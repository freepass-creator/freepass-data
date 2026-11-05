import { describe, expect, it } from 'vitest';
import { planF03Projection } from '../src/application/f03-sheet-projection.js';

const sheetHeader = ['원산지', '제조사', '모델', '세부모델', '세부트림'];
const sheetLine = (maker: string, model: string, sub: string, trim: string) => ['국산', maker, model, sub, trim, '2020-01', '현재'];

describe('F03 투영 계획', () => {
  it('시트에 없는 정본 줄만 덧붙이고 있는 줄은 건드리지 않는다', () => {
    const plan = planF03Projection({
      trimRows: [
        { maker: '현대', model: '캐스퍼', sub_model: '더 뉴 캐스퍼', trim: '스마트', origin: '국산', production_start: '2024-10', production_end: '현재', trim_row_key: 'k1' },
        { maker: '현대', model: '캐스퍼', sub_model: '더 뉴 캐스퍼', trim: '인스퍼레이션', origin: '국산', trim_row_key: 'k2' },
      ],
      masterRows: [],
      sheetRows: [sheetLine('현대', '캐스퍼', '더 뉴 캐스퍼', '스마트')],
    }, { onlyNewModels: false });
    expect(plan.alreadyInSheet).toBe(1);
    expect(plan.append.map((r) => r.values[4])).toEqual(['인스퍼레이션']);
    expect(plan.append[0].values).toHaveLength(16);
    expect(plan.append[0].values[15]).toBe('k2');
    expect(plan.append[0].values.slice(7, 13)).toEqual(['', '', '', '', '', '']); // 검토 칸은 비워 둔다
  });

  it('차종 마스터에만 있는 새 차(아우디 Q2)는 세부트림을 펼쳐 넣고, 트림이 없으면 기본형', () => {
    const plan = planF03Projection({
      trimRows: [],
      masterRows: [
        { id: 'mf-011.md-036.sm-q2', maker: '아우디', model: 'Q2', sub_model: 'Q2', origin: '수입', year_start: '2017', year_end: '현재', trims: ['35 TDI', '35 TDI 프리미엄'], market_class: '신차' },
        { id: 'x', maker: '아우디', model: 'Q3', sub_model: '', trims: [] },
      ],
      sheetRows: [],
    });
    expect(plan.append.map((r) => r.values.slice(1, 5).join('/'))).toEqual(['아우디/Q2/Q2/35 TDI', '아우디/Q2/Q2/35 TDI 프리미엄', '아우디/Q3/Q3/기본형']);
    expect(plan.append[0].values[15]).toBe('mf-011.md-036.sm-q2::1');
    expect(plan.marketClassCounts['신차']).toBe(2);
  });

  it('트림 마스터가 이미 가진 줄은 차종 마스터에서 다시 만들지 않고, 대소문자·공백이 달라도 같은 줄로 본다', () => {
    const plan = planF03Projection({
      trimRows: [{ maker: '아우디', model: 'Q2', sub_model: 'Q2', trim: '35  TDI', trim_row_key: 't' }],
      masterRows: [{ id: 'm', maker: '아우디', model: 'Q2', sub_model: 'Q2', trims: ['35 tdi'] }],
      sheetRows: [],
    });
    expect(plan.append).toHaveLength(1);
    expect(plan.append[0].source).toBe('trim_master');
  });

  it('시트에만 있는 줄은 지우지 않고 보고만 한다', () => {
    const plan = planF03Projection({ trimRows: [], masterRows: [], sheetRows: [sheetLine('현대', '옛차', '옛차', '기본형')] });
    expect(plan.append).toHaveLength(0);
    expect(plan.sheetOnly).toHaveLength(1);
    void sheetHeader;
  });
});

describe('F03 투영 범위', () => {
  const trimRows = [
    { maker: '아우디', model: 'A6', sub_model: 'A6 C8', trim: '45 TFSI', trim_row_key: 'a' },
    { maker: '아우디', model: 'Q2', sub_model: 'Q2', trim: '35 TDI', trim_row_key: 'b' },
    { maker: '현대', model: '포니', sub_model: '포니', trim: '기본형', trim_row_key: 'c' },
  ];
  const sheetRows = [['수입', '아우디', 'A6', '뉴 A6', '40 TFSI']];
  it('기본은 시트에 모델이 없는 새 차만 — 모델이 있는 이름 차이는 보고만', () => {
    const plan = planF03Projection({ trimRows, masterRows: [], sheetRows });
    expect(plan.append.map((r) => r.values[2])).toEqual(['Q2', '포니']);
    expect(plan.nameDiffers).toBe(1);
  });
  it('제조사로 좁힌다', () => {
    const plan = planF03Projection({ trimRows, masterRows: [], sheetRows }, { makers: ['아우디'] });
    expect(plan.append.map((r) => r.values[2])).toEqual(['Q2']);
  });
});
