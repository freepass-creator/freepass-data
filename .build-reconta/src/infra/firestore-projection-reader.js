import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { readFirestoreActiveProjection, readFirestoreActiveProjectionEvidence, readFirestoreProjectionLineage, readFirestoreProjectionManifest } from './firestore-projection-evidence.js';
export function projectionReader(db) {
    return {
        getActive: (projectionId) => readFirestoreActiveProjection(db, projectionId),
        getManifest: (releaseId) => readFirestoreProjectionManifest(db, releaseId),
        listProjectionLineage: (releaseId) => readFirestoreProjectionLineage(db, releaseId),
        getActiveEvidenceSnapshot: (projectionId) => readFirestoreActiveProjectionEvidence(db, projectionId)
    };
}
export function createFirestoreProjectionReader() {
    return projectionReader(getFirestore(getTargetFirebaseApp()));
}
