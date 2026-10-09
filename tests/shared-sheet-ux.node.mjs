import test from 'node:test';
import assert from 'node:assert/strict';
import {assertUxRequests,planSharedSheetUx,planHeaderProtection,planFilterRangeRepair,supplierHeaderNote,planSupplierHeaderNotes} from '../scripts/shared-sheet-ux.mjs';
import {inputSpec} from '../scripts/supplier-input-sheet.mjs';
import {planLayoutChange} from '../scripts/supplier-input-sheet.mjs';
import {planLightweightPresentation} from '../scripts/shared-sheet-lightweight.mjs';
test('supplier notes cover every column, put input guidance first and never write values',()=>{
  for(const h of inputSpec.inputHeaders){const note=supplierHeaderNote(h);assert.ok(note.startsWith(inputSpec.uiOwnership.supplierHeaderNotes[h]));assert.ok(!/AI|supplier-input-presentation|정본/.test(note));assert.ok(note.endsWith(inputSpec.uiOwnership.headerNote));}
  assert.throws(()=>supplierHeaderNote('없는 항목'),/guidance missing/);
  const metadata={sheets:[inputSpec.summaryTitle,...inputSpec.changeControl.activeSupplierTabs].map((title,i)=>({properties:{title,sheetId:i}}))};
  const capture={sheets:metadata.sheets.map(s=>({...s,data:[{rowData:[{values:inputSpec.inputHeaders.map(h=>({userEnteredValue:{stringValue:h}}))}]}]}))};
  const requests=planSupplierHeaderNotes(metadata,capture);assert.equal(requests.length,13);
  for(const r of requests){assert.equal(r.updateCells.fields,'note');assert.equal(r.updateCells.start.rowIndex,0);assert.equal(r.updateCells.rows[0].values.length,74);assert.ok(r.updateCells.rows[0].values.every(c=>Object.keys(c).join()==='note'));}
});
test('filter repairs cover full rows and columns, preserve conditions, and refuse re-sort',()=>{
  const metadata={sheets:[inputSpec.summaryTitle,...inputSpec.changeControl.activeSupplierTabs].map((title,i)=>({properties:{title,sheetId:i,gridProperties:{rowCount:100}},basicFilter:{range:{sheetId:i,startRowIndex:0,endRowIndex:100,startColumnIndex:0,endColumnIndex:74}}}))};
  metadata.sheets[0].basicFilter.range.endColumnIndex=62;
  metadata.sheets[0].basicFilter.criteria={'2':{hiddenValues:['출고불가']}};
  const before=JSON.stringify(metadata),r=planFilterRangeRepair(metadata);
  assert.equal(r.length,1);assert.equal(r[0].setBasicFilter.filter.range.endColumnIndex,74);
  assert.deepEqual(r[0].setBasicFilter.filter.criteria,metadata.sheets[0].basicFilter.criteria);
  assert.equal(JSON.stringify(metadata),before);
  metadata.sheets[0].basicFilter.sortSpecs=[{dimensionIndex:2,sortOrder:'ASCENDING'}];
  assert.throws(()=>planFilterRangeRepair(metadata),/preservation review/);
});
test('current user lock blocks historical deletions and shrinking before data access',()=>{
  assert.throws(()=>planLayoutChange({}),/Deletion forbidden/);
  const metadata={sheets:[inputSpec.summaryTitle,...inputSpec.changeControl.activeSupplierTabs].map((title,i)=>({properties:{title,sheetId:i,gridProperties:{rowCount:1000}}})),};
  metadata.sheets.push({properties:{title:inputSpec.vehicleMaster.tab,hidden:true,gridProperties:{rowCount:942}}});
  assert.throws(()=>planLightweightPresentation(metadata,{sheets:[]}),/Deletion forbidden/);
});
test('UI writer rejects input, formula and structural mutation',()=>{
  for(const fields of ['userEnteredValue','userEnteredFormat','userEnteredFormat,note'])assert.throws(()=>assertUxRequests([{updateCells:{start:{rowIndex:0},fields}}]),/HOLD/);
  assert.throws(()=>assertUxRequests([{deleteDimension:{}}]),/HOLD/);
  assert.throws(()=>assertUxRequests([{updateCells:{start:{rowIndex:1},fields:'note'}}]),/HOLD/);
  assert.throws(()=>assertUxRequests([{addConditionalFormatRule:{rule:{ranges:[{startColumnIndex:0,endColumnIndex:74,endRowIndex:1000}],booleanRule:{condition:{type:'CUSTOM_FORMULA'}}}}}]),/HOLD/);
});
test('header ACL is idempotent and refuses owner drift, leaves body open',()=>{
  const metadata={sheets:[inputSpec.summaryTitle,...inputSpec.changeControl.activeSupplierTabs].map((title,i)=>({properties:{title,sheetId:i}}))};
  const plan=planHeaderProtection(metadata);
  assert.equal(plan.length,13);
  for(const [i,r]of plan.entries()){
    assert.equal(r.addProtectedRange.protectedRange.range.endRowIndex,1);
    metadata.sheets[i].protectedRanges=[r.addProtectedRange.protectedRange];
  }
  assert.deepEqual(planHeaderProtection(metadata),[]);
  metadata.sheets[0].protectedRanges[0].warningOnly=!inputSpec.uiOwnership.headerProtection.warningOnly;
  assert.throws(()=>planHeaderProtection(metadata),/owner drift/);
});
test('locked inventory and headers stop UX changes before requests',()=>{
  const metadata={sheets:[inputSpec.summaryTitle,...inputSpec.changeControl.activeSupplierTabs].map((title,i)=>({properties:{title,sheetId:i,gridProperties:{rowCount:100}}}))};
  assert.throws(()=>planSharedSheetUx(metadata,{sheets:[]}),/header capture/);
  metadata.sheets.pop();assert.throws(()=>planSharedSheetUx(metadata,{sheets:[]}),/inventory drift/);
});
