import { describe, expect, it } from 'vitest';
import { normalizedMasterCandidate } from '../src/application/identity-normalized-match.js';
import { buildIdentityPromotionPlan, refineEngineIdentity, type IdentityMaster, type IdentityProduct } from '../src/application/identity-promotion-plan.js';

// 정규화 후보(확정 아님): 값은 합성. 엄격 매칭이 놓치는 원문 표기를 «후보»로만 낸다.
const master = (over: Partial<IdentityMaster> & Pick<IdentityMaster, 'id' | 'maker' | 'model' | 'sub_model'>): IdentityMaster => ({ model_aliases: [], sub_model_aliases: [], yearFrom: null, yearTo: null, trims: [], ...over });
const masters: IdentityMaster[] = [
  master({ id: 'ka4', maker: '기아', model: '카니발', sub_model: '카니발 KA4', yearFrom: 2020, yearTo: null }),
  master({ id: 'yp', maker: '기아', model: '카니발', sub_model: '카니발 YP', yearFrom: 2014, yearTo: 2019 }),
  master({ id: 'k5dl3', maker: '기아', model: 'K5', sub_model: 'K5 DL3', yearFrom: 2019, yearTo: null }),
  master({ id: 'k5jf', maker: '기아', model: 'K5', sub_model: 'K5 JF', yearFrom: 2015, yearTo: 2018 }),
  master({ id: 'k5h', maker: '기아', model: 'K5', sub_model: 'K5 하이브리드 DL3', yearFrom: 2020, yearTo: null }),
  master({ id: 'k50', maker: '렉서스', model: 'K50', sub_model: 'K50 X1', yearFrom: 2021, yearTo: null }),
];
const product = (id: string, rawName: string, year: string, maker = ''): IdentityProduct => ({ id, plate4: id.slice(-4), maker, model: '', sub_model: rawName, trim_name: '', rawName, year, listable: true });

describe('정규화 후보(확정 아님)', () => {
  it('접두·세대 표기가 있는 원문은 핵심어 + 연식으로 세대 후보 하나를 낸다', () => {
    expect(normalizedMasterCandidate({ rawName: '신형 카니발 9인승 디젤', year: '2023' }, masters)?.master.id).toBe('ka4');
    expect(normalizedMasterCandidate({ rawName: '더뉴카니발 4세대 리무진', year: '2022' }, masters)?.master.id).toBe('ka4');
    expect(normalizedMasterCandidate({ rawName: '기아_카니발_가솔린 3.5', year: '2016' }, masters)?.master.id).toBe('yp');
  });

  it('원문에 마스터에 없는 개발코드가 있으면 후보로 내지 않는다(새 세대를 기존 세대로 묶지 않음), 코드가 이름의 일부면 통과', () => {
    expect(normalizedMasterCandidate({ rawName: '기아_카니발 (KA5)_가솔린', year: '2024' }, masters)).toBeNull();
    expect(normalizedMasterCandidate({ rawName: '기아_카니발 (KA4)_가솔린', year: '2024' }, masters)?.master.id).toBe('ka4');
    expect(normalizedMasterCandidate({ rawName: '신형K5 2.0 가솔린', year: '2022' }, masters)?.master.id).toBe('k5dl3');
  });

  it('짧은 모델 이름(K5)은 낱말 경계로만 — 신형K5·K5 K5 는 후보, K50 과 섞이지 않는다', () => {
    expect(normalizedMasterCandidate({ rawName: '신형K5 2.0 가솔린', year: '2022' }, masters)?.master.id).toBe('k5dl3');
    expect(normalizedMasterCandidate({ rawName: '기아_K5_K5 2.0', year: '2021' }, masters)?.master.id).toBe('k5dl3');
    expect(normalizedMasterCandidate({ rawName: 'K50 X1 프리미엄', year: '2022' }, masters)?.master.id).toBe('k50');
    expect(normalizedMasterCandidate({ rawName: 'K50 X1 프리미엄', year: '2022', maker: '기아' }, masters)).toBeNull();   // 제조사 제약
  });

  it('변형(하이브리드)은 원문에 있을 때만 변형 후보, 없으면 변형 후보를 뺀다', () => {
    expect(normalizedMasterCandidate({ rawName: '신형 K5 하이브리드', year: '2022' }, masters)?.master.id).toBe('k5h');
    expect(normalizedMasterCandidate({ rawName: '신형 K5 2.0', year: '2022' }, masters)?.master.id).toBe('k5dl3');
  });

  it('세대가 여럿인데 연식이 없거나 범위 밖이면 후보를 내지 않는다(추정 금지), 마스터에 없는 모델도 null', () => {
    expect(normalizedMasterCandidate({ rawName: '신형 카니발', year: '' }, masters)).toBeNull();
    expect(normalizedMasterCandidate({ rawName: '기아 타스만 2.5T', year: '2025' }, masters)).toBeNull();
  });

  it('계획서·엔진 연결: MATCH 가 아니라 NORMALIZED_CANDIDATE 보류이며 적용(정정)·엔진 정제는 하지 않는다', () => {
    const r = buildIdentityPromotionPlan([product('p0001', '신형 카니발 9인승 디젤', '2023')], masters);
    expect(r.held.map(h => [h.reason, h.candidates])).toEqual([['NORMALIZED_CANDIDATE', ['ka4']]]);
    expect(r.plan.productIdentityRepairs ?? []).toEqual([]);
    expect(refineEngineIdentity({ rawName: '신형 카니발 9인승 디젤', year: '2023' }, masters)).toBeNull();
  });
});
