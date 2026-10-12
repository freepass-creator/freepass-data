import { describe, expect, it } from 'vitest';
import { contractLockPlanDigest, decideContractLockRelease, summarizeContractLockDecisions } from '../src/application/contract-lock-release.js';

const now = new Date('2026-10-12T05:00:00.000Z');
const item = { plate: '00가0001', supplierCode: 'RP001', sheetRow: 10, expectedLockAt: 1790000000000 };
const product = { provider_company_code: 'RP001', locked_by_contract: 'LEDGER', _ledger_lock_at: 1790000000000 };
const evidence = (patch: Record<string, unknown> = {}) => ({
  readAt: '2026-10-12T04:55:00.000Z',
  items: [{ plate: '00가0001', intakeRows: [{ row: 10, cancel: true }], otherTabHits: 0, ...patch }],
});

describe('contract lock release decision', () => {
  it('releases only when product state and fresh sheet evidence both match', () => {
    expect(decideContractLockRelease(item, product, evidence(), now)).toMatchObject({ decision: 'RELEASABLE' });
  });

  it.each([
    ['PRODUCT_NOT_FOUND', null, evidence()],
    ['SUPPLIER_MISMATCH', { ...product, provider_company_code: 'RP002' }, evidence()],
    ['LOCK_VALUE_NOT_LEDGER', { ...product, locked_by_contract: '정산원장' }, evidence()],
    ['LOCK_TIME_CHANGED', { ...product, _ledger_lock_at: 1 }, evidence()],
    ['SHEET_EVIDENCE_MISSING', product, null],
    ['SHEET_EVIDENCE_STALE', product, { ...evidence(), readAt: '2026-10-12T04:00:00.000Z' }],
    ['SHEET_ROW_NOT_FOUND', product, evidence({ intakeRows: [{ row: 99, cancel: true }] })],
    ['SHEET_CANCEL_NOT_ENTERED', product, evidence({ intakeRows: [{ row: 10, cancel: false }] })],
    ['LIVE_INTAKE_ROW_EXISTS', product, evidence({ intakeRows: [{ row: 10, cancel: true }, { row: 20, cancel: false }] })],
    ['OTHER_TAB_HIT', product, evidence({ otherTabHits: 1 })],
  ])('holds with %s', (reason, productInput, evidenceInput) => {
    expect(decideContractLockRelease(item, productInput as never, evidenceInput as never, now)).toMatchObject({ decision: 'HOLD', reason });
  });

  it('digest is order independent and summary counts reasons', () => {
    const other = { ...item, plate: '00나0002' };
    expect(contractLockPlanDigest({ planId: 'p', items: [item, other] })).toBe(contractLockPlanDigest({ planId: 'p', items: [other, item] }));
    const summary = summarizeContractLockDecisions([
      decideContractLockRelease(item, product, evidence(), now),
      decideContractLockRelease(other, null, evidence(), now),
    ]);
    expect(summary).toMatchObject({ total: 2, releasable: 1, hold: 1, holdReasons: { PRODUCT_NOT_FOUND: 1 } });
  });
});
