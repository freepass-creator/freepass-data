import { describe, expect, it } from 'vitest';
import { buildIdentityPromotionPlan, type IdentityMaster, type IdentityProduct } from '../src/application/identity-promotion-plan.js';
import type { VehicleNameRepairPlan as InfraRepairPlan } from '../src/infra/vehicle-name-reference-repair-firestore.js';

const master = (over: Partial<IdentityMaster> & Pick<IdentityMaster, 'id' | 'sub_model'>): IdentityMaster => ({ maker: '현대', model: '아반떼', model_aliases: [], sub_model_aliases: [],
  yearFrom: null, yearTo: null, trims: [], ...over });
const product = (over: Partial<IdentityProduct> & Pick<IdentityProduct, 'id'>): IdentityProduct => ({ plate4: '1234', maker: '', model: '', sub_model: '', trim_name: '',
  rawName: '', year: '', listable: false, ...over });

const masters: IdentityMaster[] = [
  master({ id: 'm-cn7', sub_model: '더 뉴 아반떼 CN7', sub_model_aliases: ['아반떼'], yearFrom: 2020, yearTo: 2023, trims: [{ name: '프리미엄', aliases: [] }, { name: '인스퍼레이션', aliases: [] }] }),
  master({ id: 'm-cn8', sub_model: '아반떼 CN8', sub_model_aliases: ['아반떼'], yearFrom: 2023, yearTo: null, trims: [{ name: '프리미엄', aliases: [] }, { name: '인스퍼레이션', aliases: [] }] }),
  master({ id: 'm-ioniq5', maker: '현대', model: '아이오닉 5', model_aliases: ['아이오닉5'], sub_model: '아이오닉 5 NE', sub_model_aliases: ['아이오닉5'],
    trims: [{ name: '프레스티지', aliases: [] }, { name: '익스클루시브', aliases: [] }] }),
  master({ id: 'm-arkana', maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL', sub_model_aliases: ['아르카나'], trims: [{ name: '아이코닉', aliases: [] }] }),
];

describe('정체성 승격 계획서 생성기(읽기 전용)', () => {
  it('turns an unmatched product into identity + trim repair candidates only when the master and trim are unique', () => {
    const r = buildIdentityPromotionPlan([
      product({ id: 'p1', plate4: '2282', maker: '현대', model: '아이오닉5', sub_model: '아이오닉5', rawName: '아이오닉5 프레스티지 2WD 롱레인지', year: '2022' }),
      product({ id: 'p2', plate4: '5917', maker: '르노코리아', model: '아르카나', sub_model: '아르카나', rawName: '아르카나 1.6가솔린 아이코닉', year: '2026' }),
    ], masters);
    expect(r.plan.productIdentityRepairs).toEqual([
      { id: 'p1', from: { maker: '현대', model: '아이오닉5', sub_model: '아이오닉5' }, to: { maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE' }, evidence: '원문 차명: 아이오닉5 프레스티지 2WD 롱레인지' },
      { id: 'p2', from: { maker: '르노코리아', model: '아르카나', sub_model: '아르카나' }, to: { maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL' }, evidence: '원문 차명: 아르카나 1.6가솔린 아이코닉' }]);
    expect(r.plan.productTrimRepairs).toEqual([
      { id: 'p1', from: '', to: '프레스티지', evidence: '원문 차명: 아이오닉5 프레스티지 2WD 롱레인지' },
      { id: 'p2', from: '', to: '아이코닉', evidence: '원문 차명: 아르카나 1.6가솔린 아이코닉' }]);
    expect(r.held).toEqual([]);
  });

  it('its output is structurally assignable to the repair path plan type (infra) — compatibility is guarded at compile time', () => {
    const r = buildIdentityPromotionPlan([product({ id: 'p1', maker: '현대', model: '아이오닉5', sub_model: '아이오닉5', rawName: '아이오닉5 프레스티지' })], masters);
    const compatible: InfraRepairPlan = r.plan;     // 이 대입이 컴파일되지 않으면 정정 경로의 계획서 모양과 어긋난 것이다
    expect(compatible.sourceDigest).toBe(r.plan.sourceDigest);
  });

  it('holds when the alias points to two masters and the year cannot decide (never guesses a generation)', () => {
    // «아반떼» 별칭은 CN7(~2023)과 CN8(2023~) 둘에 걸린다: 연식 2023 은 둘 다 범위 안 → 보류, 2026 은 CN8 하나로 특정
    const both = buildIdentityPromotionPlan([product({ id: 'a', maker: '현대', model: '아반떼', sub_model: '아반떼', rawName: '아반떼 프리미엄', year: '2023' })], masters);
    expect(both.held).toEqual([{ id: 'a', plate4: '1234', reason: 'AMBIGUOUS_MASTER', candidates: ['m-cn7', 'm-cn8'] }]);
    expect(both.plan.productIdentityRepairs).toBeUndefined();
    const unknownYear = buildIdentityPromotionPlan([product({ id: 'a', maker: '현대', model: '아반떼', sub_model: '아반떼', rawName: '아반떼 프리미엄', year: '' })], masters);
    expect(unknownYear.held[0]!.reason).toBe('AMBIGUOUS_MASTER');
    const y2026 = buildIdentityPromotionPlan([product({ id: 'a', maker: '현대', model: '아반떼', sub_model: '아반떼', rawName: '아반떼 프리미엄 신형', year: '2026' })], masters);
    expect(y2026.plan.productIdentityRepairs?.[0]?.to.sub_model).toBe('아반떼 CN8');
    expect(y2026.plan.productTrimRepairs).toEqual([{ id: 'a', from: '', to: '프리미엄', evidence: '원문 차명: 아반떼 프리미엄 신형' }]);
  });

  it('holds with no master match, with an unmatched trim, and never writes anything for already-matched products', () => {
    const r = buildIdentityPromotionPlan([
      product({ id: 'x', maker: '기아', model: '카니발', sub_model: '카니발', rawName: '카니발 9인승' }),                       // 마스터 없음
      product({ id: 'y', maker: '르노코리아', model: '아르카나', sub_model: '아르카나', rawName: '아르카나 1.6' }),                // 트림 근거 없음
      product({ id: 'z', maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL', trim_name: '아이코닉', rawName: '아르카나 1.6 아이코닉' }),   // 이미 일치
    ], masters);
    expect(r.held.map(h => [h.id, h.reason])).toEqual([['x', 'NO_MASTER_MATCH'], ['y', 'NO_TRIM_MATCH']]);
    expect(r.plan.productIdentityRepairs?.map(i => i.id)).toEqual(['y']);          // x 보류·z 이미 일치 → 정정 후보는 y 의 정체성뿐
    // y 는 정체성만 고치고 트림은 지어내지 않는다 → NO_TRIM_MATCH 로 보류
    const y = buildIdentityPromotionPlan([product({ id: 'y', maker: '르노코리아', model: '아르카나', sub_model: '아르카나', rawName: '아르카나 1.6' })], masters);
    expect(y.held).toEqual([{ id: 'y', plate4: '1234', reason: 'NO_TRIM_MATCH', candidates: [] }]);
    expect(y.plan.productIdentityRepairs).toHaveLength(1);
    expect(y.plan.productTrimRepairs).toBeUndefined();
    expect(r.stats.alreadyMatched).toBe(1);
  });

  it('is deterministic (order-independent digest) and carries no full plate numbers', () => {
    const items = [product({ id: 'b', maker: '현대', model: '아이오닉5', sub_model: '아이오닉5', rawName: '아이오닉5 프레스티지' }),
      product({ id: 'a', maker: '르노코리아', model: '아르카나', sub_model: '아르카나', rawName: '아르카나 아이코닉' })];
    const forward = buildIdentityPromotionPlan(items, masters), backward = buildIdentityPromotionPlan([...items].reverse(), masters);
    expect(forward.plan).toEqual(backward.plan);
    expect(JSON.stringify(forward)).not.toMatch(/\d{2,3}[가-힣]\d{4}/);
  });
});
