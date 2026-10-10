import { describe, expect, it } from 'vitest';
import { planVehicleUidMigration, type VehicleUidMigrationProduct } from '../src/application/vehicle-uid-migration-plan.js';
import type { VehicleAsset } from '../src/domain/catalog.js';
import type { CanonicalSourceBinding } from '../src/domain/canonicalization.js';
import { stableDigest } from '../src/shared/stable-digest.js';

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
const binding = (sourceRecordId: string, vehicleAssetId: string): CanonicalSourceBinding => ({
  bindingId: `bind_${sourceRecordId}`,
  sourceId: 'erp5',
  sourceRecordId,
  sourceFingerprint: 'fp',
  sourceRunId: 'run',
  sourceObservedAt: '2026-10-01T00:00:00.000Z',
  vehicleModelId: 'vm',
  vehicleAssetId,
  productId: sourceRecordId,
  offerId: `off_${sourceRecordId}`,
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  createdBy: actor,
  updatedBy: actor,
});
const product = (plate: string, extra: VehicleUidMigrationProduct = {}) => ({ car_number: plate, provider_company_code: 'TEST', ...extra });
const fixedClock = () => new Date('2026-10-10T00:00:00.000Z');
const random = (n: number) => () => n;
const plan = (input: {
  products: Record<string, VehicleUidMigrationProduct>;
  assets?: VehicleAsset[];
  bindings?: CanonicalSourceBinding[];
  rand?: number;
}) => planVehicleUidMigration({
  products: input.products,
  assets: input.assets ?? [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001', 'TEST-FAKE-VIN-001')],
  bindings: input.bindings ?? [],
  clock: fixedClock,
  random: random(input.rand ?? 0.1),
  observedAt: '2026-10-10T00:00:00.000Z',
});

describe('planVehicleUidMigration', () => {
  it('plans external ids without changing existing asset ids', () => {
    const result = plan({ products: {} });
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: 'ASSET_ADD_EXTERNAL_IDS',
      assetId: 'TEST-FAKE-UID-001',
    }));
    expect(result.summary.invariants.existingAssetIdsUnchanged).toBe(true);
  });

  it('uses source binding before plate matching', () => {
    const result = plan({
      products: { p1: product('TEST-FAKE-001') },
      assets: [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')],
      bindings: [binding('p1', 'TEST-FAKE-UID-001')],
    });
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: 'PRODUCT_SET_UID',
      productKey: 'p1',
      vehicleUid: 'TEST-FAKE-UID-001',
      reason: 'SOURCE_BINDING',
    }));
  });

  it('holds product with multiple source bindings', () => {
    const result = plan({
      products: { p1: product('TEST-FAKE-001') },
      assets: [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001'), asset('TEST-FAKE-UID-002', 'TEST-FAKE-002')],
      bindings: [binding('p1', 'TEST-FAKE-UID-001'), { ...binding('p1', 'TEST-FAKE-UID-002'), bindingId: 'bind_p1_second' }],
    });
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: 'HOLD',
      productKey: 'p1',
      reason: 'MULTIPLE_BINDINGS',
    }));
  });

  it('holds source binding when target asset is missing', () => {
    const result = plan({
      products: { p1: product('TEST-FAKE-001') },
      assets: [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')],
      bindings: [binding('p1', 'TEST-FAKE-UID-MISSING')],
    });
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: 'HOLD',
      productKey: 'p1',
      reason: 'BINDING_TARGET_MISSING',
    }));
  });

  it('holds source binding when binding target contradicts product VIN', () => {
    const result = plan({
      products: { p1: product('TEST-FAKE-001', { vin: 'TEST-FAKE-VIN-999' }) },
      assets: [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001', 'TEST-FAKE-VIN-001')],
      bindings: [binding('p1', 'TEST-FAKE-UID-001')],
    });
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: 'HOLD',
      productKey: 'p1',
      reason: 'BINDING_CONTRADICTS_PRODUCT',
    }));
  });

  it('holds source binding when resolver links a different asset', () => {
    const result = plan({
      products: { p1: product('TEST-FAKE-002') },
      assets: [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001'), asset('TEST-FAKE-UID-002', 'TEST-FAKE-002')],
      bindings: [binding('p1', 'TEST-FAKE-UID-001')],
    });
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: 'HOLD',
      productKey: 'p1',
      reason: 'BINDING_DISAGREES_WITH_RESOLVER',
    }));
  });

  it('links by exactly one matching plate asset', () => {
    const result = plan({ products: { p1: product('TEST-FAKE-001') } });
    expect(result.items).toContainEqual(expect.objectContaining({
      kind: 'PRODUCT_SET_UID',
      productKey: 'p1',
      reason: 'PLATE_UNIQUE_ASSET',
    }));
  });

  it('pins new planned UID into the plan digest', () => {
    const a = plan({ products: { p1: product('TEST-FAKE-NEW') }, rand: 0.1 });
    const b = plan({ products: { p1: product('TEST-FAKE-NEW') }, rand: 0.1 });
    const c = plan({ products: { p1: product('TEST-FAKE-NEW') }, rand: 0.2 });
    expect(a.items).toContainEqual(expect.objectContaining({ kind: 'PRODUCT_SET_UID', reason: 'PLANNED_NEW_UID' }));
    expect(a.planDigest).toBe(b.planDigest);
    expect(a.planDigest).not.toBe(c.planDigest);
  });

  it('links later products to UID created earlier in the same plan by VIN and plate', () => {
    const result = plan({
      products: {
        p1: product('TEST-FAKE-NEW-001', { vin: 'TEST-FAKE-VIN-NEW-001' }),
        p2: product('TEST-FAKE-NEW-001', { vin: 'TEST-FAKE-VIN-NEW-001' }),
      },
    });
    const setItems = result.items.filter(item => item.kind === 'PRODUCT_SET_UID');
    expect(setItems).toHaveLength(2);
    expect(setItems[0]).toEqual(expect.objectContaining({ productKey: 'p1', reason: 'PLANNED_NEW_UID' }));
    expect(setItems[1]).toEqual(expect.objectContaining({ productKey: 'p2', reason: 'CREATED_IN_PLAN', vehicleUid: setItems[0]!.vehicleUid }));
  });

  it('links later products to UID created earlier in the same plan by VIN even without plate', () => {
    const result = plan({
      products: {
        p1: product('TEST-FAKE-NEW-001', { vin: 'TEST-FAKE-VIN-NEW-001' }),
        p2: { vin: 'TEST-FAKE-VIN-NEW-001', provider_company_code: 'TEST' },
      },
    });
    const setItems = result.items.filter(item => item.kind === 'PRODUCT_SET_UID');
    expect(setItems).toHaveLength(2);
    expect(setItems[1]).toEqual(expect.objectContaining({ productKey: 'p2', reason: 'CREATED_IN_PLAN', vehicleUid: setItems[0]!.vehicleUid }));
  });

  it('creates separate planned UIDs when VIN differs', () => {
    const result = plan({
      products: {
        p1: product('TEST-FAKE-NEW-001', { vin: 'TEST-FAKE-VIN-NEW-001' }),
        p2: product('TEST-FAKE-NEW-002', { vin: 'TEST-FAKE-VIN-NEW-002' }),
      },
      rand: 0.1,
    });
    const setItems = result.items.filter(item => item.kind === 'PRODUCT_SET_UID');
    expect(setItems).toHaveLength(2);
    expect(setItems[0]!.vehicleUid).not.toBe(setItems[1]!.vehicleUid);
    expect(setItems.map(item => item.reason)).toEqual(['PLANNED_NEW_UID', 'PLANNED_NEW_UID']);
  });

  it('keeps the same digest when product input key order changes', () => {
    const forward = plan({
      products: {
        p1: product('TEST-FAKE-NEW-001', { vin: 'TEST-FAKE-VIN-NEW-001' }),
        p2: product('TEST-FAKE-NEW-001', { vin: 'TEST-FAKE-VIN-NEW-001' }),
      },
      rand: 0.1,
    });
    const reversed = plan({
      products: {
        p2: product('TEST-FAKE-NEW-001', { vin: 'TEST-FAKE-VIN-NEW-001' }),
        p1: product('TEST-FAKE-NEW-001', { vin: 'TEST-FAKE-VIN-NEW-001' }),
      },
      rand: 0.1,
    });
    expect(forward.planDigest).toBe(reversed.planDigest);
  });

  it('holds prefix keys, iancar keys, duplicate cross-supplier plates, and VIN contradictions', () => {
    const result = plan({
      products: {
        'RP023_TEST-FAKE-001': product('TEST-FAKE-001'),
        iancar_TEST: product('TEST-FAKE-002'),
        p2: product('TEST-FAKE-DUP', { provider_company_code: 'A' }),
        p3: product('TEST-FAKE-DUP', { provider_company_code: 'B' }),
        p4: product('TEST-FAKE-001', { vin: 'TEST-FAKE-VIN-999' }),
      },
    });
    const reasons = result.items.filter(x => x.kind === 'HOLD').map(x => x.reason);
    expect(reasons).toEqual(expect.arrayContaining([
      'PREFIX_PRODUCT_KEY_REQUIRES_REVIEW',
      'IANCAR_PRODUCT_KEY_REQUIRES_REVIEW',
      'PLATE_DUPLICATED_ACROSS_SUPPLIERS',
      'IDENTIFIER_CONTRADICTION',
    ]));
  });

  it('does not put original plate numbers in the public report', () => {
    const result = plan({ products: { p1: product('TEST-FAKE-SECRET') } });
    expect(JSON.stringify(result.summary.publicReport)).not.toContain('TEST-FAKE-SECRET');
  });

  it('does not mutate inputs and reports invariants', () => {
    const products = { p1: product('TEST-FAKE-001') };
    const assets = [asset('TEST-FAKE-UID-001', 'TEST-FAKE-001')];
    const before = stableDigest({ products, assets });
    const result = plan({ products, assets });
    expect(stableDigest({ products, assets })).toBe(before);
    expect(result.summary.totalProducts).toBe(1);
    expect(result.summary.invariants.productsUnchanged).toBe(true);
    expect(result.summary.invariants.oneActivePlatePerUid).toBe(true);
  });
});
