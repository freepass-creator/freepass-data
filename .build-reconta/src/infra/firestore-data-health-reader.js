import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { readFirestoreActiveProjectionEvidence, readFirestoreProjectionLineage } from './firestore-projection-evidence.js';
import { projectionReader } from './firestore-projection-reader.js';
import { decodeFirestoreIdentityDocument } from './firestore-document.js';
export function dataHealthReader(db) {
    const projection = projectionReader(db);
    const all = async (collection, identityField) => {
        const snap = await db.collection(collection).get();
        return snap.docs.map((doc) => decodeFirestoreIdentityDocument(doc, identityField));
    };
    return {
        listVehicleModels: () => all(FIRESTORE_COLLECTIONS.catalog.vehicleModels, 'id'),
        listVehicleAssets: () => all(FIRESTORE_COLLECTIONS.catalog.vehicleAssets, 'id'),
        listProducts: () => all(FIRESTORE_COLLECTIONS.catalog.products, 'id'),
        listOffers: () => all(FIRESTORE_COLLECTIONS.catalog.offers, 'id'),
        listPolicies: () => all(FIRESTORE_COLLECTIONS.catalog.policies, 'id'),
        async listRevisionHistory() {
            const records = await all(FIRESTORE_COLLECTIONS.catalog.revisions, 'revisionRecordId');
            return records.sort((a, b) => a.entityType.localeCompare(b.entityType) ||
                a.entityId.localeCompare(b.entityId) ||
                a.revision - b.revision);
        },
        getActive: projection.getActive,
        getManifest: projection.getManifest,
        listProjectionLineage: (releaseId) => readFirestoreProjectionLineage(db, releaseId),
        getActiveEvidenceSnapshot: (projectionId) => readFirestoreActiveProjectionEvidence(db, projectionId)
    };
}
export function createFirestoreDataHealthReader() {
    return dataHealthReader(getFirestore(getTargetFirebaseApp()));
}
