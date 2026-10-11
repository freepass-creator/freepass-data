import { describe, expect, it } from 'vitest';
import {
  applyVehicleUidMigration as applyVehicleUidMigrationRaw,
  computeVehicleUidPlanDigest,
  dryRunVehicleUidMigration,
  rollbackVehicleUidMigration,
  type VehicleUidMigrationBackup,
} from '../src/application/vehicle-uid-migration-apply.js';
import { planVehicleUidMigration, summarizeVehicleUidMigrationAssetIdentifiers, summarizeVehicleUidMigrationIdentifiers, type VehicleUidMigrationProduct } from '../src/application/vehicle-uid-migration-plan.js';
import type { VehicleAsset } from '../src/domain/catalog.js';
import type { VehicleUidMigrationUpdateTime, VehicleUidMigrationWriteStore } from '../src/ports/vehicle-uid-migration-store.js';
import { stableDigest } from '../src/shared/stable-digest.js';
// @ts-ignore local boundary script is plain ESM.
import { checkDataAccessBoundary } from '../scripts/check-data-access-boundary.mjs';

const actor = { id: 'test', kind: 'SERVICE' as const };
const meta = {
  schemaVersion: '1',
  revision: 1,
  validationStatus: 'VALID' as const,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  createdBy: actor,
  updatedBy: actor,
  lineageId: 'lin',
};
const asset = (id: string, plateNumber?: string | null, vin?: string | null): VehicleAsset => ({
  ...meta,
  id,
  vehicleModelId: `vm_${id}`,
  status: 'AVAILABLE',
  ...(plateNumber !== undefined ? { plateNumber } : {}),
  ...(vin !== undefined ? { vin } : {}),
});
const assetWithCurrentExternalIds = (id: string, plateNumber: string): VehicleAsset => ({
  ...asset(id, plateNumber),
  externalIds: [{ kind: 'PLATE', value: plateNumber, validFrom: meta.createdAt, source: 'vehicle-uid-migration-plan' }],
});
const product = (plate: string, extra: VehicleUidMigrationProduct = {}) => ({ car_number: plate, provider_company_code: 'TEST', ...extra });
const fixedClock = () => new Date('2026-10-10T00:00:00.000Z');
const random = () => 0.1;
const normalizeExternalIdsForCompare = (externalIds: unknown) =>
  Array.isArray(externalIds)
    ? [...externalIds].sort((left, right) => stableDigest(left).localeCompare(stableDigest(right)))
    : externalIds ?? null;
const sameExternalIds = (left: unknown, right: unknown) =>
  stableDigest(normalizeExternalIdsForCompare(left)) === stableDigest(normalizeExternalIdsForCompare(right));
const persistBackup = async (_backup: VehicleUidMigrationBackup) => {};
const applyVehicleUidMigration = (
  store: VehicleUidMigrationWriteStore,
  migrationPlan: ReturnType<typeof planVehicleUidMigration>,
  expectedDigest: string,
  options: { approvedDigest?: string; writeFlag?: string; now: string },
  backupWriter: (backup: VehicleUidMigrationBackup) => Promise<void> = persistBackup,
) => applyVehicleUidMigrationRaw(store, migrationPlan, expectedDigest, options, backupWriter);

