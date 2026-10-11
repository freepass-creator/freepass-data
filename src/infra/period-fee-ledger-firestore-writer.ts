import type { Firestore } from 'firebase-admin/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { readConsistentPeriodFeeLedgerRows } from './period-fee-ledger-firestore-readback.js';
import type {
  ExistingPeriodFeeDocument,
  PeriodFeeLedgerApplyStore,
} from '../ports/period-fee-ledger-store.js';
import type {
  PeriodFeeSnapshotRun,
  PeriodFeeSnapshotWriteLock,
  ProductChangeHistoryBaselineRow,
  PeriodFeeLedgerRow,
  ProductChangeHistoryRow,
} from '../domain/period-fee-ledger.js';

type Rec = Record<string, unknown>;

const allowed = new Set<string>([
  FIRESTORE_COLLECTIONS.periodFees.ledger,
  FIRESTORE_COLLECTIONS.periodFees.snapshotRuns,
  FIRESTORE_COLLECTIONS.periodFees.productChangeHistory,
]);

const WRITE_LOCK_DOCUMENT_ID = '_apply_lock';

const assertAllowedCollection = (collection: string) => {
  if (!allowed.has(collection)) throw new Error('PERIOD_FEE_WRITE_COLLECTION_FORBIDDEN');
};

export class PeriodFeeLedgerFirestoreWriter implements PeriodFeeLedgerApplyStore {
  constructor(private readonly db: Firestore = getFirestore(getTargetFirebaseApp())) {}

  private collection(name: string) {
    assertAllowedCollection(name);
    return this.db.collection(name);
  }

  async acquireSnapshotWriteLock(ownerId: string, acquiredAt: string, leaseExpiresAt: string): Promise<PeriodFeeSnapshotWriteLock> {
    return this.db.runTransaction(async tx => {
      const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(WRITE_LOCK_DOCUMENT_ID);
      const snap = await tx.get(ref);
      const existing = snap.data() as PeriodFeeSnapshotWriteLock | undefined;
      if (snap.exists && existing?.ownerId && existing.leaseExpiresAt > acquiredAt && existing.ownerId !== ownerId) {
        throw new Error('LOCK_HELD');
      }
      const lock: PeriodFeeSnapshotWriteLock = {
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

  async renewSnapshotWriteLock(ownerId: string, leaseExpiresAt: string): Promise<void> {
    await this.db.runTransaction(async tx => {
      const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(WRITE_LOCK_DOCUMENT_ID);
      const snap = await tx.get(ref);
      const existing = snap.data() as PeriodFeeSnapshotWriteLock | undefined;
      if (!snap.exists || existing?.ownerId !== ownerId) throw new Error('LOCK_HELD');
      tx.set(ref, { leaseExpiresAt }, { merge: true });
    });
  }

  async releaseSnapshotWriteLock(ownerId: string): Promise<void> {
    await this.db.runTransaction(async tx => {
      const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(WRITE_LOCK_DOCUMENT_ID);
      const snap = await tx.get(ref);
      const existing = snap.data() as PeriodFeeSnapshotWriteLock | undefined;
      if (snap.exists && existing?.ownerId === ownerId) tx.delete(ref);
    });
  }

  async getLedgerDocument(documentKey: string): Promise<ExistingPeriodFeeDocument | null> {
    const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.ledger).doc(documentKey).get();
    if (!snap.exists) return null;
    const data = snap.data() as Rec;
    return { digest: typeof data.digest === 'string' ? data.digest : '', data };
  }

  async createLedgerDocument(documentKey: string, row: PeriodFeeLedgerRow, digest: string): Promise<void> {
    await this.collection(FIRESTORE_COLLECTIONS.periodFees.ledger).doc(documentKey).create({ ...row, digest });
  }

  async createProductChangeHistoryDocument(
    documentKey: string,
    row: ProductChangeHistoryRow | ProductChangeHistoryBaselineRow,
    digest: string,
  ): Promise<void> {
    try {
      await this.collection(FIRESTORE_COLLECTIONS.periodFees.productChangeHistory).doc(documentKey).create({ ...row, digest });
    } catch (error) {
      if (String((error as { code?: unknown }).code) === '6' || String((error as Error).message).includes('ALREADY_EXISTS')) return;
      throw error;
    }
  }

  async getSnapshotRun(runId: string): Promise<PeriodFeeSnapshotRun | null> {
    const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(runId).get();
    return snap.exists ? snap.data() as PeriodFeeSnapshotRun : null;
  }

  async getActiveSnapshotRun(snapshotId: string): Promise<PeriodFeeSnapshotRun | null> {
    const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns)
      .where('snapshotId', '==', snapshotId)
      .where('active', '==', true)
      .limit(2)
      .get();
    if (snap.docs.length > 1) throw new Error('PERIOD_FEE_ACTIVE_RUN_NOT_UNIQUE');
    return snap.docs[0]?.data() as PeriodFeeSnapshotRun | undefined ?? null;
  }

  async getLatestSupersededSnapshotRun(snapshotId: string, excludeRunId: string): Promise<PeriodFeeSnapshotRun | null> {
    const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns)
      .where('snapshotId', '==', snapshotId)
      .where('status', '==', 'SUPERSEDED')
      .get();
    return snap.docs
      .map(doc => doc.data() as PeriodFeeSnapshotRun)
      .filter(run => run.runId !== excludeRunId)
      .sort((a, b) => Date.parse(b.activatedAt ?? '') - Date.parse(a.activatedAt ?? ''))[0] ?? null;
  }

  async setSnapshotRun(runId: string, run: PeriodFeeSnapshotRun): Promise<void> {
    await this.db.runTransaction(async tx => {
      const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(runId);
      const snap = await tx.get(ref);
      const existing = snap.data() as PeriodFeeSnapshotRun | undefined;
      if (run.status === 'PREPARED') {
        if (snap.exists && (!existing || existing.status !== 'PREPARED' || existing.planDigest !== run.planDigest)) {
          throw new Error('PERIOD_FEE_RUN_STATE_CONFLICT');
        }
      }
      tx.set(ref, run, { merge: true });
    });
  }

  async activateSnapshotRun(runId: string, run: PeriodFeeSnapshotRun): Promise<void> {
    await this.db.runTransaction(async tx => {
      const runs = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns);
      const active = await tx.get(runs.where('snapshotId', '==', run.snapshotId).where('active', '==', true));
      const actualPreviousActiveRunId = active.docs.find(doc => doc.id !== runId)?.id ?? null;
      tx.set(runs.doc(runId), { ...run, previousActiveRunId: actualPreviousActiveRunId }, { merge: true });
      for (const doc of active.docs) {
        if (doc.id !== runId) tx.set(doc.ref, { status: 'SUPERSEDED', active: false }, { merge: true });
      }
    });
  }

