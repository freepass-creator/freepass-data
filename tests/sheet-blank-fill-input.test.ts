import { describe, expect, it } from 'vitest';
import { buildSheetBlankFillInput, type SheetBlankFillRawInput } from '../src/application/sheet-blank-fill-input.js';
import { planSheetBlankFill } from '../src/application/sheet-blank-fill.js';
import spec from '../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };

const headers = spec.inputHeaders as string[];
const tab = '가상공급사';
const plate = '11가1111';
const policyCode = 'POL-VIRTUAL';
const fresh = () => new Date().toISOString();
const emptyRow = (): Array<string | number | null> => headers.map(() => null);
const plateCol = 4;
const makerCol = 5;
const modelCol = 6;
const policy = (fields: Record<string, unknown> = {}, writerFields = Object.keys(fields)) => ({
  ...fields,
  field_evidence: Object.fromEntries(writerFields.map((field) => [field, { writer: 'policy-corrector' }])),
});
const raw = (overrides: Partial<SheetBlankFillRawInput> = {}): SheetBlankFillRawInput => {
  const row = emptyRow();
  row[plateCol] = plate;
  return {
    spreadsheetId: 'virtual-sheet',
    capturedAt: fresh(),
    tabs: { [tab]: { headerRow: headers, valueRows: [row], formulaRows: [headers.map(() => '')] } },
    checkRows: [['공급사탭ID', '원본행', '상태', '정책코드', '원천행', 'runId'], [101, 2, 'MATCHED', policyCode, 777, 'run-1']],
    tabIds: { [tab]: 101 },
    products: {
      [plate]: { 확정: true, 검수상태: '확정', maker: '현대', model: '아반떼', sub_model: 'CN7', trim_name: '모던', year: 2024, engine_cc: 1598, fuel_type: '가솔린', seats: 5, drive_type: '2WD', origin: '국산', vehicle_class: '준중형 세단' },
    },
    policies: { [policyCode]: policy({ basic_driver_age: '만 26세 이상', insurance_included: '보험료 포함', own_damage_min_deductible: '50만원', own_damage_max_deductible: '200만원' }) },
    ...overrides,
  };
};
const arrayValues = (obj: object) => Object.values(obj).filter(Array.isArray) as Array<Array<Record<string, unknown>>>;
const rangeOf = (cell: Record<string, unknown>) => Object.values(cell).find((value) => typeof value === 'string' && value.includes('!')) as string;
const valueOf = (cell: Record<string, unknown>) => Object.values(cell).at(-1);
const fills = (input: ReturnType<typeof planSheetBlankFill>) => arrayValues(input.plan)[0]!;
const report = (input: ReturnType<typeof planSheetBlankFill>) => input.report as unknown as {
  differences: unknown[];
  skippedCounts: Record<string, number | undefined>;
};
const lineChecks = (input: ReturnType<typeof planSheetBlankFill>) => arrayValues(input.plan)[1]!;

describe('sheet blank fill input adapter', () => {
  it('rejects mismatched formula row shape', () => {
    const input = raw({ tabs: { [tab]: { headerRow: headers, valueRows: [emptyRow()], formulaRows: [] } } });
    expect(() => buildSheetBlankFillInput(input)).toThrow('SHEET_BLANK_FILL_INPUT_SHAPE');
  });

  it('marks formula cells so the planner never fills them', () => {
    const input = raw();
    input.tabs[tab]!.formulaRows[0]![makerCol] = '=A1';
    const result = planSheetBlankFill(buildSheetBlankFillInput(input));
    expect(fills(result).some((cell) => rangeOf(cell) === `${tab}!F2`)).toBe(false);
    expect(report(result).skippedCounts.FORMULA_CELL).toBe(1);
  });

  it('does not overwrite supplier-entered values and records differences only', () => {
    const input = raw();
    input.tabs[tab]!.valueRows[0]![makerCol] = '기아';
    input.tabs[tab]!.valueRows[0]![modelCol] = null;
    const result = planSheetBlankFill(buildSheetBlankFillInput(input));
    expect(fills(result).some((cell) => rangeOf(cell) === `${tab}!F2`)).toBe(false);
    expect(fills(result).some((cell) => rangeOf(cell) === `${tab}!G2`)).toBe(true);
    expect(report(result).differences).toHaveLength(1);
  });

  it('does not fill unconfirmed products', () => {
    const input = raw({ products: { [plate]: { 확정: false, 검수상태: '확인필요', maker: '현대' } } });
    const result = planSheetBlankFill(buildSheetBlankFillInput(input));
    expect(fills(result).some((cell) => rangeOf(cell) === `${tab}!F2`)).toBe(false);
    expect(report(result).skippedCounts.NOT_CONFIRMED).toBeGreaterThan(0);
  });

  it('links only MATCHED policy rows whose tab id and sheet plate match', () => {
    const input = raw({
      checkRows: [['공급사탭ID', '원본행', '상태', '정책코드', '원천행', 'runId'], [101, 2, 'MATCHED', policyCode, 1, 'r'], [999, 2, 'MATCHED', 'OTHER', 1, 'r'], [101, 3, 'PENDING', 'OTHER', 1, 'r']],
    });
    input.tabs[tab]!.valueRows.push(headers.map(() => null));
    input.tabs[tab]!.valueRows[1]![plateCol] = '';
    input.tabs[tab]!.formulaRows.push(headers.map(() => ''));
    const built = buildSheetBlankFillInput(input);
    expect(built.policyLinks).toEqual({ [`${tab}:2`]: { code: policyCode, plate } });
  });

  it('fills policy fields only with policy-corrector evidence', () => {
    const ok = planSheetBlankFill(buildSheetBlankFillInput(raw()));
    expect(fills(ok).some((cell) => rangeOf(cell) === `${tab}!AL2`)).toBe(true);
    const input = raw({ policies: { [policyCode]: policy({ basic_driver_age: '만 26세 이상' }, []) } });
    const blocked = planSheetBlankFill(buildSheetBlankFillInput(input));
    expect(fills(blocked).some((cell) => rangeOf(cell) === `${tab}!AL2`)).toBe(false);
    expect(report(blocked).skippedCounts.POLICY_NOT_CORRECTED).toBeGreaterThan(0);
  });

  it('passes comma numeric product values through so the planner reports INVALID_NUMBER', () => {
    const input = raw();
    input.products[plate]!.engine_cc = '1,598';
    const result = planSheetBlankFill(buildSheetBlankFillInput(input));
    expect(fills(result).some((cell) => rangeOf(cell) === `${tab}!N2`)).toBe(false);
    expect(report(result).skippedCounts.INVALID_NUMBER).toBeGreaterThan(0);
  });

  it('emits planner row-confirm entries for filled rows', () => {
    const result = planSheetBlankFill(buildSheetBlankFillInput(raw()));
    expect(lineChecks(result).some((cell) => rangeOf(cell) === `${tab}!E2` && valueOf(cell) === plate)).toBe(true);
  });
});
