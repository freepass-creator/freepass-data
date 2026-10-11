import { describe, expect, it } from 'vitest';
import {
  applyPeriodFeeLedgerPlan,
  rollbackPeriodFeeLedgerSnapshot,
} from '../src/application/apply-period-fee-ledger.js';
import { planPeriodFeeLedger, type PeriodFeeLedgerPlan, type PeriodFeeLedgerRow, type ProductChangeHistoryRow } from '../src/application/period-fee-ledger-plan.js';
import type { ProductChangeHistoryBaselineRow, PeriodFeeSnapshotRun } from '../src/domain/period-fee-ledger.js';
import type { ExistingPeriodFeeDocument, PeriodFeeLedgerApplyStore } from '../src/ports/period-fee-ledger-store.js';
import { stableDigest } from '../src/shared/stable-digest.js';

type Stored = { digest: string; data: Record<string, unknown> };

const observedAt = '2026-10-12T00:00:00.000Z';
const product = (overrides: Record<string, unknown> = {}) => ({
  provider_company_code: 'RP013',
  provider_name: 'TEST-FAKE-SUPPLIER',
  vehicle_uid: 'TEST-FAKE-ASSET-001',
  car_number: 'TEST-FAKE-PLATE-0001',
  product_type: '중고렌트',
  price: { '36': { rent: 800000, deposit: 1000000 } },
  ...overrides,
});

class MemoryPeriodFeeStore implements PeriodFeeLedgerApplyStore {
  ledger = new Map<string, Stored>();
  history = new Map<string, Stored>();
  runs = new Map<string, PeriodFeeSnapshotRun>();
  forbiddenWriteAttempt = false;
  corruptReadback = false;
  failAfterLedgerCreates: number | null = null;
  failDeleteAfter = Number.POSITIVE_INFINITY;
  failRestore = false;
  setSnapshotRunCalls = 0;
  createLedgerCalls = 0;
  createHistoryCalls = 0;
  activateCalls = 0;

  async getLedgerDocument(documentKey: string): Promise<ExistingPeriodFeeDocument | null> {
    return this.ledger.get(documentKey) ?? null;
  }

  async createLedgerDocument(documentKey: string, row: PeriodFeeLedgerRow, digest: string): Promise<void> {
    this.ledger.set(documentKey, { digest, data: structuredClone(row) as unknown as Record<string, unknown> });
    this.createLedgerCalls += 1;
    if (this.failAfterLedgerCreates !== null && this.createLedgerCalls >= this.failAfterLedgerCreates) {
      throw new Error('TEST_LEDGER_CREATE_INTERRUPTED');
    }
  }

  async createProductChangeHistoryDocument(documentKey: string, row: ProductChangeHistoryRow | ProductChangeHistoryBaselineRow, digest: string): Promise<void> {
    if (!documentKey.includes('__')) throw new Error('TEST_HISTORY_KEY_INVALID');
    this.createHistoryCalls += 1;
    this.history.set(documentKey, { digest, data: structuredClone(row) as unknown as Record<string, unknown> });
  }

  async getSnapshotRun(runId: string): Promise<PeriodFeeSnapshotRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async getActiveSnapshotRun(snapshotId: string): Promise<PeriodFeeSnapshotRun | null> {
    const active = [...this.runs.values()].filter(run => run.snapshotId === snapshotId && run.active);
    if (active.length > 1) throw new Error('TEST_ACTIVE_RUN_NOT_UNIQUE');
    return active[0] ?? null;
  }

  async getLatestSupersededSnapshotRun(snapshotId: string, excludeRunId: string): Promise<PeriodFeeSnapshotRun | null> {
    return [...this.runs.values()]
      .filter(run => run.snapshotId === snapshotId && run.status === 'SUPERSEDED' && run.runId !== excludeRunId)
      .sort((a, b) => Date.parse(b.activatedAt ?? '') - Date.parse(a.activatedAt ?? ''))[0] ?? null;
  }

  async setSnapshotRun(runId: string, run: PeriodFeeSnapshotRun): Promise<void> {
    this.setSnapshotRunCalls += 1;
    this.runs.set(runId, structuredClone(run));
  }

