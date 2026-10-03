import fs from 'node:fs';
import {createHash} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { specification } from './sheet-presentation.mjs';
export const inputSpec = JSON.parse(fs.readFileSync(new URL('../contracts/supplier-input-sheet-spec.v1.json', import.meta.url), 'utf8'));
const hold = message => { throw new Error(`HOLD: ${message}`); };
// Only suppliers registered for the shared sheet may be bound, with the exact
// code↔tab pairing. ERP/homepage/API suppliers are never shared-sheet tabs.
const registered = (suppliers, spec, requireAll) => {
  const list=spec.supplierChannels?.sharedInputSheet??[];
  if(!list.length)hold('Spec supplierChannels.sharedInputSheet required');
  const bad=suppliers.filter(s=>!list.some(r=>r.code===s.code&&r.tab===s.title));
  if(bad.length)hold(`Unregistered or mismatched supplier tab: ${bad.map(s=>`${s.title}/${s.code}`).join(', ')}`);
  const missing=list.filter(r=>!suppliers.some(s=>s.code===r.code));
  if(requireAll&&missing.length)hold(`Registered supplier tabs not bound: ${missing.map(r=>r.tab).join(', ')}`);
  return missing;
};
const headersOf = sheet => sheet.data?.find(d=>(d.startRow??0)===0&&(d.startColumn??0)===0)?.rowData?.[0]?.values?.map(c=>c.userEnteredValue?.stringValue??'')??[];

