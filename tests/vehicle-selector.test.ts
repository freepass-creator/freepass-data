import { describe, expect, it } from 'vitest';
import {
  VEHICLE_SELECTOR_UX_PRESETS,
  selectVehicles,
  type VehicleSelectorRecord,
} from '../src/domain/vehicle-selector.js';

function record(
  id: string,
  overrides: Partial<VehicleSelectorRecord> = {}
): VehicleSelectorRecord {
  return {
    recordId: id,
    lifecycle: 'CURRENT',
    identityStatus: 'RESOLVED',
    maker: { id: 'make_kia', label: '기아' },
    model: { id: 'model_sorento', label: '쏘렌토' },
    generation: { id: 'gen_mq4', label: '4세대 MQ4' },
    phase: { id: 'phase_mq4_fl', label: '페이스리프트' },
    modelYear: { id: 'my_2027', label: '2027년형', value: 2027 },
    powertrain: { id: 'pt_hybrid', label: '1.6 터보 하이브리드' },
    fuelType: { id: null, label: 'HYBRID' },
    drivetrain: { id: null, label: '2WD' },
    seats: { id: null, label: '5인승', value: 5 },
    trim: { id: 'trim_noblesse', label: '노블레스' },
    aliases: ['MQ4', '쏘렌토 하이브리드'],
    ...overrides,
  };
}

describe('common vehicle selector', () => {
  it('does not require a fixed selection order', () => {
    const rows = [
      record('hybrid'),
      record('gasoline', {
        powertrain: { id: 'pt_gasoline', label: '2.5 가솔린 터보' },
        fuelType: { id: null, label: 'GASOLINE' },
        trim: { id: 'trim_prestige', label: '프레스티지' },
        aliases: ['MQ4', '쏘렌토 가솔린'],
      }),
    ];

    const powertrainFirst = selectVehicles(rows, {
      mode: 'NEW_CAR',
      selection: { powertrain: '하이브리드' },
    });
    expect(powertrainFirst.candidates.map((x) => x.record.recordId)).toEqual(['hybrid']);

    const trimFirst = selectVehicles(rows, {
      mode: 'NEW_CAR',
      selection: { trim: '프레스티지' },
    });
    expect(trimFirst.candidates.map((x) => x.record.recordId)).toEqual(['gasoline']);
  });

  it('uses the same engine but filters lifecycle by mode', () => {
    const rows = [
      record('current'),
      record('historical', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2021', label: '2021년형', value: 2021 },
      }),
    ];

    expect(selectVehicles(rows, {
      mode: 'NEW_CAR',
      selection: { model: '쏘렌토' },
    }).candidates.map((x) => x.record.recordId)).toEqual(['current']);

    expect(selectVehicles(rows, {
      mode: 'USED_CAR',
      selection: { model: '쏘렌토' },
    }).candidates.map((x) => x.record.recordId)).toEqual(['current', 'historical']);
  });

  it('keeps unresolved used-car candidates discoverable but not selectable', () => {
    const partial = record('partial', {
      lifecycle: 'HOLD',
      identityStatus: 'PARTIAL',
      modelYear: { id: null, label: null, value: null },
      trim: { id: null, label: null },
    });

    const result = selectVehicles([partial], {
      mode: 'USED_CAR',
      selection: { model: '쏘렌토' },
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.selectable).toBe(false);
  });

  it('calculates each facet while ignoring only that axis selection', () => {
    const rows = [
      record('hybrid-noblesse'),
      record('hybrid-signature', {
        trim: { id: 'trim_signature', label: '시그니처' },
      }),
      record('gasoline-prestige', {
        powertrain: { id: 'pt_gasoline', label: '2.5 가솔린 터보' },
        trim: { id: 'trim_prestige', label: '프레스티지' },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'NEW_CAR',
      selection: {
        model: '쏘렌토',
        powertrain: '하이브리드',
        trim: '노블레스',
      },
    });

    expect(result.facets.trim.map((x) => x.label)).toEqual(['노블레스', '시그니처']);
    expect(result.facets.powertrain.map((x) => x.label)).toEqual([
      '1.6 터보 하이브리드',
    ]);
  });

  it('keeps UX presets separate from selector semantics', () => {
    expect(VEHICLE_SELECTOR_UX_PRESETS.NEW_CAR.presentation).toBe('GUIDED');
    expect(VEHICLE_SELECTOR_UX_PRESETS.USED_CAR.presentation).toBe('SEARCH_FILTER');
    expect(VEHICLE_SELECTOR_UX_PRESETS.NEW_CAR.allowArbitraryAxisEntry).toBe(true);
    expect(VEHICLE_SELECTOR_UX_PRESETS.USED_CAR.allowArbitraryAxisEntry).toBe(true);
  });
});
