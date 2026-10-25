import { describe, expect, it } from 'vitest';
import {
  contractLockPlanDigest,
  decideContractLockRelease,
  parseContractLockReleasePlan,
  parseContractLockSheetEvidence,
  summarizeContractLockDecisions,
} from '../src/application/contract-lock-release.js';
import { buildContractLockReleaseUpdate } from '../src/domain/contract-lock-release-update.js';
import { runReleaseContractLocks, type ContractLockRuntime } from '../src/jobs/release-contract-locks.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = new Date('2026-10-12T05:00:00.000Z');
const item = { plate: '11가0001', supplierCode: 'RP001', sheetRow: 10, expectedLockAt: 1790000000000 };
const product = { provider_company_code: 'RP001', locked_by_contract: 'LEDGER', _ledger_lock_at: 1790000000000, status: '계약중' };
const evidence = (patch: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  readAt: '2026-10-12T04:55:00.000Z',
  otherTabsRead: ['분납실적', '완납실적'],
  items: [{ plate: '11가0001', intakeRows: [{ row: 10, cancel: true }], otherTabHits: 0, ...patch }],
  ...top,
});
const parsed = (value: unknown) => parseContractLockSheetEvidence(value);

describe('contract lock release decision', () => {
  it('releases only when product state and fresh sheet evidence both match', () => {
    expect(decideContractLockRelease(item, product, parsed(evidence()), now)).toMatchObject({ decision: 'RELEASABLE' });
  });

  it.each([
    ['PRODUCT_NOT_FOUND', null, evidence()],
    ['SUPPLIER_MISMATCH', { ...product, provider_company_code: 'RP002' }, evidence()],
    ['LOCK_VALUE_NOT_LEDGER', { ...product, locked_by_contract: 'X' }, evidence()],
    ['LOCK_TIME_CHANGED', { ...product, _ledger_lock_at: 1 }, evidence()],
    ['SHEET_EVIDENCE_STALE', product, evidence({}, { readAt: '2026-10-12T04:00:00.000Z' })],
    ['SHEET_ROW_NOT_FOUND', product, evidence({ intakeRows: [{ row: 99, cancel: true }] })],
    ['SHEET_CANCEL_NOT_ENTERED', product, evidence({ intakeRows: [{ row: 10, cancel: false }] })],
    ['LIVE_INTAKE_ROW_EXISTS', product, evidence({ intakeRows: [{ row: 10, cancel: true }, { row: 20, cancel: false }] })],
    ['OTHER_TAB_HIT', product, evidence({ otherTabHits: 1 })],
  ])('holds with %s', (reason, productInput, evidenceInput) => {
    expect(decideContractLockRelease(item, productInput as never, parsed(evidenceInput), now)).toMatchObject({ decision: 'HOLD', reason });
  });

  it('holds when evidence is missing', () => {
    expect(decideContractLockRelease(item, product, null, now)).toMatchObject({ decision: 'HOLD', reason: 'SHEET_EVIDENCE_MISSING' });
  });

  it('rejects malformed evidence instead of treating it as proof (string "FALSE", missing or null otherTabHits, no tabs read)', () => {
    expect(parsed(evidence({ intakeRows: [{ row: 10, cancel: true }, { row: 20, cancel: 'FALSE' }] }))).toBeNull();
    expect(parsed(evidence({ intakeRows: [{ row: 10, cancel: 'TRUE' }] }))).toBeNull();
    expect(parsed(evidence({ otherTabHits: undefined }))).toBeNull();
    expect(parsed(evidence({ otherTabHits: null }))).toBeNull();
    expect(parsed(evidence({ otherTabHits: -1 }))).toBeNull();
    expect(parsed(evidence({ otherTabHits: Number.NaN }))).toBeNull();
    expect(parsed(evidence({}, { otherTabsRead: [] }))).toBeNull();
    expect(parsed(evidence({}, { otherTabsRead: ['분납실적'] }))).toBeNull(); // 완납실적 미조회
    expect(parsed({ ...evidence(), items: [evidence().items[0], { ...evidence().items[0], otherTabHits: 1 }] })).toBeNull(); // 같은 차량 중복
    expect(parsed(evidence({}, { otherTabsRead: undefined }))).toBeNull();
    expect(parsed(evidence({}, { readAt: 'not-a-date' }))).toBeNull();
    expect(parsed(evidence())).not.toBeNull();
  });

  it('digest is order independent and summary counts reasons', () => {
    const other = { ...item, plate: '11가0002' };
    expect(contractLockPlanDigest({ planId: 'p', items: [item, other] })).toBe(contractLockPlanDigest({ planId: 'p', items: [other, item] }));
    const summary = summarizeContractLockDecisions([
      decideContractLockRelease(item, product, parsed(evidence()), now),
      decideContractLockRelease(other, null, parsed(evidence()), now),
    ]);
    expect(summary).toMatchObject({ total: 2, releasable: 1, hold: 1, holdReasons: { PRODUCT_NOT_FOUND: 1 } });
  });
});

