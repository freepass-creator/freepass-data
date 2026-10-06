import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {auditValueFormats,planValueNormalize,auditTabConsistency,planTabConsistencyFix,canonCaptureRequest,canonValueCaptureRequest,planExcludeSupplierTab,mergeCanonCaptures,summaryFormula} from '../scripts/supplier-input-sheet.mjs';
import {planSupplierInput,planSupplierDropdowns,planVehicleMasterDropdowns,planPolicySplit,planLayoutReorder,planColumnAdd,planLayoutChange,splitPolicyValue,planPolicyImport,buildPolicyArchive,compareSharedToLegacy,inputSpec as currentSpec} from '../scripts/supplier-input-sheet.mjs';
// Earlier-policy fixtures keep historical planner coverage; current policy has its own regression below.
const inputSpec=structuredClone(currentSpec);delete inputSpec.dropdownPolicy.lightweight;inputSpec.dropdownPolicy.disabled=false;inputSpec.dropdownPolicy.freeText=inputSpec.inputHeaders.filter((h,i)=>i>=inputSpec.inputHeaders.indexOf('1개월')||(!inputSpec.dropdowns[h]&&!inputSpec.vehicleMaster.columns[h]));delete inputSpec.performancePolicy;
const now=Date.parse('2026-10-03T12:00:00Z');
const legacy=inputSpec.legacyLayouts['2026-10-02'];
const sheet=(id,title,headers,grid={frozenRowCount:1,frozenColumnCount:0})=>({properties:{sheetId:id,title,gridProperties:{rowCount:1000,columnCount:headers.length,...grid}},data:[{rowData:[{values:headers.map(h=>({userEnteredValue:{stringValue:h}}))}]}]});
const shared=inputSpec.supplierChannels.sharedInputSheet;
const tabTitles=[...new Set(shared.map(r=>r.tab))];
const canonFixture=()=>{
  const spec=structuredClone(inputSpec);spec.tabConsistency.headerBackgrounds={};spec.tabConsistency.headerForegrounds={};spec.supplierChannels.sharedInputSheet=[{tab:'가',code:'A'},{tab:'나',code:'B'}];
  const snapshot={sheets:['종합','가','나'].map((title,id)=>({properties:{sheetId:id,title,gridProperties:{rowCount:4,columnCount:spec.inputHeaders.length,frozenRowCount:1}},conditionalFormats:[],data:[{
    columnMetadata:spec.inputHeaders.map(h=>({pixelSize:spec.columnWidths[h]??spec.defaultColumnWidth})),rowMetadata:[{pixelSize:spec.headerRowHeight},...Array.from({length:3},()=>({pixelSize:spec.rowHeight}))],
    rowData:Array.from({length:4},(_,r)=>({values:spec.inputHeaders.map(h=>({...(r===0?{userEnteredValue:{stringValue:h}}:{}),userEnteredFormat:{textFormat:{fontFamily:spec.font.family,fontSize:spec.font.size,italic:spec.font.italic},wrapStrategy:spec.textWrap,horizontalAlignment:r>0&&spec.leftAlignHeaders.includes(h)?'LEFT':r>0&&(spec.rightAlignHeaders??[]).includes(h)?'RIGHT':'CENTER',...(r>0&&['date','integer','decimal','year'].includes(spec.valueFormats[h].kind)?{numberFormat:{type:spec.valueFormats[h].kind==='date'?'DATE':'NUMBER',pattern:spec.valueFormats[h].pattern}}:{})},...(r>0&&id>0&&spec.dropdowns[h]&&!spec.dropdownPolicy.freeText.includes(h)?{dataValidation:{condition:{type:'ONE_OF_LIST',values:spec.dropdowns[h].map(userEnteredValue=>({userEnteredValue}))},strict:false,showCustomUi:true}}:r>0&&id>0&&spec.vehicleMaster.columns[h]?{dataValidation:{condition:{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='차종목록'!${spec.vehicleMaster.columns[h]}2:${spec.vehicleMaster.columns[h]}`}]},strict:false,showCustomUi:true}}:{})}))}))
  }]}))};return {snapshot,spec};
};
const canonPut=(f,tab,row,h,value,extra={})=>Object.assign(f.snapshot.sheets[tab].data[0].rowData[row].values[f.spec.inputHeaders.indexOf(h)],{userEnteredValue:typeof value==='number'?{numberValue:value}:{stringValue:value},...extra});
test('canon full columns: partial capture HOLDs (majority formats need every row); complete capture plans full columns to metadata end',()=>{
  const f=canonFixture();f.snapshot.sheets.forEach((t,i)=>{t.properties.gridProperties.rowCount=i===0?20000:1000;t.data[0].rowData=t.data[0].rowData.slice(0,2);});
  const before=JSON.stringify(f),partial=planTabConsistencyFix(f.snapshot,f.spec);
  assert.equal(partial.status,'HOLD');assert.deepEqual(partial.requests,[]);assert.equal(JSON.stringify(f),before);
  assert.equal(partial.holds.filter(h=>h.reason==='PARTIAL_CAPTURE_MAJORITY_FORMATS').length,f.snapshot.sheets.length);
  assert.ok(auditTabConsistency(f.snapshot,f.spec).holds.some(h=>h.reason==='PARTIAL_GRID_COVERAGE'));
  const g=canonFixture(),p=planTabConsistencyFix(g.snapshot,g.spec);assert.equal(p.status,'PLANNED');
  for(const t of g.snapshot.sheets){
    const id=t.properties.sheetId,end=t.properties.gridProperties.rowCount;
    const requests=p.requests.filter(r=>{const x=Object.values(r)[0];return (x.range?.sheetId??x.properties?.sheetId??x.sheetId??x.rule?.ranges?.[0]?.sheetId)===id;});
    assert.ok(requests.length>=70&&requests.length<=250,`${t.properties.title}: ${requests.length}`);
    for(let col=0;col<g.spec.inputHeaders.length;col++){
      const body=requests.filter(r=>r.repeatCell?.range.startRowIndex===1&&r.repeatCell.range.startColumnIndex<=col&&r.repeatCell.range.endColumnIndex>col);
      assert.equal(body.length,1);assert.equal(body[0].repeatCell.range.endRowIndex,end);
      assert.match(body[0].repeatCell.fields,/userEnteredFormat.horizontalAlignment/);
      if(id!==0){const dropdown=requests.find(r=>r.setDataValidation?.range.startColumnIndex<=col&&r.setDataValidation.range.endColumnIndex>col);assert.equal(dropdown.setDataValidation.range.endRowIndex,end);}
    }
    assert.ok(!requests.some(r=>r.updateCells||r.repeatCell?.fields.includes('userEnteredValue')));
  }
});
test('canon full columns: header-only evidence plans spec fields and holds unknown reference attributes',()=>{
  const f=canonFixture();f.snapshot.sheets.forEach(t=>{t.data[0].rowData=t.data[0].rowData.slice(0,1);delete t.data[0].columnMetadata;delete t.data[0].rowMetadata;});
  // Fail closed: an attribute without a majority withholds every request.
  const p=planTabConsistencyFix(f.snapshot,f.spec);assert.equal(p.status,'HOLD');assert.deepEqual(p.requests,[]);
  assert.ok(p.holds.some(h=>h.reason==='NO_MAJORITY_textFormat.bold'));assert.ok(p.holds.some(h=>h.reason==='PARTIAL_CAPTURE_MAJORITY_FORMATS'));
});
test('canon full columns: supplier lists and four master ranges; no summary validations or value writes',()=>{
  const f=canonFixture(),p=planTabConsistencyFix(f.snapshot,f.spec);
  for(const [h,col] of Object.entries(f.spec.vehicleMaster.columns)){
    const at=f.spec.inputHeaders.indexOf(h),r=p.requests.find(r=>r.setDataValidation?.range.sheetId===1&&r.setDataValidation.range.startColumnIndex===at).setDataValidation;
    assert.deepEqual(r.rule.condition,{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='차종목록'!${col}2:${col}`}]});
  }
  assert.ok(!p.requests.some(r=>r.setDataValidation?.range.sheetId===0||r.updateCells));
});
test('canon full columns: explicit header RGB overrides base ColorStyle without changing body colors',()=>{
  const f=canonFixture(),at=f.spec.inputHeaders.indexOf('1개월');f.spec.tabConsistency.headerBackgrounds={'1개월':'#0891B2'};
  f.snapshot.sheets[1].data[0].rowData[0].values[at].userEnteredFormat.backgroundColorStyle={themeColor:'ACCENT1'};
  const p=planTabConsistencyFix(f.snapshot,f.spec),r=p.requests.find(r=>r.repeatCell?.range.sheetId===0&&r.repeatCell.range.startRowIndex===0&&r.repeatCell.range.startColumnIndex<=at&&r.repeatCell.range.endColumnIndex>at).repeatCell;
  assert.deepEqual(r.cell.userEnteredFormat.backgroundColor,{red:8/255,green:145/255,blue:178/255});assert.equal(r.cell.userEnteredFormat.backgroundColorStyle,undefined);
  assert.match(r.fields,/backgroundColorStyle/);assert.ok(!p.requests.some(r=>r.repeatCell?.range.startRowIndex===1&&r.repeatCell.fields.includes('backgroundColor')));
});
test('canon full columns: hidden, wrong width and external conditional reference fail closed',()=>{
  for(const change of [f=>f.snapshot.sheets[1].properties.hidden=true,f=>f.snapshot.sheets[1].properties.gridProperties.columnCount=76,f=>f.snapshot.sheets[1].conditionalFormats=[{ranges:[{sheetId:2}],booleanRule:{condition:{type:'BOOLEAN'}}}]]){
    const f=canonFixture();change(f);assert.equal(planTabConsistencyFix(f.snapshot,f.spec).requests.length,0);
  }
});
test('canon header colors: API float precision and omitted zero RGB channels compare by 8-bit color',()=>{
  const f=canonFixture(),at=f.spec.inputHeaders.indexOf('1개월');f.spec.tabConsistency.headerBackgrounds={'1개월':'#0891B2'};
  for(const t of f.snapshot.sheets)t.data[0].rowData[0].values[at].userEnteredFormat.backgroundColor={red:0.03137255,green:0.5686275,blue:0.69803923};
  assert.equal(auditTabConsistency(f.snapshot,f.spec).status,'PASS');
  f.spec.tabConsistency.headerBackgrounds['1개월']='#000000';for(const t of f.snapshot.sheets)t.data[0].rowData[0].values[at].userEnteredFormat.backgroundColor={};
  assert.equal(auditTabConsistency(f.snapshot,f.spec).status,'PASS');
});
test('capture requests: all metadata rows including large summary, escaped titles, excluded tab omitted, values separate',()=>{
  const f=canonFixture();f.spec.supplierChannels.sharedInputSheet[0].tab="가'나";f.snapshot.sheets[1].properties.title="가'나";f.snapshot.sheets[0].properties.gridProperties.rowCount=20000;
  f.snapshot.sheets.push({properties:{sheetId:99,title:'마음카',hidden:true,gridProperties:{rowCount:1000,columnCount:inputSpec.inputHeaders.length}}});
  const metadata={spreadsheetId:'private-test',sheets:f.snapshot.sheets.map(({properties})=>({properties})),usedRows:{종합:210,"가'나":60,나:1}},before=JSON.stringify(metadata);
  const r=canonCaptureRequest(f.spec,metadata);assert.deepEqual(r.ranges,["'종합'!A1:BV20000","'가''나'!A1:BV4","'나'!A1:BV4"]);
  for(const field of ['numberFormat','horizontalAlignment','fontFamily','fontSize','bold','italic','backgroundColor','dataValidation','columnMetadata','hiddenByUser','rowMetadata','conditionalFormats','gridProperties'])assert.ok(r.fields.includes(field),field);
  assert.ok(!r.fields.includes('userEnteredValue')&&!r.fields.includes('formattedValue'));
  metadata.usedRows["가'나"]=3;const v=canonValueCaptureRequest(f.spec,metadata);assert.ok(v.ranges.includes("'종합'!A1:BV210"));assert.match(v.fields,/userEnteredValue,formattedValue/);
  metadata.usedRows["가'나"]=60;assert.equal(JSON.stringify(metadata),before);assert.throws(()=>canonValueCaptureRequest(f.spec,metadata),/usedRows/);
  metadata.sheets[1].properties.gridProperties.rowCount=0;assert.throws(()=>canonCaptureRequest(f.spec,metadata),/dimensions/);
});
test('canon: current value formats, full identical tabs PASS and company values ignored',()=>{
  const f=canonFixture();canonPut(f,1,1,'회사명','각 회사');canonPut(f,2,1,'회사명','다른 회사');
  assert.equal(Object.keys(inputSpec.valueFormats).length,inputSpec.inputHeaders.length);assert.equal(auditTabConsistency(f.snapshot,f.spec).status,'PASS');
  assert.equal(auditValueFormats(f.snapshot,f.spec).status,'PASS');assert.ok(planTabConsistencyFix(f.snapshot,f.spec).requests.length>0);
});
test('capture minimal format fields plus separately joined header values can pass full-height audit',()=>{
  const f=canonFixture();
  for(const t of f.snapshot.sheets)for(const row of t.data[0].rowData)for(const cell of row.values){
    delete cell.userEnteredFormat.wrapStrategy;
    cell.userEnteredFormat.textFormat.link={uri:'https://example.test/preserve'};
  }
  assert.equal(auditTabConsistency(f.snapshot,f.spec).status,'PASS');
  const fields=canonCaptureRequest(f.spec,f.snapshot).fields;
  for(const omitted of ['wrapStrategy','verticalAlignment','foregroundColor','textFormat.link','userEnteredValue','effectiveFormat'])assert.ok(!fields.includes(omitted));
  const plan=planTabConsistencyFix(f.snapshot,f.spec);assert.ok(plan.requests.length>0);
  assert.ok(plan.requests.every(r=>!r.repeatCell||!r.repeatCell.fields.includes('link')&&!r.repeatCell.fields.includes('wrapStrategy')));
});
test('canon: exact dates, ages, seats and aliases normalize; ambiguous values and formulas HOLD; immutable',()=>{
  const f=canonFixture();canonPut(f,1,1,'입고일자','2026-10-03');canonPut(f,1,2,'입고일자','2026. 10. 3');canonPut(f,1,3,'입고일자',46298,{userEnteredFormat:{}});
  canonPut(f,1,1,'기본연령','만 26세 이상');canonPut(f,1,1,'최대연령','만 65세 이하');canonPut(f,1,1,'인승','5인승');
  canonPut(f,1,1,'연주행','연 20,000km');canonPut(f,1,1,'면허기간','1년 이상');canonPut(f,1,1,'1개월','900,000');
  canonPut(f,1,2,'기본연령','26');canonPut(f,1,2,'1개월','90만원');canonPut(f,1,2,'최초등록일','2026-02-30');canonPut(f,1,2,'정비','오일 연2회');
  canonPut(f,1,3,'기본연령','',{userEnteredValue:{formulaValue:'="만 26세 이상"'},effectiveValue:{stringValue:'만 26세 이상'}});
  canonPut(f,0,1,'입고일자','2026-10-03');const before=JSON.stringify(f),held=planValueNormalize(f.snapshot,f.spec,now);
  assert.equal(JSON.stringify(f),before);assert.equal(held.columns.find(c=>c.column==='입고일자').normalizable,3);assert.equal(held.holds.length,5);
  // Fail closed: any hold withholds every write.
  assert.equal(held.status,'HOLD');assert.deepEqual(held.requests,[]);assert.ok(held.withheldRequestCount>0);
  for(const [r,h] of [[2,'기본연령'],[2,'1개월'],[2,'최초등록일'],[2,'정비'],[3,'기본연령']])canonPut(f,1,r,h,'');
  const p=planValueNormalize(f.snapshot,f.spec,now);assert.equal(p.status,'PLANNED');assert.equal(p.holds.length,0);assert.equal(p.withheldRequestCount,0);
  assert.ok(p.requests.every(r=>(r.updateCells??r.repeatCell).range.sheetId!==0));
  assert.ok(p.requests.filter(r=>r.updateCells).every(r=>r.updateCells.fields==='userEnteredValue'));
  const dates=p.requests.filter(r=>r.updateCells?.range.startColumnIndex===1).map(r=>r.updateCells.rows[0].values[0].userEnteredValue.numberValue);assert.equal(dates[0],dates[1]);
  assert.ok(p.requests.some(r=>r.repeatCell?.cell.userEnteredFormat.numberFormat.pattern===f.spec.valueFormats['입고일자'].pattern));
});
test('canon: partial grids cannot PASS, malformed layouts cannot generate fixes, private examples redacted',()=>{
  const f=canonFixture();f.snapshot.sheets[1].properties.gridProperties.rowCount=1000;
  canonPut(f,1,1,'차량번호',123);canonPut(f,1,1,'비고',' 12가3456 ');
  const a=auditValueFormats(f.snapshot,f.spec);assert.equal(a.status,'HOLD');assert.ok(!JSON.stringify(a).includes('12가3456'));assert.equal(a.columns.find(c=>c.column==='차량번호').examples[0].value,'[비공개]');
  assert.ok(auditTabConsistency(f.snapshot,f.spec).holds.some(h=>h.reason==='PARTIAL_GRID_COVERAGE'));
  f.snapshot.sheets[1].data[0].rowData[0].values.reverse();assert.equal(planTabConsistencyFix(f.snapshot,f.spec).requests.length,0);assert.throws(()=>planValueNormalize(f.snapshot,f.spec),/LAYOUT_MISMATCH/);
});
test('canon: width, minority format, dropdown, frozen, hidden, header color, row and conditional drift detected; formats-only fixes',()=>{
  const f=canonFixture(),t=f.snapshot.sheets[2],d=t.data[0];t.properties.gridProperties.frozenColumnCount=2;
  d.columnMetadata[0]={pixelSize:12,hiddenByUser:true};d.rowMetadata[1].pixelSize=99;
  d.rowData[2].values[0].userEnteredFormat.textFormat.fontSize=40;d.rowData[0].values[0].userEnteredFormat.backgroundColor={red:1};
  d.rowData[1].values[2].dataValidation.condition.values=[{userEnteredValue:'옛 목록'}];
  t.conditionalFormats=[{ranges:[{sheetId:2,startRowIndex:1,endRowIndex:4}],booleanRule:{condition:{type:'TEXT_EQ',values:[{userEnteredValue:'예'}]},format:{backgroundColor:{red:1}}}}];
  const before=JSON.stringify(f),a=auditTabConsistency(f.snapshot,f.spec),p=planTabConsistencyFix(f.snapshot,f.spec);
  for(const k of ['columnWidth','hidden','font','dropdown','frozenColumnCount','conditionalFormats','headerColor','rowHeight'])assert.ok(a.counts[k]>0,k);
  assert.equal(JSON.stringify(f),before);assert.ok(p.requests.some(r=>r.deleteConditionalFormatRule));
  assert.ok(p.requests.every(r=>!r.updateCells&&!r.repeatCell?.fields.includes('userEnteredValue')));
});
test('canon: conditional formats rebase own ranges and summary input validation is exempt',()=>{
  const f=canonFixture();f.snapshot.sheets[1].conditionalFormats=[{ranges:[{sheetId:1,startRowIndex:1,endRowIndex:4}],booleanRule:{condition:{type:'TEXT_EQ',values:[{userEnteredValue:'예'}]},format:{backgroundColor:{red:1}}}}];
  f.snapshot.sheets[0].data[0].rowData[1].values[2].dataValidation={condition:{type:'BOOLEAN'}};
  const p=planTabConsistencyFix(f.snapshot,f.spec);assert.equal(p.requests.filter(r=>r.addConditionalFormatRule).length,2);
  assert.ok(!p.requests.some(r=>r.setDataValidation?.range.sheetId===0));assert.equal(p.requests.find(r=>r.addConditionalFormatRule).addConditionalFormatRule.rule.ranges[0].sheetId,0);
});
test('canon: CLI reports nonzero for differences and accepts stdin without network',()=>{
  const f=fixture();const r=spawnSync(process.execPath,['scripts/supplier-input-sheet.mjs','--check-canon=-'],{input:JSON.stringify(f.spreadsheet),encoding:'utf8',maxBuffer:20*1024*1024});
  assert.equal(r.status,1,r.stderr);assert.ok(JSON.parse(r.stdout).tabs.holds.length>0);
});
test('annual mileage: representative 2만km decision is persistent and idempotent',()=>{
  const f=canonFixture();
  canonPut(f,1,1,'연주행','연 20,000km');
  canonPut(f,1,2,'연주행','2만km');
  canonPut(f,1,3,'연주행','협의');
  const p=planValueNormalize(f.snapshot,f.spec,now),at=f.spec.inputHeaders.indexOf('연주행');
  const changes=p.requests.filter(r=>r.updateCells?.range.startColumnIndex===at);
  assert.equal(changes.length,1);
  assert.equal(changes[0].updateCells.rows[0].values[0].userEnteredValue.stringValue,'2만km');
  assert.equal(changes[0].updateCells.fields,'userEnteredValue');
  canonPut(f,1,1,'연주행','2만km');
  assert.ok(!planValueNormalize(f.snapshot,f.spec,now).requests.some(r=>r.updateCells?.range.startColumnIndex===at));
});
test('canon: normalization preserves cell notes and links; second plan is empty after readback',()=>{
  const f=canonFixture();canonPut(f,1,1,'입고일자','2026. 10. 3',{note:'원문 보존'});canonPut(f,1,1,'기본연령','만 26세 이상');
  const p=planValueNormalize(f.snapshot,f.spec,now);
  for(const request of p.requests){const x=request.updateCells??request.repeatCell,t=f.snapshot.sheets.find(s=>s.properties.sheetId===x.range.sheetId),c=t.data[0].rowData[x.range.startRowIndex].values[x.range.startColumnIndex];
    if(request.updateCells)c.userEnteredValue=structuredClone(x.rows[0].values[0].userEnteredValue);else c.userEnteredFormat.numberFormat=structuredClone(x.cell.userEnteredFormat.numberFormat);
  }
  assert.equal(f.snapshot.sheets[1].data[0].rowData[1].values[1].note,'원문 보존');assert.deepEqual(planValueNormalize(f.snapshot,f.spec,now).requests,[]);
});
test('canon: no majority, missing metadata and unread summary formulas cannot PASS',()=>{
  const f=canonFixture(),d=f.snapshot.sheets[1].data[0];d.rowData[1].values[0].userEnteredFormat.textFormat.bold=true;d.rowData[2].values[0].userEnteredFormat.textFormat.bold=false;
  assert.ok(auditTabConsistency(f.snapshot,f.spec).holds.some(h=>h.reason==='NO_MAJORITY_textFormat.bold'));
  delete d.rowMetadata;assert.ok(auditTabConsistency(f.snapshot,f.spec).holds.some(h=>h.reason==='MISSING_ROW_METADATA'));
  canonPut(f,0,1,'회사명','',{userEnteredValue:{formulaValue:'=VSTACK(A1)'}});assert.ok(auditValueFormats(f.snapshot,f.spec).holds.some(h=>h.reason==='SUMMARY_EFFECTIVE_VALUES_MISSING'));
});
test('canon: tab fix requests converge to PASS without changing values, formulas, notes or links',()=>{
  const f=canonFixture(),t=f.snapshot.sheets[2],d=t.data[0];
  canonPut(f,2,1,'차량번호','가짜 원문',{note:'유지'});d.rowData[1].values[4].userEnteredFormat.textFormat.link={uri:'https://example.test/photo'};
  canonPut(f,0,1,'회사명','',{userEnteredValue:{formulaValue:'=TEST()'},effectiveValue:{stringValue:'가'}});
  t.properties.gridProperties.frozenColumnCount=3;d.columnMetadata[4]={pixelSize:1,hiddenByUser:true};d.rowMetadata[2].pixelSize=1;
  d.rowData[2].values[4].userEnteredFormat.horizontalAlignment='LEFT';d.rowData[1].values[2].dataValidation={condition:{type:'BOOLEAN'}};
  t.conditionalFormats=[{ranges:[{sheetId:2}],booleanRule:{condition:{type:'BOOLEAN'},format:{backgroundColor:{red:1}}}}];
  const before=f.snapshot.sheets.map(s=>s.data[0].rowData.map(r=>r.values.map(c=>({value:c.userEnteredValue,note:c.note,link:c.userEnteredFormat?.textFormat?.link}))));
  for(const request of planTabConsistencyFix(f.snapshot,f.spec).requests){
    const x=Object.values(request)[0],id=x.range?.sheetId??x.properties?.sheetId??x.sheetId??x.rule?.ranges[0].sheetId,s=f.snapshot.sheets.find(s=>s.properties.sheetId===id),data=s.data[0];
    if(request.updateDimensionProperties){const list=x.range.dimension==='ROWS'?data.rowMetadata:data.columnMetadata;for(let i=x.range.startIndex;i<x.range.endIndex;i++)Object.assign(list[i],x.properties);}
    else if(request.updateSheetProperties)Object.assign(s.properties.gridProperties,x.properties.gridProperties);
    else if(request.deleteConditionalFormatRule)s.conditionalFormats.splice(x.index,1);
    else if(request.addConditionalFormatRule)s.conditionalFormats.splice(x.index,0,structuredClone(x.rule));
    else for(let r=x.range.startRowIndex;r<x.range.endRowIndex;r++)for(let c=x.range.startColumnIndex;c<x.range.endColumnIndex;c++){
      const cell=data.rowData[r].values[c];if(request.setDataValidation){if(x.rule)cell.dataValidation=structuredClone(x.rule);else delete cell.dataValidation;}
      else for(const mask of x.fields.split(',')){const path=mask.split('.');let dest=cell,source=x.cell;for(const k of path.slice(0,-1)){dest=dest[k]??= {};source=source?.[k];}const k=path.at(-1);if(source?.[k]===undefined)delete dest[k];else dest[k]=structuredClone(source[k]);}
    }
  }
  assert.equal(auditTabConsistency(f.snapshot,f.spec).status,'PASS');assert.ok(planTabConsistencyFix(f.snapshot,f.spec).requests.length>0);
  assert.deepEqual(f.snapshot.sheets.map(s=>s.data[0].rowData.map(r=>r.values.map(c=>({value:c.userEnteredValue,note:c.note,link:c.userEnteredFormat?.textFormat?.link})))),before);
});
const masterFixture=()=>({...fixture(),master:{source:inputSpec.vehicleMaster.source,readAt:new Date(now).toISOString(),header:['원산지','제조사','모델','세부모델','세부트림','생산시작','생산종료','클로드 엔카대조'],rows:[['국산','현대','캐스퍼','더 뉴 캐스퍼','스마트'],['국산','현대','캐스퍼','캐스퍼','터보'],['국산','기아','레이','','스마트'],['','','',null,'  ']]}});
const withMasterTab=f=>{const s=sheet(9100,'차종목록',['old'],{rowCount:20,columnCount:4});s.properties.hidden=true;f.spreadsheet.sheets.push(s);f.sheetInventory.push({sheetId:9100});return f;};
test('vehicle master: immutable input, unique ordered lists, only list-tab values and supplier range validations',()=>{
  const f=masterFixture(),before=JSON.stringify(f),specBefore=JSON.stringify(inputSpec),p=planVehicleMasterDropdowns(f,inputSpec,now);
  assert.equal(JSON.stringify(f),before);assert.equal(JSON.stringify(inputSpec),specBefore);
  assert.equal(p.status,'PLANNED');assert.equal(p.scope,'VEHICLE_MASTER_RANGE_DROPDOWNS');
  assert.deepEqual(p.counts,{제조사:2,모델:2,세부모델:2,세부트림:2});
  assert.ok(p.requests.every(r=>Object.keys(r).length===1&&['addSheet','updateCells','setDataValidation'].includes(Object.keys(r)[0])));
  assert.deepEqual(p.requests[0],{addSheet:{properties:{sheetId:9100,title:'차종목록',hidden:true,gridProperties:{rowCount:3,columnCount:4}}}});
  const writes=p.requests.filter(r=>r.updateCells).map(r=>r.updateCells);assert.equal(writes.length,1);
  assert.ok(writes.every(w=>(w.start??w.range).sheetId===9100&&w.fields==='userEnteredValue'));
  assert.deepEqual(writes[0].rows.map(r=>r.values.map(c=>c.userEnteredValue?.stringValue)),[['제조사','모델','세부모델','세부트림'],['현대','캐스퍼','더 뉴 캐스퍼','스마트'],['기아','레이','캐스퍼','터보']]);
  const validations=p.requests.filter(r=>r.setDataValidation).map(r=>r.setDataValidation);assert.equal(validations.length,15*4);
  for(const v of validations){const h=inputSpec.inputHeaders[v.range.startColumnIndex],col=inputSpec.vehicleMaster.columns[h];
    assert.ok(f.binding.suppliers.some(s=>s.sheetId===v.range.sheetId));assert.equal(v.range.startRowIndex,1);assert.equal(v.range.endRowIndex,1000);assert.equal(v.range.endColumnIndex,v.range.startColumnIndex+1);
    assert.deepEqual(v.rule,{condition:{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='차종목록'!$${col}$2:$${col}$${p.counts[h]+1}`}]},strict:false,showCustomUi:true});}
});
test('vehicle master: existing tab clears all A:D before refill, no addSheet, unequal list lengths and strict option',()=>{
  const f=withMasterTab(masterFixture());f.master.rows.push(['국산','현대','캐스퍼','캐스퍼','추가']);const p=planVehicleMasterDropdowns(f,{...inputSpec,dropdownStrict:true},now);
  assert.ok(!p.requests.some(r=>r.addSheet));assert.deepEqual(p.requests[0],{updateCells:{range:{sheetId:9100,startColumnIndex:0,endColumnIndex:4},fields:'userEnteredValue'}});
  assert.ok(p.requests.filter(r=>r.updateCells).every(r=>(r.updateCells.start??r.updateCells.range).sheetId===9100));
  assert.deepEqual(p.requests[1].updateCells.rows.at(-1).values,[{},{},{},{userEnteredValue:{stringValue:'추가'}}]);
  for(const {setDataValidation:v} of p.requests.filter(r=>r.setDataValidation)){const h=inputSpec.inputHeaders[v.range.startColumnIndex],c=inputSpec.vehicleMaster.columns[h];assert.equal(v.rule.condition.values[0].userEnteredValue,`='차종목록'!$${c}$2:$${c}$${p.counts[h]+1}`);assert.equal(v.rule.strict,true);}
});
test('vehicle master: rows marked 통합→ in the F03 compare column stay out of every list; missing compare column HOLDs',()=>{
  const f=masterFixture(),at=f.master.header.indexOf('클로드 엔카대조');f.master.rows.push(['국산','기아','셀토스','셀토스 SP2','중복트림',null,null,'통합→셀토스']);
  const r=['국산','기아','셀토스','더 뉴 셀토스','정상'];r[at]='일치';f.master.rows.push(r);
  const p=planVehicleMasterDropdowns(f,inputSpec,now),list=p.requests.find(q=>q.updateCells?.rows).updateCells.rows.flatMap(x=>x.values.map(c=>c.userEnteredValue?.stringValue));
  assert.ok(!list.includes('셀토스 SP2')&&!list.includes('중복트림'));assert.ok(list.includes('더 뉴 셀토스')&&list.includes('정상'));
  const g=masterFixture();g.master.header[g.master.header.indexOf('클로드 엔카대조')]='other';assert.throws(()=>planVehicleMasterDropdowns(g,inputSpec,now),/HOLD/);
});
test('vehicle master: missing columns, empty lists, malformed provenance/rows and tab collisions HOLD',()=>{
  for(const h of Object.keys(inputSpec.vehicleMaster.columns)){
    const f=masterFixture();f.master.header[f.master.header.indexOf(h)]='missing';assert.throws(()=>planVehicleMasterDropdowns(f,inputSpec,now),/HOLD/);
    const empty=masterFixture();empty.master.rows.forEach(r=>r[empty.master.header.indexOf(h)]='');assert.throws(()=>planVehicleMasterDropdowns(empty,inputSpec,now),/HOLD/);
  }
  for(const mutate of [f=>delete f.master,f=>f.master.source='other',f=>f.master.readAt='bad',f=>f.master.rows=[null],f=>f.master.rows[0][1]=12,f=>f.master.header.push('모델'),f=>withMasterTab(f).spreadsheet.sheets.at(-1).properties.title='other',f=>withMasterTab(f).spreadsheet.sheets.at(-1).properties.hidden=false,f=>withMasterTab(f).spreadsheet.sheets.at(-1).properties.gridProperties.rowCount=2,f=>withMasterTab(f).spreadsheet.sheets.at(-1).properties.sheetId=9101]){const f=masterFixture();mutate(f);assert.throws(()=>planVehicleMasterDropdowns(f,inputSpec,now),/HOLD/);}
});
test('vehicle master: original layout, freshness and inventory gates run first',()=>{
  const f=masterFixture();f.spreadsheet.sheets[2].data[0].rowData[0].values.reverse();delete f.master;assert.throws(()=>planVehicleMasterDropdowns(f,inputSpec,now),/LAYOUT_MISMATCH/);
  for(const mutate of [f=>f.capturedAt='2000-01-01',f=>f.sheetInventory.pop()]){const f=masterFixture();mutate(f);assert.throws(()=>planVehicleMasterDropdowns(f,inputSpec,now),/HOLD/);}
});
test('vehicle master CLI: latest disabled policy refuses regeneration',()=>{
  const f=masterFixture();f.capturedAt=new Date().toISOString();f.master.source=inputSpec.vehicleMaster.source.split(' / 탭 ')[0];
  const r=spawnSync(process.execPath,['scripts/supplier-input-sheet.mjs','--vehicle-master=-','--change-layout=unused'],{input:JSON.stringify(f),encoding:'utf8'});
  assert.equal(r.status,2);assert.match(r.stderr,/disabled/);assert.equal(r.stdout,'');
});
const fixture=()=>({capturedAt:new Date(now).toISOString(),binding:{spreadsheetId:'test',summarySheetId:1,guideSheetId:2,suppliers:shared.map((r,i)=>({sheetId:3+tabTitles.indexOf(r.tab),title:r.tab,code:r.code}))},sheetInventory:[1,2,...tabTitles.map((_,i)=>3+i)].map(sheetId=>({sheetId})),spreadsheet:{spreadsheetId:'test',sheets:[sheet(1,'종합',inputSpec.summaryHeaders),sheet(2,'관리안내',['안내']),...tabTitles.map((title,i)=>sheet(3+i,title,inputSpec.inputHeaders))]}});
const policyFixture=()=>{const f=fixture(),d=sheet(3,'웰릭스',legacy.inputHeaders);const h=legacy.inputHeaders,values=h.map(()=>({}));values[h.indexOf('차량번호')]={userEnteredValue:{stringValue:'TEST-1'}};values[h.indexOf('정책코드')]={userEnteredValue:{stringValue:'POL-01'}};d.data[0].rowData.push({values});return {runId:'test-run',capturedAt:f.capturedAt,suppliers:[{sheetId:3,sourceId:'source',sourceTab:'policy'}],destinations:[d],captures:[{sourceId:'source',sourceTab:'policy',complete:true,rows:[{values:['정책코드','추가주행 금액','정비'].map(stringValue=>({userEnteredValue:{stringValue}}))},{values:['POL-01','대여료의 10%','연2회오일'].map(stringValue=>({userEnteredValue:{stringValue}}))}]}]};};

test('2026-10-04-no-account layout: 영업자 보기 — 어떤 차인지 → 대여료 → 부가 정보, then 40 one-fact policy columns',()=>{
  assert.equal(inputSpec.layoutVersion,'2026-10-04-no-account');
  const v=inputSpec.vehicleHeaders;assert.equal(v.length,34);assert.equal(inputSpec.policyHeaders.length,40);
  assert.deepEqual(v.slice(0,15),['회사명','입고일자','차량상태','상품구분','차량번호','제조사','모델','세부모델','세부트림','외부색상','내부색상','연식','주행거리','배기량','연료']);
  assert.deepEqual(v.slice(15,24),['단기보증','1개월','6개월','12개월','장기보증','24개월','36개월','48개월','60개월']);
  assert.deepEqual(v.slice(24),['차명 원문','옵션 원문','차량가격','인승','차종크기','차종구분','구동방식','배터리용량','원산지','최초등록일']);
  for(const gone of ['배차상태','사진링크','기타기간①','기타기간②','기타기간③','정책코드','점검사항'])assert.ok(!inputSpec.inputHeaders.includes(gone),gone);
  assert.deepEqual(inputSpec.inputHeaders,[...v,...inputSpec.policyHeaders]);assert.deepEqual(inputSpec.summaryHeaders,inputSpec.inputHeaders);assert.equal(new Set(inputSpec.inputHeaders).size,inputSpec.inputHeaders.length);
  assert.equal(inputSpec.policyHeaders[0],'예외사항');assert.ok(!inputSpec.policyHeaders.includes('계좌번호'));for(const h of inputSpec.policyHeaders)assert.ok(!h.includes('/')||h==='선불/후불',h);
  assert.equal(inputSpec.frozenRowCount,1);assert.equal(inputSpec.frozenColumnCount,0);assert.equal(inputSpec.vehicleMaster.columns['모델'],'B');
  assert.equal(inputSpec.legacyLayouts['2026-10-03-spec'].inputHeaders.length,80);
});
test('matching sheet verifies with zero write requests and leaves input untouched',()=>{const f=fixture(),before=JSON.stringify(f),r=planSupplierInput(f,inputSpec,now);assert.equal(JSON.stringify(f),before);assert.equal(r.status,'LAYOUT_VERIFIED');assert.deepEqual(r.requests,[]);assert.match(r.scope,/VERIFY_ONLY/);});
test('any header difference is LAYOUT_MISMATCH HOLD — old 2026-10-02 layout, reorder, missing, extra',()=>{
  const cases=[f=>{f.spreadsheet.sheets[2]=sheet(3,'웰릭스',legacy.inputHeaders);},f=>{f.spreadsheet.sheets[0]=sheet(1,'종합',legacy.summaryHeaders);},f=>{f.spreadsheet.sheets[2].data[0].rowData[0].values.reverse();},f=>{f.spreadsheet.sheets[2].data[0].rowData[0].values.pop();},f=>{f.spreadsheet.sheets[2].data[0].rowData[0].values.push({userEnteredValue:{stringValue:'정책코드'}});},f=>{f.spreadsheet.sheets[2].data[0].rowData[0].values[0].userEnteredValue.stringValue='';}];
  for(const mutate of cases){const f=fixture();mutate(f);assert.throws(()=>planSupplierInput(f,inputSpec,now),e=>/HOLD: LAYOUT_MISMATCH/.test(e.message)&&e.mismatched.length===1);}
});
test('extra trailing header cells and hidden bound tabs are HOLD; hidden unbound archive tabs are ignored',()=>{const a=fixture();a.spreadsheet.sheets[2].data[0].rowData[0].values.push({});assert.throws(()=>planSupplierInput(a,inputSpec,now),/LAYOUT_MISMATCH/);for(const id of [0,2]){const f=fixture();f.spreadsheet.sheets[id].properties.hidden=true;assert.throws(()=>planSupplierInput(f,inputSpec,now),e=>/LAYOUT_MISMATCH/.test(e.message)&&e.mismatched[0].hidden===true);}const f=fixture();f.spreadsheet.sheets.push({...sheet(9000,'정책원문',['runId']),properties:{sheetId:9000,title:'정책원문',hidden:true,gridProperties:{rowCount:10,columnCount:1}}});f.sheetInventory.push({sheetId:9000});assert.equal(planSupplierInput(f,inputSpec,now).status,'LAYOUT_VERIFIED');});
const withExcluded=(bound=true)=>{
  const f=fixture();f.spreadsheet.sheets.push(sheet(999,'마음카',inputSpec.inputHeaders));f.sheetInventory.push({sheetId:999});
  if(bound)f.binding.suppliers.push({sheetId:999,title:'마음카',code:'RP034'});
  return f;
};
test('exclude RP034: exact two requests, 15-tab formula, only A2 value changes, archive preserves input',()=>{
  const f=withExcluded(),before=JSON.stringify(f),p=planExcludeSupplierTab(f,inputSpec,now);
  assert.equal(JSON.stringify(f),before);assert.equal(p.supplierCount,18);assert.equal(p.requests.length,2);
  const cell=p.requests[0].updateCells;assert.deepEqual(cell.start,{sheetId:f.binding.summarySheetId,rowIndex:1,columnIndex:0});assert.equal(cell.rows.length,1);assert.equal(cell.rows[0].values.length,1);assert.equal(cell.fields,'userEnteredValue');
  const formula=cell.rows[0].values[0].userEnteredValue.formulaValue;assert.ok(!formula.includes('마음카'));assert.equal((formula.match(/IF\(ISBLANK/g)??[]).length,15);
  assert.equal(p.tabCount,15);
  for(const s of shared)assert.ok(formula.includes(`'${s.tab}'!A2:BV1000`));
  assert.deepEqual(p.requests[1],{updateSheetProperties:{properties:{sheetId:999,hidden:true},fields:'hidden'}});
  f.binding.suppliers.pop();f.spreadsheet.sheets.at(-1).properties.hidden=true;
  assert.equal(planSupplierInput(f,inputSpec,now).status,'LAYOUT_VERIFIED');
  assert.ok(!planSupplierDropdowns(f,inputSpec,now).requests.some(r=>r.setDataValidation.range.sheetId===999));
  assert.equal(auditTabConsistency(f.spreadsheet).coverage.length,16);
  assert.ok(!planTabConsistencyFix(f.spreadsheet,inputSpec).coverage.some(t=>t.tab==='마음카'));
});
test('exclude RP034: reuse freshness, binding, inventory, layout and hidden-archive gates',()=>{
  assert.throws(()=>planSupplierInput(withExcluded(),inputSpec,now),/excluded/);
  assert.throws(()=>planSupplierInput(withExcluded(false),inputSpec,now),/Unbound visible/);
  for(const change of [f=>f.capturedAt='2020-01-01',f=>f.sheetInventory.pop(),f=>f.binding.suppliers.at(-1).code='RP013',f=>f.spreadsheet.sheets[2].data[0].rowData[0].values.reverse(),f=>f.binding.summarySheetId=999,f=>f.spreadsheet.sheets.pop()]){
    const f=withExcluded();change(f);assert.throws(()=>planExcludeSupplierTab(f,inputSpec,now),/HOLD/);
  }
  assert.equal(planExcludeSupplierTab(withExcluded(false),inputSpec,now).requests.length,2);
});
test('exclude RP034: compare omits archive evidence and never reports it as notCompared',()=>{
  const f=compareFixture();f.legacy.push({code:'RP034',capturedAt:'2000-01-01'});f.shared.tabs.push({title:'마음카',headers:[],rows:[]});
  const r=compareSharedToLegacy(f,inputSpec,now);assert.ok(!r.notCompared.includes('마음카'));assert.ok(!r.unboundLegacy.includes('RP034'));assert.ok(!r.results.some(x=>x.code==='RP034'));
});
test('frozen rows/columns drift is reported, never written',()=>{const f=fixture();f.spreadsheet.sheets[2].properties.gridProperties.frozenColumnCount=2;const r=planSupplierInput(f,inputSpec,now);assert.equal(r.status,'LAYOUT_VERIFIED_WITH_PRESENTATION_DRIFT');assert.deepEqual(r.drift.map(d=>[d.sheetId,d.frozenColumnCount]),[[3,2]]);assert.deepEqual(r.requests,[]);});
test('fail closed binding freshness inventory duplicate and production workbook',()=>{for(const mutate of [f=>f.binding.spreadsheetId='other',f=>f.capturedAt='2026-09-01',f=>f.sheetInventory.pop(),f=>f.binding.suppliers.push({...f.binding.suppliers[0]}),f=>{f.spreadsheet.sheets.push(sheet(9001,'숨김아님',['x']));f.sheetInventory.push({sheetId:9001});}]){const f=fixture();mutate(f);assert.throws(()=>planSupplierInput(f,inputSpec,now),/HOLD/);}});
test('channel split: 18 shared-sheet suppliers, 6 direct/own-sheet/not-connected suppliers, no overlap; binding must match exactly',()=>{const c=inputSpec.supplierChannels,codes=c.sharedInputSheet.map(r=>r.code),outside=c.notInSharedSheet.map(r=>r.code);assert.equal(codes.length,18);assert.equal(new Set(codes).size,18);assert.equal(new Set(c.sharedInputSheet.map(r=>r.tab)).size,15);assert.deepEqual(outside.sort(),['RP004','RP006','RP012','RP023','RP031','RP035']);assert.equal(new Set([...codes,...outside,...(c.excludedFromSharedSheet??[]).map(r=>r.code)]).size,codes.length+outside.length+(c.excludedFromSharedSheet??[]).length);assert.ok(outside.every(o=>!codes.includes(o)));assert.ok(codes.includes('RP013'));assert.match(c.membershipRule,/아이카/);assert.throws(()=>compareSharedToLegacy({...compareFixture(),binding:{suppliers:[{title:'아이카',code:'RP004'}]}},inputSpec,now),/excluded from the shared sheet/);
  for(const mutate of [f=>{f.binding.suppliers[0].code='RP031';},f=>{f.binding.suppliers[0].title='이안카';},f=>{f.binding.suppliers[0].code='RP020';f.binding.suppliers[1].code='RP013';},f=>{f.binding.suppliers.pop();f.spreadsheet.sheets.pop();f.sheetInventory.pop();},f=>{f.spreadsheet.sheets[2].properties.title='이안카';},f=>{f.binding.suppliers[0]={...f.binding.suppliers[0],title:'아이카',code:'RP004'};f.spreadsheet.sheets[2].properties.title='아이카';}]){const f=fixture();mutate(f);assert.throws(()=>planSupplierInput(f,inputSpec,now),/HOLD/);}
  const r=compareSharedToLegacy(compareFixture(),inputSpec,now);assert.equal(r.notCompared.length,14);});
test('planner refuses a spec that is not verify-only',()=>{assert.throws(()=>planSupplierInput(fixture(),{...inputSpec,plannerMode:'WRITE'},now),/VERIFY_ONLY/);});
test('manual authority is explicit and automatic source refresh stays disabled',()=>{assert.equal(inputSpec.managementMode,'MANUAL_DIRECT_GOOGLE_SHEETS');assert.equal(inputSpec.manualAuthority,'VISIBLE_SUPPLIER_TABS');assert.equal(inputSpec.automaticSourceRefresh,false);});
test('policy import refuses the current layout because it has no 정책코드',()=>{const f=policyFixture();f.destinations=[sheet(3,'웰릭스',inputSpec.inputHeaders)];assert.throws(()=>planPolicyImport(f,now),/2026-10-02 layout only/);});
test('compact policy retains money units, zero, one-sided bounds and repair percent basis',()=>{for(const [low,high,expected]of [['50만원','100만원','50~100만원'],['50만원','50만원','50만원'],['50만원','','최소 50만원'],['','100만원','최대 100만원'],['50만원','1억원','50만원~1억원'],[0,0,'0']]){const f=policyFixture(),src=f.captures[0].rows;const names=['대인보상한도','대인면책금','자차보상한도','자차수리비율','자차최소면책금','자차최대면책금'];src[0].values.push(...names.map(stringValue=>({userEnteredValue:{stringValue}})));src[1].values.push(...['무한',0,'차량가액','20%',low,high].map(v=>({userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:v}})));const p=planPolicyImport(f,now);assert.equal(p.writes.find(w=>w.header==='대인').value.stringValue,'무한 / 0');const car=p.writes.find(w=>w.header==='자차');assert.equal(car.value.stringValue,'차량가액 / 수리비 20% / '+expected);assert.match(car.fullDescription,/자차수리비율: 20%/);}});
test('compact rewrite requires exact import ownership and old presentation; repeat is idempotent',()=>{for(const variant of ['owned','edited','unowned']){const f=policyFixture(),src=f.captures[0].rows;src[0].values.push(...['대인보상한도','대인면책금'].map(stringValue=>({userEnteredValue:{stringValue}})));src[1].values.push(...['무한','50만원'].map(stringValue=>({userEnteredValue:{stringValue}})));const ci=legacy.inputHeaders.indexOf('대인'),cells=f.destinations[0].data[0].rowData[1].values;cells[ci]={userEnteredValue:{stringValue:'대인보상한도: 무한\n대인면책금: '+(variant==='edited'?'60만원':'50만원')},note:'원문 정책 이관 / '+(variant==='unowned'?'other':'original')+' / policy 2행 / POL-01 / 원천 단위 그대로'};f.rewriteImportedPolicyPresentation={runId:'original'};const p=planPolicyImport(f,now),w=p.writes.find(w=>w.header==='대인');if(variant==='owned'){assert.equal(w.value.stringValue,'무한 / 50만원');assert.ok(w.previous.note.includes('original'));for(const write of p.writes)cells[write.column]={userEnteredValue:write.value,note:write.previous?.note??'import'};assert.equal(planPolicyImport(f,now).writes.length,0);}else{assert.equal(w,undefined);assert.ok(p.holds.some(h=>h.reason==='POLICY_PRESENTATION_NOT_OWNED_OR_CHANGED'));}}});
test('policy exact binding, zero/formula preservation and original rate text',()=>{const f=policyFixture(),col=legacy.inputHeaders.indexOf('정비');f.destinations[0].data[0].rowData[1].values[col]={userEnteredValue:{formulaValue:'=""'},effectiveValue:{stringValue:''}};const p=planPolicyImport(f,now);assert.equal(p.writes.length,1);assert.equal(p.writes[0].value.stringValue,'대여료의 10%');assert.equal(p.writes[0].source.runId,'test-run');assert.equal(p.outcomes[0].status,'MATCHED');});
test('unreadable source fails; blank/ambiguous/numeric codes hold without generic fallback',()=>{const broken=policyFixture();broken.captures[0].complete=false;assert.throws(()=>planPolicyImport(broken,now),/HOLD/);for(const kind of ['blank','duplicate','numeric']){const f=policyFixture();if(kind==='duplicate')f.captures[0].rows.push(f.captures[0].rows[1]);else f.destinations[0].data[0].rowData[1].values[legacy.inputHeaders.indexOf('정책코드')]={userEnteredValue:kind==='numeric'?{numberValue:12}:{stringValue:''}};const p=planPolicyImport(f,now);assert.equal(p.writes.length,0);assert.equal(p.holds.length,1);assert.equal(p.outcomes.length,1);}});
test('archive aligns by label when source schemas differ; records schema hash and raw formula',()=>{const f=policyFixture(),other={sourceId:'second',sourceTab:'policy',complete:true,rows:[{values:['정비','정책코드'].map(stringValue=>({userEnteredValue:{stringValue}}))},{values:[{userEnteredValue:{formulaValue:'="미제공"'},effectiveValue:{stringValue:'미제공'}},{userEnteredValue:{stringValue:'POL-02'}}]}]};const a=buildPolicyArchive([...f.captures,other],'run',f.capturedAt);assert.equal(a.rows[2].values[a.headers.indexOf('정책코드')].userEnteredValue.stringValue,'POL-02');assert.equal(a.rows[2].values[a.headers.indexOf('정비')].note,'원천 수식: ="미제공"');assert.notEqual(a.rows[1].values[5].userEnteredValue.stringValue,a.rows[2].values[5].userEnteredValue.stringValue);});
test('source 0.2 displays 20 percent without changing raw numeric value or losing unit note',()=>{const f=policyFixture();f.captures[0].rows[0].values.push({userEnteredValue:{stringValue:'자차수리비율'}});f.captures[0].rows[1].values.push({userEnteredValue:{numberValue:0.2},effectiveValue:{numberValue:0.2},formattedValue:'20%',userEnteredFormat:{numberFormat:{type:'PERCENT',pattern:'0%'}},note:'수리비의 비율'});const p=planPolicyImport(f,now);assert.equal(p.writes.find(w=>w.header==='자차').value.stringValue,'수리비 20%');const a=buildPolicyArchive(f.captures,'run',f.capturedAt),c=a.rows[1].values[a.headers.indexOf('자차수리비율')];assert.equal(c.userEnteredValue.numberValue,0.2);assert.equal(c.userEnteredFormat.numberFormat.type,'PERCENT');assert.equal(c.note,'수리비의 비율');});
const cmp=inputSpec.legacyCompare;
const sharedRow=o=>inputSpec.inputHeaders.map(h=>o[h]??'');
const legacyHeaders=['차량번호','상태','분류','모델명','차명(세부모델+트림)','1개월','12개월','차량가격','정책코드'];
const legacyRow=o=>legacyHeaders.map(h=>o[h]??'');
const compareFixture=()=>({binding:{suppliers:[{title:'웰릭스',code:'RP013'}]},
  shared:{capturedAt:new Date(now).toISOString(),tabs:[{title:'웰릭스',headers:[...inputSpec.inputHeaders],rows:[sharedRow({'회사명':'예시','차량번호':'12가 3456','차량상태':'출고가능','1개월':900000,'차량가격':30000000,'예외사항':'정책은 비교 안 함'}),sharedRow({'차량번호':'99하9999','차량상태':'계약중'}),[]]}]},
  legacy:[{code:'RP013',tab:'재고',complete:true,capturedAt:new Date(now).toISOString(),headers:legacyHeaders,rows:[legacyRow({'차량번호':'12가3456','상태':'출고가능','1개월':'900,000','차량가격':30000000,'정책코드':'P1'}),legacyRow({'차량번호':'99하9999','상태':'출고가능'})]}]});
test('compare is read-only and maps renamed columns; spaces in plates and number formatting are not differences',()=>{const f=compareFixture(),before=JSON.stringify(f),r=compareSharedToLegacy(f,inputSpec,now);assert.equal(JSON.stringify(f),before);assert.ok(!('requests' in r));assert.match(r.scope,/COMPARE_ONLY/);const t=r.results[0];assert.equal(t.counts.matched,1);assert.deepEqual(t.different,[{plate:'99하9999',fields:['차량상태']}]);assert.equal(t.status,'DIFFERENT');assert.equal(r.status,'NOT_IN_SYNC');assert.equal(cmp.fieldMap['차량상태'],'상태');assert.ok(!('회사명' in cmp.fieldMap));for(const h of inputSpec.policyHeaders)assert.ok(!(h in cmp.fieldMap));});
const fullLegacy=f=>{const map=cmp.fieldMap,hs=[...new Set(Object.values(map))];const l=f.legacy[0],rows=l.rows.map(r=>hs.map(h=>{const i=l.headers.indexOf(h);return i<0?'':r[i];}));l.headers=hs;l.rows=rows;return f;};
test('compare reports one-sided plates, duplicates and rows without plate; identical sides are IN_SYNC',()=>{const f=compareFixture();f.legacy[0].rows[1]=legacyRow({'차량번호':'99하9999','상태':'계약중'});assert.equal(compareSharedToLegacy(f,inputSpec,now).status,'NOT_IN_SYNC','missing legacy columns are never IN_SYNC');fullLegacy(f);assert.equal(compareSharedToLegacy(f,inputSpec,now).status,'ALL_IN_SYNC');f.shared.tabs[0].rows.push(sharedRow({'차량번호':'11나1111'}),sharedRow({'차량상태':'출고가능'}));const lrow=o=>f.legacy[0].headers.map(h=>o[h]??'');f.legacy[0].rows.push(lrow({'차량번호':'22다2222'}),lrow({'차량번호':'12가3456'}));const t=compareSharedToLegacy(f,inputSpec,now).results[0];assert.deepEqual(t.onlyShared,['11나1111']);assert.deepEqual(t.onlyLegacy,['22다2222']);assert.deepEqual(t.duplicates,[{plate:'12가3456',shared:1,legacy:2}]);assert.equal(t.counts.sharedRowsWithoutPlate,1);assert.equal(t.counts.matched,1);assert.deepEqual(t.notInLegacy,[]);assert.equal(t.counts.comparedFields,Object.keys(cmp.fieldMap).length-1);});
test('compare does not equate two differently written numeric strings or text with numbers',()=>{const f=compareFixture();f.legacy[0].rows[0][legacyHeaders.indexOf('1개월')]='90만원';assert.deepEqual(compareSharedToLegacy(f,inputSpec,now).results[0].different.find(d=>d.plate==='12가3456').fields,['1개월']);});
test('compare fails closed: stale capture, wrong shared layout, missing shared tab; unreadable legacy is reported not zero',()=>{for(const mutate of [f=>f.shared.capturedAt='2026-10-03T10:00:00Z',f=>f.legacy[0].capturedAt='2026-10-01T00:00:00Z',f=>f.shared.tabs[0].headers.pop(),f=>f.shared.tabs=[],f=>f.binding.suppliers.push({title:'웰릭스',code:'X'})]){const f=compareFixture();mutate(f);assert.throws(()=>compareSharedToLegacy(f,inputSpec,now),/HOLD/);}
  for(const [mutate,status] of [[f=>f.legacy=[],'LEGACY_NOT_CAPTURED'],[f=>f.legacy[0].complete=false,'LEGACY_UNREADABLE'],[f=>f.legacy[0].tab='운영정책','LEGACY_UNREADABLE'],[f=>{f.legacy[0].headers=f.legacy[0].headers.map(h=>h==='차량번호'?'번호':h);},'LEGACY_UNREADABLE']]){const f=compareFixture();mutate(f);const r=compareSharedToLegacy(f,inputSpec,now);assert.equal(r.results[0].status,status);assert.equal(r.status,'NOT_IN_SYNC');}});
test('compare: plate-only legacy, duplicate legacy headers, duplicate or unbound legacy captures',()=>{const a=compareFixture();a.legacy[0].headers=['차량번호'];a.legacy[0].rows=[['12가3456'],['99하9999']];const r=compareSharedToLegacy(a,inputSpec,now).results[0];assert.equal(r.status,'DIFFERENT');assert.equal(r.counts.comparedFields,0);
  const b=compareFixture();b.legacy[0].headers=[...legacyHeaders.slice(0,-1),'1개월'];assert.equal(compareSharedToLegacy(b,inputSpec,now).results[0].reason,'duplicate legacy headers');
  const c=compareFixture();c.legacy.push({...c.legacy[0]});assert.throws(()=>compareSharedToLegacy(c,inputSpec,now),/One legacy capture/);
  const d=fullLegacy(compareFixture());d.legacy[0].rows[1][d.legacy[0].headers.indexOf('상태')]='계약중';d.legacy.push({...d.legacy[0],code:'OTHER'});const e=compareSharedToLegacy(d,inputSpec,now);assert.deepEqual(e.unboundLegacy,['OTHER']);assert.equal(e.results[0].status,'IN_SYNC');assert.equal(e.status,'NOT_IN_SYNC');});
test('dropdown setup: only pre-rent lists remain; free text clears filtered rows without writing values',()=>{
  const f=fixture(),before=JSON.stringify(f),p=planSupplierDropdowns(f,inputSpec,now);
  assert.equal(JSON.stringify(f),before);
  const col=h=>inputSpec.inputHeaders.indexOf(h);
  for(const r of p.requests){assert.deepEqual(Object.keys(r),['setDataValidation']);assert.ok(![1,2].includes(r.setDataValidation.range.sheetId));assert.equal(r.setDataValidation.range.startRowIndex,1);if(r.setDataValidation.rule)assert.ok(r.setDataValidation.range.startColumnIndex<col('1개월'));else assert.equal(r.setDataValidation.filteredRowsIncluded,true);}
  for(const h of inputSpec.inputHeaders.slice(col('1개월'))){const rs=p.requests.filter(r=>r.setDataValidation.range.startColumnIndex===col(h));assert.equal(rs.length,15,h);assert.ok(rs.every(r=>!r.setDataValidation.rule),h);}
  const g=fixture();g.spreadsheet.sheets[2].data[0].rowData[0].values.reverse();assert.throws(()=>planSupplierDropdowns(g,inputSpec,now),/LAYOUT_MISMATCH/);
  assert.throws(()=>planSupplierDropdowns(fixture(),{...inputSpec,dropdowns:{...inputSpec.dropdowns,'연료':undefined}},now),/exactly one dropdown/);
});
const old=inputSpec.legacyLayouts['2026-10-03'].inputHeaders,splitH=inputSpec.legacyLayouts['2026-10-03-split'].inputHeaders;
const splitFixture=(cells={})=>{const f=fixture();f.spreadsheet.sheets=f.spreadsheet.sheets.map(sh=>{const id=sh.properties.sheetId;if(id===2)return sh;const t=sheet(id,sh.properties.title,old);t.properties.gridProperties={...t.properties.gridProperties,rowCount:id===1?1000:3,columnCount:62};if(id!==1){const row=o=>({values:old.map(h=>o[h]===undefined?{}:{userEnteredValue:{stringValue:o[h]}})});t.data[0].rowData.push(row(id===3?cells:{'대인/면책':'무한 / 50만원'}),row({}));}return t;});return f;};
test('policy split: every observed value shape splits into one fact per cell',()=>{const cases=[['대인/면책','무한 / 50만원',['무한','50만원']],['대물/면책','10억원',['10억원','']],['자차/면책','차량가액 / 수리비 20% / 50~100만원',['차량가액','20%','50~100만원']],['자차/면책','차량가액 / 50~100만원',['차량가액','','50~100만원']],['자차/면책','50~100만원',['','','50~100만원']],['자손/면책','1천5백만원 / 30만원',['1천5백만원','30만원']],['무보험/면책','없음',['없음','']],['무보험/면책','없음 / 없음',['없음','없음']],['운전자범위','개인 계약자 본인 / 법인 대표자 본인',['계약자 본인','대표자 본인']],['추가운전','2인까지 / 무료',['2인까지','무료']],['승계','협의 / 100만원',['협의','100만원']],['승계','',['','']]];for(const [h,v,want] of cases)assert.deepEqual(splitPolicyValue(h,v),want,h+v);
  for(const [h,v] of [['대인/면책','무한'],['대인/면책','무한 / 50만원 / 기타'],['자차/면책','수리비 20% / 50만원'],['자차/면책','차량가액'],['운전자범위','본인 / 임직원'],['추가운전','1인까지'],['대물/면책','1억원 /  / 50만원']])assert.throws(()=>splitPolicyValue(h,v),/HOLD/,h+v);});
test('policy split plan: inserts columns right-to-left, rewrites headers and split cells only, regenerates summary; any unparsed cell holds everything',()=>{
  const f=splitFixture({'자차/면책':'차량가액 / 수리비 20% / 50~100만원','운전자범위':'개인 본인 / 법인 임직원','보험료':'포함'}),before=JSON.stringify(f),p=planPolicySplit(f,inputSpec,now);assert.equal(JSON.stringify(f),before);
  const ins=p.requests.filter(r=>r.insertDimension&&r.insertDimension.range.sheetId===3).map(r=>r.insertDimension.range.startIndex);assert.deepEqual(ins,[...ins].sort((a,b)=>b-a));assert.equal(ins.length,8);
  const added=p.requests.filter(r=>r.insertDimension&&r.insertDimension.range.sheetId===3).reduce((n,r)=>n+r.insertDimension.range.endIndex-r.insertDimension.range.startIndex,0);assert.equal(added,9);
  assert.ok(p.requests.every(r=>['insertDimension','updateCells','updateDimensionProperties','setDataValidation'].includes(Object.keys(r)[0])));
  const dv=p.requests.filter(r=>r.setDataValidation&&r.setDataValidation.range.sheetId===3);assert.equal(dv.length,17);for(const r of dv){const h=splitH[r.setDataValidation.range.startColumnIndex];assert.deepEqual(r.setDataValidation.rule.condition.values.map(v=>v.userEnteredValue),inputSpec.dropdowns[h],h);}
  assert.ok(p.requests.findIndex(r=>r.setDataValidation)>p.requests.findLastIndex(r=>r.insertDimension&&r.insertDimension.range.sheetId===3),'validation after inserts');
  const cellAt=(h,id=3)=>p.requests.find(r=>r.updateCells&&r.updateCells.start.sheetId===id&&r.updateCells.start.rowIndex===1&&r.updateCells.start.columnIndex===splitH.indexOf(h))?.updateCells.rows[0].values[0].userEnteredValue?.stringValue;
  assert.equal(cellAt('자차한도'),'차량가액');assert.equal(cellAt('자차수리비'),'20%');assert.equal(cellAt('자차면책'),'50~100만원');assert.equal(cellAt('개인운전자'),'본인');assert.equal(cellAt('법인운전자'),'임직원');assert.equal(cellAt('보험료'),undefined,'unsplit columns are not rewritten');
  const written=p.requests.filter(r=>r.updateCells&&r.updateCells.start.sheetId===3&&r.updateCells.start.rowIndex===1);assert.ok(written.every(r=>r.updateCells.rows.length===1),'only up to the last non-empty row');
  assert.ok(!p.requests.some(r=>r.updateCells&&r.updateCells.start.sheetId===3&&r.updateCells.start.rowIndex===1&&r.updateCells.start.columnIndex===splitH.indexOf('대인한도')),'empty source column writes nothing');
  const head=p.requests.find(r=>r.updateCells&&r.updateCells.start.sheetId===3&&r.updateCells.start.rowIndex===0).updateCells.rows[0].values.map(v=>v.userEnteredValue.stringValue);assert.deepEqual(head,splitH);
  const sum=p.requests.filter(r=>r.updateCells?.start.sheetId===1)[0].updateCells;assert.equal(sum.rows[0].values.length,71);assert.match(sum.rows[1].values[0].userEnteredValue.formulaValue,/'웰릭스'!A2:BS3/);assert.equal(p.requests.find(r=>r.insertDimension?.range.sheetId===1).insertDimension.range.endIndex,71);
  const offList=splitFixture({'대인/면책':'무한 / 70만원'});assert.throws(()=>planPolicySplit(offList,inputSpec,now),e=>/POLICY_SPLIT_UNPARSED/.test(e.message)&&/드롭다운 목록 밖/.test(e.holds[0]));
  const bad=splitFixture({'대인/면책':'무한'});assert.throws(()=>planPolicySplit(bad,inputSpec,now),e=>/POLICY_SPLIT_UNPARSED/.test(e.message)&&e.holds.length===1);
  const formula=splitFixture();formula.spreadsheet.sheets[2].data[0].rowData[1].values[old.indexOf('승계')]={userEnteredValue:{formulaValue:'=A1'}};assert.throws(()=>planPolicySplit(formula,inputSpec,now),/POLICY_SPLIT_UNPARSED/);
  const short=splitFixture();short.spreadsheet.sheets[2].properties.gridProperties.rowCount=10;assert.throws(()=>planPolicySplit(short,inputSpec,now),/full-height/);
  assert.throws(()=>planPolicySplit(fixture(),inputSpec,now),/LAYOUT_MISMATCH/,'already split or other layout holds');});
const reorderFixture=()=>{const f=fixture();f.spreadsheet.sheets=f.spreadsheet.sheets.map(sh=>{const id=sh.properties.sheetId;if(id===2)return sh;const t=sheet(id,sh.properties.title,splitH);t.properties.gridProperties={...t.properties.gridProperties,columnCount:71};return t;});return f;};
test('layout reorder: appends new columns, moves whole columns into the 대표 order, renames headers, never rewrites cell values',()=>{
  const f=reorderFixture(),before=JSON.stringify(f),p=planLayoutReorder(f,inputSpec,now);assert.equal(JSON.stringify(f),before);assert.equal(p.to,'2026-10-03-order');const orderH=inputSpec.legacyLayouts['2026-10-03-order'].inputHeaders;
  assert.ok(p.requests.every(r=>['insertDimension','moveDimension','updateCells','updateDimensionProperties','setDataValidation'].includes(Object.keys(r)[0])));
  const mine=p.requests.filter(r=>JSON.stringify(r).includes('"sheetId":3,')||JSON.stringify(r).includes('"sheetId":3}'));
  // Simulate the moves on the old header order and check the result is the new layout.
  const sim=[...splitH,...inputSpec.layoutReorder.newColumns.map(h=>'NEW:'+h)];
  for(const r of mine){if(r.moveDimension){const {startIndex}=r.moveDimension.source;sim.splice(r.moveDimension.destinationIndex,0,sim.splice(startIndex,1)[0]);}}
  const renamed=sim.map(h=>h.startsWith('NEW:')?h.slice(4):({'세부모델':'모델','옵션':'옵션 원문'}[h]??h));assert.deepEqual(renamed,orderH);
  const cellWrites=p.requests.filter(r=>r.updateCells&&r.updateCells.start.rowIndex!==0&&r.updateCells.start.sheetId!==1);assert.equal(cellWrites.length,0,'no data cell rewritten');
  const head=p.requests.find(r=>r.updateCells&&r.updateCells.start.sheetId===3).updateCells.rows[0].values.map(v=>v.userEnteredValue.stringValue);assert.deepEqual(head,orderH);
  const sum=p.requests.filter(r=>r.updateCells?.start.sheetId===1)[0].updateCells;assert.equal(sum.rows[0].values.length,74);assert.match(sum.rows[1].values[0].userEnteredValue.formulaValue,/'웰릭스'!A2:BV1000/);
  assert.equal(p.requests.filter(r=>r.setDataValidation&&r.setDataValidation.range.sheetId===3).length,3);
  assert.throws(()=>planLayoutReorder(fixture(),inputSpec,now),/LAYOUT_MISMATCH/,'only from the split layout');});
const orderH=inputSpec.legacyLayouts['2026-10-03-order'].inputHeaders;
const addFixture=()=>{const f=fixture();f.spreadsheet.sheets=f.spreadsheet.sheets.map(sh=>{const id=sh.properties.sheetId;if(id===2)return sh;const t=sheet(id,sh.properties.title,orderH);t.properties.gridProperties={...t.properties.gridProperties,columnCount:74};return t;});return f;};
test('column add: inserts 제원 6칸 after 차량가격, fills only those columns from matched rows, never rewrites existing cells',()=>{
  const f=addFixture();f.fill={'3':[{row:1,values:{'인승':5,'차종구분':'세단','원산지':'국산'}}],'4':[{row:2,values:{'배터리용량':77.4}}]};const before=JSON.stringify(f),p=planColumnAdd(f,inputSpec,now);assert.equal(JSON.stringify(f),before);assert.equal(p.to,'2026-10-03-spec');const specH=inputSpec.legacyLayouts['2026-10-03-spec'].inputHeaders;
  const at=orderH.indexOf('차량가격')+1;const ins=p.requests.filter(r=>r.insertDimension&&r.insertDimension.range.sheetId===3);assert.deepEqual(ins.map(r=>[r.insertDimension.range.startIndex,r.insertDimension.range.endIndex]),[[at,at+6]]);
  const fills=p.requests.filter(r=>r.updateCells&&r.updateCells.start.rowIndex>0&&r.updateCells.start.sheetId!==1);assert.equal(fills.length,2);assert.ok(fills.every(r=>r.updateCells.start.columnIndex===at&&r.updateCells.rows[0].values.length===6));
  assert.deepEqual(fills[0].updateCells.rows[0].values.map(v=>v.userEnteredValue??null),[{stringValue:'5'},{stringValue:'세단'},null,null,null,{stringValue:'국산'}],'list values stored as list text');
  assert.deepEqual(fills[1].updateCells.rows[0].values[4].userEnteredValue,{numberValue:77.4},'battery stays numeric');
  const fmt=h=>p.requests.find(r=>r.repeatCell&&r.repeatCell.range.sheetId===3&&r.repeatCell.range.startColumnIndex===at+['인승','차종구분','차종크기','구동방식','배터리용량','원산지'].indexOf(h)).repeatCell.cell.userEnteredFormat.numberFormat.type;assert.equal(fmt('배터리용량'),'NUMBER');assert.equal(fmt('차종구분'),'TEXT');assert.equal(fmt('인승'),'TEXT');
  const head=p.requests.find(r=>r.updateCells&&r.updateCells.start.sheetId===3&&r.updateCells.start.rowIndex===0).updateCells.rows[0].values.map(v=>v.userEnteredValue.stringValue);assert.deepEqual(head,specH);
  const dv=p.requests.filter(r=>r.setDataValidation&&r.setDataValidation.range.sheetId===3);assert.equal(dv.length,6);assert.equal(dv.find(r=>r.setDataValidation.range.startColumnIndex===at+4).setDataValidation.rule,undefined,'배터리용량 free');
  const sum=p.requests.filter(r=>r.updateCells?.start.sheetId===1)[0].updateCells;assert.equal(sum.rows[0].values.length,80);assert.match(sum.rows[1].values[0].userEnteredValue.formulaValue,/'웰릭스'!A2:CB1000/);
  for(const bad of [{'3':[{row:1,values:{'인승':5}},{row:1,values:{'원산지':'국산'}}]},{'3':[{row:1,values:{'차량가격':1}}]},{'3':[{row:0,values:{'인승':5}}]},{'999':[{row:1,values:{'인승':5}}]}]){const g=addFixture();g.fill=bad;assert.throws(()=>planColumnAdd(g,inputSpec,now),/HOLD/);}
  assert.throws(()=>planColumnAdd(fixture(),inputSpec,now),/LAYOUT_MISMATCH/);});
const specH=inputSpec.legacyLayouts['2026-10-03-spec'].inputHeaders;
const changeFixture=(rows=[])=>{const f=fixture();f.spreadsheet.sheets=f.spreadsheet.sheets.map(sh=>{const id=sh.properties.sheetId;if(id===2)return sh;const t=sheet(id,sh.properties.title,specH);t.properties.gridProperties={...t.properties.gridProperties,columnCount:80,rowCount:id===1?1000:4};if(id!==1){const row=o=>({values:specH.map(h=>o[h]===undefined?{}:{userEnteredValue:{stringValue:o[h]}})});t.data[0].rowData.push(...(id===3?rows:[]).map(row));while(t.data[0].rowData.length<4)t.data[0].rowData.push({values:[]});}return t;});return f;};
const salesSpec={...inputSpec,layoutChange:inputSpec.legacyLayouts['2026-10-03-sales'].layoutChange};
test('layout change: links plates to photos, deletes removed columns right to left, moves the rest, never rewrites values',()=>{
  const f=changeFixture([{'차량번호':'12가3456','사진링크':'https://example.com/a'},{'차량번호':'34나5678'}]),before=JSON.stringify(f),p=planLayoutChange(f,salesSpec,now);assert.equal(JSON.stringify(f),before);assert.equal(p.to,'2026-10-03-sales');assert.equal(p.platesLinked,1);
  assert.ok(p.requests.every(r=>['repeatCell','deleteDimension','moveDimension','updateCells'].includes(Object.keys(r)[0])));
  const mine=p.requests.filter(r=>{const b=Object.values(r)[0];return (b.range??b.source??b.start)?.sheetId===3;});
  const link=mine.find(r=>r.repeatCell);assert.equal(link.repeatCell.range.startColumnIndex,specH.indexOf('차량번호'));assert.equal(link.repeatCell.cell.userEnteredFormat.textFormat.link.uri,'https://example.com/a');assert.equal(link.repeatCell.fields,'userEnteredFormat.textFormat.link');
  assert.ok(mine.findIndex(r=>r.repeatCell)<mine.findIndex(r=>r.deleteDimension),'link before deleting the photo column');
  const sim=[...specH];for(const r of mine){if(r.deleteDimension)sim.splice(r.deleteDimension.range.startIndex,1);if(r.moveDimension)sim.splice(r.moveDimension.destinationIndex,0,sim.splice(r.moveDimension.source.startIndex,1)[0]);}
  assert.deepEqual(sim,salesSpec.legacyLayouts[salesSpec.layoutChange.to].inputHeaders);
  assert.equal(p.requests.filter(r=>r.updateCells&&(r.updateCells.start?.rowIndex??0)>0&&r.updateCells.start?.sheetId!==1).length,0,'no data cell rewritten');
  const sumReqs=p.requests.filter(r=>{const b=Object.values(r)[0];return (b.range??b.start)?.sheetId===1;});assert.match(sumReqs[0].updateCells.rows[1].values[0].userEnteredValue.formulaValue,/'웰릭스'!A2:BW4/);assert.equal(sumReqs.at(-1).deleteDimension.range.startIndex,salesSpec.legacyLayouts[salesSpec.layoutChange.to].inputHeaders.length);
  for(const rows of [[{'차량번호':'1','사진링크':'ftp://x'}],[{'사진링크':'https://example.com/b'}]]){assert.throws(()=>planLayoutChange(changeFixture(rows),salesSpec,now),/HOLD/);}
  const linkedAlready=changeFixture([{'사진링크':'https://drive.example/f'}]);linkedAlready.spreadsheet.sheets[2].data[0].rowData[1].values[specH.indexOf('차량번호')]={userEnteredValue:{formulaValue:'=HYPERLINK("https://drive.example/f","125호9158")'},effectiveValue:{stringValue:'125호9158'}};assert.equal(planLayoutChange(linkedAlready,salesSpec,now).platesLinked,0,'same-url HYPERLINK plate is already linked');
  const otherUrl=changeFixture([{'사진링크':'https://drive.example/f'}]);otherUrl.spreadsheet.sheets[2].data[0].rowData[1].values[specH.indexOf('차량번호')]={userEnteredValue:{formulaValue:'=HYPERLINK("https://other/x","125호9158")'},effectiveValue:{stringValue:'125호9158'}};assert.throws(()=>planLayoutChange(otherUrl,salesSpec,now),/수식이고 사진 주소와 다름/);
  const short=changeFixture();short.spreadsheet.sheets[2].data[0].rowData.pop();assert.throws(()=>planLayoutChange(short,salesSpec,now),/full-height/);
  assert.throws(()=>planLayoutChange(fixture(),salesSpec,now),/LAYOUT_MISMATCH/);});
const accountFixture=()=>{const f=fixture(),headers=inputSpec.legacyLayouts['2026-10-03-sales'].inputHeaders;f.spreadsheet.sheets=f.spreadsheet.sheets.map(s=>s.properties.sheetId===2?s:sheet(s.properties.sheetId,s.properties.title,headers));return f;};
test('account removal: preserves legacy, current 74-column canon and all remaining column order',()=>{
  const old=inputSpec.legacyLayouts['2026-10-03-sales'];
  assert.equal(inputSpec.inputHeaders.length,74);
  assert.deepEqual(inputSpec.inputHeaders,old.inputHeaders.filter(h=>h!=='계좌번호'));
  assert.deepEqual(inputSpec.summaryHeaders,inputSpec.inputHeaders);
  assert.equal(old.inputHeaders.length,inputSpec.inputHeaders.length+1);
  for(const h of inputSpec.inputHeaders)assert.ok(inputSpec.valueFormats[h],h);
  for(const value of [inputSpec.valueFormats,inputSpec.columnWidths,inputSpec.dropdowns])assert.ok(!Object.hasOwn(value,'계좌번호'));
  for(const value of [inputSpec.policyHeaders,inputSpec.leftAlignHeaders,...Object.values(inputSpec.dropdownPolicy).filter(Array.isArray)])assert.ok(!value.includes('계좌번호'));
  const f=canonFixture();assert.equal(auditTabConsistency(f.snapshot,f.spec).status,'PASS');
});
test('account removal: header-only capture needs no photo scan, deletes columns and rebuilds BV summary without supplier values or input mutation',()=>{
  const f=accountFixture(),before=structuredClone(f),specBefore=structuredClone(inputSpec),p=planLayoutChange(f,inputSpec,now);
  assert.deepEqual(f,before);assert.deepEqual(inputSpec,specBefore);assert.equal(p.platesLinked,0);assert.equal(p.to,'2026-10-04-no-account');
  const old=inputSpec.legacyLayouts[p.from].inputHeaders;
  for(const sup of f.binding.suppliers){
    const mine=p.requests.filter(r=>{const b=Object.values(r)[0];return (b.range??b.source??b.start)?.sheetId===sup.sheetId;});
    assert.deepEqual(mine.map(r=>Object.keys(r)[0]),['deleteDimension','updateCells']);
    assert.deepEqual(mine[0].deleteDimension.range,{sheetId:sup.sheetId,dimension:'COLUMNS',startIndex:old.indexOf('계좌번호'),endIndex:old.indexOf('계좌번호')+1});
    assert.equal(mine[1].updateCells.start.rowIndex,0);assert.equal(mine[1].updateCells.rows.length,1);
    assert.deepEqual(mine[1].updateCells.rows[0].values.map(v=>v.userEnteredValue.stringValue),inputSpec.inputHeaders);
  }
  const sum=p.requests.filter(r=>{const b=Object.values(r)[0];return (b.range??b.start)?.sheetId===1;});
  assert.equal(sum.length,3);assert.match(sum[0].updateCells.rows[1].values[0].userEnteredValue.formulaValue,/'웰릭스'!A2:BV1000/);
  assert.ok(!JSON.stringify(sum[0]).includes(':BW'));assert.equal(sum[1].updateCells.range.startColumnIndex,inputSpec.inputHeaders.length);
  assert.deepEqual(sum[2].deleteDimension.range,{sheetId:1,dimension:'COLUMNS',startIndex:inputSpec.inputHeaders.length,endIndex:old.length});
  assert.ok(!p.requests.some(r=>r.repeatCell||r.moveDimension));
  assert.throws(()=>planLayoutChange(fixture(),inputSpec,now),/LAYOUT_MISMATCH/);
  for(const remove of [['계좌번호','계좌번호'],['없는 열']])assert.throws(()=>planLayoutChange(f,{...inputSpec,layoutChange:{...inputSpec.layoutChange,remove}},now),/HOLD/);
  assert.throws(()=>planLayoutChange(f,{...inputSpec,layoutChange:{...inputSpec.layoutChange,linkPlateFrom:'사진링크'}},now),/HOLD/);
});
test('layout removal without links: multiple removed columns are deleted right to left',()=>{
  const spec=structuredClone(inputSpec);spec.layoutChange.remove=['상품구분','계좌번호','비고'];
  spec.inputHeaders=spec.legacyLayouts[spec.layoutChange.from].inputHeaders.filter(h=>!spec.layoutChange.remove.includes(h));spec.summaryHeaders=[...spec.inputHeaders];
  const p=planLayoutChange(accountFixture(),spec,now),old=spec.legacyLayouts[spec.layoutChange.from].inputHeaders;
  const indices=p.requests.filter(r=>r.deleteDimension?.range.sheetId===3).map(r=>r.deleteDimension.range.startIndex);
  assert.deepEqual(indices,spec.layoutChange.remove.map(h=>old.indexOf(h)).sort((a,b)=>b-a));
  const simulated=[...old];for(const at of indices)simulated.splice(at,1);assert.deepEqual(simulated,spec.inputHeaders);
});
test('canon captures: format-only capture HOLDs; merged format+value captures audit like the full snapshot; mismatched captures HOLD',()=>{
  const f=canonFixture(),full=f.snapshot.spreadsheet??f.snapshot,id='input-sheet-test';
  const strip=(keep)=>({spreadsheetId:id,sheets:full.sheets.map(s=>({...structuredClone(s),data:s.data.map(d=>({...structuredClone(d),rowData:(d.rowData??[]).map(r=>({values:(r.values??[]).map(c=>Object.fromEntries(Object.entries(c).filter(([k])=>keep(k))))}))}))}))});
  const isValue=k=>['userEnteredValue','formattedValue','effectiveValue'].includes(k);
  const formats=strip(k=>!isValue(k)),values=strip(isValue),before=JSON.stringify([formats,values]);
  assert.throws(()=>auditTabConsistency(formats,f.spec),/Canon header values missing/);
  const merged=mergeCanonCaptures(formats,values);assert.equal(JSON.stringify([formats,values]),before);
  assert.deepEqual(auditTabConsistency(merged,f.spec),auditTabConsistency({...full,spreadsheetId:id},f.spec));
  assert.throws(()=>mergeCanonCaptures(formats,{...values,spreadsheetId:'other'}),/different workbooks/);
  assert.throws(()=>mergeCanonCaptures(formats,{...values,sheets:values.sheets.slice(1)}),/different tabs/);
  assert.throws(()=>mergeCanonCaptures(formats,null),/HOLD/);
});


test('grouped suppliers: 18 codes, 15 physical tabs, machine-readable companies and archives; immutable capture',()=>{
  const f=fixture(),before=JSON.stringify(f);
  assert.equal(planSupplierInput(f,inputSpec,now).status,'LAYOUT_VERIFIED');
  for(const [title,codes] of [['경진',['RP016','RP015']],['빌린카',['RP021','PT-0026']],['스타',['RP018','RP033']]]){
    const members=shared.filter(s=>s.tab===title);assert.deepEqual(members.map(s=>s.code).sort(),codes.sort());
    assert.equal(new Set(f.binding.suppliers.filter(s=>s.title===title).map(s=>s.sheetId)).size,1);
    assert.ok(members.every(s=>s.companyName));
  }
  assert.deepEqual(inputSpec.supplierChannels.archivedTabs.map(s=>s.tab),['경진카','엘씨','스카이','마음카']);
  const metadata={...f.spreadsheet,usedRows:Object.fromEntries(['종합',...tabTitles].map(t=>[t,1]))};
  assert.equal(canonCaptureRequest(inputSpec,metadata).ranges.length,16);
  assert.equal(canonValueCaptureRequest(inputSpec,metadata).ranges.length,16);
  assert.equal(JSON.stringify(f),before);
  const split=fixture();split.binding.suppliers.find(s=>s.code==='RP016').sheetId=12345;
  assert.throws(()=>planSupplierInput(split,inputSpec,now),/binding mismatch/);
  const collision=fixture();collision.binding.suppliers[0].sheetId=collision.binding.suppliers[1].sheetId;
  assert.throws(()=>planSupplierInput(collision,inputSpec,now),/binding mismatch/);
});
test('hidden unbound affiliate archives accepted; visible archives HOLD; company audit accepts both affiliates',()=>{
  const f=withExcluded(false);f.spreadsheet.sheets.at(-1).properties.hidden=true;
  for(const a of inputSpec.supplierChannels.archivedTabs.filter(a=>a.mergedInto)){
    const tab=sheet(a.sheetId,a.tab,inputSpec.inputHeaders);tab.properties.hidden=true;
    f.spreadsheet.sheets.push(tab);f.sheetInventory.push({sheetId:a.sheetId});
  }
  const tab=f.spreadsheet.sheets.find(s=>s.properties.title==='경진');
  tab.data[0].rowData.push(...['경진카','경진','다른회사'].map(name=>({values:[{userEnteredValue:{stringValue:name}}]})));
  const before=JSON.stringify(f),p=planSupplierInput(f,inputSpec,now);
  assert.equal(p.status,'LAYOUT_VERIFIED');assert.equal(p.companyAudit.filter(a=>a.reason==='COMPANY_NAME_NOT_ALLOWED').length,1);
  assert.equal(p.companyAudit.find(a=>a.reason==='COMPANY_NAME_NOT_ALLOWED').row,4);
  const excluded=planExcludeSupplierTab(f,inputSpec,now);assert.equal(excluded.tabCount,15);
  const formula=excluded.requests[0].updateCells.rows[0].values[0].userEnteredValue.formulaValue;
  for(const a of inputSpec.supplierChannels.archivedTabs)assert.ok(!formula.includes(`'${a.tab}'!`));
  assert.equal(JSON.stringify(f),before);
  f.spreadsheet.sheets.at(-1).properties.hidden=false;assert.throws(()=>planSupplierInput(f,inputSpec,now),/Unbound visible/);
});
test('partial dates: confirmed month text, no invented day, invalid month HOLD, formats stable and inputs immutable',()=>{
  for(const header of ['최초등록일','입고일자'])for(const raw of ['25-04','2025-4','25.4','25.04','00-1','99-12']){
    const f=canonFixture();canonPut(f,1,1,header,raw);const before=JSON.stringify(f);
    const p=planValueNormalize(f.snapshot,f.spec,now);assert.equal(p.status,'PLANNED');
    const expected=raw==='00-1'?'00-01':raw==='99-12'?'99-12':'25-04';
    const write=p.requests.find(r=>r.updateCells);if(raw!==expected)assert.deepEqual(write.updateCells.rows[0].values[0].userEnteredValue,{stringValue:expected});
    assert.ok(p.requests.some(r=>r.repeatCell?.cell.userEnteredFormat.numberFormat.type==='TEXT'));
    assert.equal(JSON.stringify(f),before);
    canonPut(f,1,1,header,expected);const cell=f.snapshot.sheets[1].data[0].rowData[1].values[f.spec.inputHeaders.indexOf(header)];cell.userEnteredFormat.numberFormat={type:'TEXT'};
    assert.equal(auditValueFormats(f.snapshot,f.spec).status,'PASS');assert.equal(auditTabConsistency(f.snapshot,f.spec).status,'PASS');
    const fix=planTabConsistencyFix(f.snapshot,f.spec);const formats=fix.requests.filter(r=>r.repeatCell?.range.sheetId===1&&r.repeatCell.range.startRowIndex<=1&&r.repeatCell.range.endRowIndex>1&&r.repeatCell.range.startColumnIndex<=f.spec.inputHeaders.indexOf(header)&&r.repeatCell.range.endColumnIndex>f.spec.inputHeaders.indexOf(header)&&r.repeatCell.fields.includes('numberFormat'));
    assert.equal(formats.at(-1).repeatCell.cell.userEnteredFormat.numberFormat.type,'TEXT');
  }
  for(const raw of ['13월','25-13','25-00','1999-04','2025','25/4','25-02-30']){
    const f=canonFixture();canonPut(f,1,1,'입고일자',raw);const before=JSON.stringify(f),p=planValueNormalize(f.snapshot,f.spec,now);
    assert.equal(p.status,'HOLD');assert.deepEqual(p.requests,[]);assert.equal(JSON.stringify(f),before);
  }
});

test('shared legacy comparison partitions affiliates by company and rejects unassigned company rows',()=>{
  const f=compareFixture(),base=f.legacy[0];
  f.binding.suppliers=[{title:'경진',code:'RP016'},{title:'경진',code:'RP015'}];
  const row=(name,plate)=>inputSpec.inputHeaders.map(h=>h==='회사명'?name:h==='차량번호'?plate:'');
  f.shared.tabs=[{title:'경진',headers:inputSpec.inputHeaders,rows:[row('경진카','TEST-A'),row('경진','TEST-B')]}];
  f.legacy=['RP016','RP015'].map((code,i)=>({...base,code,headers:['차량번호'],rows:[[i?'TEST-B':'TEST-A']]}));
  const before=JSON.stringify(f),r=compareSharedToLegacy(f,inputSpec,now);
  assert.ok(r.results.every(s=>s.counts.matched===1&&s.counts.onlyShared===0&&s.counts.onlyLegacy===0));assert.equal(JSON.stringify(f),before);
  f.shared.tabs[0].rows.push(row('미확인','TEST-C'));assert.throws(()=>compareSharedToLegacy(f,inputSpec,now),/company/);
});
test('month formula results retain TEXT in summary format fixes while supplier formulas are preserved',()=>{
  const f=canonFixture();canonPut(f,0,1,'입고일자','25-04',{userEnteredValue:{formulaValue:'=A2'},effectiveValue:{stringValue:'25-04'}});
  const at=f.spec.inputHeaders.indexOf('입고일자');f.snapshot.sheets[0].data[0].rowData[1].values[at].userEnteredFormat.numberFormat={type:'TEXT'};
  assert.equal(auditTabConsistency(f.snapshot,f.spec).status,'PASS');
  const p=planTabConsistencyFix(f.snapshot,f.spec);assert.ok(p.requests.some(r=>r.repeatCell?.range.sheetId===0&&r.repeatCell.range.startRowIndex===1&&r.repeatCell.range.startColumnIndex===at&&r.repeatCell.cell.userEnteredFormat.numberFormat?.type==='TEXT'));
  canonPut(f,1,1,'입고일자','25-04',{userEnteredValue:{formulaValue:'=A2'},effectiveValue:{stringValue:'25-04'}});
  assert.equal(planValueNormalize(f.snapshot,f.spec,now).status,'HOLD');
});
test('summary formula keeps every row except 출고불가 and drops blank rows; status column follows the layout',()=>{
  const H=inputSpec.inputHeaders,f=summaryFormula("ARRAYFORMULA(IF(ISBLANK('가'!A2:BV9),\"\",'가'!A2:BV9))",H);
  assert.deepEqual(inputSpec.summaryExcludeStatuses,['출고불가']);
  assert.equal(inputSpec.summaryKeepStatuses,undefined);
  assert.equal(f,`=LET(src,VSTACK(ARRAYFORMULA(IF(ISBLANK('가'!A2:BV9),"",'가'!A2:BV9))),keep,BYROW(src,LAMBDA(r,AND(SUM(ARRAYFORMULA(LEN(r)))>0,INDEX(r,1,3)<>"출고불가"))),IFNA(FILTER(src,keep),""))`);
  // 수식의 keep 조건을 그대로 읽어 표본 줄에 적용: 빈 줄 아님 AND 상태 칸이 제외 목록 어느 것도 아님.
  const conds=[...f.matchAll(/INDEX\(r,1,(\d+)\)<>"([^"]+)"/g)].map(m=>[Number(m[1])-1,m[2]]);
  const keep=row=>row.some(v=>String(v).length>0)&&conds.every(([c,v])=>row[c]!==v);
  const at=H.indexOf('차량상태'),row=v=>{const r=H.map(()=>'');r[0]='회사';r[at]=v;return r;};
  const sample=[row('출고가능'),row('즉시출고'),row('출고불가'),row('출고협의'),row('상품화중'),row('계약중'),row(''),H.map(()=>'')];
  assert.deepEqual(sample.filter(keep).map(r=>r[at]),['출고가능','즉시출고','출고협의','상품화중','계약중','']);
  // 제외 목록이 둘이면 둘 다 뺀다.
  assert.ok(summaryFormula('x',H,{...inputSpec,summaryExcludeStatuses:['출고불가','계약중']}).includes('INDEX(r,1,3)<>"출고불가",INDEX(r,1,3)<>"계약중"'));
  // 칸 순서가 바뀌면 차량상태가 있는 칸을 본다; 차량상태가 없거나 목록이 잘못되면 HOLD.
  const moved=[...H];moved.splice(at,1);moved.push('차량상태');
  assert.ok(summaryFormula('x',moved).includes(`INDEX(r,1,${moved.length})<>"출고불가"`));
  assert.throws(()=>summaryFormula('x',H.filter(h=>h!=='차량상태')),/Summary status column missing/);
  for(const bad of [[],['출고"가능'],[''],undefined])assert.throws(()=>summaryFormula('x',H,{...inputSpec,summaryExcludeStatuses:bad}),/summaryExcludeStatuses invalid/);
});

test("latest user policy clears every column and blocks vehicle dropdown regeneration",()=>{ const removalSpec=structuredClone(currentSpec);delete removalSpec.dropdownPolicy.lightweight;const p=planSupplierDropdowns(fixture(),removalSpec,now);assert.equal(p.requests.length,15*currentSpec.inputHeaders.length);assert.ok(p.requests.every(r=>!r.setDataValidation.rule&&r.setDataValidation.filteredRowsIncluded));assert.throws(()=>planVehicleMasterDropdowns(masterFixture(),currentSpec,now),/disabled/);const f=canonFixture();f.spec.dropdownPolicy=structuredClone(removalSpec.dropdownPolicy);f.spec.performancePolicy=currentSpec.performancePolicy;const fix=planTabConsistencyFix(f.snapshot,f.spec);assert.ok(fix.requests.filter(r=>r.setDataValidation).every(r=>!r.setDataValidation.rule));assert.ok(!fix.requests.some(r=>r.addConditionalFormatRule));});
