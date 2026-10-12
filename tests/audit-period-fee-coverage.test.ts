import { describe, expect, it } from 'vitest';
import { lookupFeeTable, redactMismatchKeys, sampleFeeAuditPlates } from '../src/application/audit-period-fee-coverage.js';
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
  const rows = [row('00가0001', 'source:24', 24), row('00가0001', 'source:12', 12), row('00나0002', 'source:12', 12)];

  it('looks up by full plate or last 4 and orders by term, leaving unconfirmed amounts empty with a reason', () => {
    const table = lookupFeeTable(rows, '00가0001');
    expect(table.map(item => item.termMonths)).toEqual([12, 24]);
    expect(table[0]).toMatchObject({ plateLast4: '0001', payout: null, payoutState: 'UNKNOWN', payoutReason: 'Q12_BASIS_REQUIRED', billing: 100 });
    expect(lookupFeeTable(rows, '0002')).toHaveLength(1);
  });

  it('samples deterministically and reports mismatches by last 4 only', () => {
    const sample = sampleFeeAuditPlates(rows, ['00가0001|source:12|DIFF'], 2);
    expect(sample.sampled).toBe(2);
    expect(sample.matched).toBe(1);
    expect(sample.mismatchLast4).toEqual(['0001']);
    expect(sampleFeeAuditPlates(rows, [], 2)).toEqual(sampleFeeAuditPlates(rows, [], 2));
  });

  it('keeps no plate numbers in the redacted mismatch keys', () => {
    const redacted = redactMismatchKeys(['00가0001|source:12|OTHER:BILLING'], 'salt');
    expect(redacted[0]).toMatch(/^[0-9a-f]{12}|source:12|OTHER:BILLING$/);
    expect(JSON.stringify(redacted)).not.toMatch(/d{2,3}[가-힣]d{4}/);
  });
});
