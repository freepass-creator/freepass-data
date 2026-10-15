import { describe, expect, it } from 'vitest';
import { fuelVariantWord, matchIdentity, type IdentityMaster, type IdentityProduct } from '../src/application/identity-promotion-plan.js';

// plan6 후속(2026-10-16): 아르카나·XM3·그랑 콜레오스처럼 원문이 파워트레인을 안 적거나 E-TECH 만 적은 상품의 변형(하이브리드) 근거 — 원문 낱말·E-TECH·문서 연료 칸. 값은 합성.
const gas: IdentityMaster = { id: 'G', maker: '르노', model: '아르카나', sub_model: '아르카나 LJL', model_aliases: [], sub_model_aliases: [], yearFrom: 2023, yearTo: null, trims: [{ name: '이스타일', aliases: [] }] };
const hybrid: IdentityMaster = { id: 'H', maker: '르노', model: '아르카나', sub_model: '아르카나 하이브리드 LJL', model_aliases: [], sub_model_aliases: [], yearFrom: 2023, yearTo: null, trims: [{ name: '이스타일', aliases: [] }] };
const product = (extra: Partial<IdentityProduct>): IdentityProduct => ({ id: 'x', plate4: '3631', maker: '', model: '', sub_model: '르노코리아 아르카나 LJL 이스타일', trim_name: '',
  rawName: '르노코리아 아르카나 LJL 이스타일', year: '2024', listable: true, engineTemp: true, ...extra });

describe('연료 칸 변형 낱말', () => {
  it('하이브리드·플러그인·전기만 변형, 가솔린·디젤·LPG·빈 값은 변형이 아니다', () => {
    expect(fuelVariantWord('하이브리드')).toBe('하이브리드');
    expect(fuelVariantWord('가솔린+전기')).toBe('하이브리드');
    expect(fuelVariantWord('플러그인 하이브리드')).toBe('플러그인 하이브리드');
    expect(fuelVariantWord('전기')).toBe('EV');
    for (const f of ['가솔린', '디젤', 'LPG', '', '  ']) expect(fuelVariantWord(f)).toBe('');
  });
});

describe('변형 근거: 원문 낱말 + E-TECH(르노 계열) + 연료 칸', () => {
  it('연료 칸이 하이브리드인데 일반 행에만 걸리면 보류(원문이 침묵해도)', () => {
    expect(matchIdentity(product({ fuel: '하이브리드' }), [gas])).toMatchObject({ state: 'HOLD', reason: 'VARIANT_MISMATCH' });
  });
  it('연료 칸이 가솔린이거나 없으면 기존처럼 일반 행으로 확정', () => {
    expect(matchIdentity(product({ fuel: '가솔린' }), [gas])).toMatchObject({ state: 'MATCH', master: { id: 'G' } });
    expect(matchIdentity(product({}), [gas])).toMatchObject({ state: 'MATCH', master: { id: 'G' } });
  });
  it('원문의 E-TECH 는 르노 계열에서 하이브리드 근거 — 하이브리드 행이 있으면 그 행으로, 일반 행만 있으면 보류', () => {
    const raw = { sub_model: '르노코리아 아르카나 LJL 1.6 E-TECH 이스타일', rawName: '르노코리아 아르카나 LJL 1.6 E-TECH 이스타일' };
    expect(matchIdentity(product(raw), [gas])).toMatchObject({ state: 'HOLD', reason: 'VARIANT_MISMATCH' });
    // 하이브리드 행이 있어도 원문이 «하이브리드 LJL» 이름 전체를 담지 않으면 마스터 이름 대조가 못 하므로 일반 행에 걸려 보류(변형 누락 방지)
    expect(matchIdentity(product(raw), [gas, hybrid]).state).toBe('HOLD');
  });
  it('Codex #682: Plug-in Hybrid·BEV·전기차 는 변형으로 읽고, 마스터가 E-TECH 이름만 가져도 하이브리드로 본다', () => {
    expect(fuelVariantWord('Plug-in Hybrid')).toBe('플러그인 하이브리드');
    expect(fuelVariantWord('BEV')).toBe('EV');
    expect(fuelVariantWord('전기차')).toBe('EV');
    const phev: IdentityMaster = { ...gas, id: 'P', sub_model: '아르카나 플러그인 하이브리드 LJL' };
    const rawPlug = '르노코리아 아르카나 LJL Plug-in Hybrid 이스타일';
    expect(matchIdentity(product({ sub_model: rawPlug, rawName: rawPlug }), [gas]).state).toBe('HOLD');   // 일반 행엔 못 걸림(일반 HYBRID 로 오분류하지 않음)
    const etechMaster: IdentityMaster = { ...gas, id: 'E', sub_model: '아르카나 E-TECH LJL', sub_model_aliases: [] };
    const etechRaw = '르노코리아 아르카나 E-TECH LJL 이스타일';
    expect(matchIdentity(product({ sub_model: etechRaw, rawName: etechRaw }), [etechMaster])).toMatchObject({ state: 'MATCH', master: { id: 'E' } });
    expect(matchIdentity(product({ fuel: 'BEV' }), [{ ...gas, id: 'G2' }, { ...gas, id: 'EV1', sub_model: '아르카나 EV LJL' }]).state).toBe('HOLD');
    void phev;
  });
  it('E-TECH 는 단어 경계로만 — RETECH·E-TECHNOLOGY 는 변형 근거가 아니다(Codex #682)', () => {
    for (const text of ['르노코리아 아르카나 LJL RETECH 이스타일', '르노코리아 아르카나 LJL E-TECHNOLOGY 이스타일']) {
      expect(matchIdentity(product({ sub_model: text, rawName: text }), [gas])).toMatchObject({ state: 'MATCH', master: { id: 'G' } });
    }
    expect(matchIdentity(product({ sub_model: '르노코리아 아르카나 LJL (E-TECH) 이스타일', rawName: '르노코리아 아르카나 LJL (E-TECH) 이스타일' }), [gas]))
      .toMatchObject({ state: 'HOLD', reason: 'VARIANT_MISMATCH' });
    expect(matchIdentity(product({ sub_model: '르노코리아 아르카나 LJL E TECH 이스타일', rawName: '르노코리아 아르카나 LJL E TECH 이스타일' }), [gas]))
      .toMatchObject({ state: 'HOLD', reason: 'VARIANT_MISMATCH' });
  });
  it('E-TECH 는 르노 계열에만 적용(다른 제조사 이름 속 낱말로는 변형 아님)', () => {
    const other: IdentityMaster = { ...gas, id: 'X', maker: '현대', model: '쏘나타', sub_model: '쏘나타 DN8' };
    const p = product({ sub_model: '현대 쏘나타 DN8 E-TECH', rawName: '현대 쏘나타 DN8 E-TECH' });
    expect(matchIdentity(p, [other])).toMatchObject({ state: 'MATCH', master: { id: 'X' } });
  });
});
