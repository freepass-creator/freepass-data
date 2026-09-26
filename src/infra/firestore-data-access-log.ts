import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import type { DataAccessEvent } from '../domain/data-access.js';
import type {
  DataAccessEventReader,
  DataAccessLogStore
} from '../ports/data-access.js';

const COLLECTION = FIRESTORE_COLLECTIONS.evidence.dataAccessEvents;

export function dataAccessLogStore(
  db: Firestore
): DataAccessLogStore & DataAccessEventReader {
  return {
    async appendDataAccessEvent(event: DataAccessEvent) {
      // Immutable append-only evidence. Reusing an event ID must fail.
      await db.collection(COLLECTION).doc(event.eventId).create(event);
    },

    async listRecentDataAccessEvents(limit: number) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
        throw new Error('INVALID_DATA_ACCESS_EVENT_LIMIT');
      }
      const snap = await db.collection(COLLECTION)
        .orderBy('occurredAt', 'desc')
        .limit(limit)
        .get();
      return snap.docs.map((doc) => doc.data() as DataAccessEvent);
    }
  };
}

export function createFirestoreDataAccessLogStore() {
  return dataAccessLogStore(getFirestore(getTargetFirebaseApp()));
}
