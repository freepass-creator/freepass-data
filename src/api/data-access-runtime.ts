import { DataAccessGateway } from '../application/data-access-gateway.js';
import { createFirestoreDataAccessLogStore } from '../infra/firestore-data-access-log.js';
import { createFirestoreAdminWorkflowStore } from '../infra/admin-workflow-firestore.js';
import { createFirestoreDataHealthReader } from '../infra/firestore-data-health-reader.js';
import { createFirestoreCatalogCompatibilityReader } from '../infra/erp5-compat-catalog-reader.js';
import { createFirestoreProjectionReader } from '../infra/firestore-projection-reader.js';
import { createFirestoreEstimateArtifactStore } from '../infra/estimate-artifacts-firestore.js';
import { createIancarOneApiClient, iancarOneApiConfigFromEnv, iancarOnePhotoIds, readIancarOnePhotoBytes } from '../adapters/iancar-one-api.js';

/**
 * Composition root for consumer-facing reads.
 * Raw Firestore readers never escape this module.
 */
export function createConsumerDataAccessRuntime() {
  const access = new DataAccessGateway(createFirestoreDataAccessLogStore());
  // A gallery requests several photos together. Coalesce detail lookup only; never cache image bytes.
  const photoSets = new Map<string, { expiresAt: number; ids: Promise<string[]> }>();
  return {
    access,
    projection: createFirestoreProjectionReader(),
    health: createFirestoreDataHealthReader(),
    compat: createFirestoreCatalogCompatibilityReader(async (vehicleId, plate, index) => {
      const config = iancarOneApiConfigFromEnv();
      if (!config.apiKey) throw new Error('IANCAR_PHOTO_SECRET_UNAVAILABLE');
      const client = createIancarOneApiClient(config);
      const key = JSON.stringify([vehicleId, plate]);
      let cached = photoSets.get(key);
      if (!cached || cached.expiresAt <= Date.now()) {
        if (photoSets.size >= 128) photoSets.delete(photoSets.keys().next().value!);
        const ids = client.getVehicle(vehicleId).then(detail => iancarOnePhotoIds(detail, vehicleId, plate));
        cached = { expiresAt: Date.now() + 30_000, ids };
        photoSets.set(key, cached);
        const entry = cached;
        void ids.catch(() => { if (photoSets.get(key) === entry) photoSets.delete(key); });
      }
      const ids = await cached.ids;
      if (index === undefined) return { count: ids.length, bytes: null, contentType: 'application/json' };
      const id = ids[index];
      if (!id) throw new Error('IANCAR_PHOTO_NOT_FOUND');
      return { count: ids.length, ...await readIancarOnePhotoBytes(await client.getPhoto(vehicleId, id)) };
    }),
    workflow: createFirestoreAdminWorkflowStore(),
    estimateArtifacts: createFirestoreEstimateArtifactStore()
  };
}
