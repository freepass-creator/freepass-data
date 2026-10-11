import type { VehicleAsset, VehicleExternalId } from '../domain/catalog.js';
import { addExternalId } from '../domain/vehicle-uid.js';
import type { VehicleUidMigrationStoreMutation, VehicleUidMigrationUpdateTime, VehicleUidMigrationWriteStore } from '../ports/vehicle-uid-migration-store.js';
import { stableDigest } from '../shared/stable-digest.js';
import {
  summarizeVehicleUidMigrationIdentifiers,
  type VehicleUidMigrationItem,
  type VehicleUidMigrationPlan,
} from './vehicle-uid-migration-plan.js';

export type VehicleUidMigrationBackup = {
  schema: 'vehicle-uid-migration-backup/v1';
  planDigest: string;
  createdAt: string;
  assets: Array<{ componentId?: string; assetId: string; externalIds?: VehicleExternalId[]; updateTime?: VehicleUidMigrationUpdateTime; appliedExternalIds?: VehicleExternalId[] }>;
  products: Array<{ componentId?: string; productKey: string; hadVehicleUid: boolean; vehicleUid?: string | null; updateTime?: VehicleUidMigrationUpdateTime; appliedVehicleUid?: string }>;
  backupDigest: string;
};

export type VehicleUidMigrationApplyResult = {
  status: 'DRY_RUN' | 'APPLIED' | 'ROLLED_BACK';
  writes: number;
  skipped: number;
  assetUpdates: number;
  productUpdates: number;
  digest: string;
  backup?: VehicleUidMigrationBackup;
  skippedReasons?: Record<string, number>;
};

const bodyForDigest = (plan: VehicleUidMigrationPlan) => {
  const { planDigest: _planDigest, ...body } = plan;
  return body;
};

const backupBodyForDigest = (backup: VehicleUidMigrationBackup) => {
  const { backupDigest: _backupDigest, ...body } = backup;
  return body;
};

export function computeVehicleUidPlanDigest(plan: VehicleUidMigrationPlan) {
  return stableDigest(bodyForDigest(plan));
}

export function assertVehicleUidPlanDigest(plan: VehicleUidMigrationPlan, expectedDigest: string) {
  const actual = computeVehicleUidPlanDigest(plan);
  if (plan.planDigest !== expectedDigest || actual !== expectedDigest) {
    throw new Error('VEHICLE_UID_PLAN_DIGEST_MISMATCH');
  }
  return actual;
}

function mutationItems(plan: VehicleUidMigrationPlan) {
  if (!plan.summary.invariants.oneActivePlatePerUid) throw new Error('VEHICLE_UID_ONE_ACTIVE_PLATE_INVARIANT_FALSE');
  return plan.items.filter((item): item is Exclude<VehicleUidMigrationItem, { kind: 'HOLD' }> => item.kind !== 'HOLD');
}

function externalIdsAfter(asset: VehicleAsset, ids: VehicleExternalId[], observedAt: string) {
  let next = structuredClone(asset);
  for (const id of ids) next = addExternalId(next, id, observedAt);
  return next.externalIds ?? [];
}

async function commitMutations(store: VehicleUidMigrationWriteStore, mutations: VehicleUidMigrationStoreMutation[]) {
  if (mutations.length === 0) return { applied: 0, skipped: [] };
  if (store.commitMutations) {
    const result = await store.commitMutations(mutations);
    return result ?? { applied: mutations.length, skipped: [] };
  }
  for (const mutation of mutations) {
    if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
      await store.restoreAssetExternalIds(mutation.assetId, mutation.externalIds);
    } else if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
      await store.setProductVehicleUid(mutation.productKey, mutation.vehicleUid);
    } else {
      await store.deleteProductVehicleUid(mutation.productKey);
    }
  }
  return { applied: mutations.length, skipped: [] };
}

const bump = (record: Record<string, number>, reason: string) => {
  record[reason] = (record[reason] ?? 0) + 1;
};

const withTypedUpdateTime = (updateTime?: VehicleUidMigrationUpdateTime) => updateTime ? { updateTime } : {};
const withExpectedAfter = <T>(expectedAfter: T | undefined) => expectedAfter !== undefined ? { expectedAfter } : {};
const productVehicleUidBackupValue = (value: unknown): string | null => typeof value === 'string' ? value : null;
const sameDigest = (left: unknown, right: unknown) => stableDigest(left) === stableDigest(right);

