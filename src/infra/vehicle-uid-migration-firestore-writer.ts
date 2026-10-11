import { FieldValue, getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { VehicleAsset, VehicleExternalId } from '../domain/catalog.js';
import type { VehicleUidMigrationProductDoc, VehicleUidMigrationStoreMutation, VehicleUidMigrationUpdateTime, VehicleUidMigrationWriteStore } from '../ports/vehicle-uid-migration-store.js';
import { stableDigest } from '../shared/stable-digest.js';
import { summarizeVehicleUidMigrationAssetIdentifiers, summarizeVehicleUidMigrationIdentifiers } from '../shared/vehicle-uid-migration-identifiers.js';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';

type TxSnapshot = {
  exists: boolean;
  id: string;
  data(): unknown;
  get(field: string): unknown;
  updateTime?: VehicleUidMigrationUpdateTime;
};

function rollbackAssetExternalIdsPatch(externalIds: VehicleExternalId[] | undefined) {
  return externalIds === undefined ? { externalIds: FieldValue.delete() } : { externalIds };
}

function rollbackProductVehicleUidPatch(vehicleUid: string | null | undefined) {
  return vehicleUid === undefined ? { vehicle_uid: FieldValue.delete() } : { vehicle_uid: vehicleUid };
}

function rollbackProductUidRegistryPatch(hadRegistry: boolean | undefined, registryValue: unknown) {
  return hadRegistry ? { vehicle_uid_registry: registryValue } : { vehicle_uid_registry: FieldValue.delete() };
}

const normalizeExternalIdsForCompare = (externalIds: unknown) =>
  Array.isArray(externalIds)
    ? [...externalIds].sort((left, right) => stableDigest(left).localeCompare(stableDigest(right)))
    : externalIds ?? null;
const sameExternalIds = (left: unknown, right: unknown) =>
  stableDigest(normalizeExternalIdsForCompare(left)) === stableDigest(normalizeExternalIdsForCompare(right));
const updateTimeValue = (snap: { updateTime?: VehicleUidMigrationUpdateTime | undefined }) =>
  snap.updateTime ? { seconds: snap.updateTime.seconds, nanoseconds: snap.updateTime.nanoseconds } : undefined;
const sameUpdateTime = (left: VehicleUidMigrationUpdateTime | undefined, right: VehicleUidMigrationUpdateTime | undefined) =>
  left?.seconds === right?.seconds && left?.nanoseconds === right?.nanoseconds;
const actualWriteCount = (mutations: VehicleUidMigrationStoreMutation[]) =>
  mutations.filter(mutation => mutation.kind !== 'PRODUCT_VERIFY_IDENTIFIERS').length;

export function createVehicleUidMigrationFirestoreWriter(db: Firestore = getFirestore(getTargetFirebaseApp())): VehicleUidMigrationWriteStore {
  const assetRef = (assetId: string) => db.collection(FIRESTORE_COLLECTIONS.catalog.vehicleAssets).doc(assetId);
  const productRef = (productKey: string) => db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).doc(productKey);
  const mutationKey = (mutation: VehicleUidMigrationStoreMutation) =>
    mutation.kind === 'ASSET_EXTERNAL_IDS' ? `asset:${mutation.assetId}` : `product:${mutation.productKey}`;
  const validationAssetKey = (mutation: VehicleUidMigrationStoreMutation) => {
    if (mutation.kind === 'PRODUCT_DELETE_VEHICLE_UID') return undefined;
    if (mutation.kind === 'PRODUCT_VEHICLE_UID' && mutation.assetState === 'PRODUCT_ONLY') return `asset:${mutation.vehicleUid}`;
    if (!mutation.assetIdentifierDigest) return undefined;
    return `asset:${mutation.kind === 'ASSET_EXTERNAL_IDS' ? mutation.assetId : mutation.vehicleUid}`;
  };
  const mutationRef = (mutation: VehicleUidMigrationStoreMutation) =>
    mutation.kind === 'ASSET_EXTERNAL_IDS' ? assetRef(mutation.assetId) : productRef(mutation.productKey);
  const validateAssetDigest = (
    mutation: Extract<VehicleUidMigrationStoreMutation, { kind: 'ASSET_EXTERNAL_IDS' | 'PRODUCT_VEHICLE_UID' | 'PRODUCT_VERIFY_IDENTIFIERS' }>,
    snap: TxSnapshot | undefined,
  ) => {
    if (!mutation.assetIdentifierDigest) return null;
    const target = mutation.kind === 'ASSET_EXTERNAL_IDS' ? `asset:${mutation.assetId}` : `product:${mutation.productKey}`;
    if (!snap?.exists) return { target, reason: mutation.kind === 'PRODUCT_VEHICLE_UID' ? 'UID_ASSET_NOT_FOUND' as const : 'STALE_ASSET' as const };
    if (!mutation.observedAt) return { target, reason: 'STALE_ASSET' as const };
    const asset = { id: snap.id, ...(snap.data() as Record<string, unknown>) } as VehicleAsset;
    if (summarizeVehicleUidMigrationAssetIdentifiers(asset, mutation.observedAt) !== mutation.assetIdentifierDigest) {
      return { target, reason: 'STALE_ASSET' as const };
    }
    return null;
  };
  const validateMutation = (
    mutation: VehicleUidMigrationStoreMutation,
    snap: TxSnapshot,
    validationSnap?: TxSnapshot,
  ) => {
    if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
      if (!snap.exists) return { target: `asset:${mutation.assetId}`, reason: 'CONCURRENT_CHANGE' as const };
      if (mutation.updateTime && !sameUpdateTime(updateTimeValue(snap), mutation.updateTime)) {
        return { target: `asset:${mutation.assetId}`, reason: 'CONCURRENT_CHANGE' as const };
      }
      if (mutation.expectedAfter !== undefined && !sameExternalIds(snap.get('externalIds'), mutation.expectedAfter)) {
        return { target: `asset:${mutation.assetId}`, reason: 'ROLLBACK_SKIPPED_CHANGED' as const };
      }
      return validateAssetDigest(mutation, validationSnap);
    } else if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
      if (!snap.exists) return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' as const };
      if (mutation.updateTime && !sameUpdateTime(updateTimeValue(snap), mutation.updateTime)) {
        return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' as const };
      }
      if (mutation.expectedAfter !== undefined && snap.get('vehicle_uid') !== mutation.expectedAfter) {
        return { target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' as const };
      }
      if (mutation.expectedRegistryAfter !== undefined && snap.get('vehicle_uid_registry') !== mutation.expectedRegistryAfter) {
        return { target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' as const };
      }
      if (mutation.assetState === 'PRODUCT_ONLY' && validationSnap?.exists) {
        return { target: `product:${mutation.productKey}`, reason: 'UID_ASSET_ALREADY_EXISTS' as const };
      }
      if (mutation.assetState === 'LINKED_EXISTING' && !mutation.assetIdentifierDigest) {
        return { target: `product:${mutation.productKey}`, reason: 'UID_ASSET_NOT_FOUND' as const };
      }
      return validateAssetDigest(mutation, validationSnap);
    } else if (mutation.kind === 'PRODUCT_VERIFY_IDENTIFIERS') {
      if (!snap.exists) return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' as const };
      if (mutation.updateTime && !sameUpdateTime(updateTimeValue(snap), mutation.updateTime)) {
        return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' as const };
      }
      if (snap.get('vehicle_uid') !== mutation.vehicleUid) {
        return { target: `product:${mutation.productKey}`, reason: 'STALE_IDENTIFIER' as const };
      }
      const product = snap.data() as Record<string, unknown>;
      if (stableDigest(summarizeVehicleUidMigrationIdentifiers(product)) !== mutation.identifierDigest) {
        return { target: `product:${mutation.productKey}`, reason: 'STALE_IDENTIFIER' as const };
      }
      return validateAssetDigest(mutation, validationSnap);
    } else {
      if (!snap.exists) return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' as const };
      if (mutation.updateTime && !sameUpdateTime(updateTimeValue(snap), mutation.updateTime)) {
        return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' as const };
      }
      if (mutation.expectedAfter !== undefined && snap.get('vehicle_uid') !== mutation.expectedAfter) {
        return { target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' as const };
      }
      if (mutation.expectedRegistryAfter !== undefined && snap.get('vehicle_uid_registry') !== mutation.expectedRegistryAfter) {
        return { target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' as const };
      }
      return null;
    }
  };
  const mutationPatch = (mutation: VehicleUidMigrationStoreMutation) => {
    if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
      return mutation.expectedAfter === undefined ? { externalIds: mutation.externalIds } : rollbackAssetExternalIdsPatch(mutation.externalIds);
    }
    if (mutation.kind === 'PRODUCT_VERIFY_IDENTIFIERS') return {};
    if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
      if (mutation.expectedAfter !== undefined) {
        return {
          ...rollbackProductVehicleUidPatch(mutation.vehicleUid),
          ...(mutation.expectedRegistryAfter !== undefined ? rollbackProductUidRegistryPatch(Boolean(mutation.vehicleUidRegistry), mutation.vehicleUidRegistry) : {}),
        };
      }
      return mutation.vehicleUid !== null
        ? { vehicle_uid: mutation.vehicleUid, ...(mutation.vehicleUidRegistry ? { vehicle_uid_registry: mutation.vehicleUidRegistry } : {}) }
        : rollbackProductVehicleUidPatch(mutation.vehicleUid);
    }
    return {
      ...rollbackProductVehicleUidPatch(undefined),
      ...(mutation.expectedRegistryAfter !== undefined ? rollbackProductUidRegistryPatch(mutation.hadVehicleUidRegistry, mutation.registryValue) : {}),
    };
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
      const skipped: Array<{ target: string; reason: 'CONCURRENT_CHANGE' | 'ROLLBACK_SKIPPED_CHANGED' | 'NOT_APPLIED' | 'STALE_ASSET' | 'STALE_IDENTIFIER' | 'UID_ASSET_NOT_FOUND' | 'UID_ASSET_ALREADY_EXISTS' }> = [];
      const componentSkipped = await db.runTransaction(async (tx) => {
        const refs: Array<{ key: string; ref: ReturnType<typeof assetRef> | ReturnType<typeof productRef> }> = [];
        const addRef = (key: string, ref: ReturnType<typeof assetRef> | ReturnType<typeof productRef>) => {
          if (!refs.some(item => item.key === key)) refs.push({ key, ref });
        };
        for (const mutation of mutations) {
          addRef(mutationKey(mutation), mutationRef(mutation));
          const assetKey = validationAssetKey(mutation);
          if (assetKey) addRef(assetKey, assetRef(assetKey.slice('asset:'.length)));
        }
        const snaps: Array<{ key: string; snap: TxSnapshot }> = [];
        for (const { key, ref } of refs) snaps.push({ key, snap: await tx.get(ref) as TxSnapshot });
        const snapByKey = (key: string) => snaps.find(item => item.key === key)?.snap;
        for (const mutation of mutations) {
          const assetKey = validationAssetKey(mutation);
          const skip = validateMutation(mutation, snapByKey(mutationKey(mutation))!, assetKey ? snapByKey(assetKey) : undefined);
          if (skip) return [skip];
        }
        for (const mutation of mutations) {
          if (mutation.kind !== 'PRODUCT_VERIFY_IDENTIFIERS') tx.update(mutationRef(mutation), mutationPatch(mutation));
        }
        return [];
      });
      if (componentSkipped.length) skipped.push(...componentSkipped);
      else applied += actualWriteCount(mutations);
      return { applied, skipped };
    },
  };
}
