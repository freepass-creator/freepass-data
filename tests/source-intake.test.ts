import { describe, expect, it } from 'vitest';
import {
  FREEPASS_SOURCE_LANES,
  sourceLane,
  validateSourceIntakeEnvelope,
} from '../src/domain/source-intake.js';

describe('FreePass source intake lanes', () => {
  it('locks the four business source lanes without creating duplicate data worlds', () => {
    expect(FREEPASS_SOURCE_LANES.map((item) => item.laneId)).toEqual([
      'SUPPLIER',
      'PRODUCT_VEHICLE',
      'VEHICLE_MASTER',
      'SETTLEMENT',
    ]);
    expect(FREEPASS_SOURCE_LANES.every((item) => item.rawFirst)).toBe(true);
    expect(new Set(FREEPASS_SOURCE_LANES.map((item) => item.laneId)).size).toBe(4);
  });

  it('keeps settlement normalization owned by the settlement domain while Data owns intake evidence', () => {
    expect(sourceLane('SETTLEMENT')).toMatchObject({
      rawFirst: true,
      normalizerOwner: 'freepass-admin/settlement',
    });
  });

  it('accepts a minimal raw intake envelope without requiring canonical correctness', () => {
    expect(validateSourceIntakeEnvelope({
      laneId: 'PRODUCT_VEHICLE',
      sourceId: 'supplier/demo/products',
      sourceRecordId: 'row-1',
      observedAt: '2026-09-26T09:30:00.000Z',
      checksum: 'a'.repeat(64),
      payload: { model: 'unreviewed-value', price: null },
    })).toBe(true);
  });

  it('fails closed on missing identity, invalid time or invalid checksum', () => {
    expect(() => validateSourceIntakeEnvelope({
      laneId: 'SUPPLIER',
      sourceId: '',
      sourceRecordId: 'partner-1',
      observedAt: '2026-09-26T09:30:00.000Z',
      payload: {},
    })).toThrow('INVALID_SOURCE_INTAKE_ENVELOPE');

    expect(() => validateSourceIntakeEnvelope({
      laneId: 'SETTLEMENT',
      sourceId: 'settlement/source',
      sourceRecordId: 'row-1',
      observedAt: 'not-a-time',
      payload: {},
    })).toThrow('INVALID_SOURCE_INTAKE_ENVELOPE');

    expect(() => validateSourceIntakeEnvelope({
      laneId: 'VEHICLE_MASTER',
      sourceId: 'manufacturer/source',
      sourceRecordId: 'doc-1',
      observedAt: '2026-09-26T09:30:00.000Z',
      checksum: 'bad',
      payload: {},
    })).toThrow('INVALID_SOURCE_INTAKE_CHECKSUM');
  });
});
