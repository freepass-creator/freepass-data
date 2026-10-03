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
  const excluded=suppliers.filter(s=>(spec.supplierChannels.notInSharedSheet??[]).some(r=>r.code===s.code||r.name===s.title));
  if(excluded.length)hold(`Direct/own-sheet supplier is excluded from the shared sheet: ${excluded.map(s=>`${s.title}/${s.code}`).join(', ')}`);
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
// One-time supplier input setup: dropdowns only. Runs the full verify gate
// first, then emits a list setDataValidation for spec.dropdowns columns on
// supplier tabs. Free-text columns are left as they are (existing rules kept).
// No values, formats, rows, columns or the formula-driven summary tab are touched.
export function planSupplierDropdowns(input, spec=inputSpec, now=Date.now()) {
  const verified=planSupplierInput(input,spec,now);
  const free=new Set(spec.dropdownPolicy?.freeText??[]);
  const unknown=spec.inputHeaders.filter(h=>!spec.dropdowns?.[h]&&!free.has(h));
  if(unknown.length)hold(`Every column needs a dropdown or a free-text decision: ${unknown.join(', ')}`);
  const requests=[];
  for(const sup of input.binding.suppliers){
    const s=input.spreadsheet.sheets.find(x=>x.properties.sheetId===sup.sheetId);
    const rows=s.properties.gridProperties.rowCount;
    spec.inputHeaders.forEach((h,i)=>{
      const list=spec.dropdowns[h];if(!list)return;
      const range={sheetId:sup.sheetId,startRowIndex:1,endRowIndex:rows,startColumnIndex:i,endColumnIndex:i+1};
      requests.push({setDataValidation:{range,rule:{condition:{type:'ONE_OF_LIST',values:list.map(userEnteredValue=>({userEnteredValue}))},strict:spec.dropdownStrict===true,showCustomUi:true}}});
    });
  }
  return {status:'PLANNED',scope:'SUPPLIER_TAB_DATA_VALIDATION_ONLY',layoutVersion:verified.layoutVersion,spreadsheetId:verified.spreadsheetId,drift:verified.drift,requests};
}
// "One cell, one fact": split combined policy cells (2026-10-03 → -split).
// Each combined value must match its exact shape or the whole plan holds;
// nothing is guessed. Returns the parts in spec.policySplit.columns order.
export function splitPolicyValue(header,value){
  const v=typeof value==='string'?value.trim():value;
  const n=(inputSpec.policySplit.columns[header]??[]).length;
  if(!n)hold(`Not a split column: ${header}`);
  if(v===''||v===undefined||v===null)return Array(n).fill('');
  if(typeof v!=='string')hold(`Non-text value in ${header}`);
  const parts=v.split(' / ').map(x=>x.trim());
  if(parts.some(x=>x===''))hold(`Unparsed ${header}: ${v}`);
  const money=/^[\d,.]+(만원|억원|원)(~[\d,.]+(만원|억원|원))?$|^[\d,.]+~[\d,.]+(만원|억원|원)$/;
  switch(header){
    case '대인/면책': case '자손/면책': case '추가운전': if(parts.length===2)return parts; break;
    case '대물/면책': case '무보험/면책': case '승계': if(parts.length<=2)return [parts[0],parts[1]??'']; break;
    case '운전자범위': {const m=/^개인 (.+)$/.exec(parts[0]??''),k=/^법인 (.+)$/.exec(parts[1]??'');if(parts.length===2&&m&&k)return [m[1],k[1]];break;}
    case '자차/면책': {
      const pct=/^수리비 (\d+%)$/;
      if(parts.length===3&&pct.test(parts[1])&&!pct.test(parts[0])&&!pct.test(parts[2]))return [parts[0],pct.exec(parts[1])[1],parts[2]];
      if(parts.length===2&&!pct.test(parts[0])&&!pct.test(parts[1]))return [parts[0],'',parts[1]];
      if(parts.length===1&&money.test(parts[0]))return ['','',parts[0]];
      break;}
  }
  hold(`Unparsed ${header}: ${v}`);
}
const columnLetter=index=>{let out='';for(index++;index;index=Math.floor((index-1)/26))out=String.fromCharCode(65+(index-1)%26)+out;return out;};
// Moves the workbook from the pre-split layout to spec.layoutVersion: inserts
// the extra columns (inheriting format from the left), rewrites headers, writes
// the split parts, widens the summary tab and regenerates its stacking formula.
export function planPolicySplit(input,spec=inputSpec,now=Date.now()){
  const rule=spec.policySplit,from=spec.legacyLayouts?.[rule?.from];
  if(!rule||!from)hold('Spec policySplit with legacy layout required');
  // The workbook must still be on the pre-split layout; same verify gate.
  planSupplierInput(input,{...spec,inputHeaders:from.inputHeaders,summaryHeaders:from.inputHeaders},now);
  const oldH=from.inputHeaders,newH=spec.inputHeaders;
  const cols=Object.keys(rule.columns).map(h=>({h,old:oldH.indexOf(h),parts:rule.columns[h]}));
  if(cols.some(c=>c.old<0||c.parts.some(p=>!newH.includes(p))))hold('policySplit does not match layouts');
  const requests=[],holds=[];let rowsRead=0;
  for(const sup of input.binding.suppliers){
    const s=input.spreadsheet.sheets.find(x=>x.properties.sheetId===sup.sheetId);
    const block=s.data?.find(d=>(d.startRow??0)===0&&(d.startColumn??0)===0)?.rowData??[];
    if(block.length!==s.properties.gridProperties.rowCount)hold(`${sup.title}: full-height capture required`);
    const parsed=cols.map(c=>({...c,values:block.slice(1).map((r,i)=>{const cell=r.values?.[c.old];
      if(cell?.userEnteredValue?.formulaValue){holds.push(`${sup.title} ${i+2}행 ${c.h}: 수식`);return null;}
      const v=cell?.userEnteredValue?.stringValue??cell?.userEnteredValue?.numberValue??'';
      try{const parts=splitPolicyValue(c.h,v);
        // A split value outside the new dropdown list would show a warning; hold instead of guessing.
        const off=parts.map((x,j)=>[c.parts[j],x]).filter(([p,x])=>x!==''&&!(spec.dropdowns?.[p]??[]).includes(x));
        if(off.length){holds.push(`${sup.title} ${i+2}행 ${off.map(([p,x])=>`${p}=${x}`).join(', ')}: 드롭다운 목록 밖`);return null;}
        return parts;}catch{holds.push(`${sup.title} ${i+2}행 ${c.h}: ${String(v).slice(0,40)}`);return null;}})}));
    for(const c of [...cols].sort((a,b)=>b.old-a.old))if(c.parts.length>1)requests.push({insertDimension:{range:{sheetId:sup.sheetId,dimension:'COLUMNS',startIndex:c.old+1,endIndex:c.old+c.parts.length},inheritFromBefore:true}});
    requests.push({updateCells:{start:{sheetId:sup.sheetId,rowIndex:0,columnIndex:0},rows:[{values:newH.map(stringValue=>({userEnteredValue:{stringValue}}))}],fields:'userEnteredValue'}});
    for(const c of parsed)c.parts.forEach((p,j)=>{
      const at=newH.indexOf(p);
      // Rows after the last non-empty source cell stay empty already; write only up to it.
      const last=c.values.findLastIndex(v=>v&&v.some(x=>x!==''));
      if(last>=0)requests.push({updateCells:{start:{sheetId:sup.sheetId,rowIndex:1,columnIndex:at},rows:c.values.slice(0,last+1).map(v=>({values:[v&&v[j]!==''?{userEnteredValue:{stringValue:v[j]}}:{}]})),fields:'userEnteredValue'}});
      requests.push({updateDimensionProperties:{range:{sheetId:sup.sheetId,dimension:'COLUMNS',startIndex:at,endIndex:at+1},properties:{pixelSize:spec.columnWidths[p]??spec.defaultColumnWidth},fields:'pixelSize'}});
      // Inserted columns inherit the left column's validation; replace it with this column's own list (or clear it).
      const list=spec.dropdowns?.[p],range={sheetId:sup.sheetId,startRowIndex:1,endRowIndex:s.properties.gridProperties.rowCount,startColumnIndex:at,endColumnIndex:at+1};
      requests.push({setDataValidation:list?{range,rule:{condition:{type:'ONE_OF_LIST',values:list.map(userEnteredValue=>({userEnteredValue}))},strict:spec.dropdownStrict===true,showCustomUi:true}}:{range}});
    });
    rowsRead+=Math.max(0,block.length-1);
  }
  if(holds.length)throw Object.assign(new Error(`HOLD: POLICY_SPLIT_UNPARSED — ${holds.length} cell(s); nothing is written`),{holds});
  const summary=input.spreadsheet.sheets.find(x=>x.properties.sheetId===input.binding.summarySheetId);
  const width=summary.properties.gridProperties.columnCount;
  if(width<newH.length)requests.push({insertDimension:{range:{sheetId:summary.properties.sheetId,dimension:'COLUMNS',startIndex:width,endIndex:newH.length},inheritFromBefore:true}});
  const last=columnLetter(newH.length-1);
  const stack=input.binding.suppliers.map(sup=>{const t=input.spreadsheet.sheets.find(x=>x.properties.sheetId===sup.sheetId);const r=`'${sup.title.replaceAll("'","''")}'!A2:${last}${t.properties.gridProperties.rowCount}`;return `ARRAYFORMULA(IF(ISBLANK(${r}),"",${r}))`;}).join(',');
  requests.push({updateCells:{start:{sheetId:summary.properties.sheetId,rowIndex:0,columnIndex:0},rows:[{values:newH.map(stringValue=>({userEnteredValue:{stringValue}}))},{values:[{userEnteredValue:{formulaValue:`=LET(src,VSTACK(${stack}),keep,BYROW(src,LAMBDA(r,SUM(ARRAYFORMULA(LEN(r)))>0)),IFNA(FILTER(src,keep),""))`}}]}],fields:'userEnteredValue'}});
  return {status:'PLANNED',scope:'POLICY_COLUMN_SPLIT_VALUES_HEADERS_SUMMARY',from:rule.from,to:spec.layoutVersion,tabs:input.binding.suppliers.length,rowsRead,requests};
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
  try {const split=process.argv.find(a=>a.startsWith('--split='))?.slice(8);if(split){console.log(JSON.stringify(planPolicySplit(JSON.parse(split==='-'?fs.readFileSync(0,'utf8'):fs.readFileSync(split,'utf8'))),null,2));process.exit(0);}const dropdowns=process.argv.find(a=>a.startsWith('--dropdowns='))?.slice(12);const compare=process.argv.find(a=>a.startsWith('--compare='))?.slice(10);if(dropdowns){console.log(JSON.stringify(planSupplierDropdowns(JSON.parse(dropdowns==='-'?fs.readFileSync(0,'utf8'):fs.readFileSync(dropdowns,'utf8'))),null,2));}else if(compare){console.log(JSON.stringify(compareSharedToLegacy(JSON.parse(fs.readFileSync(compare,'utf8'))),null,2));}else{const path=process.argv.find(a=>a.startsWith('--input='))?.slice(8);if(!path)hold('--input=private-fresh-readback.json or --compare=private-compare.json required'); console.log(JSON.stringify(planSupplierInput(JSON.parse(fs.readFileSync(path,'utf8'))),null,2));}}catch(e){console.error(e.message);if(e.mismatched)console.error(JSON.stringify(e.mismatched,null,2));process.exitCode=2;}
}
