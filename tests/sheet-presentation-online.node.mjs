import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPresentation, runPresentation } from '../scripts/sheet-presentation-online.mjs';
import { specification as spec } from '../scripts/sheet-presentation.mjs';

function service() {
  const state = { writes: 0, gets: 0, mutateAt: 0, corruptAfterWrite: false, omitColumns: false };
  const book = { spreadsheetId: spec.workbooks.F01.spreadsheetId, sheets: spec.workbooks.F01.primarySheetIds.map((sheetId, i) => ({
    properties: { sheetId, index: i, title: spec.primaryTabs[i].label, gridProperties: { rowCount: 3, columnCount: 3 } },
    data: [{ rowData: [{ values: ['차량번호', '차명(원문)', '옵션(원문)'].map(stringValue => ({ userEnteredValue: { stringValue } })) }, { values: [{ userEnteredValue: { stringValue: `TEST${i}` } }] }], columnMetadata: [{ pixelSize: 90 }, { pixelSize: 90 }, { pixelSize: 90 }] }],
  })) };
  async function api(url, options) {
    if (options.method === 'POST') {
      state.writes++;
      for (const r of options.body.requests) {
        if (r.updateSheetProperties) {
          const p = r.updateSheetProperties.properties, s = book.sheets.find(s => s.properties.sheetId === p.sheetId);
          if (p.gridProperties) Object.assign(s.properties.gridProperties, p.gridProperties);
          else Object.assign(s.properties, p);
        } else if (r.updateDimensionProperties) {
          const rdp = r.updateDimensionProperties;
          Object.assign(book.sheets.find(s => s.properties.sheetId === rdp.range.sheetId).data[0].columnMetadata[rdp.range.startIndex], rdp.properties);
        } else if (r.setBasicFilter) book.sheets.find(s => s.properties.sheetId === r.setBasicFilter.filter.range.sheetId).basicFilter = r.setBasicFilter.filter;
        else throw new Error('Unexpected request');
      }
      if (state.corruptAfterWrite) book.sheets[0].data[0].rowData[1].values[0].userEnteredValue.stringValue = 'CORRUPTED';
      return {};
    }
    state.gets++;
    if (state.gets === state.mutateAt) book.sheets[0].data[0].rowData[1].values[0].userEnteredValue.stringValue = 'CONCURRENT';
    const range = new URL(url).searchParams.get('ranges');
    if (!range) return structuredClone({ spreadsheetId: book.spreadsheetId, sheets: book.sheets.map(({ properties, basicFilter }) => ({ properties, ...(basicFilter ? { basicFilter } : {}) })) });
    const sheet = book.sheets.find(s => range.startsWith(`'${s.properties.title}'!`));
    assert.ok(sheet, 'range must resolve the current native title');
    const result = structuredClone({ spreadsheetId: book.spreadsheetId, sheets: [{ properties: { sheetId: sheet.properties.sheetId }, data: sheet.data }] });
    if (state.omitColumns) result.sheets[0].data[0].columnMetadata.pop();
    return result;
  }
  return { state, api };
}
const options = api => ({ api, workbook: 'F01', updatedAt: new Date().toISOString() });

test('full-range collection normalizes Google trailing empty rows, never column metadata', async () => {
  const { state, api } = service();
  const snapshot = await collectPresentation(api, 'F01');
  assert.equal(snapshot.spreadsheet.sheets[0].data[0].rowData.length, 3);
  assert.equal(snapshot.spreadsheet.sheets[0].data[0].rowData[1].values.length, 3);
  assert.deepEqual(snapshot.spreadsheet.sheets[0].data[0].rowData[2].values, [{}, {}, {}]);
  assert.equal(snapshot.coverage.length, 4);
  state.omitColumns = true;
  await assert.rejects(collectPresentation(api, 'F01'), /Missing column metadata/);
});
test('default dry-run makes no writes and discloses no cell contents', async () => {
  const { state, api } = service();
  const receipt = await runPresentation(options(api));
  assert.equal(state.writes, 0);
  assert.equal(receipt.status, 'CHANGES_REQUIRED');
  assert.ok(!JSON.stringify(receipt).includes('TEST0'));
});
test('apply requires production authorization and durable backup', async () => {
  const { state, api } = service();
  await assert.rejects(runPresentation({ ...options(api), apply: true }), /gate and private backup/);
  assert.equal(state.writes, 0);
});
test('online apply reads back PASS; repeat with same time makes zero additional writes', async () => {
  const { state, api } = service(), events = [];
  const opts = { ...options(api), apply: true, authorizeWrite: async () => { events.push('gate'); }, saveBackup: async () => { events.push('backup'); } };
  const first = await runPresentation(opts);
  assert.equal(first.verification, 'FRESH_READBACK');
  assert.deepEqual(events, ['gate', 'backup']);
  const second = await runPresentation(opts);
  assert.equal(second.status, 'PASS');
  assert.equal(second.applied, false);
  assert.equal(state.writes, 1);
});
test('concurrent cell change between plan and apply prevents all writes', async () => {
  const { state, api } = service(); state.mutateAt = 7;
  await assert.rejects(runPresentation({ ...options(api), apply: true, authorizeWrite: async () => {}, saveBackup: async () => {} }), /Concurrent sheet change/);
  assert.equal(state.writes, 0);
});
test('failed private backup prevents writes', async () => {
  const { state, api } = service();
  await assert.rejects(runPresentation({ ...options(api), apply: true, authorizeWrite: async () => {}, saveBackup: async () => { throw new Error('Disk failure'); } }), /Disk failure/);
  assert.equal(state.writes, 0);
});
test('readback cell drift fails instead of claiming success', async () => {
  const { state, api } = service(); state.corruptAfterWrite = true;
  await assert.rejects(runPresentation({ ...options(api), apply: true, authorizeWrite: async () => {}, saveBackup: async () => {} }), /Cell values or formulas changed/);
  assert.equal(state.writes, 1);
});
