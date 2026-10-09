import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {buildCascadeBundle,planCascadeValidationRefresh} from '../scripts/build-shared-sheet-cascade.mjs';
import {inputSpec as currentSpec} from '../scripts/supplier-input-sheet.mjs';
import {mergeCascadeContent,deployCascade} from '../scripts/deploy-shared-sheet-cascade.mjs';
const inputSpec=structuredClone(currentSpec);inputSpec.dropdownPolicy.disabled=false;
const lookup=[['@snapshot','test-digest'],['M|*','기아','현대'],['D|기아','K3'],['S|기아|K3','K3 BD'],['T|기아|K3|K3 BD','스탠다드']];
function fixture(values=[['기아','K3','K3 BD','스탠다드']]){
  const ctx=vm.createContext({FREEPASS_CASCADE_CONFIG:{masterSnapshotDigest:'test-digest',expectedLookupRows:lookup,spreadsheetId:'book',firstColumn:6,headers:['제조사','모델','세부모델','세부트림'],lookupTab:'차종연쇄',lookupSheetId:92,suppliers:[{title:'가',sheetId:81}]},Number,JSON});
  vm.runInContext(fs.readFileSync(new URL('../scripts/shared-sheet-cascade-runtime.gs',import.meta.url),'utf8'),ctx);
  let writes=[],released=0;
  ctx.SpreadsheetApp={newDataValidation(){let r={};return {setAllowInvalid(v){r.allowInvalid=v;return this;},requireValueInList(v){r.list=v;return this;},requireFormulaSatisfied(v){r.formula=v;return this;},setHelpText(v){r.help=v;return this;},build(){return r;}};}};
  ctx.LockService={getDocumentLock:()=>({tryLock:()=>true,releaseLock:()=>released++})};
  const sheet={getName:()=> '가',getSheetId:()=>81,getMaxRows:()=>1000,getRange(row,col,count,width){assert.equal(col,6);assert.equal(width,4);return {getDisplayValues:()=>row===1?[ctx.FREEPASS_CASCADE_CONFIG.headers]:values.slice(row-2,row-2+count),setDataValidations:r=>writes.push(r)};}};
  const book={getId:()=> 'book',getSheetByName:()=>({getSheetId:()=>92,getLastRow:()=>lookup.length,getLastColumn:()=>5,getRange:()=>({getDisplayValues:()=>lookup})})};
  return {ctx,sheet,book,writes,values,released:()=>released};
}
test('cascade uses the complete parent path and does not offer other-maker descendants',()=>{
  const f=fixture(),index=f.ctx.fpCascadeIndex(lookup);
  assert.equal(JSON.stringify(f.ctx.fpCascadeChoices(['기아','K3','K3 BD'],index)),JSON.stringify([['기아','현대'],['K3'],['K3 BD'],['스탠다드']]));
  assert.equal(JSON.stringify(f.ctx.fpCascadeChoices(['현대','K3','K3 BD'],index)),JSON.stringify([['기아','현대'],[],[],[]]));
  const duplicate=[...lookup,lookup[1]];f.ctx.FREEPASS_CASCADE_CONFIG.expectedLookupRows=duplicate;
  assert.throws(()=>f.ctx.fpCascadeIndex(duplicate),/duplicate/);
});
test('cascade rejects a changed lookup even with the old snapshot marker; legacy unmarked input holds',()=>{
  const f=fixture();const changed=structuredClone(lookup);changed[1][1]='다른 제조사';
  assert.throws(()=>f.ctx.fpCascadeIndex(changed),/differs/);
  assert.throws(()=>f.ctx.fpCascadeIndex(lookup.slice(1)),/snapshot mismatch/);
});
test('row refresh writes validations only, preserves unmatched values and releases lock',()=>{
  const f=fixture([['기아','옛 모델','옛 세부모델','옛 트림']]),before=JSON.stringify(f.values);
  f.ctx.fpCascadeRefresh(f.book,f.sheet,2,1);
  assert.equal(JSON.stringify(f.values),before);assert.equal(f.writes.length,1);assert.equal(f.released(),1);
  assert.ok(f.writes[0][0].every(r=>r.allowInvalid));assert.equal(f.writes[0][0][2].formula,'=LEN(H2)=0');
});
test('multi-row paste uses current row values instead of e.value; unrelated columns do no work',()=>{
  const f=fixture([['기아','K3','K3 BD','스탠다드'],['','','','']]);
  const range={getSheet:()=>f.sheet,getColumn:()=>6,getLastColumn:()=>9,getRow:()=>2,getLastRow:()=>3};
  f.ctx.onEdit({source:f.book,range});assert.equal(f.writes[0].length,2);
  f.ctx.onEdit({source:f.book,range:{...range,getColumn:()=>17,getLastColumn:()=>17}});assert.equal(f.writes.length,1);
});
test('wrong workbook, changed headers and lookup mismatch fail before validation writes',()=>{
  const f=fixture();assert.throws(()=>f.ctx.fpCascadeRefresh({...f.book,getId:()=> 'other'},f.sheet,2,1),/binding/);
  assert.throws(()=>f.ctx.fpCascadeRefresh(f.book,{...f.sheet,getSheetId:()=>82},2,1),/sheet ID/);
  assert.throws(()=>f.ctx.fpCascadeRefresh({...f.book,getSheetByName:()=>null},f.sheet,2,1),/lookup/);assert.equal(f.writes.length,0);
});
test('summary and archives ignored; out-of-grid rows rejected',()=>{
  const f=fixture();assert.equal(f.ctx.fpCascadeRefresh(f.book,{getName:()=> '종합'},2,1).status,'IGNORED');
  assert.throws(()=>f.ctx.fpCascadeRefresh(f.book,f.sheet,999,3),/bounded/);assert.equal(f.writes.length,0);
});
test('concurrent value change aborts validation writes and releases the lock',()=>{
  const f=fixture();let reads=0;
  const sheet={...f.sheet,getRange(row,col,count,width){if(row===1)return f.sheet.getRange(row,col,count,width);return {getDisplayValues:()=>++reads===1?[['기아','K3','K3 BD','스탠다드']]:[['현대','','','']],setDataValidations:()=>{throw Error('must not write');}};}};
  assert.throws(()=>f.ctx.fpCascadeRefresh(f.book,sheet,2,1),/row changed/);assert.equal(f.released(),1);
});
test('missing lookup key after a valid parent does not invent a child or erase values',()=>{
  const f=fixture();f.ctx.FREEPASS_CASCADE_CONFIG.expectedLookupRows=[['@snapshot','test-digest'],['M|*','기아'],['D|기아','K3']];const index=f.ctx.fpCascadeIndex(f.ctx.FREEPASS_CASCADE_CONFIG.expectedLookupRows);
  assert.equal(JSON.stringify(f.ctx.fpCascadeChoices(['기아','K3','기존 값'],index)),JSON.stringify([['기아'],['K3'],[],[]]));
});
test('bundle exact-binds the existing 15 physical supplier tabs; no external-file scope',()=>{
  const titles=[...new Set(inputSpec.supplierChannels.sharedInputSheet.map(s=>s.tab))];
  const meta={spreadsheetId:'book',sheets:[...titles.map((title,i)=>({properties:{title,sheetId:i+1,gridProperties:{rowCount:1000}}})),{properties:{title:'차종연쇄',sheetId:92}}]};
  const data={maker:'기아',model:'K3',sub_model:'K3 BD'},body={readAt:new Date().toISOString(),masters:[{id:'m',data}],trims:[{id:'t',data:{...data,master_id:'m',trim:'스탠다드'}}]};meta.vehicleMasterSnapshot={source:'freepasserp5/vehicle_master+vehicle_trim_master',complete:true,...body,digest:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
  const b=buildCascadeBundle(meta,inputSpec);assert.equal(b.config.suppliers.length,15);assert.equal(b.config.firstColumn,6);
  assert.deepEqual(JSON.parse(b.files[0].source).oauthScopes,['https://www.googleapis.com/auth/spreadsheets.currentonly']);
  assert.throws(()=>buildCascadeBundle({...meta,sheets:meta.sheets.slice(1)},inputSpec),/supplier tab missing/);
  const now=Date.now(),input={master:meta.vehicleMasterSnapshot,capturedAt:new Date(now).toISOString(),metadata:meta,headers:b.config.headers,lookupSheetId:92,lookupRows:b.lookupRows,rows:[{tab:titles[0],sheetId:1,row:2,values:['기아','K3','K3 BD','스탠다드']}]};
  const plan=planCascadeValidationRefresh(input,inputSpec,now);
  assert.equal(plan.requests.length,4);assert.ok(plan.requests.every(r=>Object.keys(r).join()==='setDataValidation'&&r.setDataValidation.filteredRowsIncluded));
  assert.deepEqual(plan.requests[3].setDataValidation.rule.condition.values,[{userEnteredValue:'스탠다드'}]);
  assert.throws(()=>planCascadeValidationRefresh({...input,capturedAt:'2000-01-01'},inputSpec,now),/fresh/);
  assert.throws(()=>planCascadeValidationRefresh({...input,rows:[{...input.rows[0],sheetId:99}]},inputSpec,now),/unique supplier/);
});
test('deployment preserves unrelated script files and refuses conflicting trigger handlers',()=>{
  const bundle={files:[{name:'Code',type:'SERVER_JS',source:'function onEdit(e) {}'},{name:'appsscript',type:'JSON',source:'{}'}]};
  const helper={name:'Other',type:'SERVER_JS',source:'function unrelated() {}'};
  const merged=mergeCascadeContent({files:[helper]},bundle);
  assert.deepEqual(merged.files[0],helper);assert.ok(merged.files.at(-1).source.startsWith('// freepass-managed:'));
  assert.throws(()=>mergeCascadeContent({files:[{...helper,source:'function onEdit(e) {}'}]},bundle),/existing trigger/);
  assert.throws(()=>mergeCascadeContent({files:[{...helper,name:'FreePassVehicleCascade'}]},bundle),/unmanaged/);
});
test('latest removal decision blocks bundle and deployment before network',async()=>{assert.throws(()=>buildCascadeBundle({spreadsheetId:'book',sheets:[]}),/disabled/);await assert.rejects(deployCascade({token:'test'},()=>{throw Error('must not call');}),/disabled/);});