  async restoreSnapshotRunActive(runId: string, expectedPlanDigest: string, expectedCurrentActiveRunId: string | null): Promise<void> {
    await this.db.runTransaction(async tx => {
      const runs = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns);
      const targetRef = runs.doc(runId);
      const target = await tx.get(targetRef);
      const data = target.data() as PeriodFeeSnapshotRun | undefined;
      if (!target.exists || data?.planDigest !== expectedPlanDigest || data.status !== 'SUPERSEDED') {
        throw new Error('PERIOD_FEE_RESTORE_RUN_DIGEST_MISMATCH');
      }
      const active = await tx.get(runs.where('snapshotId', '==', data.snapshotId).where('active', '==', true));
      const activeIds = active.docs.map(doc => doc.id);
      if (activeIds.length > 1) throw new Error('PERIOD_FEE_ACTIVE_RUN_NOT_UNIQUE');
      const actualActiveRunId = activeIds[0] ?? null;
      if (actualActiveRunId !== expectedCurrentActiveRunId) throw new Error('ROLLBACK_SUPERSEDED_BY_NEWER_ACTIVE');
      for (const doc of active.docs) {
        if (doc.id !== runId) tx.set(doc.ref, { status: 'SUPERSEDED', active: false }, { merge: true });
      }
      tx.set(targetRef, { status: 'ACTIVE', active: true }, { merge: true });
    });
  }

  async readLedgerRows(snapshotId: string, runId: string): Promise<PeriodFeeLedgerRow[]> {
    return (await readConsistentPeriodFeeLedgerRows(this.db, snapshotId, runId)).rows;
  }

  async markSnapshotRunInactive(runId: string): Promise<void> {
    const existing = await this.getSnapshotRun(runId);
    await this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(runId).set({
      ...(existing ?? {
        schemaVersion: 'period-fee-snapshot-run/v1',
        runId,
        snapshotId: runId,
        planDigest: '',
        previousActiveRunId: null,
        rowKeys: [],
        rowDigests: {},
        plannedCreateKeys: [],
        createdDocumentKeys: [],
        preparedAt: new Date().toISOString(),
        rowCount: 0,
        readyRowCount: 0,
        holdNoUidCount: 0,
        historyRowCount: 0,
        readbackSampleCount: 0,
        readbackDigest: null,
      }),
      status: 'INACTIVE',
      active: false,
      activatedAt: null,
    }, { merge: true });
  }

  async deleteLedgerRowsByDigest(documentDigests: Array<{ documentKey: string; digest: string }>): Promise<number> {
    let deleted = 0;
    for (const target of documentDigests) {
      const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.ledger).doc(target.documentKey);
      const snap = await ref.get();
      if (!snap.exists) continue;
      const data = snap.data() as Rec;
      if (data.digest !== target.digest) continue;
      await ref.delete();
      deleted += 1;
    }
    return deleted;
  }
}
