import { describe, expect, it } from 'vitest';
import {
  firestoreSafePlateKey,
  isStrictKoreanPlate,
  plateIdentityKey,
} from '../src/domain/vehicle-plate.js';
import {
  ERP5_INVENTORY_STATUS_KINDS,
  resolveErp5InventoryStatus,
} from '../src/domain/erp5-inventory-status.js';
import { buildSheetInventorySummary } from '../src/application/sheet-publication-bridge.js';

describe('vehicle plate identity', () => {
  it('drops whitespace and upper-cases but keeps punctuation apart', () => {
    expect(plateIdentityKey(' 12가 3456 ')).toBe('12가3456');
    expect(plateIdentityKey('서울12가\t3456')).toBe('서울12가3456');
    expect(plateIdentityKey('ab12')).toBe('AB12');
    expect(plateIdentityKey('12가-3456')).not.toBe(plateIdentityKey('12가3456'));
  });

  it('gives non-string input no identity', () => {
    for (const value of [undefined, null, 123, {}, ['12가3456']]) expect(plateIdentityKey(value)).toBe('');
  });

  it('keeps the strict mapper shape and the separate Firestore-safe key', () => {
    expect(isStrictKoreanPlate('12가3456')).toBe(true);
    expect(isStrictKoreanPlate('서울123가4567')).toBe(true);
    expect(isStrictKoreanPlate('12가 3456')).toBe(false);
    expect(isStrictKoreanPlate('12-3456')).toBe(false);
    expect(firestoreSafePlateKey(' 12가-34.56 ')).toBe('12가3456');
  });
});

describe('ERP5 inventory status dictionary', () => {
  it('resolves every reviewed status with the historical status_kind and listable rule', () => {
    expect(Object.fromEntries(Object.keys(ERP5_INVENTORY_STATUS_KINDS).map((status) => {
      const resolved = resolveErp5InventoryStatus(status);
      return [status, resolved.known ? [resolved.statusKind, resolved.listable] : null];
    }))).toEqual({
      즉시출고: ['가용', true],
      출고가능: ['가용', true],
      출고협의: ['협의', true],
      상품화중: ['준비', true],
      차량검수: ['준비', true],
      계약중: ['선점', true],
      출고불가: ['불가', false],
    });
  });

  it('keeps the sheet drift fallbacks: empty counts as 준비, unreviewed as 불가', () => {
    const row = (vehicle_status: string, status_kind: string) =>
      ({ _key: `p-${vehicle_status}-${status_kind}`, car_number: '12가3456', vehicle_status, status_kind, listable: vehicle_status !== '출고불가' });
    const drift = (rows: Record<string, unknown>[]) => buildSheetInventorySummary(rows).statusKindDrift;
    expect(drift([row('', '준비'), row('판매완료', '불가'), row('계약중', '선점'), row('출고불가', '불가')])).toBe(0);
    expect(drift([row('', '가용')])).toBe(1);
    expect(drift([row('판매완료', '준비')])).toBe(1);
  });

  it('marks empty, unknown and inherited keys as unreviewed', () => {
    for (const value of ['', ' 출고가능', '판매완료', 'constructor', '__proto__', undefined, 1]) {
      expect(resolveErp5InventoryStatus(value)).toEqual({ known: false });
    }
  });
});
