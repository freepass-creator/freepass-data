import { describe, expect, it } from 'vitest';
import type { OfferTermEconomics, TermEconomicAmount } from '../src/domain/catalog.js';
import { toInternalFeeLookup, INTERNAL_FEE_LOOKUP_CONTRACT_VERSION } from '../src/domain/internal-fee-lookup-contract.js';

const known: TermEconomicAmount = {
  state: 'KNOWN',
  amount: { amount: 940800, currency: 'KRW' },
  vatTreatment: 'EXCLUDED',
  vatAmount: 94080,
  totalAmount: 1034880,
  sourceRefs: ['rule-row'],
  ruleId: 'R1',
  policyId: 'P1',
};

const zero: TermEconomicAmount = {
  state: 'ZERO',
  amount: { amount: 0, currency: 'KRW' },
  sourceRefs: [],
};

const unknown = (reasonCode?: string | null): TermEconomicAmount => ({
  state: 'UNKNOWN',
  sourceRefs: [],
  ...(reasonCode !== undefined ? { reasonCode } : {}),
});

const economicsTerm = (
  termKey: string,
  termMonths: number,
  supplierBillingFee: TermEconomicAmount = known,
  channelPayoutFee: TermEconomicAmount = zero,
): OfferTermEconomics => ({
  termKey,
  termMonths,
  monthlyRent: { amount: 1000000, currency: 'KRW' },
  depositCalculation: {
    state: 'NOT_APPLICABLE',
    amount: null,
    sourceRefs: [],
  },
  supplierBillingFee,
  channelPayoutFee,
});

describe('internal fee lookup contract', () => {
  it('maps stored term economics without recomputing and keeps 0 distinct from unknown', () => {
    const lookup = toInternalFeeLookup('offer-fake', [
      { termKey: 'm24', termMonths: 24 },
      { termKey: 'm36', termMonths: 36 },
    ], [
      economicsTerm('m24', 24),
      economicsTerm('m36', 36, unknown('NO_RULE'), unknown(undefined)),
    ]);
    expect(lookup.contract).toBe(INTERNAL_FEE_LOOKUP_CONTRACT_VERSION);
    expect(lookup.terms[0]!.supplierBillingFee).toMatchObject({ status: 'CONFIRMED', state: 'KNOWN', amount: { amount: 940800 }, reasonCode: null, ruleId: 'R1' });
    expect(lookup.terms[0]!.channelPayoutFee).toMatchObject({ status: 'CONFIRMED', state: 'ZERO', amount: { amount: 0 } });
    expect(lookup.terms[1]!.supplierBillingFee).toMatchObject({ status: 'UNCONFIRMED', state: 'UNKNOWN', amount: null, reasonCode: 'NO_RULE' });
    expect(lookup.terms[1]!.channelPayoutFee).toMatchObject({ status: 'UNCONFIRMED', reasonCode: 'REASON_NOT_RECORDED' });
  });

  it.each([
    ['empty', ''],
    ['spaces', '  '],
    ['undefined', undefined],
    ['null', null],
  ])('falls back unresolved blank reasonCode: %s', (_name, reasonCode) => {
    const lookup = toInternalFeeLookup('offer-fake', [
      { termKey: 'm24', termMonths: 24 },
    ], [
      economicsTerm('m24', 24, unknown(reasonCode), unknown(reasonCode)),
    ]);
    expect(lookup.terms[0]!.supplierBillingFee.reasonCode).toBe('REASON_NOT_RECORDED');
    expect(lookup.terms[0]!.channelPayoutFee.reasonCode).toBe('REASON_NOT_RECORDED');
  });

  it('returns terms in price row order and reports duplicate, orphan, missing, and normal rows', () => {
    const lookup = toInternalFeeLookup('offer-fake', [
      { termKey: 'm12', termMonths: 12 },
      { termKey: 'm24', termMonths: 24 },
      { termKey: 'm36', termMonths: 36 },
    ], [
      economicsTerm('m24', 24),
      economicsTerm('m24', 24, unknown('SECOND'), unknown('SECOND')),
      economicsTerm('m48', 48),
      economicsTerm('m36', 36),
    ]);

    expect(lookup.terms.map((term) => term.termKey)).toEqual(['m12', 'm24', 'm36']);
    expect(lookup.terms[0]!.supplierBillingFee).toMatchObject({ status: 'UNCONFIRMED', state: 'UNKNOWN', reasonCode: 'NO_EVIDENCE' });
    expect(lookup.terms[0]!.channelPayoutFee).toMatchObject({ status: 'UNCONFIRMED', state: 'UNKNOWN', reasonCode: 'NO_EVIDENCE' });
    expect(lookup.terms[1]!.supplierBillingFee).toMatchObject({ status: 'UNCONFIRMED', state: 'UNKNOWN', reasonCode: 'DUPLICATE_TERM_KEY' });
    expect(lookup.terms[1]!.channelPayoutFee).toMatchObject({ status: 'UNCONFIRMED', state: 'UNKNOWN', reasonCode: 'DUPLICATE_TERM_KEY' });
    expect(lookup.terms[2]!.supplierBillingFee).toMatchObject({ status: 'CONFIRMED', state: 'KNOWN', reasonCode: null });
    expect(lookup.orphanTermKeys).toEqual(['m48']);
  });

  it('marks every duplicated price row termKey as unresolved', () => {
    const lookup = toInternalFeeLookup('offer-fake', [
      { termKey: 'm24-return', termMonths: 24 },
      { termKey: 'm24-return', termMonths: 24 },
      { termKey: 'm36', termMonths: 36 },
    ], [
      economicsTerm('m24-return', 24),
      economicsTerm('m36', 36),
    ]);

    expect(lookup.terms[0]!.supplierBillingFee.reasonCode).toBe('DUPLICATE_PRICE_TERM_KEY');
    expect(lookup.terms[1]!.supplierBillingFee.reasonCode).toBe('DUPLICATE_PRICE_TERM_KEY');
    expect(lookup.terms[0]!.channelPayoutFee.reasonCode).toBe('DUPLICATE_PRICE_TERM_KEY');
    expect(lookup.terms[1]!.channelPayoutFee.reasonCode).toBe('DUPLICATE_PRICE_TERM_KEY');
    expect(lookup.terms[2]!.supplierBillingFee.status).toBe('CONFIRMED');
  });

  it('marks a price row unresolved when stored economics termMonths conflicts with the price term', () => {
    const lookup = toInternalFeeLookup('offer-fake', [
      { termKey: 'm24', termMonths: 24 },
      { termKey: 'm36', termMonths: 36 },
    ], [
      economicsTerm('m24', 36),
      economicsTerm('m36', 36),
    ]);

    expect(lookup.terms[0]!.supplierBillingFee).toMatchObject({
      status: 'UNCONFIRMED',
      reasonCode: 'TERM_MONTHS_MISMATCH',
    });
    expect(lookup.terms[0]!.channelPayoutFee.reasonCode).toBe('TERM_MONTHS_MISMATCH');
    expect(lookup.terms[1]!.supplierBillingFee.status).toBe('CONFIRMED');
  });

  it('returns no rows but still reports orphan economics when no price rows exist', () => {
    const lookup = toInternalFeeLookup('offer-fake', [], [
      economicsTerm('m24', 24),
    ]);
    expect(lookup.terms).toEqual([]);
    expect(lookup.orphanTermKeys).toEqual(['m24']);
  });
});
