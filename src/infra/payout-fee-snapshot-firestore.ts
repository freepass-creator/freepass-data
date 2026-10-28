import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import type { PayoutFeeSnapshotDocument } from '../application/payout-fee-snapshot.js';
import type { PayoutFeeSnapshotInput, PayoutFeeSnapshotStore } from '../ports/payout-fee-snapshot-store.js';

// 공개 products/catalog_offers와 분리하고 영업자 지급수수료만 저장하는 비공개 박제 컬렉션이다.
export const PAYOUT_FEE_SNAPSHOT_COLLECTION = 'product_payout_fee_snapshots';

export class PayoutFeeSnapshotFirestoreStore implements PayoutFeeSnapshotStore {
  constructor(private readonly db: Firestore = getFirestore(getTargetFirebaseApp())) {}

  async readInputs(): Promise<PayoutFeeSnapshotInput> {
    const [products, policies] = await Promise.all([this.db.collection('products').get(), this.db.collection('policy').get()]);
    return {
      products: Object.fromEntries(products.docs.map(document => [document.id, document.data()])),
      policies: Object.fromEntries(policies.docs.map(document => [document.id, document.data()])),
    };
  }

  async readDocument(documentId: string) {
    const snapshot = await this.db.collection(PAYOUT_FEE_SNAPSHOT_COLLECTION).doc(documentId).get();
    return snapshot.exists ? snapshot.data() as PayoutFeeSnapshotDocument : null;
  }

  async createDocument(documentId: string, document: PayoutFeeSnapshotDocument) {
    await this.db.collection(PAYOUT_FEE_SNAPSHOT_COLLECTION).doc(documentId).create(document);
  }
}
