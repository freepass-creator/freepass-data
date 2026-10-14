import { describe, expect, it } from 'vitest';
import { auditConfirmedIdentities, buildIdentityPromotionPlan, matchIdentity, refineEngineIdentity, type IdentityMaster, type IdentityProduct } from '../src/application/identity-promotion-plan.js';
import { generationCode, generationFamilies, generationGuard } from '../src/application/identity-generation-guard.js';

const master = (over: Partial<IdentityMaster> & Pick<IdentityMaster, 'id' | 'sub_model'>): IdentityMaster => ({ maker: '현대', model: '그랜저', model_aliases: [], sub_model_aliases: [],
  yearFrom: null, yearTo: null, trims: [], ...over });
const product = (over: Partial<IdentityProduct> & Pick<IdentityProduct, 'id'>): IdentityProduct => ({ plate4: '1234', maker: '', model: '', sub_model: '', trim_name: '',
  rawName: '', year: '', listable: true, ...over });

// 대표 10-15 지적 2건(커맨드 센터 샘플 검토)의 재현 마스터.
const masters: IdentityMaster[] = [
  master({ id: 'old', sub_model: '뉴 그랜저', yearFrom: 2005, yearTo: 2009 }),
  master({ id: 'gn7', sub_model: '그랜저 하이브리드 GN7', sub_model_aliases: ['그랜저 하이브리드'], yearFrom: 2022, yearTo: null }),
  master({ id: 'ig', sub_model: '그랜저 하이브리드 IG', yearFrom: 2016, yearTo: 2019 }),
  master({ id: 'lx2', maker: '현대', model: '팰리세이드', sub_model: '팰리세이드 LX2', sub_model_aliases: ['팰리세이드'], yearFrom: 2018, yearTo: 2022 }),
  master({ id: 'lx2fl', maker: '현대', model: '팰리세이드', sub_model: '더 뉴 팰리세이드 LX2', sub_model_aliases: [], yearFrom: 2022, yearTo: null }),
];

describe('R1 수식어 일치', () => {
  it('«디 올 뉴 그랜저» 안의 옛 «뉴 그랜저» 이름은 부분 일치로 보지 않는다(보류)', () => {
    const r = matchIdentity(product({ id: 'a', rawName: '현대_디 올뉴그랜저 하이브리드_3.5_캘리그래피', year: '2023' }), masters);
    // 원문에 «뉴 그랜저»(옛 이름)만 통째로 걸리는 경우는 수식어 불일치로 보류
    const old = matchIdentity(product({ id: 'b', rawName: '디 올 뉴 그랜저', year: '2023' }), [masters[0]!]);
    expect(old).toMatchObject({ state: 'HOLD', reason: 'GENERATION_QUALIFIER_MISMATCH' });
    expect(r.state === 'MATCH' ? r.master.id : r.state).not.toBe('old');
  });
  it('마스터 이름이 수식어까지 통째로 걸리면 통과한다(더 뉴 …)', () => {
    const r = matchIdentity(product({ id: 'c', rawName: '현대_더 뉴 팰리세이드 LX2_3.8', year: '2024' }), masters);
    expect(r).toMatchObject({ state: 'MATCH' });
    expect(r.state === 'MATCH' && r.master.id).toBe('lx2fl');
  });
  it('수식어가 없는 원문의 이름은 통과한다', () => {
    expect(generationGuard({ rawName: '아반떼 CN7 프리미엄', year: '2021', master: { ...master({ id: 'x', model: '아반떼', sub_model: '아반떼 CN7' }) }, masters: [] })).toBeNull();
  });
});

