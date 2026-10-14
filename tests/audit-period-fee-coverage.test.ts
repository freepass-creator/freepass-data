import { describe, expect, it } from 'vitest';
import { lookupFeeTable, lookupFeeWithReason, redactMismatchKeys, sampleFeeAuditPlates } from '../src/application/audit-period-fee-coverage.js';
import type { PeriodFeeLedgerRow } from '../src/application/period-fee-ledger-plan.js';

const fee = (state: string, amount: number | null, reasonCode: string | null = null) =>
  ({ state, amount: amount === null ? null : { amount, currency: 'KRW' }, reasonCode, ruleId: null });

const row = (plate: string, termKey: string, termMonths: number, billing = fee('CALCULATED', 100)) => ({
  inputRefs: { productPath: `products/${plate}` },
  termKey,
  termMonths,
  ruleIds: [],
  monthlyRent: { amount: 500000, currency: 'KRW', state: 'KNOWN', reasonCode: null },
  deposit: { state: 'KNOWN', amount: { amount: 500000, currency: 'KRW' } },
  supplierBillingFee: billing,
  channelPayoutFee: fee('UNKNOWN', null, 'Q12_BASIS_REQUIRED'),
}) as unknown as PeriodFeeLedgerRow;

describe('period fee coverage audit', () => {
  const rows = [row('11가0001', 'source:24', 24), row('11가0001', 'source:12', 12), row('11가0002', 'source:12', 12)];

  it('looks up by full plate or last 4 and orders by term, leaving unconfirmed amounts empty with a reason', () => {
    const table = lookupFeeTable(rows, '11가0001');
    expect(table.map(item => item.termMonths)).toEqual([12, 24]);
    expect(table[0]).toMatchObject({ plateLast4: '0001', payout: null, payoutState: 'UNKNOWN', payoutReason: 'Q12_BASIS_REQUIRED', billing: 100 });
    expect(lookupFeeTable(rows, '0002')).toHaveLength(1);
  });

  it('samples deterministically and reports mismatches by last 4 only', () => {
    const sample = sampleFeeAuditPlates(rows, ['11가0001|source:12|DIFF'], 2);
    expect(sample.sampled).toBe(2);
    expect(sample.matched).toBe(1);
    expect(sample.mismatchLast4).toEqual(['0001']);
    expect(sampleFeeAuditPlates(rows, [], 2)).toEqual(sampleFeeAuditPlates(rows, [], 2));
  });

  it('keeps no plate numbers in the redacted mismatch keys', () => {
    const redacted = redactMismatchKeys(['11가0001|source:12|OTHER:BILLING'], 'salt');
    expect(redacted[0]).toMatch(/^[0-9a-f]{12}|source:12|OTHER:BILLING$/);
    expect(JSON.stringify(redacted)).not.toMatch(/d{2,3}[가-힣]d{4}/);
  });

  it('explains why a lookup is empty instead of returning a bare empty list', () => {
    const inputs = { products: { '11가0001': { listable: false, provider_company_code: 'RP001' } }, policies: {}, newCarTrim: {}, observedAt: '2026-10-12T00:00:00.000Z' };
    expect(lookupFeeWithReason(inputs, [], '9999')[0]).toMatchObject({ status: 'PRODUCT_NOT_FOUND', rows: [] });
    expect(lookupFeeWithReason(inputs, [], '0001')[0]).toMatchObject({ status: 'NOT_LISTABLE', supplierId: 'RP001', rows: [] });
  });

  it('caps last-4 candidates and asks for a longer number', () => {
    const products = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`${10 + i}가0001`, { listable: false }]));
    const inputs = { products, policies: {}, newCarTrim: {}, observedAt: '2026-10-12T00:00:00.000Z' };
    const result = lookupFeeWithReason(inputs, [], '0001');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: 'TOO_MANY_CANDIDATES', rows: [] });
  });
});
