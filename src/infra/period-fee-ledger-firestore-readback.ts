import type { CollectionReference, Firestore } from 'firebase-admin/firestore';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import type { PeriodFeeLedgerRow, PeriodFeeSnapshotRun } from '../domain/period-fee-ledger.js';
import { stableDigest } from '../shared/stable-digest.js';

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

  const rows: Array<{ id: string; row: PeriodFeeLedgerRow }> = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot<Rec> | null = null;
  for (;;) {
    let query = ledgerRows(db)
      .orderBy('__name__')
      .startAt(runId + '__')
      .endBefore(runId + '__\uf8ff')
      .limit(500);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    rows.push(...page.docs.map(doc => {
      const { digest: _digest, ...data } = doc.data();
      return { id: doc.id, row: normalizePeriodFeeLedgerRow(data) };
    }));
    if (page.docs.length < 500) break;
    cursor = page.docs[page.docs.length - 1]!;
  }

  const reread = await snapshotRuns(db).doc(runId).get();
  const rereadRun = reread.exists ? reread.data() as PeriodFeeSnapshotRun : null;
  const mustBeActive = options.requireActive || run.active;
  if (mustBeActive && (!rereadRun || !rereadRun.active || rereadRun.status !== 'ACTIVE' || rereadRun.runId !== runId)) {
    throw new Error('LEDGER_READ_INCONSISTENT');
  }
  const rowKeys = rows.map(item => item.id).sort((a, b) => a.localeCompare(b));
  if (rows.length !== run.rowCount) throw new Error('LEDGER_READ_INCONSISTENT');
  if (stableDigest(rowKeys) !== run.rowKeysDigest) throw new Error('LEDGER_READ_INCONSISTENT');
  return { run, rows: rows.map(item => item.row) };
}
