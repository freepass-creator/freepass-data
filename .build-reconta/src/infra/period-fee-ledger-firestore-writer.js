import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { readConsistentPeriodFeeLedgerRows } from './period-fee-ledger-firestore-readback.js';
import { stableDigest } from '../shared/stable-digest.js';
const allowed = new Set([
    FIRESTORE_COLLECTIONS.periodFees.ledger,
    FIRESTORE_COLLECTIONS.periodFees.snapshotRuns,
    FIRESTORE_COLLECTIONS.periodFees.productChangeHistory,
]);
const WRITE_LOCK_DOCUMENT_ID = '_apply_lock';
const assertAllowedCollection = (collection) => {
    if (!allowed.has(collection))
        throw new Error('PERIOD_FEE_WRITE_COLLECTION_FORBIDDEN');
};
export class PeriodFeeLedgerFirestoreWriter {
    db;
    constructor(db = getFirestore(getTargetFirebaseApp())) {
        this.db = db;
    }
    collection(name) {
        assertAllowedCollection(name);
        return this.db.collection(name);
    }
    async assertSnapshotWriteLock(tx, guard) {
        const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(WRITE_LOCK_DOCUMENT_ID);
        const snap = await tx.get(ref);
        const existing = snap.data();
        if (!snap.exists || existing?.ownerId !== guard.lockOwnerId || existing.leaseExpiresAt <= guard.checkedAt) {
            throw new Error('LOCK_LOST');
        }
    }
    async acquireSnapshotWriteLock(ownerId, acquiredAt, leaseExpiresAt) {
        return this.db.runTransaction(async (tx) => {
            const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(WRITE_LOCK_DOCUMENT_ID);
            const snap = await tx.get(ref);
            const existing = snap.data();
            if (snap.exists && existing?.ownerId && existing.leaseExpiresAt > acquiredAt && existing.ownerId !== ownerId) {
                throw new Error('LOCK_HELD');
            }
            const lock = {
                schemaVersion: 'period-fee-snapshot-write-lock/v1',
                lockId: WRITE_LOCK_DOCUMENT_ID,
                ownerId,
                acquiredAt,
                leaseExpiresAt,
            };
            tx.set(ref, lock, { merge: true });
            return lock;
        });
    }
    async renewSnapshotWriteLock(ownerId, leaseExpiresAt, checkedAt = new Date().toISOString()) {
        await this.db.runTransaction(async (tx) => {
            const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(WRITE_LOCK_DOCUMENT_ID);
            const snap = await tx.get(ref);
            const existing = snap.data();
            if (!snap.exists || existing?.ownerId !== ownerId || existing.leaseExpiresAt <= checkedAt)
                throw new Error('LOCK_LOST');
            tx.set(ref, { leaseExpiresAt }, { merge: true });
        });
    }
    async releaseSnapshotWriteLock(ownerId) {
        await this.db.runTransaction(async (tx) => {
            const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(WRITE_LOCK_DOCUMENT_ID);
            const snap = await tx.get(ref);
            const existing = snap.data();
            if (snap.exists && existing?.ownerId === ownerId)
                tx.delete(ref);
        });
    }
    async getLedgerDocument(documentKey) {
        const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.ledger).doc(documentKey).get();
        if (!snap.exists)
            return null;
        const data = snap.data();
        return { digest: typeof data.digest === 'string' ? data.digest : '', data };
    }
    async createLedgerDocument(documentKey, row, digest) {
        await this.collection(FIRESTORE_COLLECTIONS.periodFees.ledger).doc(documentKey).create({ ...row, digest });
    }
    async listByRunIdPrefix(collectionName, runId, pageSize = 500) {
        const rows = [];
        let cursor = null;
        for (;;) {
            let query = this.collection(collectionName)
                .orderBy('__name__')
                .startAt(runId + '__')
                .endBefore(runId + '__\uf8ff')
                .limit(pageSize);
            if (cursor)
                query = query.startAfter(cursor);
            const page = await query.get();
            rows.push(...page.docs.map(doc => {
                const data = doc.data();
                return { documentKey: doc.id, digest: typeof data.digest === 'string' ? data.digest : '', data };
            }));
            if (page.docs.length < pageSize)
                break;
            cursor = page.docs[page.docs.length - 1];
        }
        return rows;
    }
    async listLedgerDocumentsByRunIdPrefix(runId, pageSize = 500) {
        return this.listByRunIdPrefix(FIRESTORE_COLLECTIONS.periodFees.ledger, runId, pageSize);
    }
    async getProductChangeHistoryDocument(documentKey) {
        const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.productChangeHistory).doc(documentKey).get();
        if (!snap.exists)
            return null;
        const data = snap.data();
        return { digest: typeof data.digest === 'string' ? data.digest : '', data };
    }
    async createProductChangeHistoryDocument(documentKey, row, digest) {
        const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.productChangeHistory).doc(documentKey);
        try {
            await ref.create({ ...row, digest });
        }
        catch (error) {
            if (String(error.code) === '6' || String(error.message).includes('ALREADY_EXISTS')) {
                const existing = await ref.get();
                if (existing.exists && existing.data()?.digest === digest)
                    return;
                throw new Error('DOCUMENT_ID_COLLISION');
            }
            throw error;
        }
    }
    async listProductChangeHistoryDocumentsByRunIdPrefix(runId, pageSize = 500) {
        return this.listByRunIdPrefix(FIRESTORE_COLLECTIONS.periodFees.productChangeHistory, runId, pageSize);
    }
    async getSnapshotRun(runId) {
        const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(runId).get();
        return snap.exists ? snap.data() : null;
    }
    async getActiveSnapshotRun(snapshotId) {
        const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns)
            .where('snapshotId', '==', snapshotId)
            .where('active', '==', true)
            .limit(2)
            .get();
        if (snap.docs.length > 1)
            throw new Error('PERIOD_FEE_ACTIVE_RUN_NOT_UNIQUE');
        return snap.docs[0]?.data() ?? null;
    }
    async getLatestSupersededSnapshotRun(snapshotId, excludeRunId) {
        const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns)
            .where('snapshotId', '==', snapshotId)
            .where('status', '==', 'SUPERSEDED')
            .get();
        return snap.docs
            .map(doc => doc.data())
            .filter(run => run.runId !== excludeRunId)
            .sort((a, b) => Date.parse(b.activatedAt ?? '') - Date.parse(a.activatedAt ?? ''))[0] ?? null;
    }
    async setSnapshotRun(runId, run, guard) {
        await this.db.runTransaction(async (tx) => {
            if (guard)
                await this.assertSnapshotWriteLock(tx, guard);
            const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(runId);
            const snap = await tx.get(ref);
            const existing = snap.data();
            if (guard && snap.exists && existing?.planDigest !== run.planDigest)
                throw new Error('RUN_STATE_CHANGED');
            if (run.status === 'PREPARED') {
                if (snap.exists && (!existing || existing.status !== 'PREPARED' || existing.planDigest !== run.planDigest)) {
                    throw new Error('PERIOD_FEE_RUN_STATE_CONFLICT');
                }
            }
            else if (guard && run.status === 'ROLLING_BACK') {
                if (!snap.exists || !['ACTIVE', 'PREPARED', 'ROLLING_BACK'].includes(existing?.status ?? ''))
                    throw new Error('RUN_STATE_CHANGED');
            }
            else if (guard && run.status === 'ROLLBACK_PARTIAL_UNEXPECTED') {
                if (!snap.exists || existing?.status !== 'ROLLING_BACK')
                    throw new Error('RUN_STATE_CHANGED');
            }
            else if (guard && run.status === 'FAILED') {
                if (!snap.exists || existing?.status !== 'ROLLING_BACK')
                    throw new Error('RUN_STATE_CHANGED');
            }
            else if (guard && run.status === 'ROLLED_BACK') {
                if (!snap.exists || existing?.status !== 'INACTIVE')
                    throw new Error('RUN_STATE_CHANGED');
            }
            tx.set(ref, run, { merge: true });
        });
    }
    async activateSnapshotRun(runId, run, guard) {
        await this.db.runTransaction(async (tx) => {
            await this.assertSnapshotWriteLock(tx, guard);
            const runs = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns);
            const targetRef = runs.doc(runId);
            const target = await tx.get(targetRef);
            const existing = target.data();
            if (!target.exists || existing?.status !== 'PREPARED' || existing.planDigest !== run.planDigest) {
                throw new Error('RUN_STATE_CHANGED');
            }
            const active = await tx.get(runs.where('snapshotId', '==', run.snapshotId).where('active', '==', true));
            const actualPreviousActiveRunId = active.docs.find(doc => doc.id !== runId)?.id ?? null;
            tx.set(targetRef, { ...run, previousActiveRunId: actualPreviousActiveRunId }, { merge: true });
            for (const doc of active.docs) {
                if (doc.id !== runId)
                    tx.set(doc.ref, { status: 'SUPERSEDED', active: false }, { merge: true });
            }
        });
    }
    async restoreSnapshotRunActive(runId, expectedPlanDigest, expectedCurrentActiveRunId, guard) {
        await this.db.runTransaction(async (tx) => {
            await this.assertSnapshotWriteLock(tx, guard);
            const runs = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns);
            const targetRef = runs.doc(runId);
            const target = await tx.get(targetRef);
            const data = target.data();
            if (!target.exists || data?.planDigest !== expectedPlanDigest || data.status !== 'SUPERSEDED') {
                throw new Error('PERIOD_FEE_RESTORE_RUN_DIGEST_MISMATCH');
            }
            const active = await tx.get(runs.where('snapshotId', '==', data.snapshotId).where('active', '==', true));
            const activeIds = active.docs.map(doc => doc.id);
            if (activeIds.length > 1)
                throw new Error('PERIOD_FEE_ACTIVE_RUN_NOT_UNIQUE');
            const actualActiveRunId = activeIds[0] ?? null;
            if (actualActiveRunId !== expectedCurrentActiveRunId)
                throw new Error('ROLLBACK_SUPERSEDED_BY_NEWER_ACTIVE');
            for (const doc of active.docs) {
                if (doc.id !== runId)
                    tx.set(doc.ref, { status: 'SUPERSEDED', active: false }, { merge: true });
            }
            tx.set(targetRef, { status: 'ACTIVE', active: true }, { merge: true });
        });
    }
    async readLedgerRows(snapshotId, runId) {
        return (await readConsistentPeriodFeeLedgerRows(this.db, snapshotId, runId)).rows;
    }
    async markSnapshotRunInactive(runId, guard) {
        await this.db.runTransaction(async (tx) => {
            await this.assertSnapshotWriteLock(tx, guard);
            const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(runId);
            const snap = await tx.get(ref);
            const existing = snap.data();
            tx.set(ref, {
                ...(existing ?? {
                    schemaVersion: 'period-fee-snapshot-run/v1',
                    runId,
                    snapshotId: runId,
                    planDigest: '',
                    previousActiveRunId: null,
                    preparedAt: new Date().toISOString(),
                    rowCount: 0,
                    rowKeysDigest: stableDigest([]),
                    readyRowCount: 0,
                    holdNoUidCount: 0,
                    historyRowCount: 0,
                    historyKeysDigest: stableDigest([]),
                    readbackSampleCount: 0,
                    readbackDigest: null,
                }),
                status: 'INACTIVE',
                active: false,
                activatedAt: null,
            }, { merge: true });
        });
    }
    async deleteLedgerRowsByDigest(documentDigests, guard) {
        let deleted = 0;
        for (const target of documentDigests) {
            const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.ledger).doc(target.documentKey);
            const didDelete = await this.db.runTransaction(async (tx) => {
                await this.assertSnapshotWriteLock(tx, guard);
                const snap = await tx.get(ref);
                if (!snap.exists)
                    return false;
                const data = snap.data();
                if (data.digest !== target.digest)
                    return false;
                tx.delete(ref);
                return true;
            });
            if (didDelete)
                deleted += 1;
        }
        return deleted;
    }
}
