import { DataAccessGateway } from '../application/data-access-gateway.js';
import { createFirestoreDataAccessLogStore } from '../infra/firestore-data-access-log.js';
import { gcsDataAccessLogStore } from '../infra/gcs-data-access-log.js';

export function createJobDataAccessRuntime() {
  return {
    access: new DataAccessGateway(createFirestoreDataAccessLogStore())
  };
}

export function createReadOnlyJobDataAccessRuntime(input: {
  accessToken: string;
  evidenceBucket: string;
}) {
  return {
    access: new DataAccessGateway(gcsDataAccessLogStore({
      accessToken: input.accessToken,
      bucket: input.evidenceBucket
    }))
  };
}

export async function createSourceIngestDataAccessRuntime() {
  const { createFirestoreSourceStore } = await import('../infra/source-firestore-store.js');
  return {
    ...createJobDataAccessRuntime(),
    sourceStore: createFirestoreSourceStore()
  };
}

export async function createCentralDiagnosticDataAccessRuntime() {
  const { readCentralFirestoreCounts } = await import('../infra/central-firestore-diagnostic.js');
  return {
    ...createJobDataAccessRuntime(),
    readCounts: readCentralFirestoreCounts
  };
}