function plan(products: Record<string, VehicleUidMigrationProduct>, assets = [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001', 'TEST-FAKE-VIN-001')]) {
  return planVehicleUidMigration({
    products,
    assets,
    bindings: [],
    clock: fixedClock,
    random,
    observedAt: '2026-10-10T00:00:00.000Z',
  });
}

class FakeStore implements VehicleUidMigrationWriteStore {
  writes = 0;
  assetVersions = new Map<string, VehicleUidMigrationUpdateTime>();
  productVersions = new Map<string, VehicleUidMigrationUpdateTime>();
  failAfterWrites = Number.POSITIVE_INFINITY;
  constructor(
    readonly assets: Map<string, VehicleAsset>,
    readonly products: Map<string, Record<string, unknown>>,
  ) {
    for (const key of assets.keys()) this.assetVersions.set(key, { seconds: 1, nanoseconds: 0 });
    for (const key of products.keys()) this.productVersions.set(key, { seconds: 1, nanoseconds: 0 });
  }
  async getAsset(assetId: string) {
    return this.assets.get(assetId) ? structuredClone(this.assets.get(assetId)!) : null;
  }
  async getProduct(productKey: string) {
    return this.products.get(productKey) ? structuredClone(this.products.get(productKey)!) : null;
  }
  async getAssetSnapshot(assetId: string) {
    const data = await this.getAsset(assetId);
    return data ? { data, updateTime: this.assetVersions.get(assetId)! } : null;
  }
  async getProductSnapshot(productKey: string) {
    const data = await this.getProduct(productKey);
    return data ? { data, updateTime: this.productVersions.get(productKey)! } : null;
  }
  async updateAssetExternalIds(assetId: string, externalIds: VehicleAsset['externalIds']) {
    this.writes++;
    const current = { ...this.assets.get(assetId)! };
    if (externalIds !== undefined) current.externalIds = structuredClone(externalIds);
    else delete current.externalIds;
    this.assets.set(assetId, current);
  }
  async setProductVehicleUid(productKey: string, vehicleUid: string | null) {
    this.writes++;
    this.products.set(productKey, { ...this.products.get(productKey)!, vehicle_uid: vehicleUid });
  }
  async restoreAssetExternalIds(assetId: string, externalIds: VehicleAsset['externalIds']) {
    this.writes++;
    const current = { ...this.assets.get(assetId)! };
    if (externalIds === undefined) delete current.externalIds;
    else current.externalIds = structuredClone(externalIds);
    this.assets.set(assetId, current);
  }
  async deleteProductVehicleUid(productKey: string) {
    this.writes++;
    const current = { ...this.products.get(productKey)! };
    delete current.vehicle_uid;
    this.products.set(productKey, current);
  }
  async commitMutations(mutations: Parameters<NonNullable<VehicleUidMigrationWriteStore['commitMutations']>>[0]) {
    const skipped: Array<{ target: string; reason: 'CONCURRENT_CHANGE' | 'ROLLBACK_SKIPPED_CHANGED' | 'NOT_APPLIED' | 'STALE_ASSET' | 'STALE_IDENTIFIER' }> = [];
    const sameUpdateTime = (left: VehicleUidMigrationUpdateTime | undefined, right: VehicleUidMigrationUpdateTime | undefined) =>
      left?.seconds === right?.seconds && left?.nanoseconds === right?.nanoseconds;
    const nextVersion = () => ({ seconds: 1, nanoseconds: this.writes + 1 });
    for (const mutation of mutations) {
      if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
        if (mutation.assetIdentifierDigest) {
          const currentAsset = this.assets.get(mutation.assetId);
          if (!currentAsset || !mutation.observedAt || summarizeVehicleUidMigrationAssetIdentifiers(currentAsset, mutation.observedAt) !== mutation.assetIdentifierDigest) {
            skipped.push({ target: `asset:${mutation.assetId}`, reason: 'STALE_ASSET' });
            break;
          }
        }
        if (mutation.updateTime && !sameUpdateTime(this.assetVersions.get(mutation.assetId), mutation.updateTime)) {
          skipped.push({ target: `asset:${mutation.assetId}`, reason: 'CONCURRENT_CHANGE' });
          break;
        }
        if (mutation.expectedAfter !== undefined && !sameExternalIds(this.assets.get(mutation.assetId)?.externalIds ?? null, mutation.expectedAfter ?? null)) {
          skipped.push({ target: `asset:${mutation.assetId}`, reason: 'ROLLBACK_SKIPPED_CHANGED' });
          break;
        }
      } else if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
        if (mutation.assetIdentifierDigest) {
          const currentAsset = this.assets.get(mutation.vehicleUid ?? '');
          if (!currentAsset || !mutation.observedAt || summarizeVehicleUidMigrationAssetIdentifiers(currentAsset, mutation.observedAt) !== mutation.assetIdentifierDigest) {
            skipped.push({ target: `product:${mutation.productKey}`, reason: 'STALE_ASSET' });
            break;
          }
        }
        if (mutation.updateTime && !sameUpdateTime(this.productVersions.get(mutation.productKey), mutation.updateTime)) {
          skipped.push({ target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' });
          break;
        }
        if (mutation.expectedAfter !== undefined && this.products.get(mutation.productKey)?.vehicle_uid !== mutation.expectedAfter) {
          skipped.push({ target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' });
          break;
        }
      } else if (mutation.kind === 'PRODUCT_VERIFY_IDENTIFIERS') {
        const currentProduct = this.products.get(mutation.productKey);
        if (mutation.assetIdentifierDigest) {
          const currentAsset = this.assets.get(mutation.vehicleUid);
          if (!currentAsset || !mutation.observedAt || summarizeVehicleUidMigrationAssetIdentifiers(currentAsset, mutation.observedAt) !== mutation.assetIdentifierDigest) {
            skipped.push({ target: `product:${mutation.productKey}`, reason: 'STALE_ASSET' });
            break;
          }
        }
        if (mutation.updateTime && !sameUpdateTime(this.productVersions.get(mutation.productKey), mutation.updateTime)) {
          skipped.push({ target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' });
          break;
        }
        if (currentProduct?.vehicle_uid !== mutation.vehicleUid || stableDigest(summarizeVehicleUidMigrationIdentifiers(currentProduct ?? {})) !== mutation.identifierDigest) {
          skipped.push({ target: `product:${mutation.productKey}`, reason: 'STALE_IDENTIFIER' });
          break;
        }
      } else {
        if (mutation.updateTime && !sameUpdateTime(this.productVersions.get(mutation.productKey), mutation.updateTime)) {
          skipped.push({ target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' });
          break;
        }
        if (mutation.expectedAfter !== undefined && this.products.get(mutation.productKey)?.vehicle_uid !== mutation.expectedAfter) {
          skipped.push({ target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' });
          break;
        }
      }
    }
    if (skipped.length) return { applied: 0, skipped };
    let applied = 0;
    for (const mutation of mutations) {
      if (applied >= this.failAfterWrites) throw new Error('TEST_FAKE_MID_BATCH_FAILURE');
      if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
        await this.restoreAssetExternalIds(mutation.assetId, mutation.externalIds);
        this.assetVersions.set(mutation.assetId, nextVersion());
      } else if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
        await this.setProductVehicleUid(mutation.productKey, mutation.vehicleUid);
        this.productVersions.set(mutation.productKey, nextVersion());
      } else if (mutation.kind === 'PRODUCT_VERIFY_IDENTIFIERS') {
        this.productVersions.set(mutation.productKey, nextVersion());
      } else {
        await this.deleteProductVehicleUid(mutation.productKey);
        this.productVersions.set(mutation.productKey, nextVersion());
      }
      applied++;
    }
    return { applied, skipped };
  }
}

class ReadBeforeWriteFakeStore extends FakeStore {
  async commitMutations(mutations: Parameters<NonNullable<VehicleUidMigrationWriteStore['commitMutations']>>[0]) {
    let wrote = false;
    const read = () => {
      if (wrote) throw new Error('TEST_FAKE_READ_AFTER_WRITE');
    };
    const write = () => {
      wrote = true;
    };
    for (const mutation of mutations) {
      read();
      if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
        if (!this.assets.has(mutation.assetId)) return { applied: 0, skipped: [{ target: `asset:${mutation.assetId}`, reason: 'CONCURRENT_CHANGE' as const }] };
      } else if (!this.products.has(mutation.productKey)) {
        return { applied: 0, skipped: [{ target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' as const }] };
      }
    }
    for (const mutation of mutations) {
      write();
      if (mutation.kind === 'ASSET_EXTERNAL_IDS') await this.restoreAssetExternalIds(mutation.assetId, mutation.externalIds);
      else if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
        await this.setProductVehicleUid(mutation.productKey, mutation.vehicleUid);
      } else if (mutation.kind === 'PRODUCT_VERIFY_IDENTIFIERS') {
        continue;
      } else {
        await this.deleteProductVehicleUid(mutation.productKey);
      }
    }
    return { applied: mutations.length, skipped: [] };
  }
}

const fakeStore = (p = plan({ p1: product('TEST-FAKE-001') })) => new FakeStore(
  new Map([['TEST-FAKE-UID-001', asset('TEST-FAKE-UID-001', 'TEST-FAKE-001', 'TEST-FAKE-VIN-001')]]),
  new Map(Object.entries(p.summary.totalProducts ? { p1: product('TEST-FAKE-001') } : {})),
);

describe('applyVehicleUidMigration', () => {
  it('dry-runs with zero writes and reports digest counts', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const result = await dryRunVehicleUidMigration(p, p.planDigest);
    expect(result).toEqual(expect.objectContaining({ status: 'DRY_RUN', writes: 0, digest: p.planDigest }));
    expect(result.assetUpdates).toBeGreaterThan(0);
    expect(result.productUpdates).toBe(1);
  });

  it('rejects apply without both approvals', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    await expect(applyVehicleUidMigration(fakeStore(p), p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest }))
      .rejects.toThrow('VEHICLE_UID_APPLY_NOT_APPROVED');
  });

  it('rejects digest mismatch', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    await expect(dryRunVehicleUidMigration(p, 'bad')).rejects.toThrow('VEHICLE_UID_PLAN_DIGEST_MISMATCH');
  });

  it('applies idempotently and excludes HOLD items', async () => {
    const p = plan({ p1: product('TEST-FAKE-001'), 'RP023_TEST-FAKE-002': product('TEST-FAKE-002') });
    const store = fakeStore(p);
    store.products.set('RP023_TEST-FAKE-002', product('TEST-FAKE-002'));
    const first = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    const second = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    expect(first.status).toBe('APPLIED');
    expect(second.writes).toBe(0);
    expect(store.products.get('RP023_TEST-FAKE-002')!.vehicle_uid).toBeUndefined();
  });

  it('stores backup before writes and refuses to write when backup persistence fails', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = fakeStore(p);
    await expect(applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' }, async () => {
      throw new Error('TEST_FAKE_BACKUP_WRITE_FAILED');
    })).rejects.toThrow('TEST_FAKE_BACKUP_WRITE_FAILED');
    expect(store.writes).toBe(0);
  });

  it('rejects write mode without a backup callback before any write', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = fakeStore(p);
    await expect(applyVehicleUidMigrationRaw(
      store,
      p,
      p.planDigest,
      { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' },
      undefined as never,
    )).rejects.toThrow('BACKUP_REQUIRED');
    expect(store.writes).toBe(0);
  });

  it('keeps the backup available when a later write fails', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = fakeStore(p);
    store.failAfterWrites = 1;
    let backupWritten = false;
    await expect(applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' }, async (backup) => {
      backupWritten = Boolean(backup.backupDigest);
    })).rejects.toThrow('TEST_FAKE_MID_BATCH_FAILURE');
    expect(backupWritten).toBe(true);
  });

  it('skips stale product identifiers before writing that product', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = fakeStore(p);
    store.products.set('p1', product('TEST-FAKE-CHANGED'));
    const result = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    expect(result.skippedReasons?.STALE_IDENTIFIER).toBe(1);
    expect(store.products.get('p1')!.vehicle_uid).toBeUndefined();
  });

  it('skips the whole component when stale identifiers would otherwise leave asset externalIds behind', async () => {
    const p = plan({ p1: product('TEST-FAKE-001', { vin: 'TEST-FAKE-VIN-NEW' }) }, [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')]);
    const store = new FakeStore(
      new Map([['TEST-FAKE-UID-001', asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')]]),
      new Map([['p1', product('TEST-FAKE-001', { vin: 'TEST-FAKE-VIN-NEW' })]]),
    );
    store.products.set('p1', product('TEST-FAKE-001', { vin: 'TEST-FAKE-VIN-CHANGED' }));
    const result = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    expect(result.skippedReasons?.STALE_IDENTIFIER).toBe(1);
    expect(store.products.get('p1')!.vehicle_uid).toBeUndefined();
    expect(store.assets.get('TEST-FAKE-UID-001')!.externalIds).toBeUndefined();
  });

  it('skips PRODUCT_SET_UID as STALE_ASSET when the planned existing asset was deleted before apply', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') }, [assetWithCurrentExternalIds('TEST-FAKE-UID-001', 'TEST-FAKE-001')]);
    const store = new FakeStore(
      new Map([['TEST-FAKE-UID-001', assetWithCurrentExternalIds('TEST-FAKE-UID-001', 'TEST-FAKE-001')]]),
      new Map([['p1', product('TEST-FAKE-001')]]),
    );
    store.assets.delete('TEST-FAKE-UID-001');
    const result = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    expect(result.skippedReasons?.STALE_ASSET).toBe(1);
    expect(store.products.get('p1')!.vehicle_uid).toBeUndefined();
  });

  it('skips PRODUCT_SET_UID as STALE_ASSET when the planned existing asset identifiers changed before apply', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') }, [assetWithCurrentExternalIds('TEST-FAKE-UID-001', 'TEST-FAKE-001')]);
    const store = new FakeStore(
      new Map([['TEST-FAKE-UID-001', assetWithCurrentExternalIds('TEST-FAKE-UID-001', 'TEST-FAKE-001')]]),
      new Map([['p1', product('TEST-FAKE-001')]]),
    );
    store.assets.set('TEST-FAKE-UID-001', assetWithCurrentExternalIds('TEST-FAKE-UID-001', 'TEST-FAKE-CHANGED'));
    const result = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    expect(result.skippedReasons?.STALE_ASSET).toBe(1);
    expect(store.products.get('p1')!.vehicle_uid).toBeUndefined();
  });

  it('skips concurrent changes instead of overwriting them', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = fakeStore(p);
    const result = await applyVehicleUidMigration(
      store,
      p,
      p.planDigest,
      { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' },
      async () => { store.productVersions.set('p1', { seconds: 1, nanoseconds: 1 }); },
    );
    expect(result.skippedReasons?.CONCURRENT_CHANGE).toBeGreaterThan(0);
    expect(store.products.get('p1')!.vehicle_uid).toBeUndefined();
  });

  it('treats an updateTime nanosecond-only change as CONCURRENT_CHANGE and skips the component', async () => {
    const p = plan({ p1: product('TEST-FAKE-001', { vin: 'TEST-FAKE-VIN-NEW' }) }, [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')]);
    const store = new FakeStore(
      new Map([['TEST-FAKE-UID-001', asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')]]),
      new Map([['p1', product('TEST-FAKE-001', { vin: 'TEST-FAKE-VIN-NEW' })]]),
    );
    const result = await applyVehicleUidMigration(
      store,
      p,
      p.planDigest,
      { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' },
      async () => { store.productVersions.set('p1', { seconds: 1, nanoseconds: 500 }); },
    );
    expect(result.skippedReasons?.CONCURRENT_CHANGE).toBe(1);
    expect(store.products.get('p1')!.vehicle_uid).toBeUndefined();
    expect(store.assets.get('TEST-FAKE-UID-001')!.externalIds).toBeUndefined();
  });

  it('stops when a product has a conflicting vehicle_uid precondition', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = fakeStore(p);
    store.products.set('p1', product('TEST-FAKE-001', { vehicle_uid: 'TEST-FAKE-OTHER' }));
    await expect(applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' }))
      .rejects.toThrow('VEHICLE_UID_PRODUCT_PRECONDITION_FAILED');
  });

  it('rolls back product uid and asset externalIds from backup', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = fakeStore(p);
    const applied = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    expect(applied.backup).toBeDefined();
    const rolledBack = await rollbackVehicleUidMigration(store, applied.backup!, p.planDigest, { approvedDigest: p.planDigest, writeFlag: 'ROLLBACK' });
    expect(rolledBack.status).toBe('ROLLED_BACK');
    expect(store.products.get('p1')!.vehicle_uid).toBeUndefined();
    expect(store.assets.get('TEST-FAKE-UID-001')!.externalIds).toBeUndefined();
  });

  it('rolls back missing vehicle_uid fields by deleting the field and preserves original string values', async () => {
    const p = plan({ p1: product('TEST-FAKE-001'), p2: product('TEST-FAKE-002') }, [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001'), asset('TEST-FAKE-UID-002', 'TEST-FAKE-002')]);
    const store = new FakeStore(
      new Map([['TEST-FAKE-UID-001', asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')], ['TEST-FAKE-UID-002', asset('TEST-FAKE-UID-002', 'TEST-FAKE-002')]]),
      new Map<string, Record<string, unknown>>([['p1', product('TEST-FAKE-001')], ['p2', { ...product('TEST-FAKE-002'), vehicle_uid: null }]]),
    );
    const applied = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    expect(applied.backup!.products.find(item => item.productKey === 'p1')?.vehicleUidPresence).toBe('absent');
    expect(applied.backup!.products.find(item => item.productKey === 'p2')?.vehicleUidPresence).toBe('present:null');
    const stringBackup = structuredClone(applied.backup!);
    stringBackup.products.push({ productKey: 'p3', hadVehicleUid: true, vehicleUid: 'TEST-FAKE-ORIGINAL', appliedVehicleUid: 'TEST-FAKE-APPLIED' });
    const { backupDigest: _backupDigest, ...backupBody } = stringBackup;
    stringBackup.backupDigest = stableDigest(backupBody);
    store.products.set('p3', { ...product('TEST-FAKE-003'), vehicle_uid: 'TEST-FAKE-APPLIED' });
    await rollbackVehicleUidMigration(store, stringBackup, p.planDigest, { approvedDigest: p.planDigest, writeFlag: 'ROLLBACK' });
    expect(Object.hasOwn(store.products.get('p1')!, 'vehicle_uid')).toBe(false);
    expect(store.products.get('p2')!.vehicle_uid).toBeNull();
    expect(store.products.get('p3')!.vehicle_uid).toBe('TEST-FAKE-ORIGINAL');
  });

  it('reports NOT_APPLIED when the original vehicle_uid was explicit null and remains null', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = new FakeStore(
      new Map([['TEST-FAKE-UID-001', asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')]]),
      new Map<string, Record<string, unknown>>([['p1', { ...product('TEST-FAKE-001'), vehicle_uid: null }]]),
    );
    const applied = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    store.products.set('p1', { ...product('TEST-FAKE-001'), vehicle_uid: null });
    const rolledBack = await rollbackVehicleUidMigration(store, applied.backup!, p.planDigest, { approvedDigest: p.planDigest, writeFlag: 'ROLLBACK' });
    expect(rolledBack.skippedReasons?.NOT_APPLIED).toBeGreaterThanOrEqual(1);
    expect(store.products.get('p1')!.vehicle_uid).toBeNull();
  });

  it('keeps rollback transactions read-before-write with an adapter that throws on read after write', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = new ReadBeforeWriteFakeStore(
      new Map([['TEST-FAKE-UID-001', asset('TEST-FAKE-UID-001', 'TEST-FAKE-001', 'TEST-FAKE-VIN-001')]]),
      new Map([['p1', product('TEST-FAKE-001')]]),
    );
    const applied = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    await expect(rollbackVehicleUidMigration(store, applied.backup!, p.planDigest, { approvedDigest: p.planDigest, writeFlag: 'ROLLBACK' }))
      .resolves.toEqual(expect.objectContaining({ status: 'ROLLED_BACK' }));
  });

  it('rolls back applied components and reports NOT_APPLIED for backup entries whose current value is still before-state', async () => {
    const p = plan(
      { p1: product('TEST-FAKE-001'), p2: product('TEST-FAKE-002') },
      [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001'), asset('TEST-FAKE-UID-002', 'TEST-FAKE-002')],
    );
    const store = new FakeStore(
      new Map([['TEST-FAKE-UID-001', asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')], ['TEST-FAKE-UID-002', asset('TEST-FAKE-UID-002', 'TEST-FAKE-002')]]),
      new Map<string, Record<string, unknown>>([['p1', product('TEST-FAKE-001')], ['p2', product('TEST-FAKE-002')]]),
    );
    const applied = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    store.products.set('p2', product('TEST-FAKE-002'));
    store.assets.set('TEST-FAKE-UID-002', asset('TEST-FAKE-UID-002', 'TEST-FAKE-002'));
    const rolledBack = await rollbackVehicleUidMigration(store, applied.backup!, p.planDigest, { approvedDigest: p.planDigest, writeFlag: 'ROLLBACK' });
    expect(store.products.get('p1')!.vehicle_uid).toBeUndefined();
    expect(store.assets.get('TEST-FAKE-UID-001')!.externalIds).toBeUndefined();
    expect(store.products.get('p2')!.vehicle_uid).toBeUndefined();
    expect(store.assets.get('TEST-FAKE-UID-002')!.externalIds).toBeUndefined();
    expect(rolledBack.skippedReasons?.NOT_APPLIED).toBe(2);
    expect(rolledBack.skippedReasons?.ROLLBACK_SKIPPED_CHANGED).toBeUndefined();
  });

  it('does not rollback over a post-apply product change', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = fakeStore(p);
    const applied = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    store.products.set('p1', { ...store.products.get('p1')!, vehicle_uid: 'TEST-FAKE-NORMAL-CHANGE' });
    const rolledBack = await rollbackVehicleUidMigration(store, applied.backup!, p.planDigest, { approvedDigest: p.planDigest, writeFlag: 'ROLLBACK' });
    expect(rolledBack.skippedReasons?.ROLLBACK_SKIPPED_CHANGED).toBe(1);
    expect(store.products.get('p1')!.vehicle_uid).toBe('TEST-FAKE-NORMAL-CHANGE');
  });

  it('rejects rollback when backup digest changed', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = fakeStore(p);
    const applied = await applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    const tampered = { ...applied.backup!, products: [] };
    await expect(rollbackVehicleUidMigration(store, tampered, p.planDigest, { approvedDigest: p.planDigest, writeFlag: 'ROLLBACK' }))
      .rejects.toThrow('VEHICLE_UID_BACKUP_DIGEST_MISMATCH');
  });

  it('fails readback when persisted asset externalIds do not match the plan', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = fakeStore(p);
    store.restoreAssetExternalIds = async (assetId) => {
      store.writes++;
      store.assets.set(assetId, { ...store.assets.get(assetId)!, externalIds: [] });
    };
    await expect(applyVehicleUidMigration(store, p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' }))
      .rejects.toThrow('VEHICLE_UID_READBACK_ASSET_MISMATCH');
  });

  it('rejects apply when oneActivePlatePerUid is false', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const badPlan = { ...p, summary: { ...p.summary, invariants: { ...p.summary.invariants, oneActivePlatePerUid: false } } };
    badPlan.planDigest = computeVehicleUidPlanDigest(badPlan);
    await expect(dryRunVehicleUidMigration(badPlan, badPlan.planDigest)).rejects.toThrow('VEHICLE_UID_ONE_ACTIVE_PLATE_INVARIANT_FALSE');
  });

  it('keeps FieldValue.delete exceptions limited to reviewed rollback writer calls', () => {
    const fake = `${process.cwd()}/src/infra/TEST-FAKE-field-delete.ts`;
    const violations = checkDataAccessBoundary(process.cwd(), [{
      file: fake,
      text: "import { FieldValue } from 'firebase-admin/firestore';\nexport const patch = { vehicle_uid: FieldValue.delete() };\n",
    }]);
    expect(violations.some((item: { file: string; import: string }) => item.file.endsWith('TEST-FAKE-field-delete.ts') && item.import.includes('FieldValue.delete()'))).toBe(true);
  });
});
