import { describe, expect, it } from 'vitest';
import { generationGuard, monthIndex, registrationMonthDecides } from '../src/application/identity-generation-guard.js';
import { generationMonths, refineEngineIdentity, type IdentityMaster } from '../src/application/identity-promotion-plan.js';

// 최초등록 월로 세대가 겹치는 해를 가른다(PC3 커맨드 10-28): 2332 «신형 K5(DL3)» 2023년식·등록 2023-04 → 더 뉴 K5 DL3(2023-11 출시) 전이라 K5 DL3.
const m = (over: Partial<IdentityMaster> & Pick<IdentityMaster, 'id' | 'sub_model'>): IdentityMaster => ({
  maker: '기아', model: 'K5', model_aliases: [], sub_model_aliases: [], yearFrom: null, yearTo: null, trims: [{ name: '트렌디', aliases: [] }], ...over });
const dl3 = m({ id: 'dl3', sub_model: 'K5 DL3', sub_model_aliases: ['신형 K5'], yearFrom: 2019, yearTo: 2023, monthFrom: '2019-12', monthTo: '2023-10' });
const fl = m({ id: 'fl', sub_model: '더 뉴 K5 DL3', yearFrom: 2023, yearTo: null, monthFrom: '2023-11', monthTo: null });
const jf = m({ id: 'jf', sub_model: 'K5 JF', yearFrom: 2015, yearTo: 2018, monthFrom: '2015-07', monthTo: '2019-11' });
const masters = [dl3, fl, jf];
// «신형» 앞 수식어 처리는 #821 몫이라 여기서는 수식어 없는 원문으로 등록월 근거만 고정한다.
const raw = 'K5(DL3) 2.0 가솔린 트렌디';

describe('최초등록 월 세대 근거', () => {
  it('월 번호: «YYYY-MM» 이상만, 연도만·형식 틀림은 null', () => {
    expect(monthIndex('2023-04')).toBe(2023 * 12 + 3);
    expect(monthIndex('2023-04-17')).toBe(2023 * 12 + 3);
    expect(monthIndex('2023.04')).toBe(2023 * 12 + 3);
    for (const bad of ['2023', '2023-13', '2023-4', '', null, 2023]) expect(monthIndex(bad)).toBeNull();
  });

  it('2023년식 등록 2023-04 → K5 DL3(전에는 연식 겹침으로 보류), 등록 2024-03 → 더 뉴 K5 DL3 쪽이라 K5 DL3 로 정하지 않음', () => {
    expect(refineEngineIdentity({ rawName: raw, year: '2023' }, masters)).toBeNull();
    expect(refineEngineIdentity({ rawName: raw, year: '2023', firstRegistration: '2023-04' }, masters)).toMatchObject({ sub_model: 'K5 DL3', trim_name: '트렌디' });
    expect(generationGuard({ rawName: raw, year: '2023', master: dl3, masters, firstRegistration: '2024-03' })).toBe('GENERATION_EVIDENCE_MISSING');
  });

  it('경계 ±1개월(단종 2023-10 · 출시 2023-11 근처)은 판정하지 않는다', () => {
    for (const reg of ['2023-09', '2023-10', '2023-11', '2023-12']) expect(registrationMonthDecides(dl3, [fl, jf], reg)).toBe(false);
    expect(registrationMonthDecides(dl3, [fl, jf], '2023-08')).toBe(true);
    expect(registrationMonthDecides(fl, [dl3, jf], '2024-02')).toBe(true);
    expect(registrationMonthDecides(dl3, [fl, jf], '2019-12')).toBe(false);   // 출시월 자체도 경계
  });

  it('«YYYY-01-01»·«YYYY-01» 은 연도 자리채움일 수 있어 월 근거로 쓰지 않는다(운영 오탐 2건: GV80·팰리세이드 1월 1일 등록)', () => {
    const gv80 = m({ id: 'jx1', maker: '제네시스', model: 'GV80', sub_model: 'GV80 JX1', yearFrom: 2020, yearTo: null, monthFrom: '2020-01', monthTo: '2023-09' });
    const gv80fl = m({ id: 'jx1fl', maker: '제네시스', model: 'GV80', sub_model: 'GV80 JX1 FL', yearFrom: 2023, yearTo: null, monthFrom: '2023-09', monthTo: null });
    for (const reg of ['2023-01-01', '2023-01', '2023.01.01']) expect(registrationMonthDecides(gv80, [gv80fl], reg)).toBe(false);
    expect(registrationMonthDecides(gv80, [gv80fl], '2023-01-17')).toBe(true);   // 일자가 있는 1월은 실제 날짜
    expect(registrationMonthDecides(gv80, [gv80fl], '2023-04')).toBe(true);
  });

  it('두 세대에 걸치면(기간 겹침) 판정하지 않는다', () => {
    const overlap = { ...jf, monthTo: '2020-06' };   // JF 단종이 DL3 출시 뒤까지 걸쳐 있음
    expect(registrationMonthDecides(dl3, [fl, overlap], '2020-03')).toBe(false);
  });

  it('형제 세대 하나라도 출시·단종월이 없으면 판정하지 않는다', () => {
    const { monthFrom: _f, monthTo: _t, ...noMonths } = fl;
    expect(registrationMonthDecides(dl3, [noMonths, jf], '2022-05')).toBe(false);
  });

  it('연식이 이 세대 범위 밖이면 등록월이 맞아도 정하지 않는다', () => {
    expect(generationGuard({ rawName: raw, year: '2024', master: dl3, masters, firstRegistration: '2023-04' })).toBe('GENERATION_EVIDENCE_MISSING');
  });

  it('«신형» 같은 글자·연식만으로는 정하지 않는다(등록일 없음 → 보류)', () => {
    expect(refineEngineIdentity({ rawName: raw, year: '2023', firstRegistration: '2023' }, masters)).toBeNull();
  });

  it('세대 출시·단종월: 트림 행 최소·최대, «현재»는 끝 없음, 하나라도 월 근거가 없으면 없음', () => {
    expect(generationMonths([{ productionStart: '2020-03', productionEnd: '2023-11' }, { productionStart: '2021-08', productionEnd: '2023-11' }])).toEqual({ monthFrom: '2020-03', monthTo: '2023-11' });
    expect(generationMonths([{ productionStart: '2023-11', productionEnd: '현재' }, { productionStart: '2023-11', productionEnd: '2025-05' }])).toEqual({ monthFrom: '2023-11', monthTo: null });
    expect(generationMonths([{ productionStart: '2020', productionEnd: '2023-11' }])).toEqual({});
    expect(generationMonths([])).toEqual({});
  });
});
