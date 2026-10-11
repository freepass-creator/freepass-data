import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';

type Rec = Record<string, unknown>;

const jsonSafe = (value: unknown): unknown => {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const candidate = value as { toMillis?: () => number; path?: unknown };
    if (typeof candidate.toMillis === 'function') {
      try { return new Date(candidate.toMillis()).toISOString(); } catch { /* continue */ }
    }
    if (typeof candidate.path === 'string' && Object.keys(value as object).length <= 8) return candidate.path;
    return Object.fromEntries(Object.entries(value as Rec).map(([key, child]) => [key, jsonSafe(child)]));
  }
  return String(value);
};

export async function readPeriodFeeLedgerPlanInputs() {
  const db = getFirestore(getTargetFirebaseApp());
  const [productsSnap, policiesSnap] = await Promise.all([
    db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).get(),
    db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.policies).get(),
  ]);
  return {
    products: Object.fromEntries(productsSnap.docs.map(doc => [doc.id, { ...(jsonSafe(doc.data()) as Rec), _key: doc.id }])),
    policies: Object.fromEntries(policiesSnap.docs.map(doc => [doc.id, { ...(jsonSafe(doc.data()) as Rec), _key: doc.id }])),
    referenceInputs: {
      sourceProject: 'freepasserp5',
      productsCollection: FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products,
      policiesCollection: FIRESTORE_COLLECTIONS.legacyAdminWorkflow.policies,
      productCount: productsSnap.size,
      policyCount: policiesSnap.size,
      settlementRowsAccessCount: 0,
    },
    observedAt: new Date().toISOString(),
  };
}
