import { stableDigest } from '../shared/stable-digest.js';
import type { PeriodFeeLedgerPlan } from './period-fee-ledger-plan.js';
import type {
  PeriodFeeLedgerRow,
  ProductChangeHistoryBaselineRow,
  ProductChangeHistoryRow,
} from '../domain/period-fee-ledger.js';
import type { PeriodFeeLedgerApplyStore } from '../ports/period-fee-ledger-store.js';

export type PeriodFeeLedgerApplyOptions = {
  expectedDigest: string;
  writeApproved: boolean;
  now?: () => Date;
  sampleSize?: number;
};

export type PeriodFeeLedgerRollbackOptions = {
  expectedDigest: string;
  writeApproved: boolean;
};

export type PeriodFeeLedgerApplyResult = {
  status: 'DRY_RUN' | 'APPLIED';
  snapshotId: string;
  planDigest: string;
  writesEnabled: boolean;
  counts: {
    plannedRows: number;
    readyRows: number;
    holdNoUidRows: number;
    ledgerCreated: number;
    ledgerSkippedSameDigest: number;
    historyCreated: number;
    activeMarked: number;
  };
};

export type PeriodFeeLedgerRollbackResult = {
  status: 'DRY_RUN' | 'ROLLED_BACK';
  snapshotId: string;
  planDigest: string;
  writesEnabled: boolean;
  inactiveRuns: number;
  deletedRows: number;
};

const planDigestBase = (plan: PeriodFeeLedgerPlan) => ({
  snapshotId: plan.snapshotId,
  rows: plan.rows,
  history: plan.history,
  baselines: plan.baselines,
});

export function validatePeriodFeeLedgerPlan(plan: PeriodFeeLedgerPlan, expectedDigest: string): void {
  if (plan.schema !== 'freepass-data.period-fee-ledger-plan/v1') throw new Error('PERIOD_FEE_PLAN_SCHEMA_INVALID');
  if (!expectedDigest || plan.planDigest !== expectedDigest) throw new Error('PERIOD_FEE_PLAN_DIGEST_MISMATCH');
  if (stableDigest(planDigestBase(plan)) !== plan.planDigest) throw new Error('PERIOD_FEE_PLAN_CONTENT_DIGEST_MISMATCH');
  if (!/^period-fee-\d{4}-\d{2}-\d{2}$/.test(plan.snapshotId)) throw new Error('PERIOD_FEE_SNAPSHOT_ID_INVALID');
}

const nowIso = (now: (() => Date) | undefined) => {
  const date = now ? now() : new Date();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('PERIOD_FEE_APPLY_CLOCK_INVALID');
  return date.toISOString();
};

const documentDigest = (value: unknown) => stableDigest(value);

const historyDocumentKey = (row: ProductChangeHistoryRow | ProductChangeHistoryBaselineRow) =>
  [row.productKey, row.snapshotId, row.fieldPath, stableDigest(row).slice(0, 24)]
    .map(part => String(part).replace(/[\/#?[\]*]/g, '_').slice(0, 180))
    .join('__');

function baselineRows(plan: PeriodFeeLedgerPlan): ProductChangeHistoryBaselineRow[] {
  if (plan.history.length > 0) return [];
  return Object.entries(plan.baselines.productStates)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productKey, state]) => ({
      schemaVersion: 'product-change-history/v1',
      productKey,
      kind: 'BASELINE',
      fieldPath: 'status',
      before: null,
      after: { ...state },
      changedAtKst: plan.snapshotId.slice('period-fee-'.length),
      snapshotId: plan.snapshotId,
      sourceObservationRef: state.sourceObservationRef ?? null,
    }));
}

function deterministicSample<T extends { documentKey: string }>(rows: readonly T[], size: number): T[] {
  return [...rows]
    .sort((a, b) => stableDigest(a.documentKey).localeCompare(stableDigest(b.documentKey)))
    .slice(0, Math.max(0, Math.min(size, rows.length)));
}

function assertReadback(plan: PeriodFeeLedgerPlan, readRows: PeriodFeeLedgerRow[], sampleSize: number): { sampleCount: number; digest: string } {
  const readyRows = plan.rows.filter(row => row.applyState === 'READY' && row.vehicleUid);
  if (readRows.length !== readyRows.length) throw new Error('PERIOD_FEE_READBACK_ROW_COUNT_MISMATCH');
  const byKey = new Map(readRows.map(row => [row.documentKey, row]));
  const sample = deterministicSample(readyRows, sampleSize);
  for (const expected of sample) {
    const actual = byKey.get(expected.documentKey);
    if (!actual || stableDigest(actual) !== stableDigest(expected)) throw new Error('PERIOD_FEE_READBACK_ROW_MISMATCH');
  }
  return { sampleCount: sample.length, digest: stableDigest({ count: readRows.length, sample }) };
}

