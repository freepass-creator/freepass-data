import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { projectionReader } from './firestore-projection-reader.js';
import type {
  Offer,
  Policy,
  Product,
  ErpPublicProduct,
  ProjectionProduct,
  ProjectionRelease,
  VehicleAsset,
  VehicleModel
} from '../domain/catalog.js';
import type { EntityRevisionRecord } from '../domain/history.js';
import type {
  ProjectionFieldLineageRecord,
  ProjectionReleaseManifest
} from '../domain/projection-evidence.js';
import type {
  CatalogStore,
  ProjectionEvidenceSnapshotStore,
  ProjectionStore
} from '../ports/catalog-store.js';

export type CatalogDataHealthReadStore =
  Pick<
    CatalogStore,
    | 'listVehicleModels'
    | 'listVehicleAssets'
    | 'listProducts'
    | 'listOffers'
    | 'listPolicies'
    | 'listRevisionHistory'
  > &
  Pick<
    ProjectionStore,
    'getActive' | 'getManifest' | 'listProjectionLineage'
  > &
  ProjectionEvidenceSnapshotStore;

export function dataHealthReader(db: Firestore): CatalogDataHealthReadStore {
  const projection = projectionReader(db);

  const all = async <T>(
    collection: string,
    identityField: 'id' | 'revisionRecordId'
  ): Promise<T[]> => {
    const snap = await db.collection(collection).get();
    return snap.docs.map((doc) => {
      const stored = doc.data();
      const payloadIdentity = stored[identityField];
      if (payloadIdentity !== undefined && payloadIdentity !== doc.id) {
        throw new Error(`Firestore document identity mismatch in ${collection}`);
      }
      return { ...stored, [identityField]: doc.id } as T;
    });
  };

  return {
    listVehicleModels: () => all<VehicleModel>('catalog_vehicle_models', 'id'),
    listVehicleAssets: () => all<VehicleAsset>('catalog_vehicle_assets', 'id'),
    listProducts: () => all<Product>('catalog_products', 'id'),
    listOffers: () => all<Offer>('catalog_offers', 'id'),
    listPolicies: () => all<Policy>('catalog_policies', 'id'),
    async listRevisionHistory() {
      const records = await all<EntityRevisionRecord>(
        'catalog_entity_revisions',
        'revisionRecordId'
      );
      return records.sort((a, b) =>
        a.entityType.localeCompare(b.entityType) ||
        a.entityId.localeCompare(b.entityId) ||
        a.revision - b.revision
      );
    },
    getActive: projection.getActive,
    getManifest: projection.getManifest,
    async listProjectionLineage(releaseId) {
      if (!/^rel_[a-zA-Z0-9-]+$/.test(releaseId)) {
        throw new Error('Invalid release identity');
      }
      const snap = await db.collection('projection_field_lineage')
        .where('releaseId', '==', releaseId)
        .get();
      return snap.docs.map(
        (doc) => doc.data() as ProjectionFieldLineageRecord
      );
    },
    async getActiveEvidenceSnapshot<T extends ProjectionProduct = ErpPublicProduct>(
      projectionId: string
    ) {
      const activeRef = db.collection('projection_active').doc(projectionId);
      return db.runTransaction(async (tx) => {
        const activeSnap = await tx.get(activeRef);
        if (!activeSnap.exists) {
          return {
            projectionId,
            release: null,
            manifest: null,
            lineage: [],
            consistency: 'ATOMIC' as const
          };
        }

        const releaseId: unknown = activeSnap.get('releaseId');
        if (
          typeof releaseId !== 'string' ||
          !/^rel_[a-zA-Z0-9-]+$/.test(releaseId)
        ) {
          throw new Error('Invalid release pointer');
        }

        const releaseRef = db.collection('projection_releases').doc(releaseId);
        const manifestRef = db.collection('projection_release_manifests').doc(releaseId);
        const evidenceQuery = db.collection('projection_field_lineage')
          .where('releaseId', '==', releaseId);

        const releaseSnap = await tx.get(releaseRef);
        const manifestSnap = await tx.get(manifestRef);
        const evidenceSnap = await tx.get(evidenceQuery);

        const release = releaseSnap.exists
          ? releaseSnap.data() as ProjectionRelease<T>
          : null;
        if (release && release.releaseId !== releaseId) {
          throw new Error('Release pointer identity mismatch');
        }

        const manifest = manifestSnap.exists
          ? manifestSnap.data() as ProjectionReleaseManifest
          : null;

        return {
          projectionId,
          release,
          manifest,
          lineage: evidenceSnap.docs.map(
            (doc) => doc.data() as ProjectionFieldLineageRecord
          ),
          consistency: 'ATOMIC' as const
        };
      });
    }
  };
}

export function createFirestoreDataHealthReader() {
  return dataHealthReader(getFirestore(getTargetFirebaseApp()));
}