describe('정산원장 (legacy Korean lock) release', () => {
  const legacyItem = { plate: '11가0003', supplierCode: 'RP023', sheetRow: 12, expectedLockAt: 1789022065389 };
  const legacy = { provider_company_code: 'RP023', locked_by_contract: '정산원장', _ledger_status_at: 1789022065389, status: '계약중' };
  const ev = (plate: string, row: number) => ({ plate, intakeRows: [{ row, cancel: true }], otherTabHits: 0 });
  const evidenceBoth = parsed({ ...evidence(), items: [ev('11가0001', 10), ev('11가0003', 12)] });

  it('releases when _ledger_status_at matches', () => {
    expect(decideContractLockRelease(legacyItem, legacy, evidenceBoth, now)).toMatchObject({ decision: 'RELEASABLE' });
  });
  it('holds LOCK_TIME_CHANGED on status_at mismatch (and _ledger_lock_at is not accepted)', () => {
    expect(decideContractLockRelease(legacyItem, { ...legacy, _ledger_status_at: 1 }, evidenceBoth, now)).toMatchObject({ reason: 'LOCK_TIME_CHANGED' });
    const { _ledger_status_at: _d, ...noStatus } = legacy;
    expect(decideContractLockRelease(legacyItem, { ...noStatus, _ledger_lock_at: legacyItem.expectedLockAt }, evidenceBoth, now)).toMatchObject({ reason: 'LOCK_TIME_CHANGED' });
  });
  it('keeps the other safety conditions', () => {
    const cancelNo = parsed({ ...evidence(), items: [{ ...ev('11가0003', 12), intakeRows: [{ row: 12, cancel: false }] }] });
    expect(decideContractLockRelease(legacyItem, legacy, cancelNo, now)).toMatchObject({ reason: 'SHEET_CANCEL_NOT_ENTERED' });
    const hit = parsed({ ...evidence(), items: [{ ...ev('11가0003', 12), otherTabHits: 2 }] });
    expect(decideContractLockRelease(legacyItem, legacy, hit, now)).toMatchObject({ reason: 'OTHER_TAB_HIT' });
    expect(decideContractLockRelease(legacyItem, legacy, evidenceBoth, new Date('2026-10-12T06:00:00.000Z'))).toMatchObject({ reason: 'SHEET_EVIDENCE_STALE' });
  });
  it('LEDGER regression and mixed plan are judged per item', () => {
    expect(decideContractLockRelease(item, product, evidenceBoth, now)).toMatchObject({ decision: 'RELEASABLE' });
    const bad = { ...legacyItem, plate: '11가0004' };
    expect(decideContractLockRelease(bad, { ...legacy, _ledger_status_at: 5 }, evidenceBoth, now)).toMatchObject({ decision: 'HOLD' });
  });
  it('records actual previous lock value and token for undo; LEDGER shape unchanged', () => {
    const upd = buildContractLockReleaseUpdate(legacy, { expectedLockAt: legacyItem.expectedLockAt, reason: 'r' }, 1);
    expect(upd).toMatchObject({ locked_by_contract: null, _ledger_unlock_previous: { locked_by_contract: '정산원장', token_field: '_ledger_status_at', token_value: 1789022065389 } });
    expect(buildContractLockReleaseUpdate(product, { expectedLockAt: 5, reason: 'r' }, 1)._ledger_unlock_previous).toEqual({ locked_by_contract: 'LEDGER', _ledger_lock_at: 5 });
  });
  it('job releases a mixed plan and flags readback mismatch per item', async () => {
    const plan = { planId: 'mix', items: [item, legacyItem] };
    const dir = await mkdtemp(join(tmpdir(), 'lock-mix-'));
    await writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
    await writeFile(join(dir, 'ev.json'), JSON.stringify({ readAt: '2026-10-12T04:58:00.000Z', otherTabsRead: ['분납실적', '완납실적'], items: [ev('11가0001', 10), ev('11가0003', 12)] }));
    const stored = new Map<string, string>();
    const calls: string[] = [];
    const runtime: ContractLockRuntime = {
      readProducts: async ids => Object.fromEntries(ids.map(id => [id, id === legacyItem.plate ? { ...legacy, locked_by_contract: calls.includes(id) ? '정산원장' : legacy.locked_by_contract } : { ...product, locked_by_contract: calls.includes(id) ? null : 'LEDGER' }])),
      release: async (_d, input) => { calls.push(input.id); return 'RELEASED'; },
    };
    const result = await runReleaseContractLocks(
      ['--plan', join(dir, 'plan.json'), '--evidence', join(dir, 'ev.json'), '--apply', '--backup-dir', join(dir, 'bk')],
      { FREEPASS_CONTRACT_LOCK_RELEASE: 'on', FREEPASS_CONTRACT_LOCK_RELEASE_APPROVED: contractLockPlanDigest(plan) },
      { runtime, clock: () => now, writeBackup: async (p, t) => { stored.set(p, t); }, readBackup: async p => stored.get(p) ?? '' },
    ) as { writes: number; results: Array<{ result: string }> };
    expect(calls).toEqual([item.plate, legacyItem.plate]);
    expect(result.results.map(r => r.result)).toEqual(['RELEASED', 'READBACK_MISMATCH']);
    expect(result.writes).toBe(1);
  });
});

