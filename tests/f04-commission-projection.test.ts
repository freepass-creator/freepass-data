import { describe, expect, it } from 'vitest';
import { planF04CommissionProjection, protectedSides } from '../src/application/f04-commission-projection.js';

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
  it('VAT-included rules (스타·스카이) fill only when ÷1.1 is a whole won; otherwise blank, and a sheet value is compared as a rough diff', () => {
    const p = plan([row({ 차량번호: '1', 공급사: '스타스카이', 렌탈료: 1100000 }), row({ 차량번호: '2', 공급사: '스타스카이', 렌탈료: 700000, 판매수수료: 1092000 })]);
    expect(p.fills.filter(f => f.row === 3).map(f => [f.column, f.value])).toEqual([['AE', 1000000], ['AJ', 800000]]);
    expect(p.blanks.filter(b => b.row === 4).map(b => [b.column, b.reason])).toEqual([['AJ', 'WON_ROUNDING_UNDECIDED']]);
    expect(p.diffs).toEqual([{ row: 4, column: 'AE', against: 'AE', plate: '2', sheet: 1092000, computed: 636364, difference: 455636, ruleId: 'STAR_RERENT_ONE_MONTH_RENT_BILLING', note: 'WON_ROUNDING_UNDECIDED' }]);
  });
  it('unknown supplier names, 지원금 rows and duplicate keys are never guessed', () => {
    const dup = row({ 차량번호: '9' });
    const p = plan([row({ 차량번호: '1', 공급사: 'AMR' }), row({ 차량번호: '2', 상품구분: '지원금' }), dup, [...dup]]);
    expect(p.fills).toEqual([]);
    expect(p.blanks.map(b => `${b.row}${b.column}:${b.reason}`)).toEqual(['3AE:SUPPLIER_CODE_UNRESOLVED', '3AJ:SUPPLIER_CODE_UNRESOLVED', '4AE:NOT_A_COMMISSION_ROW', '4AJ:NOT_A_COMMISSION_ROW']);
    expect(p.skipped.DUPLICATE_KEY).toBe(2);
  });
  it('stops when the layout moved or the month is malformed', () => {
    const moved = [...H]; moved.splice(30, 0, 'x');
    expect(() => planF04CommissionProjection({ intake: [['설명'], moved], installments: INST, openFromMonth: '2026-09', readAt: 'x' })).toThrow('F04_FEE_COLUMN_MOVED');
    expect(() => plan([]).fills).not.toThrow();
    expect(() => planF04CommissionProjection({ intake: intake(), installments: INST, openFromMonth: '2026-9', readAt: 'x' })).toThrow('F04_OPEN_MONTH_INVALID');
  });
});
