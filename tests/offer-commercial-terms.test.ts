import { describe, expect, it } from 'vitest';
import type { Offer, Policy } from '../src/domain/catalog.js';
import { precomputeOfferEconomics, auditOfferEconomicsTerms, resolveOfferCommercialTerms, summarizeCommercialTerms } from '../src/application/resolve-offer-commercial-terms.js';

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
      supplierBillingFee: { state: 'UNKNOWN', sourceRefs: [] },
      channelPayoutFee: { state: 'NOT_APPLICABLE', sourceRefs: [] },
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
      channelPayoutFee: { state: 'UNKNOWN', sourceRefs: [] },
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


describe('canonical per-term economics precompute', () => {
  it('uses the pinned 24 month policy, preserves prices and does not mutate inputs', () => {
    const input = offer(); input.supplierId = 'RP013';
    input.priceTerms[0]!.monthlyRent.amount = 500000;
    const before = structuredClone(input);
    const result = precomputeOfferEconomics(input, 'USED_RENT');
    expect(result[0]).toMatchObject({ monthlyRent: { amount: 500000 },
      supplierBillingFee: { state: 'KNOWN', amount: { amount: 570000 }, calculation: { kind: 'RATE', rate: 0.0475 }, policyId: 'sales-commission-2026-10-09' },
      channelPayoutFee: { state: 'KNOWN', amount: { amount: 480000 }, calculation: { kind: 'RATE', rate: 0.04 } } });
    expect(result[0]!.depositCalculation.amount).toEqual(input.priceTerms[0]!.deposit);
    result[0]!.monthlyRent!.amount = 1;
    result[0]!.depositCalculation.amount!.amount = 1;
    expect(input).toEqual(before);
  });
  it.each(['UNREGISTERED'])('keeps unregistered supplier %s unknown', (supplierId) => {
    const input = { ...offer(), supplierId };
    const row = precomputeOfferEconomics(input, 'USED_RENT')[0]!;
    for (const fee of [row.supplierBillingFee, row.channelPayoutFee]) {
      expect(fee).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: 'SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE' });
    }
  });
  it.each([['RP012', 'USED_SUBSCRIPTION'], ['RP022', 'NEW_RENT']] as const)(
    'keeps missing evidence unknown for %s %s', (supplierId, kind) => {
      const row = precomputeOfferEconomics({ ...offer(), supplierId }, kind)[0]!;
      expect(row.supplierBillingFee).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: supplierId === 'RP012' ? 'Q12_BASIS_REQUIRED' : 'DEPOSIT_TIER_REQUIRED' });
      expect(row.channelPayoutFee).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: supplierId === 'RP012' ? 'Q12_BASIS_REQUIRED' : 'DEPOSIT_TIER_REQUIRED' });
    });
  it('keeps zero, missing product rules and unsupported periods distinct', () => {
    const input = offer(); input.supplierId = 'RP013'; input.priceTerms[0]!.monthlyRent.amount = 0;
    const zeroFee = precomputeOfferEconomics(input, 'USED_RENT')[0]!.supplierBillingFee;
    expect(zeroFee).toMatchObject({ state: 'ZERO', amount: { amount: 0 } });
    expect(zeroFee.sourceRefs.some(ref => ref.startsWith('F04:'))).toBe(true);
    expect(zeroFee.sourceRefs.some(ref => ref.startsWith('catalog_offers/'))).toBe(false);
    expect(precomputeOfferEconomics(input, 'USED_SUBSCRIPTION', '가솔린')[0]!.supplierBillingFee).toMatchObject({ state: 'ZERO', amount: { amount: 0 }, reasonCode: null });
    input.priceTerms[0]!.termMonths = 18;
    expect(precomputeOfferEconomics(input, 'USED_RENT')[0]!.supplierBillingFee.reasonCode).toBe('TERM_NOT_IN_F04_COMMISSION_POLICY');
  });
  it('preserves fixed fees, rejects ambiguous fuel and rounds fractional won', () => {
    const input = offer(); input.supplierId = 'RP023';
    expect(precomputeOfferEconomics(input, 'USED_SUBSCRIPTION', '가솔린')[0]!.channelPayoutFee).toMatchObject({ amount: { amount: 800000 }, calculation: { kind: 'FIXED' } });
    input.supplierId = 'RP004';
    expect(precomputeOfferEconomics(input, 'USED_RENT')[0]!.channelPayoutFee.reasonCode).toBe('FUEL_REQUIRED_FOR_SUPPLIER_RULE');
    input.supplierId = 'RP013'; input.priceTerms[0]!.monthlyRent.amount = 500001;
    expect(precomputeOfferEconomics(input, 'USED_RENT')[0]!.channelPayoutFee.state).toBe('KNOWN');
  });
});


