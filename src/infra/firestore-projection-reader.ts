import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import {
  readFirestoreActiveProjection,
  readFirestoreActiveProjectionEvidence,
  readFirestoreProjectionLineage,
  readFirestoreProjectionManifest
} from './firestore-projection-evidence.js';
import type {
  ProjectionEvidenceSnapshotStore,
  ProjectionStore
} from '../ports/catalog-store.js';

type ConsumerProjectionReader =
  Pick<ProjectionStore, 'getActive' | 'getManifest' | 'listProjectionLineage'> &
  ProjectionEvidenceSnapshotStore;

export function projectionReader(db: Firestore): ConsumerProjectionReader {
  return {
    getActive: (projectionId) => readFirestoreActiveProjection(db, projectionId),
    getManifest: (releaseId) => readFirestoreProjectionManifest(db, releaseId),
    listProjectionLineage: (releaseId) => readFirestoreProjectionLineage(db, releaseId),
    getActiveEvidenceSnapshot: (projectionId) =>
      readFirestoreActiveProjectionEvidence(db, projectionId)
  };
}

export function createFirestoreProjectionReader() {
  return projectionReader(getFirestore(getTargetFirebaseApp()));
}
