import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import {
  readFirestoreActiveProjection,
  readFirestoreProjectionManifest
} from './firestore-projection-evidence.js';
import type { ProjectionStore } from '../ports/catalog-store.js';

export function projectionReader(db: Firestore): Pick<ProjectionStore, 'getActive' | 'getManifest'> {
  return {
    getActive: (projectionId) => readFirestoreActiveProjection(db, projectionId),
    getManifest: (releaseId) => readFirestoreProjectionManifest(db, releaseId)
  };
}

export function createFirestoreProjectionReader() {
  return projectionReader(getFirestore(getTargetFirebaseApp()));
}