describe('release-contract-locks job', () => {
  const second = { ...item, plate: '11가0002', sheetRow: 11 };
  const plan = { planId: 'p', items: [item, second] };
  const ev = {
    readAt: '2026-10-12T04:58:00.000Z',
    otherTabsRead: ['분납실적', '완납실적'],
    items: [
      { plate: item.plate, intakeRows: [{ row: 10, cancel: true }], otherTabHits: 0 },
      { plate: second.plate, intakeRows: [{ row: 11, cancel: true }], otherTabHits: 0 },
    ],
  };

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'lock-release-'));
    await writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
    await writeFile(join(dir, 'ev.json'), JSON.stringify(ev));
    const { contractLockPlanDigest: digest } = await import('../src/application/contract-lock-release.js');
    return { dir, digest: digest(plan) };
  }
  const makeRuntime = (calls: string[]): ContractLockRuntime => ({
    readProducts: async ids => Object.fromEntries(ids.map(id => [id, { ...product }])),
    release: async (_digest, input) => { calls.push(input.id); return 'RELEASED'; },
  });

  it('writes nothing when the second backup fails', async () => {
    const { dir, digest } = await setup();
    const calls: string[] = [];
    let backups = 0;
    const runtime = makeRuntime(calls);
    runtime.readProducts = async ids => Object.fromEntries(ids.map(id => [id, { ...product }]));
    const result = await runReleaseContractLocks(
      ['--plan', join(dir, 'plan.json'), '--evidence', join(dir, 'ev.json'), '--apply', '--backup-dir', join(dir, 'bk')],
      { FREEPASS_CONTRACT_LOCK_RELEASE: 'on', FREEPASS_CONTRACT_LOCK_RELEASE_APPROVED: digest },
      {
        runtime, clock: () => now,
        writeBackup: async () => { backups += 1; if (backups === 2) throw new Error('disk'); },
        readBackup: async () => '',
      },
    ) as { status?: string; writes: number };
    expect(result.status).toBe('ABORTED_BACKUP_FAILED');
    expect(result.writes).toBe(0);
    expect(calls).toEqual([]);
  });

  it('refuses a stale approval digest and releases both items after all backups verify', async () => {
    const { dir, digest } = await setup();
    await expect(runReleaseContractLocks(
      ['--plan', join(dir, 'plan.json'), '--evidence', join(dir, 'ev.json'), '--apply', '--backup-dir', join(dir, 'bk')],
      { FREEPASS_CONTRACT_LOCK_RELEASE: 'on', FREEPASS_CONTRACT_LOCK_RELEASE_APPROVED: 'wrong' },
      { runtime: makeRuntime([]), clock: () => now },
    )).rejects.toThrow('CONTRACT_LOCK_RELEASE_NOT_APPROVED');

    const stored = new Map<string, string>();
    const calls: string[] = [];
    const runtime = makeRuntime(calls);
    let released = false;
    runtime.readProducts = async ids => Object.fromEntries(ids.map(id => [id, released ? { ...product, locked_by_contract: null } : { ...product }]));
    runtime.release = async (_d, input) => { calls.push(input.id); released = true; return 'RELEASED'; };
    const result = await runReleaseContractLocks(
      ['--plan', join(dir, 'plan.json'), '--evidence', join(dir, 'ev.json'), '--apply', '--backup-dir', join(dir, 'bk')],
      { FREEPASS_CONTRACT_LOCK_RELEASE: 'on', FREEPASS_CONTRACT_LOCK_RELEASE_APPROVED: digest },
      {
        runtime, clock: () => now,
        writeBackup: async (path, text) => { stored.set(path, text); },
        readBackup: async path => stored.get(path) ?? '',
      },
    ) as { writes: number };
    expect(stored.size).toBe(2);
    expect(calls).toEqual([item.plate, second.plate]);
    expect(result.writes).toBe(2);
  });

  it('passes the evidence read time and max age to every release so expiry is re-checked per attempt', async () => {
    const { dir, digest } = await setup();
    const seen: Array<{ evidenceReadAt: string; maxEvidenceAgeMs: number }> = [];
    const stored = new Map<string, string>();
    const runtime = makeRuntime([]);
    runtime.release = async (_d, input) => { seen.push({ evidenceReadAt: input.evidenceReadAt, maxEvidenceAgeMs: input.maxEvidenceAgeMs }); return 'EVIDENCE_EXPIRED'; };
    const result = await runReleaseContractLocks(
      ['--plan', join(dir, 'plan.json'), '--evidence', join(dir, 'ev.json'), '--apply', '--backup-dir', join(dir, 'bk')],
      { FREEPASS_CONTRACT_LOCK_RELEASE: 'on', FREEPASS_CONTRACT_LOCK_RELEASE_APPROVED: digest },
      { runtime, clock: () => now, writeBackup: async (p, t) => { stored.set(p, t); }, readBackup: async p => stored.get(p) ?? '' },
    ) as { writes: number; results: Array<{ result: string }> };
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ evidenceReadAt: ev.readAt, maxEvidenceAgeMs: 15 * 60 * 1000 });
    expect(result.writes).toBe(0);
    expect(result.results.map(entry => entry.result)).toEqual(['EVIDENCE_EXPIRED', 'EVIDENCE_EXPIRED']);
  });
  it('rejects plans with a missing lock time, bad row, or duplicate vehicle', () => {
    const { expectedLockAt: _drop, ...noLockAt } = item;
    expect(parseContractLockReleasePlan({ planId: 'p', items: [noLockAt] })).toBeNull();
    expect(parseContractLockReleasePlan({ planId: 'p', items: [{ ...item, sheetRow: 0 }] })).toBeNull();
    expect(parseContractLockReleasePlan({ planId: 'p', items: [item, item] })).toBeNull();
    expect(parseContractLockReleasePlan({ planId: 'p', items: [item] })).not.toBeNull();
  });
  it('keeps earlier unlock history instead of overwriting it', () => {
    const fresh = buildContractLockReleaseUpdate(product, { expectedLockAt: 5, reason: 'r2' }, 200);
    expect(fresh).toMatchObject({ locked_by_contract: null, _ledger_unlocked_at: 200, _ledger_unlock_reason: 'r2' });
    expect(fresh).not.toHaveProperty('_ledger_unlock_history');
    const again = buildContractLockReleaseUpdate({ ...product, _ledger_unlocked_at: 100, _ledger_unlock_reason: 'r1', _ledger_unlock_previous: { locked_by_contract: 'LEDGER', _ledger_lock_at: 4 } }, { expectedLockAt: 5, reason: 'r2' }, 200);
    expect(again._ledger_unlock_history).toEqual([{ at: 100, reason: 'r1', previous: { locked_by_contract: 'LEDGER', _ledger_lock_at: 4 } }]);
    const third = buildContractLockReleaseUpdate({ ...product, ...again, _ledger_unlocked_at: 200 }, { expectedLockAt: 6, reason: 'r3' }, 300);
    expect((third._ledger_unlock_history as unknown[]).length).toBe(2);
  });
});
