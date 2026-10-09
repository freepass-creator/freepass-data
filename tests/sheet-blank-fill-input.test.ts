import { describe, expect, it } from 'vitest';
import { buildSheetBlankFillInput, type SheetBlankFillRawInput } from '../src/application/sheet-blank-fill-input.js';
import { planSheetBlankFill } from '../src/application/sheet-blank-fill.js';
import { exportSheetBlankFillInput } from '../src/jobs/export-sheet-blank-fill-input.js';
import spec from '../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };
import { sharedSheetChannels } from '../src/adapters/shared-sheet-source.js';

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
      [plate]: { 확정: true, 검수상태: '확정', maker: '현대', model: '아반떼', sub_model: 'CN7', trim_name: '모던', year: 2024, engine_cc: 1598, fuel_type: '가솔린', seats: 5, drive_type: '2WD', origin: '국산', vehicle_class: '준중형 세단', policy_code: policyCode },
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

  it('treats conflicting confirmed fields as unconfirmed', () => {
    const input = raw({ products: { [plate]: { 확정: true, 검수상태: '확인필요', maker: '현대', policy_code: policyCode } } });
    const built = buildSheetBlankFillInput(input);
    expect(built.vehicles[plate]!.confirmed).toBe(false);
    const result = planSheetBlankFill(built);
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

  it('does not link policy rows when product policy_code disagrees, so policy fields are skipped', () => {
    const input = raw({ products: { [plate]: { 확정: true, 검수상태: '확정', maker: '현대', policy_code: 'OTHER-POLICY' } } });
    const built = buildSheetBlankFillInput(input);
    expect(built.policyLinks).toEqual({});
    const result = planSheetBlankFill(built);
    expect(fills(result).some((cell) => rangeOf(cell) === `${tab}!AL2`)).toBe(false);
    expect(report(result).skippedCounts.NO_POLICY_LINK).toBeGreaterThan(0);
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

describe('sheet blank fill input export job', () => {
  const allTabs = [...new Set(sharedSheetChannels.map((channel) => channel.tab as string))];
  const jobTab = allTabs[0]!;
  const titles = [...allTabs, '정책확인'];
  const batch = (byTitle: Record<string, unknown[][]>, omitLast = false) => ({
    valueRanges: titles.slice(0, omitLast ? -1 : undefined).map((title) => ({ range: `'${title}'!A:ZZ`, values: byTitle[title] ?? [] })),
  });
  const baseRows = () => {
    const row = emptyRow();
    row[plateCol] = plate;
    (row as unknown[])[makerCol] = false;
    return {
      [jobTab]: [headers, row],
      정책확인: [['공급사탭ID', '원본행', '상태', '정책코드', '원천행', 'runId'], [101, 2, 'MATCHED', policyCode, 1, 'run-1']],
    };
  };
  const runExport = async (reads: unknown[], byTitle = baseRows()) => {
    const oldSheet = process.env.SHEET_BLANK_FILL_SPREADSHEET;
    const oldOut = process.env.SHEET_BLANK_FILL_INPUT_OUT;
    process.env.SHEET_BLANK_FILL_SPREADSHEET = 'env-sheet-id';
    process.env.SHEET_BLANK_FILL_INPUT_OUT = 'virtual-output.json';
    let artifact: unknown;
    let call = 0;
    try {
      await exportSheetBlankFillInput({
        readSheetsBatchGet: async () => reads[call++] ?? batch(byTitle),
        readSheetsMetadata: async () => ({ sheets: [{ properties: { title: jobTab, sheetId: 101 } }] }),
        readCanonDocuments: async (collection, ids) => collection === 'products'
          ? Object.fromEntries(ids.map((id) => [id, { 확정: true, 검수상태: '확정', maker: '현대', policy_code: policyCode }]))
          : Object.fromEntries(ids.map((id) => [id, policy({ basic_driver_age: '만 26세 이상' })])),
        writePrivateArtifact: async (_out, input) => { artifact = input; },
        now: () => new Date(),
        sleep: async () => {},
      });
      return { artifact: artifact as ReturnType<typeof buildSheetBlankFillInput>, calls: call };
    } finally {
      if (oldSheet === undefined) delete process.env.SHEET_BLANK_FILL_SPREADSHEET; else process.env.SHEET_BLANK_FILL_SPREADSHEET = oldSheet;
      if (oldOut === undefined) delete process.env.SHEET_BLANK_FILL_INPUT_OUT; else process.env.SHEET_BLANK_FILL_INPUT_OUT = oldOut;
    }
  };

  it('passes boolean sheet values as TRUE/FALSE text instead of blanking them', async () => {
    const { artifact } = await runExport([batch(baseRows()), batch(baseRows()), batch(baseRows()), batch(baseRows())]);
    expect(artifact.tabs[jobTab]!.rows[0]!.values[makerCol]).toBe('FALSE');
  });

  it('retries changed values and stops on the third unstable read', async () => {
    const changed = baseRows();
    changed[jobTab] = [headers, (() => { const row = emptyRow(); row[plateCol] = plate; row[makerCol] = 'changed'; return row; })()];
    await expect(runExport([
      batch(baseRows()), batch(baseRows()), batch(changed), batch(baseRows()),
      batch(baseRows()), batch(baseRows()), batch(changed), batch(baseRows()),
      batch(baseRows()), batch(baseRows()), batch(changed), batch(baseRows()),
    ])).rejects.toThrow('SHARED_SHEET_CAPTURE_CHANGED_DURING_READ');
  });

  it('stops when formulas change between the two formula reads', async () => {
    const formulas = baseRows();
    const formulasChanged = baseRows();
    formulasChanged[jobTab]![1]![makerCol] = '=IF(A2="","",FALSE)';
    await expect(runExport([
      batch(baseRows()), batch(formulas), batch(baseRows()), batch(formulasChanged),
      batch(baseRows()), batch(formulas), batch(baseRows()), batch(formulasChanged),
      batch(baseRows()), batch(formulas), batch(baseRows()), batch(formulasChanged),
    ])).rejects.toThrow('SHARED_SHEET_CAPTURE_CHANGED_DURING_READ');
  });

  it('fails closed when the FORMULA response omits a requested range', async () => {
    await expect(runExport([batch(baseRows()), batch(baseRows(), true), batch(baseRows()), batch(baseRows(), true)])).rejects.toThrow('SHEET_BLANK_FILL_INPUT_SHAPE');
  });

  it('fails closed when FORMULA ranges are present but values are empty arrays', async () => {
    const emptyFormulaValues = Object.fromEntries(titles.map((title) => [title, []])) as Record<string, unknown[][]>;
    await expect(runExport([batch(baseRows()), batch(emptyFormulaValues), batch(baseRows()), batch(emptyFormulaValues)])).rejects.toThrow('SHEET_BLANK_FILL_INPUT_SHAPE');
  });

  it('fails closed when a value row has no matching FORMULA row', async () => {
    const formulas = baseRows();
    formulas[jobTab] = [headers];
    await expect(runExport([batch(baseRows()), batch(formulas), batch(baseRows()), batch(formulas)])).rejects.toThrow('SHEET_BLANK_FILL_INPUT_SHAPE');
  });

  it('fails closed when a non-empty value cell has no matching FORMULA cell', async () => {
    const formulas = baseRows();
    formulas[jobTab] = [headers, headers.slice(0, makerCol)];
    await expect(runExport([batch(baseRows()), batch(formulas), batch(baseRows()), batch(formulas)])).rejects.toThrow('SHEET_BLANK_FILL_INPUT_SHAPE');
  });

  it('fails closed when a non-formula FORMULA cell disagrees with its value cell', async () => {
    const formulas = baseRows();
    formulas[jobTab]![1]![makerCol] = 'TRUE';
    await expect(runExport([batch(baseRows()), batch(formulas), batch(baseRows()), batch(formulas)])).rejects.toThrow('SHEET_BLANK_FILL_INPUT_SHAPE');
  });

  it('fails closed when a plate row has no FORMULA row or no FORMULA plate cell', async () => {
    const noFormulaRow = baseRows();
    noFormulaRow[jobTab] = [headers];
    await expect(runExport([batch(baseRows()), batch(noFormulaRow), batch(baseRows()), batch(noFormulaRow)])).rejects.toThrow('SHEET_BLANK_FILL_INPUT_SHAPE');

    const noPlateFormulaCell = baseRows();
    noPlateFormulaCell[jobTab] = [headers, headers.slice(0, plateCol)];
    await expect(runExport([batch(baseRows()), batch(noPlateFormulaCell), batch(baseRows()), batch(noPlateFormulaCell)])).rejects.toThrow('SHEET_BLANK_FILL_INPUT_SHAPE');
  });

  it('allows a missing FORMULA cell for an empty value cell trimmed from the row end', async () => {
    const values = baseRows();
    const row = emptyRow();
    row[plateCol] = plate;
    values[jobTab] = [headers, row];
    const formulas = baseRows();
    const formulaRow = emptyRow().slice(0, plateCol + 1);
    formulaRow[plateCol] = plate;
    formulas[jobTab] = [headers, formulaRow];
    const { artifact } = await runExport([batch(values), batch(formulas), batch(values), batch(formulas)], values);
    expect(artifact.tabs[jobTab]!.rows[0]!.values[plateCol]).toBe(plate);
    expect(artifact.tabs[jobTab]!.rows[0]!.formulaCols).not.toContain(makerCol);
  });

  it('keeps extra FORMULA rows and records their formula columns when value rows are empty', async () => {
    const values = baseRows();
    values[jobTab] = [headers];
    const formulas = baseRows();
    const formulaOnlyRow = headers.map(() => '');
    formulaOnlyRow[makerCol] = '=IF(A2="","",FALSE)';
    formulas[jobTab] = [headers, formulaOnlyRow];
    const { artifact } = await runExport([batch(values), batch(formulas), batch(values), batch(formulas)], values);
    expect(artifact.tabs[jobTab]!.rows).toHaveLength(1);
    expect(artifact.tabs[jobTab]!.rows[0]!.formulaCols).toContain(makerCol);
    expect(fills(planSheetBlankFill(artifact))).toHaveLength(0);
  });

  it('keeps header-name mapping when a tab header order changes', async () => {
    const movedHeaders = [...headers];
    const [removed] = movedHeaders.splice(makerCol, 1);
    movedHeaders.splice(modelCol + 2, 0, removed!);
    const makerIndex = movedHeaders.indexOf(headers[makerCol]!);
    const plateIndex = movedHeaders.indexOf(headers[plateCol]!);
    const row = movedHeaders.map(() => null) as Array<string | number | null>;
    row[plateIndex] = plate;
    const byTitle = { [jobTab]: [movedHeaders, row], 정책확인: baseRows().정책확인 };
    const { artifact } = await runExport([batch(byTitle), batch(byTitle), batch(byTitle), batch(byTitle)], byTitle);
    const result = planSheetBlankFill(artifact);
    expect(fills(result).some((cell) => rangeOf(cell) === `${jobTab}!${String.fromCharCode(65 + makerIndex)}2`)).toBe(true);
  });

  it('stops when one tab is over the row safety limit', async () => {
    const tooLargeRows = Array.from({ length: 5001 }, () => emptyRow());
    const byTitle = { ...baseRows(), [jobTab]: [headers, ...tooLargeRows] };
    await expect(runExport([batch(byTitle), batch(byTitle), batch(byTitle), batch(byTitle)], byTitle)).rejects.toThrow('SHEET_BLANK_FILL_TAB_TOO_LARGE');
  });
});
