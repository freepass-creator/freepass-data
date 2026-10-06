import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const managedName='FreePassVehicleCascade';
const marker='// freepass-managed: shared-sheet-row-cascade/1';
export function mergeCascadeContent(existing,bundle) {
  const incoming=bundle.files.find(f=>f.type==='SERVER_JS'),manifest=bundle.files.find(f=>f.name==='appsscript');
  if(!incoming||!manifest)throw new Error('HOLD: built script bundle required');
  const other=[];
  for(const f of existing.files??[]) {
    if(f.name===managedName){if(!f.source?.startsWith(marker))throw new Error('HOLD: unmanaged name collision');continue;}
    if(f.name==='appsscript')continue;
    if(f.type==='SERVER_JS'&&/\b(?:function\s+(?:onEdit|onOpen|onSelectionChange)\s*\(|(?:onEdit|onOpen|onSelectionChange)\s*=)/.test(f.source??''))throw new Error('HOLD: existing trigger handler must be integrated first');
    other.push(f);
  }
  const old=existing.files?.find(f=>f.name==='appsscript');
  const config=old?JSON.parse(old.source):JSON.parse(manifest.source);
  config.runtimeVersion='V8';
  config.oauthScopes=[...new Set([...(config.oauthScopes??[]),'https://www.googleapis.com/auth/spreadsheets.currentonly'])];
  return {files:[...other,{name:'appsscript',type:'JSON',source:JSON.stringify(config,null,2)},{name:managedName,type:'SERVER_JS',source:marker+'\n'+incoming.source}]};
}

export async function deployCascade({bundle,token,scriptId,receiptPath},fetcher=fetch) {
  if(!token)throw new Error('APPS_SCRIPT_AUTH_UNAVAILABLE: configure FREEPASS_APPS_SCRIPT_ACCESS_TOKEN with script.projects and userinfo.email scopes; Sheets connector auth is separate');
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const call=async(url,method='GET',body)=>{
    const r=await fetcher(url,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
    if(!r.ok)throw new Error(`APPS_SCRIPT_API_HTTP_${r.status}`); // Do not print tokens or private API error bodies.
    return r.json();
  };
  const profile=await call('https://www.googleapis.com/oauth2/v2/userinfo');
  if(profile.email!=='pyh@teamjpk.com')throw new Error('HOLD: pyh@teamjpk.com account required');
  let receipt=fs.existsSync(receiptPath)?JSON.parse(fs.readFileSync(receiptPath,'utf8')):null;
  if(receipt&&receipt.spreadsheetId!==bundle.config.spreadsheetId)throw new Error('HOLD: receipt workbook differs');
  scriptId=scriptId??receipt?.scriptId;
  const save=status=>{
    fs.mkdirSync(path.dirname(receiptPath),{recursive:true});
    receipt={spreadsheetId:bundle.config.spreadsheetId,scriptId,status,account:profile.email,recordedAt:new Date().toISOString()};
    fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');
  };
  if(receipt?.status==='CREATE_OUTCOME_UNKNOWN'&&!scriptId)throw new Error('HOLD: recover the existing project ID before retry; do not create a duplicate');
  if(!scriptId) {
    save('CREATE_OUTCOME_UNKNOWN');
    const project=await call('https://script.googleapis.com/v1/projects','POST',{title:'FreePass shared sheet vehicle dropdowns',parentId:bundle.config.spreadsheetId});
    scriptId=project.scriptId;save('PROJECT_CREATED_NOT_UPDATED');
  }
  const base=`https://script.googleapis.com/v1/projects/${encodeURIComponent(scriptId)}`;
  const project=await call(base);
  if(project.parentId!==bundle.config.spreadsheetId)throw new Error('HOLD: bound project parent differs');
  const existing=await call(base+'/content');
  fs.writeFileSync(receiptPath+'.previous-content.json',JSON.stringify(existing,null,2)+'\n');
  const content=mergeCascadeContent(existing,bundle);
  await call(base+'/content','PUT',content);
  const readback=await call(base+'/content');
  const expected=content.files.find(f=>f.name===managedName),actual=readback.files?.find(f=>f.name===managedName);
  if(actual?.source!==expected.source)throw new Error('HOLD: deployed script readback differs');
  save('PERSISTENCE_VERIFIED_NOT_CUTOVER');
  return receipt;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
  try {
    const file=arg('bundle'),receiptPath=arg('receipt');
    if(!file||!receiptPath)throw new Error('--bundle=private-script-content.json --receipt=private-deployment-receipt.json required');
    const receipt=await deployCascade({bundle:JSON.parse(fs.readFileSync(file,'utf8')),receiptPath,scriptId:arg('script-id'),token:process.env.FREEPASS_APPS_SCRIPT_ACCESS_TOKEN});
    console.log(JSON.stringify({status:receipt.status,account:receipt.account}));
  }catch(e){console.error(e.message);process.exitCode=2;}
}
