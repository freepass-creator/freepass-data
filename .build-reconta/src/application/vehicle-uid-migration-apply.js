import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { addExternalId } from '../domain/vehicle-uid.js';
import { stableDigest } from '../shared/stable-digest.js';
import { summarizeVehicleUidMigrationIdentifiers, } from './vehicle-uid-migration-plan.js';
const bodyForDigest = (plan) => {
    const { planDigest: _planDigest, ...body } = plan;
    return body;
};
const backupBodyForDigest = (backup) => {
    const { backupDigest: _backupDigest, ...body } = backup;
    return body;
};
export function computeVehicleUidPlanDigest(plan) {
    return stableDigest(bodyForDigest(plan));
}
export function assertVehicleUidPlanDigest(plan, expectedDigest) {
    const actual = computeVehicleUidPlanDigest(plan);
    if (plan.planDigest !== expectedDigest || actual !== expectedDigest) {
        throw new Error('VEHICLE_UID_PLAN_DIGEST_MISMATCH');
    }
    return actual;
}
function mutationItems(plan) {
    if (!plan.summary.invariants.oneActivePlatePerUid)
        throw new Error('VEHICLE_UID_ONE_ACTIVE_PLATE_INVARIANT_FALSE');
    const items = plan.items.filter((item) => item.kind !== 'HOLD');
    for (const item of items) {
        if (item.kind === 'PRODUCT_SET_UID') {
            if (!item.assetState)
                throw new Error('PLAN_INVALID');
            if (item.assetState === 'LINKED_EXISTING' && !item.assetIdentifierDigest)
                throw new Error('PLAN_INVALID');
        }
    }
    return items;
}
function externalIdsAfter(asset, ids, observedAt) {
    let next = structuredClone(asset);
    for (const id of ids)
        next = addExternalId(next, id, observedAt);
    return next.externalIds ?? [];
}
const actualWriteCount = (mutations) => mutations.filter(mutation => mutation.kind !== 'PRODUCT_VERIFY_IDENTIFIERS').length;
async function acquireVehicleUidMigrationLock(options, action) {
    if (!options)
        return async () => { };
    const lockPath = join(options.directory, 'vehicle-uid-migration.lock');
    const owner = { owner: options.owner, action, createdAt: options.now };
    const create = async () => {
        const handle = await open(lockPath, 'wx');
        try {
            await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
        }
        finally {
            await handle.close();
        }
    };
    try {
        await create();
    }
    catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
            throw error;
        try {
            const existing = JSON.parse(await readFile(lockPath, 'utf8'));
            const ageMs = Date.parse(options.now) - Date.parse(existing.createdAt ?? '');
            if (!Number.isFinite(ageMs) || ageMs <= 15 * 60 * 1000)
                throw new Error('LOCK_HELD');
            await unlink(lockPath);
            await create();
        }
        catch (inner) {
            if (inner instanceof Error && inner.message === 'LOCK_HELD')
                throw inner;
            throw new Error('LOCK_HELD');
        }
    }
    let released = false;
    return async () => {
        if (released)
            return;
        released = true;
        await unlink(lockPath).catch(() => { });
    };
}
async function commitMutations(store, mutations) {
    if (mutations.length === 0)
        return { applied: 0, skipped: [] };
    if (store.commitMutations) {
        const result = await store.commitMutations(mutations);
        return result ?? { applied: actualWriteCount(mutations), skipped: [] };
    }
    for (const mutation of mutations) {
        if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
            await store.restoreAssetExternalIds(mutation.assetId, mutation.externalIds);
        }
        else if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
            await store.setProductVehicleUid(mutation.productKey, mutation.vehicleUid);
        }
        else if (mutation.kind === 'PRODUCT_DELETE_VEHICLE_UID') {
            await store.deleteProductVehicleUid(mutation.productKey);
        }
    }
    return { applied: actualWriteCount(mutations), skipped: [] };
}
const bump = (record, reason) => {
    record[reason] = (record[reason] ?? 0) + 1;
};
const withTypedUpdateTime = (updateTime) => updateTime ? { updateTime } : {};
const withExpectedAfter = (expectedAfter) => expectedAfter !== undefined ? { expectedAfter } : {};
const productVehicleUidBackupValue = (value) => typeof value === 'string' ? value : null;
const productVehicleUidPresence = (product) => !Object.hasOwn(product, 'vehicle_uid') ? 'absent' : product.vehicle_uid === null ? 'present:null' : 'present:string';
const productIdentifierDigest = (product) => stableDigest(summarizeVehicleUidMigrationIdentifiers(product));
const normalizeExternalIdsForCompare = (externalIds) => Array.isArray(externalIds)
    ? [...externalIds].sort((left, right) => stableDigest(left).localeCompare(stableDigest(right)))
    : externalIds ?? null;
