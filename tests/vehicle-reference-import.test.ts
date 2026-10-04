import { describe, expect, it } from 'vitest';
import { normalizeVehicleReferenceDataset } from '../src/application/vehicle-reference-import.js';

const base = {
  schema: 'freepass-vehicle-reference/v1',
  observedAt: '2026-10-04T05:50:00.000Z',
  revision: 'snapshot-1',
  provenanceRef: 'private-reference-001',
};

describe('vehicle reference import', () => {
  it('normalizes and deduplicates identical records', () => {
    const row = {
      maker: ' 현대 ',
      series: '그랜저',
      model: '더 뉴 그랜저 IG',
      generation: 'IG',
      fromYear: 2020,
      toYear: 2023,
      aliases: ['더뉴그랜저IG', '더뉴그랜저IG'],
      sourceIds: { series: 10, model: '20' },
    };
    const result = normalizeVehicleReferenceDataset({ ...base, records: [row, row] });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.maker).toBe('현대');
    expect(result.records[0]?.aliases).toEqual(['더뉴그랜저IG']);
    expect(result.records[0]?.sourceIds).toEqual({ model: '20', series: '10' });
  });

  it('rejects conflicting rows with the same identity', () => {
    const row = { maker: '현대', series: '그랜저', model: '그랜저 IG', generation: 'IG' };
    expect(() => normalizeVehicleReferenceDataset({
      ...base,
      records: [{ ...row, fromYear: 2020 }, { ...row, fromYear: 2021 }],
    })).toThrow(/VEHICLE_REFERENCE_CONFLICT/);
  });
});
