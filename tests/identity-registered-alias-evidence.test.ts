import { describe, expect, it } from 'vitest';
import { dropVariantAliasCollisions, matchIdentity, refineEngineIdentity, type IdentityMaster } from '../src/application/identity-promotion-plan.js';
import { generationGuard } from '../src/application/identity-generation-guard.js';

// 2026-10-28 PC3 «새 편입 정제 누락»: 운영 마스터 모양을 줄인 가짜 마스터로, 노출 보류 원인 셋을 고정한다.
const m = (over: Partial<IdentityMaster> & Pick<IdentityMaster, 'id' | 'maker' | 'model' | 'sub_model'>): IdentityMaster => ({
  model_aliases: [], sub_model_aliases: [], yearFrom: null, yearTo: null, trims: [], ...over });
const refine = (rawName: string, year: string, masters: IdentityMaster[]) => refineEngineIdentity({ rawName, year }, masters);
const holdOf = (rawName: string, year: string, masters: IdentityMaster[]) => {
  const r = matchIdentity({ id: '', plate4: '', maker: '', model: '', sub_model: rawName, trim_name: '', rawName, year, listable: true }, masters);
  return r.state === 'MATCH' ? `MATCH ${r.master.sub_model}` : r.reason;
};

describe('① 변형 행 별칭이 일반 행 «별칭»과 같아도 충돌(아르카나)', () => {
  const plain = m({ id: 'ljl', maker: '르노', model: '아르카나', sub_model: '아르카나 LJL', sub_model_aliases: ['아르카나'], yearFrom: 2024,
    trims: [{ name: '아이코닉', aliases: [] }, { name: '테크노', aliases: [] }] });
  const hybrid = m({ id: 'ljl-h', maker: '르노', model: '아르카나', sub_model: '아르카나 하이브리드 LJL', sub_model_aliases: ['아르카나', 'E-TECH 아르카나'], yearFrom: 2024,
    trims: [{ name: 'E-TECH 아이코닉', aliases: [] }] });
  it('원문 «아르카나»·«아르카나 1.6 GTe Iconic» → 일반 아르카나 LJL(전에는 AMBIGUOUS_MASTER)', () => {
    expect(holdOf('아르카나', '2026', [plain, hybrid])).toBe('AMBIGUOUS_MASTER');                         // 충돌 제외 전
    const masters = dropVariantAliasCollisions([plain, hybrid]);
    expect(masters.find(x => x.id === 'ljl-h')!.sub_model_aliases).toEqual(['E-TECH 아르카나']);      // 변형 낱말이 든 별칭은 남는다
    expect(refine('아르카나', '2026', masters)?.sub_model).toBe('아르카나 LJL');
    expect(refine('아르카나 1.6 GTe Iconic', '2026', masters)?.sub_model).toBe('아르카나 LJL');
  });
  it('하이브리드 원문은 일반 아르카나 LJL 로 가지 않는다(정식 이름이 걸리면 하이브리드 행, 아니면 변형 불일치 보류)', () => {
    const masters = dropVariantAliasCollisions([plain, hybrid]);
    expect(refine('아르카나 하이브리드 LJL 아이코닉', '2025', masters)?.sub_model).toBe('아르카나 하이브리드 LJL');
    expect(refine('아르카나 E-TECH 하이브리드 아이코닉', '2025', masters)).toBeNull();
    expect(holdOf('아르카나 E-TECH 하이브리드 아이코닉', '2025', masters)).toBe('VARIANT_MISMATCH');
  });
  it('연식이 갈리는 일반 행의 별칭과는 충돌로 보지 않는다(연식 근거)', () => {
    const old = { ...plain, id: 'old', sub_model: '아르카나 XM', yearFrom: 2015, yearTo: 2019 };
    expect(dropVariantAliasCollisions([old, hybrid]).find(x => x.id === 'ljl-h')!.sub_model_aliases).toEqual(['아르카나', 'E-TECH 아르카나']);
  });
});

describe('② 등록 별칭에 든 앞 수식어는 세대 한정어 불일치가 아니다(K5) — 별칭 자체를 세대 근거로 쓰지는 않는다', () => {
  const dl3 = m({ id: 'dl3', maker: '기아', model: 'K5', sub_model: 'K5 DL3', sub_model_aliases: ['신형 K5', 'K5 3세대'], yearFrom: 2019, yearTo: 2023,
    trims: [{ name: '트렌디', aliases: [] }, { name: '노블레스', aliases: [] }] });
  const fl = m({ id: 'dl3-fl', maker: '기아', model: 'K5', sub_model: '더 뉴 K5 DL3', yearFrom: 2023, trims: [{ name: '트렌디', aliases: [] }] });
  const jf = m({ id: 'jf', maker: '기아', model: 'K5', sub_model: 'K5 JF', yearFrom: 2015, yearTo: 2018 });
  const masters = [dl3, fl, jf];
  it('원문 «신형 K5(DL3) 2.0 가솔린 트렌디» 2022 → K5 DL3 · 트렌디(전에는 GENERATION_QUALIFIER_MISMATCH)', () => {
    expect(holdOf('신형 K5(DL3) 2.0 가솔린 트렌디', '2022', masters.map(x => x))).toBe('MATCH K5 DL3');
    expect(refine('신형 K5(DL3) 2.0 가솔린 트렌디', '2022', masters)).toMatchObject({ sub_model: 'K5 DL3', trim_name: '트렌디' });
  });
  it('2023 은 더 뉴 K5 DL3(2023~)와 연식이 겹쳐 보류한다 — «신형» 별칭은 세대 근거가 아니다(공급사가 부분변경에도 «신형»을 쓴다: 운영 확정 «신형 K5 DL3 … 2023» = 더 뉴 K5 DL3)', () => {
    expect(refine('신형 K5(DL3) 2.0 가솔린 트렌디', '2023', masters)).toBeNull();
    expect(generationGuard({ rawName: '신형 K5(DL3) 2.0 가솔린 트렌디', year: '2023', master: dl3, masters })).toBe('GENERATION_EVIDENCE_MISSING');
  });
  it('«신형 카니발» 2023 도 같은 이유로 일반 카니발 KA4 로 확정하지 않는다(오탐 방지)', () => {
    const ka4 = m({ id: 'ka4', maker: '기아', model: '카니발', sub_model: '카니발 KA4', sub_model_aliases: ['신형 카니발'], yearFrom: 2020, yearTo: 2023 });
    const ka4fl = m({ id: 'ka4fl', maker: '기아', model: '카니발', sub_model: '더 뉴 카니발 KA4', yearFrom: 2023 });
    expect(refine('기아_신형 카니발_9인승 디젤_노블레스', '2023', [ka4, ka4fl])).toBeNull();
  });
  it('등록 별칭이 덮지 않는 앞 수식어는 여전히 불일치(«더 뉴 K5 DL3» 원문을 일반 K5 DL3 으로 고르지 않는다)', () => {
    expect(generationGuard({ rawName: '디 올 뉴 K5 DL3', year: '2021', master: { ...dl3, sub_model_aliases: [] }, masters })).toBe('GENERATION_QUALIFIER_MISMATCH');
    expect(refine('더 뉴 K5(DL3) 1.6 트렌디', '2024', masters)?.sub_model).toBe('더 뉴 K5 DL3');
  });
});
