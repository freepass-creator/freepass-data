import { describe, expect, it } from 'vitest';
import {
  buildEstimateNewcarMaster,
  buildEstimateNewcarMasterRecord,
  type EstimateMasterCandidate,
} from '../src/application/estimate-master.js';

function candidate(overrides: Partial<EstimateMasterCandidate> = {}): EstimateMasterCandidate {
  return {
    productId: 'prod_1',
    vehicleModelId: 'vm_1',
    modelYearId: 'my_2026',
    trimId: 'trim_1',
    powertrainId: 'pt_1',
    maker: '기아',
    model: '니로',
    modelYear: 2026,
    trimName: '시그니처',
    powertrainName: '1.6 하이브리드',
    basePrice: { amount: 35020000, currency: 'KRW' },
    options: [{
      optionId: 'opt_1',
      name: '드라이브 와이즈',
      price: { amount: 700000, currency: 'KRW' },
      requires: [],
      excludes: [],
      exclusiveGroupId: null
    }],
    exteriorColors: [{
      colorId: 'ext_1',
      name: '화이트',
      code: null,
      price: { amount: 80000, currency: 'KRW' }
    }],
    interiorColors: [{
      colorId: 'int_1',
      name: '블랙',
      code: null,
      price: { amount: 0, currency: 'KRW' }
    }],
    configuration: { drivetrain: 'FWD', seats: 5, bodyConfiguration: null },
    ...overrides
  };
}

describe('Estimate new-car master builder', () => {
  it('publishes reviewed complete evidence as ACTIVE without inventing values', () => {
    const record = buildEstimateNewcarMasterRecord(candidate());
    expect(record.status).toBe('ACTIVE');
    expect(record.modelYear).toBe(2026);
    expect(record.modelYearId).toBe('my_2026');
    expect(record.holdReasons).toEqual([]);
  });

  it('turns the current legacy shape into explicit HOLD when model year/stable IDs are absent', () => {
    const record = buildEstimateNewcarMasterRecord(candidate({
      vehicleModelId: null,
      modelYearId: null,
      trimId: null,
      powertrainId: null,
      modelYear: null,
      options: [{
        optionId: null,
        name: '드라이브 와이즈',
        price: { amount: 700000, currency: 'KRW' },
        requires: [],
        excludes: []
      }],
      exteriorColors: [{
        colorId: null,
        name: '화이트',
        price: { amount: 80000, currency: 'KRW' }
      }],
    }));
    expect(record.status).toBe('HOLD');
    expect(record.modelYear).toBeNull();
    expect(record.modelYearId).toBeNull();
    expect(record.holdReasons).toEqual(expect.arrayContaining([
      'VEHICLE_MODEL_ID_UNVERIFIED',
      'MODEL_YEAR_ID_UNVERIFIED',
      'MODEL_YEAR_UNVERIFIED',
      'TRIM_ID_UNVERIFIED',
      'POWERTRAIN_ID_UNVERIFIED',
      'OPTION_ID_UNVERIFIED',
      'COLOR_ID_UNVERIFIED'
    ]));
    expect(record.holdReasons).not.toContain('YEAR_DEFAULT_2026');
  });

  it('never repairs missing model year from the current calendar year', () => {
    const record = buildEstimateNewcarMasterRecord(candidate({
      modelYear: null,
      modelYearId: null,
    }));
    expect(record.modelYear).toBeNull();
    expect(record.status).toBe('HOLD');
    expect(record.holdReasons).toContain('MODEL_YEAR_UNVERIFIED');
  });

  it('converts option-rule defects into a HOLD reason instead of silently dropping the rule', () => {
    const record = buildEstimateNewcarMasterRecord(candidate({
      options: [{
        optionId: 'opt_1',
        name: '드라이브 와이즈',
        price: { amount: 700000, currency: 'KRW' },
        requires: ['opt_missing'],
        excludes: []
      }]
    }));
    expect(record.status).toBe('HOLD');
    expect(record.holdReasons).toContain('OPTION_REQUIRES_UNKNOWN');
  });

  it('rejects duplicate product IDs across the release set', () => {
    expect(() => buildEstimateNewcarMaster([candidate(), candidate({ trimId: 'trim_2' })]))
      .toThrow('DUPLICATE_PRODUCT_ID');
  });

  it('rejects invalid money instead of coercing it', () => {
    expect(() => buildEstimateNewcarMasterRecord(candidate({
      basePrice: { amount: -1, currency: 'KRW' }
    }))).toThrow('basePrice');
  });
});
