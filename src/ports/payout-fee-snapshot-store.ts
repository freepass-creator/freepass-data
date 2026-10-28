import type { PayoutFeeSnapshotDocument } from '../application/payout-fee-snapshot.js';

export type PayoutFeeSnapshotInput = { products: Record<string, Record<string, unknown>>; policies: Record<string, Record<string, unknown>> };

export interface PayoutFeeSnapshotStore {
  readInputs(): Promise<PayoutFeeSnapshotInput>;
  readDocument(documentId: string): Promise<PayoutFeeSnapshotDocument | null>;
  createDocument(documentId: string, document: PayoutFeeSnapshotDocument): Promise<void>;
}
