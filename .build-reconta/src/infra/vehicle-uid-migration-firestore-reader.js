import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
export async function readVehicleUidMigrationInputs() {
    const db = getFirestore(getTargetFirebaseApp());
    const [productsSnap, assetsSnap, bindingsSnap] = await Promise.all([
        db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).get(),
        db.collection(FIRESTORE_COLLECTIONS.catalog.vehicleAssets).get(),
        db.collection(FIRESTORE_COLLECTIONS.catalog.sourceBindings).get(),
    ]);
    return {
        products: Object.fromEntries(productsSnap.docs.map(doc => [doc.id, doc.data()])),
        assets: assetsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })),
        bindings: bindingsSnap.docs.map(doc => doc.data()),
        observedAt: new Date().toISOString(),
    };
}
