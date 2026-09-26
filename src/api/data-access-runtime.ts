import { DataAccessGateway } from '../application/data-access-gateway.js';
import { createFirestoreDataAccessLogStore } from '../infra/firestore-data-access-log.js';
import { createFirestoreDataHealthReader } from '../infra/firestore-data-health-reader.js';
import { createFirestoreProjectionReader } from '../infra/firestore-projection-reader.js';

/**
 * Composition root for consumer-facing reads.
 * Raw Firestore readers never escape this module.
 */
export function createConsumerDataAccessRuntime() {
  const access = new DataAccessGateway(createFirestoreDataAccessLogStore());
  return {
    access,
    projection: createFirestoreProjectionReader(),
    health: createFirestoreDataHealthReader()
  };
}
