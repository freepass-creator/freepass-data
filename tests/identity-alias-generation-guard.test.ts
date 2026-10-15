import { describe, expect, it } from 'vitest';
import { matchIdentity, type IdentityMaster, type IdentityProduct } from '../src/application/identity-promotion-plan.js';

// 2026-10-16 plan4 Codex 의심: 원문 «더 뉴팰리세이드» 연식 2022 상품 8건이 세부모델 칸(원문 복사값 «팰리세이드», 별칭)으로 일반 «팰리세이드 LX2» 에 매칭.
// 세부모델 칸이 채워졌다는 이유로 세대 근거 점검(R1·R2)이 건너뛰어지던 우회를 막는다. 값은 합성.
const lx2: IdentityMaster = { id: 'A', maker: '현대', model: '팰리세이드', sub_model: '팰리세이드 LX2', model_aliases: [], sub_model_aliases: ['팰리세이드'],
  yearFrom: 2018, yearTo: 2022, trims: [{ name: '익스클루시브', aliases: [] }, { name: '캘리그래피', aliases: [] }] };
const newLx2: IdentityMaster = { id: 'B', maker: '현대', model: '팰리세이드', sub_model: '더 뉴 팰리세이드 LX2', model_aliases: [], sub_model_aliases: ['더 뉴 팰리세이드'],
  yearFrom: 2022, yearTo: 2025, trims: [{ name: '익스클루시브', aliases: [] }, { name: '캘리그래피', aliases: [] }] };
const masters = [lx2, newLx2];
const product = (extra: Partial<IdentityProduct>): IdentityProduct => ({ id: 'x', plate4: '2366', maker: '현대', model: '팰리세이드', sub_model: '팰리세이드',
  trim_name: '익스클루시브', rawName: '현대_더 뉴팰리세이드_3.8 가솔린 2WD_익스클루시브', year: '2022', listable: false, ...extra });

describe('별칭으로 고른 마스터도 세대 근거 점검을 받는다', () => {
  it('원문 «더 뉴»가 있는데 세부모델 칸이 별칭 «팰리세이드» 이면 일반 세대로 확정하지 않는다', () => {
    const m = matchIdentity(product({}), masters);
    expect(m).toMatchObject({ state: 'HOLD', reason: 'GENERATION_QUALIFIER_MISMATCH' });
  });

  it('원문에 수식어가 없고 연식이 일반 세대 범위에만 있으면 그대로 확정된다(과차단 없음)', () => {
    const m = matchIdentity(product({ rawName: '현대_팰리세이드_3.8 가솔린 2WD_익스클루시브', year: '2020' }), masters);
    expect(m).toMatchObject({ state: 'MATCH', master: { id: 'A' } });
  });

  it('세부모델 칸이 마스터 이름과 정확히 같으면(별칭 아님) 기존처럼 점검 대상이 아니다', () => {
    const m = matchIdentity(product({ sub_model: '팰리세이드 LX2', rawName: '현대_더 뉴팰리세이드_3.8' }), masters);
    expect(m.state).toBe('MATCH');
  });

  it('원문 차명이 없거나 공백이면 별칭 일치를 확정하지 않고 보류한다(Codex #679)', () => {
    for (const rawName of ['', '   ']) {
      expect(matchIdentity(product({ rawName }), masters)).toMatchObject({ state: 'HOLD', reason: 'GENERATION_EVIDENCE_MISSING' });
    }
    const missing = { ...product({}) } as Record<string, unknown>;
    delete missing.rawName;
    expect(matchIdentity(missing as unknown as IdentityProduct, masters)).toMatchObject({ state: 'HOLD', reason: 'GENERATION_EVIDENCE_MISSING' });
  });

  it('원문이 없어도 세부모델 칸이 마스터 이름과 정확히 같으면 기존처럼 확정된다', () => {
    expect(matchIdentity(product({ sub_model: '팰리세이드 LX2', rawName: '' }), masters)).toMatchObject({ state: 'MATCH', master: { id: 'A' } });
  });
});
