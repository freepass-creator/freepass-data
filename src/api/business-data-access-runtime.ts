import { DataAccessGateway } from '../application/data-access-gateway.js';
import { createFirestoreDataAccessLogStore } from '../infra/firestore-data-access-log.js';
import { createFirebaseBusinessStore } from '../infra/firebase-business-store.js';

/**
 * The only composition root for the business runtime.
 * Raw Firebase stores stay below this boundary.
 */
export function createBusinessDataAccessRuntime() {
  return {
    access: new DataAccessGateway(createFirestoreDataAccessLogStore()),
    store: createFirebaseBusinessStore(),
  };
}
