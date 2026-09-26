import { describe, expect, it } from 'vitest';
import {
  reconcileVehicleSelection,
  type VehicleSelectorMode,
  type VehicleSelectorRecord,
} from '../src/domain/vehicle-selector.js';

// Synthetic records exercise matching semantics, not production vehicle facts.
function record(id: string, overrides: Partial<VehicleSelectorRecord> = {}): VehicleSelectorRecord {
  return {
    recordId: id,
    lifecycle: 'CURRENT',
    identityStatus: 'RESOLVED',
    maker: { id: 'maker_test', label: '시험 제조사' },
    model: { id: id === 'source' ? 'model_source' : 'model_target', label: id === 'source' ? '기존 모델' : '변경 모델' },
    generation: { id: 'generation_test', label: '시험 세대' },
    phase: { id: 'phase_test', label: '시험 단계' },
    modelYear: { id: 'year_test', label: '2027년형', value: 2027 },
    powertrain: { id: 'powertrain_test', label: '1.6 터보 하이브리드' },
    fuelType: { id: null, label: 'HYBRID' },
    drivetrain: { id: null, label: 'AWD' },
    seats: { id: null, label: '5인승', value: 5 },
    trim: { id: 'trim_test', label: 'GT' },
    aliases: [],
    ...overrides,
  };
}

const categoricalCases = [
  { axis: 'fuelType', previous: 'HYBRID', different: 'PLUG-IN HYBRID' },
  { axis: 'trim', previous: 'GT', different: 'GT-Line' },
  { axis: 'drivetrain', previous: 'AWD', different: 'E-AWD' },
] as const;

for (const mode of ['NEW_CAR', 'USED_CAR'] as const satisfies readonly VehicleSelectorMode[]) {
  describe(`structured-label reconciliation in ${mode}`, () => {
    for (const { axis, previous, different } of categoricalCases) {
      it(`clears stale ${axis} when the new model only has a substring-related category`, () => {
        const rows = [
          record('source', { [axis]: { id: null, label: previous } }),
          record('target', { [axis]: { id: null, label: different } }),
        ];
        const selection = { modelId: 'model_target', [axis]: previous };
        const before = structuredClone(selection);
        const result = reconcileVehicleSelection(rows, { mode }, selection, ['model']);

        expect(result.clearedAxes).toEqual([axis]);
        expect(result.selection[axis]).toBeUndefined();
        expect(result.selection.modelId).toBe('model_target');
        expect(result.result.candidates.map((item) => item.record.recordId)).toEqual(['target']);
        expect(selection).toEqual(before);
      });

      it(`preserves normalized exact ${axis} after the model changes`, () => {
        const rows = [
          record('source', { [axis]: { id: null, label: previous } }),
          record('target', { [axis]: { id: null, label: previous.toLowerCase() } }),
        ];
        const selectedLabel = `  ${previous}  `;
        const result = reconcileVehicleSelection(
          rows, { mode }, { modelId: 'model_target', [axis]: selectedLabel }, ['model'],
        );

        expect(result.clearedAxes).toEqual([]);
        expect(result.selection[axis]).toBe(selectedLabel);
        expect(result.result.candidates.map((item) => item.record.recordId)).toEqual(['target']);
      });
    }

    it('preserves a descriptive partial powertrain selection after a model change', () => {
      const rows = [
        record('source'),
        record('target', { powertrain: { id: 'pt_target', label: '1.6 터보 플러그인 하이브리드' } }),
      ];
      const result = reconcileVehicleSelection(
        rows, { mode }, { modelId: 'model_target', powertrain: '하이브리드' }, ['model'],
      );

      expect(result.clearedAxes).toEqual([]);
      expect(result.selection.powertrain).toBe('하이브리드');
      expect(result.result.candidates.map((item) => item.record.recordId)).toEqual(['target']);
    });

    it('protects an explicitly changed fuel choice and clears an incompatible old model instead', () => {
      const rows = [
        record('source', { fuelType: { id: null, label: 'HYBRID' } }),
        record('target', { fuelType: { id: null, label: 'PLUG-IN HYBRID' } }),
      ];
      const result = reconcileVehicleSelection(
        rows, { mode }, { modelId: 'model_target', fuelType: 'HYBRID' }, ['fuelType'],
      );

      expect(result.selection.fuelType).toBe('HYBRID');
      expect(result.selection.modelId).toBeUndefined();
      expect(result.clearedAxes).toEqual(['model']);
      expect(result.result.candidates.map((item) => item.record.recordId)).toEqual(['source']);
    });
  });
}
