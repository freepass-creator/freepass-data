import { describe, expect, it } from 'vitest';
import { sonogongSourceAdapter, welrixSourceAdapter, type WelrixSheetObservation } from '../src/adapters/supplier-source-capture.js';
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

describe('provider-specific RAW adapters', () => {
  const now = '2026-10-02T04:00:00.000Z';
  const sonogong = (missing = false, mismatch = false) => sonogongSourceAdapter({
    expectedFreshnessSeconds: 60, readBucket: async bucket => ({ bucket, observedAt: now,
      revision: 'original/1', declaredTotal: 1, complete: true,
      records: [{ list: { id: 'same-id-across-buckets', carNumber: '12가3456' },
        detail: missing ? null : { id: 'same-id-across-buckets', carNumber: mismatch ? '12가9999' : '12가3456',
          estimates: [{ monthly12: '10', securityDepositAmount: null }] } }] }),
  });
  const grid = (): WelrixSheetObservation => ({ sourceId: 'synthetic-welrix-policy', sheetId: 'approved-sheet',
    tabId: 'policy-tab', range: 'A1:C3', revision: 'revision/1', observedAt: now,
    expectedRows: 2, complete: true, identityColumn: 0, headers: ['UID', '금액', '단위'],
    rows: [['same-policy', '10', '만원'], ['same-policy', '10', '%']] });
  const welrix = (original: WelrixSheetObservation, scope: 'inventory' | 'policy' = 'policy') => welrixSourceAdapter({
    sourceId: original.sourceId, sheetId: 'approved-sheet', tabId: 'policy-tab', range: 'A1:C3',
    scope, expectedFreshnessSeconds: 60, readGrid: async () => original,
  });
  it('keeps Sonogong buckets distinct and original term values untouched', async () => {
    const result = await collectSupplierSource(sonogong(), now);
    expect(result.evidence.status).toBe('RAW_READY');
    expect(new Set(result.batch.records.map(r => r.sourceRecordId)).size).toBe(3);
    expect((result.batch.records[0]!.payload.detail as Record<string, unknown>).estimates)
      .toEqual([{ monthly12: '10', securityDepositAmount: null }]);
  });
  it('holds missing Sonogong detail and rejects conflicting identities', async () => {
    expect((await collectSupplierSource(sonogong(true), now)).evidence.status).toBe('HOLD');
    await expect(collectSupplierSource(sonogong(false, true), now)).rejects.toThrow('SONOGONG_DETAIL_IDENTITY_MISMATCH');
  });
  it('does not turn a failed source request into an empty successful capture', async () => {
    const adapter = sonogongSourceAdapter({ expectedFreshnessSeconds: 60,
      readBucket: async () => { throw new Error('SOURCE_UNAVAILABLE'); } });
    await expect(collectSupplierSource(adapter, now)).rejects.toThrow('SOURCE_UNAVAILABLE');
  });
  it('preserves repeated policy UID conditions and explicit units in separate RAW rows', async () => {
    const original = grid();
    const result = await collectSupplierSource(welrix(original), now);
    expect(result.evidence.status).toBe('RAW_READY');
    expect(new Set(result.batch.records.map(r => r.sourceRecordId)).size).toBe(2);
    expect(result.batch.records.map(r => r.payload.cells)).toEqual(original.rows);
    result.batch.records[0]!.payload.cells = [];
    expect(original.rows[0]).toEqual(['same-policy', '10', '만원']);
  });
  it('rejects wrong Sheet binding and duplicate inventory plates', async () => {
    await expect(collectSupplierSource(welrix({ ...grid(), sheetId: 'wrong' }), now)).rejects.toThrow('WELRIX_SHEET_BINDING_MISMATCH');
    const original = grid(); original.rows = [['12가3456', '10', '만원'], ['12 가 3456', '20', '만원']];
    await expect(collectSupplierSource(welrix(original, 'inventory'), now)).rejects.toThrow('INVALID_SOURCE_INTAKE_RECORD');
  });
  it('holds truncated Sheet ranges despite successful transport', async () => {
    expect((await collectSupplierSource(welrix({ ...grid(), expectedRows: 3 }), now)).evidence.status).toBe('HOLD');
  });
});
