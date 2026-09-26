import { describe, expect, it } from 'vitest';
import {
  selectorRecordsFromNewcarMaster,
  selectorRecordsFromUsedcarMaster,
} from '../src/application/vehicle-selector-adapters.js';
import { selectVehicles } from '../src/domain/vehicle-selector.js';
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

  it('keeps historical year available only in used-car mode data', () => {
    const result = selectVehicles(
      selectorRecordsFromUsedcarMaster([usedcar]),
      { mode: 'USED_CAR', selection: { modelYear: 2021 } }
    );

    expect(result.candidates[0]?.record.modelYear.value).toBe(2021);
    expect(result.facets.powertrain[0]?.label).toBe('1.6 터보 하이브리드');
  });
});
