import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import {
  readFirestoreActiveProjectionEvidence,
  readFirestoreProjectionLineage
} from './firestore-projection-evidence.js';
import { projectionReader } from './firestore-projection-reader.js';
import { decodeFirestoreIdentityDocument } from './firestore-document.js';
import type {
  Offer,
  Policy,
  Product,
  VehicleAsset,
  VehicleModel
} from '../domain/catalog.js';
import type { EntityRevisionRecord } from '../domain/history.js';
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
    return snap.docs.map((doc) =>
      decodeFirestoreIdentityDocument<T>(doc, identityField)!
    );
  };

  return {
    listVehicleModels: () =>
      all<VehicleModel>(FIRESTORE_COLLECTIONS.catalog.vehicleModels, 'id'),
    listVehicleAssets: () =>
      all<VehicleAsset>(FIRESTORE_COLLECTIONS.catalog.vehicleAssets, 'id'),
    listProducts: () =>
      all<Product>(FIRESTORE_COLLECTIONS.catalog.products, 'id'),
    listOffers: () =>
      all<Offer>(FIRESTORE_COLLECTIONS.catalog.offers, 'id'),
    listPolicies: () =>
      all<Policy>(FIRESTORE_COLLECTIONS.catalog.policies, 'id'),
    async listRevisionHistory() {
      const records = await all<EntityRevisionRecord>(
        FIRESTORE_COLLECTIONS.catalog.revisions,
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
    listProjectionLineage: (releaseId) =>
      readFirestoreProjectionLineage(db, releaseId),
    getActiveEvidenceSnapshot: (projectionId) =>
      readFirestoreActiveProjectionEvidence(db, projectionId)
  };
}

export function createFirestoreDataHealthReader() {
  return dataHealthReader(getFirestore(getTargetFirebaseApp()));
}
