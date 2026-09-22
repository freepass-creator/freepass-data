import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPresentation, specification as spec } from '../scripts/sheet-presentation.mjs';
const at='2026-09-21T07:28:00Z';
const opts={workbook:'F86',updatedAt:at,now:Date.parse(at)};
const cell=s=>({userEnteredValue:{stringValue:s}});
function fixture(){
  const sheets=spec.workbooks.F86.primarySheetIds.map((id,i)=>({properties:{sheetId:id,title:`legacy-${i}`,index:i,gridProperties:{rowCount:10,columnCount:7,frozenRowCount:1}},data:[{rowData:[{values:['차량번호','차명(원문)','옵션(원문)','단기보증','장기보증','12개월','24개월'].map(cell)},{values:[`TEST-${i}`,'raw-name','raw-options','100','100','100','100'].map(cell)}],columnMetadata:[{pixelSize:80},{pixelSize:80},{pixelSize:80},{pixelSize:80},{pixelSize:80,hiddenByUser:true},{pixelSize:80},{pixelSize:80,hiddenByUser:true}]}]}));
  for(const s of sheets)while(s.data[0].rowData.length<10)s.data[0].rowData.push({values:[]});
  return {capturedAt:at,sheetInventory:sheets.map(s=>s.properties),coverage:sheets.map(s=>({sheetId:s.properties.sheetId,endRowIndex:10,endColumnIndex:7})),spreadsheet:{spreadsheetId:spec.workbooks.F86.spreadsheetId,sheets}};
}
test('all primary tabs, Seoul timestamp and widths; no cell writes or deletions',()=>{
  const result=planPresentation(fixture(),opts);
  assert.equal(result.counts.length,4);
  assert.equal(result.requests.find(r=>r.updateSheetProperties)?.updateSheetProperties.properties.title,'09.21 16:28 상품리스트 1대');
  assert.equal(result.requests.filter(r=>r.updateDimensionProperties?.properties.pixelSize===260).length,4);
  assert.equal(result.requests.filter(r=>r.updateDimensionProperties?.properties.pixelSize===360).length,4);
  assert.equal(result.requests.filter(r=>r.updateDimensionProperties?.properties.hiddenByUser===true).length,8);
  assert.equal(result.requests.filter(r=>r.updateDimensionProperties?.properties.hiddenByUser===false).length,8);
  assert.ok(result.requests.every(r=>['updateSheetProperties','updateDimensionProperties','setBasicFilter'].includes(Object.keys(r)[0])));
});
test('fixed usability widths are reapplied on every matching sales tab',()=>{
 const x=fixture();
 for(const s of x.spreadsheet.sheets){
  s.properties.gridProperties.columnCount=7;
  s.data[0].rowData[0].values=['차량번호','차명(원문)','옵션(원문)','세부트림','반납형보증금','인수형보증금','24개월'].map(cell);
  s.data[0].rowData[1].values=['TEST-'+s.properties.sheetId,'원문차명','원문옵션','긴 세부트림','긴 반납형 규칙','긴 인수형 규칙','100'].map(cell);
  s.data[0].columnMetadata=Array.from({length:7},()=>({pixelSize:80}));
 }
 x.coverage.forEach(c=>c.endColumnIndex=7);
 const result=planPresentation(x,opts);
 assert.equal(result.requests.filter(r=>r.updateDimensionProperties?.properties.pixelSize===260).length,4);
 assert.equal(result.requests.filter(r=>r.updateDimensionProperties?.properties.pixelSize===360).length,4);
 assert.equal(result.requests.filter(r=>r.updateDimensionProperties?.properties.pixelSize===100).length,4);
 const pickup=spec.workbooks.F86.primarySheetIds[2];
 const pickup180=result.requests.filter(r=>r.updateDimensionProperties?.range.sheetId===pickup&&r.updateDimensionProperties?.properties.pixelSize===180);
 assert.equal(pickup180.length,2);
 assert.equal(result.requests.filter(r=>r.updateDimensionProperties?.properties.pixelSize===180).length,2);
});
test('wrong target and stale observations fail closed',()=>{
 const x=fixture();x.spreadsheet.spreadsheetId='wrong';assert.throws(()=>planPresentation(x,opts),/Wrong workbook/);
 assert.throws(()=>planPresentation(fixture(),{...opts,now:opts.now+300001}),/fresh/);
});
test('incomplete coverage and absent column metadata do not invent defaults',()=>{
 const x=fixture();x.coverage[0].endRowIndex=2;assert.throws(()=>planPresentation(x,opts),/coverage/);
 const y=fixture();delete y.spreadsheet.sheets[0].data[0].columnMetadata;assert.throws(()=>planPresentation(y,opts),/Complete normalized/);
});
test('duplicate vehicle across primary tabs and missing key halt entire plan',()=>{
 const x=fixture();x.spreadsheet.sheets[1].data[0].rowData[1].values[0]=cell('TEST-0');assert.throws(()=>planPresentation(x,opts),/Duplicate/);
 const y=fixture();y.spreadsheet.sheets[0].data[0].rowData[1].values[0]=cell('');assert.throws(()=>planPresentation(y,opts),/Missing vehicle/);
});
test('retired tab is a HOLD, never auto-deleted',()=>{
 const x=fixture();x.spreadsheet.sheets.push({properties:{sheetId:123,title:'오공구독 9대',hidden:true}});assert.throws(()=>planPresentation(x,opts),/Retired/);
});
test('hidden or missing primary ID cannot be replaced by a name guess',()=>{
 const x=fixture();x.spreadsheet.sheets[0].properties.hidden=true;assert.throws(()=>planPresentation(x,opts),/Primary/);
});
test('existing filter criteria are preserved when extending range',()=>{
 const x=fixture();x.spreadsheet.sheets[0].basicFilter={range:{sheetId:spec.workbooks.F86.primarySheetIds[0],endRowIndex:1,endColumnIndex:4},criteria:{0:{hiddenValues:['archived']}}};
 const r=planPresentation(x,opts).requests.find(r=>r.setBasicFilter);
 assert.deepEqual(r.setBasicFilter.filter.criteria,{0:{hiddenValues:['archived']}});
 assert.equal(r.setBasicFilter.filter.range.endRowIndex,2);
});
test('same snapshot and timestamp produce identical request bytes',()=>{
 assert.equal(JSON.stringify(planPresentation(fixture(),opts)),JSON.stringify(planPresentation(fixture(),opts)));
});
test('already-compliant native metadata verifies with no writes',()=>{
 const x=fixture();for(const[i,s]of x.spreadsheet.sheets.entries()){
  const p=spec.primaryTabs[i],h=p.color;
  s.properties.title=i===0?'09.21 16:28 상품리스트 1대':`${p.label} 1대`;
  s.properties.tabColorStyle={rgbColor:{red:parseInt(h.slice(1,3),16)/255,green:parseInt(h.slice(3,5),16)/255,blue:parseInt(h.slice(5,7),16)/255}};
  s.data[0].columnMetadata=[{pixelSize:80},{pixelSize:260},{pixelSize:360},{pixelSize:80,hiddenByUser:true},{pixelSize:80,hiddenByUser:false},{pixelSize:80,hiddenByUser:true},{pixelSize:80,hiddenByUser:false}];
  s.basicFilter={range:{sheetId:s.properties.sheetId,startRowIndex:0,endRowIndex:2,startColumnIndex:0,endColumnIndex:7}};
 }
 assert.equal(planPresentation(x,opts).status,'PASS');assert.deepEqual(planPresentation(x,opts).requests,[]);
});
test('truncated data or trailing metadata cannot produce PASS',()=>{
 const x=fixture();x.spreadsheet.sheets[0].data[0].rowData.pop();assert.throws(()=>planPresentation(x,opts),/Complete normalized/);
 const y=fixture();y.spreadsheet.sheets[0].data[0].columnMetadata.pop();assert.throws(()=>planPresentation(y,opts),/Complete normalized/);
});
test('independent inventory detects an omitted supplier tab',()=>{
 const x=fixture();x.sheetInventory.push({sheetId:999,title:'supplier 1대',index:4});assert.throws(()=>planPresentation(x,opts),/inventory mismatch/);
});
test('F01 preserves short-term visibility and uses its own stable IDs',()=>{
 const x=fixture();x.spreadsheet.spreadsheetId=spec.workbooks.F01.spreadsheetId;
 x.spreadsheet.sheets.forEach((s,i)=>{s.properties.sheetId=spec.workbooks.F01.primarySheetIds[i];x.coverage[i].sheetId=s.properties.sheetId;});
 const r=planPresentation(x,{...opts,workbook:'F01'});
 assert.equal(r.counts.length,4);assert.equal(r.requests.filter(r=>r.updateDimensionProperties?.fields==='hiddenByUser').length,0);
});
test('F01 duplicate or stale extra visible catalog tab fails closed',()=>{
 const x=fixture();x.spreadsheet.spreadsheetId=spec.workbooks.F01.spreadsheetId;
 x.spreadsheet.sheets.forEach((s,i)=>{s.properties.sheetId=spec.workbooks.F01.primarySheetIds[i];x.coverage[i].sheetId=s.properties.sheetId;});
 const duplicate=structuredClone(x.spreadsheet.sheets[0]);duplicate.properties={...duplicate.properties,sheetId:999,index:4,title:'상품리스트 09.21 18:13 · 385대'};
 x.spreadsheet.sheets.push(duplicate);x.sheetInventory.push(duplicate.properties);x.coverage.push({sheetId:999,endRowIndex:10,endColumnIndex:4});
 assert.throws(()=>planPresentation(x,{...opts,workbook:'F01'}),/Unexpected visible F01 tab/);
});
test('supplier views may repeat primary keys, preserve gaps and use common gray',()=>{
 const x=fixture(),s=structuredClone(x.spreadsheet.sheets[0]);
 s.properties={...s.properties,sheetId:999,index:7,title:'공급사 · 1대'};
 x.spreadsheet.sheets.push(s);x.sheetInventory.push(s.properties);x.coverage.push({sheetId:999,endRowIndex:10,endColumnIndex:7});
 const r=planPresentation(x,opts);const p=r.requests.find(r=>r.updateSheetProperties?.properties.sheetId===999).updateSheetProperties;
 assert.equal(p.properties.title,'공급사 1대');assert.equal(p.properties.index,undefined);
 assert.ok(p.properties.tabColorStyle);assert.equal(r.counts[4].count,1);
});
