import { describe, expect, it } from 'vitest';
import type { Offer, Policy } from '../src/domain/catalog.js';
import { resolveOfferCommercialTerms, summarizeCommercialTerms } from '../src/application/resolve-offer-commercial-terms.js';

const meta = {
  schemaVersion: '1', revision: 1, validationStatus: 'VALID' as const,
  createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
  createdBy: { id: 'service:test', kind: 'SERVICE' as const },
  updatedBy: { id: 'service:test', kind: 'SERVICE' as const },
  lineageId: 'lin_test',
};

function policy(facts: Record<string, unknown> = { annual_mileage: 20000 }): Policy {
  return {
    ...meta, id: 'policy_test', kind: 'MILEAGE', version: '1',
    effectiveFrom: '2026-01-01T00:00:00.000Z', facts,
  };
}

function offer(): Offer {
  return {
    ...meta, id: 'offer_test', productId: 'product_test', supplierId: 'supplier_test',
    status: 'ACTIVE', policyId: 'policy_test',
    priceTerms: [
      {
        termKey: '24@default', termMonths: 24,
        monthlyRent: { amount: 700000, currency: 'KRW' },
        deposit: { amount: 3000000, currency: 'KRW' }, depositState: 'KNOWN',
      },
      {
        termKey: '36@default', termMonths: 36,
        monthlyRent: { amount: 650000, currency: 'KRW' },
        deposit: { amount: 0, currency: 'KRW' }, depositState: 'ZERO',
      },
    ],
  };
}

describe('offer commercial terms resolution', () => {
  it('uses policy annual_mileage as the default and fills terms that omit mileage', () => {
    const result = resolveOfferCommercialTerms(offer(), policy());
    expect(result.status).toBe('READY');
    expect(result.defaultMileage).toEqual({ state: 'KNOWN', kmPerYear: 20000, source: 'POLICY' });
    expect(result.terms.map((term) => term.mileage)).toEqual([
      { state: 'KNOWN', kmPerYear: 20000, source: 'POLICY_DEFAULT', isDefault: true },
      { state: 'KNOWN', kmPerYear: 20000, source: 'POLICY_DEFAULT', isDefault: true },
    ]);
  });

  it('marks the matching mileage variant as default without collapsing alternate prices', () => {
    const input = offer();
    input.priceTerms = [
      { termKey: '24_2만', termMonths: 24, monthlyRent: { amount: 700000, currency: 'KRW' },
        deposit: { amount: 0, currency: 'KRW' }, depositState: 'ZERO', mileageLimitKmPerYear: 20000 },
      { termKey: '24_3만', termMonths: 24, monthlyRent: { amount: 750000, currency: 'KRW' },
        deposit: { amount: 0, currency: 'KRW' }, depositState: 'ZERO', mileageLimitKmPerYear: 30000 },
    ];
    const result = resolveOfferCommercialTerms(input, policy());
    expect(result.status).toBe('READY');
    expect(result.terms[0]?.mileage).toMatchObject({ kmPerYear: 20000, isDefault: true });
    expect(result.terms[1]?.mileage).toMatchObject({ kmPerYear: 30000, isDefault: false });
    expect(result.terms.map((term) => term.monthlyRent.amount)).toEqual([700000, 750000]);
  });

  it('keeps missing default mileage as a policy decision instead of guessing', () => {
    const result = resolveOfferCommercialTerms(offer(), policy({}));
    expect(result.status).toBe('NEEDS_DECISION');
    expect(result.decisions).toContain('DEFAULT_MILEAGE_REQUIRED');
    expect(result.decisions).toContain('MILEAGE_REQUIRED:24@default');
  });

  it('requires a price variant for the chosen default mileage in every offered duration', () => {
    const input = offer();
    input.priceTerms = [
      { termKey: '24_3만', termMonths: 24, monthlyRent: { amount: 750000, currency: 'KRW' },
        deposit: { amount: 0, currency: 'KRW' }, depositState: 'ZERO', mileageLimitKmPerYear: 30000 },
    ];
    const result = resolveOfferCommercialTerms(input, policy());
    expect(result.status).toBe('NEEDS_DECISION');
    expect(result.decisions).toContain('DEFAULT_MILEAGE_PRICE_MISSING:24');
  });

  it('keeps an unresolved deposit as a decision item', () => {
    const input = offer();
    input.priceTerms[0] = {
      ...input.priceTerms[0]!,
      deposit: null,
      depositState: 'UNKNOWN',
    };
    const result = resolveOfferCommercialTerms(input, policy());
    expect(result.status).toBe('NEEDS_DECISION');
    expect(result.decisions).toContain('DEPOSIT_REQUIRED:24@default');
    expect(result.terms[0]?.deposit).toEqual({ state: 'UNKNOWN', source: 'UNRESOLVED' });
  });

  it('fails closed on contradictory deposit state and amount', () => {
    const input = offer();
    input.priceTerms[0] = {
      ...input.priceTerms[0]!,
      deposit: { amount: 1000000, currency: 'KRW' },
      depositState: 'ZERO',
    };
    const result = resolveOfferCommercialTerms(input, policy());
    expect(result.status).toBe('INVALID');
    expect(result.invalidFacts).toContain('ZERO_DEPOSIT_WITH_NONZERO_AMOUNT:24@default');
  });

  it('does not accept a different policy document for the offer link', () => {
    const other = { ...policy(), id: 'policy_other' };
    const result = resolveOfferCommercialTerms(offer(), other);
    expect(result.status).toBe('INVALID');
    expect(result.invalidFacts).toContain('POLICY_ID_MISMATCH');
  });

  it('summarizes decision queues by code without losing per-offer detail', () => {
    const ready = resolveOfferCommercialTerms(offer(), policy());
    const missing = resolveOfferCommercialTerms(offer(), policy({}));
    const summary = summarizeCommercialTerms([ready, missing]);
    expect(summary.total).toBe(2);
    expect(summary.byStatus).toEqual({ READY: 1, NEEDS_DECISION: 1, INVALID: 0 });
    expect(summary.decisionCounts.DEFAULT_MILEAGE_REQUIRED).toBe(1);
    expect(summary.decisionCounts.MILEAGE_REQUIRED).toBe(2);
  });
});
