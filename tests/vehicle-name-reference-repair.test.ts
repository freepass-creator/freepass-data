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
  it('accepts trim-master repairs and rejects no-op or duplicate trim items', () => {
    expect(validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [],
      trimRepairs: [{ id: 't1', from: 'TCe LE', to: 'LE' }] })).toEqual({ masterCount: 0, productCount: 0, trimCount: 1 });
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [],
      trimRepairs: [{ id: 't1', from: 'LE', to: ' LE ' }] })).toThrow(/no-op/);
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [],
      trimRepairs: [{ id: 't1', from: 'A', to: 'B' }, { id: 't1', from: 'A', to: 'C' }] })).toThrow(/duplicate/);
  });
  it('fills a blank name only with source-text evidence', () => {
    expect(validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [],
      productRepairs: [{ id: 'p1', from: '', to: '더 뉴 기아 레이', evidence: '원문: 더 뉴기아 레이 트렌디' }] })).toEqual({ masterCount: 0, productCount: 1 });
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [],
      productRepairs: [{ id: 'p1', from: '', to: '더 뉴 기아 레이' }] })).toThrow(/requires/);
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [],
      productRepairs: [{ id: 'p1', from: ' ', to: '', evidence: 'x' }] })).toThrow(/requires/);
  });
});