const sameExternalIds = (left, right) => stableDigest(normalizeExternalIdsForCompare(left)) === stableDigest(normalizeExternalIdsForCompare(right));
export async function dryRunVehicleUidMigration(plan, expectedDigest) {
    const digest = assertVehicleUidPlanDigest(plan, expectedDigest);
    const items = mutationItems(plan);
    return {
        status: 'DRY_RUN',
        writes: 0,
        skipped: 0,
        assetUpdates: items.filter(item => item.kind === 'ASSET_ADD_EXTERNAL_IDS').length,
        productUpdates: items.filter(item => item.kind === 'PRODUCT_SET_UID').length,
        digest,
    };
}
export async function applyVehicleUidMigration(store, plan, expectedDigest, options, persistBackup) {
    const releaseLock = await acquireVehicleUidMigrationLock(options.lock, 'apply');
    try {
        const digest = assertVehicleUidPlanDigest(plan, expectedDigest);
        if (options.approvedDigest !== digest || options.writeFlag !== 'APPLY')
            throw new Error('VEHICLE_UID_APPLY_NOT_APPROVED');
        if (!persistBackup)
            throw new Error('BACKUP_REQUIRED');
        const items = mutationItems(plan);
        const backup = {
            schema: 'vehicle-uid-migration-backup/v1',
            planDigest: digest,
            createdAt: options.now,
            assets: [],
            products: [],
        };
        let writes = 0;
        let skipped = 0;
        let assetUpdates = 0;
        let productUpdates = 0;
        const mutations = [];
        const mutationsByComponent = new Map();
        const skippedReasons = {};
        const skippedTargets = new Set();
        const componentSkipReasons = new Map();
        for (const componentId of [...new Set(items.map(item => item.componentId))].sort()) {
            const componentItems = items.filter(item => item.componentId === componentId);
            const componentMutations = [];
            const componentBackupAssets = [];
            const componentBackupProducts = [];
            let componentWrites = 0;
            let componentAssetUpdates = 0;
            let componentProductUpdates = 0;
            for (const item of componentItems) {
                if (item.kind === 'ASSET_ADD_EXTERNAL_IDS') {
                    const snapshot = store.getAssetSnapshot ? await store.getAssetSnapshot(item.assetId) : null;
                    const asset = snapshot?.data ?? await store.getAsset(item.assetId);
                    if (!asset)
                        throw new Error('VEHICLE_UID_ASSET_MISSING');
                    const next = externalIdsAfter(asset, item.externalIds, plan.observedAt);
                    if (sameExternalIds(next, asset.externalIds ?? [])) {
                        skipped++;
                        continue;
                    }
                    componentBackupAssets.push({
                        componentId,
                        assetId: item.assetId,
                        ...(asset.externalIds !== undefined ? { externalIds: structuredClone(asset.externalIds) } : {}),
                        ...(snapshot?.updateTime ? { updateTime: snapshot.updateTime } : {}),
                        appliedExternalIds: structuredClone(next),
                    });
                    componentMutations.push({
                        kind: 'ASSET_EXTERNAL_IDS',
                        assetId: item.assetId,
                        externalIds: next,
                        ...withTypedUpdateTime(snapshot?.updateTime),
                        assetIdentifierDigest: item.assetIdentifierDigest,
                        observedAt: plan.observedAt,
                    });
                    componentWrites++;
                    componentAssetUpdates++;
                }
                if (item.kind === 'PRODUCT_SET_UID' || item.kind === 'PRODUCT_VERIFY_UID') {
                    const snapshot = store.getProductSnapshot ? await store.getProductSnapshot(item.productKey) : null;
                    const product = snapshot?.data ?? await store.getProduct(item.productKey);
                    if (!product)
                        throw new Error('VEHICLE_UID_PRODUCT_MISSING');
                    if (productIdentifierDigest(product) !== stableDigest(item.identifiers)) {
                        componentSkipReasons.set(componentId, 'STALE_IDENTIFIER');
                        bump(skippedReasons, 'STALE_IDENTIFIER');
                        break;
                    }
                    const current = product.vehicle_uid;
                    if (item.kind === 'PRODUCT_VERIFY_UID') {
                        if (current !== item.vehicleUid) {
                            componentSkipReasons.set(componentId, 'STALE_IDENTIFIER');
                            bump(skippedReasons, 'STALE_IDENTIFIER');
                            break;
                        }
                        componentMutations.push({
                            kind: 'PRODUCT_VERIFY_IDENTIFIERS',
                            productKey: item.productKey,
                            vehicleUid: item.vehicleUid,
                            ...withTypedUpdateTime(snapshot?.updateTime),
                            identifierDigest: stableDigest(item.identifiers),
                            ...(item.assetIdentifierDigest ? { assetIdentifierDigest: item.assetIdentifierDigest, observedAt: plan.observedAt } : {}),
                        });
                        continue;
                    }
                    if (current === item.vehicleUid) {
                        componentMutations.push({
                            kind: 'PRODUCT_VERIFY_IDENTIFIERS',
                            productKey: item.productKey,
                            vehicleUid: item.vehicleUid,
                            ...withTypedUpdateTime(snapshot?.updateTime),
                            identifierDigest: stableDigest(item.identifiers),
                            ...(item.assetIdentifierDigest ? { assetIdentifierDigest: item.assetIdentifierDigest, observedAt: plan.observedAt } : {}),
                        });
                        continue;
                    }
                    if (current !== undefined && current !== null && current !== '')
                        throw new Error('VEHICLE_UID_PRODUCT_PRECONDITION_FAILED');
                    componentBackupProducts.push({
                        componentId,
                        productKey: item.productKey,
                        hadVehicleUid: Object.hasOwn(product, 'vehicle_uid'),
                        vehicleUidPresence: productVehicleUidPresence(product),
                        hadVehicleUidRegistry: Object.hasOwn(product, 'vehicle_uid_registry'),
                        ...(Object.hasOwn(product, 'vehicle_uid_registry') ? { vehicleUidRegistry: product.vehicle_uid_registry } : {}),
                        ...(Object.hasOwn(product, 'vehicle_uid') ? { vehicleUid: productVehicleUidBackupValue(current) } : {}),
                        ...(snapshot?.updateTime ? { updateTime: snapshot.updateTime } : {}),
                        appliedVehicleUid: item.vehicleUid,
                        ...(item.assetState === 'PRODUCT_ONLY' ? { appliedVehicleUidRegistry: 'PRODUCT_ONLY' } : {}),
                    });
                    componentMutations.push({
                        kind: 'PRODUCT_VEHICLE_UID',
                        productKey: item.productKey,
                        vehicleUid: item.vehicleUid,
                        ...withTypedUpdateTime(snapshot?.updateTime),
                        assetState: item.assetState,
                        ...(item.assetState === 'PRODUCT_ONLY' ? { vehicleUidRegistry: 'PRODUCT_ONLY' } : {}),
                        ...(item.assetIdentifierDigest ? { assetIdentifierDigest: item.assetIdentifierDigest, observedAt: plan.observedAt } : {}),
                    });
                    componentWrites++;
                    componentProductUpdates++;
                }
            }
            const componentSkipReason = componentSkipReasons.get(componentId);
            if (componentSkipReason) {
                skipped += componentItems.length;
                for (const skippedItem of componentItems) {
                    if (skippedItem.kind === 'ASSET_ADD_EXTERNAL_IDS')
                        skippedTargets.add(`asset:${skippedItem.assetId}`);
                    if (skippedItem.kind === 'PRODUCT_SET_UID' || skippedItem.kind === 'PRODUCT_VERIFY_UID')
                        skippedTargets.add(`product:${skippedItem.productKey}`);
                }
                continue;
            }
            backup.assets.push(...componentBackupAssets);
            backup.products.push(...componentBackupProducts);
            mutations.push(...componentMutations);
            mutationsByComponent.set(componentId, componentMutations);
            writes += componentWrites;
            assetUpdates += componentAssetUpdates;
            productUpdates += componentProductUpdates;
        }
        const fullBackup = { ...backup, backupDigest: stableDigest(backup) };
        await persistBackup(fullBackup);
        if (writes > 0 && mutations.length === 0)
            throw new Error('VEHICLE_UID_BACKUP_WITHOUT_MUTATIONS');
        let appliedWrites = 0;
        let commitSkipped = 0;
        for (const [componentId, componentMutations] of mutationsByComponent) {
            const commit = await commitMutations(store, componentMutations);
            appliedWrites += commit.applied;
            commitSkipped += commit.skipped.length ? componentMutations.length : 0;
            for (const item of commit.skipped) {
                bump(skippedReasons, item.reason);
                for (const skippedItem of items.filter(planItem => planItem.componentId === componentId)) {
                    if (skippedItem.kind === 'ASSET_ADD_EXTERNAL_IDS')
                        skippedTargets.add(`asset:${skippedItem.assetId}`);
                    if (skippedItem.kind === 'PRODUCT_SET_UID' || skippedItem.kind === 'PRODUCT_VERIFY_UID')
                        skippedTargets.add(`product:${skippedItem.productKey}`);
                }
            }
        }
        await verifyVehicleUidMigration(store, plan, skippedTargets);
        return { status: 'APPLIED', writes: appliedWrites, skipped: skipped + commitSkipped, assetUpdates, productUpdates, digest, backup: fullBackup, skippedReasons };
    }
    finally {
        await releaseLock();
    }
}
export async function verifyVehicleUidMigration(store, plan, skippedTargets = new Set()) {
    for (const item of mutationItems(plan)) {
        if (item.kind === 'PRODUCT_SET_UID' || item.kind === 'PRODUCT_VERIFY_UID') {
            if (skippedTargets.has(`product:${item.productKey}`))
                continue;
            const product = await store.getProduct(item.productKey);
            if (product?.vehicle_uid !== item.vehicleUid)
                throw new Error('VEHICLE_UID_READBACK_PRODUCT_MISMATCH');
            if (productIdentifierDigest(product) !== stableDigest(item.identifiers))
                throw new Error('VEHICLE_UID_READBACK_PRODUCT_IDENTIFIER_MISMATCH');
        }
        if (item.kind === 'ASSET_ADD_EXTERNAL_IDS') {
            if (skippedTargets.has(`asset:${item.assetId}`))
                continue;
            const asset = await store.getAsset(item.assetId);
            if (!asset)
                throw new Error('VEHICLE_UID_READBACK_ASSET_MISSING');
            const expected = externalIdsAfter(asset, item.externalIds, plan.observedAt);
            if (!sameExternalIds(asset.externalIds ?? [], expected))
                throw new Error('VEHICLE_UID_READBACK_ASSET_MISMATCH');
        }
    }
}
export async function rollbackVehicleUidMigration(store, backup, expectedDigest, options) {
    const releaseLock = await acquireVehicleUidMigrationLock(options.lock, 'rollback');
    try {
        if (backup.planDigest !== expectedDigest || options.approvedDigest !== expectedDigest || options.writeFlag !== 'ROLLBACK') {
            throw new Error('VEHICLE_UID_ROLLBACK_NOT_APPROVED');
        }
        if (stableDigest(backupBodyForDigest(backup)) !== backup.backupDigest) {
            throw new Error('VEHICLE_UID_BACKUP_DIGEST_MISMATCH');
        }
        let writes = 0;
        let skipped = 0;
        let assetUpdates = 0;
        let productUpdates = 0;
        const mutationsByComponent = new Map();
        const skippedReasons = {};
        const addMutation = (componentId, mutation) => {
            const list = mutationsByComponent.get(componentId) ?? [];
            list.push(mutation);
            mutationsByComponent.set(componentId, list);
        };
        const rollbackProductMutation = (item) => {
            if (item.hadVehicleUid) {
                return {
                    kind: 'PRODUCT_VEHICLE_UID',
                    productKey: item.productKey,
                    vehicleUid: item.vehicleUid ?? null,
                    ...withExpectedAfter(item.appliedVehicleUid),
                    ...(item.appliedVehicleUidRegistry !== undefined ? { expectedRegistryAfter: item.appliedVehicleUidRegistry } : {}),
                    ...(item.hadVehicleUidRegistry !== undefined ? { hadVehicleUidRegistry: item.hadVehicleUidRegistry } : {}),
                    registryValue: item.vehicleUidRegistry,
                };
            }
            return {
                kind: 'PRODUCT_DELETE_VEHICLE_UID',
                productKey: item.productKey,
                ...withExpectedAfter(item.appliedVehicleUid),
                ...(item.appliedVehicleUidRegistry !== undefined ? { expectedRegistryAfter: item.appliedVehicleUidRegistry } : {}),
                ...(item.hadVehicleUidRegistry !== undefined ? { hadVehicleUidRegistry: item.hadVehicleUidRegistry } : {}),
                registryValue: item.vehicleUidRegistry,
            };
        };
        for (const item of backup.products) {
            const current = await store.getProduct(item.productKey);
            const presence = item.vehicleUidPresence ?? (item.hadVehicleUid ? item.vehicleUid === null ? 'present:null' : 'present:string' : 'absent');
            const beforeValue = presence === 'absent' ? undefined : presence === 'present:null' ? null : item.vehicleUid;
            if (item.appliedVehicleUid !== undefined && current?.vehicle_uid === beforeValue) {
                bump(skippedReasons, 'NOT_APPLIED');
                skipped++;
                continue;
            }
            addMutation(item.componentId ?? `product:${item.productKey}`, rollbackProductMutation(item));
            writes++;
            productUpdates++;
        }
        for (const item of backup.assets) {
            const current = await store.getAsset(item.assetId);
            if (item.appliedExternalIds !== undefined && sameExternalIds(current?.externalIds ?? null, item.externalIds ?? null)) {
                bump(skippedReasons, 'NOT_APPLIED');
                skipped++;
                continue;
            }
            addMutation(item.componentId ?? `asset:${item.assetId}`, { kind: 'ASSET_EXTERNAL_IDS', assetId: item.assetId, externalIds: item.externalIds, ...withExpectedAfter(item.appliedExternalIds) });
            writes++;
            assetUpdates++;
        }
        let applied = 0;
        for (const mutations of mutationsByComponent.values()) {
            const commit = await commitMutations(store, mutations);
            applied += commit.applied;
            if (commit.skipped.length)
                skipped += mutations.length;
            for (const item of commit.skipped)
                bump(skippedReasons, item.reason);
        }
        return { status: 'ROLLED_BACK', writes: applied, skipped, assetUpdates, productUpdates, digest: expectedDigest, skippedReasons };
    }
    finally {
        await releaseLock();
    }
}
