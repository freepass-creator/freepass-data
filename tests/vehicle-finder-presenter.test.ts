import { describe, expect, it } from 'vitest';
import {
  selectorRecordsFromNewcarMaster,
  selectorRecordsFromUsedcarMaster,
} from '../src/application/vehicle-selector-adapters.js';
import { presentVehicleSelectorResult } from '../src/application/vehicle-finder-presenter.js';
import {
  applyVehicleGroupDrilldown,
  selectVehicles,
} from '../src/domain/vehicle-selector.js';
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

function display(recordId: string, label: string) {
  return {
    [recordId]: {
      label,
      pathText: '기아 › 쏘렌토 › 노블레스',
      nodeTypeLabel: '트림',
      listLines: ['하이브리드 · 2WD', '노블레스'],
      facts: [
        { label: '트림', value: '노블레스', unknown: false },
      ],
      evidenceIds: ['evidence-1'],
      sources: [{ id: 'source-1', label: '실제 selector projection test' }],
    },
  };
}

describe('Vehicle Finder presenter over actual selector result', () => {
  it('preserves F-owned NEW_CAR action and guidance semantics', () => {
    const result = selectVehicles(selectorRecordsFromNewcarMaster([newcar]), {
      mode: 'NEW_CAR',
      searchText: '쏘렌토 하이브리드',
    });

    const view = presentVehicleSelectorResult({
      result,
      presentation: 'GUIDED',
      observation: {
        id: 'obs-new-1',
        observedAt: '2026-09-26T08:00:00.000Z',
        coverage: 'COMPLETE',
      },
      facets: [
        {
          axis: 'model',
          label: '모델',
          options: [{ key: 'model_sorento', label: '쏘렌토', count: 1 }],
        },
      ],
      displayByRecordId: display(newcar.productId, '기아 쏘렌토'),
    });

    expect(view.mode).toBe('NEW_CAR');
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.action.code).toBe(result.candidates[0]?.action);
    expect(view.items[0]?.state.code).toBe(result.candidates[0]?.actionState);
    expect(view.items[0]?.selectable).toBe(result.candidates[0]?.selectable);
    expect(view.guidance.resolutionStatus).toBe(result.guidance.resolutionStatus);
    expect(view.items[0]?.listLines).toEqual(['하이브리드 · 2WD', '노블레스']);
  });

  it('preserves USED_CAR historical selection semantics without building a second master', () => {
    const result = selectVehicles(selectorRecordsFromUsedcarMaster([usedcar]), {
      mode: 'USED_CAR',
      selection: { modelYear: 2021, model: '쏘렌토' },
    });

    const view = presentVehicleSelectorResult({
      result,
      presentation: 'SEARCH_FILTER',
      observation: {
        id: 'obs-used-1',
        observedAt: '2026-09-26T08:01:00.000Z',
        coverage: 'COMPLETE',
      },
      facets: [
        {
          axis: 'modelYear',
          label: '연식',
          options: [{ key: 'my_2021', label: '2021', count: 1 }],
        },
      ],
      displayByRecordId: display(usedcar.recordId, '기아 쏘렌토 2021'),
    });

    expect(view.mode).toBe('USED_CAR');
    expect(view.items[0]?.id).toBe(usedcar.recordId);
    expect(view.items[0]?.selectable).toBe(true);
    expect(view.facets[0]?.axis).toBe('modelYear');
  });

  it('surfaces F-owned NO_RESULT diagnosis without inventing a replacement reason', () => {
    const result = selectVehicles(selectorRecordsFromUsedcarMaster([usedcar]), {
      mode: 'USED_CAR',
      searchText: '존재하지않는검색어',
    });

    const view = presentVehicleSelectorResult({
      result,
      presentation: 'SEARCH_FILTER',
      observation: {
        id: 'obs-zero-1',
        observedAt: '2026-09-26T08:02:00.000Z',
        coverage: 'COMPLETE',
      },
      facets: [],
      displayByRecordId: {},
    });

    expect(result.guidance.resolutionStatus).toBe('NO_RESULT');
    expect(result.guidance.noResultReason).toBe('UNRECOGNIZED_SEARCH');
    expect(view.guidance.noResultReason).toBe(result.guidance.noResultReason);
    expect(view.guidance.noResultTitle).toContain('검색어');
    expect(view.items).toHaveLength(0);
  });

  it('fails closed when selector candidate display evidence is missing', () => {
    const result = selectVehicles(selectorRecordsFromNewcarMaster([newcar]), {
      mode: 'NEW_CAR',
    });

    expect(() =>
      presentVehicleSelectorResult({
        result,
        presentation: 'GUIDED',
        observation: {
          id: 'obs-missing-display',
          observedAt: '2026-09-26T08:03:00.000Z',
          coverage: 'COMPLETE',
        },
        facets: [],
        displayByRecordId: {},
      })
    ).toThrow('MISSING_VEHICLE_FINDER_DISPLAY');
  });
});