export async function dryRunVehicleUidMigration(plan: VehicleUidMigrationPlan, expectedDigest: string): Promise<VehicleUidMigrationApplyResult> {
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

export async function applyVehicleUidMigration(
  store: VehicleUidMigrationWriteStore,
  plan: VehicleUidMigrationPlan,
  expectedDigest: string,
  options: { approvedDigest?: string; writeFlag?: string; now: string },
  persistBackup: (backup: VehicleUidMigrationBackup) => Promise<void> = async () => {},
): Promise<VehicleUidMigrationApplyResult> {
  const digest = assertVehicleUidPlanDigest(plan, expectedDigest);
  if (options.approvedDigest !== digest || options.writeFlag !== 'APPLY') throw new Error('VEHICLE_UID_APPLY_NOT_APPROVED');
  const items = mutationItems(plan);
  const backup: Omit<VehicleUidMigrationBackup, 'backupDigest'> = {
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
  const mutations: VehicleUidMigrationStoreMutation[] = [];
  const mutationsByComponent = new Map<string, VehicleUidMigrationStoreMutation[]>();
  const skippedReasons: Record<string, number> = {};
  const skippedTargets = new Set<string>();
  const componentSkipReasons = new Map<string, string>();

  for (const componentId of [...new Set(items.map(item => item.componentId))].sort()) {
    const componentItems = items.filter(item => item.componentId === componentId);
    const componentMutations: VehicleUidMigrationStoreMutation[] = [];
    const componentBackupAssets: typeof backup.assets = [];
    const componentBackupProducts: typeof backup.products = [];
    let componentWrites = 0;
    let componentAssetUpdates = 0;
    let componentProductUpdates = 0;
    for (const item of componentItems) {
      if (item.kind === 'ASSET_ADD_EXTERNAL_IDS') {
        const snapshot = store.getAssetSnapshot ? await store.getAssetSnapshot(item.assetId) : null;
        const asset = snapshot?.data ?? await store.getAsset(item.assetId);
        if (!asset) throw new Error('VEHICLE_UID_ASSET_MISSING');
        const next = externalIdsAfter(asset, item.externalIds, plan.observedAt);
        if (stableDigest(next) === stableDigest(asset.externalIds ?? [])) {
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
      if (item.kind === 'PRODUCT_SET_UID') {
        const snapshot = store.getProductSnapshot ? await store.getProductSnapshot(item.productKey) : null;
        const product = snapshot?.data ?? await store.getProduct(item.productKey);
        if (!product) throw new Error('VEHICLE_UID_PRODUCT_MISSING');
        if (stableDigest(summarizeVehicleUidMigrationIdentifiers(product)) !== stableDigest(item.identifiers)) {
          componentSkipReasons.set(componentId, 'STALE_IDENTIFIER');
          bump(skippedReasons, 'STALE_IDENTIFIER');
          break;
        }
        const current = product.vehicle_uid;
        if (current === item.vehicleUid) {
          skipped++;
          continue;
        }
        if (current !== undefined && current !== null && current !== '') throw new Error('VEHICLE_UID_PRODUCT_PRECONDITION_FAILED');
        componentBackupProducts.push({
          componentId,
          productKey: item.productKey,
          hadVehicleUid: Object.hasOwn(product, 'vehicle_uid'),
          ...(Object.hasOwn(product, 'vehicle_uid') ? { vehicleUid: productVehicleUidBackupValue(current) } : {}),
          ...(snapshot?.updateTime ? { updateTime: snapshot.updateTime } : {}),
          appliedVehicleUid: item.vehicleUid,
        });
        componentMutations.push({
          kind: 'PRODUCT_VEHICLE_UID',
          productKey: item.productKey,
          vehicleUid: item.vehicleUid,
          ...withTypedUpdateTime(snapshot?.updateTime),
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
        if (skippedItem.kind === 'ASSET_ADD_EXTERNAL_IDS') skippedTargets.add(`asset:${skippedItem.assetId}`);
        if (skippedItem.kind === 'PRODUCT_SET_UID') skippedTargets.add(`product:${skippedItem.productKey}`);
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
  if (writes > 0 && mutations.length === 0) throw new Error('VEHICLE_UID_BACKUP_WITHOUT_MUTATIONS');
  let appliedWrites = 0;
  let commitSkipped = 0;
  for (const [componentId, componentMutations] of mutationsByComponent) {
    const commit = await commitMutations(store, componentMutations);
    appliedWrites += commit.applied;
    commitSkipped += commit.skipped.length ? componentMutations.length : 0;
    for (const item of commit.skipped) {
      bump(skippedReasons, item.reason);
      for (const skippedItem of items.filter(planItem => planItem.componentId === componentId)) {
        if (skippedItem.kind === 'ASSET_ADD_EXTERNAL_IDS') skippedTargets.add(`asset:${skippedItem.assetId}`);
        if (skippedItem.kind === 'PRODUCT_SET_UID') skippedTargets.add(`product:${skippedItem.productKey}`);
      }
    }
  }
  await verifyVehicleUidMigration(store, plan, skippedTargets);
  return { status: 'APPLIED', writes: appliedWrites, skipped: skipped + commitSkipped, assetUpdates, productUpdates, digest, backup: fullBackup, skippedReasons };
}

export async function verifyVehicleUidMigration(store: VehicleUidMigrationWriteStore, plan: VehicleUidMigrationPlan, skippedTargets = new Set<string>()) {
  for (const item of mutationItems(plan)) {
    if (item.kind === 'PRODUCT_SET_UID') {
      if (skippedTargets.has(`product:${item.productKey}`)) continue;
      const product = await store.getProduct(item.productKey);
      if (product?.vehicle_uid !== item.vehicleUid) throw new Error('VEHICLE_UID_READBACK_PRODUCT_MISMATCH');
    }
    if (item.kind === 'ASSET_ADD_EXTERNAL_IDS') {
      if (skippedTargets.has(`asset:${item.assetId}`)) continue;
      const asset = await store.getAsset(item.assetId);
      if (!asset) throw new Error('VEHICLE_UID_READBACK_ASSET_MISSING');
      const expected = externalIdsAfter(asset, item.externalIds, plan.observedAt);
      if (stableDigest(asset.externalIds ?? []) !== stableDigest(expected)) throw new Error('VEHICLE_UID_READBACK_ASSET_MISMATCH');
    }
  }
}

export async function rollbackVehicleUidMigration(
  store: VehicleUidMigrationWriteStore,
  backup: VehicleUidMigrationBackup,
  expectedDigest: string,
  options: { approvedDigest?: string; writeFlag?: string },
): Promise<VehicleUidMigrationApplyResult> {
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
  const mutationsByComponent = new Map<string, VehicleUidMigrationStoreMutation[]>();
  const skippedReasons: Record<string, number> = {};
  const addMutation = (componentId: string, mutation: VehicleUidMigrationStoreMutation) => {
    const list = mutationsByComponent.get(componentId) ?? [];
    list.push(mutation);
    mutationsByComponent.set(componentId, list);
  };
  for (const item of backup.products) {
    const current = await store.getProduct(item.productKey);
    const beforeValue = item.hadVehicleUid ? item.vehicleUid ?? undefined : undefined;
    if (item.appliedVehicleUid !== undefined && current?.vehicle_uid === beforeValue) {
      bump(skippedReasons, 'NOT_APPLIED');
      skipped++;
      continue;
    }
    addMutation(item.componentId ?? `product:${item.productKey}`, item.hadVehicleUid
      ? { kind: 'PRODUCT_VEHICLE_UID', productKey: item.productKey, vehicleUid: item.vehicleUid ?? null, ...withExpectedAfter(item.appliedVehicleUid) }
      : { kind: 'PRODUCT_DELETE_VEHICLE_UID', productKey: item.productKey, ...withExpectedAfter(item.appliedVehicleUid) });
    writes++;
    productUpdates++;
  }
  for (const item of backup.assets) {
    const current = await store.getAsset(item.assetId);
    if (item.appliedExternalIds !== undefined && sameDigest(current?.externalIds ?? null, item.externalIds ?? null)) {
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
    if (commit.skipped.length) skipped += mutations.length;
    for (const item of commit.skipped) bump(skippedReasons, item.reason);
  }
  return { status: 'ROLLED_BACK', writes: applied, skipped, assetUpdates, productUpdates, digest: expectedDigest, skippedReasons };
}
