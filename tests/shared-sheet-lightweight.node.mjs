import test from 'node:test';
import assert from 'node:assert/strict';
import {inputSpec as currentSpec} from '../scripts/supplier-input-sheet.mjs';
import {planLightweightPresentation,planInputWarningCleanup} from '../scripts/shared-sheet-lightweight.mjs';
const inputSpec=structuredClone(currentSpec);delete inputSpec.dropdownPolicy.lightweight.validationChoices;
const fixture=()=>{
  const properties=(sheetId,title,rowCount,hidden=false)=>({sheetId,title,hidden,gridProperties:{rowCount,columnCount:74}});
  const metadata={sheets:[{properties:properties(1,'종합',300)},{properties:properties(2,'스타',600)},{properties:properties(3,'차종목록',942,true)}]};
  const header={values:inputSpec.inputHeaders.map(stringValue=>({userEnteredValue:{stringValue}}))};
  const captures={sheets:metadata.sheets.slice(0,2).map(s=>({properties:s.properties,data:[{rowData:[header,{values:[{userEnteredValue:{stringValue:'unchanged'}}]}]}]}))};
  captures.sheets[1].data.push({startRow:500,rowData:[{values:[{userEnteredValue:{stringValue:'preserve hidden status row'}}]}]});
  return {metadata,captures};
};
test('bounded presentation moves overflow before shrink, preserves filtered rows and adds no formulas',()=>{
  const f=fixture(),before=JSON.stringify(f),p=planLightweightPresentation(f.metadata,f.captures,inputSpec);
  assert.equal(JSON.stringify(f),before);assert.deepEqual(p.moves,[{tab:'스타',from:501,to:3}]);
  const index=p.requests.findIndex(r=>r.copyPaste);assert.ok(index<p.requests.findIndex(r=>r.updateSheetProperties?.properties.sheetId===2));
  assert.equal(p.requests[index+1].updateCells.rows[0].values[0].userEnteredValue.stringValue,'preserve hidden status row');
  const validations=p.requests.filter(r=>r.setDataValidation?.rule).map(r=>r.setDataValidation);
  assert.equal(validations.length,7);assert.ok(validations.every(v=>v.filteredRowsIncluded&&v.range.endRowIndex===100&&v.range.endColumnIndex<=16&&!v.rule.strict));
  assert.ok(validations.filter(v=>v.rule.condition.type==='ONE_OF_RANGE').every(v=>v.rule.condition.values[0].userEnteredValue.endsWith('$942')));
  assert.ok(p.requests.filter(r=>r.addConditionalFormatRule).every(r=>r.addConditionalFormatRule.rule.booleanRule.condition.type==='TEXT_EQ'));
  assert.ok(!p.requests.some(r=>r.addSheet||r.repeatCell));
});
test('shrinking refuses formulas and excessive occupied rows before any execution',()=>{
  const f=fixture();f.captures.sheets[1].data[0].rowData[1].values[0].userEnteredValue={formulaValue:'=A501'};
  assert.throws(()=>planLightweightPresentation(f.metadata,f.captures),/Formula dependency/);
  const g=fixture();g.captures.sheets[1].data[0].rowData.push(...Array.from({length:99},()=>({values:[{userEnteredValue:{numberValue:1}}]})));
  assert.throws(()=>planLightweightPresentation(g.metadata,g.captures,inputSpec),/capacity/);
});

test("existing labels and confirmation placeholder become valid UI choices without promoting master facts",()=>{const f=fixture();const cell=f.captures.sheets[1].data[0].rowData[1];cell.values[5]={userEnteredValue:{stringValue:"확인 필요"},userEnteredFormat:{backgroundColor:{red:1,green:1}}};const master={sheets:[{properties:f.metadata.sheets[2].properties,data:[{rowData:[{values:[{userEnteredValue:{stringValue:"제조사"}}]},{values:[{userEnteredValue:{stringValue:"현대"}},{userEnteredValue:{stringValue:"캐스퍼"}},{userEnteredValue:{stringValue:"캐스퍼 AX1"}},{userEnteredValue:{stringValue:"스마트"}}]}]}]}]};const before=JSON.stringify(f);const p=planInputWarningCleanup(f.metadata,f.captures,master,currentSpec);assert.equal(JSON.stringify(f),before);assert.ok(p.options.제조사.includes("확인 필요"));assert.equal(p.yellowCells,1);assert.ok(p.requests.filter(r=>r.updateCells?.fields==='userEnteredValue').every(r=>r.updateCells.range.sheetId===9400));assert.ok(p.requests.filter(r=>r.repeatCell).every(r=>!r.repeatCell.fields.includes("foreground")));assert.ok(!p.requests.some(r=>r.addConditionalFormatRule));});
