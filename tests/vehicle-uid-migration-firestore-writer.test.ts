import { describe, expect, it } from 'vitest';
import { applyVehicleUidMigration, rollbackVehicleUidMigration } from '../src/application/vehicle-uid-migration-apply.js';
import { planVehicleUidMigration, type VehicleUidMigrationProduct } from '../src/application/vehicle-uid-migration-plan.js';
import type { VehicleAsset } from '../src/domain/catalog.js';
import { createVehicleUidMigrationFirestoreWriter } from '../src/infra/vehicle-uid-migration-firestore-writer.js';
import { FIRESTORE_COLLECTIONS } from '../src/infra/firestore-layout.js';

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

function plan(products: Record<string, VehicleUidMigrationProduct>, assets: VehicleAsset[]) {
  return planVehicleUidMigration({
    products,
    assets,
    bindings: [],
    clock: fixedClock,
    random,
    observedAt: '2026-10-10T00:00:00.000Z',
  });
}

class FakeSnapshot {
  readonly exists: boolean;
  readonly updateTime = { seconds: 1, nanoseconds: 0 };
  constructor(readonly id: string, private readonly value: Record<string, unknown> | undefined) {
    this.exists = value !== undefined;
  }
  data() {
    return structuredClone(this.value);
  }
  get(field: string) {
    return this.value?.[field];
  }
}

class FakeFirestore {
  readonly docs = new Map<string, Record<string, unknown>>();
  collection(name: string) {
    return {
      doc: (id: string) => ({
        collection: name,
        id,
        path: `${name}/${id}`,
        get: async () => new FakeSnapshot(id, this.docs.get(`${name}/${id}`)),
        update: async (patch: Record<string, unknown>) => this.applyPatch(`${name}/${id}`, patch),
      }),
    };
  }
  applyPatch(path: string, patch: Record<string, unknown>) {
    const current = { ...this.docs.get(path) };
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && value.constructor?.name.includes('Delete')) delete current[key];
      else if (value === undefined) delete current[key];
      else current[key] = structuredClone(value);
    }
    this.docs.set(path, current);
  }
  async runTransaction<T>(fn: (tx: { get: (ref: { id: string; path: string }) => Promise<FakeSnapshot>; update: (ref: { path: string }, patch: Record<string, unknown>) => void }) => Promise<T>) {
    let wrote = false;
    const tx = {
      get: async (ref: { id: string; path: string }) => {
        if (wrote) throw new Error('TEST_FAKE_READ_AFTER_WRITE');
        return new FakeSnapshot(ref.id, this.docs.get(ref.path));
      },
      update: (ref: { path: string }, patch: Record<string, unknown>) => {
        wrote = true;
        this.applyPatch(ref.path, patch);
      },
    };
    return fn(tx);
  }
}

function fakeWriter(db: FakeFirestore) {
  return createVehicleUidMigrationFirestoreWriter(db as never);
}

function assetPath(id: string) {
  return `${FIRESTORE_COLLECTIONS.catalog.vehicleAssets}/${id}`;
}

function productPath(id: string) {
  return `${FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products}/${id}`;
}

describe('vehicle UID Firestore writer transaction ordering', () => {
  it('applies and rolls back a component with asset and product mutations without reading after the first update', async () => {
    const p = plan(
      { p1: product('TEST-FAKE-001', { vin: 'TEST-FAKE-VIN-NEW' }) },
      [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')],
    );
    const db = new FakeFirestore();
    db.docs.set(assetPath('TEST-FAKE-UID-001'), asset('TEST-FAKE-UID-001', 'TEST-FAKE-001'));
    db.docs.set(productPath('p1'), product('TEST-FAKE-001', { vin: 'TEST-FAKE-VIN-NEW' }));

    const applied = await applyVehicleUidMigration(fakeWriter(db), p, p.planDigest, { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' });
    expect(applied.status).toBe('APPLIED');
    expect(db.docs.get(productPath('p1'))?.vehicle_uid).toBe('TEST-FAKE-UID-001');
    expect(db.docs.get(assetPath('TEST-FAKE-UID-001'))?.externalIds).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'VIN', value: 'TEST-FAKE-VIN-NEW' })]));

    const rolledBack = await rollbackVehicleUidMigration(fakeWriter(db), applied.backup!, p.planDigest, { approvedDigest: p.planDigest, writeFlag: 'ROLLBACK' });
    expect(rolledBack.status).toBe('ROLLED_BACK');
    expect(db.docs.get(productPath('p1'))?.vehicle_uid).toBeUndefined();
    expect(db.docs.get(assetPath('TEST-FAKE-UID-001'))?.externalIds).toBeUndefined();
  });

  it('revalidates a product-only linked asset inside the transaction and skips stale asset deletion', async () => {
    const p = plan({ p1: product('TEST-FAKE-001') }, [assetWithCurrentExternalIds('TEST-FAKE-UID-001', 'TEST-FAKE-001')]);
    const db = new FakeFirestore();
    db.docs.set(assetPath('TEST-FAKE-UID-001'), assetWithCurrentExternalIds('TEST-FAKE-UID-001', 'TEST-FAKE-001'));
    db.docs.set(productPath('p1'), product('TEST-FAKE-001'));

    const result = await applyVehicleUidMigration(
      fakeWriter(db),
      p,
      p.planDigest,
      { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' },
      async () => { db.docs.delete(assetPath('TEST-FAKE-UID-001')); },
    );

    expect(result.skippedReasons?.STALE_ASSET).toBe(1);
    expect(db.docs.get(productPath('p1'))?.vehicle_uid).toBeUndefined();
  });

  it('revalidates an unlinked asset external-id addition inside the transaction and skips stale identifier changes', async () => {
    const p = plan({}, [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')]);
    const db = new FakeFirestore();
    db.docs.set(assetPath('TEST-FAKE-UID-001'), asset('TEST-FAKE-UID-001', 'TEST-FAKE-001'));

    const result = await applyVehicleUidMigration(
      fakeWriter(db),
      p,
      p.planDigest,
      { now: p.createdAt, approvedDigest: p.planDigest, writeFlag: 'APPLY' },
      async () => { db.docs.set(assetPath('TEST-FAKE-UID-001'), asset('TEST-FAKE-UID-001', 'TEST-FAKE-CHANGED')); },
    );

    expect(result.skippedReasons?.STALE_ASSET).toBe(1);
    expect(db.docs.get(assetPath('TEST-FAKE-UID-001'))?.externalIds).toBeUndefined();
  });
});
