import { describe, expect, it } from 'vitest';
import type { Offer, Policy } from '../src/domain/catalog.js';
import { precomputeOfferEconomics, auditOfferEconomicsTerms, resolveOfferCommercialTerms, summarizeCommercialTerms, joinStoredProductEconomics } from '../src/application/resolve-offer-commercial-terms.js';

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
  it('joins exact stored product periods without computing missing fees or crossing product IDs', () => {
    const input=offer(),before=structuredClone(input);
    const rows=joinStoredProductEconomics(input.productId,[input],[]).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.supplierBillingFee).toMatchObject({state:'UNKNOWN',amount:null,reasonCode:'STORED_ECONOMICS_NOT_FOUND'});
    expect(joinStoredProductEconomics('other',[input],[]).rows).toEqual([]);
    expect(input).toEqual(before);
  });
  it('distinguishes stored ZERO, NOT_APPLICABLE and missing values and refuses duplicate period keys', () => {
    const input=offer();input.supplierId='RP013';input.internalEconomicsTerms=precomputeOfferEconomics(input,'USED_RENT');
    const term=input.internalEconomicsTerms[0]!;
    term.supplierBillingFee={state:'ZERO',amount:{amount:0,currency:'KRW'},calculation:null,sourceRefs:['confirmed-zero']};
    term.channelPayoutFee={state:'NOT_APPLICABLE',amount:null,calculation:null,sourceRefs:[]};
    const rows=joinStoredProductEconomics(input.productId,[input],[]).rows;
    expect(rows[0]!.supplierBillingFee.state).toBe('ZERO');expect(rows[0]!.channelPayoutFee.state).toBe('NOT_APPLICABLE');
    input.priceTerms.push(structuredClone(input.priceTerms[0]!));
    expect(joinStoredProductEconomics(input.productId,[input],[]).rows[0]!.reasonCode).toBe('DUPLICATE_STORED_JOIN_KEY');
    expect(joinStoredProductEconomics(input.productId,[input],[]).rows[0]!.monthlyRent)
      .toMatchObject({state:'UNKNOWN',amount:null,reasonCode:'DUPLICATE_STORED_JOIN_KEY'});
  });
  it('fences ledger revision and price and fails closed on divergent stored fee amounts', () => {
    const input=offer();input.supplierId='RP013';input.internalEconomicsTerms=precomputeOfferEconomics(input,'USED_RENT');
    const price=input.priceTerms[0]!,term=input.internalEconomicsTerms[0]!;
    const row:any={productId:input.productId,offerId:input.id,offerRevision:input.revision,supplierId:input.supplierId,termKey:price.termKey,
      termMonths:price.termMonths,monthlyRent:{...price.monthlyRent,state:'KNOWN'},deposit:{state:price.depositState,amount:price.deposit,sourceRefs:term.depositCalculation.sourceRefs},
      applyState:'READY',supplierBillingFee:{...term.supplierBillingFee,state:'CALCULATED'},channelPayoutFee:{...term.channelPayoutFee,state:'CALCULATED'}};
    expect(joinStoredProductEconomics(input.productId,[input],[row]).rows[0]!.joinState).toBe('MATCHED');
    const old={...row,offerRevision:0};
    expect(joinStoredProductEconomics(input.productId,[input],[old]).rows[0]!.reasonCode).toBe('LEDGER_PRICE_OR_REVISION_MISMATCH');
    const conflict={...row,supplierBillingFee:{...row.supplierBillingFee,amount:{amount:1,currency:'KRW'}}};
    expect(joinStoredProductEconomics(input.productId,[input],[conflict]).rows[0]!.supplierBillingFee)
      .toMatchObject({state:'UNKNOWN',amount:null,reasonCode:'STORED_FEE_SOURCES_CONFLICT'});
    const orphan={...row,termKey:'not-a-price-row'};
    expect(joinStoredProductEconomics(input.productId,[input],[orphan]).orphanLedgerRows).toBe(1);
    const zero=structuredClone(input);zero.priceTerms=[{...price,monthlyRent:{amount:0,currency:'KRW'}}];zero.internalEconomicsTerms=[];
    expect(joinStoredProductEconomics(zero.productId,[zero],[]).rows[0]!.monthlyRent.state).toBe('UNKNOWN');
    const zeroRow={...row,monthlyRent:{amount:0,currency:'KRW',state:'KNOWN'},priceSourceRefs:['verified-rent-zero']};
    expect(joinStoredProductEconomics(zero.productId,[zero],[zeroRow]).rows[0]!.monthlyRent).toMatchObject({state:'ZERO',amount:{amount:0}});
  });
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
      supplierBillingFee: { state: 'KNOWN', amount: { amount: 570000 }, calculation: { kind: 'RATE', rate: 0.0475 }, policyId: 'sales-commission-2026-10-11' },
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
      expect(row.supplierBillingFee).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: supplierId === 'RP012' ? 'OGONG_12M_BASE_MISSING' : 'DEPOSIT_TIER_REQUIRED' });
      expect(row.channelPayoutFee).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: supplierId === 'RP012' ? 'OGONG_12M_BASE_MISSING' : 'DEPOSIT_TIER_REQUIRED' });
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
  it('uses pickup 60-month rent x term rule and ignores vehicle-value evidence', () => {
    const offer = { id: 'synthetic', supplierId: 'RP012', priceTerms: [{ termKey: '60', termMonths: 60, monthlyRent: { amount: 200000, currency: 'KRW' as const }, depositState: 'UNKNOWN' as const }] };
    const evidence = { '60': { vehicleValue: 30000000 } };
    const before = structuredClone({ offer, evidence });
    const row = precomputeOfferEconomics(offer, 'PICKUP_SUBSCRIPTION', '가솔린', evidence)[0]!;
    expect(row.supplierBillingFee).toMatchObject({ state: 'KNOWN', amount: { amount: 230000 }, policyId: 'sales-commission-2026-10-11', approximate: true });
    expect(row.channelPayoutFee.amount?.amount).toBe(240000);
    expect(row.supplierBillingFee.sourceRefs).toContain('F04:수수료표!A191:M191');
    expect(precomputeOfferEconomics(offer, 'PICKUP_SUBSCRIPTION')[0]!.supplierBillingFee.amount?.amount).toBe(230000);
    const unsupported = { ...offer, priceTerms: [{ ...offer.priceTerms[0]!, termMonths: 24 }] };
    expect(precomputeOfferEconomics(unsupported, 'PICKUP_SUBSCRIPTION')[0]!.supplierBillingFee).toMatchObject({ state: 'KNOWN', amount: { amount: 128000 }, approximate: true });
    expect({ offer, evidence }).toEqual(before);
  });
  it('truncates Sonokong fractional-won commission and VAT while preserving other suppliers rounding', () => {
    const pickup = precomputeOfferEconomics({
      id: 'synthetic', supplierId: 'RP012',
      priceTerms: [{ termKey: '60', termMonths: 60, monthlyRent: { amount: 100001, currency: 'KRW' }, depositState: 'UNKNOWN' }],
    }, 'PICKUP_SUBSCRIPTION')[0]!;
    expect(pickup.supplierBillingFee).toMatchObject({
      state: 'KNOWN',
      amount: { amount: 65001 },
      vatAmount: 6500,
      totalAmount: 71501,
      ruleId: 'SONOKONG_PICKUP_60_BILLING_RENT_X_TERM',
    });
    expect(pickup.channelPayoutFee).toMatchObject({ amount: { amount: 120001 }, vatAmount: 12000 });

    const rerentTerms = [24, 36, 48, 60].map(termMonths => ({
      termKey: `m${termMonths}`, termMonths, monthlyRent: { amount: 100001, currency: 'KRW' as const }, depositState: 'UNKNOWN' as const,
    }));
    const rerent = precomputeOfferEconomics({ id: 'synthetic', supplierId: 'RP012', priceTerms: rerentTerms }, 'USED_RENT');
    expect(rerent.map(row => row.supplierBillingFee.amount?.amount)).toEqual([14001, 35001, 56001, 35001]);
    expect(rerent.map(row => row.channelPayoutFee.amount?.amount)).toEqual([96000, 108001, 120001, 105001]);

    const fixedQ12 = precomputeOfferEconomics({
      id: 'synthetic', supplierId: 'RP012',
      priceTerms: [{ termKey: '12', termMonths: 12, monthlyRent: { amount: 800000, currency: 'KRW' }, depositState: 'UNKNOWN' }],
    }, 'OGONG_SUBSCRIPTION')[0]!;
    expect(fixedQ12.supplierBillingFee).toMatchObject({ amount: { amount: 700000 }, vatAmount: 70000 });
    expect(fixedQ12.channelPayoutFee).toMatchObject({ amount: { amount: 800000 }, vatAmount: 80000 });

    const other = precomputeOfferEconomics({
      id: 'synthetic', supplierId: 'RP013',
      priceTerms: [{ termKey: 'm60', termMonths: 60, monthlyRent: { amount: 100001, currency: 'KRW' }, depositState: 'UNKNOWN' }],
    }, 'USED_RENT')[0]!;
    expect(other.channelPayoutFee.amount?.amount).toBe(105001);
  });
  it('stores pickup fee calculations that recompute to the saved amount', () => {
    const calc = (fee: NonNullable<ReturnType<typeof precomputeOfferEconomics>[number]['supplierBillingFee']>, monthlyRent: number, termMonths: number) => {
      if (fee.calculation?.kind === 'RATE' && fee.calculation.base === 'MONTHLY_RENT_X_TERM') {
        const base = fee.ruleId?.startsWith('SONOKONG_')
          ? Math.trunc(monthlyRent * termMonths * fee.calculation.rate)
          : Math.round(monthlyRent * termMonths * fee.calculation.rate);
        return base + (fee.calculation.adjustmentAmount?.amount ?? 0);
      }
      if (fee.calculation?.kind === 'FIXED') return fee.calculation.amount.amount;
      throw new Error('unsupported calculation');
    };
    const rows = precomputeOfferEconomics({
      id: 'synthetic', supplierId: 'RP012',
      priceTerms: [
        { termKey: '24', termMonths: 24, monthlyRent: { amount: 400000, currency: 'KRW' }, depositState: 'UNKNOWN' },
        { termKey: '60', termMonths: 60, monthlyRent: { amount: 1000000, currency: 'KRW' }, depositState: 'UNKNOWN' },
      ],
    }, 'PICKUP_SUBSCRIPTION');
    const byTerm = new Map(rows.map(row => [row.termMonths, row]));
    expect(byTerm.get(60)!.supplierBillingFee).toMatchObject({
      amount: { amount: 1550000 },
      calculation: { kind: 'RATE', base: 'MONTHLY_RENT_X_TERM', rate: 0.0275, adjustmentAmount: { amount: -100000, currency: 'KRW' } },
      ruleId: 'SONOKONG_PICKUP_60_BILLING_RENT_X_TERM',
    });
    expect(byTerm.get(60)!.channelPayoutFee).toMatchObject({
      amount: { amount: 1200000 },
      calculation: { kind: 'RATE', base: 'MONTHLY_RENT_X_TERM', rate: 0.02 },
      ruleId: 'SONOKONG_PICKUP_60_PAYOUT_RENT_X_TERM',
    });
    expect(byTerm.get(24)!.supplierBillingFee.calculation).toMatchObject({
      kind: 'RATE', base: 'MONTHLY_RENT_X_TERM', rate: 0.0475,
      adjustmentAmount: { amount: -100000, currency: 'KRW' },
    });
    expect(byTerm.get(24)!.channelPayoutFee.calculation).toMatchObject({
      kind: 'RATE', base: 'MONTHLY_RENT_X_TERM', rate: 0.04,
    });
    for (const row of rows) {
      for (const fee of [row.supplierBillingFee, row.channelPayoutFee]) {
        expect(calc(fee, row.monthlyRent!.amount, row.termMonths!)).toBe(fee.amount!.amount);
      }
    }
  });
  it('rejects rounded stored Sonokong rate fees in the audit path', () => {
    const input = {
      ...offer(), supplierId: 'RP012',
      priceTerms: [{ termKey: '60', termMonths: 60, monthlyRent: { amount: 100001, currency: 'KRW' as const }, depositState: 'UNKNOWN' as const }],
    };
    input.internalEconomicsTerms = precomputeOfferEconomics(input, 'PICKUP_SUBSCRIPTION');
    expect(auditOfferEconomicsTerms(input).invalidFacts).not.toContain('ECONOMICS_CALCULATION_MISMATCH:60:SUPPLIER_BILLING_FEE');
    input.internalEconomicsTerms[0]!.supplierBillingFee.amount!.amount = Math.round(100001 * 60 * 275 / 10000) - 100000;
    expect(auditOfferEconomicsTerms(input).invalidFacts).toContain('ECONOMICS_CALCULATION_MISMATCH:60:SUPPLIER_BILLING_FEE');
  });
  it('audits all RP012 rate fees with truncation, regardless of rule id prefix', () => {
    const input = {
      ...offer(), supplierId: 'RP012',
      priceTerms: [{ termKey: '24', termMonths: 24, monthlyRent: { amount: 100001, currency: 'KRW' as const }, depositState: 'UNKNOWN' as const }],
    };
    input.internalEconomicsTerms = precomputeOfferEconomics(input, 'USED_RENT');
    expect(input.internalEconomicsTerms[0]!.channelPayoutFee).toMatchObject({
      ruleId: 'STANDARD_RERENT_24_RENT_X_TERM',
      amount: { amount: 96000 },
    });
    expect(auditOfferEconomicsTerms(input).invalidFacts).not.toContain('ECONOMICS_CALCULATION_MISMATCH:24:CHANNEL_PAYOUT_FEE');
    input.internalEconomicsTerms[0]!.channelPayoutFee.amount!.amount = Math.round(100001 * 24 * 0.04);
    expect(auditOfferEconomicsTerms(input).invalidFacts).toContain('ECONOMICS_CALCULATION_MISMATCH:24:CHANNEL_PAYOUT_FEE');

    const other = {
      ...offer(), supplierId: 'RP013',
      priceTerms: [{ termKey: '24', termMonths: 24, monthlyRent: { amount: 100001, currency: 'KRW' as const }, depositState: 'UNKNOWN' as const }],
    };
    other.internalEconomicsTerms = precomputeOfferEconomics(other, 'USED_RENT');
    expect(other.internalEconomicsTerms[0]!.channelPayoutFee.amount?.amount).toBe(96001);
    expect(auditOfferEconomicsTerms(other).invalidFacts).not.toContain('ECONOMICS_CALCULATION_MISMATCH:24:CHANNEL_PAYOUT_FEE');
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
  it('requires a unique same-settlement Sonokong Q12 basis and keeps caller evidence first', () => {
    const input = { ...offer(), supplierId: 'RP012' };
    input.priceTerms = [
      { termKey: '12', termMonths: 12, monthlyRent: { amount: 800000, currency: 'KRW' }, depositState: 'UNKNOWN' },
      { termKey: '24_?몄닔??', termMonths: 24, monthlyRent: { amount: 700000, currency: 'KRW' }, depositState: 'UNKNOWN' },
    ];
    const targetKey = input.priceTerms[1]!.termKey;
    expect(precomputeOfferEconomics(input, 'OGONG_SUBSCRIPTION', undefined, { [targetKey]: { subscriptionForm: 'BUYOUT' } })[1]!.supplierBillingFee)
      .toMatchObject({ state: 'UNKNOWN', reasonCode: 'OGONG_12M_BASE_MISSING' });
    input.priceTerms[0]!.termKey = '12_?몄닔??';
    const q12Key = input.priceTerms[0]!.termKey;
    expect(precomputeOfferEconomics(input, 'OGONG_SUBSCRIPTION', undefined, { [q12Key]: { subscriptionForm: 'BUYOUT' }, [targetKey]: { subscriptionForm: 'BUYOUT' } })[1]!.supplierBillingFee.amount?.amount)
      .toBe(900000);
    input.priceTerms.unshift({ termKey: '12_?몄닔??_duplicate', termMonths: 12, monthlyRent: { amount: 810000, currency: 'KRW' }, depositState: 'UNKNOWN' });
    const duplicateQ12Key = input.priceTerms[0]!.termKey;
    expect(precomputeOfferEconomics(input, 'OGONG_SUBSCRIPTION', undefined, { [duplicateQ12Key]: { subscriptionForm: 'BUYOUT' }, [q12Key]: { subscriptionForm: 'BUYOUT' }, [targetKey]: { subscriptionForm: 'BUYOUT' } })[2]!.supplierBillingFee)
      .toMatchObject({ state: 'UNKNOWN', reasonCode: 'OGONG_12M_BASE_MISSING' });
    expect(precomputeOfferEconomics(input, 'OGONG_SUBSCRIPTION', undefined, {
      [targetKey]: { subscriptionForm: 'BUYOUT', q12Basis: { amount: 900000, sourceRef: 'verified:q12' } },
    })[2]!.supplierBillingFee.amount?.amount).toBe(1000000);
  });
  it('passes price-key Sonokong settlement into Q12 selection and calculation', () => {
    const input = { ...offer(), supplierId: 'RP012' };
    input.priceTerms = [
      { termKey: '12_인수형', termMonths: 12, monthlyRent: { amount: 900000, currency: 'KRW' }, depositState: 'UNKNOWN' },
      { termKey: '24_인수형', termMonths: 24, monthlyRent: { amount: 700000, currency: 'KRW' }, depositState: 'UNKNOWN' },
      { termKey: '12', termMonths: 12, monthlyRent: { amount: 800000, currency: 'KRW' }, depositState: 'UNKNOWN' },
      { termKey: '24', termMonths: 24, monthlyRent: { amount: 700000, currency: 'KRW' }, depositState: 'UNKNOWN' },
    ];
    expect(precomputeOfferEconomics(input, 'OGONG_SUBSCRIPTION', undefined, {}, ['24_인수형'])[0]!.supplierBillingFee)
      .toMatchObject({ state: 'KNOWN', amount: { amount: 1000000 } });
    expect(precomputeOfferEconomics(input, 'OGONG_SUBSCRIPTION', undefined, {}, ['24'])[0]!.supplierBillingFee)
      .toMatchObject({ state: 'UNKNOWN', reasonCode: 'RETURN_SUBSCRIPTION_TERM_NOT_SUPPORTED' });
    expect(precomputeOfferEconomics(input, 'OGONG_SUBSCRIPTION', undefined, { '24_인수형': { subscriptionForm: 'RETURN' } }, ['24_인수형'])[0]!.supplierBillingFee)
      .toMatchObject({ state: 'UNKNOWN', reasonCode: 'SUBSCRIPTION_FORM_CONFLICT' });
  });
  it('detects a changed or corrupted reference monthly rent independently of the stored fixed amount', () => {
    const input = { ...offer(), supplierId: 'RP021' };
    input.internalEconomicsTerms = precomputeOfferEconomics(input, 'USED_SUBSCRIPTION');
    expect(auditOfferEconomicsTerms(input).invalidFacts).toHaveLength(0);
    input.internalEconomicsTerms[0]!.supplierBillingFee.referenceRentBasis!.monthlyRent.amount += 100;
    expect(auditOfferEconomicsTerms(input).invalidFacts).toContain('ECONOMICS_REFERENCE_RENT_MISMATCH:24@default:supplierBillingFee');
  });
  it('audits Sonokong Ogong billing against Q12 minus insurance plus exact term addon', () => {
    const input = { ...offer(), supplierId: 'RP012' };
    input.priceTerms = [
      { termKey: '12_인수형', termMonths: 12, monthlyRent: { amount: 900000, currency: 'KRW' }, depositState: 'UNKNOWN' },
      { termKey: '24_인수형', termMonths: 24, monthlyRent: { amount: 700000, currency: 'KRW' }, depositState: 'UNKNOWN' },
      { termKey: '60_인수형', termMonths: 60, monthlyRent: { amount: 700000, currency: 'KRW' }, depositState: 'UNKNOWN' },
    ];
    input.internalEconomicsTerms = precomputeOfferEconomics(input, 'OGONG_SUBSCRIPTION', undefined, {}, ['12_인수형', '24_인수형', '60_인수형']);
    expect(input.internalEconomicsTerms.map(term => term.supplierBillingFee.amount?.amount)).toEqual([800000, 1000000, 1400000]);
    expect(auditOfferEconomicsTerms(input).invalidFacts).toHaveLength(0);
    input.internalEconomicsTerms[0]!.supplierBillingFee.amount!.amount = 900000;
    input.internalEconomicsTerms[1]!.supplierBillingFee.amount!.amount = 900000;
    input.internalEconomicsTerms[2]!.supplierBillingFee.amount!.amount = 1500000;
    expect(auditOfferEconomicsTerms(input).invalidFacts).toEqual([
      'ECONOMICS_CALCULATION_MISMATCH:12_인수형:SUPPLIER_BILLING_FEE',
      'ECONOMICS_CALCULATION_MISMATCH:24_인수형:SUPPLIER_BILLING_FEE',
      'ECONOMICS_CALCULATION_MISMATCH:60_인수형:SUPPLIER_BILLING_FEE',
      'ECONOMICS_REFERENCE_RENT_MISMATCH:12_인수형:supplierBillingFee',
      'ECONOMICS_REFERENCE_RENT_MISMATCH:24_인수형:supplierBillingFee',
      'ECONOMICS_REFERENCE_RENT_MISMATCH:60_인수형:supplierBillingFee',
    ]);
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
