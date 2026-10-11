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
  constructor(
    readonly assets: Map<string, VehicleAsset>,
    readonly products: Map<string, Record<string, unknown>>,
  ) {}
  async getAsset(assetId: string) {
    return this.assets.get(assetId) ? structuredClone(this.assets.get(assetId)!) : null;
  }
  async getProduct(productKey: string) {
    return this.products.get(productKey) ? structuredClone(this.products.get(productKey)!) : null;
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
});
