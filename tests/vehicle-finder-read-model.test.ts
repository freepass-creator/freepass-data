import { describe, expect, it } from 'vitest';
import {
  selectorRecordsFromNewcarMaster,
  selectorRecordsFromUsedcarMaster,
} from '../src/application/vehicle-selector-adapters.js';
import {
  VEHICLE_FINDER_UI_SCHEMA,
  createVehicleFinderReader,
} from '../src/application/vehicle-finder-read-model.js';
import type { EstimateNewcarMasterRecord } from '../src/domain/estimate-master.js';
import type { UsedcarMasterRecord } from '../src/domain/usedcar-master.js';

const newcar: EstimateNewcarMasterRecord = {
  productId: 'new_sorento_hybrid_noblesse',
  vehicleModelId: 'model_sorento',
  modelYearId: 'my_2027',
  trimId: 'trim_noblesse_2027',
  powertrainId: 'pt_hybrid_2027',
  maker: '기아',
  model: '쏘렌토',
  modelYear: 2027,
  trimName: '노블레스',
  powertrainName: '1.6 터보 하이브리드',
  basePrice: { amount: 42170000, currency: 'KRW' },
  priceBefore: null,
  priceAfter: null,
  priceBasis: null,
  options: [],
  exteriorColors: [],
  interiorColors: [],
  configuration: { drivetrain: '2WD', seats: 5, bodyConfiguration: null },
  status: 'ACTIVE',
  holdReasons: [],
};

const usedcar: UsedcarMasterRecord = {
  recordId: 'used_sorento_hybrid_noblesse_2021',
  vehicleModelId: 'model_sorento',
  generationId: 'gen_mq4',
  phaseId: 'phase_mq4_pre',
  modelYearId: 'my_2021',
  powertrainId: 'pt_hybrid_2021',
  variantId: 'variant_hybrid_2wd_5',
  trimId: 'trim_noblesse_2021',
  maker: '기아',
  model: '쏘렌토',
  generationName: '4세대 MQ4',
  phaseName: '초기형',
  modelYear: 2021,
  powertrainName: '1.6 터보 하이브리드',
  trimName: '노블레스',
  configuration: { fuelType: 'HYBRID', drivetrain: '2WD', seats: 5 },
  aliases: ['MQ4', '쏘렌토 하이브리드'],
  originalBasePriceHistory: [],
  lifecycleStatus: 'HISTORICAL',
  identityStatus: 'RESOLVED',
  holdReasons: [],
  sourceEvidenceIds: ['src_2021'],
};

function reader() {
  const byMode = {
    NEW_CAR: selectorRecordsFromNewcarMaster([newcar]),
    USED_CAR: selectorRecordsFromUsedcarMaster([usedcar]),
  };
  return createVehicleFinderReader({
    async loadRecords(mode) {
      return byMode[mode];
    },
    async loadObservation(mode) {
      return {
        observationId: 'obs_' + mode,
        observedAt: '2026-09-26T08:00:00.000Z',
        coverage: mode === 'NEW_CAR' ? 'COMPLETE' : 'PARTIAL',
        evidenceByRecordId: mode === 'USED_CAR'
          ? { [usedcar.recordId]: usedcar.sourceEvidenceIds }
          : {},
        sourcesByRecordId: mode === 'USED_CAR'
          ? { [usedcar.recordId]: [{ id: 'vehicle-master', label: 'Vehicle Master' }] }
          : {},
      };
    },
  });
}

describe('Vehicle Finder read model adapter', () => {
  it('feeds real NEW_CAR selector semantics into the U view contract', async () => {
    const read = reader();
    const view = await read({ mode: 'NEW_CAR', query: '쏘렌토 하이브리드', filters: {} });

    expect(view.schemaVersion).toBe(VEHICLE_FINDER_UI_SCHEMA);
    expect(view.mode).toBe('NEW_CAR');
    expect(view.presentation).toBe('GUIDED');
    expect(view.total).toBe(1);
    expect(view.items[0]).toMatchObject({
      id: newcar.productId,
      state: { code: 'ACTIVE', label: '선택 가능' },
      selectable: true,
    });
    expect(view.items[0]?.label).toContain('쏘렌토');
    expect(view.items[0]?.listLines.length).toBeLessThanOrEqual(2);
  });

  it('feeds real USED_CAR historical facets and evidence into the same U contract', async () => {
    const read = reader();
    const view = await read({ mode: 'USED_CAR', query: 'MQ4', filters: {} });

    expect(view.mode).toBe('USED_CAR');
    expect(view.presentation).toBe('SEARCH_FILTER');
    expect(view.coverage).toBe('PARTIAL');
    expect(view.total).toBe(1);
    expect(view.facets.map((facet) => facet.axis)).toContain('modelYear');
    expect(view.facets.map((facet) => facet.axis)).toContain('generation');
    expect(view.items[0]?.evidenceIds).toEqual(['src_2021']);
    expect(view.items[0]?.sources).toEqual([{ id: 'vehicle-master', label: 'Vehicle Master' }]);
  });

  it('round-trips opaque facet keys back into the real selector selection', async () => {
    const read = reader();
    const first = await read({ mode: 'USED_CAR', query: '', filters: {} });
    const yearFacet = first.facets.find((facet) => facet.axis === 'modelYear');
    const year = yearFacet?.options[0];
    expect(year?.key).toMatch(/^vf1\./);

    const filtered = await read({
      mode: 'USED_CAR',
      query: '',
      filters: { modelYear: year!.key },
    });

    expect(filtered.total).toBe(1);
    expect(filtered.items[0]?.id).toBe(usedcar.recordId);
  });

  it('fails closed on malformed or cross-axis filter tokens', async () => {
    const read = reader();
    const first = await read({ mode: 'USED_CAR', query: '', filters: {} });
    const year = first.facets.find((facet) => facet.axis === 'modelYear')?.options[0]?.key;
    await expect(read({
      mode: 'USED_CAR',
      query: '',
      filters: { trim: year! },
    })).rejects.toThrow('INVALID_VEHICLE_FINDER_FILTER_TOKEN');

    await expect(read({
      mode: 'USED_CAR',
      query: '',
      filters: { modelYear: 'not-a-token' },
    })).rejects.toThrow('INVALID_VEHICLE_FINDER_FILTER_TOKEN');
  });

  it('surfaces F no-result semantics without reimplementing search rules', async () => {
    const read = reader();
    const view = await read({
      mode: 'USED_CAR',
      query: '존재하지않는검색어',
      filters: {},
    });

    expect(view.total).toBe(0);
    expect(view.guidance.resolutionStatus).toBe('NO_RESULT');
    expect(view.guidance.noResultReason).toBe('UNRECOGNIZED_SEARCH');
    expect(view.guidance.noResultLabel).toBe('검색어를 확인할 수 없음');
  });
});
