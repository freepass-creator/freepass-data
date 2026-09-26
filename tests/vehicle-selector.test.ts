import { describe, expect, it } from 'vitest';
import {
  VEHICLE_SELECTOR_UX_PRESETS,
  reconcileVehicleSelection,
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

  it('guides new-car UI to the first ambiguous axis without making it mandatory', () => {
    const rows = [
      record('hybrid'),
      record('gasoline', {
        powertrain: { id: 'pt_gasoline', label: '2.5 가솔린 터보' },
        fuelType: { id: null, label: 'GASOLINE' },
        trim: { id: 'trim_prestige', label: '프레스티지' },
      }),
    ];

    const initial = selectVehicles(rows, { mode: 'NEW_CAR' });
    expect(initial.guidance.singletonAxes).toEqual(
      expect.arrayContaining(['maker', 'model'])
    );
    expect(initial.guidance.ambiguousAxes).toEqual(
      expect.arrayContaining(['powertrain', 'trim'])
    );
    expect(initial.guidance.suggestedNextAxis).toBe('powertrain');

    const narrowed = selectVehicles(rows, {
      mode: 'NEW_CAR',
      selection: { powertrain: '하이브리드' },
    });
    expect(narrowed.guidance.resolvedRecordId).toBe('hybrid');
  });

  it('surfaces historical ambiguity to used-car UI instead of forcing a path', () => {
    const rows = [
      record('year-2027'),
      record('year-2021', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2021', label: '2021년형', value: 2021 },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'USED_CAR',
      selection: { model: '쏘렌토' },
    });

    expect(result.guidance.ambiguousAxes).toContain('modelYear');
    expect(result.guidance.suggestedNextAxis).toBe('modelYear');
  });

  it('does not let a shorter record label satisfy a more specific selected label', () => {
    const rows = [
      record('gt', {
        trim: { id: 'trim_gt', label: 'GT' },
      }),
      record('gt-line', {
        trim: { id: 'trim_gt_line', label: 'GT-Line' },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'NEW_CAR',
      selection: { trim: 'GT-Line' },
    });

    expect(result.candidates.map((x) => x.record.recordId)).toEqual(['gt-line']);
  });

  it('keeps unknown requested axes as candidates but never marks them resolved', () => {
    const rows = [
      record('known-five-seat'),
      record('unknown-seats', {
        seats: { id: null, label: null, value: null },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'NEW_CAR',
      selection: { seats: 7 },
    });

    expect(result.candidates.map((x) => x.record.recordId)).toEqual(['unknown-seats']);
    expect(result.candidates[0]?.selectable).toBe(false);
    expect(result.guidance.resolvedRecordId).toBeNull();
  });

  it('narrows free-text candidates as more known facts are supplied', () => {
    const rows = [
      record('hybrid'),
      record('gasoline', {
        powertrain: { id: 'pt_gasoline', label: '2.5 가솔린 터보' },
        fuelType: { id: null, label: 'GASOLINE' },
        aliases: ['MQ4', '쏘렌토 가솔린'],
      }),
    ];

    expect(selectVehicles(rows, {
      mode: 'NEW_CAR',
      searchText: '쏘렌토',
    }).candidates.map((x) => x.record.recordId)).toEqual([
      'gasoline',
      'hybrid',
    ]);

    expect(selectVehicles(rows, {
      mode: 'NEW_CAR',
      searchText: '쏘렌토 하이브리드',
    }).candidates.map((x) => x.record.recordId)).toEqual(['hybrid']);
  });

  it('rejects candidates that contradict recognized free-text facts', () => {
    const rows = [
      record('gasoline-five-seat', {
        powertrain: { id: 'pt_gasoline', label: '2.5 가솔린 터보' },
        fuelType: { id: null, label: 'GASOLINE' },
        seats: { id: null, label: '5인승', value: 5 },
        aliases: ['쏘렌토 가솔린'],
      }),
      record('diesel-seven-seat', {
        powertrain: { id: 'pt_diesel', label: '2.2 디젤' },
        fuelType: { id: null, label: 'DIESEL' },
        seats: { id: null, label: '7인승', value: 7 },
        aliases: ['쏘렌토 디젤'],
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'NEW_CAR',
      searchText: '쏘렌토 7인승 디젤',
    });

    expect(result.candidates.map((x) => x.record.recordId)).toEqual([
      'diesel-seven-seat',
    ]);
    expect(result.guidance.resolvedRecordId).toBe('diesel-seven-seat');
  });

  it('keeps a candidate when a recognized free-text fact is unknown on that record', () => {
    const rows = [
      record('known-seven-seat', {
        seats: { id: null, label: '7인승', value: 7 },
      }),
      record('unknown-seats', {
        seats: { id: null, label: null, value: null },
      }),
      record('known-five-seat', {
        seats: { id: null, label: '5인승', value: 5 },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'NEW_CAR',
      searchText: '쏘렌토 7인승',
    });

    expect(result.candidates.map((x) => x.record.recordId)).toEqual([
      'known-seven-seat',
      'unknown-seats',
    ]);
    expect(result.candidates.find((x) => x.record.recordId === 'unknown-seats')?.selectable)
      .toBe(false);
    expect(result.guidance.resolvedRecordId).toBeNull();
  });

  it('supports whitespace-insensitive Korean free-text without fuzzy typo invention', () => {
    const rows = [
      record('the-new', {
        model: { id: 'model_the_new_sorento', label: '더 뉴 쏘렌토' },
      }),
    ];

    expect(selectVehicles(rows, {
      mode: 'NEW_CAR',
      searchText: '더뉴쏘렌토',
    }).candidates.map((x) => x.record.recordId)).toEqual(['the-new']);

    expect(selectVehicles(rows, {
      mode: 'NEW_CAR',
      searchText: '쏘랜토',
    }).candidates).toHaveLength(0);
  });

  it('rejects impossible cross-axis combinations from sibling records', () => {
    const rows = [
      record('pre-hybrid', {
        phase: { id: 'phase_pre', label: '초기형' },
        modelYear: { id: 'my_2021', label: '2021년형', value: 2021 },
        powertrain: { id: 'pt_hybrid_2021', label: '1.6 터보 하이브리드' },
        trim: { id: 'trim_noblesse_2021', label: '노블레스' },
      }),
      record('fl-gasoline', {
        phase: { id: 'phase_fl', label: '페이스리프트' },
        modelYear: { id: 'my_2024', label: '2024년형', value: 2024 },
        powertrain: { id: 'pt_gasoline_2024', label: '2.5 가솔린 터보' },
        trim: { id: 'trim_signature_2024', label: '시그니처' },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'NEW_CAR',
      selection: {
        phase: '페이스리프트',
        modelYear: 2021,
        powertrain: '하이브리드',
      },
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.guidance.resolutionStatus).toBe('IMPOSSIBLE');
    expect(result.guidance.resolvedRecordId).toBeNull();
  });

  it('resolves the same valid combination regardless of selection order', () => {
    const rows = [
      record('target'),
      record('other', {
        phase: { id: 'phase_pre', label: '초기형' },
        modelYear: { id: 'my_2024', label: '2024년형', value: 2024 },
        powertrain: { id: 'pt_gasoline', label: '2.5 가솔린 터보' },
        trim: { id: 'trim_signature', label: '시그니처' },
      }),
    ];

    const a = selectVehicles(rows, {
      mode: 'NEW_CAR',
      selection: {
        trim: '노블레스',
        modelYear: 2027,
        phase: '페이스리프트',
        powertrain: '하이브리드',
      },
    });
    const b = selectVehicles(rows, {
      mode: 'NEW_CAR',
      selection: {
        powertrain: '하이브리드',
        phase: '페이스리프트',
        modelYear: 2027,
        trim: '노블레스',
      },
    });

    expect(a.candidates.map((x) => x.record.recordId)).toEqual(['target']);
    expect(b.candidates.map((x) => x.record.recordId)).toEqual(['target']);
    expect(a.guidance.resolutionStatus).toBe('RESOLVED');
    expect(b.guidance.resolutionStatus).toBe('RESOLVED');
  });

  it('distinguishes ambiguity from unknown evidence without inventing facts', () => {
    const ambiguous = selectVehicles([
      record('noblesse'),
      record('signature', {
        trim: { id: 'trim_signature', label: '시그니처' },
      }),
    ], {
      mode: 'NEW_CAR',
      selection: { model: '쏘렌토' },
    });

    expect(ambiguous.guidance.resolutionStatus).toBe('AMBIGUOUS');

    const partial = selectVehicles([
      record('unknown-year', {
        lifecycle: 'HISTORICAL',
        identityStatus: 'PARTIAL',
        modelYear: { id: null, label: null, value: null },
      }),
      record('known-wrong-year', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2020', label: '2020년형', value: 2020 },
      }),
    ], {
      mode: 'USED_CAR',
      selection: {
        model: '쏘렌토',
        modelYear: 2021,
        powertrain: '하이브리드',
      },
    });

    expect(partial.candidates.map((x) => x.record.recordId)).toEqual([
      'unknown-year',
    ]);
    expect(partial.candidates[0]?.unresolvedAxes).toContain('modelYear');
    expect(partial.guidance.resolutionStatus).toBe('PARTIAL_UNKNOWN');
    expect(partial.guidance.resolvedRecordId).toBeNull();
  });

  it('keeps UNKNOWN-compatible candidates without exposing unproven facet options', () => {
    const rows = [
      record('known-2021-noblesse', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2021', label: '2021년형', value: 2021 },
        trim: { id: 'trim_noblesse_2021', label: '노블레스' },
      }),
      record('unknown-year-signature', {
        lifecycle: 'HISTORICAL',
        identityStatus: 'PARTIAL',
        modelYear: { id: null, label: null, value: null },
        trim: { id: 'trim_signature_unknown', label: '시그니처' },
      }),
      record('known-2024-signature', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2024', label: '2024년형', value: 2024 },
        trim: { id: 'trim_signature_2024', label: '시그니처' },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'USED_CAR',
      selection: {
        model: '쏘렌토',
        modelYear: 2021,
        powertrain: '하이브리드',
      },
    });

    expect(result.candidates.map((x) => x.record.recordId)).toEqual([
      'known-2021-noblesse',
      'unknown-year-signature',
    ]);
    expect(result.facets.trim.map((x) => x.label)).toEqual(['노블레스']);
    expect(result.guidance.ambiguousAxes).not.toContain('trim');
    expect(result.guidance.resolutionStatus).toBe('PARTIAL_UNKNOWN');
  });

  it('widens evidence-backed facet options when a prior condition is removed', () => {
    const rows = [
      record('year-2021-noblesse', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2021', label: '2021년형', value: 2021 },
        trim: { id: 'trim_noblesse_2021', label: '노블레스' },
      }),
      record('year-2024-signature', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2024', label: '2024년형', value: 2024 },
        trim: { id: 'trim_signature_2024', label: '시그니처' },
      }),
    ];

    const narrowed = selectVehicles(rows, {
      mode: 'USED_CAR',
      selection: {
        model: '쏘렌토',
        modelYear: 2021,
        powertrain: '하이브리드',
      },
    });
    expect(narrowed.facets.trim.map((x) => x.label)).toEqual(['노블레스']);

    const widened = selectVehicles(rows, {
      mode: 'USED_CAR',
      selection: {
        model: '쏘렌토',
        powertrain: '하이브리드',
      },
    });
    expect(widened.facets.trim.map((x) => x.label)).toEqual([
      '노블레스',
      '시그니처',
    ]);
    expect(widened.guidance.ambiguousAxes).toContain('modelYear');
    expect(widened.guidance.ambiguousAxes).toContain('trim');
  });

  it('does not use unresolved free-text evidence to manufacture filter choices', () => {
    const rows = [
      record('known-seven-noblesse', {
        lifecycle: 'HISTORICAL',
        seats: { id: null, label: '7인승', value: 7 },
        trim: { id: 'trim_noblesse_7', label: '노블레스' },
      }),
      record('unknown-seats-signature', {
        lifecycle: 'HISTORICAL',
        identityStatus: 'PARTIAL',
        seats: { id: null, label: null, value: null },
        trim: { id: 'trim_signature_unknown', label: '시그니처' },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'USED_CAR',
      searchText: '쏘렌토 7인승',
    });

    expect(result.candidates.map((x) => x.record.recordId)).toEqual([
      'known-seven-noblesse',
      'unknown-seats-signature',
    ]);
    expect(result.facets.trim.map((x) => x.label)).toEqual(['노블레스']);
  });

  it('preserves compatible selections and clears only stale downstream choices', () => {
    const rows = [
      record('2021-hybrid-noblesse', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2021', label: '2021년형', value: 2021 },
        powertrain: { id: 'pt_hybrid_2021', label: '1.6 터보 하이브리드' },
        trim: { id: 'trim_noblesse_2021', label: '노블레스' },
      }),
      record('2024-hybrid-signature', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2024', label: '2024년형', value: 2024 },
        powertrain: { id: 'pt_hybrid_2024', label: '1.6 터보 하이브리드' },
        trim: { id: 'trim_signature_2024', label: '시그니처' },
      }),
    ];

    const reconciled = reconcileVehicleSelection(
      rows,
      { mode: 'USED_CAR' },
      {
        model: '쏘렌토',
        modelYear: 2024,
        powertrain: '하이브리드',
        trim: '노블레스',
      },
      ['modelYear']
    );

    expect(reconciled.selection).toEqual({
      model: '쏘렌토',
      modelYear: 2024,
      powertrain: '하이브리드',
    });
    expect(reconciled.clearedAxes).toEqual(['trim']);
    expect(reconciled.result.candidates.map((x) => x.record.recordId)).toEqual([
      '2024-hybrid-signature',
    ]);
  });

  it('clears multiple incompatible retained choices while protecting the changed axis', () => {
    const rows = [
      record('2021-hybrid-noblesse', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2021', label: '2021년형', value: 2021 },
        powertrain: { id: 'pt_hybrid_2021', label: '1.6 터보 하이브리드' },
        trim: { id: 'trim_noblesse_2021', label: '노블레스' },
      }),
      record('2024-gasoline-signature', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2024', label: '2024년형', value: 2024 },
        powertrain: { id: 'pt_gasoline_2024', label: '2.5 가솔린 터보' },
        trim: { id: 'trim_signature_2024', label: '시그니처' },
      }),
    ];

    const reconciled = reconcileVehicleSelection(
      rows,
      { mode: 'USED_CAR' },
      {
        model: '쏘렌토',
        modelYear: 2024,
        powertrain: '하이브리드',
        trim: '노블레스',
      },
      ['modelYear']
    );

    expect(reconciled.selection).toEqual({
      model: '쏘렌토',
      modelYear: 2024,
    });
    expect(reconciled.clearedAxes).toEqual(['trim', 'powertrain']);
    expect(reconciled.result.candidates.map((x) => x.record.recordId)).toEqual([
      '2024-gasoline-signature',
    ]);
  });

  it('treats removing a condition as back-navigation and preserves remaining valid choices', () => {
    const rows = [
      record('2021-hybrid-noblesse', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2021', label: '2021년형', value: 2021 },
        trim: { id: 'trim_noblesse_2021', label: '노블레스' },
      }),
      record('2024-hybrid-noblesse', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2024', label: '2024년형', value: 2024 },
        trim: { id: 'trim_noblesse_2024', label: '노블레스' },
      }),
    ];

    const reconciled = reconcileVehicleSelection(
      rows,
      { mode: 'USED_CAR' },
      {
        model: '쏘렌토',
        powertrain: '하이브리드',
        trim: '노블레스',
      },
      ['modelYear']
    );

    expect(reconciled.clearedAxes).toEqual([]);
    expect(reconciled.selection).toEqual({
      model: '쏘렌토',
      powertrain: '하이브리드',
      trim: '노블레스',
    });
    expect(reconciled.result.candidates).toHaveLength(2);
    expect(reconciled.result.facets.modelYear.map((x) => x.value)).toEqual([
      2021,
      2024,
    ]);
  });

  it('does not erase prior choices when the newly changed condition is itself impossible', () => {
    const rows = [
      record('2021-hybrid-noblesse', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2021', label: '2021년형', value: 2021 },
        trim: { id: 'trim_noblesse_2021', label: '노블레스' },
      }),
    ];

    const reconciled = reconcileVehicleSelection(
      rows,
      { mode: 'USED_CAR' },
      {
        model: '쏘렌토',
        modelYear: 2099,
        powertrain: '하이브리드',
        trim: '노블레스',
      },
      ['modelYear']
    );

    expect(reconciled.clearedAxes).toEqual([]);
    expect(reconciled.selection).toEqual({
      model: '쏘렌토',
      modelYear: 2099,
      powertrain: '하이브리드',
      trim: '노블레스',
    });
    expect(reconciled.result.guidance.resolutionStatus).toBe('NO_RESULT');
    expect(reconciled.result.guidance.noResultReason).toBe('INSUFFICIENT_DATA');
  });

  it('supports arbitrary-axis changes by protecting the axis the user explicitly changed', () => {
    const rows = [
      record('hybrid-noblesse'),
      record('gasoline-signature', {
        powertrain: { id: 'pt_gasoline', label: '2.5 가솔린 터보' },
        trim: { id: 'trim_signature', label: '시그니처' },
      }),
    ];

    const reconciled = reconcileVehicleSelection(
      rows,
      { mode: 'NEW_CAR' },
      {
        model: '쏘렌토',
        powertrain: '하이브리드',
        trim: '시그니처',
      },
      ['trim']
    );

    expect(reconciled.selection).toEqual({
      model: '쏘렌토',
      trim: '시그니처',
    });
    expect(reconciled.clearedAxes).toEqual(['powertrain']);
    expect(reconciled.result.candidates.map((x) => x.record.recordId)).toEqual([
      'gasoline-signature',
    ]);
  });

  it('maps ACTIVE candidates to SELECT', () => {
    const result = selectVehicles([
      record('active'),
    ], {
      mode: 'NEW_CAR',
      selection: { model: '쏘렌토' },
    });

    expect(result.candidates[0]).toMatchObject({
      actionState: 'ACTIVE',
      action: 'SELECT',
      actionReasons: [],
      selectable: true,
    });
    expect(result.guidance.selectableCount).toBe(1);
    expect(result.guidance.inspectOnlyCount).toBe(0);
    expect(result.guidance.blockedCount).toBe(0);
  });

  it('maps UNKNOWN identity or unresolved facts to INSPECT_ONLY', () => {
    const partialIdentity = record('partial-identity', {
      lifecycle: 'HISTORICAL',
      identityStatus: 'PARTIAL',
      seats: { id: null, label: null, value: null },
    });
    const unresolvedFact = record('unknown-seats', {
      lifecycle: 'HISTORICAL',
      seats: { id: null, label: null, value: null },
    });

    const result = selectVehicles([
      partialIdentity,
      unresolvedFact,
    ], {
      mode: 'USED_CAR',
      selection: {
        model: '쏘렌토',
        seats: 7,
      },
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((x) => x.actionState === 'UNKNOWN')).toBe(true);
    expect(result.candidates.every((x) => x.action === 'INSPECT_ONLY')).toBe(true);
    expect(result.candidates.every((x) => x.selectable === false)).toBe(true);
    expect(result.guidance.selectableCount).toBe(0);
    expect(result.guidance.inspectOnlyCount).toBe(2);
    expect(result.guidance.blockedCount).toBe(0);
    expect(result.candidates.find((x) => x.record.recordId === 'partial-identity')?.actionReasons)
      .toContain('IDENTITY_PARTIAL');
    expect(result.candidates.find((x) => x.record.recordId === 'unknown-seats')?.actionReasons)
      .toContain('UNRESOLVED_SELECTION');
  });

  it('maps HOLD records to BLOCKED while keeping them visible when requested', () => {
    const hold = record('hold', {
      lifecycle: 'HOLD',
      identityStatus: 'HOLD',
    });

    const visible = selectVehicles([hold], {
      mode: 'USED_CAR',
      selection: { model: '쏘렌토' },
      includeHold: true,
    });

    expect(visible.candidates).toHaveLength(1);
    expect(visible.candidates[0]).toMatchObject({
      actionState: 'HOLD',
      action: 'BLOCKED',
      selectable: false,
    });
    expect(visible.candidates[0]?.actionReasons).toEqual(
      expect.arrayContaining(['LIFECYCLE_HOLD', 'IDENTITY_HOLD'])
    );
    expect(visible.guidance.blockedCount).toBe(1);

    const hidden = selectVehicles([hold], {
      mode: 'USED_CAR',
      selection: { model: '쏘렌토' },
      includeHold: false,
    });
    expect(hidden.candidates).toHaveLength(0);
  });

  it('does not let UNKNOWN or HOLD records create selectable facet options', () => {
    const rows = [
      record('active-noblesse', {
        lifecycle: 'HISTORICAL',
        trim: { id: 'trim_noblesse_active', label: '노블레스' },
      }),
      record('unknown-signature', {
        lifecycle: 'HISTORICAL',
        identityStatus: 'PARTIAL',
        trim: { id: 'trim_signature_unknown', label: '시그니처' },
      }),
      record('hold-prestige', {
        lifecycle: 'HOLD',
        identityStatus: 'HOLD',
        trim: { id: 'trim_prestige_hold', label: '프레스티지' },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'USED_CAR',
      selection: {
        model: '쏘렌토',
        powertrain: '하이브리드',
      },
      includeHold: true,
    });

    expect(result.candidates.map((x) => x.record.recordId)).toEqual([
      'active-noblesse',
      'unknown-signature',
      'hold-prestige',
    ]);
    expect(result.facets.trim.map((x) => x.label)).toEqual(['노블레스']);
  });

  it('distinguishes an unrecognized search term from a proven impossible combination', () => {
    const result = selectVehicles([
      record('known'),
    ], {
      mode: 'NEW_CAR',
      searchText: '쏘랜토',
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.guidance.resolutionStatus).toBe('NO_RESULT');
    expect(result.guidance.noResultReason).toBe('UNRECOGNIZED_SEARCH');
    expect(result.guidance.noResultEvidence?.unrecognizedSearchTokens).toEqual([
      '쏘랜토',
    ]);
  });

  it('treats a selected value with no evidence as insufficient data, not impossibility', () => {
    const result = selectVehicles([
      record('known-2027'),
    ], {
      mode: 'NEW_CAR',
      selection: {
        model: '쏘렌토',
        modelYear: 2099,
      },
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.guidance.resolutionStatus).toBe('NO_RESULT');
    expect(result.guidance.noResultReason).toBe('INSUFFICIENT_DATA');
    expect(result.guidance.noResultEvidence?.unrecognizedAxes).toContain('modelYear');
  });

  it('reports HOLD_ONLY when matching evidence exists only behind HOLD exclusion', () => {
    const hold = record('hold-only', {
      lifecycle: 'HOLD',
      identityStatus: 'HOLD',
    });

    const result = selectVehicles([hold], {
      mode: 'USED_CAR',
      selection: { model: '쏘렌토' },
      includeHold: false,
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.guidance.resolutionStatus).toBe('NO_RESULT');
    expect(result.guidance.noResultReason).toBe('HOLD_ONLY');
    expect(result.guidance.noResultEvidence?.holdCompatibleCount).toBe(1);
  });

  it('reports OUT_OF_SCOPE when the combination exists only outside the requested mode', () => {
    const historical = record('historical-only', {
      lifecycle: 'HISTORICAL',
    });

    const result = selectVehicles([historical], {
      mode: 'NEW_CAR',
      selection: { model: '쏘렌토' },
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.guidance.resolutionStatus).toBe('NO_RESULT');
    expect(result.guidance.noResultReason).toBe('OUT_OF_SCOPE');
    expect(result.guidance.noResultEvidence?.outOfScopeCompatibleCount).toBe(1);
  });

  it('reports INSUFFICIENT_DATA when only UNKNOWN evidence could satisfy the request', () => {
    const partial = record('partial-only', {
      lifecycle: 'CURRENT',
      identityStatus: 'PARTIAL',
      modelYear: { id: null, label: null, value: null },
    });

    const result = selectVehicles([partial], {
      mode: 'NEW_CAR',
      selection: {
        model: '쏘렌토',
        modelYear: 2027,
      },
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.guidance.resolutionStatus).toBe('NO_RESULT');
    expect(result.guidance.noResultReason).toBe('INSUFFICIENT_DATA');
    expect(result.guidance.noResultEvidence?.unknownCompatibleCount).toBe(1);
  });

  it('uses IMPOSSIBLE only when every fact is known but no single record proves the combination', () => {
    const rows = [
      record('2021-hybrid', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2021', label: '2021년형', value: 2021 },
        powertrain: { id: 'pt_hybrid_2021', label: '1.6 터보 하이브리드' },
      }),
      record('2024-gasoline', {
        lifecycle: 'HISTORICAL',
        modelYear: { id: 'my_2024', label: '2024년형', value: 2024 },
        powertrain: { id: 'pt_gasoline_2024', label: '2.5 가솔린 터보' },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'USED_CAR',
      selection: {
        model: '쏘렌토',
        modelYear: 2021,
        powertrain: '가솔린',
      },
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.guidance.resolutionStatus).toBe('IMPOSSIBLE');
    expect(result.guidance.noResultReason).toBe('IMPOSSIBLE_COMBINATION');
    expect(result.guidance.noResultEvidence).toMatchObject({
      unrecognizedSearchTokens: [],
      unrecognizedAxes: [],
      unknownCompatibleCount: 0,
      holdCompatibleCount: 0,
      outOfScopeCompatibleCount: 0,
    });
  });

  it('ranks direct model evidence above alias-only matches', () => {
    const rows = [
      record('alias-only', {
        model: { id: 'model_carnival', label: '카니발' },
        aliases: ['쏘렌토'],
      }),
      record('direct-model'),
    ];

    const result = selectVehicles(rows, {
      mode: 'NEW_CAR',
      searchText: '쏘렌토',
    });

    expect(result.candidates.map((x) => x.record.recordId)).toEqual([
      'direct-model',
      'alias-only',
    ]);
    expect(result.candidates[0]?.ranking).toMatchObject({
      directSearchMatches: 1,
      aliasOnlySearchMatches: 0,
    });
    expect(result.candidates[1]?.ranking).toMatchObject({
      directSearchMatches: 0,
      aliasOnlySearchMatches: 1,
    });
  });

  it('ranks exact axis matches above broader containing labels', () => {
    const rows = [
      record('broader-model', {
        model: { id: 'model_the_new_sorento', label: '더 뉴 쏘렌토' },
      }),
      record('exact-model'),
    ];

    const result = selectVehicles(rows, {
      mode: 'NEW_CAR',
      searchText: '쏘렌토',
    });

    expect(result.candidates.map((x) => x.record.recordId)).toEqual([
      'exact-model',
      'broader-model',
    ]);
    expect(result.candidates[0]?.ranking.exactSearchMatches).toBe(1);
    expect(result.candidates[1]?.ranking.exactSearchMatches).toBe(0);
  });

  it('uses axis specificity after direct and exact match quality', () => {
    const rows = [
      record('model-hit', {
        model: { id: 'model_noblesse', label: '노블레스' },
        trim: { id: 'trim_other', label: '프레스티지' },
      }),
      record('trim-hit', {
        model: { id: 'model_other', label: '기타모델' },
        trim: { id: 'trim_noblesse', label: '노블레스' },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'NEW_CAR',
      searchText: '노블레스',
    });

    expect(result.candidates.map((x) => x.record.recordId)).toEqual([
      'trim-hit',
      'model-hit',
    ]);
    expect(result.candidates[0]?.ranking.specificityScore).toBeGreaterThan(
      result.candidates[1]?.ranking.specificityScore ?? 0
    );
  });

  it('keeps explicit selection matches ahead of free-text-only ranking', () => {
    const rows = [
      record('selected-match', {
        trim: { id: 'trim_signature', label: '시그니처' },
        aliases: ['패밀리'],
      }),
      record('search-only', {
        trim: { id: 'trim_noblesse', label: '노블레스' },
        model: { id: 'model_family', label: '패밀리' },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'NEW_CAR',
      searchText: '패밀리',
      selection: { trim: '시그니처' },
    });

    expect(result.candidates.map((x) => x.record.recordId)).toEqual([
      'selected-match',
    ]);
    expect(result.candidates[0]?.matchedAxes).toContain('trim');
  });

  it('keeps ranking deterministic regardless of input record order', () => {
    const a = record('a');
    const b = record('b', {
      model: { id: 'model_the_new_sorento', label: '더 뉴 쏘렌토' },
    });

    const first = selectVehicles([b, a], {
      mode: 'NEW_CAR',
      searchText: '쏘렌토',
    });
    const second = selectVehicles([a, b], {
      mode: 'NEW_CAR',
      searchText: '쏘렌토',
    });

    expect(first.candidates.map((x) => x.record.recordId)).toEqual(['a', 'b']);
    expect(second.candidates.map((x) => x.record.recordId)).toEqual(['a', 'b']);
  });

  it('groups broad manufacturer results by model and generation without dropping candidates', () => {
    const rows = [
      record('sorento-noblesse', {
        trim: { id: 'trim_noblesse', label: '노블레스' },
      }),
      record('sorento-signature', {
        trim: { id: 'trim_signature', label: '시그니처' },
      }),
      record('carnival-prestige', {
        model: { id: 'model_carnival', label: '카니발' },
        generation: { id: 'gen_ka4', label: '4세대 KA4' },
        trim: { id: 'trim_prestige', label: '프레스티지' },
        aliases: ['KA4'],
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'NEW_CAR',
      searchText: '기아',
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.map((group) => group.model.label)).toEqual([
      '카니발',
      '쏘렌토',
    ]);

    const sorento = result.groups.find((group) => group.model.label === '쏘렌토');
    expect(sorento).toMatchObject({
      scope: 'MODEL_GENERATION',
      candidateCount: 2,
      selectableCount: 2,
      expandable: true,
    });
    expect(sorento?.memberRecordIds).toEqual([
      'sorento-noblesse',
      'sorento-signature',
    ]);
  });

  it('keeps different generations of the same model in separate groups', () => {
    const rows = [
      record('mq4', {
        generation: { id: 'gen_mq4', label: '4세대 MQ4' },
      }),
      record('um', {
        generation: { id: 'gen_um', label: '3세대 UM' },
        lifecycle: 'HISTORICAL',
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'USED_CAR',
      searchText: '쏘렌토',
    });

    expect(result.groups).toHaveLength(2);
    expect(result.groups.map((group) => group.generation.id)).toEqual([
      'gen_mq4',
      'gen_um',
    ]);
  });

  it('never merges unresolved generation identity into a fabricated group', () => {
    const rows = [
      record('unknown-generation-a', {
        lifecycle: 'HISTORICAL',
        identityStatus: 'PARTIAL',
        generation: { id: null, label: null },
      }),
      record('unknown-generation-b', {
        lifecycle: 'HISTORICAL',
        identityStatus: 'PARTIAL',
        generation: { id: null, label: null },
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'USED_CAR',
      searchText: '쏘렌토',
    });

    expect(result.groups).toHaveLength(2);
    expect(result.groups.every((group) => group.scope === 'UNRESOLVED_IDENTITY'))
      .toBe(true);
    expect(result.groups.every((group) => group.candidateCount === 1)).toBe(true);
    expect(result.groups.map((group) => group.representativeRecordId)).toEqual([
      'unknown-generation-a',
      'unknown-generation-b',
    ]);
  });

  it('uses the highest-ranked member as the group representative', () => {
    const rows = [
      record('hold-first-input', {
        lifecycle: 'HOLD',
        identityStatus: 'HOLD',
      }),
      record('active-second-input'),
      record('partial-third-input', {
        lifecycle: 'HISTORICAL',
        identityStatus: 'PARTIAL',
      }),
    ];

    const result = selectVehicles(rows, {
      mode: 'USED_CAR',
      searchText: '쏘렌토',
      includeHold: true,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      representativeRecordId: 'active-second-input',
      candidateCount: 3,
      selectableCount: 1,
      inspectOnlyCount: 1,
      blockedCount: 1,
      expandable: true,
    });
    expect(result.groups[0]?.memberRecordIds).toEqual([
      'active-second-input',
      'partial-third-input',
      'hold-first-input',
    ]);
  });

  it('returns a non-expandable group for a single concrete candidate', () => {
    const result = selectVehicles([
      record('only'),
    ], {
      mode: 'NEW_CAR',
      searchText: '쏘렌토',
    });

    expect(result.groups).toEqual([
      expect.objectContaining({
        representativeRecordId: 'only',
        memberRecordIds: ['only'],
        candidateCount: 1,
        expandable: false,
      }),
    ]);
  });

  it('reports OPEN before the user supplies any search criteria', () => {
    const result = selectVehicles([
      record('one'),
      record('two', {
        trim: { id: 'trim_signature', label: '시그니처' },
      }),
    ], { mode: 'NEW_CAR' });

    expect(result.guidance.resolutionStatus).toBe('OPEN');
  });

  it('keeps UX presets separate from selector semantics', () => {
    expect(VEHICLE_SELECTOR_UX_PRESETS.NEW_CAR.presentation).toBe('GUIDED');
    expect(VEHICLE_SELECTOR_UX_PRESETS.USED_CAR.presentation).toBe('SEARCH_FILTER');
    expect(VEHICLE_SELECTOR_UX_PRESETS.NEW_CAR.allowArbitraryAxisEntry).toBe(true);
    expect(VEHICLE_SELECTOR_UX_PRESETS.USED_CAR.allowArbitraryAxisEntry).toBe(true);
  });
});
