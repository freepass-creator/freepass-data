import { describe, expect, it } from 'vitest';
import { KiaOfficialPriceParser } from '../src/adapters/kia-official-price-parser.js';
import { parseFetchedVehicleMasterSource } from '../src/application/vehicle-master-source-parse.js';
import {
  sealVehicleMasterSourceDocument,
} from '../src/domain/vehicle-master.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import { sha256Bytes } from '../src/shared/binary-digest.js';

const html = Buffer.from(`
  <html>
    <head><title>기아 쏘렌토 가격 - 시대의 Mainstream</title></head>
    <body>
      <div>The 2027 Sorento</div>
      <div>2026년 9월 1일 기준 (단위 : 원)</div>
      <button>2.5 가솔린 터보</button>
      <h3>프레스티지</h3>
      <div>36,410,000</div>
      <div>파워트레인</div>
      <div>스마트스트림 G2.5 터보 엔진</div>
      <button>선택품목</button>
      <li>스타일 1,240,000</li>
      <li>12.3인치 클러스터 590,000</li>
      <li>드라이브 와이즈(12.3인치 클러스터 적용 시) 1,290,000</li>
    </body>
  </html>
`, 'utf8');

describe('vehicle master parse persistence', () => {
  it('persists raw pointer, normalized rows and parser summary idempotently', async () => {
    const store = new MemoryVehicleMasterStore();
    const sourceDocument = sealVehicleMasterSourceDocument({
      sourceDocumentId: 'srcdoc_kia_parse_fixture',
      sourceType: 'MANUFACTURER_OFFICIAL',
      sourceName: 'Kia Sorento fixture',
      sourceUrl: 'https://www.kia.com/kr/vehicles/sorento/price',
      publishedAt: '2026-09-01T00:00:00.000Z',
      observedAt: '2026-09-25T08:30:00.000Z',
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      effectiveTo: null,
      storagePath: 'vehicle-master/source-documents/manufacturer_official/fixture.html',
      sha256: sha256Bytes(html),
      mimeType: 'text/html; charset=utf-8',
      metadata: {},
    });
    await store.putSourceDocument(sourceDocument);

    const fetched = {
      requestedUrl: sourceDocument.sourceUrl!,
      finalUrl: sourceDocument.sourceUrl!,
      status: 200,
      contentType: sourceDocument.mimeType,
      bytes: html,
    };

    const first = await parseFetchedVehicleMasterSource(
      { store, parsers: [new KiaOfficialPriceParser()] },
      { sourceDocument, fetched }
    );

    expect(first.parseResult.records).toHaveLength(1);
    expect(first.normalizedRecordIds).toHaveLength(1);
    expect(first.writes).toEqual(['CREATED', 'CREATED', 'CREATED']);

    const raw = await store.getPipelineRecord('RAW_RECORD', first.rawRecordId);
    expect(raw?.payload).toEqual(expect.objectContaining({
      storagePath: sourceDocument.storagePath,
      sha256: sourceDocument.sha256,
    }));

    const normalized = await store.getPipelineRecord(
      'NORMALIZED_RECORD',
      first.normalizedRecordIds[0]!
    );
    expect(normalized?.payload).toEqual(expect.objectContaining({
      recordKind: 'TRIM',
      parserId: 'KIA_OFFICIAL_PRICE',
      parserVersion: '1.0.0',
    }));

    const second = await parseFetchedVehicleMasterSource(
      { store, parsers: [new KiaOfficialPriceParser()] },
      { sourceDocument, fetched }
    );
    expect(second.rawRecordId).toBe(first.rawRecordId);
    expect(second.normalizedRecordIds).toEqual(first.normalizedRecordIds);
    expect(second.summaryRecordId).toBe(first.summaryRecordId);
    expect(second.writes).toEqual(['UNCHANGED', 'UNCHANGED', 'UNCHANGED']);
  });

  it('fails closed when the bytes no longer match the archived SourceDocument hash', async () => {
    const store = new MemoryVehicleMasterStore();
    const sourceDocument = sealVehicleMasterSourceDocument({
      sourceDocumentId: 'srcdoc_kia_parse_mismatch',
      sourceType: 'MANUFACTURER_OFFICIAL',
      sourceName: 'Kia Sorento fixture',
      sourceUrl: 'https://www.kia.com/kr/vehicles/sorento/price',
      publishedAt: null,
      observedAt: '2026-09-25T08:30:00.000Z',
      effectiveFrom: null,
      effectiveTo: null,
      storagePath: 'vehicle-master/source-documents/manufacturer_official/mismatch.html',
      sha256: 'a'.repeat(64),
      mimeType: 'text/html',
      metadata: {},
    });

    await expect(parseFetchedVehicleMasterSource(
      { store, parsers: [new KiaOfficialPriceParser()] },
      {
        sourceDocument,
        fetched: {
          requestedUrl: sourceDocument.sourceUrl!,
          finalUrl: sourceDocument.sourceUrl!,
          status: 200,
          contentType: sourceDocument.mimeType,
          bytes: html,
        },
      }
    )).rejects.toThrow('SOURCE_SHA_MISMATCH');
  });
});