  async activateSnapshotRun(runId: string, run: PeriodFeeSnapshotRun, previousActiveRunId: string | null): Promise<void> {
    this.activateCalls += 1;
    this.runs.set(runId, structuredClone(run));
    if (previousActiveRunId && previousActiveRunId !== runId) {
      const previous = this.runs.get(previousActiveRunId);
      if (previous) this.runs.set(previousActiveRunId, { ...previous, status: 'SUPERSEDED', active: false });
    }
  }

  async restoreSnapshotRunActive(runId: string, expectedPlanDigest: string): Promise<void> {
    if (this.failRestore) throw new Error('TEST_RESTORE_INTERRUPTED');
    const run = this.runs.get(runId);
    if (!run || run.planDigest !== expectedPlanDigest || run.status !== 'SUPERSEDED') {
      throw new Error('TEST_RESTORE_RUN_MISMATCH');
    }
    for (const [id, existing] of this.runs) {
      if (existing.snapshotId === run.snapshotId && existing.active && id !== runId) {
        this.runs.set(id, { ...existing, status: 'SUPERSEDED', active: false });
      }
    }
    this.runs.set(runId, { ...run, status: 'ACTIVE', active: true });
  }

  async readLedgerRows(snapshotId: string): Promise<PeriodFeeLedgerRow[]> {
    const rows = [...this.ledger.values()]
      .map(item => item.data as unknown as PeriodFeeLedgerRow)
      .filter(row => row.snapshotId === snapshotId);
    if (!this.corruptReadback) return rows;
    return rows.map((row, index) => index === 0
      ? { ...row, monthlyRent: { ...row.monthlyRent, amount: row.monthlyRent.amount + 1 } }
      : row);
  }

  async markSnapshotRunInactive(runId: string): Promise<void> {
    const existing = this.runs.get(runId);
    this.runs.set(runId, { ...(existing ?? {
      schemaVersion: 'period-fee-snapshot-run/v1',
      runId,
      snapshotId: runId,
      planDigest: '',
      previousActiveRunId: null,
      rowKeys: [],
      rowDigests: {},
      plannedCreateKeys: [],
      createdDocumentKeys: [],
      preparedAt: observedAt,
      rowCount: 0,
      readyRowCount: 0,
      holdNoUidCount: 0,
      historyRowCount: 0,
      readbackSampleCount: 0,
      readbackDigest: null,
    }), status: 'INACTIVE', active: false, activatedAt: null });
  }

  async deleteLedgerRowsByDigest(documentDigests: Array<{ documentKey: string; digest: string }>): Promise<number> {
    let count = 0;
    for (const target of documentDigests) {
      const stored = this.ledger.get(target.documentKey);
      if (stored?.digest === target.digest) {
        this.ledger.delete(target.documentKey);
        count += 1;
        if (count >= this.failDeleteAfter) throw new Error('TEST_DELETE_INTERRUPTED');
      }
    }
    return count;
  }

  async forbiddenWrite(): Promise<void> {
    this.forbiddenWriteAttempt = true;
    throw new Error('FORBIDDEN_WRITE');
  }
}

const makePlan = (products: Record<string, Record<string, unknown>> = { p1: product() }): PeriodFeeLedgerPlan =>
  planPeriodFeeLedger({ products, policies: {}, referenceInputs: {} }, { clock: () => new Date(observedAt) });

const runIdFor = (plan: PeriodFeeLedgerPlan) => `${plan.snapshotId}__${plan.planDigest.slice(0, 24)}`;

