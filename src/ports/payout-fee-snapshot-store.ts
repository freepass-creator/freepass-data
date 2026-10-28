// 박제 문서 모양(지급수수료만). 계산 규칙은 application 쪽 기존 엔진을 재사용한다.
export type PayoutFeeState = 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
export type PayoutFeeSnapshotTerm = {
  productId: string;
  supplierId: string;
  termKey: string;
  termMonths: number;
  state: PayoutFeeState;
  amount: number | null;
  vatAmount: number | null;
  totalAmount: number | null;
  vatTreatment?: 'EXCLUDED' | 'INCLUDED' | 'UNKNOWN' | null;
  ruleId: string | null;
  policyId: string;
  reasonCode: string | null;
  evidenceRefs: string[];
  computedFrom: {
    rent: { amount: number | null; currency: 'KRW'; sourceRef: string };
    deposit: { state: string; amount: number | null; currency: 'KRW'; sourceRef: string };
  };
};

export interface ChannelPayoutReader {
  readLatestChannelPayout(vehicleId: string): Promise<PayoutFeeSnapshotDocument | null>;
}

export type PayoutFeeSnapshotDocument = {
  schema: 'product-payout-fee-snapshot/v1';
  snapshotDate: string;
  productId: string;
  supplierId: string;
  listable: boolean;
  policyId: string;
  terms: PayoutFeeSnapshotTerm[];
  contentDigest: string;
  planDigest: string;
};


export type PayoutFeeSnapshotInput = { products: Record<string, Record<string, unknown>>; policies: Record<string, Record<string, unknown>> };

export interface PayoutFeeSnapshotStore {
  readInputs(): Promise<PayoutFeeSnapshotInput>;
  readDocument(documentId: string): Promise<PayoutFeeSnapshotDocument | null>;
  createDocument(documentId: string, document: PayoutFeeSnapshotDocument): Promise<void>;
}
