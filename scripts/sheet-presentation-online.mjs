import { createHash } from 'node:crypto';
import { planPresentation, specification } from './sheet-presentation.mjs';

const hold = message => { throw new Error(`HOLD: ${message}`); };
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const base = workbook => {
  const id = specification.workbooks[workbook]?.spreadsheetId;
  if (!id) hold('Unknown workbook');
  return `https://sheets.googleapis.com/v4/spreadsheets/${id}`;
};
const column = number => {
  let result = '';
  for (let n = number; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
};
const metadataFields = 'spreadsheetId,sheets(properties,basicFilter)';

/** api(url, {method, body?}) must throw on any HTTP/API failure; return parsed JSON.
 * Authentication belongs to the existing publisher. This module has no credentials,
 * scheduler, fallback, source ingestion, or Firestore dependency.
 */
export async function collectPresentation(api, workbook) {
  const started = new Date().toISOString();
  const url = base(workbook);
  const before = await api(`${url}?fields=${encodeURIComponent(metadataFields)}`, { method: 'GET' });
  if (before.spreadsheetId !== specification.workbooks[workbook].spreadsheetId || !Array.isArray(before.sheets)) hold('Incomplete metadata response');
  const spreadsheet = structuredClone(before), coverage = [];
  for (const sheet of spreadsheet.sheets) {
    const prop = sheet.properties;
    if (prop.hidden) continue;
    const { rowCount, columnCount } = prop.gridProperties ?? {};
    if (!Number.isSafeInteger(rowCount) || rowCount < 1 || !Number.isSafeInteger(columnCount) || columnCount < 1) hold('Invalid grid dimensions');
    const range = `'${prop.title.replace(/'/g, "''")}'!A1:${column(columnCount)}${rowCount}`;
    const fields = 'spreadsheetId,sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue)),columnMetadata(pixelSize,hiddenByUser)))';
    const full = await api(`${url}?includeGridData=true&ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`, { method: 'GET' });
    if (full.spreadsheetId !== spreadsheet.spreadsheetId || full.sheets?.length !== 1 || full.sheets[0].properties?.sheetId !== prop.sheetId) hold('Wrong grid response');
    const grids = full.sheets[0].data;
    if (grids?.length !== 1 || (grids[0].startRow ?? 0) !== 0 || (grids[0].startColumn ?? 0) !== 0) hold('Incomplete A1 grid response');
    const grid = grids[0];
    // Sheets omits trailing empty rows/cells even for an explicit full range.
    // Normalize only after the successful, bounded full-range API response.
    grid.rowData ??= [];
    if (grid.rowData.length > rowCount) hold('Grid exceeds requested rows');
    while (grid.rowData.length < rowCount) grid.rowData.push({ values: [] });
    for (const row of grid.rowData) {
      row.values ??= [];
      if (row.values.length > columnCount) hold('Row exceeds requested columns');
      while (row.values.length < columnCount) row.values.push({});
      row.values = row.values.map(cell => ({
        ...(cell.userEnteredValue && Object.keys(cell.userEnteredValue).length ? { userEnteredValue: cell.userEnteredValue } : {}),
        ...(cell.effectiveValue && Object.keys(cell.effectiveValue).length ? { effectiveValue: cell.effectiveValue } : {}),
      }));
    }
    if (grid.columnMetadata?.length !== columnCount) hold('Missing column metadata');
    sheet.data = grids;
    coverage.push({ sheetId: prop.sheetId, endRowIndex: rowCount, endColumnIndex: columnCount });
  }
  const after = await api(`${url}?fields=${encodeURIComponent(metadataFields)}`, { method: 'GET' });
  if (digest(before) !== digest(after)) hold('Metadata changed during collection');
  return { capturedAt: started, sheetInventory: after.sheets.map(s => s.properties), coverage, spreadsheet };
}

const observationDigest = input => digest({ sheetInventory: input.sheetInventory, coverage: input.coverage, spreadsheet: input.spreadsheet });
const cellDigest = input => digest(input.spreadsheet.sheets.filter(s => !s.properties.hidden).map(s => ({
  sheetId: s.properties.sheetId,
  rows: s.data[0].rowData.map(r => (r.values ?? []).map(c => c.userEnteredValue ?? {})),
})).sort((a, b) => a.sheetId - b.sheetId));

/** The caller must hold the existing erp5-inventory-publish concurrency lock.
 * Apply requires the production write gate and durable private backup callbacks.
 * Dry run is the default. No raw data is returned in the public receipt.
 */
export async function runPresentation({ api, workbook, updatedAt, apply = false, authorizeWrite, saveBackup }) {
  const before = await collectPresentation(api, workbook);
  const plan = planPresentation(before, { workbook, updatedAt });
  const receipt = { workbook, spreadsheetId: plan.spreadsheetId, updatedAt, specDigest: digest(specification), snapshotDigest: observationDigest(before), status: plan.status, counts: plan.counts, changes: plan.changes };
  if (!apply || !plan.requests.length) return { ...receipt, applied: false };
  if (typeof authorizeWrite !== 'function' || typeof saveBackup !== 'function') hold('Production write gate and private backup required');
  await authorizeWrite({ workbook, spreadsheetId: plan.spreadsheetId, requests: structuredClone(plan.requests) });
  await saveBackup(structuredClone(before));
  const fresh = await collectPresentation(api, workbook);
  planPresentation(fresh, { workbook, updatedAt });
  if (observationDigest(fresh) !== receipt.snapshotDigest) hold('Concurrent sheet change before apply');
  await api(`${base(workbook)}:batchUpdate`, { method: 'POST', body: { requests: plan.requests } });
  const after = await collectPresentation(api, workbook);
  if (cellDigest(before) !== cellDigest(after)) hold('Cell values or formulas changed during presentation update');
  const verification = planPresentation(after, { workbook, updatedAt });
  if (verification.status !== 'PASS') hold('Presentation readback differs from contract');
  return { ...receipt, status: 'PASS', applied: true, verification: 'FRESH_READBACK', afterDigest: observationDigest(after) };
}
