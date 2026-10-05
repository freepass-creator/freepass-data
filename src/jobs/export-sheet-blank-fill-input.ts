import { pathToFileURL } from 'node:url';
import spec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };
import { buildSheetBlankFillInput, type SheetBlankFillRawInput } from '../application/sheet-blank-fill-input.js';
import { readCanonDocuments } from '../infra/sheet-blank-fill-canon-reader.js';
import { readSheetsBatchGet, readSheetsMetadata } from '../infra/shared-sheet-capture-reader.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

type ValueRange = { range?: string; values?: unknown[][] };
type BatchGet = { valueRanges?: ValueRange[] };
type Metadata = { sheets?: Array<{ properties?: { title?: string; sheetId?: number } }> };

const CHECK_TAB = '정책확인';
const retryable = /^(SHARED_SHEET_CAPTURE_CHANGED_DURING_READ|SHARED_SHEET_READ_UNKNOWN|SHARED_SHEET_RESPONSE_INVALID|SHARED_SHEET_HTTP_(429|500|502|503|504))$/;
const cell = (value: unknown): string | number | null => (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string' ? value : null;
const formulaCell = (value: unknown): string => typeof value === 'string' ? value : '';
const text = (value: unknown) => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

function valuesByTitle(response: BatchGet, titles: string[]): Record<string, unknown[][]> {
  const out: Record<string, unknown[][]> = {};
  const ranges = response.valueRanges ?? [];
  titles.forEach((title, index) => { out[title] = ranges[index]?.values ?? []; });
  return out;
}

function equalBatch(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function rangeFor(tab: string): string {
  return `'${tab.replaceAll("'", "''")}'!A:ZZ`;
}

async function readStable(spreadsheetId: string, ranges: string[]) {
  for (let attempt = 1; ; attempt++) {
    try {
      const capturedAt = new Date().toISOString();
      const before = await readSheetsBatchGet(spreadsheetId, ranges, {}, 'SERIAL') as BatchGet;
      const formulas = await readSheetsBatchGet(spreadsheetId, ranges, {}, 'FORMULA') as BatchGet;
      const after = await readSheetsBatchGet(spreadsheetId, ranges, {}, 'SERIAL') as BatchGet;
      if (!equalBatch(before, after)) throw new Error('SHARED_SHEET_CAPTURE_CHANGED_DURING_READ');
      return { capturedAt, values: before, formulas };
    } catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || !retryable.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
}

function normalizeRows(rows: unknown[][]): Array<Array<string | number | null>> {
  const width = Math.max(0, ...rows.map((row) => row.length));
  return rows.map((row) => Array.from({ length: width }, (_, index) => cell(row[index])));
}

function normalizeFormulaRows(rows: unknown[][], rowCount: number, width: number): string[][] {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const row = rows[rowIndex] ?? [];
    return Array.from({ length: width }, (_, index) => formulaCell(row[index]));
  });
}

function metadataTabIds(meta: Metadata): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sheet of meta.sheets ?? []) {
    const title = sheet.properties?.title;
    const sheetId = sheet.properties?.sheetId;
    if (title && typeof sheetId === 'number') out[title] = sheetId;
  }
  return out;
}

export async function main() {
  const spreadsheetId = process.env.SHEET_BLANK_FILL_SPREADSHEET?.trim();
  const out = process.env.SHEET_BLANK_FILL_INPUT_OUT?.trim();
  if (!spreadsheetId || !out) throw new Error('SHEET_BLANK_FILL_EXPORT_ENV_REQUIRED');
  const tabs = [...new Set(spec.supplierChannels.sharedInputSheet.map((channel) => channel.tab as string))];
  const titles = [...tabs, CHECK_TAB];
  const ranges = titles.map(rangeFor);
  const meta = await readSheetsMetadata(spreadsheetId, 'sheets.properties(sheetId,title)') as Metadata;
  const { capturedAt, values, formulas } = await readStable(spreadsheetId, ranges);
  const byTab = valuesByTitle(values, titles);
  const formulaByTab = valuesByTitle(formulas, titles);
  const rawTabs: SheetBlankFillRawInput['tabs'] = {};
  const plates: string[] = [];
  for (const tab of tabs) {
    const rows = normalizeRows(byTab[tab] ?? []);
    const headerRow = rows[0] ?? [];
    const valueRows = rows.slice(1);
    const formulaRows = normalizeFormulaRows((formulaByTab[tab] ?? []).slice(1), valueRows.length, headerRow.length || Math.max(0, ...valueRows.map((row) => row.length)));
    rawTabs[tab] = { headerRow, valueRows, formulaRows };
    const plateCol = headerRow.map((item) => text(item)).indexOf('차량번호');
    if (plateCol >= 0) for (const row of valueRows) {
      const plate = text(row[plateCol]);
      if (plate) plates.push(plate);
    }
  }
  const checkRows = normalizeRows(byTab[CHECK_TAB] ?? []) as Array<Array<string | number>>;
  const checkHeader = checkRows[0] ?? [];
  const codeCol = checkHeader.map((item) => text(item)).indexOf('정책코드');
  const policyCodes = codeCol >= 0 ? checkRows.slice(1).map((row) => text(row[codeCol])).filter(Boolean) : [];
  const products = await readCanonDocuments('products', plates);
  const policies = await readCanonDocuments('policy', policyCodes);
  const input = buildSheetBlankFillInput({ spreadsheetId, capturedAt, tabs: rawTabs, checkRows, tabIds: metadataTabIds(meta), products, policies });
  await writePrivateArtifact(out, input);
  console.log(JSON.stringify({ tabs: Object.keys(input.tabs).length, rows: Object.values(input.tabs).reduce((sum, tab) => sum + tab.rows.length, 0),
    vehicles: Object.keys(input.vehicles).length, policyLinks: Object.keys(input.policyLinks).length, policies: Object.keys(input.policies).length }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`SHEET_BLANK_FILL_EXPORT_HOLD ${error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : ''}`.trim());
    process.exitCode = 1;
  });
}
