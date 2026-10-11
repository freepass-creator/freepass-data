import type { CollectionReference, Firestore } from 'firebase-admin/firestore';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import type { PeriodFeeLedgerRow, PeriodFeeSnapshotRun } from '../domain/period-fee-ledger.js';

type Rec = Record<string, unknown>;

export type PeriodFeeLedgerFirestoreReadback = {
  run: PeriodFeeSnapshotRun;
  rows: PeriodFeeLedgerRow[];
};

const snapshotRuns = (db: Firestore) =>
  db.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns) as CollectionReference<Rec>;

const ledgerRows = (db: Firestore) =>
  db.collection(FIRESTORE_COLLECTIONS.periodFees.ledger) as CollectionReference<Rec>;

export const normalizePeriodFeeLedgerRow = (data: Rec): PeriodFeeLedgerRow => ({
  ...data,
  evidenceScope: data.evidenceScope === 'BASELINE_NOT_CONTRACT_EVIDENCE' || data.evidenceScope === 'OBSERVED_AT_SNAPSHOT'
    ? data.evidenceScope
    : 'UNKNOWN_SCOPE',
} as PeriodFeeLedgerRow);

export async function readConsistentPeriodFeeLedgerRows(
  db: Firestore,
  snapshotId: string,
  runId: string,
  options: { requireActive?: boolean } = {},
): Promise<PeriodFeeLedgerFirestoreReadback> {
  const runSnap = await snapshotRuns(db).doc(runId).get();
  const run = runSnap.exists ? runSnap.data() as PeriodFeeSnapshotRun : null;
  if (!run || run.snapshotId !== snapshotId) throw new Error('PERIOD_FEE_READBACK_RUN_NOT_FOUND');

  const allowed = new Set(run.rowKeys);
  const rowsSnap = await ledgerRows(db).where('snapshotId', '==', snapshotId).get();
  const rows = rowsSnap.docs
    .map(doc => {
      const { digest: _digest, ...data } = doc.data();
      return { id: doc.id, row: normalizePeriodFeeLedgerRow(data) };
    })
    .filter(item => allowed.has(item.id))
    .map(item => item.row);

  const reread = await snapshotRuns(db).doc(runId).get();
  const rereadRun = reread.exists ? reread.data() as PeriodFeeSnapshotRun : null;
  const mustBeActive = options.requireActive || run.active;
  if (mustBeActive && (!rereadRun || !rereadRun.active || rereadRun.status !== 'ACTIVE' || rereadRun.runId !== runId)) {
    throw new Error('LEDGER_READ_INCONSISTENT');
  }
  if (rows.length !== allowed.size) throw new Error('LEDGER_READ_INCONSISTENT');
  return { run, rows };
}
