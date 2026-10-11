import { describe, expect, it } from 'vitest';
import {
  applyVehicleUidMigration,
  computeVehicleUidPlanDigest,
  dryRunVehicleUidMigration,
  rollbackVehicleUidMigration,
} from '../src/application/vehicle-uid-migration-apply.js';
import { planVehicleUidMigration, type VehicleUidMigrationProduct } from '../src/application/vehicle-uid-migration-plan.js';
import type { VehicleAsset } from '../src/domain/catalog.js';
import type { VehicleUidMigrationWriteStore } from '../src/ports/vehicle-uid-migration-store.js';
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
const product = (plate: string, extra: VehicleUidMigrationProduct = {}) => ({ car_number: plate, provider_company_code: 'TEST', ...extra });
const fixedClock = () => new Date('2026-10-10T00:00:00.000Z');
const random = () => 0.1;

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
  assetVersions = new Map<string, string>();
  productVersions = new Map<string, string>();
  failAfterWrites = Number.POSITIVE_INFINITY;
  constructor(
    readonly assets: Map<string, VehicleAsset>,
    readonly products: Map<string, Record<string, unknown>>,
  ) {
    for (const key of assets.keys()) this.assetVersions.set(key, 'v1');
    for (const key of products.keys()) this.productVersions.set(key, 'v1');
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
  async setProductVehicleUid(productKey: string, vehicleUid: string) {
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
    let applied = 0;
    const skipped: Array<{ target: string; reason: 'CONCURRENT_CHANGE' | 'ROLLBACK_SKIPPED_CHANGED' }> = [];
    for (const mutation of mutations) {
      if (applied >= this.failAfterWrites) throw new Error('TEST_FAKE_MID_BATCH_FAILURE');
      if (mutation.kind === 'ASSET_EXTERNAL_IDS') {
        if (mutation.updateTime && this.assetVersions.get(mutation.assetId) !== mutation.updateTime) {
          skipped.push({ target: `asset:${mutation.assetId}`, reason: 'CONCURRENT_CHANGE' });
          continue;
        }
        if (mutation.expectedAfter !== undefined && JSON.stringify(this.assets.get(mutation.assetId)?.externalIds ?? null) !== JSON.stringify(mutation.expectedAfter ?? null)) {
          skipped.push({ target: `asset:${mutation.assetId}`, reason: 'ROLLBACK_SKIPPED_CHANGED' });
          continue;
        }
        await this.restoreAssetExternalIds(mutation.assetId, mutation.externalIds);
        this.assetVersions.set(mutation.assetId, `v${this.writes + 1}`);
      } else if (mutation.kind === 'PRODUCT_VEHICLE_UID') {
        if (mutation.updateTime && this.productVersions.get(mutation.productKey) !== mutation.updateTime) {
          skipped.push({ target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' });
          continue;
        }
        if (mutation.expectedAfter !== undefined && this.products.get(mutation.productKey)?.vehicle_uid !== mutation.expectedAfter) {
          skipped.push({ target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' });
          continue;
        }
        await this.setProductVehicleUid(mutation.productKey, mutation.vehicleUid);
        this.productVersions.set(mutation.productKey, `v${this.writes + 1}`);
      } else {
        if (mutation.updateTime && this.productVersions.get(mutation.productKey) !== mutation.updateTime) {
          skipped.push({ target: `product:${mutation.productKey}`, reason: 'CONCURRENT_CHANGE' });
          continue;
        }
        if (mutation.expectedAfter !== undefined && this.products.get(mutation.productKey)?.vehicle_uid !== mutation.expectedAfter) {
          skipped.push({ target: `product:${mutation.productKey}`, reason: 'ROLLBACK_SKIPPED_CHANGED' });
          continue;
        }
        await this.deleteProductVehicleUid(mutation.productKey);
        this.productVersions.set(mutation.productKey, `v${this.writes + 1}`);
      }
      applied++;
    }
    return { applied, skipped };
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

  it('skips concurrent changes instead of overwriting them', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') });
    const store = fakeStore(p);
    const result = await applyVehicleUidMigration(
      store,
      p,
      p.planDigest,
      { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' },
      async () => { store.productVersions.set('p1', 'v2'); },
    );
    expect(result.skippedReasons?.CONCURRENT_CHANGE).toBeGreaterThan(0);
    expect(store.products.get('p1')!.vehicle_uid).toBeUndefined();
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