describe('R2 형제 세대 연식 근거', () => {
  const lx = (rawName: string, year: string) => matchIdentity(product({ id: 'p', rawName, year }), masters.filter(m => m.model === '팰리세이드'));
  it('«더 뉴» 없는 원문 «팰리세이드»: 두 범위가 겹치지 않는 연식에서만 확정, 겹침(2022)·연식 없음은 보류', () => {
    const early = lx('현대_팰리세이드_3.8 가솔린_프레스티지', '2020');
    expect(early.state === 'MATCH' && early.master.id).toBe('lx2');
    // 별칭 «팰리세이드» 는 1세대 이름에만 이어져 있다 — 2024 는 그 범위 밖이라 보류(«더 뉴» 별칭 등록 전까지 추측하지 않음)
    expect(lx('현대_팰리세이드_3.8 가솔린_프레스티지', '2024')).toMatchObject({ state: 'HOLD', reason: 'GENERATION_EVIDENCE_MISSING' });
    expect(lx('현대_팰리세이드_3.8 가솔린_프레스티지', '2022')).toMatchObject({ state: 'HOLD' });
    expect(lx('현대_팰리세이드_3.8 가솔린_프레스티지', '')).toMatchObject({ state: 'HOLD' });
  });
  it('원문에 개발코드·전체 이름이 있으면 연식 없이도 통과한다', () => {
    const withCode = matchIdentity(product({ id: 'q', rawName: '현대 그랜저 하이브리드 GN7 캘리그래피', year: '' }), masters.filter(m => m.model === '그랜저'));
    expect(withCode).toMatchObject({ state: 'MATCH' });
    expect(withCode.state === 'MATCH' && withCode.master.id).toBe('gn7');
  });
  it('개발코드가 같은 변형(하이브리드)끼리는 세대 형제가 아니다', () => {
    const family = [master({ id: 'g', sub_model: '그랜저 GN7', sub_model_aliases: [], yearFrom: 2022 }), master({ id: 'h', sub_model: '그랜저 하이브리드 GN7', yearFrom: 2022 })];
    expect(generationGuard({ rawName: '그랜저 하이브리드', year: '', master: family[1]!, masters: family })).toBeNull();
  });
  it('개발코드 추출', () => {
    expect(generationCode('더 뉴 그랜저 GN7')).toBe('GN7');
    expect(generationCode('EQ900')).toBe('EQ900');   // 모델명이 코드 역할(규칙 4)
    expect(generationCode('그랜저 하이브리드')).toBe('');
    expect(generationCode('쏘렌토 MQ4')).toBe('MQ4');
  });
});

describe('엔진 정제·계획서·감사·부록', () => {
  it('엔진 정제는 같은 판정기라 근거 없는 세대 선택을 null 로 둔다', () => {
    expect(refineEngineIdentity({ rawName: '현대_팰리세이드_3.8 가솔린_프레스티지', year: '2022' }, masters.filter(m => m.model === '팰리세이드'))).toBeNull();
    expect(refineEngineIdentity({ rawName: '현대_팰리세이드_3.8 가솔린_프레스티지', year: '2020' }, masters.filter(m => m.model === '팰리세이드'))?.sub_model).toBe('팰리세이드 LX2');
  });
  it('계획서 보류 사유·부록(형제 세대 목록·별칭 후보)', () => {
    const r = buildIdentityPromotionPlan([
      product({ id: 'h1', plate4: '1111', rawName: '현대_팰리세이드_3.8 가솔린_프레스티지', year: '2022' }),
      product({ id: 'h2', plate4: '2222', rawName: '현대_팰리세이드_3.8 가솔린_프레스티지', year: '2022' }),
      product({ id: 'ok', plate4: '3333', rawName: '현대_팰리세이드_3.8 가솔린_프레스티지', year: '2020' }),
    ], masters.filter(m => m.model === '팰리세이드'));
    expect(r.held.filter(h => h.reason === 'GENERATION_EVIDENCE_MISSING').map(h => h.id)).toEqual(['h1', 'h2']);
    expect(r.plan.productIdentityRepairs?.map(i => i.id)).toEqual(['ok']);
    expect(r.appendix.generationFamilies.map(f => f.model)).toEqual(['팰리세이드']);
    expect(r.appendix.generationFamilies[0]!.generations.map(g => g.id)).toEqual(['lx2', 'lx2fl']);
    // 별칭 후보: 같은 원문 2대, 2022 는 두 세대 범위에 모두 걸려 unique=false(사람이 결정)
    expect(r.appendix.aliasCandidates[0]).toMatchObject({ count: 2, unique: false, reason: 'GENERATION_EVIDENCE_MISSING' });
  });
  it('감사: 이미 확정된 상품 중 R1/R2 에 걸리는 것만 «검토 필요» 로 센다(공급사별), 되돌리지 않는다', () => {
    const fam = masters.filter(m => m.model === '팰리세이드');
    const rows = [
      { ...product({ id: 'a1', plate4: '0001', maker: '현대', model: '팰리세이드', sub_model: '팰리세이드 LX2', rawName: '현대_팰리세이드_3.8', year: '2022' }), supplier: 'RP012' },
      { ...product({ id: 'a2', plate4: '0002', maker: '현대', model: '팰리세이드', sub_model: '팰리세이드 LX2', rawName: '현대_팰리세이드_3.8', year: '2019' }), supplier: 'RP012' },
      { ...product({ id: 'a3', plate4: '0003', maker: '현대', model: '팰리세이드', sub_model: '팰리세이드 LX2', rawName: '', year: '2019' }), supplier: 'RP023' },
    ];
    const a = auditConfirmedIdentities(rows, fam);
    expect(a.rows.map(r => [r.id, r.verdict])).toEqual([['a1', 'GENERATION_EVIDENCE_MISSING'], ['a2', 'OK'], ['a3', 'UNVERIFIABLE']]);
    expect(a.bySupplier).toEqual({ RP012: { GENERATION_EVIDENCE_MISSING: 1, OK: 1 }, RP023: { UNVERIFIABLE: 1 } });
    expect(generationFamilies(fam)).toHaveLength(1);
  });
});
