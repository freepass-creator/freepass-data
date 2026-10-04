import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ERP5_DOCUMENTS, type Erp5SourceCapture } from '../src/adapters/erp5-source-capture.js';
import { supplierEnteredFromErp5, withSupplements } from '../src/adapters/shared-sheet-capture.js';
import { buildSharedSheetBatch, sharedSheetChannels, sharedSheetHeaders, type SharedSheetCapture } from '../src/adapters/shared-sheet-source.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';
import { ingestRawSourceBatch } from '../src/application/ingest-raw-source.js';
import { normalizeSharedSheet } from '../src/adapters/normalize-shared-sheet.js';

const T = '2026-10-04T00:00:00.000Z', T2 = '2026-10-05T00:00:00.000Z';
const mapValue = (o: Record<string, string>) => ({ mapValue: { fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { stringValue: v }])) } });
const doc = (id: string, plate: string, source: Record<string, string>, supplier = 'RP013') => ({ name: `${ERP5_DOCUMENTS}/products/${id}`,
  createTime: '2026-09-21T00:00:00Z', updateTime: '2026-09-21T00:00:00Z',
  fields: { car_number: { stringValue: plate }, provider_company_code: { stringValue: supplier }, '원문': mapValue(source) } });
function erp5(products: ReturnType<typeof doc>[]): Erp5SourceCapture {
  const unsigned = { version: 'erp5-source-capture/1' as const, projectId: 'freepasserp5' as const, databaseId: '(default)' as const,
    consistency: 'READ_ONLY_TRANSACTION' as const, readTime: '2026-09-21T00:00:00Z', capturedAt: '2026-09-21T00:00:01Z',
    collections: { products: { count: products.length, documents: products }, policy: { count: 0, documents: [] }, partner: { count: 0, documents: [] } } };
  return { ...unsigned, digest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') } as unknown as Erp5SourceCapture;
}
function sheet(plates: string[], readTime = T): SharedSheetCapture {
  const ch = sharedSheetChannels.find(x => x.companyName === '웰릭스')!;
  const row = (plate: string) => sharedSheetHeaders.map(h => ({ 회사명: '웰릭스', 차량번호: plate, 차량상태: '출고가능', 상품구분: '중고렌트',
    제조사: '시험제조사', 모델: '시험모델', 세부모델: '시험세부모델', 세부트림: '시험트림', '12개월': 404 } as Record<string, string | number>)[h] ?? '');
  return { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-sheet', layoutVersion: '2026-10-04-no-account', readTime, revision: `r-${readTime}`,
    tabs: [...new Set(sharedSheetChannels.map(x => x.tab))].map(title => {
      const values = [[...sharedSheetHeaders], ...(title === ch.tab ? plates.map(row) : [])];
      return { title, readTime, complete: true as const, rowCount: values.length, values };
    }) };
}

describe('layer ② supplier-entered values and correction history', () => {
  it('reads products.원문 per plate and drops plates whose products disagree', () => {
    const got = supplierEnteredFromErp5(erp5([doc('p1', 'TEST-FAKE-001', { 전체: '공급사가 쓴 값' }),
      doc('p2', 'TEST-FAKE-002', { 차명: 'A' }), doc('p3', 'TEST-FAKE-002', { 차명: 'B' })]));
    expect(got).toEqual([{ supplierCode: 'RP013', plate: 'TEST-FAKE-001', source: 'ERP5_PRODUCTS_SOURCE_TEXT', sourceRef: 'p1', observedAt: '2026-09-21T00:00:00Z',
      values: { 전체: '공급사가 쓴 값' } }]);
  });
  it('attaches beside the row without changing the sheet RAW digest or fingerprint', () => {
    const base = buildSharedSheetBatch({ ...sheet(['TEST-FAKE-001', 'TEST-FAKE-002']), digest: undefined });
    const sealed = withSupplements(sheet(['TEST-FAKE-001', 'TEST-FAKE-002']),
      [{ supplierCode: 'RP013', plate: 'TEST-FAKE-001', source: 'ERP5_PRODUCTS_SOURCE_TEXT', sourceRef: 'p1', observedAt: T, values: { 차명: '원래 값' } },
       { supplierCode: 'RP013', plate: 'TEST-FAKE-999', source: 'SHEET_BACKUP', sourceRef: 'backup', observedAt: T, values: {} }],
      [{ supplierCode: 'RP013', plate: 'TEST-FAKE-002', at: T, column: '세부트림', before: 'ECH 아이코닉', after: '아이코닉', source: '기준 한 장' }]);
    const batch = buildSharedSheetBatch(sealed);
    const by = new Map(batch.records.map(r => [(r.payload.values as unknown[])[4], r]));
    expect(by.get('TEST-FAKE-001')!.payload.supplierEntered).toMatchObject({ values: { 차명: '원래 값' } });
    expect(by.get('TEST-FAKE-002')!.payload.corrections).toHaveLength(1);
    expect(sealed.supplierEntered).toHaveLength(1);
    expect(batch.records.map(r => [r.sourceRecordId, r.sourceFingerprint, r.payload.rowDigest]))
      .toEqual(base.records.map(r => [r.sourceRecordId, r.sourceFingerprint, r.payload.rowDigest]));
  });
  it('rejects a supplement with two supplier-entered records for one plate', () => {
    const c = sheet(['TEST-FAKE-001']);
    const rec = { supplierCode: 'RP013', plate: 'TEST-FAKE-001', source: 'SHEET_BACKUP' as const, sourceRef: 'b', observedAt: T, values: {} };
    expect(() => withSupplements(c, [rec, { ...rec }], [])).toThrow();
  });
});

describe('first run link (layer ① first source text)', () => {
  it('keeps the first run id across later runs', async () => {
    const store = new MemorySourceStore();
    const first = await ingestRawSourceBatch(store, buildSharedSheetBatch({ ...sheet(['TEST-FAKE-001']), digest: undefined }), T, normalizeSharedSheet);
    const c2 = sheet(['TEST-FAKE-001'], T2); c2.tabs[0]!.values[1]![10] = 'changed';
    const second = await ingestRawSourceBatch(store, buildSharedSheetBatch(c2), T2, normalizeSharedSheet);
    const raw = (await store.listRaw(second.runId)).find(r => (r.payload.values as unknown[])[4] === 'TEST-FAKE-001')!;
    expect(second.runId).not.toBe(first.runId);
    expect(raw.firstRunId).toBe(first.runId);
    expect((await store.listCandidates(second.runId))[0]!.candidate.firstRunId).toBe(first.runId);
  });
});

describe('Codex #324 review', () => {
  it('leaves the first run unknown when older RAW history has no firstRunId (never links to a re-observation run)', async () => {
    const store = new MemorySourceStore();
    const T3 = '2026-10-06T00:00:00.000Z';
    await ingestRawSourceBatch(store, buildSharedSheetBatch({ ...sheet(['TEST-FAKE-001']), digest: undefined }), T, normalizeSharedSheet);
    const b = sheet(['TEST-FAKE-001'], T2); b.tabs[0]!.values[1]![10] = 'b';
    const second = await ingestRawSourceBatch(store, buildSharedSheetBatch(b), T2, normalizeSharedSheet);
    // Simulate RAW written before this change: drop firstRunId from the re-observation run.
    for (const r of (store as unknown as { raw: Map<string, { runId: string; firstRunId?: string | null }> }).raw.values())
      if (r.runId === second.runId) delete r.firstRunId;
    const c = sheet(['TEST-FAKE-001'], T3); c.tabs[0]!.values[1]![10] = 'c';
    const third = await ingestRawSourceBatch(store, buildSharedSheetBatch(c), T3, normalizeSharedSheet);
    const raw = (await store.listRaw(third.runId))[0]!;
    expect(raw.firstObservedAt).toBe(T);
    expect(raw.firstRunId).toBeNull();
    expect((await store.listCandidates(third.runId))[0]!.candidate).not.toHaveProperty('firstRunId');
  });
  it('rejects corrections without valid before/after cells', () => {
    const c = sheet(['TEST-FAKE-001']);
    const ok = { supplierCode: 'RP013', plate: 'TEST-FAKE-001', at: T, column: '세부트림', before: 'A', after: 'B', source: 's' };
    expect(() => withSupplements(c, [], [ok])).not.toThrow();
    for (const bad of [{ ...ok, before: undefined }, { ...ok, after: { x: 1 } }, (({ after: _, ...x }) => x)(ok)])
      expect(() => withSupplements(c, [], [bad as unknown as typeof ok])).toThrow();
  });
});

describe('one plate = one canonical row (AI 상황실 #324 review)', () => {
  it('quarantines the same plate offered by two suppliers and attaches supplements only by supplier+plate', () => {
    const a = sharedSheetChannels.find(x => x.companyName === '웰릭스')!, b = sharedSheetChannels.find(x => x.code !== a.code && x.tab !== a.tab)!;
    const row = (company: string, plate: string) => sharedSheetHeaders.map(h => ({ 회사명: company, 차량번호: plate, 차량상태: '출고가능' } as Record<string, string>)[h] ?? '');
    const capture: SharedSheetCapture = { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-sheet', layoutVersion: '2026-10-04-no-account',
      readTime: T, revision: 'r', tabs: [...new Set(sharedSheetChannels.map(x => x.tab))].map(title => {
        const values = [[...sharedSheetHeaders], ...(title === a.tab ? [row(a.companyName, 'TEST-FAKE-001'), row(a.companyName, 'TEST-FAKE-002')] : []),
          ...(title === b.tab ? [row(b.companyName, 'TEST-FAKE-001'), row(b.companyName, 'TEST-FAKE-003')] : [])];
        return { title, readTime: T, complete: true as const, rowCount: values.length, values };
      }) };
    const sealed = withSupplements(capture, [
      { supplierCode: a.code, plate: 'TEST-FAKE-002', source: 'SHEET_BACKUP', sourceRef: 'x', observedAt: T, values: { 차명: 'A값' } },
      { supplierCode: a.code, plate: 'TEST-FAKE-003', source: 'SHEET_BACKUP', sourceRef: 'x', observedAt: T, values: { 차명: '다른 공급사 차' } }], []);
    const recs = buildSharedSheetBatch(sealed).records;
    const of = (company: string, plate: string) => recs.find(r => (r.payload.values as unknown[])[0] === company && (r.payload.values as unknown[])[4] === plate)!;
    expect(of(a.companyName, 'TEST-FAKE-001').payload.quarantine).toBe('PLATE_ON_MULTIPLE_SUPPLIERS');
    expect(of(b.companyName, 'TEST-FAKE-001').payload.quarantine).toBe('PLATE_ON_MULTIPLE_SUPPLIERS');
    expect(of(a.companyName, 'TEST-FAKE-002').payload.supplierEntered).toMatchObject({ values: { 차명: 'A값' } });
    expect(of(b.companyName, 'TEST-FAKE-003').payload).not.toHaveProperty('supplierEntered');
  });
});
