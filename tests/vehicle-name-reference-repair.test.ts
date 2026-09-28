import { describe, expect, it } from 'vitest';
import { validateVehicleNameRepairPlan } from '../src/infra/vehicle-name-reference-repair-firestore.js';

describe('vehicle-name reference repair gate', () => {
  it('accepts exact non-overlapping master and product repairs', () => {
    expect(validateVehicleNameRepairPlan({
      sourceDigest: 'digest',
      masterRepairs: [{ id: 'master-1', from: 'G80 DH', to: 'G80' }],
      productRepairs: [{ id: '24저4970', from: 'G80 DH', to: 'G80' }],
    })).toEqual({ masterCount: 1, productCount: 1 });
  });

  it('rejects no-op and duplicate targets', () => {
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'digest', masterRepairs: [{ id: 'm', from: 'G80', to: ' G80 ' }], productRepairs: [] })).toThrow(/no-op/);
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'digest', masterRepairs: [], productRepairs: [{ id: 'p', from: 'A', to: 'B' }, { id: 'p', from: 'A', to: 'C' }] })).toThrow(/duplicate/);
  });
});