describe('Vehicle Finder presenter candidate groups', () => {
  it('preserves F-owned group membership, counts and suggested drilldown', () => {
    const adapted = selectorRecordsFromUsedcarMaster([usedcar])[0]!;
    const base = {
      ...adapted,
      maker: { id: 'maker_kia', label: '기아' },
    };
    const second = {
      ...base,
      recordId: 'used_sorento_signature_2024',
      modelYear: { id: 'my_2024', label: '2024', value: 2024 },
      trim: { id: 'trim_signature_2024', label: '시그니처' },
    };
    const result = selectVehicles([base, second], {
      mode: 'USED_CAR',
      searchText: '쏘렌토',
    });
    const group = result.groups[0]!;
    expect(group.candidateCount).toBe(2);
    expect(group.expandable).toBe(true);

    const view = presentVehicleSelectorResult({
      result,
      presentation: 'SEARCH_FILTER',
      observation: {
        id: 'obs-group-1',
        observedAt: '2026-09-26T08:04:00.000Z',
        coverage: 'COMPLETE',
      },
      facets: [
        {
          axis: 'modelYear',
          label: '연식',
          options: [
            { key: 'my_2021', label: '2021', count: 1 },
            { key: 'my_2024', label: '2024', count: 1 },
          ],
        },
        {
          axis: 'trim',
          label: '트림',
          options: [
            { key: 'trim_noblesse_2021', label: '노블레스', count: 1 },
            { key: 'trim_signature_2024', label: '시그니처', count: 1 },
          ],
        },
      ],
      displayByRecordId: {
        ...display(base.recordId, '쏘렌토 · 노블레스'),
        ...display(second.recordId, '쏘렌토 · 시그니처'),
      },
    });

    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]?.memberIds).toEqual(group.memberRecordIds);
    expect(view.groups[0]?.candidateCount).toBe(group.candidateCount);
    expect(view.groups[0]?.representativeId).toBe(group.representativeRecordId);
    expect(view.groups[0]?.suggestedDrilldownAxis).toBe(group.suggestedDrilldownAxis);
    if (group.suggestedDrilldownAxis === 'modelYear') {
      expect(view.groups[0]?.suggestedDrilldownLabel).toBe('연식');
    }
  });
});


describe('Vehicle Finder group drilldown presentation contract', () => {
  it('preserves F drilldown options without recalculating discrimination', () => {
    const adapted = selectorRecordsFromUsedcarMaster([usedcar])[0]!;
    const base = {
      ...adapted,
      maker: { id: 'maker_kia', label: '기아' },
    };
    const second = {
      ...base,
      recordId: 'used_sorento_signature_2024',
      modelYear: { id: 'my_2024', label: '2024', value: 2024 },
      trim: { id: 'trim_signature_2024', label: '시그니처' },
    };
    const result = selectVehicles([base, second], {
      mode: 'USED_CAR',
      searchText: '쏘렌토',
    });
    const group = result.groups[0]!;
    const view = presentVehicleSelectorResult({
      result,
      presentation: 'SEARCH_FILTER',
      observation: {
        id: 'obs-drilldown-1',
        observedAt: '2026-09-26T09:00:00.000Z',
        coverage: 'COMPLETE',
      },
      facets: [
        {
          axis: 'modelYear',
          label: '연식',
          options: [
            { key: 'opaque-2021', label: '2021', count: 1 },
            { key: 'opaque-2024', label: '2024', count: 1 },
          ],
        },
        {
          axis: 'trim',
          label: '트림',
          options: [
            { key: 'opaque-noblesse', label: '노블레스', count: 1 },
            { key: 'opaque-signature', label: '시그니처', count: 1 },
          ],
        },
      ],
      displayByRecordId: {
        ...display(base.recordId, '쏘렌토 · 노블레스'),
        ...display(second.recordId, '쏘렌토 · 시그니처'),
      },
    });

    const presented = view.groups[0]!;
    expect(presented.drilldowns.map((item) => item.axis))
      .toEqual(group.drilldownAxes.map((item) => item.axis));
    expect(presented.drilldowns[0]?.options)
      .toEqual(group.drilldownAxes[0]?.options);
    expect(presented.suggestedDrilldownAxis).toBe(group.suggestedDrilldownAxis);
  });
});


