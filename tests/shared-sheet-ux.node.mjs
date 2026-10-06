import test from 'node:test';
import assert from 'node:assert/strict';
import {assertUxRequests,planSharedSheetUx,planHeaderProtection} from '../scripts/shared-sheet-ux.mjs';
import {inputSpec} from '../scripts/supplier-input-sheet.mjs';
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
  metadata.sheets[0].protectedRanges[0].warningOnly=true;
  assert.throws(()=>planHeaderProtection(metadata),/owner drift/);
});
test('locked inventory and headers stop UX changes before requests',()=>{
  const metadata={sheets:[inputSpec.summaryTitle,...inputSpec.changeControl.activeSupplierTabs].map((title,i)=>({properties:{title,sheetId:i,gridProperties:{rowCount:100}}}))};
  assert.throws(()=>planSharedSheetUx(metadata,{sheets:[]}),/header capture/);
  metadata.sheets.pop();assert.throws(()=>planSharedSheetUx(metadata,{sheets:[]}),/inventory drift/);
});