describe('F04 explicit canonical evidence', () => {
  it('passes pickup vehicle evidence and persists row provenance without mutating evidence', () => {
    const offer = { id: 'synthetic', supplierId: 'RP012', priceTerms: [{ termKey: '60', termMonths: 60, monthlyRent: { amount: 200000, currency: 'KRW' as const }, depositState: 'UNKNOWN' as const }] };
    const evidence = { '60': { vehicleValue: 30000000 } };
    const before = structuredClone({ offer, evidence });
    const row = precomputeOfferEconomics(offer, 'PICKUP_SUBSCRIPTION', '가솔린', evidence)[0]!;
    expect(row.supplierBillingFee).toMatchObject({ state: 'KNOWN', amount: { amount: 1200000 }, policyId: 'sales-commission-2026-10-09' });
    expect(row.channelPayoutFee.amount?.amount).toBe(900000);
    expect(row.supplierBillingFee.sourceRefs).toContain('F04:수수료표!A190:M190');
    expect(precomputeOfferEconomics(offer, 'PICKUP_SUBSCRIPTION')[0]!.supplierBillingFee.reasonCode).toBe('VEHICLE_VALUE_REQUIRED');
    expect({ offer, evidence }).toEqual(before);
  });
  it('uses the same-product 36-month basis for Billin and records its exact price provenance', () => {
    const offer = { id: 'synthetic', supplierId: 'RP021', priceTerms: [{ termKey: '60', termMonths: 60, monthlyRent: { amount: 200000, currency: 'KRW' as const }, depositState: 'UNKNOWN' as const }] };
    expect(precomputeOfferEconomics(offer, 'USED_SUBSCRIPTION')[0]!.supplierBillingFee.reasonCode).toBe('BILLIN_36_MONTH_RENT_REQUIRED');
    offer.priceTerms.push({ ...offer.priceTerms[0]!, termKey: '36', termMonths: 36, monthlyRent: { amount: 500000, currency: 'KRW' } });
    const row = precomputeOfferEconomics(offer, 'USED_SUBSCRIPTION')[0]!;
    expect(row.supplierBillingFee).toMatchObject({ amount: { amount: 500000 }, calculation: { kind: 'FIXED' } });
    expect(row.channelPayoutFee.amount?.amount).toBe(400000);
    expect(row.channelPayoutFee.sourceRefs).toContain('USER:2026-10-09:BILLIN_LC_36_MONTH_RENT_100_80');
    expect(row.channelPayoutFee.priceSourceRefs).toContain('catalog_offers/synthetic/priceTerms/36');
    expect(row.supplierBillingFee.referenceRentBasis).toEqual({ termKey: '36', termMonths: 36, monthlyRent: { amount: 500000, currency: 'KRW' }, multiplier: 1 });
    expect(row.channelPayoutFee.referenceRentBasis?.multiplier).toBe(0.8);
  });
  it('detects a changed or corrupted reference monthly rent independently of the stored fixed amount', () => {
    const input = { ...offer(), supplierId: 'RP021' };
    input.internalEconomicsTerms = precomputeOfferEconomics(input, 'USED_SUBSCRIPTION');
    expect(auditOfferEconomicsTerms(input).invalidFacts).toHaveLength(0);
    input.internalEconomicsTerms[0]!.supplierBillingFee.referenceRentBasis!.monthlyRent.amount += 100;
    expect(auditOfferEconomicsTerms(input).invalidFacts).toContain('ECONOMICS_REFERENCE_RENT_MISMATCH:24@default:supplierBillingFee');
  });
});

describe('economic rule and price provenance separation', () => {
  it.each(['UNREGISTERED', 'RP034', 'RP013'])('separates fee references for %s', (supplierId) => {
    const input = { ...offer(), supplierId };
    const evidence = { '24@default': { q12Basis: { amount: 800000, sourceRef: 'unused:q12' } } };
    const before = structuredClone({ input, evidence });
    const row = precomputeOfferEconomics(input, 'USED_RENT', undefined, evidence)[0]!;
    const priceRef = `catalog_offers/${input.id}/priceTerms/${row.termKey}`;
    for (const fee of [row.supplierBillingFee, row.channelPayoutFee]) {
      expect(fee.priceSourceRefs).toEqual([priceRef]);
      if (supplierId === 'RP013') {
        expect(fee.state).toBe('KNOWN');
        expect(fee.sourceRefs.some(ref => ref.startsWith('F04:'))).toBe(true);
        expect(fee.sourceRefs.some(ref => ref.startsWith('catalog_offers/'))).toBe(false);
        expect(fee.sourceRefs).not.toContain('unused:q12');
      } else expect(fee.sourceRefs).toEqual([]);
    }
    row.supplierBillingFee.priceSourceRefs!.push('mutated');
    expect({ input, evidence }).toEqual(before);
  });
  it('includes Q12 evidence only when the Q12 rule was calculated', () => {
    const input = { ...offer(), supplierId: 'RP012' };
    const evidence = { '24@default': { q12Basis: { amount: 800000, sourceRef: 'verified:q12' }, subscriptionForm: 'BUYOUT' as const } };
    expect(precomputeOfferEconomics(input, 'USED_SUBSCRIPTION', undefined, evidence)[0]!.supplierBillingFee.sourceRefs).toContain('verified:q12');
    delete (evidence['24@default'] as { subscriptionForm?: string }).subscriptionForm;
    const fee = precomputeOfferEconomics(input, 'USED_SUBSCRIPTION', undefined, evidence)[0]!.supplierBillingFee;
    expect(fee.state).toBe('UNKNOWN');
    expect(fee.sourceRefs).toEqual([]);
  });
  it.each(['UNKNOWN', 'KNOWN', 'ZERO', 'NOT_APPLICABLE'] as const)('separates %s deposit references', state => {
    const input = offer();
    input.priceTerms[0]!.depositState = state;
    input.priceTerms[0]!.deposit = state === 'KNOWN' ? { amount: 100, currency: 'KRW' } : state === 'ZERO' ? { amount: 0, currency: 'KRW' } : null;
    const before = structuredClone(input);
    const value = precomputeOfferEconomics(input, 'USED_RENT')[0]!.depositCalculation;
    const priceRef = `catalog_offers/${input.id}/priceTerms/${input.priceTerms[0]!.termKey}`;
    expect(value.sourceRefs).toEqual(state === 'KNOWN' || state === 'ZERO' ? [priceRef] : []);
    expect(value.priceSourceRefs).toEqual([priceRef]);
    expect(input).toEqual(before);
  });
});
