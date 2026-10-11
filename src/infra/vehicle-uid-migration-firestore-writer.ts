import { FieldValue, getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { VehicleAsset, VehicleExternalId } from '../domain/catalog.js';
import type { VehicleUidMigrationProductDoc, VehicleUidMigrationStoreMutation, VehicleUidMigrationUpdateTime, VehicleUidMigrationWriteStore } from '../ports/vehicle-uid-migration-store.js';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';

function rollbackAssetExternalIdsPatch(externalIds: VehicleExternalId[] | undefined) {
  return externalIds === undefined ? { externalIds: FieldValue.delete() } : { externalIds };
}

function rollbackProductVehicleUidPatch(vehicleUid: string | null | undefined) {
  return vehicleUid === undefined || vehicleUid === null ? { vehicle_uid: FieldValue.delete() } : { vehicle_uid: vehicleUid };
}

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const updateTimeValue = (snap: { updateTime?: VehicleUidMigrationUpdateTime | undefined }) =>
  snap.updateTime ? { seconds: snap.updateTime.seconds, nanoseconds: snap.updateTime.nanoseconds } : undefined;
const sameUpdateTime = (left: VehicleUidMigrationUpdateTime | undefined, right: VehicleUidMigrationUpdateTime | undefined) =>
  left?.seconds === right?.seconds && left?.nanoseconds === right?.nanoseconds;

export function createVehicleUidMigrationFirestoreWriter(db: Firestore = getFirestore(getTargetFirebaseApp())): VehicleUidMigrationWriteStore {
  const assetRef = (assetId: string) => db.collection(FIRESTORE_COLLECTIONS.catalog.vehicleAssets).doc(assetId);
  const productRef = (productKey: string) => db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).doc(productKey);
  const applyMutation = async (tx: Transaction, mutation: VehicleUidMigrationStoreMutation, write = true) => {
    if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
      const ref = assetRef(mutation.assetId);
      const snap = await tx.get(ref);
      if (!snap.exists) return { target: `asset:${mutation.assetId}`, reason: 'CONCURRENT_CHANGE' as const };
      if (mutation.updateTime && !sameUpdateTime(updateTimeValue(snap), mutation.updateTime)) {
        return { target: `asset:${mutation.assetId}`, reason: 'CONCURRENT_CHANGE' as const };
      }
      if (mutation.expectedAfter !== undefined && !same(snap.get('externalIds'), mutation.expectedAfter)) {
        return { target: `asset:${mutation.assetId}`, reason: 'ROLLBACK_SKIPPED_CHANGED' as const };
      }
      const patch = mutation.expectedAfter === undefined ? { externalIds: mutation.externalIds } : rollbackAssetExternalIdsPatch(mutation.externalIds);
      if (write) tx.update(ref, patch);
      return null;
    } else if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
      const ref = productRef(mutation.productKey);
      const snap = await tx.get(ref);
      if (!snap.exists) return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' as const };
      if (mutation.updateTime && !sameUpdateTime(updateTimeValue(snap), mutation.updateTime)) {
        return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' as const };
      }
      if (mutation.expectedAfter !== undefined && snap.get('vehicle_uid') !== mutation.expectedAfter) {
        return { target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' as const };
      }
      if (write) tx.update(ref, mutation.expectedAfter === undefined && mutation.vehicleUid !== null ? { vehicle_uid: mutation.vehicleUid } : rollbackProductVehicleUidPatch(mutation.vehicleUid));
      return null;
    } else {
      const ref = productRef(mutation.productKey);
      const snap = await tx.get(ref);
      if (!snap.exists) return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' as const };
      if (mutation.updateTime && !sameUpdateTime(updateTimeValue(snap), mutation.updateTime)) {
        return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' as const };
      }
      if (mutation.expectedAfter !== undefined && snap.get('vehicle_uid') !== mutation.expectedAfter) {
        return { target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' as const };
      }
      if (write) tx.update(ref, rollbackProductVehicleUidPatch(undefined));
      return null;
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
    async getAssetSnapshot(assetId) {
      const snap = await assetRef(assetId).get();
      const updateTime = updateTimeValue(snap);
      return snap.exists ? { data: { id: snap.id, ...snap.data() } as VehicleAsset, ...(updateTime ? { updateTime } : {}) } : null;
    },
    async getProductSnapshot(productKey) {
      const snap = await productRef(productKey).get();
      const updateTime = updateTimeValue(snap);
      return snap.exists ? { data: snap.data() as VehicleUidMigrationProductDoc, ...(updateTime ? { updateTime } : {}) } : null;
    },
    async updateAssetExternalIds(assetId, externalIds) {
      await assetRef(assetId).update({ externalIds });
    },
    async setProductVehicleUid(productKey, vehicleUid) {
      await productRef(productKey).update({ vehicle_uid: vehicleUid });
    },
    async restoreAssetExternalIds(assetId: string, externalIds: VehicleExternalId[] | undefined) {
      await assetRef(assetId).update(rollbackAssetExternalIdsPatch(externalIds));
    },
    async deleteProductVehicleUid(productKey: string) {
      await productRef(productKey).update(rollbackProductVehicleUidPatch(undefined));
    },
    async commitMutations(mutations: VehicleUidMigrationStoreMutation[]) {
      let applied = 0;
      const skipped: Array<{ target: string; reason: 'CONCURRENT_CHANGE' | 'ROLLBACK_SKIPPED_CHANGED' | 'NOT_APPLIED' }> = [];
      const componentSkipped = await db.runTransaction(async (tx) => {
        for (const mutation of mutations) {
          const skip = await applyMutation(tx, mutation, false);
          if (skip) return [skip];
        }
        for (const mutation of mutations) await applyMutation(tx, mutation, true);
        return [];
      });
      if (componentSkipped.length) skipped.push(...componentSkipped);
      else applied += mutations.length;
      return { applied, skipped };
    },
  };
}
