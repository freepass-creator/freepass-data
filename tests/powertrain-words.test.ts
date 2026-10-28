import { describe, expect, it } from 'vitest';
import { matchIdentity, stripPowertrainWords, type IdentityMaster, type IdentityProduct } from '../src/application/identity-promotion-plan.js';

// 엔진·파워트레인 이름은 차종이 아니다(차종 기준 한 장). 원문 «스마트스트림» 이 마스터 «스트림» 에 걸려 쏘나타가 엉뚱한 행에 연결되던 문제(대표 2026-10-22).
const m = (over: Partial<IdentityMaster> & Pick<IdentityMaster, 'id' | 'sub_model'>): IdentityMaster => ({ maker: '현대', model: '쏘나타', model_aliases: [], sub_model_aliases: [],
  yearFrom: null, yearTo: null, trims: [], ...over });
const masters: IdentityMaster[] = [
  m({ id: 'stream', maker: '혼다', model: '스트림', sub_model: '스트림', yearFrom: 2000, yearTo: 2014 }),
  m({ id: 'dn8', sub_model: '쏘나타 디 엣지 DN8', sub_model_aliases: ['쏘나타 디 엣지'], yearFrom: 2023, trims: [{ name: '익스클루시브', aliases: [] }] }),
];
const product = (rawName: string, year = '2025'): IdentityProduct => ({ id: 'x', plate4: '0000', maker: '', model: '', sub_model: rawName, trim_name: '', rawName, year, listable: true } as IdentityProduct);

describe('파워트레인 낱말 제거', () => {
  it.each([
    ['쏘나타 디 엣지 스마트스트림 가솔린 2.0 익스클루시브', '쏘나타 디 엣지 가솔린 2.0 익스클루시브'],
    ['아반떼 스마트 스트림 1.6 / 모던', '아반떼 1.6 / 모던'],
    ['투싼 1.6 T-GDi 2WD', '투싼 1.6 2WD'],
    ['쏘렌토 2.2 e-VGT 프레스티지', '쏘렌토 2.2 프레스티지'],
    ['K5 감마 1.6 터보', 'K5 1.6 터보'],
    ['스포티지 CRDi 2.0 노블레스', '스포티지 2.0 노블레스'],
  ])('%s → %s', (raw, expected) => expect(stripPowertrainWords(raw)).toBe(expected));
  it('영문 단어 안의 글자·차종 이름은 건드리지 않는다', () => {
    for (const raw of ['쏘나타 디 엣지 DN8', 'CHEVROLET 스파크', '벨로스터 N', '카니발 하이리무진', '그랜저 GN7']) expect(stripPowertrainWords(raw)).toBe(raw);
  });
  it('원문 «스마트스트림» 이 마스터 «스트림» 에 연결되지 않고, 쏘나타 디 엣지 별칭이 있으면 그 행으로 간다', () => {
    const r = matchIdentity(product('쏘나타 디 엣지 스마트스트림 가솔린 2.0 익스클루시브'), masters);
    expect(r.state).toBe('MATCH');
    if (r.state === 'MATCH') { expect(r.master.id).toBe('dn8'); expect(r.trim).toEqual({ state: 'UNIQUE', name: '익스클루시브' }); }
    const noAlias = matchIdentity(product('쏘나타 디 엣지 스마트스트림 가솔린 2.0 익스클루시브'), [masters[0]!, { ...masters[1]!, sub_model_aliases: [] }]);
    expect(noAlias.state).toBe('HOLD');   // 스트림 행으로 잘못 가지 않고 보류
  });
});

describe('파워트레인 낱말 제거 — Codex 반례', () => {
  it('표기 변형(공백·비ASCII 하이픈)도 뗀다', () => {
    expect(stripPowertrainWords('투싼 1.6 T GDi')).toBe('투싼 1.6');
    expect(stripPowertrainWords('투싼 1.6 T\u2011GDi 2WD')).toBe('투싼 1.6 2WD');
    expect(stripPowertrainWords('쏘렌토 2.2 e VGT')).toBe('쏘렌토 2.2');
  });
  it('한글 낱말은 다른 한글 글자에 붙어 있으면(에스카파드 등) 건드리지 않고, 트림에 쓰이는 TCe·dCi·GDi 는 남긴다', () => {
    expect(stripPowertrainWords('에스카파드 TCe 260 GDi 프리미엄 dCi RE')).toBe('에스카파드 TCe 260 GDi 프리미엄 dCi RE');
    expect(stripPowertrainWords('쎄타 2.4 카파 1.0')).toBe('2.4 1.0');
  });
});
