import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { readConsistentPeriodFeeLedgerRows } from './period-fee-ledger-firestore-readback.js';
import type {
  ExistingPeriodFeeDocument,
  ExistingPeriodFeeDocumentWithKey,
  PeriodFeeLedgerApplyStore,
  PeriodFeeSnapshotWriteGuard,
} from '../ports/period-fee-ledger-store.js';
import type {
  PeriodFeeSnapshotRun,
  PeriodFeeSnapshotWriteLock,
  ProductChangeHistoryBaselineRow,
  PeriodFeeLedgerRow,
  ProductChangeHistoryRow,
} from '../domain/period-fee-ledger.js';
import { stableDigest } from '../shared/stable-digest.js';

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

  private async assertSnapshotWriteLock(
    tx: Transaction,
    guard: PeriodFeeSnapshotWriteGuard,
  ) {
    const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(WRITE_LOCK_DOCUMENT_ID);
    const snap = await tx.get(ref);
    const existing = snap.data() as PeriodFeeSnapshotWriteLock | undefined;
    if (!snap.exists || existing?.ownerId !== guard.lockOwnerId || existing.leaseExpiresAt <= guard.checkedAt) {
      throw new Error('LOCK_LOST');
    }
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

  async renewSnapshotWriteLock(ownerId: string, leaseExpiresAt: string, checkedAt = new Date().toISOString()): Promise<void> {
    await this.db.runTransaction(async tx => {
      const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(WRITE_LOCK_DOCUMENT_ID);
      const snap = await tx.get(ref);
      const existing = snap.data() as PeriodFeeSnapshotWriteLock | undefined;
      if (!snap.exists || existing?.ownerId !== ownerId || existing.leaseExpiresAt <= checkedAt) throw new Error('LOCK_LOST');
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

  private async listByRunIdPrefix(collectionName: string, runId: string, pageSize = 500): Promise<ExistingPeriodFeeDocumentWithKey[]> {
    const rows: ExistingPeriodFeeDocumentWithKey[] = [];
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      let query = this.collection(collectionName)
        .orderBy('__name__')
        .startAt(runId + '__')
        .endBefore(runId + '__\uf8ff')
        .limit(pageSize);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      rows.push(...page.docs.map(doc => {
        const data = doc.data() as Rec;
        return { documentKey: doc.id, digest: typeof data.digest === 'string' ? data.digest : '', data };
      }));
      if (page.docs.length < pageSize) break;
      cursor = page.docs[page.docs.length - 1]!;
    }
    return rows;
  }

  async listLedgerDocumentsByRunIdPrefix(runId: string, pageSize = 500): Promise<ExistingPeriodFeeDocumentWithKey[]> {
    return this.listByRunIdPrefix(FIRESTORE_COLLECTIONS.periodFees.ledger, runId, pageSize);
  }

  async getProductChangeHistoryDocument(documentKey: string): Promise<ExistingPeriodFeeDocument | null> {
    const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.productChangeHistory).doc(documentKey).get();
    if (!snap.exists) return null;
    const data = snap.data() as Rec;
    return { digest: typeof data.digest === 'string' ? data.digest : '', data };
  }

  async createProductChangeHistoryDocument(
    documentKey: string,
    row: ProductChangeHistoryRow | ProductChangeHistoryBaselineRow,
    digest: string,
  ): Promise<void> {
    const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.productChangeHistory).doc(documentKey);
    try {
      await ref.create({ ...row, digest });
    } catch (error) {
      if (String((error as { code?: unknown }).code) === '6' || String((error as Error).message).includes('ALREADY_EXISTS')) {
        const existing = await ref.get();
        if (existing.exists && (existing.data() as Rec | undefined)?.digest === digest) return;
        throw new Error('DOCUMENT_ID_COLLISION');
      }
      throw error;
    }
  }

  async listProductChangeHistoryDocumentsByRunIdPrefix(runId: string, pageSize = 500): Promise<ExistingPeriodFeeDocumentWithKey[]> {
    return this.listByRunIdPrefix(FIRESTORE_COLLECTIONS.periodFees.productChangeHistory, runId, pageSize);
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

  async setSnapshotRun(runId: string, run: PeriodFeeSnapshotRun, guard?: PeriodFeeSnapshotWriteGuard): Promise<void> {
    await this.db.runTransaction(async tx => {
      if (guard) await this.assertSnapshotWriteLock(tx, guard);
      const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(runId);
      const snap = await tx.get(ref);
      const existing = snap.data() as PeriodFeeSnapshotRun | undefined;
      if (guard && snap.exists && existing?.planDigest !== run.planDigest) throw new Error('RUN_STATE_CHANGED');
      if (run.status === 'PREPARED') {
        if (snap.exists && (!existing || existing.status !== 'PREPARED' || existing.planDigest !== run.planDigest)) {
          throw new Error('PERIOD_FEE_RUN_STATE_CONFLICT');
        }
      } else if (guard && run.status === 'ROLLING_BACK') {
        if (!snap.exists || !['ACTIVE', 'PREPARED', 'ROLLING_BACK'].includes(existing?.status ?? '')) throw new Error('RUN_STATE_CHANGED');
      } else if (guard && run.status === 'ROLLBACK_PARTIAL_UNEXPECTED') {
        if (!snap.exists || existing?.status !== 'ROLLING_BACK') throw new Error('RUN_STATE_CHANGED');
      } else if (guard && run.status === 'FAILED') {
        if (!snap.exists || existing?.status !== 'ROLLING_BACK') throw new Error('RUN_STATE_CHANGED');
      } else if (guard && run.status === 'ROLLED_BACK') {
        if (!snap.exists || existing?.status !== 'INACTIVE') throw new Error('RUN_STATE_CHANGED');
      }
      tx.set(ref, run, { merge: true });
    });
  }

  async activateSnapshotRun(runId: string, run: PeriodFeeSnapshotRun, guard: PeriodFeeSnapshotWriteGuard): Promise<void> {
    await this.db.runTransaction(async tx => {
      await this.assertSnapshotWriteLock(tx, guard);
      const runs = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns);
      const targetRef = runs.doc(runId);
      const target = await tx.get(targetRef);
      const existing = target.data() as PeriodFeeSnapshotRun | undefined;
      if (!target.exists || existing?.status !== 'PREPARED' || existing.planDigest !== run.planDigest) {
        throw new Error('RUN_STATE_CHANGED');
      }
      const active = await tx.get(runs.where('snapshotId', '==', run.snapshotId).where('active', '==', true));
      const actualPreviousActiveRunId = active.docs.find(doc => doc.id !== runId)?.id ?? null;
      tx.set(targetRef, { ...run, previousActiveRunId: actualPreviousActiveRunId }, { merge: true });
      for (const doc of active.docs) {
        if (doc.id !== runId) tx.set(doc.ref, { status: 'SUPERSEDED', active: false }, { merge: true });
      }
    });
  }

  async restoreSnapshotRunActive(runId: string, expectedPlanDigest: string, expectedCurrentActiveRunId: string | null, guard: PeriodFeeSnapshotWriteGuard): Promise<void> {
    await this.db.runTransaction(async tx => {
      await this.assertSnapshotWriteLock(tx, guard);
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

  async markSnapshotRunInactive(runId: string, guard: PeriodFeeSnapshotWriteGuard): Promise<void> {
    await this.db.runTransaction(async tx => {
      await this.assertSnapshotWriteLock(tx, guard);
      const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(runId);
      const snap = await tx.get(ref);
      const existing = snap.data() as PeriodFeeSnapshotRun | undefined;
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

  async deleteLedgerRowsByDigest(documentDigests: Array<{ documentKey: string; digest: string }>, guard: PeriodFeeSnapshotWriteGuard): Promise<number> {
    let deleted = 0;
    for (const target of documentDigests) {
      const ref = this.collection(FIRESTORE_COLLECTIONS.periodFees.ledger).doc(target.documentKey);
      const didDelete = await this.db.runTransaction(async tx => {
        await this.assertSnapshotWriteLock(tx, guard);
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        const data = snap.data() as Rec;
        if (data.digest !== target.digest) return false;
        tx.delete(ref);
        return true;
      });
      if (didDelete) deleted += 1;
    }
    return deleted;
  }
}
