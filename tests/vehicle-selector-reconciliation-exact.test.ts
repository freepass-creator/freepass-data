import { describe, expect, it } from 'vitest';
import {
  reconcileVehicleSelection,
  selectVehicles,
  type VehicleSelectorMode,
  type VehicleSelectorRecord,
  type VehicleSelectorSelection,
} from '../src/domain/vehicle-selector.js';

type ExactAxis = 'trim' | 'fuelType' | 'drivetrain';
const cases: Array<{ axis: ExactAxis; selected: string; actual: string }> = [
  { axis: 'trim', selected: 'GT', actual: 'GT-Line' },
  { axis: 'fuelType', selected: 'HYBRID', actual: 'PLUG-IN HYBRID' },
  { axis: 'drivetrain', selected: 'AWD', actual: 'E-AWD' },
];
const modes: VehicleSelectorMode[] = ['NEW_CAR', 'USED_CAR'];

// Synthetic records exercise selector semantics, not production vehicle facts.
function record(overrides: Partial<VehicleSelectorRecord> = {}): VehicleSelectorRecord {
  return {
    recordId: 'new-record',
    lifecycle: 'CURRENT',
    identityStatus: 'RESOLVED',
    maker: { id: 'maker', label: '제조사' },
    model: { id: 'new-model', label: '새 차종' },
    generation: { id: 'generation', label: '세대' },
    phase: { id: 'phase', label: '변경 전' },
    modelYear: { id: 'year', label: '2026', value: 2026 },
    powertrain: { id: 'powertrain', label: '1.6 터보 하이브리드' },
    fuelType: { id: null, label: 'HYBRID' },
    drivetrain: { id: null, label: 'AWD' },
    seats: { id: null, label: '5인승', value: 5 },
    trim: { id: 'trim', label: 'GT' },
    aliases: [],
    ...overrides,
  };
}

function previousRecord(overrides: Partial<VehicleSelectorRecord> = {}): VehicleSelectorRecord {
  return record({
    recordId: 'old-record',
    model: { id: 'old-model', label: '이전 차종' },
    ...overrides,
  });
}

for (const mode of modes) {
  describe(`${mode} exact-axis reconciliation`, () => {
    for (const { axis, selected, actual } of cases) {
      it(`clears stale ${axis} after a model change instead of keeping a zero-result trap`, () => {
        const rows = [
          previousRecord({ [axis]: { id: null, label: selected } }),
          record({ [axis]: { id: null, label: actual } }),
        ];
        const selection: VehicleSelectorSelection = { modelId: 'new-model', [axis]: selected };
        const before = structuredClone(selection);
        expect(selectVehicles(rows, { mode, selection }).candidates).toHaveLength(0);

        const reconciled = reconcileVehicleSelection(rows, { mode }, selection, ['model']);
        expect(reconciled.clearedAxes).toEqual([axis]);
        expect(reconciled.selection).toEqual({ modelId: 'new-model' });
        expect(reconciled.result.candidates.map((item) => item.record.recordId)).toEqual(['new-record']);
        expect(selection).toEqual(before);
      });

      it(`preserves an explicitly changed unavailable ${axis} rather than silently broadening it`, () => {
        const rows = [record({ [axis]: { id: null, label: actual } })];
        const selection: VehicleSelectorSelection = { modelId: 'new-model', [axis]: selected };
        const reconciled = reconcileVehicleSelection(rows, { mode }, selection, [axis]);
        expect(reconciled.clearedAxes).toEqual([]);
        expect(reconciled.selection).toEqual(selection);
        expect(reconciled.result.candidates).toHaveLength(0);
      });

      it(`retains a normalized exact ${axis} value`, () => {
        const rows = [
          previousRecord({ [axis]: { id: null, label: selected } }),
          record({ [axis]: { id: null, label: selected.toLowerCase() } }),
        ];
        const selection: VehicleSelectorSelection = { modelId: 'new-model', [axis]: `  ${selected}  ` };
        const reconciled = reconcileVehicleSelection(rows, { mode }, selection, ['model']);
        expect(reconciled.clearedAxes).toEqual([]);
        expect(reconciled.selection).toEqual(selection);
        expect(reconciled.result.candidates.map((item) => item.record.recordId)).toEqual(['new-record']);
      });
    }

    it('keeps descriptive powertrain partial matching', () => {
      const rows = [
        previousRecord(),
        record({ powertrain: { id: 'new-powertrain', label: '1.6 터보 플러그인 하이브리드' } }),
      ];
      const selection = { modelId: 'new-model', powertrain: '하이브리드' };
      const reconciled = reconcileVehicleSelection(rows, { mode }, selection, ['model']);
      expect(reconciled.clearedAxes).toEqual([]);
      expect(reconciled.selection).toEqual(selection);
      expect(reconciled.result.candidates.map((item) => item.record.recordId)).toEqual(['new-record']);
    });

    // Absorbed from PR #177: protected fuel is available elsewhere, so clear
    // the incompatible old model rather than clearing the user's new choice.
    it('protects a changed available fuel choice and clears the incompatible model', () => {
      const rows = [
        previousRecord({ fuelType: { id: null, label: 'HYBRID' } }),
        record({ fuelType: { id: null, label: 'PLUG-IN HYBRID' } }),
      ];
      const selection = { modelId: 'new-model', fuelType: 'HYBRID' };
      const reconciled = reconcileVehicleSelection(rows, { mode }, selection, ['fuelType']);
      expect(reconciled.clearedAxes).toEqual(['model']);
      expect(reconciled.selection).toEqual({ fuelType: 'HYBRID' });
      expect(reconciled.result.candidates.map((item) => item.record.recordId)).toEqual(['old-record']);
      expect(selection).toEqual({ modelId: 'new-model', fuelType: 'HYBRID' });
    });

    it('does not weaken stable trim identity checks', () => {
      const selection = { modelId: 'new-model', trimId: 'old-trim', trim: 'GT' };
      const reconciled = reconcileVehicleSelection([record()], { mode }, selection, ['model']);
      expect(reconciled.clearedAxes).toEqual(['trim']);
      expect(reconciled.selection).toEqual({ modelId: 'new-model' });
      expect(reconciled.result.candidates).toHaveLength(1);
    });

    it('clears multiple stale categorical selections and converges', () => {
      const rows = [record({
        trim: { id: null, label: 'GT-Line' },
        fuelType: { id: null, label: 'PLUG-IN HYBRID' },
        drivetrain: { id: null, label: 'E-AWD' },
      })];
      const reconciled = reconcileVehicleSelection(rows, { mode }, {
        modelId: 'new-model', trim: 'GT', fuelType: 'HYBRID', drivetrain: 'AWD',
      }, ['model']);
      expect([...reconciled.clearedAxes].sort()).toEqual(['drivetrain', 'fuelType', 'trim']);
      expect(reconciled.selection).toEqual({ modelId: 'new-model' });
      expect(reconciled.result.candidates).toHaveLength(1);
    });
  });
}