describe('Vehicle Finder presented drilldown compatibility with F transition', () => {
  it('round-trips a presented F option back through applyVehicleGroupDrilldown', () => {
    const adapted = selectorRecordsFromUsedcarMaster([usedcar])[0]!;
    const base = {
      ...adapted,
      maker: { id: 'maker_kia', label: '기아' },
    };
    const second = {
      ...base,
      recordId: 'used_sorento_signature_2024',
      modelYear: { id: 'my_2024', label: '2024', value: 2024 },
      trim: { id: 'trim_signature_2024', label: '시그니처' },
    };
    const records = [base, second];
    const result = selectVehicles(records, {
      mode: 'USED_CAR',
      searchText: '쏘렌토',
    });
    const group = result.groups[0]!;
    const drilldown = group.drilldownAxes[0]!;
    const option = drilldown.options[0]!;

    const transition = applyVehicleGroupDrilldown(
      records,
      { mode: 'USED_CAR', searchText: '쏘렌토' },
      {},
      group.groupId,
      drilldown.axis,
      option,
    );

    expect(transition.status).toBe('APPLIED');
    expect(transition.beforeCandidateCount).toBe(2);
    expect(transition.afterCandidateCount).toBeLessThan(2);
  });
});


describe('Vehicle Finder UNKNOWN / HOLD reason presentation', () => {
  it('translates only F-owned candidate reason codes and preserves unresolved evidence', () => {
    const partial = selectorRecordsFromUsedcarMaster([usedcar])[0]!;
    const rows = [{
      ...partial,
      identityStatus: 'PARTIAL' as const,
      seats: { id: null, label: null, value: null },
    }];
    const result = selectVehicles(rows, {
      mode: 'USED_CAR',
      selection: { model: '쏘렌토', seats: 7 },
    });
    const candidate = result.candidates[0]!;
    expect(candidate.action).toBe('INSPECT_ONLY');
    expect(candidate.actionReasons).toEqual(
      expect.arrayContaining(['IDENTITY_PARTIAL', 'UNRESOLVED_SELECTION']),
    );

    const view = presentVehicleSelectorResult({
      result,
      presentation: 'SEARCH_FILTER',
      observation: {
        id: 'obs-reason-unknown',
        observedAt: '2026-09-26T10:00:00.000Z',
        coverage: 'COMPLETE',
      },
      facets: [{ axis: 'seats', label: '인승', options: [] }],
      displayByRecordId: display(partial.recordId, '기아 쏘렌토'),
    });

    expect(view.items[0]?.action.reasonDetails.map((item) => item.code))
      .toEqual(candidate.actionReasons);
    expect(view.items[0]?.unresolved.axes).toEqual([
      { code: 'seats', label: '인승' },
    ]);
  });

  it('keeps HOLD lifecycle/identity reasons visible as separate codes', () => {
    const base = selectorRecordsFromUsedcarMaster([usedcar])[0]!;
    const hold = {
      ...base,
      lifecycle: 'HOLD' as const,
      identityStatus: 'HOLD' as const,
    };
    const result = selectVehicles([hold], {
      mode: 'USED_CAR',
      selection: { model: '쏘렌토' },
      includeHold: true,
    });
    const view = presentVehicleSelectorResult({
      result,
      presentation: 'SEARCH_FILTER',
      observation: {
        id: 'obs-reason-hold',
        observedAt: '2026-09-26T10:01:00.000Z',
        coverage: 'COMPLETE',
      },
      facets: [],
      displayByRecordId: display(hold.recordId, '기아 쏘렌토 HOLD'),
    });

    expect(view.items[0]?.action.code).toBe('BLOCKED');
    expect(view.items[0]?.action.reasonDetails.map((item) => item.code))
      .toEqual(expect.arrayContaining(['LIFECYCLE_HOLD', 'IDENTITY_HOLD']));
    expect(view.items[0]?.action.reasonDetails.every((item) => item.nextStep.length > 0))
      .toBe(true);
  });
});
