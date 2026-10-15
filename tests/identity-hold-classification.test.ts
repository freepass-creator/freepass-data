import { describe, expect, it } from 'vitest';
import { classifyIdentityHolds } from '../src/application/identity-hold-classification.js';
import type { IdentityMaster, IdentityProduct } from '../src/application/identity-promotion-plan.js';

// 값은 합성. 계획서가 NO_MASTER_MATCH 로 보류한 문서를 «마스터에 있는데 못 잡은 것» 과 «정말 없는 것» 으로 나눈다.
const master = (over: Partial<IdentityMaster> & Pick<IdentityMaster, 'id' | 'maker' | 'model' | 'sub_model'>): IdentityMaster => ({ model_aliases: [], sub_model_aliases: [], yearFrom: null, yearTo: null, trims: [], ...over });
const product = (id: string, rawName: string, year = '2023'): IdentityProduct => ({ id, plate4: id.slice(-4).padStart(4, '0'), maker: '', model: '', sub_model: rawName, trim_name: '', rawName, year, listable: true });
const masters: IdentityMaster[] = [
  master({ id: 'sp-nq5', maker: '기아', model: '스포티지', sub_model: '스포티지 NQ5', yearFrom: 2021, yearTo: null }),
  master({ id: 'sp-ql', maker: '기아', model: '스포티지', sub_model: '스포티지 QL', yearFrom: 2015, yearTo: 2020 }),
  master({ id: 'so-mq4', maker: '기아', model: '쏘렌토', sub_model: '쏘렌토 MQ4', yearFrom: 2020, yearTo: null }),
  master({ id: 'ca-ka4', maker: '기아', model: '카니발', sub_model: '카니발 KA4', yearFrom: 2020, yearTo: null }),
  master({ id: 'gr-gn7', maker: '현대', model: '그랜저', sub_model: '디 올뉴그랜저 GN7', yearFrom: 2022, yearTo: null }),
];

describe('정체성 보류 재분류(읽기 전용)', () => {
  it('개발코드·접두·세대 순번·연식으로 마스터에 있는 것을 «매칭 실패(유일)»로 분류한다', () => {
    const r = classifyIdentityHolds([
      product('p0001', '신형 쏘렌토 2.2 디젤'),
      product('p0002', '더 뉴카니발 하이브리드'),
      product('p0003', '기아_스포티지 5세대_1.6 터보', '2023'),
    ], masters);
    const byId = Object.fromEntries(r.held.map(h => [h.id, h]));
    expect(byId.p0001).toMatchObject({ cls: 'MATCH_FAILURE_UNIQUE' });
    expect(byId.p0002).toMatchObject({ cls: 'MATCH_FAILURE_UNIQUE' });
    expect(byId.p0003!.cls).toBe('MATCH_FAILURE_UNIQUE');   // 핵심어 «스포티지» + 연식 2023 → NQ5
    expect(byId.p0003!.candidates).toEqual(['스포티지 NQ5']);
    expect(r.byClass.MATCH_FAILURE_UNIQUE).toBe(3);
  });

  it('마스터에 모델 행조차 없으면 MASTER_MISSING, 모델만 있고 세대를 못 정하면 MODEL_ONLY/AMBIGUOUS', () => {
    const r = classifyIdentityHolds([
      product('q0001', '기아 타스만 2.5T'),
      product('q0002', '기아 스포티지 1.6', ''),      // 연식 없음 → 세대 후보 여럿
    ], masters);
    const byId = Object.fromEntries(r.held.map(h => [h.id, h]));
    expect(byId.q0001!.cls).toBe('MASTER_MISSING');
    expect(byId.q0002!.cls).toBe('MATCH_FAILURE_AMBIGUOUS');
  });

  it('연식 구분과 실패 유형(패턴)별 집계를 낸다 — 이름은 만들지 않고 번호는 끝 4자리', () => {
    const r = classifyIdentityHolds([product('r0001', '신형 쏘렌토 (2.2 디젤)', '2022'), product('r0002', '더뉴카니발', '2015')], masters);
    expect(r.byClassYear['MATCH_FAILURE_UNIQUE|RECENT_2019_PLUS']).toBe(1);
    expect(r.byClassYear['MATCH_FAILURE_UNIQUE|OLDER']).toBe(1);
    const patterns = Object.fromEntries(r.patterns.map(p => [p.pattern, p]));
    expect(patterns['괄호·코드']!.count).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r)).not.toMatch(/\d{2,3}[가-힣]\d{4}/);
  });
});
