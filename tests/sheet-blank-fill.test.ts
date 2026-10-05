import { describe, expect, it } from 'vitest';
import { planSheetBlankFill, type SheetBlankFillInput } from '../src/application/sheet-blank-fill.js';

const headers = ['차량번호', '제조사', '모델', '세부모델', '세부트림', '연식', '배기량', '연료', '인승', '구동방식', '차종크기', '차종구분', '원산지',
  '기본연령', '면허기간', '연주행', '1만km+', '분납', '보험료', '심사', '보증금카드', '대인한도', '대인면책', '대물한도', '대물면책',
  '자차한도', '자차수리비', '자손한도', '자손면책', '무보험한도', '무보험면책', '추가운전인원', '추가운전요금', '정비', '긴급출동',
  '지역', '탁송비', '승계', '승계비', '최대연령', '개인운전자', '법인운전자', '21세+', '23세+', '자차면책'];
const fresh = () => new Date().toISOString();
const row = (rowNo: number, plate: string, overrides: Record<string, unknown> = {}, formulaCols: number[] = []) => {
  const values = headers.map(h => overrides[h] ?? '');
  values[0] = plate;
  return { row: rowNo, values: values as Array<string | number | null>, formulaCols };
};
const policy = (fields: Record<string, unknown> = {}, writerFields = Object.keys(fields)) => ({
  ...fields,
  field_evidence: Object.fromEntries(writerFields.map(f => [f, { writer: 'policy-corrector' }])),
});
const base = (rows = [row(2, '11가1111')]): SheetBlankFillInput => ({
  spreadsheetId: 'virtual-sheet-id',
  capturedAt: fresh(),
  tabs: { '가상공급사': { headers, rows } },
  vehicles: {
    '11가1111': { confirmed: true, evidence: 'virtual-canonical', fields: { maker: '현대', model: '아반떼', sub_model: 'CN7', trim_name: '모던', year: 2024, engine_cc: 1598, fuel_type: '가솔린', seats: 5, drivetrain: '2WD', size_class: '준중형', body_type: '세단', origin: '국산' } },
    '22나2222': { confirmed: false, evidence: 'virtual-canonical', fields: { maker: '기아' } },
    '33다3333': { confirmed: true, evidence: '', fields: { maker: '기아' } },
    '44라4444': { confirmed: true, evidence: 'virtual-canonical', needsConfirmation: ['제조사'], fields: { maker: '르노' } },
  },
  policyLinks: Object.fromEntries(rows.map(r => [`가상공급사:${r.row}`, { code: 'POL-1', plate: String(r.values[0]) }])),
  policies: { 'POL-1': policy({ basic_driver_age: '만 26세 이상', insurance_included: '보험료 포함', age_21_cost: '7만원', age_23_cost: '5만원', own_damage_min_deductible: '50만원', own_damage_max_deductible: '200만원' }) },
});

