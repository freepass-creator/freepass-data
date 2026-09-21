import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const specification = JSON.parse(fs.readFileSync(new URL('../contracts/f01-f86-sheet-spec.v1.json', import.meta.url), 'utf8'));
const fail = message => { throw new Error(`HOLD: ${message}`); };
const value = c => {
  if (c?.userEnteredValue?.formulaValue && !c.effectiveValue) fail('Formula result unavailable');
  const v = c?.effectiveValue ?? c?.userEnteredValue ?? {};
  return v.stringValue ?? v.numberValue ?? '';
};
const hex = c => c && '#' + ['red', 'green', 'blue'].map(k => Math.round((c[k] ?? 0) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const rgb = h => Object.fromEntries(['red', 'green', 'blue'].map((k, i) => [k, parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255]));

// Input: { capturedAt, coverage:[{sheetId,endRowIndex,endColumnIndex}], spreadsheet }.
// spreadsheet is the native Sheets spreadsheets.get response, including full grid
// values/effectiveValues and columnMetadata, for every visible sheet. No credentials.
export function planPresentation(input, { workbook, updatedAt, now = Date.now() }, spec = specification) {
  const binding = spec.workbooks[workbook];
  if (!binding || input.spreadsheet?.spreadsheetId !== binding.spreadsheetId) fail('Wrong workbook');
  if(spec.primaryTabs.length !== 4 || binding.primarySheetIds.length !== 4 || new Set(binding.primarySheetIds).size !== 4) fail('Invalid primary binding');
  const captured = Date.parse(input.capturedAt);
  if (!Number.isFinite(captured) || now - captured > 300000 || captured > now + 1000) fail('Read must be fresh (5 minutes)');
  const time = new Date(updatedAt);
  if (!Number.isFinite(time.getTime())) fail('Explicit update timestamp required');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: spec.timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(time).map(x => [x.type, x.value]));
  const stamp = `${p.month}.${p.day} ${p.hour}:${p.minute}`;
  const all = input.spreadsheet.sheets;
  if (!Array.isArray(all) || new Set(all.map(s => s.properties?.sheetId)).size !== all.length) fail('Missing or duplicate sheet metadata');
  if(!Array.isArray(input.sheetInventory)) fail('Independent full sheet inventory required');
  const expectedIds=input.sheetInventory.filter(s=>!s.hidden).map(s=>s.sheetId).sort((a,b)=>a-b);
  const actualIds=all.filter(s=>!s.properties.hidden).map(s=>s.properties.sheetId).sort((a,b)=>a-b);
  if(JSON.stringify(expectedIds)!==JSON.stringify(actualIds))fail('Visible sheet inventory mismatch');
  const primary = binding.primarySheetIds.map(id => all.find(s => s.properties.sheetId === id));
  if (primary.some(s => !s || s.properties.hidden)) fail('Primary sheet missing or hidden; never guess a replacement ID');
  if (all.some(s => /^오공구독(?:\s|$)/.test(s.properties.title))) fail('Retired 오공구독 tab exists: reconcile data before removing');
  const other = all.filter(s => !s.properties.hidden && !binding.primarySheetIds.includes(s.properties.sheetId)).sort((a,b) => a.properties.index - b.properties.index);
  if (workbook === 'F01' && other.length) fail('Unexpected visible F01 tab');
  const requests = [], changes = [], counts = [], primaryKeys = new Set(), supplierKeys = new Set();
  const add = (sheetId, field, actual, expected, request) => { changes.push({sheetId, field, actual: actual ?? null, expected}); requests.push(request); };
  for (const [order, s] of [...primary, ...other].entries()) {
    const prop = s.properties, id = prop.sheetId, grid = prop.gridProperties;
    const coverage = input.coverage?.find(x => x.sheetId === id);
    if (!coverage || coverage.endRowIndex !== grid.rowCount || coverage.endColumnIndex !== grid.columnCount) fail(`Incomplete read coverage: ${id}`);
    if (s.data?.length !== 1 || (s.data[0].startRow ?? 0) !== 0 || (s.data[0].startColumn ?? 0) !== 0) fail(`One complete A1 grid read required: ${id}`);
    const data = s.data[0], rows = data.rowData ?? [], headers = (rows[0]?.values ?? []).map(value);
    if (rows.length !== grid.rowCount || headers.length !== grid.columnCount || data.columnMetadata?.length !== grid.columnCount) fail('Complete normalized grid/columns required');
    if (headers.filter(h => h === '차량번호').length !== 1) fail(`Vehicle key header missing/ambiguous: ${id}`);
    const ki = headers.indexOf('차량번호'), keys = new Set(); let lastRow = 1;
    for (let ri = 1; ri < rows.length; ri++) {
      const cells = rows[ri].values ?? [];
      if (cells.length > grid.columnCount) fail('Row exceeds grid bounds');
      if (!cells.some(c => value(c) !== '')) continue;
      const key = String(value(cells[ki])).replace(/[\s-]/g, '');
      if (!key || ['미입력','미정','해당없음'].includes(key)) fail(`Missing vehicle key at ${id}:${ri+1}`);
      const groupKeys = order < 4 ? primaryKeys : supplierKeys;
      if (keys.has(key) || groupKeys.has(key)) fail(`Duplicate vehicle key in ${order < 4 ? 'primary' : 'supplier'} group`);
      keys.add(key); groupKeys.add(key); lastRow = ri + 1;
    }
    const main = spec.primaryTabs[order];
    const label = main?.label ?? prop.title.replace(/\s*·?\s*\d+대$/, '').trim();
    if (!label || /\d{2}\.\d{2}|·/.test(label)) fail('Ambiguous supplier tab label');
    const title = order === 0 ? `${stamp} ${label} ${keys.size}대` : `${label} ${keys.size}대`;
    const color = main?.color ?? spec.supplierTabs.color;
    counts.push({sheetId:id,label,count:keys.size});
    const properties = {sheetId:id}; const fields = [];
    // Only the four primary tabs have mandated absolute positions. Preserve
    // supplier/admin interleaving rather than moving unrelated hidden tabs.
    for (const [field,actual,expected] of [['title',prop.title,title],...(order<4?[['index',prop.index,order]]:[])]) if(actual !== expected){ properties[field]=expected;fields.push(field);changes.push({sheetId:id,field,actual,expected}); }
    if (hex(prop.tabColorStyle?.rgbColor ?? prop.tabColor) !== color) {properties.tabColorStyle={rgbColor:rgb(color)};fields.push('tabColorStyle');changes.push({sheetId:id,field:'tabColor',expected:color});}
    if(fields.length) requests.push({updateSheetProperties:{properties,fields:fields.join(',')}});
    if ((grid.frozenRowCount ?? 0) !== 1) add(id,'frozenRowCount',grid.frozenRowCount,1,{updateSheetProperties:{properties:{sheetId:id,gridProperties:{frozenRowCount:1}},fields:'gridProperties.frozenRowCount'}});
    for(let ci=0;ci<headers.length;ci++) {
      const header=headers[ci], width=spec.appearance.columnWidthsPx[header], meta=data.columnMetadata?.[ci];
      if (!meta || !Number.isFinite(meta.pixelSize)) fail(`Column metadata unavailable: ${id}:${ci}`);
      const range={sheetId:id,dimension:'COLUMNS',startIndex:ci,endIndex:ci+1};
      if(width && meta.pixelSize !== width) add(id,`width:${header}`,meta.pixelSize,width,{updateDimensionProperties:{range,properties:{pixelSize:width},fields:'pixelSize'}});
      const months=String(header).match(/^(\d+)\s*개월/);
      if(workbook==='F86' && (header==='단기보증' || (months && Number(months[1])<spec.appearance.F86MinimumVisibleFeeMonths)) && !meta.hiddenByUser) add(id,`hidden:${header}`,false,true,{updateDimensionProperties:{range,properties:{hiddenByUser:true},fields:'hiddenByUser'}});
    }
    const width=headers.reduce((end,h,i)=>h ? i+1 : end,0);
    const wanted={sheetId:id,startRowIndex:0,endRowIndex:lastRow,startColumnIndex:0,endColumnIndex:width};
    const actual=s.basicFilter?.range;
    const covers = actual && actual.sheetId===id && (actual.startRowIndex??0)===0 && (actual.startColumnIndex??0)===0 && actual.endRowIndex>=lastRow && actual.endRowIndex<=grid.rowCount && actual.endColumnIndex>=width && actual.endColumnIndex<=grid.columnCount;
    if (!covers) {
      // Existing filter criteria/sortSpecs are preserved. This changes coverage only.
      add(id,'filterRange',actual,wanted,{setBasicFilter:{filter:{...s.basicFilter,range:wanted}}});
    }
  }
  return {status:requests.length?'CHANGES_REQUIRED':'PASS',specVersion:spec.version,spreadsheetId:binding.spreadsheetId,updatedAt,counts,changes,requests,scope:'PRESENTATION_ONLY_NOT_SOURCE_PARITY'};
}

if(process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    const args=Object.fromEntries(process.argv.slice(2).map(a=>{const i=a.indexOf('=');return [a.slice(0,i),a.slice(i+1)]}));
    if(!args['--input']) fail('Usage: --input=readback.json --workbook=F01 --updated-at=ISO [--verify]');
    const result=planPresentation(JSON.parse(fs.readFileSync(args['--input'],'utf8')),{workbook:args['--workbook'],updatedAt:args['--updated-at']});
    console.log(JSON.stringify(result,null,2));
    if(process.argv.includes('--verify') && result.status!=='PASS')process.exitCode=1;
  } catch(e) { console.error(e.message);process.exitCode=2; }
}
