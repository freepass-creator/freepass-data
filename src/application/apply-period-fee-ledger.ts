import { randomUUID } from 'crypto';
import { stableDigest } from '../shared/stable-digest.js';
import type { PeriodFeeLedgerPlan } from './period-fee-ledger-plan.js';
import type {
  PeriodFeeLedgerRow,
  ProductChangeHistoryBaselineRow,
  ProductChangeHistoryRow,
} from '../domain/period-fee-ledger.js';
import type { ExistingPeriodFeeDocument, PeriodFeeLedgerApplyStore } from '../ports/period-fee-ledger-store.js';

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
  keptSharedByActiveRows: number;
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
const documentIdPart = (value: string) => value.replace(/[\/#?[\]*]/g, '_').slice(0, 180);
const WRITE_LOCK_LEASE_MS = 15 * 60 * 1000;

const snapshotRunId = (snapshotId: string, planDigest: string) =>
  [snapshotId, planDigest.slice(0, 24)].map(documentIdPart).join('__');

const storageDocumentKey = (runId: string, logicalDocumentKey: string) =>
  [runId, logicalDocumentKey].map(documentIdPart).join('__');

const readyLedgerTargets = (plan: PeriodFeeLedgerPlan, runId: string, keys?: readonly string[]) => {
  const allowed = keys ? new Set(keys) : null;
  return plan.rows
    .filter(row => row.applyState === 'READY' && row.vehicleUid)
    .map(row => ({ documentKey: storageDocumentKey(runId, row.documentKey), digest: documentDigest(row) }))
    .filter(target => !allowed || allowed.has(target.documentKey));
};

const unique = (values: readonly string[]) => [...new Set(values)];

const runRowKeys = (run: { rowKeys?: string[]; createdDocumentKeys: string[]; plannedCreateKeys: string[] }) =>
  unique(run.rowKeys ?? [...run.createdDocumentKeys, ...run.plannedCreateKeys]);

const lockLeaseExpiresAt = (now: (() => Date) | undefined) => {
  const acquiredAt = nowIso(now);
  return {
    acquiredAt,
    leaseExpiresAt: new Date(Date.parse(acquiredAt) + WRITE_LOCK_LEASE_MS).toISOString(),
  };
};

async function withSnapshotWriteLock<T>(
  store: PeriodFeeLedgerApplyStore,
  ownerId: string,
  now: (() => Date) | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const lease = lockLeaseExpiresAt(now);
  await store.acquireSnapshotWriteLock(ownerId, lease.acquiredAt, lease.leaseExpiresAt);
  try {
    return await fn();
  } finally {
    await store.releaseSnapshotWriteLock(ownerId);
  }
}

async function renewSnapshotWriteLock(store: PeriodFeeLedgerApplyStore, ownerId: string, now: (() => Date) | undefined) {
  await store.renewSnapshotWriteLock(ownerId, lockLeaseExpiresAt(now).leaseExpiresAt);
}

const runRowDigests = (
  run: { rowDigests?: Record<string, string> },
  plan: PeriodFeeLedgerPlan,
) => {
  const runId = snapshotRunId(plan.snapshotId, plan.planDigest);
  const digests: Record<string, string> = { ...(run.rowDigests ?? {}) };
  for (const target of readyLedgerTargets(plan, runId)) digests[target.documentKey] = target.digest;
  return digests;
};

async function ownedLedgerTargets(
  store: PeriodFeeLedgerApplyStore,
  plan: PeriodFeeLedgerPlan,
  keys: readonly string[],
) {
  const targets: Array<{ documentKey: string; digest: string }> = [];
  const seen = new Set<string>();
  const runId = snapshotRunId(plan.snapshotId, plan.planDigest);
  for (const target of readyLedgerTargets(plan, runId, keys)) {
    if (seen.has(target.documentKey)) continue;
    const existing = await store.getLedgerDocument(target.documentKey);
    if (existing?.digest === target.digest) {
      targets.push(target);
      seen.add(target.documentKey);
    }
  }
  return targets;
}

async function assertRestorableRunRows(
  store: PeriodFeeLedgerApplyStore,
  restore: { rowKeys?: string[]; rowDigests?: Record<string, string>; createdDocumentKeys: string[]; plannedCreateKeys: string[] },
) {
  for (const documentKey of runRowKeys(restore)) {
    const expectedDigest = restore.rowDigests?.[documentKey];
    const existing = await store.getLedgerDocument(documentKey);
    if (!existing || !expectedDigest || existing.digest !== expectedDigest) {
      throw new Error('PERIOD_FEE_RESTORE_LEDGER_READBACK_FAILED');
    }
  }
}

const historyDocumentKey = (row: ProductChangeHistoryRow | ProductChangeHistoryBaselineRow) =>
  [row.productKey, row.snapshotId, row.fieldPath, stableDigest(row).slice(0, 24)]
    .map(part => documentIdPart(String(part)))
    .join('__');

const runHistoryDocumentKey = (runId: string, row: ProductChangeHistoryRow | ProductChangeHistoryBaselineRow) =>
  storageDocumentKey(runId, historyDocumentKey(row));

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

  const runId = snapshotRunId(plan.snapshotId, plan.planDigest);
  const lockOwnerId = `apply:${runId}:${randomUUID()}`;
  return withSnapshotWriteLock(store, lockOwnerId, options.now, async () => {
  const preparedAt = nowIso(options.now);
  const existingRun = await store.getSnapshotRun(runId);
  if (existingRun && existingRun.planDigest !== plan.planDigest) {
    throw new Error('PERIOD_FEE_RUN_DIGEST_CONFLICT');
  }
  if (existingRun && ['SUPERSEDED', 'ROLLING_BACK', 'ROLLED_BACK', 'INACTIVE', 'FAILED'].includes(existingRun.status)) {
    throw new Error('RUN_NOT_REAPPLICABLE');
  }
  if (existingRun?.status === 'ACTIVE' && existingRun.active) {
    for (const row of readyRows) {
      const existing = await store.getLedgerDocument(storageDocumentKey(runId, row.documentKey));
      if (!existing || existing.digest !== documentDigest(row)) {
        throw new Error('PERIOD_FEE_LEDGER_DOCUMENT_DIGEST_CONFLICT');
      }
    }
    const readback = assertReadback(plan, await store.readLedgerRows(plan.snapshotId, runId), options.sampleSize ?? 50);
    if (existingRun.readbackDigest && existingRun.readbackDigest !== readback.digest) {
      throw new Error('PERIOD_FEE_ACTIVE_READBACK_DIGEST_MISMATCH');
    }
    counts.ledgerSkippedSameDigest = readyRows.length;
    return { status: 'APPLIED', snapshotId: plan.snapshotId, planDigest: plan.planDigest, writesEnabled: true, counts };
  }
  const previousActive = await store.getActiveSnapshotRun(plan.snapshotId);
  const previousActiveRunId = previousActive?.runId === runId
    ? existingRun?.previousActiveRunId ?? null
    : previousActive?.runId ?? existingRun?.previousActiveRunId ?? null;
  const existingLedgerDocuments = new Map<string, ExistingPeriodFeeDocument | null>();
  for (const row of readyRows) {
    existingLedgerDocuments.set(row.documentKey, await store.getLedgerDocument(storageDocumentKey(runId, row.documentKey)));
  }
  const plannedCreateKeys = unique([
    ...(existingRun?.plannedCreateKeys ?? []),
    ...readyRows
      .filter(row => !existingLedgerDocuments.get(row.documentKey))
      .map(row => storageDocumentKey(runId, row.documentKey)),
  ]);
  const rowKeys = unique([...(existingRun?.rowKeys ?? []), ...readyRows.map(row => storageDocumentKey(runId, row.documentKey))]);
  const rowDigests = runRowDigests(existingRun ?? { rowDigests: {} }, plan);
  await store.setSnapshotRun(runId, {
    schemaVersion: 'period-fee-snapshot-run/v1',
    runId,
    snapshotId: plan.snapshotId,
    planDigest: plan.planDigest,
    status: 'PREPARED',
    active: false,
    previousActiveRunId,
    rowKeys,
    rowDigests,
    plannedCreateKeys,
    createdDocumentKeys: existingRun?.createdDocumentKeys ?? [],
    preparedAt,
    activatedAt: null,
    rowCount: plan.rows.length,
    readyRowCount: readyRows.length,
    holdNoUidCount: holdNoUidRows.length,
    historyRowCount: historyRows.length,
    readbackSampleCount: 0,
    readbackDigest: null,
  });

  const createdDocumentKeys: string[] = [];
  for (const row of readyRows) {
    const digest = documentDigest(row);
    const existing = existingLedgerDocuments.has(row.documentKey)
      ? existingLedgerDocuments.get(row.documentKey)
      : await store.getLedgerDocument(storageDocumentKey(runId, row.documentKey));
    if (existing) {
      if (existing.digest !== digest) throw new Error('PERIOD_FEE_LEDGER_DOCUMENT_DIGEST_CONFLICT');
      counts.ledgerSkippedSameDigest += 1;
      continue;
    }
    const documentKey = storageDocumentKey(runId, row.documentKey);
    await store.createLedgerDocument(documentKey, row, digest);
    await renewSnapshotWriteLock(store, lockOwnerId, options.now);
    createdDocumentKeys.push(documentKey);
    await store.setSnapshotRun(runId, {
      ...(await store.getSnapshotRun(runId))!,
      createdDocumentKeys: unique([...(existingRun?.createdDocumentKeys ?? []), ...createdDocumentKeys]),
    });
    counts.ledgerCreated += 1;
  }

  for (const row of historyRows) {
    await store.createProductChangeHistoryDocument(runHistoryDocumentKey(runId, row), row, documentDigest(row));
    await renewSnapshotWriteLock(store, lockOwnerId, options.now);
    counts.historyCreated += 1;
  }

  const readback = assertReadback(plan, await store.readLedgerRows(plan.snapshotId, runId), options.sampleSize ?? 50);
  await renewSnapshotWriteLock(store, lockOwnerId, options.now);
  await store.activateSnapshotRun(runId, {
    schemaVersion: 'period-fee-snapshot-run/v1',
    runId,
    snapshotId: plan.snapshotId,
    planDigest: plan.planDigest,
    status: 'ACTIVE',
    active: true,
    previousActiveRunId,
    rowKeys,
    rowDigests,
    plannedCreateKeys,
    createdDocumentKeys: unique([...(existingRun?.createdDocumentKeys ?? []), ...createdDocumentKeys]),
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
  });
}

export async function rollbackPeriodFeeLedgerSnapshot(
  store: PeriodFeeLedgerApplyStore,
  plan: PeriodFeeLedgerPlan,
  options: PeriodFeeLedgerRollbackOptions,
): Promise<PeriodFeeLedgerRollbackResult> {
  validatePeriodFeeLedgerPlan(plan, options.expectedDigest);
  if (!options.writeApproved) {
    return { status: 'DRY_RUN', snapshotId: plan.snapshotId, planDigest: plan.planDigest, writesEnabled: false, inactiveRuns: 0, deletedRows: 0, keptSharedByActiveRows: 0 };
  }
  const runId = snapshotRunId(plan.snapshotId, plan.planDigest);
  const lockOwnerId = `rollback:${runId}:${randomUUID()}`;
  return withSnapshotWriteLock(store, lockOwnerId, undefined, async () => {
  const run = await store.getSnapshotRun(runId);
  if (!run || run.planDigest !== plan.planDigest) throw new Error('PERIOD_FEE_ROLLBACK_RUN_DIGEST_MISMATCH');
  if (['SUPERSEDED', 'ROLLED_BACK', 'INACTIVE', 'FAILED'].includes(run.status)) throw new Error('RUN_NOT_REAPPLICABLE');
  const wasActive = Boolean(run.activatedAt);
  const canRestoreFromPrepared = run.status === 'PREPARED'
    && wasActive
    && Boolean(run.previousActiveRunId);
  const ownedKeys = unique([...(run.rowKeys ?? []), ...(run.createdDocumentKeys ?? []), ...(run.plannedCreateKeys ?? [])])
    .filter(key => key.startsWith(`${runId}__`));
  const targets = await ownedLedgerTargets(store, plan, ownedKeys);
  const deleteTargets = targets;
  const keptSharedByActiveRows = 0;
  const restore = run.status === 'ACTIVE' || canRestoreFromPrepared
    ? run.previousActiveRunId
      ? await store.getSnapshotRun(run.previousActiveRunId)
      : await store.getLatestSupersededSnapshotRun(plan.snapshotId, runId)
    : null;
  if (restore?.status === 'SUPERSEDED') await assertRestorableRunRows(store, restore);
  await store.setSnapshotRun(runId, { ...run, status: 'ROLLING_BACK', active: false });
  const deletedRows = await store.deleteLedgerRowsByDigest(deleteTargets);
  await renewSnapshotWriteLock(store, lockOwnerId, undefined);
  if (run.status === 'ACTIVE' || run.status === 'ROLLING_BACK' || canRestoreFromPrepared) {
    const currentActive = await store.getActiveSnapshotRun(plan.snapshotId);
    if (run.status === 'ROLLING_BACK' && currentActive && currentActive.runId !== runId) {
      await store.setSnapshotRun(runId, { ...(await store.getSnapshotRun(runId) ?? run), status: 'FAILED', active: false });
      throw new Error('ROLLBACK_SUPERSEDED_BY_NEWER_ACTIVE');
    }
    const rollbackRestore = run.previousActiveRunId
      ? await store.getSnapshotRun(run.previousActiveRunId)
      : await store.getLatestSupersededSnapshotRun(plan.snapshotId, runId);
    if (rollbackRestore?.status === 'SUPERSEDED') {
      await assertRestorableRunRows(store, rollbackRestore);
      await store.restoreSnapshotRunActive(rollbackRestore.runId, rollbackRestore.planDigest, currentActive?.runId ?? null);
      const restored = await store.getActiveSnapshotRun(plan.snapshotId);
      if (!restored || restored.runId !== rollbackRestore.runId || restored.planDigest !== rollbackRestore.planDigest) {
        throw new Error('PERIOD_FEE_ROLLBACK_RESTORE_READBACK_FAILED');
      }
    }
  }
  const latest = await store.getSnapshotRun(runId);
  await store.markSnapshotRunInactive(runId);
  await store.setSnapshotRun(runId, { ...(latest ?? run), status: 'ROLLED_BACK', active: false, activatedAt: null });
  return { status: 'ROLLED_BACK', snapshotId: plan.snapshotId, planDigest: plan.planDigest, writesEnabled: true, inactiveRuns: 1, deletedRows, keptSharedByActiveRows };
  });
}
