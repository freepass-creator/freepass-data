import { describe, expect, it } from 'vitest';
import type { ActorRef, VehicleAsset, VehicleExternalId } from '../src/domain/catalog.js';
import {
  addExternalId,
  isExistingVehicleAssetId,
  isVehicleUid,
  newVehicleUid,
  resolveVehicleUid,
} from '../src/domain/vehicle-uid.js';

const actor: ActorRef = { id: 'test', kind: 'SERVICE' };
const now = '2026-10-12T00:00:00.000Z';
const meta = {
  schemaVersion: 'catalog-v1',
  revision: 1,
  validationStatus: 'VALID' as const,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  createdBy: actor,
  updatedBy: actor,
  lineageId: 'test-lineage',
};
const id = (kind: VehicleExternalId['kind'], value: string, supplierCode?: string): VehicleExternalId => ({
  kind,
  value,
  ...(supplierCode ? { supplierCode } : {}),
  validFrom: '2026-10-01T00:00:00.000Z',
  source: 'test',
});
const closedId = (kind: VehicleExternalId['kind'], value: string, validTo: string, supplierCode?: string): VehicleExternalId => ({
  ...id(kind, value, supplierCode),
  validTo,
});
const asset = (assetId: string, externalIds: VehicleExternalId[] = []): VehicleAsset => ({
  ...meta,
  id: assetId,
  vehicleModelId: 'vm-test',
  status: 'AVAILABLE',
  externalIds,
});
const randomSeq = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('vehicle UID issuing', () => {
  it('issues ULID-shaped vehicle UIDs with deterministic injected inputs', () => {
    const uid = newVehicleUid(() => 1_760_227_200_000, randomSeq(Array(16).fill(0.25)), { monotonic: false });
    expect(uid).toMatch(/^va_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(uid).toBe('va_01K7AVF3008888888888888888');
    expect(isVehicleUid(uid)).toBe(true);
  });

  it('sorts by the ULID time part and monotonically increments in one millisecond', () => {
    const first = newVehicleUid(() => 1_760_227_200_001, randomSeq(Array(16).fill(0.1)));
    const second = newVehicleUid(() => 1_760_227_200_002, randomSeq(Array(16).fill(0.0)));
    const sameTickA = newVehicleUid(() => 1_760_227_200_003, randomSeq(Array(16).fill(0.0)));
    const sameTickB = newVehicleUid(() => 1_760_227_200_003, randomSeq(Array(16).fill(0.0)));
    expect([second, sameTickB, first, sameTickA].sort()).toEqual([first, second, sameTickA, sameTickB]);
    expect(sameTickB > sameTickA).toBe(true);
  });

  it('keeps new ULID UIDs separate from existing 24-hex hash asset IDs', () => {
    expect(isVehicleUid('va_01K75JP8008888888888888888')).toBe(true);
    expect(isVehicleUid('va_0123456789abcdef01234567')).toBe(false);
    expect(isExistingVehicleAssetId('va_0123456789abcdef01234567')).toBe(true);
    expect(isExistingVehicleAssetId('va_01K75JP8008888888888888888')).toBe(false);
  });
});

describe('vehicle UID resolver', () => {
  it('links when VIN matches and plate changed', () => {
    const a = asset('va_old', [id('VIN', 'TESTVIN0000000001'), id('PLATE', 'TEST-FAKE-OLD')]);
    const result = resolveVehicleUid({ vin: 'testvin0000000001', plate: 'TEST-FAKE-NEW' }, [a], { now });
    expect(result.action).toBe('LINK');
    if (result.action === 'LINK') {
      expect(result.vehicleUid).toBe('va_old');
      expect(result.reason).toBe('VIN');
    }
  });

  it('holds when plate matches but VIN differs, and does not create', () => {
    const a = asset('va_plate', [id('VIN', 'TESTVIN0000000001'), id('PLATE', 'TEST-FAKE-001')]);
    const result = resolveVehicleUid({ vin: 'TESTVIN0000000002', plate: 'TEST-FAKE-001' }, [a], { now });
    expect(result).toEqual({ action: 'HOLD', reason: 'IDENTIFIER_CONTRADICTION' });
  });

  it('holds when a single plate match has a VIN mismatch', () => {
    const a = asset('va_plate', [id('VIN', 'TESTVIN0000000001'), id('PLATE', 'TEST-FAKE-001')]);
    const result = resolveVehicleUid({ vin: 'TESTVIN0000000003', plate: 'TEST-FAKE-001' }, [a], { now });
    expect(result.action).toBe('HOLD');
    expect(result).toHaveProperty('reason', 'IDENTIFIER_CONTRADICTION');
  });

  it('holds supplier ID reuse as a contradiction', () => {
    const a = asset('va_supplier', [id('SUPPLIER_VEHICLE', 'SUP-001', 'IANCAR'), id('VIN', 'TESTVIN0000000001')]);
    const result = resolveVehicleUid(
      { supplierCode: 'iancar', supplierVehicleId: 'SUP-001', vin: 'TESTVIN0000000002' },
      [a],
      { now },
    );
    expect(result).toEqual({ action: 'HOLD', reason: 'IDENTIFIER_CONTRADICTION' });
  });

  it('holds duplicate active plate across two supplier assets', () => {
    const a = asset('va_a', [id('PLATE', 'TEST-FAKE-001'), id('SUPPLIER_VEHICLE', 'A-1', 'SUP-A')]);
    const b = asset('va_b', [id('PLATE', 'TEST-FAKE-001'), id('SUPPLIER_VEHICLE', 'B-1', 'SUP-B')]);
    expect(resolveVehicleUid({ plate: 'TEST-FAKE-001' }, [a, b], { now }))
      .toEqual({ action: 'HOLD', reason: 'PLATE_CONFLICT' });
  });

  it('holds when identifiers point to different assets', () => {
    const vinAsset = asset('va_vin', [id('VIN', 'TESTVIN0000000001')]);
    const plateAsset = asset('va_plate', [id('PLATE', 'TEST-FAKE-001')]);
    expect(resolveVehicleUid({ vin: 'TESTVIN0000000001', plate: 'TEST-FAKE-001' }, [vinAsset, plateAsset], { now }))
      .toEqual({ action: 'HOLD', reason: 'IDENTIFIER_POINTS_TO_DIFFERENT_ASSETS' });
  });

  it('returns UNKNOWN when there are no identifiers', () => {
    expect(resolveVehicleUid({}, [], { now })).toEqual({ action: 'UNKNOWN', reason: 'INSUFFICIENT_IDENTITY' });
  });

  it('creates for a new vehicle without plate, then links after the plate is added to the same UID', () => {
    const created = resolveVehicleUid(
      { vin: 'TESTVIN0000000009', supplierCode: 'IANCAR', supplierVehicleId: 'SUP-009' },
      [],
      { now, clock: () => 1_760_227_200_010, random: randomSeq(Array(16).fill(0.5)) },
    );
    expect(created.action).toBe('CREATE');
    if (created.action !== 'CREATE') throw new Error('expected create');
    const stored = asset(created.vehicleUid, created.externalIds);
    const withPlate = addExternalId(stored, id('PLATE', 'TEST-FAKE-009'), '2026-10-13T00:00:00.000Z');
    const linked = resolveVehicleUid({ plate: 'TEST-FAKE-009' }, [withPlate], { now: '2026-10-13T00:00:01.000Z' });
    expect(linked.action).toBe('LINK');
    if (linked.action === 'LINK') expect(linked.vehicleUid).toBe(created.vehicleUid);
  });

  it('ignores stale legacy plate when external plate history has moved, but keeps legacy-only assets compatible', () => {
    const changed = {
      ...asset('va_changed', [
        closedId('PLATE', 'TEST-FAKE-OLD', '2026-10-11T00:00:00.000Z'),
        id('PLATE', 'TEST-FAKE-NEW'),
      ]),
      plateNumber: 'TEST-FAKE-OLD',
    };
    const oldPlate = resolveVehicleUid(
      { plate: 'TEST-FAKE-OLD' },
      [changed],
      { now, clock: () => 1_760_227_200_020, random: randomSeq(Array(16).fill(0.6)) },
    );
    expect(oldPlate.action).toBe('CREATE');

    const newPlate = resolveVehicleUid({ plate: 'TEST-FAKE-NEW' }, [changed], { now });
    expect(newPlate.action).toBe('LINK');
    if (newPlate.action === 'LINK') expect(newPlate.vehicleUid).toBe('va_changed');

    const legacyOnly = { ...asset('va_legacy'), plateNumber: 'TEST-FAKE-LEGACY' };
    const legacy = resolveVehicleUid({ plate: 'TEST-FAKE-LEGACY' }, [legacyOnly], { now });
    expect(legacy.action).toBe('LINK');
    if (legacy.action === 'LINK') expect(legacy.vehicleUid).toBe('va_legacy');
  });

  it('holds when candidate externalIds point to different plate and VIN assets', () => {
    const plateAsset = asset('va_plate_external', [id('PLATE', 'TEST-FAKE-A')]);
    const vinAsset = asset('va_vin_external', [id('VIN', 'TESTVIN00000000B')]);
    expect(resolveVehicleUid(
      { externalIds: [id('PLATE', 'TEST-FAKE-A'), id('VIN', 'TESTVIN00000000B')] },
      [plateAsset, vinAsset],
      { now },
    )).toEqual({ action: 'HOLD', reason: 'IDENTIFIER_POINTS_TO_DIFFERENT_ASSETS' });
  });

  it('holds when multiple supplier vehicle IDs in candidate externalIds point to different assets', () => {
    const first = asset('va_supplier_first', [id('SUPPLIER_VEHICLE', 'SUP-FAKE-1', 'TESTSUP')]);
    const second = asset('va_supplier_second', [id('SUPPLIER_VEHICLE', 'SUP-FAKE-2', 'TESTSUP')]);
    expect(resolveVehicleUid(
      { externalIds: [id('SUPPLIER_VEHICLE', 'SUP-FAKE-1', 'TESTSUP'), id('SUPPLIER_VEHICLE', 'SUP-FAKE-2', 'TESTSUP')] },
      [first, second],
      { now },
    )).toEqual({ action: 'HOLD', reason: 'IDENTIFIER_POINTS_TO_DIFFERENT_ASSETS' });
  });

  it('links when every candidate externalId points to the same asset', () => {
    const a = asset('va_all_same', [
      id('PLATE', 'TEST-FAKE-SAME'),
      id('VIN', 'TESTVIN000000SAME'),
      id('SUPPLIER_VEHICLE', 'SUP-FAKE-SAME-1', 'TESTSUP'),
      id('SUPPLIER_VEHICLE', 'SUP-FAKE-SAME-2', 'TESTSUP'),
    ]);
    const result = resolveVehicleUid(
      {
        externalIds: [
          id('PLATE', 'TEST-FAKE-SAME'),
          id('VIN', 'TESTVIN000000SAME'),
          id('SUPPLIER_VEHICLE', 'SUP-FAKE-SAME-1', 'TESTSUP'),
          id('SUPPLIER_VEHICLE', 'SUP-FAKE-SAME-2', 'TESTSUP'),
        ],
      },
      [a],
      { now },
    );
    expect(result.action).toBe('LINK');
    if (result.action === 'LINK') expect(result.vehicleUid).toBe('va_all_same');
  });

  it('creates with every active candidate externalId copied into the new asset IDs', () => {
    const created = resolveVehicleUid(
      { externalIds: [id('PLATE', 'TEST-FAKE-CREATE'), id('VIN', 'TESTVIN000CREATE')] },
      [],
      { now, clock: () => 1_760_227_200_030, random: randomSeq(Array(16).fill(0.7)) },
    );
    expect(created.action).toBe('CREATE');
    if (created.action !== 'CREATE') throw new Error('expected create');
    expect(created.externalIds).toEqual([
      { kind: 'PLATE', value: 'TEST-FAKE-CREATE', validFrom: now, validTo: null, source: 'vehicle-uid-resolver' },
      { kind: 'VIN', value: 'TESTVIN000CREATE', validFrom: now, validTo: null, source: 'vehicle-uid-resolver' },
    ]);
  });
});

describe('addExternalId', () => {
  it('closes the previous active value and appends the new value', () => {
    const original = asset('va_history', [id('PLATE', 'TEST-FAKE-OLD')]);
    const next = addExternalId(original, id('PLATE', 'TEST-FAKE-NEW'), now);
    expect(original.externalIds?.[0]?.validTo).toBeUndefined();
    expect(next.externalIds).toEqual([
      { ...id('PLATE', 'TEST-FAKE-OLD'), validTo: now },
      { ...id('PLATE', 'TEST-FAKE-NEW'), validTo: null },
    ]);
  });

  it('does not change history when the active value is identical', () => {
    const original = asset('va_same', [id('VIN', 'TESTVIN0000000001')]);
    const next = addExternalId(original, id('VIN', 'testvin0000000001'), now);
    expect(next).toEqual(original);
    expect(next).not.toBe(original);
  });
});
