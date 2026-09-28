import { describe, expect, it } from 'vitest';
import type { Offer, Policy } from '../src/domain/catalog.js';
import { auditOfferEconomicsTerms, resolveOfferCommercialTerms, summarizeCommercialTerms } from '../src/application/resolve-offer-commercial-terms.js';

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
  it('requires one internal economics row for every price term without guessing missing fees', () => {
    const result = auditOfferEconomicsTerms(offer());
    expect(result.status).toBe('NEEDS_DECISION');
    expect(result.decisions).toEqual([
      'ECONOMICS_TERM_REQUIRED:24@default',
      'ECONOMICS_TERM_REQUIRED:36@default',
    ]);
  });

  it('keeps period deposit, supplier billing fee and channel payout fee explicit and traceable', () => {
    const input = offer();
    input.internalEconomicsTerms = [{
      termKey: '24@default',
      depositCalculation: {
        state: 'KNOWN', amount: { amount: 3000000, currency: 'KRW' },
        calculation: { kind: 'MULTIPLY', base: 'MONTHLY_RENT', multiplier: 3000000 / 700000 },
        sourceRefs: ['source:product.price.24@default.deposit'],
      },
      supplierBillingFee: {
        state: 'KNOWN', amount: { amount: 504000, currency: 'KRW' },
        calculation: { kind: 'RATE', base: 'MONTHLY_RENT_X_TERM', rate: 0.03 },
        sourceRefs: ['source:fee-table:supplier:24'],
      },
      channelPayoutFee: {
        state: 'KNOWN', amount: { amount: 336000, currency: 'KRW' },
        calculation: { kind: 'RATE', base: 'MONTHLY_RENT_X_TERM', rate: 0.02 },
        sourceRefs: ['source:fee-table:channel:24'],
      },
    }, {
      termKey: '36@default',
      depositCalculation: {
        state: 'ZERO', amount: { amount: 0, currency: 'KRW' },
        calculation: { kind: 'FIXED', amount: { amount: 0, currency: 'KRW' } },
        sourceRefs: ['source:product.price.36@default.deposit'],
      },
      supplierBillingFee: { state: 'UNKNOWN', sourceRefs: ['source:fee-table:supplier:36'] },
      channelPayoutFee: { state: 'NOT_APPLICABLE', sourceRefs: ['source:fee-table:channel:36'] },
    }];
    const result = auditOfferEconomicsTerms(input);
    expect(result.status).toBe('NEEDS_DECISION');
    expect(result.terms[0]?.supplierBillingFee.amount?.amount).toBe(504000);
    expect(result.decisions).toContain('ECONOMICS_VALUE_REQUIRED:36@default:SUPPLIER_BILLING_FEE');
  });

  it('fails closed when a stored amount disagrees with its period formula', () => {
    const input = offer();
    input.internalEconomicsTerms = [{
      termKey: '24@default',
      depositCalculation: {
        state: 'KNOWN', amount: { amount: 3000000, currency: 'KRW' },
        calculation: { kind: 'MULTIPLY', base: 'MONTHLY_RENT', multiplier: 2 },
        sourceRefs: ['source:deposit'],
      },
      supplierBillingFee: {
        state: 'KNOWN', amount: { amount: 1, currency: 'KRW' },
        calculation: { kind: 'RATE', base: 'MONTHLY_RENT_X_TERM', rate: 0.03 },
        sourceRefs: ['source:billing'],
      },
      channelPayoutFee: { state: 'UNKNOWN', sourceRefs: ['source:payout'] },
    }];
    const result = auditOfferEconomicsTerms(input);
    expect(result.status).toBe('INVALID');
    expect(result.invalidFacts).toContain('ECONOMICS_CALCULATION_MISMATCH:24@default:DEPOSIT');
    expect(result.invalidFacts).toContain('ECONOMICS_CALCULATION_MISMATCH:24@default:SUPPLIER_BILLING_FEE');
  });

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