export async function applyPeriodFeeLedgerPlan(
  store: PeriodFeeLedgerApplyStore,
  plan: PeriodFeeLedgerPlan,
  options: PeriodFeeLedgerApplyOptions,
): Promise<PeriodFeeLedgerApplyResult> {
  validatePeriodFeeLedgerPlan(plan, options.expectedDigest);
  const readyRows = plan.rows.filter(row => row.applyState === 'READY' && row.vehicleUid);
  const holdNoUidRows = plan.rows.filter(row => row.holdReasonCode === 'HOLD_NO_UID' || !row.vehicleUid);
  const historyRows = plan.history.length > 0 ? plan.history : baselineRows(plan);
  const counts = {
    plannedRows: plan.rows.length,
    readyRows: readyRows.length,
    holdNoUidRows: holdNoUidRows.length,
    ledgerCreated: 0,
    ledgerSkippedSameDigest: 0,
    historyCreated: 0,
    activeMarked: 0,
  };

  if (!options.writeApproved) {
    return { status: 'DRY_RUN', snapshotId: plan.snapshotId, planDigest: plan.planDigest, writesEnabled: false, counts };
  }

  const preparedAt = nowIso(options.now);
  await store.setSnapshotRun(plan.snapshotId, {
    schemaVersion: 'period-fee-snapshot-run/v1',
    snapshotId: plan.snapshotId,
    planDigest: plan.planDigest,
    status: 'PREPARED',
    active: false,
    preparedAt,
    activatedAt: null,
    rowCount: plan.rows.length,
    readyRowCount: readyRows.length,
    holdNoUidCount: holdNoUidRows.length,
    historyRowCount: historyRows.length,
    readbackSampleCount: 0,
    readbackDigest: null,
  });

  for (const row of readyRows) {
    const digest = documentDigest(row);
    const existing = await store.getLedgerDocument(row.documentKey);
    if (existing) {
      if (existing.digest !== digest) throw new Error('PERIOD_FEE_LEDGER_DOCUMENT_DIGEST_CONFLICT');
      counts.ledgerSkippedSameDigest += 1;
      continue;
    }
    await store.createLedgerDocument(row.documentKey, row, digest);
    counts.ledgerCreated += 1;
  }

  for (const row of historyRows) {
    await store.createProductChangeHistoryDocument(historyDocumentKey(row), row, documentDigest(row));
    counts.historyCreated += 1;
  }

  const readback = assertReadback(plan, await store.readLedgerRows(plan.snapshotId), options.sampleSize ?? 50);
  await store.setSnapshotRun(plan.snapshotId, {
    schemaVersion: 'period-fee-snapshot-run/v1',
    snapshotId: plan.snapshotId,
    planDigest: plan.planDigest,
    status: 'ACTIVE',
    active: true,
    preparedAt,
    activatedAt: nowIso(options.now),
    rowCount: plan.rows.length,
    readyRowCount: readyRows.length,
    holdNoUidCount: holdNoUidRows.length,
    historyRowCount: historyRows.length,
    readbackSampleCount: readback.sampleCount,
    readbackDigest: readback.digest,
  });
  counts.activeMarked = 1;
  return { status: 'APPLIED', snapshotId: plan.snapshotId, planDigest: plan.planDigest, writesEnabled: true, counts };
}

export async function rollbackPeriodFeeLedgerSnapshot(
  store: PeriodFeeLedgerApplyStore,
  plan: PeriodFeeLedgerPlan,
  options: PeriodFeeLedgerRollbackOptions,
): Promise<PeriodFeeLedgerRollbackResult> {
  validatePeriodFeeLedgerPlan(plan, options.expectedDigest);
  if (!options.writeApproved) {
    return { status: 'DRY_RUN', snapshotId: plan.snapshotId, planDigest: plan.planDigest, writesEnabled: false, inactiveRuns: 0, deletedRows: 0 };
  }
  await store.markSnapshotRunInactive(plan.snapshotId);
  const deletedRows = await store.deleteLedgerRows(plan.snapshotId);
  return { status: 'ROLLED_BACK', snapshotId: plan.snapshotId, planDigest: plan.planDigest, writesEnabled: true, inactiveRuns: 1, deletedRows };
}
