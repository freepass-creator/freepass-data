import fs from 'node:fs';
import {createHash} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { specification } from './sheet-presentation.mjs';
export const inputSpec = JSON.parse(fs.readFileSync(new URL('../contracts/supplier-input-sheet-spec.v1.json', import.meta.url), 'utf8'));
const hold = message => { throw new Error(`HOLD: ${message}`); };
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
  const summary=sheets.find(s=>s.properties.sheetId===binding.summarySheetId), guide=sheets.find(s=>s.properties.sheetId===binding.guideSheetId);
  if(!summary||!guide||summary===guide||suppliers.some(s=>[binding.summarySheetId,binding.guideSheetId].includes(s.sheetId)))hold('Summary/guide binding invalid');
  const allowed=new Set([binding.summarySheetId,binding.guideSheetId,...suppliers.map(s=>s.sheetId)]);
  if(sheets.some(s=>!s.properties.hidden&&!allowed.has(s.properties.sheetId)))hold('Unbound visible sheet');
  const mismatched=[], drift=[];
  for(const entry of [{sheetId:binding.summarySheetId,title:spec.summaryTitle,summary:true},...suppliers]) {
    const s=sheets.find(s=>s.properties.sheetId===entry.sheetId); if(!s)hold('Supplier sheet missing');
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
if(process.argv[1]&&fileURLToPath(import.meta.url)===fs.realpathSync(process.argv[1])){
  try {const path=process.argv.find(a=>a.startsWith('--input='))?.slice(8);if(!path)hold('--input=private-fresh-readback.json required'); console.log(JSON.stringify(planSupplierInput(JSON.parse(fs.readFileSync(path,'utf8'))),null,2));}catch(e){console.error(e.message);if(e.mismatched)console.error(JSON.stringify(e.mismatched,null,2));process.exitCode=2;}
}