describe('period fee ledger apply', () => {
  it('dry-runs with zero writes when approval env is absent at the application boundary', async () => {
    const plan = makePlan();
    const store = new MemoryPeriodFeeStore();

    const result = await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: false });

    expect(result).toMatchObject({ status: 'DRY_RUN', writesEnabled: false, counts: { ledgerCreated: 0, activeMarked: 0 } });
    expect(store.ledger.size).toBe(0);
    expect(store.history.size).toBe(0);
    expect(store.runs.size).toBe(0);
  });

  it('rejects a digest mismatch before writing anything', async () => {
    const plan = makePlan();
    const store = new MemoryPeriodFeeStore();

    await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: 'wrong', writeApproved: true }))
      .rejects.toThrow('PERIOD_FEE_PLAN_DIGEST_MISMATCH');
    expect(store.ledger.size).toBe(0);
  });

  it('does not write HOLD_NO_UID rows but reports them', async () => {
    const plan = makePlan({ ok: product(), noUid: product({ vehicle_uid: undefined, assetId: undefined }) });
    const store = new MemoryPeriodFeeStore();

    const result = await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });

    expect(result.counts).toMatchObject({ plannedRows: 2, readyRows: 1, holdNoUidRows: 1, ledgerCreated: 1, activeMarked: 1 });
    expect([...store.ledger.values()].every(row => (row.data as unknown as PeriodFeeLedgerRow).vehicleUid)).toBe(true);
  });

  it('is idempotent for same document digests and refuses conflicting documents', async () => {
    const plan = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });

    const callsBefore = {
      setSnapshotRunCalls: store.setSnapshotRunCalls,
      createLedgerCalls: store.createLedgerCalls,
      createHistoryCalls: store.createHistoryCalls,
      activateCalls: store.activateCalls,
    };
    const runBefore = structuredClone(store.runs.get(runIdFor(plan))!);
    const second = await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
    expect(second.counts).toMatchObject({ ledgerCreated: 0, ledgerSkippedSameDigest: 1, activeMarked: 0 });
    expect({
      setSnapshotRunCalls: store.setSnapshotRunCalls,
      createLedgerCalls: store.createLedgerCalls,
      createHistoryCalls: store.createHistoryCalls,
      activateCalls: store.activateCalls,
    }).toEqual(callsBefore);
    expect(store.runs.get(runIdFor(plan))).toEqual(runBefore);
    expect(store.runs.get(runIdFor(plan))?.createdDocumentKeys).toEqual([plan.rows[0]!.documentKey]);

    const row = plan.rows[0]!;
    store.ledger.set(row.documentKey, { digest: stableDigest({ stale: true }), data: row as unknown as Record<string, unknown> });
    await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
      .rejects.toThrow('PERIOD_FEE_LEDGER_DOCUMENT_DIGEST_CONFLICT');
  });

  it('rejects a stored same-run digest conflict before rewriting ACTIVE evidence', async () => {
    const plan = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
    const runId = runIdFor(plan);
    store.runs.set(runId, { ...store.runs.get(runId)!, planDigest: 'TEST-FAKE-DIFFERENT-DIGEST' });
    const callsBefore = store.setSnapshotRunCalls;

    await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
      .rejects.toThrow('PERIOD_FEE_RUN_DIGEST_CONFLICT');

    expect(store.setSnapshotRunCalls).toBe(callsBefore);
    expect(store.runs.get(runId)).toMatchObject({ status: 'ACTIVE', active: true, previousActiveRunId: null });
  });

  it('does not mark ACTIVE when readback mismatches', async () => {
    const plan = makePlan();
    const store = new MemoryPeriodFeeStore();
    store.corruptReadback = true;

    await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
      .rejects.toThrow('PERIOD_FEE_READBACK_ROW_MISMATCH');
    expect(store.runs.get(runIdFor(plan))).toMatchObject({ status: 'PREPARED', active: false });
  });

  it('records a first-snapshot baseline and append-only history rows', async () => {
    const first = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
    expect([...store.history.values()].some(row => row.data.kind === 'BASELINE')).toBe(true);

    const second = planPeriodFeeLedger({
      products: { p1: product({ price: { '36': { rent: 850000, deposit: 1000000 } } }) },
      policies: {},
      referenceInputs: {},
      previousSnapshot: { rows: first.rows, productStates: first.baselines.productStates },
    }, { clock: () => new Date('2026-10-13T00:00:00.000Z') });
    await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
    expect([...store.history.values()].some(row => row.data.kind === 'RENT')).toBe(true);
  });

  it('rolls back by deleting only documents the run actually created', async () => {
    const plan = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });

    const result = await rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });

    expect(result).toMatchObject({ status: 'ROLLED_BACK', inactiveRuns: 1, deletedRows: 1 });
    expect(store.runs.get(runIdFor(plan))).toMatchObject({ status: 'ROLLED_BACK', active: false });
    expect(store.ledger.size).toBe(0);
  });

  it('persists planned create keys before row creation so interrupted apply can be rolled back', async () => {
    const plan = makePlan({ p1: product(), p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }) });
    const store = new MemoryPeriodFeeStore();
    store.failAfterLedgerCreates = 1;

    await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
      .rejects.toThrow('TEST_LEDGER_CREATE_INTERRUPTED');

    const run = store.runs.get(runIdFor(plan))!;
    expect(run).toMatchObject({ status: 'PREPARED', active: false });
    expect(run.plannedCreateKeys.sort()).toEqual(plan.rows.map(row => row.documentKey).sort());
    expect(run.createdDocumentKeys).toEqual([]);

    store.failAfterLedgerCreates = null;
    const result = await rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });

    expect(result.deletedRows).toBe(1);
    expect(store.ledger.size).toBe(0);
    expect(store.runs.get(runIdFor(plan))).toMatchObject({ status: 'ROLLED_BACK', active: false });
  });

  it('keeps ownership when retrying a digest-identical planned row created before an interrupted apply', async () => {
    const plan = makePlan({ p1: product(), p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }) });
    const store = new MemoryPeriodFeeStore();
    store.failAfterLedgerCreates = 1;
    await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
      .rejects.toThrow('TEST_LEDGER_CREATE_INTERRUPTED');
    store.failAfterLedgerCreates = null;

    const result = await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });

    expect(result.counts).toMatchObject({ ledgerCreated: 1, ledgerSkippedSameDigest: 1, activeMarked: 1 });
    const run = store.runs.get(runIdFor(plan))!;
    expect(run.plannedCreateKeys.sort()).toEqual(plan.rows.map(row => row.documentKey).sort());
    expect(run.createdDocumentKeys).toEqual([plan.rows[1]!.documentKey]);
    expect(store.ledger.size).toBe(2);
  });

  it('does not delete another run owned document that is outside this run ownership keys', async () => {
    const plan = makePlan({ p1: product(), p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }) });
    const store = new MemoryPeriodFeeStore();
    store.failAfterLedgerCreates = 1;
    await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
      .rejects.toThrow('TEST_LEDGER_CREATE_INTERRUPTED');
    store.failAfterLedgerCreates = null;
    const foreignRow = plan.rows[1]!;
    store.ledger.set(foreignRow.documentKey, { digest: stableDigest(foreignRow), data: foreignRow as unknown as Record<string, unknown> });
    const run = store.runs.get(runIdFor(plan))!;
    store.runs.set(runIdFor(plan), { ...run, plannedCreateKeys: [plan.rows[0]!.documentKey] });

    const result = await rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });

    expect(result.deletedRows).toBe(1);
    expect(store.ledger.has(plan.rows[0]!.documentKey)).toBe(false);
    expect(store.ledger.has(foreignRow.documentKey)).toBe(true);
  });

  it('refuses rollback of a superseded history-only run and deletes zero shared ledger rows', async () => {
    const first = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
    const history: ProductChangeHistoryRow[] = [{
      schemaVersion: 'product-change-history/v1',
      productKey: 'p1',
      kind: 'STATUS',
      fieldPath: 'status',
      before: 'TEST-FAKE-BEFORE',
      after: 'TEST-FAKE-AFTER',
      changedAtKst: '2026-10-12',
      snapshotId: first.snapshotId,
      sourceObservationRef: null,
    }];
    const secondBase = { ...first, history };
    const second = {
      ...secondBase,
      planDigest: stableDigest({
        snapshotId: secondBase.snapshotId,
        rows: secondBase.rows,
        history: secondBase.history,
        baselines: secondBase.baselines,
      }),
    };
    await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });

    await expect(rollbackPeriodFeeLedgerSnapshot(store, first, { expectedDigest: first.planDigest, writeApproved: true }))
      .rejects.toThrow('RUN_NOT_REAPPLICABLE');

    expect(store.ledger.size).toBe(1);
    expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'SUPERSEDED', active: false });
    expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ACTIVE', active: true, createdDocumentKeys: [] });
  });

  it('keeps PREPARED rollback rows that another ACTIVE run references by rowKeys', async () => {
    const first = makePlan();
    const store = new MemoryPeriodFeeStore();
    store.failAfterLedgerCreates = 1;
    await expect(applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true }))
      .rejects.toThrow('TEST_LEDGER_CREATE_INTERRUPTED');
    store.failAfterLedgerCreates = null;

    const history: ProductChangeHistoryRow[] = [{
      schemaVersion: 'product-change-history/v1',
      productKey: 'p1',
      kind: 'STATUS',
      fieldPath: 'status',
      before: 'TEST-FAKE-BEFORE',
      after: 'TEST-FAKE-AFTER',
      changedAtKst: '2026-10-12',
      snapshotId: first.snapshotId,
      sourceObservationRef: null,
    }];
    const secondBase = { ...first, history };
    const second = {
      ...secondBase,
      planDigest: stableDigest({
        snapshotId: secondBase.snapshotId,
        rows: secondBase.rows,
        history: secondBase.history,
        baselines: secondBase.baselines,
      }),
    };
    await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });

    const result = await rollbackPeriodFeeLedgerSnapshot(store, first, { expectedDigest: first.planDigest, writeApproved: true });

    expect(result).toMatchObject({ status: 'ROLLED_BACK', deletedRows: 0, keptSharedByActiveRows: 1 });
    expect(store.ledger.has(first.rows[0]!.documentKey)).toBe(true);
    expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ROLLED_BACK', active: false });
    expect(store.runs.get(runIdFor(second))).toMatchObject({
      status: 'ACTIVE',
      active: true,
      createdDocumentKeys: [],
      rowKeys: [first.rows[0]!.documentKey],
    });
  });

  it('rejects reapply of a superseded run', async () => {
    const first = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
    const history: ProductChangeHistoryRow[] = [{
      schemaVersion: 'product-change-history/v1',
      productKey: 'p1',
      kind: 'STATUS',
      fieldPath: 'status',
      before: 'TEST-FAKE-BEFORE',
      after: 'TEST-FAKE-AFTER',
      changedAtKst: '2026-10-12',
      snapshotId: first.snapshotId,
      sourceObservationRef: null,
    }];
    const secondBase = { ...first, history };
    const second = {
      ...secondBase,
      planDigest: stableDigest({
        snapshotId: secondBase.snapshotId,
        rows: secondBase.rows,
        history: secondBase.history,
        baselines: secondBase.baselines,
      }),
    };
    await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });

    await expect(applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true }))
      .rejects.toThrow('RUN_NOT_REAPPLICABLE');

    expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'SUPERSEDED', active: false });
    expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ACTIVE', active: true });
  });

  it('refuses previous run restore when its row digest readback is missing and keeps current ACTIVE', async () => {
    const first = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
    const second = makePlan({
      p1: product(),
      p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }),
    });
    await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
    store.ledger.delete(first.rows[0]!.documentKey);

    await expect(rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
      .rejects.toThrow('PERIOD_FEE_RESTORE_LEDGER_READBACK_FAILED');

    expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ACTIVE', active: true });
    expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ runId: runIdFor(second) });
    expect(store.ledger.has(second.rows[1]!.documentKey)).toBe(true);
  });

  it('rolls back an active history-only run without deleting shared ledger rows and restores the previous run', async () => {
    const first = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
    const history: ProductChangeHistoryRow[] = [{
      schemaVersion: 'product-change-history/v1',
      productKey: 'p1',
      kind: 'STATUS',
      fieldPath: 'status',
      before: 'TEST-FAKE-BEFORE',
      after: 'TEST-FAKE-AFTER',
      changedAtKst: '2026-10-12',
      snapshotId: first.snapshotId,
      sourceObservationRef: null,
    }];
    const secondBase = { ...first, history };
    const second = {
      ...secondBase,
      planDigest: stableDigest({
        snapshotId: secondBase.snapshotId,
        rows: secondBase.rows,
        history: secondBase.history,
        baselines: secondBase.baselines,
      }),
    };
    await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });

    const result = await rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true });

    expect(result).toMatchObject({ status: 'ROLLED_BACK', deletedRows: 0 });
    expect(store.ledger.size).toBe(1);
    expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLED_BACK', active: false });
    expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ACTIVE', active: true });
  });

  it('resumes rollback after delete interruption and restores the previous ACTIVE run', async () => {
    const first = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
    const second = makePlan({
      p1: product(),
      p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }),
    });
    await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
    store.failDeleteAfter = 1;

    await expect(rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
      .rejects.toThrow('TEST_DELETE_INTERRUPTED');
    expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLING_BACK', active: false, previousActiveRunId: runIdFor(first) });

    store.failDeleteAfter = Number.POSITIVE_INFINITY;
    const result = await rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true });

    expect(result).toMatchObject({ status: 'ROLLED_BACK', deletedRows: 0 });
    expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ACTIVE', active: true });
    expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLED_BACK', active: false });
    expect(store.ledger.has(second.rows[1]!.documentKey)).toBe(false);
    expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ runId: runIdFor(first) });
  });

  it('resumes rollback after restore interruption and keeps an ACTIVE run available', async () => {
    const first = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
    const history: ProductChangeHistoryRow[] = [{
      schemaVersion: 'product-change-history/v1',
      productKey: 'p1',
      kind: 'STATUS',
      fieldPath: 'status',
      before: 'TEST-FAKE-BEFORE',
      after: 'TEST-FAKE-AFTER',
      changedAtKst: '2026-10-12',
      snapshotId: first.snapshotId,
      sourceObservationRef: null,
    }];
    const secondBase = { ...first, history };
    const second = {
      ...secondBase,
      planDigest: stableDigest({
        snapshotId: secondBase.snapshotId,
        rows: secondBase.rows,
        history: secondBase.history,
        baselines: secondBase.baselines,
      }),
    };
    await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
    store.failRestore = true;

    await expect(rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
      .rejects.toThrow('TEST_RESTORE_INTERRUPTED');
    expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLING_BACK', active: false, previousActiveRunId: runIdFor(first) });

    store.failRestore = false;
    const result = await rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true });

    expect(result).toMatchObject({ status: 'ROLLED_BACK', deletedRows: 0 });
    expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ACTIVE', active: true });
    expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLED_BACK', active: false });
    expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ runId: runIdFor(first) });
  });

  it('keeps the existing ACTIVE run when a same-day digest conflict aborts', async () => {
    const first = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });

    const second = makePlan({ p1: product({ price: { '36': { rent: 810000, deposit: 1000000 } } }) });
    await expect(applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
      .rejects.toThrow('PERIOD_FEE_LEDGER_DOCUMENT_DIGEST_CONFLICT');

    expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ACTIVE', active: true });
    expect(store.runs.has(runIdFor(second))).toBe(false);
    expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ planDigest: first.planDigest });
  });

  it('keeps the existing ACTIVE run when readback fails for a new run', async () => {
    const first = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });

    const second = planPeriodFeeLedger({
      products: { p1: product({ price: { '36': { rent: 810000, deposit: 1000000 } } }) },
      policies: {},
      referenceInputs: {},
      previousSnapshot: { rows: [], productStates: {} },
    }, { clock: () => new Date('2026-10-13T00:00:00.000Z') });
    store.corruptReadback = true;

    await expect(applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
      .rejects.toThrow('PERIOD_FEE_READBACK_ROW_MISMATCH');

    expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'PREPARED', active: false });
    expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ACTIVE', active: true });
    expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ planDigest: first.planDigest });
  });

  it('activates the new run and supersedes the previous active run only after readback', async () => {
    const first = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
    const history: ProductChangeHistoryRow[] = [{
      schemaVersion: 'product-change-history/v1',
      productKey: 'p1',
      kind: 'STATUS',
      fieldPath: 'status',
      before: 'TEST-FAKE-BEFORE',
      after: 'TEST-FAKE-AFTER',
      changedAtKst: '2026-10-12',
      snapshotId: first.snapshotId,
      sourceObservationRef: null,
    }];
    const secondBase = { ...first, history };
    const second = {
      ...secondBase,
      planDigest: stableDigest({
        snapshotId: secondBase.snapshotId,
        rows: secondBase.rows,
        history: secondBase.history,
        baselines: secondBase.baselines,
      }),
    };
    await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });

    expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'SUPERSEDED', active: false });
    expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ACTIVE', active: true });
    expect([...store.runs.values()].filter(run => run.snapshotId === second.snapshotId && run.active)).toHaveLength(1);
  });

  it('refuses rollback when the stored run digest does not match and deletes zero rows', async () => {
    const plan = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
    const runId = runIdFor(plan);
    store.runs.set(runId, { ...store.runs.get(runId)!, planDigest: 'TEST-FAKE-DIFFERENT-DIGEST' });

    await expect(rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
      .rejects.toThrow('PERIOD_FEE_ROLLBACK_RUN_DIGEST_MISMATCH');

    expect(store.ledger.size).toBe(1);
    expect(store.runs.get(runId)).toMatchObject({ status: 'ACTIVE', active: true });
  });

  it('keeps the store interface limited to the allowed internal collections', async () => {
    const store = new MemoryPeriodFeeStore();
    await expect(store.forbiddenWrite()).rejects.toThrow('FORBIDDEN_WRITE');
    expect(store.forbiddenWriteAttempt).toBe(true);
  });
});
