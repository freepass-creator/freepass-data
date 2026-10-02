import { describe, expect, it } from 'vitest';
import {
  FREEPASS_SOURCE_LANES,
  sourceLane,
  validateSourceIntakeEnvelope,
  collectSupplierSource,
  inspectSupplierSourceBatch,
  SUPPLIER_SOURCE_ADAPTERS,
  type SourceIntakeBatch,
  type SupplierSourceAdapterId,
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

describe('supplier adapter common capture contract', () => {
  const now = '2026-10-02T04:00:00.000Z';
  const batch = (kind: SourceIntakeBatch['source']['kind'] = 'API'): SourceIntakeBatch => ({
    laneId: 'PRODUCT_VEHICLE', source: { sourceId: 'synthetic-source', kind,
      displayName: 'synthetic', expectedFreshnessSeconds: 60 },
    observedAt: now, sourceRevision: 'mapping/1:revision', checksum: 'a'.repeat(64),
    coverage: { mode: 'FULL', completeness: 'COMPLETE', scope: 'inventory only' },
    records: [{ sourceRecordId: 'opaque-1', sourceFingerprint: 'b'.repeat(64),
      payload: { amount: '10', unit: 'unconfirmed', missing: null, zero: 0 } }],
  });
  const binding = { adapterId: 'iancar-one-api' as const, sourceId: 'synthetic-source', scope: 'inventory' as const };
  it('all registered supplier transports use one RAW output without altering numeric meaning', async () => {
    for (const adapterId of Object.keys(SUPPLIER_SOURCE_ADAPTERS) as SupplierSourceAdapterId[]) {
      const input = batch(SUPPLIER_SOURCE_ADAPTERS[adapterId].kind);
      const before = structuredClone(input);
      const result = await collectSupplierSource({ ...binding, adapterId, read: async () => input }, now);
      expect(result.batch).toEqual(before);
      expect(result.evidence).toMatchObject({ status: 'RAW_READY', recordCount: 1,
        canonicalWriteAuthorized: false, publicationAuthorized: false, retirementAuthorized: false });
      expect(JSON.stringify(result.evidence)).not.toContain('opaque-1');
    }
  });
  it('rejects wrong transport/source/lane and unsupported scopes before transport', async () => {
    for (const input of [ { ...batch(), laneId: 'SETTLEMENT' as const }, batch('GOOGLE_SHEET'),
      { ...batch(), source: { ...batch().source, sourceId: 'other' } } ]) {
      expect(() => inspectSupplierSourceBatch(binding, input, now)).toThrow('SUPPLIER_SOURCE_BINDING_MISMATCH');
    }
    let invoked = false;
    await expect(collectSupplierSource({ ...binding, adapterId: 'iancar-original-erp', scope: 'terms',
      read: async () => { invoked = true; return batch(); } }, now)).rejects.toThrow('UNSUPPORTED_SUPPLIER_ADAPTER_SCOPE');
    expect(invoked).toBe(false);
  });
  it('keeps stale/partial/unknown evidence HOLD, including a successful empty HTTP result', () => {
    const input = batch();
    input.records = [];
    input.coverage = { mode: 'UNKNOWN', completeness: 'UNKNOWN' };
    input.observedAt = '2026-10-02T03:00:00.000Z';
    input.checksum = null;
    expect(inspectSupplierSourceBatch(binding, input, now)).toMatchObject({ status: 'HOLD', issues: [
      'SOURCE_STALE', 'SOURCE_EVIDENCE_INCOMPLETE', 'SOURCE_COVERAGE_NOT_COMPLETE', 'SOURCE_SCOPE_UNKNOWN' ] });
    input.observedAt = '2026-10-02T04:00:01.000Z';
    input.source.expectedFreshnessSeconds = null;
    expect(inspectSupplierSourceBatch(binding, input, now).issues).toContain('SOURCE_TIME_IN_FUTURE');
    expect(inspectSupplierSourceBatch(binding, input, now).issues).toContain('SOURCE_FRESHNESS_UNKNOWN');
  });
  it('rejects duplicate identities and does not reinterpret a fresh full empty scope as deletion', () => {
    const input = batch();
    input.records.push(input.records[0]!);
    expect(() => inspectSupplierSourceBatch(binding, input, now)).toThrow('INVALID_SOURCE_INTAKE_RECORD');
    input.records = [];
    expect(inspectSupplierSourceBatch(binding, input, now)).toMatchObject({ status: 'RAW_READY', retirementAuthorized: false });
  });
});
