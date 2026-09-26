import { describe, expect, it } from 'vitest';
import {
  buildVehicleMasterCoverage,
  findCoverageForHint,
} from '../src/application/vehicle-master-coverage.js';
import {
  sealVehicleMasterPipelineRecord,
  sealVehicleMasterSourceDocument,
} from '../src/domain/vehicle-master.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';

const observedAt = '2026-09-26T00:00:00.000Z';

async function source(
  store: MemoryVehicleMasterStore,
  id: string,
  type: Parameters<typeof sealVehicleMasterSourceDocument>[0]['sourceType'],
  url: string,
  sha: string
) {
  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId: id,
    sourceType: type,
    sourceName: id,
    sourceUrl: url,
    publishedAt: null,
    observedAt,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath: `vehicle-master/test/${id}.html`,
    sha256: sha.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  }));
}

async function normalized(
  store: MemoryVehicleMasterStore,
  sourceDocumentId: string,
  id: string,
  input: {
    maker: string;
    model: string;
    modelYear: number;
    powertrainName: string;
    trimName: string;
  }
) {
  await store.putPipelineRecord(sealVehicleMasterPipelineRecord({
    recordId: id,
    kind: 'NORMALIZED_RECORD',
    sourceDocumentId,
    observedAt,
    payload: {
      recordKind: 'TRIM',
      parserId: 'fixture',
      parserVersion: '1',
      record: {
        ...input,
        drivetrain: '2WD',
        seats: 5,
      },
    },
  }));
}

describe('vehicle master coverage ledger', () => {
  it('counts independent provider origins rather than repeated captures', async () => {
    const store = new MemoryVehicleMasterStore();
    await source(store, 'carnoon-a', 'CARNOON', 'https://www.carnoon.co.kr/a', 'a');
    await source(store, 'carnoon-b', 'CARNOON', 'https://www.carnoon.co.kr/b', 'b');
    await normalized(store, 'carnoon-a', 'n1', {
      maker: '기아', model: '쏘렌토', modelYear: 2027,
      powertrainName: '2.5 가솔린 터보', trimName: '프레스티지',
    });
    await normalized(store, 'carnoon-b', 'n2', {
      maker: '기아', model: '쏘렌토', modelYear: 2027,
      powertrainName: '2.5 가솔린 터보', trimName: '노블레스',
    });

    const rows = await buildVehicleMasterCoverage(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceOrigins).toEqual(['CARNOON']);
    expect(rows[0]?.status).toBe('SINGLE_SOURCE');
    expect(rows[0]?.normalizedRecordCount).toBe(2);
  });

  it('marks two independent structured providers as corroborated', async () => {
    const store = new MemoryVehicleMasterStore();
    await source(store, 'carnoon', 'CARNOON', 'https://www.carnoon.co.kr/a', 'c');
    await source(store, 'danawa', 'DANAWA', 'https://auto.danawa.com/a', 'd');
    for (const [sourceDocumentId, id] of [['carnoon', 'n1'], ['danawa', 'n2']] as const) {
      await normalized(store, sourceDocumentId, id, {
        maker: '현대', model: '코나', modelYear: 2027,
        powertrainName: '1.6 하이브리드', trimName: '모던',
      });
    }

    const rows = await buildVehicleMasterCoverage(store);
    expect(rows[0]?.status).toBe('CORROBORATED');
    expect(rows[0]?.sourceOrigins).toEqual(['CARNOON', 'DANAWA']);
  });

  it('marks manufacturer evidence as official even with one origin', async () => {
    const store = new MemoryVehicleMasterStore();
    await source(store, 'official', 'MANUFACTURER_OFFICIAL', 'https://www.kia.com/a', 'e');
    await normalized(store, 'official', 'n1', {
      maker: '기아', model: '쏘렌토', modelYear: 2027,
      powertrainName: '2.5 가솔린 터보', trimName: '프레스티지',
    });

    const rows = await buildVehicleMasterCoverage(store);
    expect(rows[0]?.status).toBe('OFFICIAL');
  });

  it('finds coverage from a noisy discovery model hint', async () => {
    const store = new MemoryVehicleMasterStore();
    await source(store, 'official', 'MANUFACTURER_OFFICIAL', 'https://www.kia.com/a', 'f');
    await normalized(store, 'official', 'n1', {
      maker: '기아', model: '쏘렌토', modelYear: 2027,
      powertrainName: '2.5 가솔린 터보', trimName: '프레스티지',
    });

    const rows = await buildVehicleMasterCoverage(store);
    expect(findCoverageForHint(rows, '더 뉴 쏘렌토 27년형 8월 출시', 2027)?.status)
      .toBe('OFFICIAL');
  });
});
