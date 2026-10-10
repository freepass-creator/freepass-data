import { describe, expect, it } from 'vitest';
import { toInternalFeeLookup, INTERNAL_FEE_LOOKUP_CONTRACT_VERSION } from '../src/domain/internal-fee-lookup-contract.js';

const known = { state: 'KNOWN' as const, amount: { amount: 940800, currency: 'KRW' as const }, vatTreatment: 'EXCLUDED' as const, vatAmount: 94080, totalAmount: 1034880, sourceRefs: ['rule-row'], ruleId: 'R1', policyId: 'P1' };

describe('internal fee lookup contract', () => {
  it('maps stored term economics without recomputing and keeps 0 distinct from unknown', () => {
    const lookup = toInternalFeeLookup('offer-fake', [
      { termKey: 'm24', termMonths: 24, supplierBillingFee: known, channelPayoutFee: { state: 'ZERO', amount: { amount: 0, currency: 'KRW' }, sourceRefs: [] } } as never,
      { termKey: 'm36', termMonths: 36, supplierBillingFee: { state: 'UNKNOWN', sourceRefs: [], reasonCode: 'NO_RULE' }, channelPayoutFee: { state: 'UNKNOWN', sourceRefs: [] } } as never,
    ]);
    expect(lookup.contract).toBe(INTERNAL_FEE_LOOKUP_CONTRACT_VERSION);
    expect(lookup.terms[0]!.supplierBillingFee).toMatchObject({ status: 'CONFIRMED', state: 'KNOWN', amount: { amount: 940800 }, reasonCode: null, ruleId: 'R1' });
    expect(lookup.terms[0]!.channelPayoutFee).toMatchObject({ status: 'CONFIRMED', state: 'ZERO', amount: { amount: 0 } });
    expect(lookup.terms[1]!.supplierBillingFee).toMatchObject({ status: 'UNCONFIRMED', state: 'UNKNOWN', amount: null, reasonCode: 'NO_RULE' });
    expect(lookup.terms[1]!.channelPayoutFee).toMatchObject({ status: 'UNCONFIRMED', reasonCode: 'REASON_NOT_RECORDED' });
  });
  it('returns an empty term list when nothing is stored (never invents terms)', () => {
    expect(toInternalFeeLookup('offer-fake', undefined).terms).toEqual([]);
  });
});
