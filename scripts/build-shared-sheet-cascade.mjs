import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inputSpec,vehicleMasterCascadeLookup} from './supplier-input-sheet.mjs';
import vm from 'node:vm';

// Same pure hierarchy logic as the bound script, also usable by Sheets API publishers.
export function planCascadeValidationRefresh(input,spec=inputSpec,now=Date.now()) {
  const age=now-Date.parse(input.capturedAt);
  if(!Number.isFinite(age)||age< -1000||age>300000)throw new Error('HOLD: fresh read required');
  const bundle=buildCascadeBundle({...input.metadata,vehicleMasterSnapshot:input.master},spec,now),config=bundle.config;
  if(JSON.stringify(input.headers)!==JSON.stringify(config.headers))throw new Error('HOLD: fresh vehicle header read required');
  if(input.lookupSheetId!==config.lookupSheetId)throw new Error('HOLD: lookup binding changed');
  const ctx=vm.createContext({});
  vm.runInContext(bundle.files[1].source,ctx);
  const index=ctx.fpCascadeIndex(input.lookupRows),requests=[];
  const seen=new Set();
  for(const row of input.rows??[]) {
    const binding=config.suppliers.find(s=>s.title===row.tab&&s.sheetId===row.sheetId);
    const sheet=input.metadata.sheets.find(s=>s.properties.sheetId===row.sheetId);
    const key=`${row.sheetId}:${row.row}`;
    if(!binding||!Number.isInteger(row.row)||row.row<2||row.row>sheet.properties.gridProperties.rowCount||!Array.isArray(row.values)||row.values.length!==4||row.values.some(v=>typeof v!=='string')||seen.has(key))throw new Error('HOLD: exact unique supplier row required');
    seen.add(key);
    ctx.fpCascadeChoices(row.values,index).forEach((list,i)=>{
      const column=config.firstColumn+i;
      requests.push({setDataValidation:{range:{sheetId:row.sheetId,startRowIndex:row.row-1,endRowIndex:row.row,startColumnIndex:column-1,endColumnIndex:column},filteredRowsIncluded:true,rule:{condition:list.length?{type:'ONE_OF_LIST',values:list.map(userEnteredValue=>({userEnteredValue}))}:{type:'CUSTOM_FORMULA',values:[{userEnteredValue:`=LEN(${String.fromCharCode(64+column)}${row.row})=0`}]},strict:false,showCustomUi:list.length>0,inputMessage:'앞 항목에 맞는 차종 목록. 입력값은 보존됩니다.'}}});
    });
  }
  return {status:bundle.holds.length?'PLANNED_WITH_HOLD':'PLANNED',snapshotDigest:config.masterSnapshotDigest,holds:bundle.holds,spreadsheetId:config.spreadsheetId,scope:'VEHICLE_VALIDATION_ONLY',requests};
}

export function buildCascadeBundle(metadata, spec=inputSpec,now=Date.now()) {
  if(spec.dropdownPolicy?.disabled)throw new Error('HOLD: Dropdowns disabled by latest user decision');
  if(!metadata?.spreadsheetId || !Array.isArray(metadata.sheets))throw new Error('HOLD: fresh workbook metadata required');
  const titles=[...new Set(spec.supplierChannels.sharedInputSheet.map(s=>s.tab))];
  const suppliers=titles.map(title=>{
    const sheet=metadata.sheets.find(s=>s.properties.title===title&&!s.properties.hidden);
    if(!sheet)throw new Error(`HOLD: supplier tab missing: ${title}`);
    return {title,sheetId:sheet.properties.sheetId};
  });
  const headers=spec.vehicleMaster.cascade.order;
  const firstColumn=spec.inputHeaders.indexOf(headers[0])+1;
  if(headers.length!==4||!headers.every((h,i)=>spec.inputHeaders[firstColumn-1+i]===h))throw new Error('HOLD: contiguous vehicle headers required');
  const lookup=metadata.sheets.find(s=>s.properties.title===spec.vehicleMaster.cascade.lookupTab);
  if(!lookup)throw new Error('HOLD: published lookup tab missing');
  const snapshot=vehicleMasterCascadeLookup(metadata.vehicleMasterSnapshot,now);
  const config={version:'shared-sheet-row-cascade/1',masterSnapshotDigest:snapshot.snapshotDigest,expectedLookupRows:snapshot.lookupRows,spreadsheetId:metadata.spreadsheetId,headers,firstColumn,lookupTab:lookup.properties.title,lookupSheetId:lookup.properties.sheetId,suppliers};
  const source=fs.readFileSync(new URL('./shared-sheet-cascade-runtime.gs',import.meta.url),'utf8');
  return {config,lookupRows:snapshot.lookupRows,holds:snapshot.holds,files:[{name:'appsscript',type:'JSON',source:JSON.stringify({timeZone:'Asia/Seoul',runtimeVersion:'V8',exceptionLogging:'STACKDRIVER',oauthScopes:['https://www.googleapis.com/auth/spreadsheets.currentonly']},null,2)},{name:'Code',type:'SERVER_JS',source:`var FREEPASS_CASCADE_CONFIG = ${JSON.stringify(config)};\n${source}`}],cutover:'HOLD_UNTIL_BOUND_SCRIPT_UI_EDIT_AND_API_REPAIR_VERIFIED'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const input=process.argv.find(a=>a.startsWith('--metadata='))?.slice(11),out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
  if(!input||!out)throw new Error('--metadata=private-metadata.json --out=private-script-content.json required');
  const raw=JSON.parse(fs.readFileSync(input,'utf8'));
  const built=buildCascadeBundle(raw.structuredContent??raw);
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(built,null,2)+'\n');
  console.log(JSON.stringify({status:'BUILT_NOT_DEPLOYED',suppliers:built.config.suppliers.length,output:path.resolve(out)}));
}
