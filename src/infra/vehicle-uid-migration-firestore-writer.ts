import { FieldValue, getFirestore, type Firestore, type WriteBatch } from 'firebase-admin/firestore';
import type { VehicleAsset, VehicleExternalId } from '../domain/catalog.js';
import type { VehicleUidMigrationProductDoc, VehicleUidMigrationStoreMutation, VehicleUidMigrationWriteStore } from '../ports/vehicle-uid-migration-store.js';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';

const WRITE_BATCH_LIMIT = 450;

export function createVehicleUidMigrationFirestoreWriter(db: Firestore = getFirestore(getTargetFirebaseApp())): VehicleUidMigrationWriteStore {
  const assetRef = (assetId: string) => db.collection(FIRESTORE_COLLECTIONS.catalog.vehicleAssets).doc(assetId);
  const productRef = (productKey: string) => db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).doc(productKey);
  const applyMutation = (batch: WriteBatch, mutation: VehicleUidMigrationStoreMutation) => {
    if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
      batch.update(
        assetRef(mutation.assetId),
        mutation.externalIds === undefined ? { externalIds: FieldValue.delete() } : { externalIds: mutation.externalIds },
      );
    } else if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
      batch.update(productRef(mutation.productKey), { vehicle_uid: mutation.vehicleUid });
    } else {
      batch.update(productRef(mutation.productKey), { vehicle_uid: FieldValue.delete() });
    }
  };
  return {
    async getAsset(assetId) {
      const snap = await assetRef(assetId).get();
      return snap.exists ? ({ id: snap.id, ...snap.data() } as VehicleAsset) : null;
    },
    async getProduct(productKey) {
      const snap = await productRef(productKey).get();
      return snap.exists ? (snap.data() as VehicleUidMigrationProductDoc) : null;
    },
    async updateAssetExternalIds(assetId, externalIds) {
      await assetRef(assetId).update({ externalIds });
    },
    async setProductVehicleUid(productKey, vehicleUid) {
      await productRef(productKey).update({ vehicle_uid: vehicleUid });
    },
    async restoreAssetExternalIds(assetId: string, externalIds: VehicleExternalId[] | undefined) {
      await assetRef(assetId).update(externalIds === undefined ? { externalIds: FieldValue.delete() } : { externalIds });
    },
    async deleteProductVehicleUid(productKey: string) {
      await productRef(productKey).update({ vehicle_uid: FieldValue.delete() });
    },
    async commitMutations(mutations: VehicleUidMigrationStoreMutation[]) {
      for (let index = 0; index < mutations.length; index += WRITE_BATCH_LIMIT) {
        const batch = db.batch();
        for (const mutation of mutations.slice(index, index + WRITE_BATCH_LIMIT)) applyMutation(batch, mutation);
        await batch.commit();
      }
    },
  };
}