// No credentials, network, source ingestion, sharing, or value normalization.
// Caller must provide a fresh independent inventory and exact private binding.
// 2026-10-03 layout is applied in the live sheet and locked by the spec. This
// planner only verifies the header row (exact order, no extra cells), that bound
// tabs are visible, and frozen panes. Widths, number formats and dropdowns are
// recorded in the spec but not verified here. Any header difference or hidden
// bound tab is HOLD; a matching sheet yields zero write requests. The 2026-10-02 writer
// that reordered columns and rebuilt the summary would damage the new layout,
// so re-applying presentation needs a new reviewed planner, not this one.
export function planSupplierInput(input, spec=inputSpec, now=Date.now()) {
  const {spreadsheet,binding,capturedAt}=input;
  if(spec.plannerMode!=='VERIFY_ONLY_NO_WRITES')hold('Spec planner mode must be VERIFY_ONLY_NO_WRITES');
  const age=now-Date.parse(capturedAt);
  if(!Number.isFinite(age)||age< -1000||age>300000)hold('Fresh read required');
  if(!binding?.spreadsheetId||spreadsheet?.spreadsheetId!==binding.spreadsheetId)hold('Exact workbook binding required');
  if(Object.values(specification.workbooks).some(w=>w.spreadsheetId===binding.spreadsheetId))hold('Production F01/F86 is not an input workbook');
  const sheets=spreadsheet.sheets??[], ids=sheets.map(s=>s.properties.sheetId);
  if(new Set(ids).size!==ids.length)hold('Duplicate sheet IDs');
  if(JSON.stringify([...ids].sort((a,b)=>a-b))!==JSON.stringify((input.sheetInventory??[]).map(s=>s.sheetId).sort((a,b)=>a-b)))hold('Complete independent inventory required');
  const suppliers=binding.suppliers??[];
  if(!suppliers.length||suppliers.some(s=>typeof s.title!=='string'||s.title.length===0)||new Set(suppliers.map(s=>s.sheetId)).size!==suppliers.length||new Set(suppliers.map(s=>s.code)).size!==suppliers.length||new Set(suppliers.map(s=>s.title)).size!==suppliers.length)hold('Unique supplier bindings required');
  registered(suppliers,spec,true);
  const summary=sheets.find(s=>s.properties.sheetId===binding.summarySheetId), guide=sheets.find(s=>s.properties.sheetId===binding.guideSheetId);
  if(!summary||!guide||summary===guide||suppliers.some(s=>[binding.summarySheetId,binding.guideSheetId].includes(s.sheetId)))hold('Summary/guide binding invalid');
  const allowed=new Set([binding.summarySheetId,binding.guideSheetId,...suppliers.map(s=>s.sheetId)]);
  if(sheets.some(s=>!s.properties.hidden&&!allowed.has(s.properties.sheetId)))hold('Unbound visible sheet');
  const mismatched=[], drift=[];
  for(const entry of [{sheetId:binding.summarySheetId,title:spec.summaryTitle,summary:true},...suppliers]) {
    const s=sheets.find(s=>s.properties.sheetId===entry.sheetId); if(!s)hold('Supplier sheet missing');
    if(s.properties.title!==entry.title)hold(`Bound tab title differs: sheet ${entry.sheetId} is "${s.properties.title}", binding says "${entry.title}"`);
    const headers=headersOf(s),expected=entry.summary?spec.summaryHeaders:spec.inputHeaders;
    if(JSON.stringify(headers)!==JSON.stringify(expected))mismatched.push({sheetId:entry.sheetId,title:s.properties.title,missing:expected.filter(h=>!headers.includes(h)),unexpected:headers.filter(h=>!expected.includes(h)),orderOnly:headers.length===expected.length&&expected.every(h=>headers.includes(h))});
    if(s.properties.hidden)mismatched.push({sheetId:entry.sheetId,title:s.properties.title,hidden:true});
    const grid=s.properties.gridProperties??{};
    if((grid.frozenRowCount??0)!==spec.frozenRowCount||(grid.frozenColumnCount??0)!==spec.frozenColumnCount)drift.push({sheetId:entry.sheetId,title:s.properties.title,frozenRowCount:grid.frozenRowCount??0,frozenColumnCount:grid.frozenColumnCount??0});
  }
  if(mismatched.length)throw Object.assign(new Error(`HOLD: LAYOUT_MISMATCH — ${mismatched.length} tab(s) differ from spec layout ${spec.layoutVersion}; nothing is written`),{mismatched});
  return {status:drift.length?'LAYOUT_VERIFIED_WITH_PRESENTATION_DRIFT':'LAYOUT_VERIFIED',layoutVersion:spec.layoutVersion,scope:'MANUAL_SUPPLIER_INPUT_LAYOUT_VERIFY_ONLY_NOT_AUTOMATIC_SOURCE_REFRESH',spreadsheetId:binding.spreadsheetId,drift,requests:[]};
}
// Source policies stay in their original units. Blank/duplicate codes never
// select a generic default. No inventory/monetary field is normalized here.
// Historical one-time migration for the 2026-10-02 layout (matched by 정책코드).
const legacyLayout=inputSpec.legacyLayouts['2026-10-02'];
export function planPolicyImport({suppliers,captures,destinations,capturedAt,runId,rewriteImportedPolicyPresentation},now=Date.now()) {
  if(!runId)hold('Policy import run ID required');
  const age=now-Date.parse(capturedAt);if(!Number.isFinite(age)||age< -1000||age>300000)hold('Fresh policy captures required');
  const read=c=>{const v=c?.effectiveValue??c?.userEnteredValue??{};if(v.errorValue)hold('Source formula error');return v.stringValue??v.numberValue??v.boolValue??'';};
  const cell=v=>typeof v==='number'?{numberValue:v}:typeof v==='boolean'?{boolValue:v}:{stringValue:String(v)};
  const writes=[],holds=[],outcomes=[];
  for(const supplier of suppliers){
    const capture=captures.find(c=>c.sourceId===supplier.sourceId&&c.sourceTab===supplier.sourceTab);
    const dest=destinations.find(s=>s.properties.sheetId===supplier.sheetId);
    if(!capture||!dest||capture.complete!==true)hold('Complete supplier-bound policy capture required');
    const raw=capture.rows,sh=raw[0]?.values.map(read),rows=dest.data?.[0]?.rowData,h=rows?.[0]?.values.map(read);
    if(!h?.includes('정책코드'))hold('Policy import is for the 2026-10-02 layout only; current layout has no 정책코드 column');
    if(!sh?.includes('정책코드')||!h?.includes('차량번호')||new Set(sh).size!==sh.length)hold('Policy headers invalid');
    for(let row=1;row<rows.length;row++){
      const plate=read(rows[row].values?.[h.indexOf('차량번호')]);if(plate==='')continue;
      const code=read(rows[row].values?.[h.indexOf('정책코드')]);
      if(code!==''&&(typeof code!=='string'||code.trim()!==code)){holds.push({sheetId:supplier.sheetId,row,reason:'NON_CANONICAL_CODE'});outcomes.push({sheetId:supplier.sheetId,row,status:'NON_CANONICAL_CODE'});continue;}
      const hits=code===''?[]:raw.slice(1).filter(r=>read(r.values?.[sh.indexOf('정책코드')])===code);
      if(hits.length!==1){const reason=code===''?'POLICY_CODE_EMPTY':hits.length>1?'POLICY_CODE_AMBIGUOUS':'POLICY_CODE_UNMATCHED';holds.push({sheetId:supplier.sheetId,row,reason});outcomes.push({sheetId:supplier.sheetId,row,status:reason});continue;}
      outcomes.push({sheetId:supplier.sheetId,row,status:'MATCHED',sourceId:capture.sourceId,sourceRow:raw.indexOf(hits[0])+1,code});
      const get=name=>{const c=hits[0].values?.[sh.indexOf(name)],v=read(c);if(typeof v==='number'&&c?.userEnteredFormat?.numberFormat?.type==='PERCENT'){if(!c.formattedValue)hold('Percent display evidence required');return c.formattedValue;}return v;};
      const join=names=>names.map(name=>{const v=get(name);return v===''?'':name+': '+v;}).filter(Boolean).join('\n');
      const verbose={'정비':get('정비'),'전용계좌':get('전용계좌'),'연주행':get('기본주행'),'분납':get('보증금분납'),'21세':get('21세+'),'23세':get('23세+'),'1만+':get('추가주행 금액'),'운전자범위':join(['개인운전자범위','법인운전자범위']),'대인':join(['대인보상한도','대인면책금']),'대물':join(['대물보상한도','대물면책금']),'자손':join(['자손보상','자손면책금']),'무보험':join(['무보험보상','무보험면책금']),'자차':join(['자차보상한도','자차수리비율','자차최소면책금','자차최대면책금']),'비고':join(['정책명','심사조건','특이사항','기타사항 1','기타사항 2','기타사항 3','기타사항 4'])};
      const compact=names=>names.map(get).filter(v=>v!=='').join(' / ');
      const range=(low,high)=>{
        if(low===''&&high==='')return '';
        if(low==='')return '최대 '+high;
        if(high==='')return '최소 '+low;
        if(low===high)return String(low);
        const a=String(low).match(/^([\d,.]+)(만원|억원|원)$/),b=String(high).match(/^([\d,.]+)(만원|억원|원)$/);
        return a&&b&&a[2]===b[2]?a[1]+'~'+b[1]+a[2]:low+'~'+high;
      };
      const values=legacyLayout.policyDisplay==='COMPACT_VALUES_PRESERVE_UNITS'?{...verbose,
        '운전자범위':[['개인','개인운전자범위'],['법인','법인운전자범위']].map(([label,key])=>get(key)===''?'':label+' '+get(key)).filter(Boolean).join(' / '),
        '대인':compact(['대인보상한도','대인면책금']),'대물':compact(['대물보상한도','대물면책금']),
        '자손':compact(['자손보상','자손면책금']),'무보험':compact(['무보험보상','무보험면책금']),
        '자차':[get('자차보상한도'),get('자차수리비율')===''?'':'수리비 '+get('자차수리비율'),range(get('자차최소면책금'),get('자차최대면책금'))].filter(v=>v!=='').join(' / '),
        '비고':compact(['정책명','심사조건','특이사항','기타사항 1','기타사항 2','기타사항 3','기타사항 4'])}:verbose;
      // 대여지역 is not 차고지. Neither generic template nor bare rate/money
      // assumptions fill it. Full original source fields must be archived.
      for(const [name,v]of Object.entries(values)){const col=h.indexOf(name);if(col<0||v==='')continue;const existing=rows[row].values?.[col];
        if(JSON.stringify(existing?.userEnteredValue)===JSON.stringify(cell(v)))continue;
        let previous;
        if(existing?.userEnteredValue||read(existing)!==''){
          const owned=rewriteImportedPolicyPresentation?.runId;
          if(!owned||v===verbose[name])continue;
          if(!existing?.note?.includes('/ '+owned+' /')||!existing.note.includes('/ '+capture.sourceTab+' '+(raw.indexOf(hits[0])+1)+'행 / '+code+' /')||JSON.stringify(existing.userEnteredValue)!==JSON.stringify(cell(verbose[name]))){holds.push({sheetId:supplier.sheetId,row,column:col,reason:'POLICY_PRESENTATION_NOT_OWNED_OR_CHANGED'});continue;}
          previous={value:existing.userEnteredValue,note:existing.note};
        }
        writes.push({sheetId:supplier.sheetId,row,column:col,header:name,value:cell(v),fullDescription:verbose[name],...(previous?{previous}:{}),source:{runId,sourceId:capture.sourceId,sourceTab:capture.sourceTab,sourceRow:raw.indexOf(hits[0])+1,code}});
      }
    }
  }
  return {status:holds.length?'PARTIAL_WITH_HOLD':'READY',writes,holds,outcomes,scope:rewriteImportedPolicyPresentation?'IMPORTED_PRESENTATION_REWRITE_PRESERVE_RAW_UNITS':'BLANK_POLICY_FIELDS_ONLY_KEEP_RAW_UNITS'};
}
export function buildPolicyArchive(captures,runId,capturedAt) {
  if(!runId||!Number.isFinite(Date.parse(capturedAt)))hold('Archive provenance required');
  const read=c=>c?.effectiveValue??c?.userEnteredValue??{};
  const headers=[...new Set(captures.flatMap(c=>c.rows[0].values.map(v=>read(v).stringValue)))];
  if(headers.some(h=>!h))hold('Archive header missing');
  const meta=['runId','원천파일','원천탭','원천행','확인시각','원천헤더SHA256'];
  const rows=[{values:[...meta,...headers].map(stringValue=>({userEnteredValue:{stringValue}}))}];
  for(const capture of captures){if(capture.complete!==true)hold('Incomplete archive capture');const own=capture.rows[0].values.map(v=>read(v).stringValue);if(new Set(own).size!==own.length)hold('Duplicate archive header');
    const hash=createHash('sha256').update(JSON.stringify(own)).digest('hex');
    for(let i=1;i<capture.rows.length;i++)rows.push({values:[runId,capture.sourceId,capture.sourceTab,String(i+1),capturedAt,hash].map(stringValue=>({userEnteredValue:{stringValue}})).concat(headers.map(h=>{const source=capture.rows[i].values?.[own.indexOf(h)];const v=read(source);if(v.errorValue)hold('Source formula error');const note=[source?.note,source?.userEnteredValue?.formulaValue?'원천 수식: '+source.userEnteredValue.formulaValue:null].filter(Boolean).join('\n');return {userEnteredValue:v,...(note?{note}:{}),...(source?.userEnteredFormat?.numberFormat?{userEnteredFormat:{numberFormat:source.userEnteredFormat.numberFormat}}:{})};}))});
  }
  return {headers:[...meta,...headers],rows};
}
// Compare-only: shared input sheet vs each supplier's existing provided sheet.
// Both sides are caller-supplied fresh reads (header row + data rows of typed
// values). No network, no writes, no value normalization beyond the spec's
// equality rule. Policy columns are not compared (spec legacyCompare.policyCompare).
export function compareSharedToLegacy({shared,legacy,binding},spec=inputSpec,now=Date.now()) {
  const rule=spec.legacyCompare;
  if(rule?.mode!=='COMPARE_ONLY_NO_WRITES')hold('Spec legacyCompare must be COMPARE_ONLY_NO_WRITES');
  const times=[shared?.capturedAt,...(legacy??[]).map(l=>l.capturedAt)].map(Date.parse);
  if(times.some(t=>!Number.isFinite(t)||t-now>1000||now-t>rule.maxCaptureSkewMinutes*60000))hold('Fresh captures required on both sides');
  const suppliers=binding?.suppliers??[];
  if(!suppliers.length||new Set(suppliers.map(s=>s.code)).size!==suppliers.length||new Set(suppliers.map(s=>s.title)).size!==suppliers.length)hold('Unique supplier bindings required');
  const notCompared=registered(suppliers,spec,false).map(r=>r.tab);
  const legacyCodes=(legacy??[]).map(l=>l.code);
  if(new Set(legacyCodes).size!==legacyCodes.length)hold('One legacy capture per supplier code required');
  const unboundLegacy=legacyCodes.filter(c=>!suppliers.some(s=>s.code===c));
  const key=v=>String(v??'').replace(/\s+/g,'');
  const text=v=>v===undefined||v===null?'':typeof v==='string'?v.trim():v;
  const same=(a,b)=>{a=text(a);b=text(b);if(a===b)return true;
    const num=x=>typeof x==='number'?x:typeof x==='string'&&/^-?[\d,\s]+(\.\d+)?$/.test(x)&&/\d/.test(x)?Number(x.replace(/[,\s]/g,'')):null;
    const na=num(a),nb=num(b);return (typeof a==='number'||typeof b==='number')&&na!==null&&na===nb;};
  const index=(rows,headers,label)=>{const at=headers.indexOf(rule.key);if(at<0)return null;const map=new Map(),dupes=new Set(),count=new Map();let noKey=0;
    for(const r of rows){if(!r?.some(v=>text(v)!==''))continue;const k=key(r[at]);if(!k){noKey++;continue;}if(map.has(k))dupes.add(k);map.set(k,r);count.set(k,(count.get(k)??0)+1);}
    return {map,dupes,noKey,count};};
  const results=[];
  for(const sup of suppliers){
    const tab=shared?.tabs?.find(t=>t.title===sup.title);
    if(!tab)hold(`Shared tab missing for ${sup.title}`);
    if(JSON.stringify(tab.headers)!==JSON.stringify(spec.inputHeaders))hold(`Shared tab layout differs from ${spec.layoutVersion}: ${sup.title}`);
    const src=(legacy??[]).find(l=>l.code===sup.code);
    if(!src){results.push({code:sup.code,title:sup.title,status:'LEGACY_NOT_CAPTURED'});continue;}
    if(src.complete!==true||src.tab!==rule.legacySourceTab){results.push({code:sup.code,title:sup.title,status:'LEGACY_UNREADABLE'});continue;}
    const named=(src.headers??[]).map(h=>text(h)).filter(h=>h!=='');
    if(new Set(named).size!==named.length){results.push({code:sup.code,title:sup.title,status:'LEGACY_UNREADABLE',reason:'duplicate legacy headers'});continue;}
    const a=index(tab.rows??[],tab.headers),b=index(src.rows??[],src.headers??[]);
    if(!b){results.push({code:sup.code,title:sup.title,status:'LEGACY_UNREADABLE',reason:`no ${rule.key} header`});continue;}
    const fields=Object.entries(rule.fieldMap).filter(([h,old])=>h!==rule.key&&src.headers.includes(old)); // key already matched after normalization
    const notInLegacy=Object.entries(rule.fieldMap).filter(([,old])=>!src.headers.includes(old)).map(([h])=>h);
    const matched=[],different=[],onlyShared=[],onlyLegacy=[];
    for(const [k,row] of a.map){
      if(a.dupes.has(k)||b.dupes.has(k))continue;
      const old=b.map.get(k);if(!old){onlyShared.push(k);continue;}
      const diffs=fields.filter(([h,o])=>!same(row[tab.headers.indexOf(h)],old[src.headers.indexOf(o)])).map(([h])=>h);
      (diffs.length?different:matched).push(diffs.length?{plate:k,fields:diffs}:k);
    }
    for(const k of b.map.keys())if(!a.map.has(k)&&!b.dupes.has(k))onlyLegacy.push(k);
    const duplicates=[...new Set([...a.dupes,...b.dupes])].map(plate=>({plate,shared:a.count.get(plate)??0,legacy:b.count.get(plate)??0}));
    // A missing legacy column means those fields were never compared, so it cannot be IN_SYNC.
    const clean=!different.length&&!onlyShared.length&&!onlyLegacy.length&&!duplicates.length&&!a.noKey&&!b.noKey&&!notInLegacy.filter(h=>h!==rule.key).length;
    results.push({code:sup.code,title:sup.title,status:clean?'IN_SYNC':'DIFFERENT',counts:{matched:matched.length,different:different.length,comparedFields:fields.length,onlyShared:onlyShared.length,onlyLegacy:onlyLegacy.length,duplicates:duplicates.length,sharedRowsWithoutPlate:a.noKey,legacyRowsWithoutPlate:b.noKey},different,onlyShared,onlyLegacy,duplicates,notInLegacy});
  }
  const summary=Object.fromEntries(['IN_SYNC','DIFFERENT','LEGACY_UNREADABLE','LEGACY_NOT_CAPTURED'].map(k=>[k,results.filter(r=>r.status===k).length]));
  return {status:results.every(r=>r.status==='IN_SYNC')&&!unboundLegacy.length?'ALL_IN_SYNC':'NOT_IN_SYNC',scope:'COMPARE_ONLY_VEHICLE_RATE_FIELDS_NO_WRITES_POLICY_NOT_COMPARED',layoutVersion:spec.layoutVersion,summary,unboundLegacy,notCompared,results};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===fs.realpathSync(process.argv[1])){
  try {const compare=process.argv.find(a=>a.startsWith('--compare='))?.slice(10);if(compare){console.log(JSON.stringify(compareSharedToLegacy(JSON.parse(fs.readFileSync(compare,'utf8'))),null,2));}else{const path=process.argv.find(a=>a.startsWith('--input='))?.slice(8);if(!path)hold('--input=private-fresh-readback.json or --compare=private-compare.json required'); console.log(JSON.stringify(planSupplierInput(JSON.parse(fs.readFileSync(path,'utf8'))),null,2));}}catch(e){console.error(e.message);if(e.mismatched)console.error(JSON.stringify(e.mismatched,null,2));process.exitCode=2;}
}
