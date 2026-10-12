import { VEHICLE_PHOTO_CACHE_TTL_MS } from '../domain/consumer-output-contract.js';
import { DataAccessGateway } from '../application/data-access-gateway.js';
import { createFirestoreDataAccessLogStore } from '../infra/firestore-data-access-log.js';
import { createFirestoreAdminWorkflowStore } from '../infra/admin-workflow-firestore.js';
import { createFirestoreDataHealthReader } from '../infra/firestore-data-health-reader.js';
import { createFirestoreCatalogCompatibilityReader, type ApprovedPhotoReader } from '../infra/erp5-compat-catalog-reader.js';
import { createFirestoreProjectionReader } from '../infra/firestore-projection-reader.js';
import { createFirestoreEstimateArtifactStore } from '../infra/estimate-artifacts-firestore.js';
import { createIancarOneApiClient, createIancarPhotoByteCache, iancarOneApiConfigFromEnv, iancarOnePhotoIds, readIancarOnePhotoBytes } from '../adapters/iancar-one-api.js';
import { logPhotoMetadataFailure } from './vehicle-photo-metadata-diagnostic.js';
import { createVehiclePhotoReadFailureObserver } from './vehicle-photo-read-diagnostic.js';
export { isPublicIancarPhotoProduct } from '../infra/erp5-compat-catalog-reader.js';

/**
 * Composition root for consumer-facing reads.
 * Raw Firestore readers never escape this module.
 */
export function createConsumerDataAccessRuntime(approvedPhotoReader?: ApprovedPhotoReader) {
  const access = new DataAccessGateway(createFirestoreDataAccessLogStore());
  // The reader rechecks public eligibility before either private cache is used.
  const photoSets = new Map<string, { expiresAt: number; ids: Promise<string[]> }>();
  const photoBytes = createIancarPhotoByteCache();
  return {
    access,
    projection: createFirestoreProjectionReader(),
    health: createFirestoreDataHealthReader(),
    compat: createFirestoreCatalogCompatibilityReader(async (vehicleId, plate, index, fresh, expectedRegisteredPhotoCount) => {
      // Capture only the published count; current source handles may be reissued.
      const expected = expectedRegisteredPhotoCount;
      if (expected !== undefined) {
        if (fresh !== true || !Number.isSafeInteger(expected) || expected < 1 || expected > 200
          || (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || index >= expected)))
          throw new Error('VEHICLE_PHOTO_REQUEST_INVALID');
      }
      // Also covers a byte request's final fresh-membership recheck; no caller binding is inferred.
      const observeMetadata = fresh === true && index === undefined;
      let client: ReturnType<typeof createIancarOneApiClient>;
      try {
        const config = iancarOneApiConfigFromEnv();
        if (!config.apiKey) throw new Error('VEHICLE_PHOTO_READER_UNAVAILABLE');
        client = createIancarOneApiClient(config);
      } catch (error) {
        if (observeMetadata) logPhotoMetadataFailure('FETCH_DETAIL', error);
        throw error;
      }
      if (fresh) {
        let detail: Awaited<ReturnType<typeof client.getVehicle>>;
        try { detail = await client.getVehicle(vehicleId); }
        catch (error) {
          if (observeMetadata) logPhotoMetadataFailure('FETCH_DETAIL', error, true);
          throw error;
        }
        let photoIds: string[], metadata: { count: number; photoIds: string[]; upstreamPhotoIds: string[]; upstreamRepresentatives: boolean[]; servingSourceOrdinals: number[] };
        try {
          photoIds = iancarOnePhotoIds(detail, vehicleId, plate);
          // Validate count before fetching this same fresh detail's selected handle.
          if (expected !== undefined && photoIds.length !== expected)
            throw new Error('VEHICLE_PHOTO_NOT_FOUND');
          const raw = (detail as any)?.data ?? detail;
          const upstreamPhotoIds = raw.photos.map((photo: any) => String(photo.photo_id).trim()) as string[];
          const upstreamRepresentatives = raw.photos.map((photo: any) => photo.representative) as boolean[];
          const servingSourceOrdinals = photoIds.map(id => upstreamPhotoIds.indexOf(id));
          metadata = { count: photoIds.length, photoIds, upstreamPhotoIds, upstreamRepresentatives, servingSourceOrdinals };
        } catch (error) {
          if (observeMetadata) logPhotoMetadataFailure('VALIDATE_METADATA', error);
          throw error;
        }
        if (index === undefined) return { ...metadata, bytes: null, contentType: 'application/json' };
        const id = photoIds[index];
        if (!id) throw new Error('VEHICLE_PHOTO_NOT_FOUND');
        // A reviewed album must not serve cached bytes after the same source ID changes content.
        return { ...metadata, ...await readIancarOnePhotoBytes(await client.getPhoto(vehicleId, id)) };
      }
      const key = JSON.stringify([vehicleId, plate]);
      let cached = photoSets.get(key);
      if (!cached || cached.expiresAt <= Date.now()) {
        if (photoSets.size >= 128) photoSets.delete(photoSets.keys().next().value!);
        const ids = client.getVehicle(vehicleId).then(detail => iancarOnePhotoIds(detail, vehicleId, plate));
        cached = { expiresAt: Date.now() + VEHICLE_PHOTO_CACHE_TTL_MS, ids };
        photoSets.set(key, cached);
        const entry = cached;
        void ids.catch(() => { if (photoSets.get(key) === entry) photoSets.delete(key); });
      }
      const ids = await cached.ids;
      if (index === undefined) return { count: ids.length, bytes: null, contentType: 'application/json' };
      const id = ids[index];
      if (!id) throw new Error('VEHICLE_PHOTO_NOT_FOUND');
      return { count: ids.length, ...await photoBytes(vehicleId, id, async () => readIancarOnePhotoBytes(await client.getPhoto(vehicleId, id))) };
    }, approvedPhotoReader, { photoReadFailureObserver: createVehiclePhotoReadFailureObserver() }),
    workflow: createFirestoreAdminWorkflowStore(),
    estimateArtifacts: createFirestoreEstimateArtifactStore()
  };
}
