import { describe, expect, it } from 'vitest';
import { isoDate, planF04CommissionProjection, protectedSides } from '../src/application/f04-commission-projection.js';

// 시험 자료는 모두 합성값이다 — 차량번호(12가3456 등)·금액·날짜는 실제 계약이 아니다.
// F04 접수 탭 머리글(실제 순서 A~AZ). 1행은 탭 설명, 2행이 머리글.
const H = ['접수일', '차량번호', '공급사', '모델명', '영업채널', '영업담당자', '영업자연락처', '고객명', '특이사항', '상품구분', '계약기간', '렌탈료',
  '보증금', '차량가액', '분납여부', '계약서', '인도완료', '인도일', '청구년', '청구월', '청구액', '지급액', '취소', '다음회차일', '환수', '환수사유',
  '환수일', '환수금액', '렌트구분', '공급사수수료율', '판매수수료', '공급사인센티브', '공급사부가세', '청구금액', '에이전시수수료율', '출고수수료',
  '에이전시인센티브', '계약서대행료', '에이전시부가세', '지급합계(부가세포함)', '계약번호', '계약형태', '연령', '계약대여료', '업셀링금액', '출고지역',
  '계약서작성담당', '비고', '원본탭', '영업자코드', '납입회차', '청구'];
const at = (h: string) => H.indexOf(h);
const row = (over: Record<string, unknown>) => {
  const r: unknown[] = H.map(() => '');
  Object.assign(r, Object.fromEntries(Object.entries({ 접수일: '2026-09-20', 공급사: '웰릭스', 상품구분: '장기렌트', 계약기간: 48, 렌탈료: 820000,
    분납여부: '일시납', 청구년: 2026, 청구월: 10, 취소: false, 청구: false, ...over }).map(([k, v]) => [at(k), v])));
  return r;
};
const intake = (...rows: unknown[][]) => [['접수 누적원장 — 설명'], H, ...rows];
const INST: unknown[][] = [['회차청구 — 설명'], ['차량번호', '원 접수행', '접수일', '회차', '청구년', '청구월', '금액(공급가)', '근거', '청구']];
const plan = (rows: unknown[][], installments: unknown[][] = INST, facts = {}) =>
  planF04CommissionProjection({ intake: intake(...rows), installments, openFromMonth: '2026-09', readAt: '2026-10-05T00:00:00.000Z', facts });

