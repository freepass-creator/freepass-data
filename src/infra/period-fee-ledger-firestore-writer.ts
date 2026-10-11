import type { Firestore } from 'firebase-admin/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import type {
  ExistingPeriodFeeDocument,
  PeriodFeeLedgerApplyStore,
} from '../ports/period-fee-ledger-store.js';
import type {
  PeriodFeeSnapshotRun,
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

const assertAllowedCollection = (collection: string) => {
  if (!allowed.has(collection)) throw new Error('PERIOD_FEE_WRITE_COLLECTION_FORBIDDEN');
};

export class PeriodFeeLedgerFirestoreWriter implements PeriodFeeLedgerApplyStore {
  constructor(private readonly db: Firestore = getFirestore(getTargetFirebaseApp())) {}

  private collection(name: string) {
    assertAllowedCollection(name);
    return this.db.collection(name);
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

  async getSnapshotRun(snapshotId: string): Promise<PeriodFeeSnapshotRun | null> {
    const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(snapshotId).get();
    return snap.exists ? snap.data() as PeriodFeeSnapshotRun : null;
  }

  async setSnapshotRun(snapshotId: string, run: PeriodFeeSnapshotRun): Promise<void> {
    await this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(snapshotId).set(run, { merge: true });
  }

  async readLedgerRows(snapshotId: string): Promise<PeriodFeeLedgerRow[]> {
    const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.ledger).where('snapshotId', '==', snapshotId).get();
    return snap.docs.map(doc => {
      const { digest: _digest, ...data } = doc.data() as Rec;
      return data as PeriodFeeLedgerRow;
    });
  }

  async markSnapshotRunInactive(snapshotId: string): Promise<void> {
    const existing = await this.getSnapshotRun(snapshotId);
    await this.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns).doc(snapshotId).set({
      ...(existing ?? {
        schemaVersion: 'period-fee-snapshot-run/v1',
        snapshotId,
        planDigest: '',
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

  async deleteLedgerRows(snapshotId: string): Promise<number> {
    const snap = await this.collection(FIRESTORE_COLLECTIONS.periodFees.ledger).where('snapshotId', '==', snapshotId).get();
    let deleted = 0;
    for (const doc of snap.docs) {
      await doc.ref.delete();
      deleted += 1;
    }
    return deleted;
  }
}
