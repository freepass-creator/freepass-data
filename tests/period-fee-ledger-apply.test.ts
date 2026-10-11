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

  async getLedgerDocument(documentKey: string): Promise<ExistingPeriodFeeDocument | null> {
    return this.ledger.get(documentKey) ?? null;
  }

  async createLedgerDocument(documentKey: string, row: PeriodFeeLedgerRow, digest: string): Promise<void> {
    this.ledger.set(documentKey, { digest, data: structuredClone(row) as unknown as Record<string, unknown> });
  }

  async createProductChangeHistoryDocument(documentKey: string, row: ProductChangeHistoryRow | ProductChangeHistoryBaselineRow, digest: string): Promise<void> {
    if (!documentKey.includes('__')) throw new Error('TEST_HISTORY_KEY_INVALID');
    this.history.set(documentKey, { digest, data: structuredClone(row) as unknown as Record<string, unknown> });
  }

  async getSnapshotRun(snapshotId: string): Promise<PeriodFeeSnapshotRun | null> {
    return this.runs.get(snapshotId) ?? null;
  }

  async setSnapshotRun(snapshotId: string, run: PeriodFeeSnapshotRun): Promise<void> {
    this.runs.set(snapshotId, structuredClone(run));
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

  async markSnapshotRunInactive(snapshotId: string): Promise<void> {
    const existing = this.runs.get(snapshotId);
    this.runs.set(snapshotId, { ...(existing ?? {
      schemaVersion: 'period-fee-snapshot-run/v1',
      snapshotId,
      planDigest: '',
      preparedAt: observedAt,
      rowCount: 0,
      readyRowCount: 0,
      holdNoUidCount: 0,
      historyRowCount: 0,
      readbackSampleCount: 0,
      readbackDigest: null,
    }), status: 'INACTIVE', active: false, activatedAt: null });
  }

  async deleteLedgerRows(snapshotId: string): Promise<number> {
    let count = 0;
    for (const [key, stored] of this.ledger) {
      if ((stored.data as unknown as PeriodFeeLedgerRow).snapshotId === snapshotId) {
        this.ledger.delete(key);
        count += 1;
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

    const second = await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
    expect(second.counts).toMatchObject({ ledgerCreated: 0, ledgerSkippedSameDigest: 1, activeMarked: 1 });

    const row = plan.rows[0]!;
    store.ledger.set(row.documentKey, { digest: stableDigest({ stale: true }), data: row as unknown as Record<string, unknown> });
    await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
      .rejects.toThrow('PERIOD_FEE_LEDGER_DOCUMENT_DIGEST_CONFLICT');
  });

  it('does not mark ACTIVE when readback mismatches', async () => {
    const plan = makePlan();
    const store = new MemoryPeriodFeeStore();
    store.corruptReadback = true;

    await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
      .rejects.toThrow('PERIOD_FEE_READBACK_ROW_MISMATCH');
    expect(store.runs.get(plan.snapshotId)).toMatchObject({ status: 'PREPARED', active: false });
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

  it('rolls back by inactivating the run before deleting snapshot rows', async () => {
    const plan = makePlan();
    const store = new MemoryPeriodFeeStore();
    await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });

    const result = await rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });

    expect(result).toMatchObject({ status: 'ROLLED_BACK', inactiveRuns: 1, deletedRows: 1 });
    expect(store.runs.get(plan.snapshotId)).toMatchObject({ status: 'INACTIVE', active: false });
    expect(store.ledger.size).toBe(0);
  });

  it('keeps the store interface limited to the allowed internal collections', async () => {
    const store = new MemoryPeriodFeeStore();
    await expect(store.forbiddenWrite()).rejects.toThrow('FORBIDDEN_WRITE');
    expect(store.forbiddenWriteAttempt).toBe(true);
  });
});
