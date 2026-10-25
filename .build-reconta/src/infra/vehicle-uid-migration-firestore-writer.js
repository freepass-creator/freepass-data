import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { stableDigest } from '../shared/stable-digest.js';
import { summarizeVehicleUidMigrationAssetIdentifiers, summarizeVehicleUidMigrationIdentifiers } from '../shared/vehicle-uid-migration-identifiers.js';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
function rollbackAssetExternalIdsPatch(externalIds) {
    return externalIds === undefined ? { externalIds: FieldValue.delete() } : { externalIds };
}
function rollbackProductVehicleUidPatch(vehicleUid) {
    return vehicleUid === undefined ? { vehicle_uid: FieldValue.delete() } : { vehicle_uid: vehicleUid };
}
function rollbackProductUidRegistryPatch(hadRegistry, registryValue) {
    return hadRegistry ? { vehicle_uid_registry: registryValue } : { vehicle_uid_registry: FieldValue.delete() };
}
const normalizeExternalIdsForCompare = (externalIds) => Array.isArray(externalIds)
    ? [...externalIds].sort((left, right) => stableDigest(left).localeCompare(stableDigest(right)))
    : externalIds ?? null;
const sameExternalIds = (left, right) => stableDigest(normalizeExternalIdsForCompare(left)) === stableDigest(normalizeExternalIdsForCompare(right));
const updateTimeValue = (snap) => snap.updateTime ? { seconds: snap.updateTime.seconds, nanoseconds: snap.updateTime.nanoseconds } : undefined;
const sameUpdateTime = (left, right) => left?.seconds === right?.seconds && left?.nanoseconds === right?.nanoseconds;
const actualWriteCount = (mutations) => mutations.filter(mutation => mutation.kind !== 'PRODUCT_VERIFY_IDENTIFIERS').length;
export function createVehicleUidMigrationFirestoreWriter(db = getFirestore(getTargetFirebaseApp())) {
    const assetRef = (assetId) => db.collection(FIRESTORE_COLLECTIONS.catalog.vehicleAssets).doc(assetId);
    const productRef = (productKey) => db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).doc(productKey);
    const mutationKey = (mutation) => mutation.kind === 'ASSET_EXTERNAL_IDS' ? `asset:${mutation.assetId}` : `product:${mutation.productKey}`;
    const validationAssetKey = (mutation) => {
        if (mutation.kind === 'PRODUCT_DELETE_VEHICLE_UID')
            return undefined;
        if (mutation.kind === 'PRODUCT_VEHICLE_UID' && mutation.assetState === 'PRODUCT_ONLY')
            return `asset:${mutation.vehicleUid}`;
        if (!mutation.assetIdentifierDigest)
            return undefined;
        return `asset:${mutation.kind === 'ASSET_EXTERNAL_IDS' ? mutation.assetId : mutation.vehicleUid}`;
    };
    const mutationRef = (mutation) => mutation.kind === 'ASSET_EXTERNAL_IDS' ? assetRef(mutation.assetId) : productRef(mutation.productKey);
    const validateAssetDigest = (mutation, snap) => {
        if (!mutation.assetIdentifierDigest)
            return null;
        const target = mutation.kind === 'ASSET_EXTERNAL_IDS' ? `asset:${mutation.assetId}` : `product:${mutation.productKey}`;
        if (!snap?.exists)
            return { target, reason: mutation.kind === 'PRODUCT_VEHICLE_UID' ? 'UID_ASSET_NOT_FOUND' : 'STALE_ASSET' };
        if (!mutation.observedAt)
            return { target, reason: 'STALE_ASSET' };
        const asset = { id: snap.id, ...snap.data() };
        if (summarizeVehicleUidMigrationAssetIdentifiers(asset, mutation.observedAt) !== mutation.assetIdentifierDigest) {
            return { target, reason: 'STALE_ASSET' };
        }
        return null;
    };
    const validateMutation = (mutation, snap, validationSnap) => {
        if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
            if (!snap.exists)
                return { target: `asset:${mutation.assetId}`, reason: 'CONCURRENT_CHANGE' };
            if (mutation.updateTime && !sameUpdateTime(updateTimeValue(snap), mutation.updateTime)) {
                return { target: `asset:${mutation.assetId}`, reason: 'CONCURRENT_CHANGE' };
            }
            if (mutation.expectedAfter !== undefined && !sameExternalIds(snap.get('externalIds'), mutation.expectedAfter)) {
                return { target: `asset:${mutation.assetId}`, reason: 'ROLLBACK_SKIPPED_CHANGED' };
            }
            return validateAssetDigest(mutation, validationSnap);
        }
        else if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
            if (!snap.exists)
                return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' };
            if (mutation.updateTime && !sameUpdateTime(updateTimeValue(snap), mutation.updateTime)) {
                return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' };
            }
            if (mutation.expectedAfter !== undefined && snap.get('vehicle_uid') !== mutation.expectedAfter) {
                return { target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' };
            }
            if (mutation.expectedRegistryAfter !== undefined && snap.get('vehicle_uid_registry') !== mutation.expectedRegistryAfter) {
                return { target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' };
            }
            if (mutation.assetState === 'PRODUCT_ONLY' && validationSnap?.exists) {
                return { target: `product:${mutation.productKey}`, reason: 'UID_ASSET_ALREADY_EXISTS' };
            }
            if (mutation.assetState === 'LINKED_EXISTING' && !mutation.assetIdentifierDigest) {
                return { target: `product:${mutation.productKey}`, reason: 'UID_ASSET_NOT_FOUND' };
            }
            return validateAssetDigest(mutation, validationSnap);
        }
        else if (mutation.kind === 'PRODUCT_VERIFY_IDENTIFIERS') {
            if (!snap.exists)
                return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' };
            if (mutation.updateTime && !sameUpdateTime(updateTimeValue(snap), mutation.updateTime)) {
                return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' };
            }
            if (snap.get('vehicle_uid') !== mutation.vehicleUid) {
                return { target: `product:${mutation.productKey}`, reason: 'STALE_IDENTIFIER' };
            }
            const product = snap.data();
            if (stableDigest(summarizeVehicleUidMigrationIdentifiers(product)) !== mutation.identifierDigest) {
                return { target: `product:${mutation.productKey}`, reason: 'STALE_IDENTIFIER' };
            }
            return validateAssetDigest(mutation, validationSnap);
        }
        else {
            if (!snap.exists)
                return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' };
            if (mutation.updateTime && !sameUpdateTime(updateTimeValue(snap), mutation.updateTime)) {
                return { target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' };
            }
            if (mutation.expectedAfter !== undefined && snap.get('vehicle_uid') !== mutation.expectedAfter) {
                return { target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' };
            }
            if (mutation.expectedRegistryAfter !== undefined && snap.get('vehicle_uid_registry') !== mutation.expectedRegistryAfter) {
                return { target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' };
            }
            return null;
        }
    };
    const mutationPatch = (mutation) => {
        if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
            return mutation.expectedAfter === undefined ? { externalIds: mutation.externalIds } : rollbackAssetExternalIdsPatch(mutation.externalIds);
        }
        if (mutation.kind === 'PRODUCT_VERIFY_IDENTIFIERS')
            return {};
        if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
            if (mutation.expectedAfter !== undefined) {
                return {
                    ...rollbackProductVehicleUidPatch(mutation.vehicleUid),
                    ...(mutation.expectedRegistryAfter !== undefined ? rollbackProductUidRegistryPatch(mutation.hadVehicleUidRegistry === true, mutation.registryValue) : {}),
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
            return snap.exists ? { id: snap.id, ...snap.data() } : null;
        },
        async getProduct(productKey) {
            const snap = await productRef(productKey).get();
            return snap.exists ? snap.data() : null;
        },
        async getAssetSnapshot(assetId) {
            const snap = await assetRef(assetId).get();
            const updateTime = updateTimeValue(snap);
            return snap.exists ? { data: { id: snap.id, ...snap.data() }, ...(updateTime ? { updateTime } : {}) } : null;
        },
        async getProductSnapshot(productKey) {
            const snap = await productRef(productKey).get();
            const updateTime = updateTimeValue(snap);
            return snap.exists ? { data: snap.data(), ...(updateTime ? { updateTime } : {}) } : null;
        },
        async updateAssetExternalIds(assetId, externalIds) {
            await assetRef(assetId).update({ externalIds });
        },
        async setProductVehicleUid(productKey, vehicleUid) {
            await productRef(productKey).update({ vehicle_uid: vehicleUid });
        },
        async restoreAssetExternalIds(assetId, externalIds) {
            await assetRef(assetId).update(rollbackAssetExternalIdsPatch(externalIds));
        },
        async deleteProductVehicleUid(productKey) {
            await productRef(productKey).update(rollbackProductVehicleUidPatch(undefined));
        },
        async commitMutations(mutations) {
            let applied = 0;
            const skipped = [];
            const componentSkipped = await db.runTransaction(async (tx) => {
                const refs = [];
                const addRef = (key, ref) => {
                    if (!refs.some(item => item.key === key))
                        refs.push({ key, ref });
                };
                for (const mutation of mutations) {
                    addRef(mutationKey(mutation), mutationRef(mutation));
                    const assetKey = validationAssetKey(mutation);
                    if (assetKey)
                        addRef(assetKey, assetRef(assetKey.slice('asset:'.length)));
                }
                const snaps = [];
                for (const { key, ref } of refs)
                    snaps.push({ key, snap: await tx.get(ref) });
                const snapByKey = (key) => snaps.find(item => item.key === key)?.snap;
                for (const mutation of mutations) {
                    const assetKey = validationAssetKey(mutation);
                    const skip = validateMutation(mutation, snapByKey(mutationKey(mutation)), assetKey ? snapByKey(assetKey) : undefined);
                    if (skip)
                        return [skip];
                }
                for (const mutation of mutations) {
                    if (mutation.kind !== 'PRODUCT_VERIFY_IDENTIFIERS')
                        tx.update(mutationRef(mutation), mutationPatch(mutation));
                }
                return [];
            });
            if (componentSkipped.length)
                skipped.push(...componentSkipped);
            else
                applied += actualWriteCount(mutations);
            return { applied, skipped };
        },
    };
}
