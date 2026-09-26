import { describe, expect, it } from 'vitest';
import {
  selectVehiclesFromNewcarMaster,
  selectVehiclesFromUsedcarMaster,
  selectorRecordsFromNewcarMaster,
  selectorRecordsFromUsedcarMaster,
} from '../src/application/vehicle-selector-adapters.js';
import {
  applyVehicleGroupSelection,
  selectVehicles,
} from '../src/domain/vehicle-selector.js';
import type { EstimateNewcarMasterRecord } from '../src/domain/estimate-master.js';
import {
  usedcarMasterToSelectorRecord,
  type UsedcarMasterRecord,
} from '../src/domain/usedcar-master.js';

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
  configuration: {
    drivetrain: '2WD',
    seats: 5,
    bodyConfiguration: null,
  },
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
  configuration: {
    fuelType: 'HYBRID',
    drivetrain: '2WD',
    seats: 5,
  },
  aliases: ['MQ4', '쏘렌토 하이브리드'],
  originalBasePriceHistory: [],
  lifecycleStatus: 'HISTORICAL',
  identityStatus: 'RESOLVED',
  holdReasons: [],
  sourceEvidenceIds: ['src_2021'],
};

describe('vehicle selector adapters', () => {
  it('uses one canonical used-car to selector mapping path', () => {
    const direct = usedcarMasterToSelectorRecord(usedcar);
    const adapted = selectorRecordsFromUsedcarMaster([usedcar]);

    expect(adapted).toEqual([direct]);
    expect(adapted[0]).toMatchObject({
      recordId: usedcar.recordId,
      maker: { id: null, label: '기아' },
      model: { id: 'model_sorento', label: '쏘렌토' },
      generation: { id: 'gen_mq4', label: '4세대 MQ4' },
      trim: { id: 'trim_noblesse_2021', label: '노블레스' },
    });
  });

  it('runs new-car and used-car through the same selector semantics', () => {
    const newResult = selectVehicles(
      selectorRecordsFromNewcarMaster([newcar]),
      {
        mode: 'NEW_CAR',
        selection: {
          powertrain: '하이브리드',
          trim: '노블레스',
          model: '쏘렌토',
        },
      }
    );

    const usedResult = selectVehicles(
      selectorRecordsFromUsedcarMaster([usedcar]),
      {
        mode: 'USED_CAR',
        selection: {
          powertrain: '하이브리드',
          trim: '노블레스',
          model: '쏘렌토',
        },
      }
    );

    expect(newResult.candidates.map((x) => x.record.recordId)).toEqual([
      'new_sorento_hybrid_noblesse',
    ]);
    expect(usedResult.candidates.map((x) => x.record.recordId)).toEqual([
      'used_sorento_hybrid_noblesse_2021',
    ]);
  });

  it('allows powertrain-first selection for both modes', () => {
    const newResult = selectVehicles(
      selectorRecordsFromNewcarMaster([newcar]),
      { mode: 'NEW_CAR', selection: { powertrainId: 'pt_hybrid_2027' } }
    );
    const usedResult = selectVehicles(
      selectorRecordsFromUsedcarMaster([usedcar]),
      { mode: 'USED_CAR', selection: { powertrainId: 'pt_hybrid_2021' } }
    );

    expect(newResult.candidates).toHaveLength(1);
    expect(usedResult.candidates).toHaveLength(1);
  });

  it('groups real new-car adapter records by stable model ID without inventing generation', () => {
    const signature: EstimateNewcarMasterRecord = {
      ...newcar,
      productId: 'new_sorento_hybrid_signature',
      trimId: 'trim_signature_2027',
      trimName: '시그니처',
    };

    const result = selectVehicles(
      selectorRecordsFromNewcarMaster([newcar, signature]),
      { mode: 'NEW_CAR', searchText: '쏘렌토' }
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      scope: 'MODEL',
      model: { id: 'model_sorento', label: '쏘렌토' },
      candidateCount: 2,
      expandable: true,
    });
    expect(result.groups[0]?.generation.id).toBeNull();

    const transition = applyVehicleGroupSelection(
      selectorRecordsFromNewcarMaster([newcar, signature]),
      { mode: 'NEW_CAR', searchText: '쏘렌토' },
      {},
      result.groups[0]!.groupId
    );
    expect(transition.status).toBe('APPLIED');
    expect(transition.selection).toMatchObject({
      maker: '기아',
      modelId: 'model_sorento',
      model: '쏘렌토',
    });
    expect(transition.selection.makerId).toBeUndefined();
    expect(transition.selection.generationId).toBeUndefined();
    expect(transition.result.candidates).toHaveLength(2);
  });

  it('groups real used-car adapter records by model and generation without requiring maker ID', () => {
    const signature: UsedcarMasterRecord = {
      ...usedcar,
      recordId: 'used_sorento_hybrid_signature_2021',
      trimId: 'trim_signature_2021',
      trimName: '시그니처',
    };
    const previousGeneration: UsedcarMasterRecord = {
      ...usedcar,
      recordId: 'used_sorento_um_2020',
      generationId: 'gen_um',
      generationName: '3세대 UM',
      phaseId: 'phase_um_fl',
      phaseName: '페이스리프트',
      modelYearId: 'my_2020',
      modelYear: 2020,
      powertrainId: 'pt_diesel_2020',
      powertrainName: '2.2 디젤',
      trimId: 'trim_prestige_2020',
      trimName: '프레스티지',
    };

    const records = selectorRecordsFromUsedcarMaster([
      usedcar,
      signature,
      previousGeneration,
    ]);
    const result = selectVehicles(records, {
      mode: 'USED_CAR',
      searchText: '쏘렌토',
    });

    expect(result.groups).toHaveLength(2);
    const mq4 = result.groups.find(
      (group) => group.generation.id === 'gen_mq4'
    );
    expect(mq4).toMatchObject({
      scope: 'MODEL_GENERATION',
      model: { id: 'model_sorento', label: '쏘렌토' },
      generation: { id: 'gen_mq4', label: '4세대 MQ4' },
      candidateCount: 2,
    });

    const transition = applyVehicleGroupSelection(
      records,
      { mode: 'USED_CAR', searchText: '쏘렌토' },
      {},
      mq4!.groupId
    );
    expect(transition.status).toBe('APPLIED');
    expect(transition.selection).toMatchObject({
      maker: '기아',
      modelId: 'model_sorento',
      generationId: 'gen_mq4',
    });
    expect(transition.selection.makerId).toBeUndefined();
    expect(transition.result.candidates).toHaveLength(2);
  });

  it('keeps used-car rows with missing generation isolated instead of merging them by model', () => {
    const partialA: UsedcarMasterRecord = {
      ...usedcar,
      recordId: 'used_partial_a',
      generationId: null,
      generationName: null,
      phaseId: null,
      phaseName: null,
      modelYearId: null,
      modelYear: null,
      powertrainId: null,
      variantId: null,
      trimId: null,
      powertrainName: null,
      trimName: null,
      identityStatus: 'PARTIAL',
    };
    const partialB: UsedcarMasterRecord = {
      ...partialA,
      recordId: 'used_partial_b',
    };

    const result = selectVehicles(
      selectorRecordsFromUsedcarMaster([partialA, partialB]),
      { mode: 'USED_CAR', searchText: '쏘렌토' }
    );

    expect(result.groups).toHaveLength(2);
    expect(result.groups.every(
      (group) => group.scope === 'UNRESOLVED_IDENTITY'
    )).toBe(true);
    expect(result.groups.every((group) => group.candidateCount === 1)).toBe(true);
  });

  it('provides one official full-selector entrypoint for Estimate new-car master', () => {
    const signature: EstimateNewcarMasterRecord = {
      ...newcar,
      productId: 'new_sorento_hybrid_signature',
      trimId: 'trim_signature_2027',
      trimName: '시그니처',
    };

    const result = selectVehiclesFromNewcarMaster(
      [newcar, signature],
      {
        searchText: '쏘렌토',
        selection: { powertrain: '하이브리드' },
      }
    );

    expect(result.mode).toBe('NEW_CAR');
    expect(result.candidates.map((item) => item.record.recordId)).toEqual([
      'new_sorento_hybrid_noblesse',
      'new_sorento_hybrid_signature',
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      scope: 'MODEL',
      candidateCount: 2,
    });
    expect(result.facets.trim.map((item) => item.label)).toEqual([
      '노블레스',
      '시그니처',
    ]);
  });

  it('provides the same full-selector contract for used-car master consumption', () => {
    const signature: UsedcarMasterRecord = {
      ...usedcar,
      recordId: 'used_sorento_hybrid_signature_2021',
      trimId: 'trim_signature_2021',
      trimName: '시그니처',
    };

    const result = selectVehiclesFromUsedcarMaster(
      [usedcar, signature],
      {
        searchText: '쏘렌토',
        selection: { modelYear: 2021 },
      }
    );

    expect(result.mode).toBe('USED_CAR');
    expect(result.candidates).toHaveLength(2);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      scope: 'MODEL_GENERATION',
      candidateCount: 2,
    });
  });

  it('keeps master wrappers semantically identical to direct selector execution', () => {
    const newDirect = selectVehicles(
      selectorRecordsFromNewcarMaster([newcar]),
      {
        mode: 'NEW_CAR',
        selection: { trim: '노블레스' },
      }
    );
    const newWrapped = selectVehiclesFromNewcarMaster(
      [newcar],
      { selection: { trim: '노블레스' } }
    );
    expect(newWrapped).toEqual(newDirect);

    const usedDirect = selectVehicles(
      selectorRecordsFromUsedcarMaster([usedcar]),
      {
        mode: 'USED_CAR',
        selection: { trim: '노블레스' },
      }
    );
    const usedWrapped = selectVehiclesFromUsedcarMaster(
      [usedcar],
      { selection: { trim: '노블레스' } }
    );
    expect(usedWrapped).toEqual(usedDirect);
  });

  it('keeps historical year available only in used-car mode data', () => {
    const result = selectVehicles(
      selectorRecordsFromUsedcarMaster([usedcar]),
      { mode: 'USED_CAR', selection: { modelYear: 2021 } }
    );

    expect(result.candidates[0]?.record.modelYear.value).toBe(2021);
    expect(result.facets.powertrain[0]?.label).toBe('1.6 터보 하이브리드');
  });
});
