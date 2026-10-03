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
  const excluded=suppliers.filter(s=>[...(spec.supplierChannels.notInSharedSheet??[]),...(spec.supplierChannels.excludedFromSharedSheet??[])].some(r=>r.code===s.code||(r.name??r.tab)===s.title));
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
  const unknown=spec.inputHeaders.filter(h=>[Boolean(spec.dropdowns?.[h]),Boolean(spec.vehicleMaster?.columns?.[h]),free.has(h)].filter(Boolean).length!==1);
  if(unknown.length)hold(`Every column needs exactly one dropdown, vehicle-master range or free-text decision: ${unknown.join(', ')}`);
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
// Full master lists, not per-row dependent lists. Only the hidden list tab
// receives values; supplier tabs receive validation rules only.
export function planVehicleMasterDropdowns(input,spec=inputSpec,now=Date.now()){
  planSupplierInput(input,spec,now);
  const rule=spec.vehicleMaster,master=input.master;
  const names=['제조사','모델','세부모델','세부트림'];
  if(!rule||rule.sheetId!==9100||rule.tab!=='차종목록'||rule.hidden!==true||JSON.stringify(rule.columns)!==JSON.stringify({제조사:'A',모델:'B',세부모델:'C',세부트림:'D'}))hold('Vehicle master spec invalid');
  if(![rule.source,rule.source.split(' / 탭 ')[0]].includes(master?.source)||!Number.isFinite(Date.parse(master?.readAt)))hold('Vehicle master provenance required');
  if(!Array.isArray(master.header)||names.some(h=>master.header.filter(x=>x===h).length!==1))hold('Vehicle master columns missing or duplicated');
  if(!Array.isArray(master.rows)||master.rows.some(r=>!Array.isArray(r)))hold('Vehicle master rows required');
  // F03 keeps merged duplicates as marked rows; they stay in F03 but never reach the dropdown lists.
  const excludes=(rule.excludeRows??[]).map(x=>{const at=master.header.indexOf(x.header);if(at<0||master.header.filter(h=>h===x.header).length!==1||typeof x.startsWith!=='string'||!x.startsWith)hold(`Vehicle master exclude column missing: ${x.header}`);return {at,prefix:x.startsWith};});
  const kept=master.rows.filter(r=>!excludes.some(x=>typeof r[x.at]==='string'&&r[x.at].trim().startsWith(x.prefix)));
  const lists=names.map(h=>{
    const at=master.header.indexOf(h),values=kept.map(r=>r[at]).filter(v=>v!==undefined&&v!==null&&v!=='');
    if(values.some(v=>typeof v!=='string'))hold(`Vehicle master non-text value: ${h}`);
    const list=[...new Set(values.filter(v=>v.trim()!==''))];
    if(!list.length)hold(`Vehicle master empty list: ${h}`);
    return list;
  });
  const height=Math.max(...lists.map(l=>l.length))+1;
  const existing=input.spreadsheet.sheets.find(s=>s.properties.sheetId===rule.sheetId);
  if([input.binding.summarySheetId,input.binding.guideSheetId,...input.binding.suppliers.map(s=>s.sheetId)].includes(rule.sheetId))hold('Vehicle master tab must be unbound');
  if(input.spreadsheet.sheets.some(s=>s.properties.title===rule.tab&&s.properties.sheetId!==rule.sheetId))hold('Vehicle master title belongs to another sheet');
  const requests=[];
  if(existing){
    const p=existing.properties;
    if(p.title!==rule.tab||p.hidden!==true)hold('Vehicle master tab title/hidden mismatch');
    if(!(p.gridProperties?.rowCount>=height)||!(p.gridProperties?.columnCount>=4))hold('Vehicle master grid too small');
    requests.push({updateCells:{range:{sheetId:rule.sheetId,startColumnIndex:0,endColumnIndex:4},fields:'userEnteredValue'}});
  }else requests.push({addSheet:{properties:{sheetId:rule.sheetId,title:rule.tab,hidden:true,gridProperties:{rowCount:height,columnCount:4}}}});
  const rows=[{values:names.map(stringValue=>({userEnteredValue:{stringValue}}))}];
  for(let i=0;i<height-1;i++)rows.push({values:lists.map(list=>i<list.length?{userEnteredValue:{stringValue:list[i]}}:{})});
  requests.push({updateCells:{start:{sheetId:rule.sheetId,rowIndex:0,columnIndex:0},rows,fields:'userEnteredValue'}});
  for(const sup of input.binding.suppliers){
    const s=input.spreadsheet.sheets.find(s=>s.properties.sheetId===sup.sheetId),headers=headersOf(s),end=s.properties.gridProperties.rowCount;
    if(!Number.isInteger(end)||end<2)hold('Supplier rowCount invalid');
    names.forEach((h,i)=>{
      const at=headers.indexOf(h);if(at<0)hold(`Vehicle master target column missing: ${h}`);
      const col=rule.columns[h],range={sheetId:sup.sheetId,startRowIndex:1,endRowIndex:end,startColumnIndex:at,endColumnIndex:at+1};
      requests.push({setDataValidation:{range,rule:{condition:{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='${rule.tab}'!$${col}$2:$${col}$${lists[i].length+1}`}]},strict:spec.dropdownStrict===true,showCustomUi:true}}});
    });
  }
  return {status:'PLANNED',scope:'VEHICLE_MASTER_RANGE_DROPDOWNS',counts:Object.fromEntries(names.map((h,i)=>[h,lists[i].length])),requests};
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
  const oldH=from.inputHeaders,newH=rule.to===spec.layoutVersion?spec.inputHeaders:spec.legacyLayouts?.[rule.to]?.inputHeaders;
  if(!newH)hold(`Target layout ${rule.to} missing`);
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
  return {status:'PLANNED',scope:'POLICY_COLUMN_SPLIT_VALUES_HEADERS_SUMMARY',from:rule.from,to:rule.to,tabs:input.binding.suppliers.length,rowsRead,requests};
}
// Column order change (legacy layout → spec layout): append the new empty
// columns at the end, move every column into place left to right (whole
// columns move with values, notes, formats and validation), then rewrite the
// header row with the renamed labels. No cell value is rewritten.
export function planLayoutReorder(input,spec=inputSpec,now=Date.now()){
  const rule=spec.layoutReorder,from=spec.legacyLayouts?.[rule?.from];
  if(!rule||!from)hold('Spec layoutReorder with legacy layout required');
  planSupplierInput(input,{...spec,inputHeaders:from.inputHeaders,summaryHeaders:from.inputHeaders},now);
  const oldH=from.inputHeaders,newH=rule.to===spec.layoutVersion?spec.inputHeaders:spec.legacyLayouts?.[rule.to]?.inputHeaders;
  if(!newH)hold(`Target layout ${rule.to} missing`);
  // Map each new header to the old column it comes from (renames), or null for a new column.
  const source=newH.map(h=>Object.hasOwn(rule.renames,h)?rule.renames[h]:rule.newColumns.includes(h)?null:h);
  if(source.some((o,i)=>o!==null&&!oldH.includes(o))||new Set(source.filter(Boolean)).size!==oldH.length||rule.newColumns.length!==newH.length-oldH.length)hold('layoutReorder does not account for every column');
  const requests=[];
  for(const sup of input.binding.suppliers){
    const s=input.spreadsheet.sheets.find(x=>x.properties.sheetId===sup.sheetId);
    if(s.properties.gridProperties.columnCount!==oldH.length)hold(`${sup.title}: column count must equal the legacy layout`);
    // Working model of the current column order; new columns get placeholder ids.
    const order=[...oldH,...rule.newColumns.map(h=>`\u0000new:${h}`)];
    requests.push({insertDimension:{range:{sheetId:sup.sheetId,dimension:'COLUMNS',startIndex:oldH.length,endIndex:newH.length},inheritFromBefore:true}});
    newH.forEach((h,i)=>{
      const id=source[i]??`\u0000new:${h}`,at=order.indexOf(id);
      if(at===i)return;
      if(at<i)hold('reorder invariant broken');
      requests.push({moveDimension:{source:{sheetId:sup.sheetId,dimension:'COLUMNS',startIndex:at,endIndex:at+1},destinationIndex:i}});
      order.splice(i,0,order.splice(at,1)[0]);
    });
    requests.push({updateCells:{start:{sheetId:sup.sheetId,rowIndex:0,columnIndex:0},rows:[{values:newH.map(stringValue=>({userEnteredValue:{stringValue}}))}],fields:'userEnteredValue'}});
    for(const h of rule.newColumns){const at=newH.indexOf(h);
      requests.push({updateDimensionProperties:{range:{sheetId:sup.sheetId,dimension:'COLUMNS',startIndex:at,endIndex:at+1},properties:{pixelSize:spec.columnWidths[h]??spec.defaultColumnWidth},fields:'pixelSize'}});
      // Appended columns inherit the last column's rule; new columns start without one.
      requests.push({setDataValidation:{range:{sheetId:sup.sheetId,startRowIndex:1,endRowIndex:s.properties.gridProperties.rowCount,startColumnIndex:at,endColumnIndex:at+1}}});}
  }
  const summary=input.spreadsheet.sheets.find(x=>x.properties.sheetId===input.binding.summarySheetId);
  const width=summary.properties.gridProperties.columnCount;
  if(width<newH.length)requests.push({insertDimension:{range:{sheetId:summary.properties.sheetId,dimension:'COLUMNS',startIndex:width,endIndex:newH.length},inheritFromBefore:true}});
  const last=columnLetter(newH.length-1);
  const stack=input.binding.suppliers.map(sup=>{const t=input.spreadsheet.sheets.find(x=>x.properties.sheetId===sup.sheetId);const r=`'${sup.title.replaceAll("'","''")}'!A2:${last}${t.properties.gridProperties.rowCount}`;return `ARRAYFORMULA(IF(ISBLANK(${r}),"",${r}))`;}).join(',');
  requests.push({updateCells:{start:{sheetId:summary.properties.sheetId,rowIndex:0,columnIndex:0},rows:[{values:newH.map(stringValue=>({userEnteredValue:{stringValue}}))},{values:[{userEnteredValue:{formulaValue:`=LET(src,VSTACK(${stack}),keep,BYROW(src,LAMBDA(r,SUM(ARRAYFORMULA(LEN(r)))>0)),IFNA(FILTER(src,keep),""))`}}]}],fields:'userEnteredValue'}});
  return {status:'PLANNED',scope:'COLUMN_ORDER_AND_HEADERS_NO_VALUE_REWRITE',from:rule.from,to:rule.to,tabs:input.binding.suppliers.length,requests};
}
// Add new columns after one anchor column (legacy layout → spec layout) and
// optionally fill only those new columns from caller-supplied, plate-matched
// rows (input.fill[sheetId] = [{row, values:{header:value}}]). Existing cells
// are never rewritten.
export function planColumnAdd(input,spec=inputSpec,now=Date.now()){
  const rule=spec.columnAdd,from=spec.legacyLayouts?.[rule?.from];
  if(!rule||!from)hold('Spec columnAdd with legacy layout required');
  planSupplierInput(input,{...spec,inputHeaders:from.inputHeaders,summaryHeaders:from.inputHeaders},now);
  const oldH=from.inputHeaders,newH=rule.to===spec.layoutVersion?spec.inputHeaders:spec.legacyLayouts?.[rule.to]?.inputHeaders,at=oldH.indexOf(rule.after)+1;
  if(!newH)hold(`Target layout ${rule.to} missing`);
  if(at<1||JSON.stringify([...oldH.slice(0,at),...rule.columns,...oldH.slice(at)])!==JSON.stringify(newH))hold('columnAdd does not produce the spec layout');
  const requests=[],fill=input.fill??{};
  for(const id of Object.keys(fill))if(!input.binding.suppliers.some(s=>String(s.sheetId)===id))hold(`fill for unbound sheet ${id}`);
  for(const sup of input.binding.suppliers){
    const s=input.spreadsheet.sheets.find(x=>x.properties.sheetId===sup.sheetId),rc=s.properties.gridProperties.rowCount;
    requests.push({insertDimension:{range:{sheetId:sup.sheetId,dimension:'COLUMNS',startIndex:at,endIndex:at+rule.columns.length},inheritFromBefore:true}});
    requests.push({updateCells:{start:{sheetId:sup.sheetId,rowIndex:0,columnIndex:0},rows:[{values:newH.map(stringValue=>({userEnteredValue:{stringValue}}))}],fields:'userEnteredValue'}});
    rule.columns.forEach((h,j)=>{const c=at+j,range={sheetId:sup.sheetId,startRowIndex:1,endRowIndex:rc,startColumnIndex:c,endColumnIndex:c+1},list=spec.dropdowns[h];
      requests.push({updateDimensionProperties:{range:{sheetId:sup.sheetId,dimension:'COLUMNS',startIndex:c,endIndex:c+1},properties:{pixelSize:spec.columnWidths[h]??spec.defaultColumnWidth},fields:'pixelSize'}});
      // Inherited from the anchor column (#,##0): numeric columns get plain numbers, the rest plain text.
      const numberFormat=spec.numberHeaders.includes(h)?{type:'NUMBER',pattern:'0.############'}:{type:'TEXT'};
      requests.push({repeatCell:{range,cell:{userEnteredFormat:{numberFormat,horizontalAlignment:'CENTER'}},fields:'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment'}});
      requests.push({setDataValidation:list?{range,rule:{condition:{type:'ONE_OF_LIST',values:list.map(userEnteredValue=>({userEnteredValue}))},strict:spec.dropdownStrict===true,showCustomUi:true}}:{range}});});
    const seen=new Set();
    for(const {row,values} of fill[String(sup.sheetId)]??[]){
      if(!Number.isInteger(row)||row<1||row>=rc)hold(`${sup.title}: fill row ${row} out of range`);
      if(seen.has(row))hold(`${sup.title}: fill row ${row} appears twice`);seen.add(row);
      if(Object.keys(values).some(h=>!rule.columns.includes(h)))hold(`${sup.title}: fill may only touch the new columns`);
      requests.push({updateCells:{start:{sheetId:sup.sheetId,rowIndex:row,columnIndex:at},rows:[{values:rule.columns.map(h=>{const v=values[h];if(v===undefined||v==='')return {};
        // Dropdown columns store the exact list text so the value matches the list; numeric columns keep numbers.
        if(spec.dropdowns[h]?.includes(String(v)))return {userEnteredValue:{stringValue:String(v)}};
        return {userEnteredValue:typeof v==='number'&&spec.numberHeaders.includes(h)?{numberValue:v}:{stringValue:String(v)}};})}],fields:'userEnteredValue'}});
    }
  }
  const summary=input.spreadsheet.sheets.find(x=>x.properties.sheetId===input.binding.summarySheetId);
  const width=summary.properties.gridProperties.columnCount;
  if(width<newH.length)requests.push({insertDimension:{range:{sheetId:summary.properties.sheetId,dimension:'COLUMNS',startIndex:width,endIndex:newH.length},inheritFromBefore:true}});
  const last=columnLetter(newH.length-1);
  const stack=input.binding.suppliers.map(sup=>{const t=input.spreadsheet.sheets.find(x=>x.properties.sheetId===sup.sheetId);const r=`'${sup.title.replaceAll("'","''")}'!A2:${last}${t.properties.gridProperties.rowCount}`;return `ARRAYFORMULA(IF(ISBLANK(${r}),"",${r}))`;}).join(',');
  requests.push({updateCells:{start:{sheetId:summary.properties.sheetId,rowIndex:0,columnIndex:0},rows:[{values:newH.map(stringValue=>({userEnteredValue:{stringValue}}))},{values:[{userEnteredValue:{formulaValue:`=LET(src,VSTACK(${stack}),keep,BYROW(src,LAMBDA(r,SUM(ARRAYFORMULA(LEN(r)))>0)),IFNA(FILTER(src,keep),""))`}}]}],fields:'userEnteredValue'}});
  return {status:'PLANNED',scope:'ADD_COLUMNS_AND_FILL_NEW_COLUMNS_ONLY',from:rule.from,to:rule.to,tabs:input.binding.suppliers.length,requests};
}
// Layout change with removals (legacy layout → spec layout): link each plate
// to its photo URL first when configured (plate text unchanged), delete the removed columns
// right to left, then move the remaining columns into place left to right and
// rewrite the header row. No cell value is rewritten. Back up before running.
export function planLayoutChange(input,spec=inputSpec,now=Date.now()){
  const rule=spec.layoutChange,from=spec.legacyLayouts?.[rule?.from];
  if(!rule||!from)hold('Spec layoutChange with legacy layout required');
  if(!Array.isArray(rule.remove)||new Set(rule.remove).size!==rule.remove.length)hold('layoutChange remove must be a unique column list');
  planSupplierInput(input,{...spec,inputHeaders:from.inputHeaders,summaryHeaders:from.inputHeaders},now);
  const oldH=from.inputHeaders,newH=rule.to===spec.layoutVersion?spec.inputHeaders:spec.legacyLayouts?.[rule.to]?.inputHeaders;
  if(!newH)hold(`Target layout ${rule.to} missing`);
  const kept=oldH.filter(h=>!rule.remove.includes(h));
  if(rule.remove.some(h=>!oldH.includes(h))||kept.length!==newH.length||[...kept].sort().join()!==[...newH].sort().join())hold('layoutChange does not account for every column');
  const plateAt=oldH.indexOf('차량번호'),photoAt=oldH.indexOf(rule.linkPlateFrom);
  if(rule.linkPlateFrom!==undefined&&(typeof rule.linkPlateFrom!=='string'||photoAt<0||plateAt<0))hold('layoutChange photo source and plate columns required');
  const requests=[];let linked=0;
  for(const sup of input.binding.suppliers){
    const s=input.spreadsheet.sheets.find(x=>x.properties.sheetId===sup.sheetId),rc=s.properties.gridProperties.rowCount;
    if(s.properties.gridProperties.columnCount!==oldH.length)hold(`${sup.title}: column count must equal the legacy layout`);
    const block=s.data?.find(d=>(d.startRow??0)===0&&(d.startColumn??0)===0)?.rowData??[];
    if(photoAt>=0&&block.length!==rc)hold(`${sup.title}: full-height capture of 차량번호/${rule.linkPlateFrom} required`);
    if(photoAt>=0)block.slice(1).forEach((r,i)=>{
      const plate=r.values?.[plateAt],photo=r.values?.[photoAt],read=c=>c?.effectiveValue?.stringValue??c?.userEnteredValue?.stringValue??'';
      const uri=read(photo).trim();if(!uri)return;
      if(!/^https?:\/\//i.test(uri))hold(`${sup.title} ${i+2}행: 사진 주소가 http(s)가 아님`);
      if(!read(plate).trim())hold(`${sup.title} ${i+2}행: 사진 주소는 있는데 차량번호가 없음`);
      const formula=plate?.userEnteredValue?.formulaValue;
      if(formula){
        // Plate already written as =HYPERLINK("<same photo url>","<plate>"): it already opens the photo.
        const m=/^=HYPERLINK\("([^"]+)"\s*,\s*"[^"]*"\)$/i.exec(formula.trim());
        if(m&&m[1]===uri)return;
        hold(`${sup.title} ${i+2}행: 차량번호가 수식이고 사진 주소와 다름`);
      }
      requests.push({repeatCell:{range:{sheetId:sup.sheetId,startRowIndex:i+1,endRowIndex:i+2,startColumnIndex:plateAt,endColumnIndex:plateAt+1},cell:{userEnteredFormat:{textFormat:{link:{uri}}}},fields:'userEnteredFormat.textFormat.link'}});linked++;});
    const order=[...oldH];
    for(const h of [...rule.remove].sort((a,b)=>oldH.indexOf(b)-oldH.indexOf(a))){const at=order.indexOf(h);
      requests.push({deleteDimension:{range:{sheetId:sup.sheetId,dimension:'COLUMNS',startIndex:at,endIndex:at+1}}});order.splice(at,1);}
    newH.forEach((h,i)=>{const at=order.indexOf(h);if(at===i)return;if(at<i)hold('reorder invariant broken');
      requests.push({moveDimension:{source:{sheetId:sup.sheetId,dimension:'COLUMNS',startIndex:at,endIndex:at+1},destinationIndex:i}});order.splice(i,0,order.splice(at,1)[0]);});
    requests.push({updateCells:{start:{sheetId:sup.sheetId,rowIndex:0,columnIndex:0},rows:[{values:newH.map(stringValue=>({userEnteredValue:{stringValue}}))}],fields:'userEnteredValue'}});
  }
  const summary=input.spreadsheet.sheets.find(x=>x.properties.sheetId===input.binding.summarySheetId);
  const last=columnLetter(newH.length-1);
  const stack=input.binding.suppliers.map(sup=>{const t=input.spreadsheet.sheets.find(x=>x.properties.sheetId===sup.sheetId);const r=`'${sup.title.replaceAll("'","''")}'!A2:${last}${t.properties.gridProperties.rowCount}`;return `ARRAYFORMULA(IF(ISBLANK(${r}),"",${r}))`;}).join(',');
  // Rewrite the summary first so its spill never targets the columns deleted next.
  requests.push({updateCells:{start:{sheetId:summary.properties.sheetId,rowIndex:0,columnIndex:0},rows:[{values:newH.map(stringValue=>({userEnteredValue:{stringValue}}))},{values:[{userEnteredValue:{formulaValue:`=LET(src,VSTACK(${stack}),keep,BYROW(src,LAMBDA(r,SUM(ARRAYFORMULA(LEN(r)))>0)),IFNA(FILTER(src,keep),""))`}}]}],fields:'userEnteredValue'}});
  const width=summary.properties.gridProperties.columnCount;
  if(width>newH.length)requests.push({updateCells:{range:{sheetId:summary.properties.sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:newH.length,endColumnIndex:width},fields:'userEnteredValue'}},{deleteDimension:{range:{sheetId:summary.properties.sheetId,dimension:'COLUMNS',startIndex:newH.length,endIndex:width}}});
  return {status:'PLANNED',scope:'LAYOUT_CHANGE_LINK_DELETE_MOVE_NO_VALUE_REWRITE',from:rule.from,to:rule.to,tabs:input.binding.suppliers.length,platesLinked:linked,requests};
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
  legacy=(legacy??[]).filter(l=>!(spec.supplierChannels.excludedFromSharedSheet??[]).some(s=>s.code===l.code));
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
// Canon tools are offline: no credentials, transport or writes. Sparse reads never
// establish whole-grid coverage. Coordinates, not vehicle identifiers, identify HOLDs.
const canonClone = v => structuredClone(v);
const canonKey = v => JSON.stringify(v, function(k,x){return x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x;});
const canonEqual = (a,b) => canonKey(a)===canonKey(b);
function canonTabs(snapshot,spec){
  const book=snapshot.spreadsheet??snapshot,all=book?.sheets;
  if(!Array.isArray(all)||!all.length)hold('Canon requires native Sheets GridData');
  if(book.spreadsheetId&&Object.values(specification.workbooks).some(w=>w.spreadsheetId===book.spreadsheetId))hold('Production F01/F86 is not an input workbook');
  if(new Set(all.map(s=>s.properties?.sheetId)).size!==all.length||new Set(all.map(s=>s.properties?.title)).size!==all.length)hold('Canon duplicate tabs');
  const titles=[spec.summaryTitle,...spec.supplierChannels.sharedInputSheet.map(s=>s.tab)];
  const tabs=titles.map(t=>all.find(s=>s.properties?.title===t));
  if(tabs.some(t=>!t))hold('Canon registered tabs missing');
  // canonCaptureRequest reads formats only; a check without the value capture merged in must not run.
  if(tabs.some(t=>!headersOf(t).some(Boolean)))hold('Canon header values missing: merge the canonValueCaptureRequest result with mergeCanonCaptures');
  if(spec.inputHeaders.some(h=>!spec.valueFormats?.[h]))hold('Canon valueFormats incomplete');
  return tabs.map(s=>{
    const rows=new Map(),columns=new Map(),heights=new Map();
    const g=s.properties.gridProperties;
    if(!Number.isInteger(g?.rowCount)||g.rowCount<2||!Number.isInteger(g.columnCount))hold('Canon grid dimensions required');
    for(const d of s.data??[]){
      const sr=d.startRow??0,sc=d.startColumn??0;
      for(const [i,r] of (d.rowData??[]).entries()){
        const at=sr+i;if(at>=g.rowCount)hold('Canon row outside grid');
        const row=rows.get(at)??new Map();
        // API trailing omitted cells in an observed row are empty; omitted rows
        // are unknown. Partial-column captures cannot establish full row coverage.
        for(let j=0;j<(r.values?.length??0);j++){if(sc+j>=g.columnCount||row.has(sc+j))hold('Canon overlapping or out-of-grid GridData');row.set(sc+j,r.values[j]);}
        rows.set(at,row);
      }
      (d.columnMetadata??[]).forEach((v,i)=>columns.set(sc+i,v));
      (d.rowMetadata??[]).forEach((v,i)=>heights.set(sr+i,v));
      if(sc!==0)hold('Canon full-width A1 GridData required');
    }
    if(!rows.has(0))hold('Canon header evidence required');
    return {sheet:s,id:s.properties.sheetId,title:s.properties.title,g,rows,columns,heights};
  });
}
// Transition gate: verify the prospective archive state using the existing
// binding/inventory/freshness gate; never mutate the caller's capture.
export function planExcludeSupplierTab(input,spec=inputSpec,now=Date.now()){
  const excluded=spec.supplierChannels.excludedFromSharedSheet??[];
  if(!excluded.length)hold('Excluded supplier decision required');
  const candidate=structuredClone(input),archived=[];
  if(!Array.isArray(candidate.binding?.suppliers))hold('Supplier bindings required');
  for(const entry of excluded){
    const matches=candidate.spreadsheet?.sheets?.filter(s=>s.properties.title===entry.tab)??[];
    if(matches.length!==1)hold('Excluded supplier tab must exist exactly once');
    const tab=matches[0],bound=candidate.binding?.suppliers?.filter(s=>s.code===entry.code||s.title===entry.tab||s.sheetId===tab.properties.sheetId)??[];
    if(bound.length>1||bound.some(s=>s.code!==entry.code||s.title!==entry.tab||s.sheetId!==tab.properties.sheetId))hold('Excluded supplier binding mismatch');
    candidate.binding.suppliers=candidate.binding.suppliers.filter(s=>!bound.includes(s));
    tab.properties.hidden=true;archived.push(tab.properties.sheetId);
  }
  const verified=planSupplierInput(candidate,spec,now),last=columnLetter(spec.inputHeaders.length-1);
  const stack=candidate.binding.suppliers.map(sup=>{
    const tab=candidate.spreadsheet.sheets.find(s=>s.properties.sheetId===sup.sheetId),end=tab.properties.gridProperties.rowCount;
    if(!Number.isInteger(end)||end<2)hold('Supplier rowCount invalid');
    const r=`'${sup.title.replaceAll("'","''")}'!A2:${last}${end}`;
    return `ARRAYFORMULA(IF(ISBLANK(${r}),"",${r}))`;
  }).join(',');
  const formulaValue=`=LET(src,VSTACK(${stack}),keep,BYROW(src,LAMBDA(r,SUM(ARRAYFORMULA(LEN(r)))>0)),IFNA(FILTER(src,keep),""))`;
  return {status:'PLANNED',scope:'EXCLUDED_SUPPLIER_ARCHIVE_AND_SUMMARY_ONLY',spreadsheetId:verified.spreadsheetId,supplierCount:candidate.binding.suppliers.length,requests:[
    {updateCells:{start:{sheetId:candidate.binding.summarySheetId,rowIndex:1,columnIndex:0},rows:[{values:[{userEnteredValue:{formulaValue}}]}],fields:'userEnteredValue'}},
    ...archived.map(sheetId=>({updateSheetProperties:{properties:{sheetId,hidden:true},fields:'hidden'}}))
  ]};
}
const canonCell=(t,r,c)=>t.rows.get(r)?.get(c)??{};
const canonCoverage=t=>({tab:t.title,observedRows:t.rows.size,totalRows:t.g.rowCount,complete:t.rows.size===t.g.rowCount});
const canonValue=c=>c.effectiveValue??c.userEnteredValue??{};
function canonNumberFormat(h,spec){
  const f=spec.valueFormats[h];
  if(f.kind==='date')return {type:'DATE',pattern:f.pattern};
  if(['integer','decimal','year'].includes(f.kind))return {type:'NUMBER',pattern:f.pattern};
  return null;
}
function canonCheck(c,h,spec){
  if(c.userEnteredValue?.formulaValue&&!c.effectiveValue)return {bad:true,reason:'FORMULA_EFFECTIVE_VALUE_MISSING'};
  const v=canonValue(c),raw=v.stringValue??v.numberValue??v.boolValue;
  if(v.errorValue)return {bad:true,reason:'FORMULA_ERROR'};
  if(raw===undefined||raw==='')return {bad:false};
  const f=spec.valueFormats[h],s=String(raw),trim=s.trim(),fmt=canonNumberFormat(h,spec);
  const finish=value=>{
    const target=typeof value==='number'?{numberValue:value}:{stringValue:value};
    const formatBad=fmt&&!canonEqual(c.userEnteredFormat?.numberFormat,fmt);
    const valueBad=!canonEqual(c.userEnteredValue??v,target);
    return {bad:Boolean(valueBad||formatBad),target,format:fmt,valueBad,formatBad};
  };
  let out;
  if(f.kind==='date'){
    let serial;
    if(typeof raw==='number'&&Number.isInteger(raw))serial=raw;
    else {const m=trim.match(/^(\d{4}|\d{2})([-.])\s*(\d{1,2})\2\s*(\d{1,2})$/);if(m){const y=Number(m[1])+(m[1].length===2?2000:0),mo=Number(m[3]),d=Number(m[4]),date=new Date(Date.UTC(y,mo-1,d));if(date.getUTCFullYear()===y&&date.getUTCMonth()===mo-1&&date.getUTCDate()===d)serial=(date.getTime()-Date.UTC(1899,11,30))/86400000;}}
    const y=new Date(Date.UTC(1899,11,30)+(serial??NaN)*86400000).getUTCFullYear();
    out=Number.isInteger(serial)&&y>=2000&&y<=2099?finish(serial):{bad:true,reason:'INVALID_OR_AMBIGUOUS_DATE'};
  }else if(['integer','decimal','year'].includes(f.kind)){
    const valid=typeof raw==='number'&&Number.isFinite(raw)&&raw>=0&&(f.kind==='decimal'||Number.isSafeInteger(raw));
    const numeric=(f.kind==='decimal'?/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,3})?$/:/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/).test(trim);
    const n=valid?raw:numeric?Number(trim.replaceAll(',','')):NaN;
    out=Number.isFinite(n)&&(f.kind==='decimal'?Number.isSafeInteger(Math.round(n*1000)):Number.isSafeInteger(n))&&(f.kind!=='year'||n>=1900&&n<=2099)?finish(n):{bad:true,reason:'NUMBER_UNIT_OR_PRECISION_UNKNOWN'};
  }else if(f.kind==='text')out={bad:typeof raw!=='string'||trim!==s,reason:'PRESERVE_FREE_TEXT'};
  else {
    let target=trim;
    if(f.kind==='age')target=trim.replace(h==='기본연령'?/^(만 \d{1,3}세) 이상$/:/^(만 \d{1,3}세) 이하$/,'$1');
    if(f.kind==='duration')target=trim.replace(/^(\d+년) 이상$/,'$1');
    if(f.kind==='distance')target=trim.replace(/^연 /,'');
    if(f.kind==='seats')target=trim.replace(/^(\d+)인승$/,'$1');
    if(['분납','추가운전인원'].includes(h))target=trim.replace(/^(\d+(?:회|인))까지$/,'$1');
    if(h==='개인운전자'&&trim==='계약자 본인')target='본인';
    const accepted=(f.dropdown??[]).includes(target)||f.kind==='age'&&/^만 (?:[1-9]\d?|1[01]\d|120)세$/.test(target)||f.kind==='duration'&&/^[1-9]\d*년$/.test(target)||f.kind==='distance'&&/^(?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{0,2})km$/.test(target)||f.kind==='policyMoney'&&/^(?:\d+(?:\.\d+)?(?:~\d+(?:\.\d+)?)?만원|\d+억원|\d+천(?:\d+백)?만원|\d+억\d+천만원|대여료의 \d+(?:\.\d+)?%)$/.test(target);
    out=accepted?finish(target):{bad:true,reason:'UNCONFIRMED_VALUE_OR_UNIT'};
  }
  if(out.bad&&spec.valueFormatsUndecided?.some(x=>x.column===h))return {bad:true,reason:'UNDECIDED_COLUMN'};
  if(out.bad&&c.userEnteredValue?.formulaValue)return {bad:true,reason:'FORMULA_PRESERVED'};
  return out;
}
const canonSafeExample=(c,h)=>h==='차량번호'||h==='계좌번호'?'[비공개]':String(canonValue(c).stringValue??canonValue(c).numberValue??'[오류]').replace(/\d{2,3}\s*[가-힣]\s*\d{4}/g,'[차량번호]').slice(0,120);
function canonScan(snapshot,spec){
  const tabs=canonTabs(snapshot,spec),columns=spec.inputHeaders.map(column=>({column,mismatched:0,normalizable:0,holds:0,summaryMismatched:0,examples:[]})),changes=[],holds=[];
  for(const t of tabs){
    if(!canonEqual(spec.inputHeaders,[...t.rows.get(0).values()].map(c=>c.userEnteredValue?.stringValue??'')))hold('Canon LAYOUT_MISMATCH');
    for(const [r,row] of t.rows){if(!r)continue;
      for(const [i,c] of row){const h=spec.inputHeaders[i];if(!h||h==='회사명')continue;const result=canonCheck(t.title===spec.summaryTitle&&c.effectiveValue?{...c,userEnteredValue:canonValue(c)}:c,h,spec);if(!result.bad)continue;
        const stat=columns[i],summary=t.title===spec.summaryTitle;
        if(summary){stat.summaryMismatched++;continue;}
        stat.mismatched++;
        if(stat.examples.length<3)stat.examples.push({tab:t.title,row:r+1,value:canonSafeExample(c,h)});
        if(result.target){stat.normalizable++;changes.push({t,r,i,result});}
        else {stat.holds++;holds.push({tab:t.title,row:r+1,column:h,reason:result.reason});}
      }
    }
  }
  return {tabs,columns,changes,holds};
}
export function auditValueFormats(snapshot,spec=inputSpec){
  const {tabs,columns,holds}=canonScan(snapshot,spec),coverage=tabs.map(canonCoverage);
  const summary=tabs[0];
  if([...summary.rows.entries()].some(([r,row])=>r>0&&[...row.values()].some(c=>c.userEnteredValue?.formulaValue&&!c.effectiveValue)))holds.push({tab:summary.title,reason:'SUMMARY_EFFECTIVE_VALUES_MISSING'});
  return {status:holds.length||columns.some(c=>c.mismatched||c.summaryMismatched)||coverage.some(c=>!c.complete)?'HOLD':'PASS',scope:'OBSERVED_GRID_ONLY',columns,holds,coverage};
}
export function planValueNormalize(snapshot,spec=inputSpec,now=Date.now()){
  if(!Number.isFinite(now))hold('Canon valid planning time required');
  const {tabs,columns,changes,holds}=canonScan(snapshot,spec),requests=[];
  for(const {t,r,i,result:x} of changes){const range={sheetId:t.id,startRowIndex:r,endRowIndex:r+1,startColumnIndex:i,endColumnIndex:i+1};
    if(x.valueBad)requests.push({updateCells:{range,rows:[{values:[{userEnteredValue:x.target}]}],fields:'userEnteredValue'}});
    if(x.formatBad)requests.push({repeatCell:{range,cell:{userEnteredFormat:{numberFormat:x.format}},fields:'userEnteredFormat.numberFormat'}});
  }
  const coverage=tabs.map(canonCoverage);
  // Fail closed: one undecided value or incomplete capture withholds every write, so nothing is applied partially.
  const blocked=holds.length>0||coverage.some(c=>!c.complete);
  return {status:blocked?'HOLD':'PLANNED',plannedAt:new Date(now).toISOString(),scope:'OFFLINE_OBSERVED_SUPPLIER_INPUT_ONLY',columns,holds,coverage,withheldRequestCount:blocked?requests.length:0,requests:blocked?[]:requests};
}
function canonMajority(values){
  const groups=new Map();for(const v of values){const k=canonKey(v);groups.set(k,{value:v,count:(groups.get(k)?.count??0)+1});}
  const best=[...groups.values()].sort((a,b)=>b.count-a.count)[0];
  return best&&best.count>values.length/2?{value:best.value}:null;
}
const canonRule=(rules,t)=>rules.map(rule=>({...canonClone(rule),ranges:(rule.ranges??[]).map(r=>({...r,sheetId:r.sheetId===t.id?'SELF':r.sheetId,...(r.endRowIndex===t.g.rowCount?{endRowIndex:'END'}:{})}))}));
const canonRgb=hex=>Object.fromEntries(['red','green','blue'].map((k,i)=>[k,parseInt(hex.slice(1+i*2,3+i*2),16)/255]));
const canonColorKey=color=>color==null?null:[...['red','green','blue'].map(k=>Math.round((color[k]??0)*255)),color.alpha??1];
const canonHeaderColor=(spec,h,path,fallback)=>{
  const hex=path==='backgroundColor'?spec.tabConsistency?.headerBackgrounds?.[h]:null;
  // A ColorStyle overrides Color in Sheets, so clear it for explicit RGB rules.
  if(path==='backgroundColorStyle')return null;
  return hex?canonRgb(hex):fallback;
};
function canonTabAudit(snapshot,spec){
  const tabs=canonTabs(snapshot,spec),base=tabs[1],differences=[],holds=[];
  const add=(t,item,column,expected,actual)=>{if(canonEqual(expected,actual))return;differences.push({tab:t.title,item,column,expected:canonClone(expected??null),actual:canonClone(actual??null)});};
  const baseRules=canonRule(base.sheet.conditionalFormats??[],base);
  for(const t of tabs){
    const header=[...t.rows.get(0).values()].map(c=>c.userEnteredValue?.stringValue??'');
    if(t.g.columnCount!==spec.inputHeaders.length)holds.push({tab:t.title,reason:'GRID_COLUMN_COUNT_MISMATCH'});
    if(t.sheet.properties.hidden)holds.push({tab:t.title,reason:'BOUND_TAB_HIDDEN'});
    if([...t.rows.keys()].some(r=>!t.heights.has(r)))holds.push({tab:t.title,reason:'MISSING_ROW_METADATA'});
    if(!canonEqual(header,spec.inputHeaders)){add(t,'headers','*',spec.inputHeaders,header);holds.push({tab:t.title,reason:'LAYOUT_MISMATCH_NO_VALUE_OR_COLUMN_MOVES'});continue;}
    for(const k of ['frozenRowCount','frozenColumnCount'])add(t,k,'*',spec[k],t.g[k]??0);
    for(const [r,m] of t.heights){const expected=r===0?spec.headerRowHeight:spec.rowHeight;add(t,'rowHeight',String(r+1),expected,m.pixelSize??null);}
    for(const [i,h] of spec.inputHeaders.entries()){
      const meta=t.columns.get(i);
      if(!meta){holds.push({tab:t.title,column:h,reason:'MISSING_COLUMN_METADATA'});continue;}
      for(const [item,k,expected] of [['columnWidth','pixelSize',spec.columnWidths[h]??spec.defaultColumnWidth],['hidden','hiddenByUser',spec.hiddenHeaders.includes(h)]])add(t,item,h,expected,meta[k]??(k==='hiddenByUser'?false:null));
      const baseHeader=canonCell(base,0,i).userEnteredFormat??{};
      const dataRows=[...base.rows.keys()].filter(r=>r>0);
      const font={fontFamily:spec.font.family,fontSize:spec.font.size,italic:spec.font.italic};
      const attributes=[['font','textFormat.fontFamily',font.fontFamily],['font','textFormat.fontSize',font.fontSize],['font','textFormat.italic',font.italic],['bodyFont','textFormat.bold',null],['alignment','horizontalAlignment',spec.leftAlignHeaders.includes(h)?'LEFT':(spec.rightAlignHeaders??[]).includes(h)?'RIGHT':spec.tabConsistency.horizontalAlignment],['numberFormat','numberFormat',canonNumberFormat(h,spec)]];
      const get=(fmt,path)=>path.split('.').reduce((v,k)=>v?.[k],fmt)??null;
      for(const [item,path,fixed] of attributes){
        const majority=fixed===null?canonMajority(dataRows.map(r=>get(canonCell(base,r,i).userEnteredFormat,path))):{value:fixed};
        if(!majority){holds.push({tab:t.title,column:h,reason:`NO_MAJORITY_${path}`});continue;}
        const expected=majority.value;
        // Check each captured row against the authority; a minority drift must
        // not disappear just because the destination majority is correct.
        for(const r of t.rows.keys()){if(!r)continue;const actual=get(canonCell(t,r,i).userEnteredFormat,path);
          add(t,item,`${h}:${r+1}`,expected,actual);
        }
        const expectedHeader=canonHeaderColor(spec,h,path,['font','wrap'].includes(item)?fixed:get(baseHeader,path));
        const actualHeader=get(canonCell(t,0,i).userEnteredFormat,path);
        add(t,`header.${item}`,h,expectedHeader,actualHeader);
      }
      for(const path of ['backgroundColor','textFormat.bold']){
        const expected=canonHeaderColor(spec,h,path,get(baseHeader,path)),actual=get(canonCell(t,0,i).userEnteredFormat,path);
        if(path==='backgroundColor'&&canonEqual(canonColorKey(expected),canonColorKey(actual)))continue;
        add(t,'headerColor',h,expected,actual);
      }
      if(t.title!==spec.summaryTitle){
        let rule=null;
        if(spec.dropdowns[h])rule={condition:{type:'ONE_OF_LIST',values:spec.dropdowns[h].map(userEnteredValue=>({userEnteredValue}))},strict:spec.dropdownStrict===true,showCustomUi:true};
        else if(spec.vehicleMaster.columns[h])rule={condition:{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='${spec.vehicleMaster.tab}'!${spec.vehicleMaster.columns[h]}2:${spec.vehicleMaster.columns[h]}`}]},strict:spec.dropdownStrict===true,showCustomUi:true};
        for(const r of t.rows.keys()){if(!r)continue;const actual=canonCell(t,r,i).dataValidation??null;
          const canonicalActual=actual?{...actual,strict:actual.strict??false,showCustomUi:actual.showCustomUi??false}:null;
          add(t,'dropdown',`${h}:${r+1}`,rule,canonicalActual);
        }
      }
    }
    const actualRules=canonRule(t.sheet.conditionalFormats??[],t);
    if(!canonEqual(baseRules,actualRules)){
      add(t,'conditionalFormats','*',baseRules,actualRules);
      if(JSON.stringify(baseRules).includes('!')||baseRules.some(rule=>rule.ranges.some(r=>r.sheetId!=='SELF'))){holds.push({tab:t.title,reason:'CONDITIONAL_EXTERNAL_REFERENCE'});}
    }
  }
  const coverage=tabs.map(canonCoverage);for(const c of coverage)if(!c.complete)holds.push({tab:c.tab,reason:'PARTIAL_GRID_COVERAGE'});
  return {status:differences.length||holds.length?'HOLD':'PASS',referenceTab:base.title,differences,counts:Object.fromEntries([...new Set(differences.map(d=>d.item))].map(k=>[k,differences.filter(d=>d.item===k).length])),holds,coverage};
}
export function auditTabConsistency(snapshot,spec=inputSpec){return canonTabAudit(snapshot,spec);}
export function planTabConsistencyFix(snapshot,spec=inputSpec){
  const tabs=canonTabs(snapshot,spec),base=tabs[1],holds=[],requests=[];
  const get=(format,path)=>path.split('.').reduce((v,k)=>v?.[k],format)??null;
  const paths=['textFormat.fontFamily','textFormat.fontSize','textFormat.italic','textFormat.bold','horizontalAlignment','numberFormat'];
  const headerPaths=[...paths,'backgroundColor','backgroundColorStyle'];
  const bodyRows=[...base.rows.keys()].filter(r=>r>0);
  const formats=spec.inputHeaders.map((h,i)=>{
    const fixed={'textFormat.fontFamily':spec.font.family,'textFormat.fontSize':spec.font.size,'textFormat.italic':spec.font.italic,horizontalAlignment:spec.leftAlignHeaders.includes(h)?'LEFT':(spec.rightAlignHeaders??[]).includes(h)?'RIGHT':spec.tabConsistency.horizontalAlignment,numberFormat:canonNumberFormat(h,spec)};
    const body={},bodyPaths=[],header={},baseHeader=canonCell(base,0,i).userEnteredFormat??{};
    const put=(target,path,value)=>{if(value===null)return;const parts=path.split('.');if(parts.length===2)(target[parts[0]]??={})[parts[1]]=value;else target[path]=value;};
    for(const path of paths){
      const expected=Object.hasOwn(fixed,path)?{value:fixed[path]}:canonMajority(bodyRows.map(r=>get(canonCell(base,r,i).userEnteredFormat,path)));
      if(!expected)holds.push({tab:base.title,column:h,reason:`NO_MAJORITY_${path}`});
      else {put(body,path,expected.value);bodyPaths.push(path);}
    }
    for(const path of headerPaths)put(header,path,canonHeaderColor(spec,h,path,['textFormat.fontFamily','textFormat.fontSize','textFormat.italic','wrapStrategy'].includes(path)?fixed[path]:get(baseHeader,path)));
    return {body,bodyPaths,header};
  });
  for(const t of tabs){
    if(!canonEqual(headersOf(t.sheet),spec.inputHeaders))holds.push({tab:t.title,reason:'LAYOUT_MISMATCH_NO_VALUE_OR_COLUMN_MOVES'});
    if(t.g.columnCount!==spec.inputHeaders.length)holds.push({tab:t.title,reason:'GRID_COLUMN_COUNT_MISMATCH'});
    if(t.sheet.properties.hidden)holds.push({tab:t.title,reason:'BOUND_TAB_HIDDEN'});
  }
  const baseRules=canonRule(base.sheet.conditionalFormats??[],base);
  if(JSON.stringify(baseRules).includes('!')||baseRules.some(rule=>rule.ranges.some(r=>r.sheetId!=='SELF')))holds.push({tab:base.title,reason:'CONDITIONAL_EXTERNAL_REFERENCE'});
  // Majority-derived attributes (bold, numberFormat, ...) cover whole columns, so they need every row read.
  for(const c of tabs.map(canonCoverage))if(!c.complete)holds.push({tab:c.tab,reason:'PARTIAL_CAPTURE_MAJORITY_FORMATS'});
  // Fail closed like planValueNormalize: any hold withholds every request.
  const result=()=>({status:holds.length?'HOLD':'PLANNED',scope:'OFFLINE_FORMATS_ONLY_FULL_COLUMNS',referenceTab:base.title,holds,coverage:tabs.map(canonCoverage),withheldRequestCount:holds.length?requests.length:0,requests:holds.length?[]:requests});
  if(holds.some(h=>!h.reason.startsWith('NO_MAJORITY_')))return result();
  // Coalesce adjacent columns with identical payloads. Row endpoints always
  // come from metadata, never the length of a captured GridData block.
  const runs=(items,emit)=>{for(let start=0;start<items.length;){let end=start+1;while(end<items.length&&canonEqual(items[start],items[end]))end++;emit(items[start],start,end);start=end;}};
  for(const t of tabs){
    const range=(start,end,row=1,rowEnd=t.g.rowCount)=>({sheetId:t.id,startRowIndex:row,endRowIndex:rowEnd,startColumnIndex:start,endColumnIndex:end});
    runs(formats.map(f=>({format:f.body,paths:f.bodyPaths})),({format,paths:mask},start,end)=>requests.push({repeatCell:{range:range(start,end),cell:{userEnteredFormat:format},fields:mask.map(p=>`userEnteredFormat.${p}`).join(',')}}));
    runs(formats.map(f=>f.header),(format,start,end)=>requests.push({repeatCell:{range:range(start,end,0,1),cell:{userEnteredFormat:format},fields:headerPaths.map(p=>`userEnteredFormat.${p}`).join(',')}}));
    runs(spec.inputHeaders.map(h=>({pixelSize:spec.columnWidths[h]??spec.defaultColumnWidth,hiddenByUser:spec.hiddenHeaders.includes(h)})),(properties,startIndex,endIndex)=>requests.push({updateDimensionProperties:{range:{sheetId:t.id,dimension:'COLUMNS',startIndex,endIndex},properties,fields:'pixelSize,hiddenByUser'}}));
    requests.push({updateSheetProperties:{properties:{sheetId:t.id,gridProperties:{frozenRowCount:spec.frozenRowCount,frozenColumnCount:spec.frozenColumnCount}},fields:'gridProperties.frozenRowCount,gridProperties.frozenColumnCount'}});
    for(const [startIndex,endIndex,pixelSize] of [[0,1,spec.headerRowHeight],[1,t.g.rowCount,spec.rowHeight]])requests.push({updateDimensionProperties:{range:{sheetId:t.id,dimension:'ROWS',startIndex,endIndex},properties:{pixelSize},fields:'pixelSize'}});
    if(t.title!==spec.summaryTitle)runs(spec.inputHeaders.map(h=>{
      const condition=spec.dropdowns[h]?{type:'ONE_OF_LIST',values:spec.dropdowns[h].map(userEnteredValue=>({userEnteredValue}))}:spec.vehicleMaster.columns[h]?{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='${spec.vehicleMaster.tab}'!${spec.vehicleMaster.columns[h]}2:${spec.vehicleMaster.columns[h]}`}]}:null;
      return condition?{condition,strict:spec.dropdownStrict===true,showCustomUi:true}:null;
    }),(rule,start,end)=>requests.push({setDataValidation:{range:range(start,end),...(rule?{rule}:{})}}));
    if(!canonEqual(baseRules,canonRule(t.sheet.conditionalFormats??[],t))){
      for(let index=(t.sheet.conditionalFormats??[]).length-1;index>=0;index--)requests.push({deleteConditionalFormatRule:{sheetId:t.id,index}});
      baseRules.forEach((rule,index)=>requests.push({addConditionalFormatRule:{index,rule:{...canonClone(rule),ranges:rule.ranges.map(r=>({...r,sheetId:t.id,...(r.endRowIndex==='END'?{endRowIndex:t.g.rowCount}:{})}))}}}));
    }
  }
  return result();
}

// Pure request builders: no gws execution, credentials or snapshot persistence.
function canonCaptureTabs(spec,metadata){
  const book=metadata.spreadsheet??metadata;
  if(!Array.isArray(book.sheets))hold('Capture metadata sheets required');
  if(Object.values(specification.workbooks).some(w=>w.spreadsheetId===book.spreadsheetId))hold('Production F01/F86 is not an input workbook');
  return [spec.summaryTitle,...spec.supplierChannels.sharedInputSheet.map(s=>s.tab)].map(title=>{
    const matches=book.sheets.filter(s=>s.properties?.title===title);
    if(matches.length!==1)hold(`Capture metadata tab missing or duplicate: ${title}`);
    const tab=matches[0],g=tab.properties.gridProperties;
    if(!Number.isInteger(g?.rowCount)||g.rowCount<2||g.columnCount!==spec.inputHeaders.length)hold(`Capture grid dimensions invalid: ${title}`);
    return tab;
  });
}
export function canonCaptureRequest(spec,metadata){
  const tabs=canonCaptureTabs(spec,metadata),book=metadata.spreadsheet??metadata;
  return {spreadsheetId:book.spreadsheetId,includeGridData:true,ranges:tabs.map(t=>`'${t.properties.title.replaceAll("'","''")}'!A1:${columnLetter(spec.inputHeaders.length-1)}${t.properties.gridProperties.rowCount}`),
    fields:'spreadsheetId,sheets(properties(sheetId,title,hidden,gridProperties),conditionalFormats,data(startRow,startColumn,rowData(values(userEnteredFormat(numberFormat,horizontalAlignment,textFormat(fontFamily,fontSize,bold,italic),backgroundColor),dataValidation)),columnMetadata(pixelSize,hiddenByUser),rowMetadata(pixelSize)))'};
}
export function canonValueCaptureRequest(spec,metadata){
  const tabs=canonCaptureTabs(spec,metadata),book=metadata.spreadsheet??metadata;
  return {spreadsheetId:book.spreadsheetId,includeGridData:true,ranges:tabs.map(t=>{
    const last=metadata.usedRows?.[t.properties.title];
    if(!Number.isInteger(last)||last<1||last>t.properties.gridProperties.rowCount)hold(`Confirmed usedRows required: ${t.properties.title}`);
    return `'${t.properties.title.replaceAll("'","''")}'!A1:${columnLetter(spec.inputHeaders.length-1)}${last}`;
  }),fields:'spreadsheetId,sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(userEnteredValue,formattedValue,effectiveValue))))'};
}
// The canon check needs both captures: formats from canonCaptureRequest and values from
// canonValueCaptureRequest. Same workbook and same tabs, both anchored at A1; inputs stay untouched.
export function mergeCanonCaptures(formatCapture,valueCapture){
  const fb=formatCapture?.spreadsheet??formatCapture,vb=valueCapture?.spreadsheet??valueCapture;
  if(!Array.isArray(fb?.sheets)||!Array.isArray(vb?.sheets))hold('Both format and value captures required');
  if(!fb.spreadsheetId||fb.spreadsheetId!==vb.spreadsheetId)hold('Captures come from different workbooks');
  const key=s=>`${s.properties?.sheetId}:${s.properties?.title}`;
  if(JSON.stringify(fb.sheets.map(key).sort())!==JSON.stringify(vb.sheets.map(key).sort()))hold('Captures cover different tabs');
  const anchor=s=>{const d=s.data??[];if(d.length!==1||(d[0].startRow??0)!==0||(d[0].startColumn??0)!==0)hold(`Capture must be one A1 block: ${s.properties.title}`);return d[0];};
  const merged=structuredClone(fb);
  for(const sheet of merged.sheets){
    const block=anchor(sheet),values=anchor(vb.sheets.find(s=>key(s)===key(sheet)));
    (values.rowData??[]).forEach((row,r)=>{const target=(block.rowData??=[])[r]??={};
      (row.values??[]).forEach((cell,c)=>{const t=(target.values??=[])[c]??={};for(const k of ['userEnteredValue','formattedValue','effectiveValue'])if(cell[k]!==undefined)t[k]=structuredClone(cell[k]);});
      if(target.values)for(let c=0;c<target.values.length;c++)target.values[c]??={};});
    for(let r=0;r<(block.rowData?.length??0);r++)block.rowData[r]??={};
  }
  return merged;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===fs.realpathSync(process.argv[1])){
  const modes={'--audit-formats':auditValueFormats,'--normalize-values':planValueNormalize,'--audit-tabs':auditTabConsistency,'--fix-tabs':planTabConsistencyFix,'--exclude-supplier':planExcludeSupplierTab,'--capture-canon':metadata=>canonCaptureRequest(inputSpec,metadata),'--capture-values':metadata=>canonValueCaptureRequest(inputSpec,metadata)};
  const canonArg=process.argv.slice(2).find(a=>Object.keys(modes).some(k=>a.startsWith(k+'='))||a.startsWith('--check-canon'));
  if(canonArg){try{const mode=canonArg.split('=')[0],path=canonArg.includes('=')?canonArg.slice(mode.length+1):process.argv[process.argv.indexOf(canonArg)+1];if(!path)hold('Snapshot path required');const read=JSON.parse(fs.readFileSync(path==='-'?0:path,'utf8')),snapshot=read.formatCapture||read.valueCapture?mergeCanonCaptures(read.formatCapture,read.valueCapture):read;const result=mode==='--check-canon'?{formats:auditValueFormats(snapshot),tabs:auditTabConsistency(snapshot)}:modes[mode](snapshot);const code=mode==='--check-canon'&&(result.formats.status!=='PASS'||result.tabs.status!=='PASS')?1:0;process.stdout.write(`${JSON.stringify(result,null,2)}\n`,()=>process.exit(code));}catch(e){console.error(e.message);process.exit(2);}}
  try {const master=process.argv.find(a=>a.startsWith('--vehicle-master='))?.slice(17);if(master){console.log(JSON.stringify(planVehicleMasterDropdowns(JSON.parse(master==='-'?fs.readFileSync(0,'utf8'):fs.readFileSync(master,'utf8'))),null,2));process.exit(0);}const change=process.argv.find(a=>a.startsWith('--change-layout='))?.slice(16);if(change){console.log(JSON.stringify(planLayoutChange(JSON.parse(change==='-'?fs.readFileSync(0,'utf8'):fs.readFileSync(change,'utf8'))),null,2));process.exit(0);}const add=process.argv.find(a=>a.startsWith('--add-columns='))?.slice(14);if(add){console.log(JSON.stringify(planColumnAdd(JSON.parse(add==='-'?fs.readFileSync(0,'utf8'):fs.readFileSync(add,'utf8'))),null,2));process.exit(0);}const reorder=process.argv.find(a=>a.startsWith('--reorder='))?.slice(10);if(reorder){console.log(JSON.stringify(planLayoutReorder(JSON.parse(reorder==='-'?fs.readFileSync(0,'utf8'):fs.readFileSync(reorder,'utf8'))),null,2));process.exit(0);}const split=process.argv.find(a=>a.startsWith('--split='))?.slice(8);if(split){console.log(JSON.stringify(planPolicySplit(JSON.parse(split==='-'?fs.readFileSync(0,'utf8'):fs.readFileSync(split,'utf8'))),null,2));process.exit(0);}const dropdowns=process.argv.find(a=>a.startsWith('--dropdowns='))?.slice(12);const compare=process.argv.find(a=>a.startsWith('--compare='))?.slice(10);if(dropdowns){console.log(JSON.stringify(planSupplierDropdowns(JSON.parse(dropdowns==='-'?fs.readFileSync(0,'utf8'):fs.readFileSync(dropdowns,'utf8'))),null,2));}else if(compare){console.log(JSON.stringify(compareSharedToLegacy(JSON.parse(fs.readFileSync(compare,'utf8'))),null,2));}else{const path=process.argv.find(a=>a.startsWith('--input='))?.slice(8);if(!path)hold('--input=private-fresh-readback.json or --compare=private-compare.json required'); console.log(JSON.stringify(planSupplierInput(JSON.parse(fs.readFileSync(path,'utf8'))),null,2));}}catch(e){console.error(e.message);if(e.mismatched)console.error(JSON.stringify(e.mismatched,null,2));process.exitCode=2;}
}
