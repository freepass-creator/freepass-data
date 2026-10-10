import { getFirestore } from 'firebase-admin/firestore';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { getTargetFirebaseApp } from './firebase-target.js';
import type {
  SettlementIdLinkAuditSource,
  SettlementIdLinkContract,
  SettlementIdLinkProduct,
  SettlementIdLinkSettlementRow,
} from '../domain/settlement-id-link-audit.js';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const value = (data: Record<string, unknown>, field: string) =>
  data[field] as string | number | boolean | null | undefined;

/** READ-ONLY: fetches settlement audit evidence; no write call of any kind lives in this module. */
export async function readSettlementIdLinkAuditSource(): Promise<SettlementIdLinkAuditSource> {
  const db = getFirestore(getTargetFirebaseApp());
  const collections = FIRESTORE_COLLECTIONS.legacyAdminWorkflow;
  const [settlementRows, contracts, products] = await Promise.all([
    db.collection(collections.settlementRows).get(),
    db.collection(collections.contracts).get(),
    db.collection(collections.products).get(),
  ]);
  return {
    settlementRows: settlementRows.docs.map((doc) => {
      const data = asRecord(doc.data());
      return {
        id: doc.id,
        plate: value(data, 'plate'),
        code: value(data, 'code'),
        supplierCode: value(data, 'supplierCode'),
        product: value(data, 'product'),
        sourceTab: value(data, 'sourceTab'),
        sourceRow: value(data, 'sourceRow'),
        contractNo: value(data, 'contractNo'),
        contractId: value(data, 'contractId'),
        contractCode: value(data, 'contractCode'),
        intakeRequestId: value(data, 'intakeRequestId'),
        sourceProductId: value(data, 'sourceProductId'),
      };
    }),
    contracts: contracts.docs.map((doc) => {
      const data = asRecord(doc.data());
      return {
        id: doc.id,
        car_number_snapshot: value(data, 'car_number_snapshot'),
        contract_code: value(data, 'contract_code'),
        product_code: value(data, 'product_code'),
        _deleted: value(data, '_deleted'),
        is_draft: value(data, 'is_draft'),
        test: value(data, 'test'),
        is_test: value(data, 'is_test'),
        env: value(data, 'env'),
        type: value(data, 'type'),
        status: value(data, 'status'),
      };
    }),
    products: products.docs.map((doc) => {
      const data = asRecord(doc.data());
      return {
        id: doc.id,
        car_number: value(data, 'car_number'),
        product_code: value(data, 'product_code'),
      };
    }),
  };
}