describe('F04 접수 탭 AE·AJ 투영 계획', () => {
  it('fills only empty AE·AJ with the engine amount (supply, VAT excluded) and counts same values', () => {
    const p = plan([row({ 차량번호: '12가3456' }), row({ 차량번호: '12가3457', 판매수수료: 1279200, 출고수수료: 984000 })]);
    expect(p.fills).toEqual([
      { row: 3, column: 'AE', plate: '12가3456', value: 1279200, ruleId: 'STANDARD_RERENT_48_BILLING_RENT_X_TERM' },
      { row: 3, column: 'AJ', plate: '12가3456', value: 984000, ruleId: 'STANDARD_RERENT_48_RENT_X_TERM' },
    ]);
    expect(p.same).toBe(2);
  });
  it('never writes 0 for an unknown fee: blank with the engine reason (e.g. fuel missing for 오토플러스 구독)', () => {
    const p = plan([row({ 차량번호: '12가3456', 공급사: '오토플러스', 상품구분: '오플구독', 계약기간: 24 })]);
    expect(p.fills).toEqual([]);
    expect(p.blanks.map(b => b.reason)).toEqual(['FUEL_REQUIRED_FOR_SUPPLIER_RULE', 'FUEL_REQUIRED_FOR_SUPPLIER_RULE']);
    const withFuel = plan([row({ 차량번호: '12가3456', 공급사: '오토플러스', 상품구분: '오플구독', 계약기간: 24 })], INST, { '12가3456': { fuel: '가솔린' } });
    expect(withFuel.fills.map(f => [f.column, f.value])).toEqual([['AE', 1000000], ['AJ', 800000]]);
  });
  it('does not overwrite: a different sheet value or a different U·V goes to the diff list', () => {
    const p = plan([row({ 차량번호: '12가3456', 판매수수료: 1300000 }), row({ 차량번호: '12가3457', 지급액: 1416000 })]);
    expect(p.diffs).toEqual([
      { row: 3, column: 'AE', against: 'AE', plate: '12가3456', sheet: 1300000, computed: 1279200, difference: 20800, ruleId: 'STANDARD_RERENT_48_BILLING_RENT_X_TERM' },
      { row: 4, column: 'AJ', against: 'V', plate: '12가3457', sheet: 1416000, computed: 984000, difference: 432000, ruleId: 'STANDARD_RERENT_48_RENT_X_TERM' },
    ]);
    expect(p.fills.map(f => `${f.column}${f.row}`)).toEqual(['AJ3', 'AE4']);
  });
  it('leaves cancelled, billed and closed-month rows alone; closed-row differences are listed for people only', () => {
    const p = plan([row({ 차량번호: '1', 취소: true }), row({ 차량번호: '2', 청구: true }), row({ 차량번호: '3', 청구월: 8, 판매수수료: 1 })]);
    expect(p.fills).toEqual([]);
    expect(p.skipped).toEqual({ CANCELLED: 1, ALREADY_BILLED: 1, BILLING_MONTH_CLOSED: 1 });
    expect(p.closedDiffs.map(d => [d.row, d.column, d.computed])).toEqual([[5, 'AE', 1279200]]);
  });
  it('a contract with its next round in 회차청구 keeps AE untouched (no double billing); AJ is still filled', () => {
    const inst = [...INST, ['12가3456', 3, '2026-09-20', 2, 2026, 10, 639600, '근거', false]];
    const p = plan([row({ 차량번호: '12가3456', 분납여부: '2회분납' })], inst);
    expect(p.blanks).toEqual([{ row: 3, column: 'AE', plate: '12가3456', reason: 'INSTALLMENT_TAB_HAS_CONTRACT' }]);
    expect(p.fills.map(f => f.column)).toEqual(['AJ']);
  });
  it('a remark agreement protects only its side: 하허호 F80 correction protects AJ, not AE', () => {
    expect([...protectedSides('하허호 F80 2026-09 정정 반영(2026-10-02)')]).toEqual(['AJ']);
    expect([...protectedSides('공급사 정산서 확정')]).toEqual(['AE']);
    expect([...protectedSides('합의')]).toEqual(['AE', 'AJ']);
    expect([...protectedSides('일반 메모')]).toEqual([]);
    const p = plan([row({ 차량번호: '12가3456', 비고: '하허호 F80 정정 반영' })]);
    expect(p.fills.map(f => f.column)).toEqual(['AE']);
    expect(p.blanks).toEqual([{ row: 3, column: 'AJ', plate: '12가3456', reason: 'REMARK_AGREEMENT_NEEDS_PERSON' }]);
  });
  it('VAT-included rules (스타·스카이) use the engine supply amount: ÷1.1, rounded to the won (상황실 2026-10-05)', () => {
    const p = plan([row({ 차량번호: '1', 공급사: '스타스카이', 렌탈료: 1100000 }), row({ 차량번호: '2', 공급사: '스타스카이', 렌탈료: 700000, 판매수수료: 1092000 })]);
    expect(p.fills.map(f => [f.row, f.column, f.value])).toEqual([[3, 'AE', 1000000], [3, 'AJ', 800000], [4, 'AJ', 509091]]);
    expect(p.diffs).toEqual([{ row: 4, column: 'AE', against: 'AE', plate: '2', sheet: 1092000, computed: 636364, difference: 455636, ruleId: 'STAR_RERENT_ONE_MONTH_RENT_BILLING' }]);
  });
  it('unknown supplier names, 지원금 rows and duplicate keys are never guessed', () => {
    const dup = row({ 차량번호: '9' });
    const p = plan([row({ 차량번호: '1', 공급사: 'AMR' }), row({ 차량번호: '2', 상품구분: '지원금' }), dup, [...dup]]);
    expect(p.fills).toEqual([]);
    expect(p.blanks.map(b => `${b.row}${b.column}:${b.reason}`)).toEqual(['3AE:SUPPLIER_CODE_UNRESOLVED', '3AJ:SUPPLIER_CODE_UNRESOLVED', '4AE:NOT_A_COMMISSION_ROW', '4AJ:NOT_A_COMMISSION_ROW']);
    expect(p.skipped.DUPLICATE_KEY).toBe(2);
  });
  it('an empty or text rent is unknown, never 0 — no 0-won fill', () => {
    const p = plan([row({ 차량번호: '1', 렌탈료: '' }), row({ 차량번호: '2', 렌탈료: '협의' })]);
    expect(p.fills).toEqual([]);
    expect(new Set(p.blanks.map(b => b.reason))).toEqual(new Set(['INVALID_PRICE_TERM_INPUT']));
  });
  it('billing year/month: both blank = open, one missing or unreadable («8월») = not touched', () => {
    const p = plan([row({ 차량번호: '1', 청구년: '', 청구월: '' }), row({ 차량번호: '2', 청구월: '8월' }), row({ 차량번호: '3', 청구년: '' })]);
    expect(p.fills.map(f => f.row)).toEqual([3, 3]);
    expect(p.skipped).toEqual({ BILLING_MONTH_UNREADABLE: 2 });
  });
  it('individual agreements (비고 «개별» or the private key list) never get the general amount', () => {
    const p = plan([row({ 차량번호: 'y', 비고: '개별 합의 40만' })]);
    expect(p.fills).toEqual([]);
    expect(p.blanks.map(b => `${b.row}${b.column}:${b.reason}`)).toEqual(['3AE:INDIVIDUAL_AGREEMENT', '3AJ:INDIVIDUAL_AGREEMENT']);
  });
  it('any other cell changed between the two reads (청구·취소·청구월·지급액·비고·렌탈료) stops the whole plan; formula cells and dates are compared sensibly', () => {
    const base = row({ 차량번호: '12가3456' });
    for (const [h, v] of [['청구', true], ['취소', true], ['청구월', 8], ['지급액', 1416000], ['비고', '개별 합의'], ['렌탈료', 900000], ['렌탈료', 820000.5]] as const) {
      const changed = [...base]; changed[at(h)] = v;
      expect(() => planF04CommissionProjection({ intake: intake(base), intakeFormulas: intake(changed), installments: INST, openFromMonth: '2026-09', readAt: 'x' }), h).toThrow('F04_FORMULA_READ_MISMATCH');
    }
    // 공급사 칸이 수식이면 건너뛰고, 접수일은 글자 날짜 ↔ 일련번호를 같은 날로 본다.
    const asFormula = [...base]; asFormula[at('공급사')] = '=VLOOKUP(B3,차량대장!A:E,5,FALSE)'; asFormula[at('접수일')] = 46285;
    expect(() => planF04CommissionProjection({ intake: intake(base), intakeFormulas: intake(asFormula), installments: INST, openFromMonth: '2026-09', readAt: 'x' })).not.toThrow();
    // 배열 수식 파생 칸: 수식은 맨 위 한 칸에만 보이고 아래 칸은 수식 읽기에서 비어 있다 — 그 열은 통째로 뺀다.
    const v1 = [...base], v2 = row({ 차량번호: '12가3457' }); v1[at('비고')] = ''; v2[at('비고')] = '';
    const values = intake(v1, v2), formulasRead = intake([...v1], [...v2]);
    (values[2] as unknown[])[at('계약형태')] = '파생값'; (values[3] as unknown[])[at('계약형태')] = '파생값';
    (formulasRead[2] as unknown[])[at('계약형태')] = '=ARRAYFORMULA(…)'; (formulasRead[3] as unknown[])[at('계약형태')] = '';
    expect(() => planF04CommissionProjection({ intake: values, intakeFormulas: formulasRead, installments: INST, openFromMonth: '2026-09', readAt: 'x' })).not.toThrow();
  });
  it('a row whose calculation/decision input is a formula (청구·청구월·렌탈료·지급액·공급사 …) is never filled', () => {
    const v = row({ 차량번호: '12가3456' });
    for (const [h, f] of [['청구', '=TRUE'], ['청구월', '=8'], ['렌탈료', '=900000'], ['지급액', '=1'], ['공급사', '=IFERROR(VLOOKUP(B3,차량대장!A:E,5,FALSE),"")']] as const) {
      const fr = [...v]; fr[at(h)] = f;
      const p = planF04CommissionProjection({ intake: intake(v), intakeFormulas: intake(fr), installments: INST, openFromMonth: '2026-09', readAt: 'x' });
      expect(p.fills, h).toEqual([]);
      expect(p.blanks.map(b => b.reason), h).toEqual(['INPUT_FORMULA_UNVERIFIED', 'INPUT_FORMULA_UNVERIFIED']);
    }
  });
  it('an input column filled by an array formula (e.g. 청구 = ARRAYFORMULA) stops the whole plan', () => {
    const v1 = row({ 차량번호: '12가3456' }), v2 = row({ 차량번호: '12가3457' });
    const f1 = [...v1], f2 = [...v2]; f1[at('청구')] = '=ARRAYFORMULA(IF(A3:A="","",FALSE))'; f2[at('청구')] = '';
    expect(() => planF04CommissionProjection({ intake: intake(v1, v2), intakeFormulas: intake(f1, f2), installments: INST, openFromMonth: '2026-09', readAt: 'x' })).toThrow('F04_INPUT_COLUMN_IS_ARRAY_FORMULA');
  });
  it('a header or description row that differs in the second read (column renamed or moved) stops the plan', () => {
    const v = row({ 차량번호: '12가3456' });
    const renamed = [...H]; renamed[at('판매수수료')] = '판매수수료(공급가)';
    expect(() => planF04CommissionProjection({ intake: intake(v), intakeFormulas: [['접수 누적원장 — 설명'], renamed, [...v]], installments: INST, openFromMonth: '2026-09', readAt: 'x' })).toThrow('F04_FORMULA_READ_MISMATCH');
    const formulaHeader = [...H]; formulaHeader[at('판매수수료')] = '="다른 항목"';
    expect(() => planF04CommissionProjection({ intake: intake(v), intakeFormulas: [['접수 누적원장 — 설명'], formulaHeader, [...v]], installments: INST, openFromMonth: '2026-09', readAt: 'x' })).toThrow('F04_FORMULA_READ_MISMATCH');
    const moved = [...H]; [moved[30], moved[35]] = [moved[35]!, moved[30]!];
    expect(() => planF04CommissionProjection({ intake: intake(v), intakeFormulas: [['접수 누적원장 — 설명'], moved, [...v]], installments: INST, openFromMonth: '2026-09', readAt: 'x' })).toThrow('F04_FORMULA_READ_MISMATCH');
    expect(() => planF04CommissionProjection({ intake: intake(v), intakeFormulas: [['다른 설명'], [...H], [...v]], installments: INST, openFromMonth: '2026-09', readAt: 'x' })).toThrow('F04_FORMULA_READ_MISMATCH');
  });
  it('a plain formula in one cell of a column does not hide changes in the other cells of that column', () => {
    const v1 = row({ 차량번호: '12가3456' }), v2 = row({ 차량번호: '12가3457' });
    const f1 = [...v1], f2 = [...v2]; f1[at('청구')] = '=FALSE()'; f2[at('청구')] = true; // 4행 청구가 그 사이 TRUE 로
    expect(() => planF04CommissionProjection({ intake: intake(v1, v2), intakeFormulas: intake(f1, f2), installments: INST, openFromMonth: '2026-09', readAt: 'x' })).toThrow('F04_FORMULA_READ_MISMATCH');
  });
  it('a spilling formula at or left of AJ (it may cover AE·AJ) stops the plan; one to the right of AJ is fine', () => {
    const v1 = row({ 차량번호: '12가3456' }), v2 = row({ 차량번호: '12가3457' });
    for (const [h, f] of [['판매수수료', '={0,""}'], ['공급사수수료율', '=HSTACK(0,"","","","","","")'], ['렌탈료', '=TRANSPOSE(A3:A9)'], ['모델명', '=B3:B9'], ['공급사', '=IF(TRUE,C3:H3)'], ['공급사수수료율', '=IF(SUM(BG3:BG4)>0,BH3:BI3,SUM(BJ3:BJ4))'], ['렌탈료', '=IF(TRUE,FeeRange,0)'], ['렌탈료', '=7:8'], ['렌탈료', '=bg3:bh3'], ['렌탈료', '=INDIRECT("A3:B3")']] as const) {
      const f1 = [...v1]; f1[at(h)] = f;
      expect(() => planF04CommissionProjection({ intake: intake(v1, v2), intakeFormulas: intake(f1, [...v2]), installments: INST, openFromMonth: '2026-09', readAt: 'x' }), h).toThrow('F04_SPILL_FORMULA_MAY_COVER_FEE_COLUMNS');
    }
    // 한 칸만 돌려주는 조회 수식(지금 시트의 공급사·모델명 칸)은 그대로 통과, 머리글 위 줄의 흐르는 수식도 본다.
    const lookup = [...v1]; lookup[at('공급사')] = `=IF($B3="","",IFERROR(VLOOKUP($B3,'차량대장'!$A$3:$E,5,FALSE),""))`;
    expect(() => planF04CommissionProjection({ intake: intake(v1, v2), intakeFormulas: intake(lookup, [...v2]), installments: INST, openFromMonth: '2026-09', readAt: 'x' })).not.toThrow();
    const top = intake(v1, v2); (top[0] as unknown[])[at('렌탈료')] = '=HSTACK(1,2,3)';
    expect(() => planF04CommissionProjection({ intake: intake(v1, v2), intakeFormulas: top, installments: INST, openFromMonth: '2026-09', readAt: 'x' })).toThrow('F04_SPILL_FORMULA_MAY_COVER_FEE_COLUMNS');
    const right = [...v1]; right[at('계약형태')] = '=ARRAYFORMULA(A3:A)';
    expect(() => planF04CommissionProjection({ intake: intake(v1, v2), intakeFormulas: intake(right, [...v2]), installments: INST, openFromMonth: '2026-09', readAt: 'x' })).not.toThrow();
  });
  it('a number typed between the two reads (value read empty, second read has it) is compared, never filled', () => {
    const values = intake(row({ 차량번호: '12가3456' }));
    const p = planF04CommissionProjection({ intake: values, intakeFormulas: intake(row({ 차량번호: '12가3456', 판매수수료: 1300000, 출고수수료: 984000 })), installments: INST, openFromMonth: '2026-09', readAt: 'x' });
    expect(p.fills).toEqual([]);
    expect(p.diffs.map(d => [d.column, d.sheet, d.computed])).toEqual([['AE', 1300000, 1279200]]);
    expect(p.same).toBe(1);
  });
  it('a 회차청구 line for the same plate that does not point to this row (moved or unreadable) blocks AE as unclear', () => {
    const inst = [...INST, ['12가3456', 99, '2026-09-20', 2, 2026, 10, 1, '근거', false], ['12가3457', '', '2026-09-20', 2, 2026, 10, 1, '근거', false]];
    const p = plan([row({ 차량번호: '12가3456' }), row({ 차량번호: '12가3457' })], inst);
    expect(p.blanks.map(b => `${b.row}${b.column}:${b.reason}`)).toEqual(['3AE:INSTALLMENT_LINK_UNCLEAR', '4AE:INSTALLMENT_LINK_UNCLEAR']);
    expect(p.fills.map(f => `${f.row}${f.column}`)).toEqual(['3AJ', '4AJ']);
  });
  it('the private individual-agreement list protects the contract by key wherever its row moved', () => {
    const p = planF04CommissionProjection({ intake: intake(row({ 차량번호: '12가3456' })), installments: INST, openFromMonth: '2026-09', readAt: 'x', individualKeys: ['12가3456|2026-09-20'] });
    expect(p.fills).toEqual([]);
    expect(p.blanks.map(b => b.reason)).toEqual(['INDIVIDUAL_AGREEMENT', 'INDIVIDUAL_AGREEMENT']);
  });
  it('a formula cell (read with FORMULA) is never filled even when it shows an empty string', () => {
    const p = plan([row({ 차량번호: '12가3456', 판매수수료: '=IF(L3="","",L3*0)', 출고수수료: '=""' })]);
    expect(p.fills).toEqual([]);
    expect(p.skipped.FORMULA_CELL).toBe(2);
  });
  it('dates are compared as YYYY-MM-DD: a serial 접수일 still matches the individual list written as text (and vice versa)', () => {
    expect(isoDate(46285)).toBe('2026-09-20');
    expect(isoDate('2026. 9. 20')).toBe('2026-09-20');
    expect(isoDate('46285')).toBe('2026-09-20');
    const listSerial = planF04CommissionProjection({ intake: intake(row({ 차량번호: '12가3456' })), installments: INST, openFromMonth: '2026-09', readAt: 'x', individualKeys: ['12가3456|46285'] });
    expect(listSerial.fills).toEqual([]);
    const serial = planF04CommissionProjection({ intake: intake(row({ 차량번호: '12가3456', 접수일: 46285 })), installments: INST, openFromMonth: '2026-09', readAt: 'x', individualKeys: ['12가 3456|2026-09-20'] });
    expect(serial.blanks.map(b => b.reason)).toEqual(['INDIVIDUAL_AGREEMENT', 'INDIVIDUAL_AGREEMENT']);
    const textDate = planF04CommissionProjection({ intake: intake(row({ 차량번호: '12가3456', 접수일: '2026/9/20' })), installments: INST, openFromMonth: '2026-09', readAt: 'x', individualKeys: ['12가3456|2026-09-20'] });
    expect(textDate.fills).toEqual([]);
  });
  it('stops on a duplicated header name (e.g. two «청구» columns)', () => {
    const dup = [...H, '청구'];
    expect(() => planF04CommissionProjection({ intake: [['설명'], dup, [...row({ 차량번호: '1' }), '']], installments: INST, openFromMonth: '2026-09', readAt: 'x' })).toThrow('F04_INTAKE_HEADER_DUPLICATE');
  });
  it('stops when the layout moved or the month is malformed', () => {
    const moved = [...H]; moved.splice(30, 0, 'x');
    expect(() => planF04CommissionProjection({ intake: [['설명'], moved], installments: INST, openFromMonth: '2026-09', readAt: 'x' })).toThrow('F04_FEE_COLUMN_MOVED');
    expect(() => plan([]).fills).not.toThrow();
    expect(() => planF04CommissionProjection({ intake: intake(), installments: INST, openFromMonth: '2026-9', readAt: 'x' })).toThrow('F04_OPEN_MONTH_INVALID');
  });
});
