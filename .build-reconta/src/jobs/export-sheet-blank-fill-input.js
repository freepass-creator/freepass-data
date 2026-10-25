import { pathToFileURL } from 'node:url';
import { sharedSheetChannels } from '../adapters/shared-sheet-source.js';
import { buildSheetBlankFillInput } from '../application/sheet-blank-fill-input.js';
import { readCanonDocuments } from '../infra/sheet-blank-fill-canon-reader.js';
import { readSheetsBatchGet, readSheetsMetadata } from '../infra/shared-sheet-capture-reader.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';
const CHECK_TAB = '정책확인';
const MAX_ROWS_PER_TAB = 5000;
const retryable = /^(SHARED_SHEET_CAPTURE_CHANGED_DURING_READ|SHARED_SHEET_READ_UNKNOWN|SHARED_SHEET_RESPONSE_INVALID|SHARED_SHEET_HTTP_(429|500|502|503|504))$/;
const cell = (value) => typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string' ? value : null;
const formulaCell = (value) => typeof value === 'string' ? value : '';
const text = (value) => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
function valuesByTitle(response, titles) {
    if (!Array.isArray(response.valueRanges) || response.valueRanges.length !== titles.length)
        throw new Error('SHEET_BLANK_FILL_INPUT_SHAPE');
    const out = {};
    const ranges = response.valueRanges ?? [];
    titles.forEach((title, index) => {
        if (!ranges[index] || !Array.isArray(ranges[index].values))
            throw new Error('SHEET_BLANK_FILL_INPUT_SHAPE');
        out[title] = ranges[index].values;
    });
    return out;
}
function equalBatch(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
function rangeFor(tab) {
    return `'${tab.replaceAll("'", "''")}'!A:ZZ`;
}
async function readStable(deps, spreadsheetId, ranges) {
    for (let attempt = 1;; attempt++) {
        try {
            const capturedAt = deps.now().toISOString();
            const before = await deps.readSheetsBatchGet(spreadsheetId, ranges, {}, 'SERIAL');
            const formulasBefore = await deps.readSheetsBatchGet(spreadsheetId, ranges, {}, 'FORMULA');
            const after = await deps.readSheetsBatchGet(spreadsheetId, ranges, {}, 'SERIAL');
            const formulasAfter = await deps.readSheetsBatchGet(spreadsheetId, ranges, {}, 'FORMULA');
            if (!equalBatch(before, after))
                throw new Error('SHARED_SHEET_CAPTURE_CHANGED_DURING_READ');
            if (!equalBatch(formulasBefore, formulasAfter))
                throw new Error('SHARED_SHEET_CAPTURE_CHANGED_DURING_READ');
            return { capturedAt, values: before, formulas: formulasBefore };
        }
        catch (error) {
            if (attempt >= 3 || !(error instanceof Error) || !retryable.test(error.message))
                throw error;
            await deps.sleep(30_000);
        }
    }
}
function normalizeRows(rows) {
    const width = Math.max(0, ...rows.map((row) => row.length));
    return rows.map((row) => Array.from({ length: width }, (_, index) => cell(row[index])));
}
function present(value) {
    return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');
}
function comparableCell(value) {
    return cell(value);
}
function assertFormulaShape(valueRows, formulaRows, plateCol) {
    for (let rowIndex = 0; rowIndex < valueRows.length; rowIndex++) {
        const valueRow = valueRows[rowIndex] ?? [];
        const formulaRow = formulaRows[rowIndex];
        if (rowIndex > 0 && plateCol >= 0 && present(valueRow[plateCol])) {
            if (!formulaRow || plateCol >= formulaRow.length || formulaRow[plateCol] === undefined) {
                throw new Error('SHEET_BLANK_FILL_INPUT_SHAPE');
            }
        }
        for (let col = 0; col < valueRow.length; col++) {
            if (!present(valueRow[col]))
                continue;
            if (!formulaRow || col >= formulaRow.length || formulaRow[col] === undefined) {
                throw new Error('SHEET_BLANK_FILL_INPUT_SHAPE');
            }
            const formula = formulaRow[col];
            if (typeof formula === 'string' && formula.startsWith('='))
                continue;
            if (comparableCell(valueRow[col]) !== comparableCell(formula)) {
                throw new Error('SHEET_BLANK_FILL_INPUT_SHAPE');
            }
        }
    }
}
function normalizeTabRows(valueRawRows, formulaRawRows) {
    const rawHeader = valueRawRows[0] ?? [];
    const plateCol = rawHeader.map((item) => text(item)).indexOf('李⑤웾踰덊샇');
    assertFormulaShape(valueRawRows, formulaRawRows, plateCol);
    const dataRowCount = Math.max(Math.max(0, valueRawRows.length - 1), Math.max(0, formulaRawRows.length - 1));
    const width = Math.max(0, ...valueRawRows.map((row) => row.length), ...formulaRawRows.map((row) => row.length));
    const normalizedValues = normalizeRows(valueRawRows).map((row) => Array.from({ length: width }, (_, index) => row[index] ?? null));
    const dataFormulaRows = Array.from({ length: dataRowCount }, (_, dataIndex) => {
        const formulaRow = formulaRawRows[dataIndex + 1] ?? [];
        return Array.from({ length: width }, (_, index) => formulaCell(formulaRow[index]));
    });
    return {
        headerRow: normalizedValues[0] ?? [],
        valueRows: Array.from({ length: dataRowCount }, (_, dataIndex) => normalizedValues[dataIndex + 1] ?? Array.from({ length: width }, () => null)),
        formulaRows: dataFormulaRows,
    };
}
function metadataTabIds(meta) {
    const out = {};
    for (const sheet of meta.sheets ?? []) {
        const title = sheet.properties?.title;
        const sheetId = sheet.properties?.sheetId;
        if (title && typeof sheetId === 'number')
            out[title] = sheetId;
    }
    return out;
}
export async function main() {
    await exportSheetBlankFillInput({
        readSheetsBatchGet,
        readSheetsMetadata,
        readCanonDocuments,
        writePrivateArtifact,
        now: () => new Date(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
}
export async function exportSheetBlankFillInput(deps) {
    const spreadsheetId = process.env.SHEET_BLANK_FILL_SPREADSHEET?.trim();
    const out = process.env.SHEET_BLANK_FILL_INPUT_OUT?.trim();
    if (!spreadsheetId || !out)
        throw new Error('SHEET_BLANK_FILL_EXPORT_ENV_REQUIRED');
    const tabs = [...new Set(sharedSheetChannels.map((channel) => channel.tab))];
    const titles = [...tabs, CHECK_TAB];
    const ranges = titles.map(rangeFor);
    const meta = await deps.readSheetsMetadata(spreadsheetId, 'sheets.properties(sheetId,title)');
    const { capturedAt, values, formulas } = await readStable(deps, spreadsheetId, ranges);
    const byTab = valuesByTitle(values, titles);
    const formulaByTab = valuesByTitle(formulas, titles);
    const rawTabs = {};
    const plates = [];
    for (const tab of tabs) {
        const rawValueRows = byTab[tab] ?? [];
        if (rawValueRows.length > MAX_ROWS_PER_TAB + 1)
            throw new Error('SHEET_BLANK_FILL_TAB_TOO_LARGE');
        const { headerRow, valueRows, formulaRows } = normalizeTabRows(rawValueRows, formulaByTab[tab] ?? []);
        rawTabs[tab] = { headerRow, valueRows, formulaRows };
        const plateCol = headerRow.map((item) => text(item)).indexOf('차량번호');
        if (plateCol >= 0)
            for (const row of valueRows) {
                const plate = text(row[plateCol]);
                if (plate)
                    plates.push(plate);
            }
    }
    const checkRows = normalizeRows(byTab[CHECK_TAB] ?? []);
    const checkHeader = checkRows[0] ?? [];
    const codeCol = checkHeader.map((item) => text(item)).indexOf('정책코드');
    const policyCodes = codeCol >= 0 ? checkRows.slice(1).map((row) => text(row[codeCol])).filter(Boolean) : [];
    const products = await deps.readCanonDocuments('products', plates);
    const policies = await deps.readCanonDocuments('policy', policyCodes);
    const input = buildSheetBlankFillInput({ spreadsheetId, capturedAt, tabs: rawTabs, checkRows, tabIds: metadataTabIds(meta), products, policies });
    await deps.writePrivateArtifact(out, input);
    console.log(JSON.stringify({ tabs: Object.keys(input.tabs).length, rows: Object.values(input.tabs).reduce((sum, tab) => sum + tab.rows.length, 0),
        vehicles: Object.keys(input.vehicles).length, policyLinks: Object.keys(input.policyLinks).length, policies: Object.keys(input.policies).length }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(`SHEET_BLANK_FILL_EXPORT_HOLD ${error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : ''}`.trim());
        process.exitCode = 1;
    });
}