describe('공통 시트 빈 칸 채우기 계획기', () => {
  it('fills blanks only, keeps numbers as numbers, strips insurance prefix and composes own-damage deductible', () => {
    const { plan, report } = planSheetBlankFill(base());
    expect(plan.시트ID).toBe('virtual-sheet-id');
    expect(plan.바꿀칸).toContainEqual({ 범위: '가상공급사!B2', 전: '', 후: '현대' });
    expect(plan.바꿀칸).toContainEqual({ 범위: '가상공급사!F2', 전: '', 후: 2024 });
    expect(plan.바꿀칸.some(c => c.후 === '포함')).toBe(true);
    expect(plan.바꿀칸.some(c => c.후 === '50~200만원')).toBe(true);
    expect(report.counts.채울칸).toBe(plan.바꿀칸.length);
  });

  it('does not overwrite different values, ignores equivalent values, and normalizes impossible wording', () => {
    const input = base([row(2, '11가1111', { 제조사: '기아', 모델: '아반떼', 기본연령: '만26세이상', 보험료: '불가능' })]);
    input.policies['POL-1'] = policy({ ...input.policies['POL-1'], insurance_included: '불가' });
    const { plan, report } = planSheetBlankFill(input);
    expect(plan.바꿀칸.some(c => c.범위 === '가상공급사!C2' || c.범위 === '가상공급사!N2' || c.범위 === '가상공급사!O2')).toBe(false);
    expect(report.differences).toEqual([{ 탭: '가상공급사', 행: 2, 차량번호: '11가1111', 칸: '제조사', 시트값: '기아', 정본값: '현대', 층: '차량' }]);
  });

  it('skips formula cells and vehicle rows that are unconfirmed, lack evidence, or need confirmation', () => {
    const makerCol = headers.indexOf('제조사');
    const { plan, report } = planSheetBlankFill(base([row(2, '11가1111', {}, [makerCol]), row(3, '22나2222'), row(4, '33다3333'), row(5, '44라4444')]));
    expect(plan.바꿀칸.some(c => c.범위 === '가상공급사!B2')).toBe(false);
    expect(report.skippedCounts.FORMULA_CELL).toBe(1);
    expect(report.skippedCounts.NOT_CONFIRMED).toBeGreaterThan(0);
    expect(report.skippedCounts.NO_EVIDENCE).toBeGreaterThan(0);
    expect(report.skippedCounts.NEEDS_CONFIRMATION).toBe(1);
  });

  it('holds a whole tab for missing or duplicated headers', () => {
    const missing = base(); missing.tabs['가상공급사']!.headers = headers.filter(h => h !== '모델');
    expect(planSheetBlankFill(missing).report.skippedCounts.HEADER_MISSING).toBeGreaterThan(0);
    const dup = base(); dup.tabs['가상공급사']!.headers = [...headers]; dup.tabs['가상공급사']!.headers[2] = '제조사';
    expect(planSheetBlankFill(dup).report.skippedCounts.HEADER_DUPLICATE).toBeGreaterThan(0);
  });

  it('uses only policy-corrector fields, prefers sales policy for 21/23, and skips missing policy links', () => {
    const input = base([row(2, '11가1111'), row(6, '11가1111')]);
    input.policies['POL-1'] = { ...policy({ basic_driver_age: '만 26세 이상', age_21_cost: '9만원', age_23_cost: '8만원' }, ['basic_driver_age', 'age_21_cost', 'age_23_cost']), sales_policy: { age_21_cost: { value: '6만원' }, age_23_cost: { value: '4만원' } } };
    delete input.policyLinks['가상공급사:6'];
    const { plan, report } = planSheetBlankFill(input);
    expect(plan.바꿀칸).toContainEqual({ 범위: '가상공급사!AQ2', 전: '', 후: '6만원' });
    expect(plan.바꿀칸).toContainEqual({ 범위: '가상공급사!AR2', 전: '', 후: '4만원' });
    expect(report.skippedCounts.POLICY_NOT_CORRECTED).toBeGreaterThan(0);
    expect(report.skippedCounts.NO_POLICY_LINK).toBeGreaterThan(0);
  });

  it('rejects stale captures, more than 2000 fills, and never emits duplicate cells; output order is stable', () => {
    const stale = base(); stale.capturedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    expect(() => planSheetBlankFill(stale)).toThrow('SHEET_BLANK_FILL_CAPTURE_STALE');
    const many = base(Array.from({ length: 201 }, (_, i) => row(i + 2, '11가1111')));
    expect(() => planSheetBlankFill(many)).toThrow('SHEET_BLANK_FILL_TOO_MANY_CELLS');
    const ok = planSheetBlankFill(base([row(3, '11가1111'), row(2, '11가1111')])).plan.바꿀칸.map(c => c.범위);
    expect(ok).toEqual([...ok].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true })));
    expect(new Set(ok).size).toBe(ok.length);
  });

  it('treats only null/undefined/empty string as blank; whitespace-only cells are left alone (a human cleared them)', () => {
    const { plan, report } = planSheetBlankFill(base([row(2, '11가1111', { 제조사: '   ', 모델: null })]));
    expect(plan.바꿀칸.some(c => c.범위 === '가상공급사!B2')).toBe(false);
    expect(plan.바꿀칸.some(c => c.범위 === '가상공급사!C2')).toBe(true);
    expect(report.skippedCounts.WHITESPACE_ONLY).toBe(1);
  });

  it('stops when the formula read is missing for a row', () => {
    const input = base();
    delete (input.tabs['가상공급사']!.rows[0] as { formulaCols?: number[] }).formulaCols;
    expect(() => planSheetBlankFill(input)).toThrow('SHEET_BLANK_FILL_FORMULA_READ_REQUIRED');
  });

  it('skips policy fills when the policy-check plate differs from the sheet row plate', () => {
    const input = base();
    input.policyLinks['가상공급사:2'] = { code: 'POL-1', plate: '99하9999' };
    const { plan, report } = planSheetBlankFill(input);
    expect(plan.바꿀칸.some(c => c.후 === '포함' || c.후 === '50~200만원')).toBe(false);
    expect(report.skippedCounts.POLICY_LINK_MISMATCH).toBeGreaterThan(0);
  });

  it('skips number columns whose canonical value is not a plain number and never writes them as text', () => {
    const input = base();
    input.vehicles['11가1111']!.fields = { ...input.vehicles['11가1111']!.fields, year: '2024년', engine_cc: '1,598', seats: '5' };
    const { plan, report } = planSheetBlankFill(input);
    expect(plan.바꿀칸.some(c => c.범위 === '가상공급사!F2' || c.범위 === '가상공급사!G2')).toBe(false);
    expect(plan.바꿀칸).toContainEqual({ 범위: '가상공급사!I2', 전: '', 후: 5 });
    expect(report.skippedCounts.INVALID_NUMBER).toBe(2);
  });

  it('adds a row-confirm (줄확인) of the plate cell for every row that gets a fill, and none for untouched rows', () => {
    const { plan } = planSheetBlankFill(base([row(2, '11가1111'), row(3, '11가1111', Object.fromEntries(headers.map(h => [h, 'x'])))]));
    expect(plan.줄확인).toContainEqual({ 범위: '가상공급사!A2', 값: '11가1111' });
    expect(plan.줄확인.some(c => c.범위 === '가상공급사!A3')).toBe(false);
    for (const c of plan.줄확인) expect(plan.바꿀칸.some(f => f.범위 === c.범위)).toBe(false);
  });

  it('rejects non-finite numeric text (309 digits) and handles real null cells', () => {
    const input = base([{ row: 2, values: headers.map((h, i) => (i === 0 ? '11가1111' : null)), formulaCols: [] }]);
    input.vehicles['11가1111']!.fields = { ...input.vehicles['11가1111']!.fields, year: '9'.repeat(309) };
    const { plan, report } = planSheetBlankFill(input);
    expect(plan.바꿀칸.some(c => c.범위 === '가상공급사!F2')).toBe(false);
    expect(report.skippedCounts.INVALID_NUMBER).toBeGreaterThanOrEqual(1);
    expect(plan.바꿀칸.some(c => c.범위 === '가상공급사!B2')).toBe(true);
  });
});
