import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import type { DataAccessEvent } from '../domain/data-access.js';
import type { DataAccessLogStore } from '../ports/data-access.js';

const COLLECTION = 'data_access_events';

export function dataAccessLogStore(db: Firestore): DataAccessLogStore {
  return {
    async appendDataAccessEvent(event: DataAccessEvent) {
      // Immutable append-only evidence. Reusing an event ID must fail.
      await db.collection(COLLECTION).doc(event.eventId).create(event);
    }
  };
}

export function createFirestoreDataAccessLogStore() {
  return dataAccessLogStore(getFirestore(getTargetFirebaseApp()));
}
