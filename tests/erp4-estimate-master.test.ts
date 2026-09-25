import { describe, expect, it } from 'vitest';
import {
  mapLegacyNewcarFeedToEstimateMaster,
  permanentIdentityOf,
} from '../src/adapters/erp4-estimate-master.js';

const master = {
  trim_row_key: 'mf-002.md-036.sm-ka4-pe-xline-2026__carnival-x-line::v02::t01',
  master_id: 'mf-002.md-036.sm-ka4-pe-xline-2026__carnival-x-line',
  powertrain_seq: 2,
  trim_seq: 1,
  usage_tier: 'automatic' as const,
  market_status: '신차' as const,
  maker: '기아',
  model: '카니발',
  sub_model: '2026 카니발 X-Line KA4',
  powertrain: '하이브리드 1.6T 2WD',
  trim: 'X-Line 7인승',
  model_year_start: '2026',
  model_year_end: '2026',
  drivetrain: '2WD',
  seats: 7,
  body_configuration: '승용',
};

const feed = {
  id: 'kia_carnival_xline_7_hev',
  trimKey: master.trim_row_key,
  maker: '기아',
  sub_model: '카니발',
  fuel: '하이브리드 1.6T 2WD',
  trim: 'X-Line 7인승',
  priceBefore: 52000000,
  priceAfter: 51500000,
  priceBasis: '세제혜택 후',
  optionsMaster: {
    sunroof: { name: '선루프', price: 1200000 },
    drivewise: { name: '드라이브 와이즈', price: 700000, requires: ['sunroof'] },
  },
  availableOptions: ['sunroof', 'drivewise'],
  impliedOptions: [],
  optionExcludes: { sunroof: [] },
  exclusiveGroups: [],
  extColors: [{ name: '스노우 화이트 펄', code: 'SWP', price: 80000 }],
  intColors: [{ name: '차콜', code: 'CCH', price: 0 }],
};

describe('ERP4 reviewed master -> Estimate master migration adapter', () => {
  it('promotes only the permanent key structure into stable IDs', () => {
    expect(permanentIdentityOf(master)).toEqual({
      vehicleModelId: 'mf-002.md-036',
      trimId: master.trim_row_key,
      powertrainId: 'mf-002.md-036.sm-ka4-pe-xline-2026__carnival-x-line::v02',
      subModelId: master.master_id,
      issue: null,
    });
  });

  it('builds ACTIVE when trim key, exact MY, prices, option keys and color codes are all proven', () => {
    const record = mapLegacyNewcarFeedToEstimateMaster(feed, [master]);
    expect(record.status).toBe('ACTIVE');
    expect(record.vehicleModelId).toBe('mf-002.md-036');
    expect(record.modelYearId).toBe(`${master.master_id}::my2026`);
    expect(record.powertrainId).toBe(`${master.master_id}::v02`);
    expect(record.trimId).toBe(master.trim_row_key);
    expect(record.basePrice.amount).toBe(52000000);
    expect(record.priceBefore?.amount).toBe(52000000);
    expect(record.priceAfter?.amount).toBe(51500000);
    expect(record.options.map((option) => option.optionId)).toEqual([
      `${master.trim_row_key}::opt:sunroof`,
      `${master.trim_row_key}::opt:drivewise`,
    ]);
    expect(record.exteriorColors[0]?.colorId).toBe(`${master.trim_row_key}::ext:SWP`);
    expect(record.interiorColors[0]?.colorId).toBe(`${master.trim_row_key}::int:CCH`);
  });

  it('does not choose the latest year from a multi-year master range', () => {
    const record = mapLegacyNewcarFeedToEstimateMaster(feed, [{
      ...master,
      model_year_start: '2024',
      model_year_end: '현재',
    }]);
    expect(record.status).toBe('HOLD');
    expect(record.modelYear).toBeNull();
    expect(record.modelYearId).toBeNull();
    expect(record.holdReasons).toContain('MODEL_YEAR_UNVERIFIED');
  });

  it('accepts an explicit product model year only when it is inside the reviewed master range', () => {
    const ranged = { ...master, model_year_start: '2024', model_year_end: '2026' };
    const ok = mapLegacyNewcarFeedToEstimateMaster({ ...feed, modelYear: 2026 }, [ranged]);
    expect(ok.status).toBe('ACTIVE');
    expect(ok.modelYearId).toBe(`${master.master_id}::my2026`);

    const bad = mapLegacyNewcarFeedToEstimateMaster({ ...feed, modelYear: 2027 }, [ranged]);
    expect(bad.status).toBe('HOLD');
    expect(bad.holdReasons).toContain('PRODUCT_MODEL_YEAR_OUTSIDE_MASTER_RANGE');
  });

  it('holds when the feed has no permanent trimKey instead of matching by labels', () => {
    const record = mapLegacyNewcarFeedToEstimateMaster({ ...feed, trimKey: '' }, [master]);
    expect(record.status).toBe('HOLD');
    expect(record.holdReasons).toContain('TRIM_KEY_UNVERIFIED');
    expect(record.trimId).toBeNull();
  });

  it('holds missing source color code and never hashes the color name into an ID', () => {
    const record = mapLegacyNewcarFeedToEstimateMaster({
      ...feed,
      extColors: [{ name: '스노우 화이트 펄', price: 80000 }],
    }, [master]);
    expect(record.status).toBe('HOLD');
    expect(record.exteriorColors[0]?.colorId).toBeNull();
    expect(record.holdReasons).toContain('COLOR_CODE_UNVERIFIED');
  });

  it('holds missing availableOptions rather than exposing the whole option master', () => {
    const { availableOptions, ...withoutAvailable } = feed;
    const record = mapLegacyNewcarFeedToEstimateMaster(withoutAvailable, [master]);
    expect(record.status).toBe('HOLD');
    expect(record.holdReasons).toContain('AVAILABLE_OPTIONS_UNVERIFIED');
  });

  it('rejects a trim key whose embedded structural sequence disagrees with the row', () => {
    const record = mapLegacyNewcarFeedToEstimateMaster(feed, [{ ...master, powertrain_seq: 3 }]);
    expect(record.status).toBe('HOLD');
    expect(record.holdReasons).toContain('PERMANENT_TRIM_KEY_INVALID');
  });
});
