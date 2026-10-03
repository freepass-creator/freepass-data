import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {auditValueFormats,planValueNormalize,auditTabConsistency,planTabConsistencyFix} from '../scripts/supplier-input-sheet.mjs';
import {planSupplierInput,planSupplierDropdowns,planVehicleMasterDropdowns,planPolicySplit,planLayoutReorder,planColumnAdd,planLayoutChange,splitPolicyValue,planPolicyImport,buildPolicyArchive,compareSharedToLegacy,inputSpec} from '../scripts/supplier-input-sheet.mjs';
const now=Date.parse('2026-10-03T12:00:00Z');
const legacy=inputSpec.legacyLayouts['2026-10-02'];
const sheet=(id,title,headers,grid={frozenRowCount:1,frozenColumnCount:0})=>({properties:{sheetId:id,title,gridProperties:{rowCount:1000,columnCount:headers.length,...grid}},data:[{rowData:[{values:headers.map(h=>({userEnteredValue:{stringValue:h}}))}]}]});
const shared=inputSpec.supplierChannels.sharedInputSheet;
const canonFixture=()=>{
  const spec=structuredClone(inputSpec);spec.supplierChannels.sharedInputSheet=[{tab:'가',code:'A'},{tab:'나',code:'B'}];
  const snapshot={sheets:['종합','가','나'].map((title,id)=>({properties:{sheetId:id,title,gridProperties:{rowCount:4,columnCount:75,frozenRowCount:1}},conditionalFormats:[],data:[{
    columnMetadata:spec.inputHeaders.map(h=>({pixelSize:spec.columnWidths[h]??spec.defaultColumnWidth})),rowMetadata:[{pixelSize:32},...Array.from({length:3},()=>({pixelSize:24}))],
    rowData:Array.from({length:4},(_,r)=>({values:spec.inputHeaders.map(h=>({...(r===0?{userEnteredValue:{stringValue:h}}:{}),userEnteredFormat:{textFormat:{fontFamily:spec.font.family,fontSize:spec.font.size,italic:false},wrapStrategy:'CLIP',horizontalAlignment:'CENTER',...(r>0&&['date','integer','decimal','year'].includes(spec.valueFormats[h].kind)?{numberFormat:{type:spec.valueFormats[h].kind==='date'?'DATE':'NUMBER',pattern:spec.valueFormats[h].pattern}}:{})},...(r>0&&id>0&&spec.dropdowns[h]?{dataValidation:{condition:{type:'ONE_OF_LIST',values:spec.dropdowns[h].map(userEnteredValue=>({userEnteredValue}))},strict:false,showCustomUi:true}}:r>0&&id>0&&spec.vehicleMaster.columns[h]?{dataValidation:{condition:{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='차종목록'!${spec.vehicleMaster.columns[h]}2:${spec.vehicleMaster.columns[h]}`}]},strict:false,showCustomUi:true}}:{})}))}))
  }]}))};return {snapshot,spec};
};
const canonPut=(f,tab,row,h,value,extra={})=>Object.assign(f.snapshot.sheets[tab].data[0].rowData[row].values[f.spec.inputHeaders.indexOf(h)],{userEnteredValue:typeof value==='number'?{numberValue:value}:{stringValue:value},...extra});
test('canon: 75 value formats, full identical tabs PASS and company values ignored',()=>{
  const f=canonFixture();canonPut(f,1,1,'회사명','각 회사');canonPut(f,2,1,'회사명','다른 회사');
  assert.equal(Object.keys(inputSpec.valueFormats).length,75);assert.equal(auditTabConsistency(f.snapshot,f.spec).status,'PASS');
  assert.equal(auditValueFormats(f.snapshot,f.spec).status,'PASS');assert.deepEqual(planTabConsistencyFix(f.snapshot,f.spec).requests,[]);
});
test('canon: exact dates, ages, seats and aliases normalize; ambiguous values and formulas HOLD; immutable',()=>{
  const f=canonFixture();canonPut(f,1,1,'입고일자','2026-10-03');canonPut(f,1,2,'입고일자','2026. 10. 3');canonPut(f,1,3,'입고일자',46298,{userEnteredFormat:{}});
  canonPut(f,1,1,'기본연령','만 26세 이상');canonPut(f,1,1,'최대연령','만 65세 이하');canonPut(f,1,1,'인승','5인승');
  canonPut(f,1,1,'연주행','연 20,000km');canonPut(f,1,1,'면허기간','1년 이상');canonPut(f,1,1,'1개월','900,000');
  canonPut(f,1,2,'기본연령','26');canonPut(f,1,2,'1개월','90만원');canonPut(f,1,2,'최초등록일','2026-02-30');canonPut(f,1,2,'정비','오일 연2회');
  canonPut(f,1,3,'기본연령','',{userEnteredValue:{formulaValue:'="만 26세 이상"'},effectiveValue:{stringValue:'만 26세 이상'}});
  canonPut(f,0,1,'입고일자','2026-10-03');const before=JSON.stringify(f),p=planValueNormalize(f.snapshot,f.spec,now);
  assert.equal(JSON.stringify(f),before);assert.equal(p.columns.find(c=>c.column==='입고일자').normalizable,3);assert.equal(p.holds.length,5);
  assert.ok(p.requests.every(r=>(r.updateCells??r.repeatCell).range.sheetId!==0));
  assert.ok(p.requests.filter(r=>r.updateCells).every(r=>r.updateCells.fields==='userEnteredValue'));
  const dates=p.requests.filter(r=>r.updateCells?.range.startColumnIndex===1).map(r=>r.updateCells.rows[0].values[0].userEnteredValue.numberValue);assert.equal(dates[0],dates[1]);
  assert.ok(p.requests.some(r=>r.repeatCell?.cell.userEnteredFormat.numberFormat.pattern==='yy.mm.dd'));
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
test('canon: normalization preserves cell notes and links; second plan is empty after readback',()=>{
  const f=canonFixture();canonPut(f,1,1,'입고일자','2026. 10. 3',{note:'원문 보존'});canonPut(f,1,1,'기본연령','만 26세 이상');
  const p=planValueNormalize(f.snapshot,f.spec,now);
  for(const request of p.requests){const x=request.updateCells??request.repeatCell,t=f.snapshot.sheets.find(s=>s.properties.sheetId===x.range.sheetId),c=t.data[0].rowData[x.range.startRowIndex].values[x.range.startColumnIndex];
    if(request.updateCells)c.userEnteredValue=structuredClone(x.rows[0].values[0].userEnteredValue);else c.userEnteredFormat.numberFormat=structuredClone(x.cell.userEnteredFormat.numberFormat);
  }
  assert.equal(f.snapshot.sheets[1].data[0].rowData[1].values[1].note,'원문 보존');assert.deepEqual(planValueNormalize(f.snapshot,f.spec,now).requests,[]);
});
test('canon: no majority, missing metadata and unread summary formulas cannot PASS',()=>{
  const f=canonFixture(),d=f.snapshot.sheets[1].data[0];d.rowData[1].values[0].userEnteredFormat.horizontalAlignment='LEFT';d.rowData[2].values[0].userEnteredFormat.horizontalAlignment='RIGHT';
  assert.ok(auditTabConsistency(f.snapshot,f.spec).holds.some(h=>h.reason==='NO_MAJORITY_horizontalAlignment'));
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
      else {const path=x.fields.split('.');let dest=cell,source=x.cell;for(const k of path.slice(0,-1)){dest=dest[k]??= {};source=source?.[k];}const k=path.at(-1);if(source?.[k]===undefined)delete dest[k];else dest[k]=structuredClone(source[k]);}
    }
  }
  assert.equal(auditTabConsistency(f.snapshot,f.spec).status,'PASS');assert.equal(planTabConsistencyFix(f.snapshot,f.spec).requests.length,0);
  assert.deepEqual(f.snapshot.sheets.map(s=>s.data[0].rowData.map(r=>r.values.map(c=>({value:c.userEnteredValue,note:c.note,link:c.userEnteredFormat?.textFormat?.link})))),before);
});
const masterFixture=()=>({...fixture(),master:{source:inputSpec.vehicleMaster.source,readAt:new Date(now).toISOString(),header:['원산지','제조사','모델','세부모델','세부트림','생산시작','생산종료'],rows:[['국산','현대','캐스퍼','더 뉴 캐스퍼','스마트'],['국산','현대','캐스퍼','캐스퍼','터보'],['국산','기아','레이','','스마트'],['','','',null,'  ']]}});
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
  const validations=p.requests.filter(r=>r.setDataValidation).map(r=>r.setDataValidation);assert.equal(validations.length,19*4);
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
test('vehicle master CLI: stdin uses the first branch and emits requests only',()=>{
  const f=masterFixture();f.capturedAt=new Date().toISOString();f.master.source=inputSpec.vehicleMaster.source.split(' / 탭 ')[0];
  const r=spawnSync(process.execPath,['scripts/supplier-input-sheet.mjs','--vehicle-master=-','--change-layout=unused'],{input:JSON.stringify(f),encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).scope,'VEHICLE_MASTER_RANGE_DROPDOWNS');
});
const fixture=()=>({capturedAt:new Date(now).toISOString(),binding:{spreadsheetId:'test',summarySheetId:1,guideSheetId:2,suppliers:shared.map((r,i)=>({sheetId:3+i,title:r.tab,code:r.code}))},sheetInventory:[1,2,...shared.map((_,i)=>3+i)].map(sheetId=>({sheetId})),spreadsheet:{spreadsheetId:'test',sheets:[sheet(1,'종합',inputSpec.summaryHeaders),sheet(2,'관리안내',['안내']),...shared.map((r,i)=>sheet(3+i,r.tab,inputSpec.inputHeaders))]}});
const policyFixture=()=>{const f=fixture(),d=sheet(3,'웰릭스',legacy.inputHeaders);const h=legacy.inputHeaders,values=h.map(()=>({}));values[h.indexOf('차량번호')]={userEnteredValue:{stringValue:'TEST-1'}};values[h.indexOf('정책코드')]={userEnteredValue:{stringValue:'POL-01'}};d.data[0].rowData.push({values});return {runId:'test-run',capturedAt:f.capturedAt,suppliers:[{sheetId:3,sourceId:'source',sourceTab:'policy'}],destinations:[d],captures:[{sourceId:'source',sourceTab:'policy',complete:true,rows:[{values:['정책코드','추가주행 금액','정비'].map(stringValue=>({userEnteredValue:{stringValue}}))},{values:['POL-01','대여료의 10%','연2회오일'].map(stringValue=>({userEnteredValue:{stringValue}}))}]}]};};

test('2026-10-03-sales layout: 영업자 보기 — 어떤 차인지 → 대여료 → 부가 정보, then 예외사항 and 41 one-fact policy columns',()=>{
  assert.equal(inputSpec.layoutVersion,'2026-10-03-sales');
  const v=inputSpec.vehicleHeaders;assert.equal(v.length,34);assert.equal(inputSpec.policyHeaders.length,41);
  assert.deepEqual(v.slice(0,15),['회사명','입고일자','차량상태','상품구분','차량번호','제조사','모델','세부모델','세부트림','외부색상','내부색상','연식','주행거리','배기량','연료']);
  assert.deepEqual(v.slice(15,24),['단기보증','1개월','6개월','12개월','장기보증','24개월','36개월','48개월','60개월']);
  assert.deepEqual(v.slice(24),['차명 원문','옵션 원문','차량가격','인승','차종크기','차종구분','구동방식','배터리용량','원산지','최초등록일']);
  for(const gone of ['배차상태','사진링크','기타기간①','기타기간②','기타기간③','정책코드','점검사항'])assert.ok(!inputSpec.inputHeaders.includes(gone),gone);
  assert.deepEqual(inputSpec.inputHeaders,[...v,...inputSpec.policyHeaders]);assert.deepEqual(inputSpec.summaryHeaders,inputSpec.inputHeaders);assert.equal(new Set(inputSpec.inputHeaders).size,75);
  assert.equal(inputSpec.policyHeaders[0],'예외사항');assert.ok(inputSpec.policyHeaders.includes('계좌번호'));for(const h of inputSpec.policyHeaders)assert.ok(!h.includes('/')||h==='선불/후불',h);
  assert.equal(inputSpec.frozenRowCount,1);assert.equal(inputSpec.frozenColumnCount,0);assert.equal(inputSpec.vehicleMaster.columns['모델'],'B');
  assert.equal(inputSpec.legacyLayouts['2026-10-03-spec'].inputHeaders.length,80);
});
test('matching sheet verifies with zero write requests and leaves input untouched',()=>{const f=fixture(),before=JSON.stringify(f),r=planSupplierInput(f,inputSpec,now);assert.equal(JSON.stringify(f),before);assert.equal(r.status,'LAYOUT_VERIFIED');assert.deepEqual(r.requests,[]);assert.match(r.scope,/VERIFY_ONLY/);});
test('any header difference is LAYOUT_MISMATCH HOLD — old 2026-10-02 layout, reorder, missing, extra',()=>{
  const cases=[f=>{f.spreadsheet.sheets[2]=sheet(3,'웰릭스',legacy.inputHeaders);},f=>{f.spreadsheet.sheets[0]=sheet(1,'종합',legacy.summaryHeaders);},f=>{f.spreadsheet.sheets[2].data[0].rowData[0].values.reverse();},f=>{f.spreadsheet.sheets[2].data[0].rowData[0].values.pop();},f=>{f.spreadsheet.sheets[2].data[0].rowData[0].values.push({userEnteredValue:{stringValue:'정책코드'}});},f=>{f.spreadsheet.sheets[2].data[0].rowData[0].values[0].userEnteredValue.stringValue='';}];
  for(const mutate of cases){const f=fixture();mutate(f);assert.throws(()=>planSupplierInput(f,inputSpec,now),e=>/HOLD: LAYOUT_MISMATCH/.test(e.message)&&e.mismatched.length===1);}
});
test('extra trailing header cells and hidden bound tabs are HOLD; hidden unbound archive tabs are ignored',()=>{const a=fixture();a.spreadsheet.sheets[2].data[0].rowData[0].values.push({});assert.throws(()=>planSupplierInput(a,inputSpec,now),/LAYOUT_MISMATCH/);for(const id of [0,2]){const f=fixture();f.spreadsheet.sheets[id].properties.hidden=true;assert.throws(()=>planSupplierInput(f,inputSpec,now),e=>/LAYOUT_MISMATCH/.test(e.message)&&e.mismatched[0].hidden===true);}const f=fixture();f.spreadsheet.sheets.push({...sheet(9000,'정책원문',['runId']),properties:{sheetId:9000,title:'정책원문',hidden:true,gridProperties:{rowCount:10,columnCount:1}}});f.sheetInventory.push({sheetId:9000});assert.equal(planSupplierInput(f,inputSpec,now).status,'LAYOUT_VERIFIED');});
test('frozen rows/columns drift is reported, never written',()=>{const f=fixture();f.spreadsheet.sheets[2].properties.gridProperties.frozenColumnCount=2;const r=planSupplierInput(f,inputSpec,now);assert.equal(r.status,'LAYOUT_VERIFIED_WITH_PRESENTATION_DRIFT');assert.deepEqual(r.drift.map(d=>[d.sheetId,d.frozenColumnCount]),[[3,2]]);assert.deepEqual(r.requests,[]);});
test('fail closed binding freshness inventory duplicate and production workbook',()=>{for(const mutate of [f=>f.binding.spreadsheetId='other',f=>f.capturedAt='2026-09-01',f=>f.sheetInventory.pop(),f=>f.binding.suppliers.push({...f.binding.suppliers[0]}),f=>{f.spreadsheet.sheets.push(sheet(9001,'숨김아님',['x']));f.sheetInventory.push({sheetId:9001});}]){const f=fixture();mutate(f);assert.throws(()=>planSupplierInput(f,inputSpec,now),/HOLD/);}});
test('channel split: 19 shared-sheet suppliers, 5 direct/own-sheet suppliers, no overlap; binding must match exactly',()=>{const c=inputSpec.supplierChannels,codes=c.sharedInputSheet.map(r=>r.code),outside=c.notInSharedSheet.map(r=>r.code);assert.equal(codes.length,19);assert.equal(new Set(codes).size,19);assert.equal(new Set(c.sharedInputSheet.map(r=>r.tab)).size,19);assert.deepEqual(outside.sort(),['RP004','RP006','RP012','RP023','RP031']);assert.ok(outside.every(o=>!codes.includes(o)));assert.ok(codes.includes('RP013'));assert.match(c.membershipRule,/아이카/);assert.throws(()=>compareSharedToLegacy({...compareFixture(),binding:{suppliers:[{title:'아이카',code:'RP004'}]}},inputSpec,now),/excluded from the shared sheet/);
  for(const mutate of [f=>{f.binding.suppliers[0].code='RP031';},f=>{f.binding.suppliers[0].title='이안카';},f=>{f.binding.suppliers[0].code='RP020';f.binding.suppliers[1].code='RP013';},f=>{f.binding.suppliers.pop();f.spreadsheet.sheets.pop();f.sheetInventory.pop();},f=>{f.spreadsheet.sheets[2].properties.title='이안카';},f=>{f.binding.suppliers[0]={...f.binding.suppliers[0],title:'아이카',code:'RP004'};f.spreadsheet.sheets[2].properties.title='아이카';}]){const f=fixture();mutate(f);assert.throws(()=>planSupplierInput(f,inputSpec,now),/HOLD/);}
  const r=compareSharedToLegacy(compareFixture(),inputSpec,now);assert.equal(r.notCompared.length,18);});
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
test('dropdown setup: validation-only requests on supplier tabs, every column decided, summary untouched',()=>{const f=fixture(),before=JSON.stringify(f),p=planSupplierDropdowns(f,inputSpec,now);assert.equal(JSON.stringify(f),before);assert.equal(p.scope,'SUPPLIER_TAB_DATA_VALIDATION_ONLY');assert.ok(p.requests.every(r=>Object.keys(r).join()==='setDataValidation'&&r.setDataValidation.rule));assert.equal(p.requests.length,19*Object.keys(inputSpec.dropdowns).length);assert.ok(!p.requests.some(r=>r.setDataValidation.range.sheetId===1||r.setDataValidation.range.sheetId===2));assert.ok(p.requests.every(r=>r.setDataValidation.range.startRowIndex===1));
  const col=h=>inputSpec.inputHeaders.indexOf(h),at=(h,id=3)=>p.requests.find(r=>r.setDataValidation.range.sheetId===id&&r.setDataValidation.range.startColumnIndex===col(h))?.setDataValidation;
  assert.deepEqual(at('보험료').rule.condition.values.map(v=>v.userEnteredValue),['포함','불포함']);assert.equal(at('보험료').rule.strict,false);assert.equal(at('비고'),undefined,'free text untouched');assert.equal(at('계좌번호'),undefined);assert.deepEqual(at('대물면책').rule.condition.values.map(v=>v.userEnteredValue),['없음','30만원','50만원','100만원','협의']);assert.ok(at('21세+').rule.condition.values.some(v=>v.userEnteredValue==='대여료의 10%'));
  for(const h of inputSpec.inputHeaders)assert.equal([Boolean(inputSpec.dropdowns[h]),Boolean(inputSpec.vehicleMaster.columns[h]),inputSpec.dropdownPolicy.freeText.includes(h)].filter(Boolean).length,1,h);
  for(const h of inputSpec.policyHeaders)if(inputSpec.dropdowns[h])assert.equal(inputSpec.dropdowns[h].includes('협의'),!inputSpec.dropdownPolicy.negotiableExceptions.includes(h),'협의 rule for '+h);
  for(const r of ['50~100만원','100~200만원','200~400만원','300~400만원','300~500만원'])assert.ok(inputSpec.dropdowns['자차면책'].includes(r),r);
  for(const [h,vals] of Object.entries(inputSpec.dropdownPolicy.existingValuesNotInList))for(const [v] of vals)assert.ok(!inputSpec.dropdowns[h].includes(v),h+v);
  const g=fixture();g.spreadsheet.sheets[2].data[0].rowData[0].values.reverse();assert.throws(()=>planSupplierDropdowns(g,inputSpec,now),/LAYOUT_MISMATCH/);
  assert.throws(()=>planSupplierDropdowns(fixture(),{...inputSpec,dropdowns:{...inputSpec.dropdowns,'보험료':undefined}},now),/exactly one dropdown/);});
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
test('layout change: links plates to photos, deletes removed columns right to left, moves the rest, never rewrites values',()=>{
  const f=changeFixture([{'차량번호':'12가3456','사진링크':'https://example.com/a'},{'차량번호':'34나5678'}]),before=JSON.stringify(f),p=planLayoutChange(f,inputSpec,now);assert.equal(JSON.stringify(f),before);assert.equal(p.to,'2026-10-03-sales');assert.equal(p.platesLinked,1);
  assert.ok(p.requests.every(r=>['repeatCell','deleteDimension','moveDimension','updateCells'].includes(Object.keys(r)[0])));
  const mine=p.requests.filter(r=>{const b=Object.values(r)[0];return (b.range??b.source??b.start)?.sheetId===3;});
  const link=mine.find(r=>r.repeatCell);assert.equal(link.repeatCell.range.startColumnIndex,specH.indexOf('차량번호'));assert.equal(link.repeatCell.cell.userEnteredFormat.textFormat.link.uri,'https://example.com/a');assert.equal(link.repeatCell.fields,'userEnteredFormat.textFormat.link');
  assert.ok(mine.findIndex(r=>r.repeatCell)<mine.findIndex(r=>r.deleteDimension),'link before deleting the photo column');
  const sim=[...specH];for(const r of mine){if(r.deleteDimension)sim.splice(r.deleteDimension.range.startIndex,1);if(r.moveDimension)sim.splice(r.moveDimension.destinationIndex,0,sim.splice(r.moveDimension.source.startIndex,1)[0]);}
  assert.deepEqual(sim,inputSpec.inputHeaders);
  assert.equal(p.requests.filter(r=>r.updateCells&&(r.updateCells.start?.rowIndex??0)>0&&r.updateCells.start?.sheetId!==1).length,0,'no data cell rewritten');
  const sumReqs=p.requests.filter(r=>{const b=Object.values(r)[0];return (b.range??b.start)?.sheetId===1;});assert.match(sumReqs[0].updateCells.rows[1].values[0].userEnteredValue.formulaValue,/'웰릭스'!A2:BW4/);assert.equal(sumReqs.at(-1).deleteDimension.range.startIndex,75);
  for(const rows of [[{'차량번호':'1','사진링크':'ftp://x'}],[{'사진링크':'https://example.com/b'}]]){assert.throws(()=>planLayoutChange(changeFixture(rows),inputSpec,now),/HOLD/);}
  const linkedAlready=changeFixture([{'사진링크':'https://drive.example/f'}]);linkedAlready.spreadsheet.sheets[2].data[0].rowData[1].values[specH.indexOf('차량번호')]={userEnteredValue:{formulaValue:'=HYPERLINK("https://drive.example/f","125호9158")'},effectiveValue:{stringValue:'125호9158'}};assert.equal(planLayoutChange(linkedAlready,inputSpec,now).platesLinked,0,'same-url HYPERLINK plate is already linked');
  const otherUrl=changeFixture([{'사진링크':'https://drive.example/f'}]);otherUrl.spreadsheet.sheets[2].data[0].rowData[1].values[specH.indexOf('차량번호')]={userEnteredValue:{formulaValue:'=HYPERLINK("https://other/x","125호9158")'},effectiveValue:{stringValue:'125호9158'}};assert.throws(()=>planLayoutChange(otherUrl,inputSpec,now),/수식이고 사진 주소와 다름/);
  const short=changeFixture();short.spreadsheet.sheets[2].data[0].rowData.pop();assert.throws(()=>planLayoutChange(short,inputSpec,now),/full-height/);
  assert.throws(()=>planLayoutChange(fixture(),inputSpec,now),/LAYOUT_MISMATCH/);});
