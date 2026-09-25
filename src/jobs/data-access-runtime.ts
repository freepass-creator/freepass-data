import { DataAccessGateway } from '../application/data-access-gateway.js';
import { createFirestoreDataAccessLogStore } from '../infra/firestore-data-access-log.js';
import { createFirestoreSourceStore } from '../infra/source-firestore-store.js';

/** Composition root for background jobs that write source evidence. */
export function createSourceIngestDataAccessRuntime() {
  return {
    access: new DataAccessGateway(createFirestoreDataAccessLogStore()),
    sourceStore: createFirestoreSourceStore()
  };
}
