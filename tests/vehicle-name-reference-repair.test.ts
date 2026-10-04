import { describe, expect, it } from 'vitest';
import { MAX_VEHICLE_NAME_REPAIR_TARGETS, matchesFrom, validateVehicleNameRepairPlan } from '../src/infra/vehicle-name-reference-repair-firestore.js';

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
  it('rejects non-string evidence and treats only missing/null/empty-string as blank', () => {
    for (const evidence of [{}, false, 123]) expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [],
      productRepairs: [{ id: 'p1', from: '', to: 'X', evidence } as never] })).toThrow();
    expect([undefined, null, '', '  '].map((v) => matchesFrom(v, ''))).toEqual([true, true, true, true]);
    expect([[], [null], 0, false, '레이'].map((v) => matchesFrom(v, ''))).toEqual([false, false, false, false, false]);
    expect(matchesFrom(' G80 ', 'G80')).toBe(true);
  });
  it('renames or moves trim rows to a sub-model and relinks them to a master (세부모델 이름 v1, 하이브리드 떼기)', () => {
    expect(validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [],
      trimSubModelRepairs: [{ id: 't1', from: '그랜저 GN7', to: '그랜저 하이브리드 GN7' }],
      trimMasterLinkRepairs: [{ id: 't1', from: 'm-gn7', to: 'm-gn7-hev' }] }))
      .toEqual({ masterCount: 0, productCount: 0, trimSubModelCount: 1, trimMasterLinkCount: 1 });
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [],
      trimSubModelRepairs: [{ id: 't1', from: '', to: 'X', evidence: '원문' }] })).toThrow(/requires/);
  });
  it('creates master and trim entries only with evidence and required keys', () => {
    const master = { id: 'm-new', data: { id: 'm-new', maker: '현대', model: '쏘나타', sub_model: '쏘나타 디 엣지 DN8', origin: '국산' }, evidence: '현대 공식 2023-03' };
    const trim = { id: 'm-new::v01::t01', data: { maker: '현대', model: '쏘나타', sub_model: '쏘나타 디 엣지 DN8', trim: '프리미엄', master_id: 'm-new', trim_row_key: 'm-new::v01::t01' }, evidence: '엔카 세부등급' };
    expect(validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [], masterCreates: [master], trimCreates: [trim] }))
      .toEqual({ masterCount: 0, productCount: 0, masterCreateCount: 1, trimCreateCount: 1 });
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [], masterCreates: [{ ...master, evidence: ' ' }] })).toThrow(/evidence/);
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [], masterCreates: [{ ...master, data: { ...master.data, id: 'other' } }] })).toThrow(/data.id/);
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [], trimCreates: [{ ...trim, data: { ...trim.data, master_id: '' } }] })).toThrow(/master_id/);
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [], masterCreates: [master, master] })).toThrow(/duplicate/);
  });
  it('caps one plan below the Firestore transaction write limit', () => {
    const many = Array.from({ length: MAX_VEHICLE_NAME_REPAIR_TARGETS + 1 }, (_, i) => ({ id: `t${i}`, from: 'A', to: 'B' }));
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [], trimSubModelRepairs: many })).toThrow(/too large/);
  });
  it('allows a blank fill only for products.sub_model, and repairs products.trim_name by name', () => {
    const blank = { id: 'x', from: '', to: 'Y', evidence: '원문' };
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [blank], productRepairs: [] })).toThrow(/requires/);
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [], trimRepairs: [blank] })).toThrow(/requires/);
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [], productTrimRepairs: [blank] })).toThrow(/requires/);
    expect(validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [],
      productTrimRepairs: [{ id: 'p', from: '프리미엄', to: 'CVX 프리미엄' }] })).toEqual({ masterCount: 0, productCount: 0, productTrimCount: 1 });
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [{ id: 'p', from: 'A', to: 'B' }],
      productTrimRepairs: [{ id: 'p', from: 'C', to: 'D' }] })).toThrow(/overlap/);
  });
});
