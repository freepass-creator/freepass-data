import { describe, expect, it } from 'vitest';
import { stableDigest } from '../src/shared/stable-digest.js';
import { MAX_VEHICLE_NAME_REPAIR_TARGETS, matchesFrom, normalizeName, validateVehicleNameRepairPlan } from '../src/infra/vehicle-name-reference-repair-firestore.js';

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
  it('accepts only normalized name text in creates and renames — spaces and full-width letters are refused, Ⅱ is kept', () => {
    const trim = (t: string) => ({ id: 'k1', evidence: 'x', data: { maker: '기아', model: '카니발', sub_model: '카니발 KA4', trim: t, master_id: 'm', trim_row_key: 'k1' } });
    const plan = (t: string) => ({ sourceDigest: 'd', masterRepairs: [], productRepairs: [], trimCreates: [trim(t)] });
    expect(() => validateVehicleNameRepairPlan(plan(' 프리미엄'))).toThrow(/normalized/);
    expect(() => validateVehicleNameRepairPlan(plan('ＬＥ'))).toThrow(/normalized/); // 전각
    expect(() => validateVehicleNameRepairPlan(plan('X  Line'))).toThrow(/normalized/);
    expect(validateVehicleNameRepairPlan(plan('마스터즈 Ⅱ'))).toMatchObject({ trimCreateCount: 1 });
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [],
      trimSubModelRepairs: [{ id: 't', from: 'A', to: '그랜저 GN7 ' }] })).toThrow(/normalized/);
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', masterRepairs: [], productRepairs: [],
      trimRepairs: [{ id: 't', from: 'TCe LE', to: 'ＬＥ' }] })).toThrow(/normalized/);
    expect(normalizeName('포터 Ⅱ')).toBe('포터 Ⅱ');
    expect(normalizeName('　ＬＥ  플러스 ')).toBe('LE 플러스');
    // Stable: the width change runs before NFC, so a second pass changes nothing.
    for (const v of ['Ａ̊', 'ｅ́', '　ＬＥ  플러스 ']) expect(normalizeName(normalizeName(v))).toBe(normalizeName(v));
    expect(matchesFrom('Ａ̊', 'Å')).toBe(true);
  });
  it('validates retire items: exact ids, not into itself, not combined with a rename of the same master', () => {
    const base = { sourceDigest: 'd', masterRepairs: [], productRepairs: [] };
    expect(validateVehicleNameRepairPlan({ ...base, masterRetires: [{ id: 'm1', into: 'm2', evidence: '합쳐짐' }] })).toMatchObject({ masterRetireCount: 1 });
    expect(() => validateVehicleNameRepairPlan({ ...base, masterRetires: [{ id: 'm1', into: 'm1', evidence: 'x' }] })).toThrow(/itself/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterRetires: [{ id: ' m1', into: 'm2', evidence: 'x' }] })).toThrow(/exact/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterRetires: [{ id: 'm1', into: 'm2', evidence: ' ' }] })).toThrow(/evidence/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterRetires: [{ id: 'm1', into: 'm2', evidence: 'x' }, { id: 'm1', into: 'm3', evidence: 'x' }] })).toThrow(/duplicate/);
    expect(() => validateVehicleNameRepairPlan({ sourceDigest: 'd', productRepairs: [], masterRepairs: [{ id: 'm1', from: 'A', to: 'B' }],
      masterRetires: [{ id: 'm1', into: 'm2', evidence: 'x' }] })).toThrow(/same plan/);
    // final-state rules: no chain or cycle, no new link into a retired master, created masters are active
    expect(() => validateVehicleNameRepairPlan({ ...base, masterRetires: [{ id: 'm1', into: 'm2', evidence: 'x' }, { id: 'm2', into: 'm1', evidence: 'x' }] })).toThrow(/chains or cycles/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterRetires: [{ id: 'm1', into: 'm2', evidence: 'x' }],
      trimMasterLinkRepairs: [{ id: 't1', from: 'm3', to: 'm1' }] })).toThrow(/link a trim row/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterRetires: [{ id: 'm1', into: 'm2', evidence: 'x' }],
      trimCreates: [{ id: 'k1', evidence: 'x', data: { maker: '현대', model: '그랜저', sub_model: '그랜저 GN7', trim: '프리미엄', master_id: 'm1', trim_row_key: 'k1' } }] })).toThrow(/link a trim row/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterRetires: [{ id: 'm1', into: 'm2', evidence: 'x' }],
      masterCreates: [{ id: 'm2', evidence: 'x', data: { id: 'm2', maker: '현대', model: '그랜저', sub_model: '그랜저 GN7', retired: true } }] })).toThrow(/active master/);
  });
  it('accepts a top-level trims list only with its digest, normalized and without duplicates', () => {
    const base = { sourceDigest: 'd', masterRepairs: [], productRepairs: [] };
    const v = { id: 'm', fromDigest: 'a'.repeat(64), to: [{ fuel: '가솔린' }], evidence: 'x' };
    expect(validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...v, trims: ['C 에센셜'], fromTrimsDigest: 'b'.repeat(64) }] })).toMatchObject({ masterVariantCount: 1 });
    expect(() => validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...v, trims: ['C 에센셜'] }] })).toThrow(/together/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...v, trims: [' C 에센셜'], fromTrimsDigest: 'b'.repeat(64) }] })).toThrow(/normalized/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...v, trims: ['A', 'A'], fromTrimsDigest: 'b'.repeat(64) }] })).toThrow(/duplicate/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...v, fromTrimsDigest: 'b'.repeat(64) }] })).toThrow(/together/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...v, trims: [], fromTrimsDigest: 'b'.repeat(64) }] })).toThrow(/non-empty/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...v, trims: ['A'], fromTrimsDigest: 'xyz' }] })).toThrow(/fromTrimsDigest/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...v, trims: [3 as never], fromTrimsDigest: 'b'.repeat(64) }] })).toThrow(/normalized/);
    // no-op rules: same variants but different trims is a change; both the same is a no-op; variants-only still works
    const same = { ...v, fromDigest: stableDigest(v.to) };
    expect(validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...same, trims: ['A'], fromTrimsDigest: stableDigest(['B']) }] })).toMatchObject({ masterVariantCount: 1 });
    expect(() => validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...same, trims: ['A'], fromTrimsDigest: stableDigest(['A']) }] })).toThrow(/no-op/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [same] })).toThrow(/no-op/);
    expect(validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [v] })).toMatchObject({ masterVariantCount: 1 });
    // a master retired in the same plan cannot get a trims edit
    expect(() => validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...v, trims: ['A'], fromTrimsDigest: 'b'.repeat(64) }],
      masterRetires: [{ id: 'm', into: 'm2', evidence: 'x' }] })).toThrow(/same plan/);
  });
  it('validates model and gen_code repairs and the variants-trims ⊆ trims rule', () => {
    const base = { sourceDigest: 'd', masterRepairs: [], productRepairs: [] };
    expect(validateVehicleNameRepairPlan({ ...base, masterModelRepairs: [{ id: 'm', from: '아이오닉5', to: '아이오닉 5' }],
      trimModelRepairs: [{ id: 't', from: '아이오닉5', to: '아이오닉 5' }], masterGenCodeRepairs: [{ id: 'm', from: 'CV1', to: 'CV' }] }))
      .toMatchObject({ masterModelCount: 1, trimModelCount: 1, masterGenCodeCount: 1 });
    expect(() => validateVehicleNameRepairPlan({ ...base, masterModelRepairs: [{ id: 'm', from: '아이오닉5', to: '아이오닉  5' }] })).toThrow(/normalized/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterGenCodeRepairs: [{ id: 'm', from: 'CV1', to: 'CV' }],
      masterRetires: [{ id: 'm', into: 'm2', evidence: 'x' }] })).toThrow(/same plan/);
    const v = { id: 'm', fromDigest: 'a'.repeat(64), to: [{ fuel: '가솔린', trims: ['A', 'B'] }], evidence: 'x', fromTrimsDigest: 'b'.repeat(64) };
    expect(() => validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...v, trims: ['A'] }] })).toThrow(/missing from trims: B/);
    expect(validateVehicleNameRepairPlan({ ...base, masterVariantRepairs: [{ ...v, trims: ['A', 'B', 'C'] }] })).toMatchObject({ masterVariantCount: 1 });
    const create = { id: 'n', evidence: 'x', data: { id: 'n', maker: '현대', model: '그랜저', sub_model: '그랜저 X', origin: '국산', trims: ['A'], variants: [{ trims: ['A', 'Z'] }] } };
    expect(() => validateVehicleNameRepairPlan({ ...base, masterCreates: [create] })).toThrow(/missing from trims: Z/);
    expect(() => validateVehicleNameRepairPlan({ ...base, masterCreates: [{ ...create, data: { ...create.data, trims: undefined } }] })).toThrow(/not a list/);
    expect(validateVehicleNameRepairPlan({ ...base, masterCreates: [{ ...create, data: { ...create.data, trims: undefined, variants: [{ fuel: '가솔린' }] } }] })).toMatchObject({ masterCreateCount: 1 });
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
