import { describe, expect, it } from 'vitest';
import { buildIdentityPromotionPlan, type IdentityMaster, type IdentityProduct } from '../src/application/identity-promotion-plan.js';
import { validateVehicleNameRepairPlan, type VehicleNameRepairPlan as InfraRepairPlan } from '../src/infra/vehicle-name-reference-repair-firestore.js';

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
    // 같은 상품의 정체성과 세부트림은 한 계획에 겹치지 않는다(정정 경로 one product per plan) → 세부트림은 두 번째 계획
    expect(r.plan.productTrimRepairs).toBeUndefined();
    expect(r.trimPlan?.productTrimRepairs).toEqual([
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
    expect(y2026.trimPlan?.productTrimRepairs).toEqual([{ id: 'a', from: '', to: '프리미엄', evidence: '원문 차명: 아반떼 프리미엄 신형' }]);
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
  it('reads engine-ingested documents (maker·model blank, raw name parked in sub_model) and every plan passes the repair-path validator', () => {
    const engineDoc = product({ id: 'e1', sub_model: '아이오닉5 프레스티지 롱레인지', rawName: '' });
    const r = buildIdentityPromotionPlan([engineDoc,
      product({ id: 'e2', sub_model: '아르카나 아이코닉', rawName: '아르카나 아이코닉' }),
      product({ id: 'k', maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL', rawName: '아르카나 아이코닉' })], masters);
    expect(r.plan.productIdentityRepairs?.map(i => [i.id, i.from.sub_model, i.to.sub_model])).toEqual([
      ['e1', '아이오닉5 프레스티지 롱레인지', '아이오닉 5 NE'], ['e2', '아르카나 아이코닉', '아르카나 LJL']]);
    expect(r.plan.productTrimRepairs?.map(i => i.id)).toEqual(['k']);              // 정체성이 이미 맞는 상품의 세부트림은 첫 계획에
    expect(r.trimPlan?.productTrimRepairs?.map(i => [i.id, i.to])).toEqual([['e1', '프레스티지'], ['e2', '아이코닉']]);
    expect(() => validateVehicleNameRepairPlan(r.plan as InfraRepairPlan)).not.toThrow();
    expect(() => validateVehicleNameRepairPlan(r.trimPlan as InfraRepairPlan)).not.toThrow();
  });

  it('same-name trim rows (powertrain/year variants) are one name, not ambiguous; different names of the same length still hold', () => {
    const dup = master({ id: 'm-dup', maker: '기아', model: '쏘렌토', sub_model: '쏘렌토 MQ4', sub_model_aliases: ['쏘렌토'],
      trims: [{ name: '프레스티지', aliases: [] }, { name: '프레스티지', aliases: ['프레스티지 2WD'] }, { name: '노블레스', aliases: [] }] });
    const same = buildIdentityPromotionPlan([product({ id: 'd1', maker: '기아', model: '쏘렌토', sub_model: '쏘렌토 MQ4', rawName: '쏘렌토 프레스티지', year: '2022' })], [dup]);
    expect(same.held).toEqual([]);
    expect(same.plan.productTrimRepairs?.map(i => [i.id, i.to])).toEqual([['d1', '프레스티지']]);
    // 서로 다른 이름이 같은 길이로 걸리면 여전히 모호 → 보류(추측 금지)
    const two = master({ id: 'm-two', maker: '기아', model: '쏘렌토', sub_model: '쏘렌토 MQ4', sub_model_aliases: ['쏘렌토'],
      trims: [{ name: '프리미엄', aliases: [] }, { name: '노블레스', aliases: [] }] });
    const amb = buildIdentityPromotionPlan([product({ id: 'd2', maker: '기아', model: '쏘렌토', sub_model: '쏘렌토 MQ4', rawName: '쏘렌토 프리미엄 노블레스', year: '2022' })], [two]);
    expect(amb.held.map(h => h.reason)).toEqual(['AMBIGUOUS_TRIM']);
    expect(amb.held[0]!.candidates).toEqual(['노블레스', '프리미엄']);
  });

  it('R4: 원문에 하이브리드·HEV 가 있는데 고른 마스터 이름에 없으면 일반 세대를 잘못 고른 것 — 보류, 하이브리드 마스터가 있으면 그쪽', () => {
    const plain = master({ id: 'm-dn8', maker: '현대', model: '쏘나타', sub_model: '쏘나타 DN8', yearFrom: 2019, trims: [{ name: '모던', aliases: [] }] });
    const hybrid = master({ id: 'm-dn8h', maker: '현대', model: '쏘나타', sub_model: '쏘나타 하이브리드 DN8', yearFrom: 2019, trims: [{ name: '모던', aliases: [] }] });
    const raw = '현대_쏘나타(DN8) 하이브리드_2.0 HEV / 모던';
    // 하이브리드 마스터가 없으면: 일반 세대(쏘나타 DN8)를 고르지 않고 보류
    const without = buildIdentityPromotionPlan([product({ id: 'v1', rawName: raw, year: '2022' })], [plain]);
    expect(without.held.map(h => h.reason)).toEqual(['VARIANT_MISMATCH']);
    expect(without.plan.productIdentityRepairs).toBeUndefined();
    // 하이브리드 마스터가 있고 원문에 그 이름이 통째로 들어 있으면 그쪽을 고른다
    const withHybrid = buildIdentityPromotionPlan([product({ id: 'v2', rawName: '현대 쏘나타 하이브리드 DN8 모던', year: '2022' })], [plain, hybrid]);
    expect(withHybrid.plan.productIdentityRepairs?.[0]?.to.sub_model).toBe('쏘나타 하이브리드 DN8');
    // 원문에 변형이 없으면 영향 없음
    const normal = buildIdentityPromotionPlan([product({ id: 'v3', rawName: '현대 쏘나타 DN8 모던', year: '2022' })], [plain]);
    expect(normal.plan.productIdentityRepairs?.[0]?.to.sub_model).toBe('쏘나타 DN8');
    // 플러그인 하이브리드는 하이브리드와 다른 변형
    const phev = buildIdentityPromotionPlan([product({ id: 'v4', rawName: '기아 K5 DL3 플러그인 하이브리드', year: '2022' })],
      [master({ id: 'k5', maker: '기아', model: 'K5', sub_model: 'K5 DL3', yearFrom: 2019 })]);
    expect(phev.held.map(h => h.reason)).toEqual(['VARIANT_MISMATCH']);
  });

  it('이미 값이 있는 트림은 근거 없이 다른 등급으로 바꾸지 않는다(TRIM_CONFLICT_EXISTING), 빈칸 채우기·철자만 다른 정정은 그대로', () => {
    const m = master({ id: 'm-x', maker: '기아', model: '카니발', sub_model: '카니발 KA4', yearFrom: 2020,
      trims: [{ name: '노블레스', aliases: [] }, { name: '그래비티', aliases: [] }, { name: '프레스티지', aliases: [] }] });
    const r = buildIdentityPromotionPlan([
      product({ id: 'c1', maker: '기아', model: '카니발', sub_model: '카니발 KA4', trim_name: '노블레스', rawName: '카니발 KA4 그래비티', year: '2022' }),   // 다른 등급으로 덮어쓰기 → 보류
      product({ id: 'c2', maker: '기아', model: '카니발', sub_model: '카니발 KA4', trim_name: '', rawName: '카니발 KA4 프레스티지', year: '2022' }),       // 빈칸 → 값
      product({ id: 'c3', maker: '기아', model: '카니발', sub_model: '카니발 KA4', trim_name: '프레스 티지', rawName: '카니발 KA4 프레스티지', year: '2022' }), // 철자만 다름 → 정정
    ], [m]);
    expect(r.held.filter(h => h.reason === 'TRIM_CONFLICT_EXISTING').map(h => [h.id, h.candidates])).toEqual([['c1', ['그래비티']]]);
    expect(r.plan.productTrimRepairs?.map(i => [i.id, i.to]).sort()).toEqual([['c2', '프레스티지'], ['c3', '프레스티지']]);
  });

  it('Codex #669 ①: EV·일렉트릭 변형 — 같은 모델에 EV 형제 마스터가 있으면 일반 마스터는 보류, EV 전용 모델(형제 없음)은 통과', () => {
    const kona = master({ id: 'kona', maker: '현대', model: '코나', sub_model: '코나 SX2', yearFrom: 2023 });
    const konaEv = master({ id: 'kona-ev', maker: '현대', model: '코나', sub_model: '코나 일렉트릭 SX2', yearFrom: 2023 });
    const ioniq5 = master({ id: 'io5', maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE', sub_model_aliases: ['아이오닉5'], yearFrom: 2021 });
    const run = (rawName: string, masters: IdentityMaster[]) => buildIdentityPromotionPlan([product({ id: 'e', rawName, year: '2024' })], masters);
    expect(run('현대 코나 SX2 EV 롱레인지', [kona, konaEv]).held.map(h => h.reason)).toEqual(['VARIANT_MISMATCH']);   // 코나 EV → 코나 통과 금지
    expect(run('현대 코나 SX2 일렉트릭', [kona, konaEv]).held.map(h => h.reason)).toEqual(['VARIANT_MISMATCH']);
    expect(run('현대 코나 일렉트릭 SX2', [kona, konaEv]).plan.productIdentityRepairs?.[0]?.to.sub_model).toBe('코나 일렉트릭 SX2');
    expect(run('현대 아이오닉5 EV 롱레인지', [ioniq5]).plan.productIdentityRepairs?.[0]?.to.sub_model).toBe('아이오닉 5 NE');   // EV 전용 → 통과
  });

  it('Codex #669 ②: 변형 낱말은 단어 경계로만 본다 — CHEVROLET 의 HEV·EV6 의 EV 는 변형이 아니다', () => {
    const trax = master({ id: 'tx', maker: '쉐보레', model: '트랙스', sub_model: '트랙스 크로스오버', yearFrom: 2023 });
    const ev6 = master({ id: 'ev6', maker: '기아', model: 'EV6', sub_model: 'EV6 CV', yearFrom: 2021 });
    const a = buildIdentityPromotionPlan([product({ id: 'c', rawName: 'CHEVROLET 트랙스 크로스오버', year: '2024' })], [trax]);
    expect(a.held.map(h => h.reason)).not.toContain('VARIANT_MISMATCH');
    expect(a.plan.productIdentityRepairs?.[0]?.to.sub_model).toBe('트랙스 크로스오버');
    const b = buildIdentityPromotionPlan([product({ id: 'd', rawName: '기아 EV6 CV 롱레인지', year: '2022' })], [ev6]);
    expect(b.held.map(h => h.reason)).not.toContain('VARIANT_MISMATCH');
    expect(b.plan.productIdentityRepairs?.[0]?.to.sub_model).toBe('EV6 CV');
  });

  it('Codex #669 ③: 이미 세부모델이 채워진 상품도 원문에 변형이 있으면 같은 검사를 받는다(빈칸 조건문 우회 없음)', () => {
    const plain = master({ id: 'm-dn8', maker: '현대', model: '쏘나타', sub_model: '쏘나타 DN8', yearFrom: 2019 });
    const filled = product({ id: 'f1', maker: '현대', model: '쏘나타', sub_model: '쏘나타 DN8', rawName: '현대_쏘나타(DN8) 하이브리드_2.0 HEV', year: '2022' });
    const r = buildIdentityPromotionPlan([filled], [plain]);
    expect(r.held.map(h => h.reason)).toEqual(['VARIANT_MISMATCH']);
    expect(r.stats.alreadyMatched).toBe(0);
  });

  it('Codex #669 ④: 엔진 임시 표식 문서의 트림은 근거가 유일하면 덮어쓴다(표식 없는 확정 값은 계속 보류)', () => {
    const m = master({ id: 'm-t', maker: '기아', model: '카니발', sub_model: '카니발 KA4', yearFrom: 2020,
      trims: [{ name: '노블레스', aliases: [] }, { name: '그래비티', aliases: [] }] });
    const base = { maker: '기아', model: '카니발', sub_model: '카니발 KA4', trim_name: '노블레스', rawName: '카니발 KA4 그래비티', year: '2022' };
    const temp = buildIdentityPromotionPlan([product({ id: 't1', ...base, engineTemp: true })], [m]);
    expect(temp.plan.productTrimRepairs?.map(i => [i.id, i.from, i.to])).toEqual([['t1', '노블레스', '그래비티']]);
    const confirmed = buildIdentityPromotionPlan([product({ id: 't2', ...base })], [m]);
    expect(confirmed.held.map(h => h.reason)).toEqual(['TRIM_CONFLICT_EXISTING']);
  });
});

describe('원문 형태 세부모델 + 채워진 제조사·모델(입구 매핑 뒤, B3Q 18:00 회차)', () => {
  const sonata = master({ id: 'm-dn8', maker: '현대', model: '쏘나타', sub_model: '쏘나타 DN8', yearFrom: 2019, yearTo: null, trims: [{ name: '프리미엄', aliases: [] }] });
  const raw = '현대_쏘나타 DN8_가솔린 2.0 / 프리미엄';
  const tempDoc = (over: Partial<IdentityProduct> = {}) => product({ id: 'p', plate4: '9203', maker: '현대', model: '쏘나타', sub_model: raw, rawName: raw, year: '2024', listable: true, engineTemp: true, ...over });

  it('채움 표식(makerModelFromSource)이 없어도 엔진 임시 표식 + 세부모델=원문이면 원문 대조 경로로 마스터에 매칭된다', () => {
    const r = buildIdentityPromotionPlan([tempDoc()], [sonata]);
    expect(r.plan.productIdentityRepairs?.map(x => x.to.sub_model)).toEqual(['쏘나타 DN8']);
  });

  it('표식이 있을 때와 같은 결과(maker·model 이 비어 있는 경로와 동일)', () => {
    const withFlag = buildIdentityPromotionPlan([tempDoc({ makerModelFromSource: true })], [sonata]);
    const blank = buildIdentityPromotionPlan([tempDoc({ maker: '', model: '' })], [sonata]);
    const noFlag = buildIdentityPromotionPlan([tempDoc()], [sonata]);
    expect(noFlag.plan.productIdentityRepairs).toEqual(withFlag.plan.productIdentityRepairs);
    expect(noFlag.plan.productIdentityRepairs?.map(x => x.to.sub_model)).toEqual(blank.plan.productIdentityRepairs?.map(x => x.to.sub_model));
  });

  it('제조사가 다르면 제약으로 남는다(다른 제조사 마스터에 매칭하지 않는다), 임시 표식이 없으면 종전 정확 비교', () => {
    const other = master({ id: 'm-kia', maker: '기아', model: 'K5', sub_model: 'K5 DL3' });
    const none = buildIdentityPromotionPlan([tempDoc({ maker: '기아', model: 'K5', sub_model: '현대_쏘나타 DN8', rawName: '현대_쏘나타 DN8' })], [sonata, other]);
    expect(none.plan.productIdentityRepairs ?? []).toEqual([]);
    const human = buildIdentityPromotionPlan([tempDoc({ engineTemp: false })], [sonata]);
    expect(human.plan.productIdentityRepairs ?? []).toEqual([]);   // 사람이 정리한 문서(임시 표식 없음)는 세부모델 정확 비교만
  });

  it('마스터에 없는 모델이면 이름을 만들지 않고 NO_MASTER_MATCH 로 둔다', () => {
    const r = buildIdentityPromotionPlan([tempDoc({ model: '타스만', sub_model: '기아_타스만_2.5T', rawName: '기아_타스만_2.5T', maker: '기아' })], [sonata]);
    expect(r.plan.productIdentityRepairs ?? []).toEqual([]);
    expect(r.held.some(h => h.reason === 'NO_MASTER_MATCH')).toBe(true);
  });
});
