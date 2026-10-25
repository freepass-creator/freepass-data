import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { readConsistentPeriodFeeLedgerRows } from './period-fee-ledger-firestore-readback.js';
const jsonSafe = (value) => {
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (value instanceof Date)
        return value.toISOString();
    if (Array.isArray(value))
        return value.map(jsonSafe);
    if (typeof value === 'object') {
        const candidate = value;
        if (typeof candidate.toMillis === 'function') {
            try {
                return new Date(candidate.toMillis()).toISOString();
            }
            catch { /* continue */ }
        }
        if (typeof candidate.path === 'string' && Object.keys(value).length <= 8)
            return candidate.path;
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
    }
    return String(value);
};
export async function readPeriodFeeLedgerPlanInputs() {
    const db = getFirestore(getTargetFirebaseApp());
    const [productsSnap, policiesSnap] = await Promise.all([
        db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).get(),
        db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.policies).get(),
    ]);
    const newCarTrimSnap = await db.collection('new_car_trim').get();
    return {
        products: Object.fromEntries(productsSnap.docs.map(doc => [doc.id, { ...jsonSafe(doc.data()), _key: doc.id }])),
        policies: Object.fromEntries(policiesSnap.docs.map(doc => [doc.id, { ...jsonSafe(doc.data()), _key: doc.id }])),
        newCarTrim: Object.fromEntries(newCarTrimSnap.docs.map(doc => [doc.id, { ...jsonSafe(doc.data()), _key: doc.id }])),
        referenceInputs: {
            sourceProject: 'freepasserp5',
            productsCollection: FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products,
            policiesCollection: FIRESTORE_COLLECTIONS.legacyAdminWorkflow.policies,
            newCarTrimCollection: 'new_car_trim',
            productCount: productsSnap.size,
            policyCount: policiesSnap.size,
            newCarTrimCount: newCarTrimSnap.size,
            settlementRowsAccessCount: 0,
        },
        observedAt: new Date().toISOString(),
    };
}
export async function listActivePeriodFeeLedgerRows() {
    const db = getFirestore(getTargetFirebaseApp());
    const activeRuns = await db.collection(FIRESTORE_COLLECTIONS.periodFees.snapshotRuns)
        .where('active', '==', true)
        .where('status', '==', 'ACTIVE')
        .get();
    const rows = [];
    for (const runDoc of activeRuns.docs) {
        const run = runDoc.data();
        const readback = await readConsistentPeriodFeeLedgerRows(db, run.snapshotId, run.runId, { requireActive: true });
        rows.push(...readback.rows);
    }
    return rows;
}
