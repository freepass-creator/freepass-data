import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { stableDigest } from '../shared/stable-digest.js';
const snapshotRuns = (db) => db.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns);
const ledgerRows = (db) => db.collection(FIRESTORE_COLLECTIONS.periodFees.ledger);
export const normalizePeriodFeeLedgerRow = (data) => ({
    ...data,
    evidenceScope: data.evidenceScope === 'BASELINE_NOT_CONTRACT_EVIDENCE' || data.evidenceScope === 'OBSERVED_AT_SNAPSHOT'
        ? data.evidenceScope
        : 'UNKNOWN_SCOPE',
});
export async function readConsistentPeriodFeeLedgerRows(db, snapshotId, runId, options = {}) {
    const runSnap = await snapshotRuns(db).doc(runId).get();
    const run = runSnap.exists ? runSnap.data() : null;
    if (!run || run.snapshotId !== snapshotId)
        throw new Error('PERIOD_FEE_READBACK_RUN_NOT_FOUND');
    const rows = [];
    let cursor = null;
    for (;;) {
        let query = ledgerRows(db)
            .orderBy('__name__')
            .startAt(runId + '__')
            .endBefore(runId + '__\uf8ff')
            .limit(500);
        if (cursor)
            query = query.startAfter(cursor);
        const page = await query.get();
        rows.push(...page.docs.map(doc => {
            const { digest: _digest, ...data } = doc.data();
            return { id: doc.id, row: normalizePeriodFeeLedgerRow(data) };
        }));
        if (page.docs.length < 500)
            break;
        cursor = page.docs[page.docs.length - 1];
    }
    const reread = await snapshotRuns(db).doc(runId).get();
    const rereadRun = reread.exists ? reread.data() : null;
    const mustBeActive = options.requireActive || run.active;
    if (mustBeActive && (!rereadRun || !rereadRun.active || rereadRun.status !== 'ACTIVE' || rereadRun.runId !== runId)) {
        throw new Error('LEDGER_READ_INCONSISTENT');
    }
    const rowKeys = rows.map(item => item.id).sort((a, b) => a.localeCompare(b));
    if (rows.length !== run.rowCount)
        throw new Error('LEDGER_READ_INCONSISTENT');
    if (stableDigest(rowKeys) !== run.rowKeysDigest)
        throw new Error('LEDGER_READ_INCONSISTENT');
    if (!run.rowContentDigest)
        throw new Error('LEDGER_READ_INCONSISTENT');
    if (stableDigest(rows
        .map(item => [item.id, stableDigest(item.row)])
        .sort(([left], [right]) => left.localeCompare(right))) !== run.rowContentDigest)
        throw new Error('LEDGER_READ_INCONSISTENT');
    return { run, rows: rows.map(item => item.row) };
}
