import fs from 'node:fs';
import {createHash} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { specification } from './sheet-presentation.mjs';
export const inputSpec = JSON.parse(fs.readFileSync(new URL('../contracts/supplier-input-sheet-spec.v1.json', import.meta.url), 'utf8'));
const hold = message => { throw new Error(`HOLD: ${message}`); };
const rgb = h => Object.fromEntries(['red','green','blue'].map((k,i)=>[k,parseInt(h.slice(1+i*2,3+i*2),16)/255]));
const column = index => { let out=''; for(index++;index;index=Math.floor((index-1)/26)) out=String.fromCharCode(65+(index-1)%26)+out; return out; };
const quote = title => `'${title.replaceAll("'", "''")}'`;
const literal = text => `"${String(text).replaceAll('"','""')}"`;
const headersOf = sheet => sheet.data?.find(d=>(d.startRow??0)===0&&(d.startColumn??0)===0)?.rowData?.[0]?.values?.map(c=>c.userEnteredValue?.stringValue??'')??[];

// No credentials, network, source ingestion, sharing, or value normalization.
// Caller must provide a fresh independent inventory and exact private binding.
export function planSupplierInput(input, spec=inputSpec, now=Date.now()) {
  const {spreadsheet,binding,capturedAt}=input;
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
  const requests=[], blocks=[], canonical=spec.summaryHeaders;
  for(const s of sheets.filter(s=>allowed.has(s.properties.sheetId)))for(const p of s.protectedRanges??[]){if(input.authorization?.removeSheetProtections!==true)hold('Explicit sheet-protection removal authorization required');requests.push({deleteProtectedRange:{protectedRangeId:p.protectedRangeId}});}
  for(const entry of [{sheetId:binding.summarySheetId,title:spec.summaryTitle,summary:true},...suppliers]) {
    const s=sheets.find(s=>s.properties.sheetId===entry.sheetId); if(!s)hold('Supplier sheet missing');
    if(s.tables?.length)hold('Native table conversion requires backed-up atomic restoration');
    const headers=headersOf(s),expected=entry.summary?canonical:spec.inputHeaders;
    if(!headers.length||headers.some(h=>!h)||new Set(headers).size!==headers.length||headers.some(h=>!expected.includes(h)))hold('Unknown/duplicate header');
    if(expected.filter(h=>!headers.includes(h)).some(h=>!['사진링크','기타기간①'].includes(h)))hold('Required column missing; explicit migration required');
    const wanted=expected.filter(h=>headers.includes(h)), working=[...headers];
    if(!entry.summary&&spec.companyNameSource==='SUPPLIER_TAB_TITLE_FOR_POPULATED_ROWS') {
      const company=headers.indexOf('회사명');
      for(let row=1;row<(s.data?.[0]?.rowData?.length??0);row++) {
        const cells=s.data[0].rowData[row].values??[];
        const active=cells.some((cell,i)=>{
          if(i===company)return false;
          const value=cell.effectiveValue??cell.userEnteredValue;
          if(value?.errorValue)hold('Cannot label an error row');
          return value&&(value.stringValue!==undefined?value.stringValue!=='':value.numberValue!==undefined||value.boolValue!==undefined);
        });
        if(active&&cells[company]?.userEnteredValue?.stringValue!==entry.title)requests.push({updateCells:{start:{sheetId:entry.sheetId,rowIndex:row,columnIndex:company},rows:[{values:[{userEnteredValue:{stringValue:entry.title}}]}],fields:'userEnteredValue'}});
      }
    }
    for(let i=0;i<wanted.length;i++){const at=working.indexOf(wanted[i]);if(at!==i){requests.push({moveDimension:{source:{sheetId:entry.sheetId,dimension:'COLUMNS',startIndex:at,endIndex:at+1},destinationIndex:i}});working.splice(i,0,working.splice(at,1)[0]);}}
    requests.push({updateSheetProperties:{properties:{sheetId:entry.sheetId,title:entry.title,hidden:false,gridProperties:{frozenRowCount:1,frozenColumnCount:entry.summary?6:2},tabColorStyle:{rgbColor:rgb(entry.summary?'#4A86E8':'#7F8C8D')}},fields:'title,hidden,gridProperties.frozenRowCount,gridProperties.frozenColumnCount,tabColorStyle'}});
    const height=s.properties.gridProperties.rowCount, range={sheetId:entry.sheetId,startColumnIndex:0,endColumnIndex:wanted.length,startRowIndex:0,endRowIndex:height};
    // Keep the compact retro rows; long original text remains accessible in the formula bar.
    requests.push({repeatCell:{range,cell:{userEnteredFormat:{wrapStrategy:spec.textWrap}},fields:'userEnteredFormat.wrapStrategy'}});
    requests.push({repeatCell:{range,cell:{userEnteredFormat:{textFormat:{fontFamily:'Malgun Gothic',fontSize:9,italic:true,bold:false},horizontalAlignment:'CENTER',verticalAlignment:'MIDDLE',wrapStrategy:spec.textWrap,padding:{top:2,right:3,bottom:2,left:3}}},fields:'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.italic,userEnteredFormat.textFormat.bold,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy,userEnteredFormat.padding'}},{updateDimensionProperties:{range:{sheetId:entry.sheetId,dimension:'ROWS',startIndex:0,endIndex:height},properties:{pixelSize:spec.rowHeight},fields:'pixelSize'}});
    for(let i=0;i<wanted.length;i++) {
      const h=wanted[i], r={...range,startColumnIndex:i,endColumnIndex:i+1};
      const period=spec.rentalFeeBodyBackgrounds[h];
      requests.push({updateDimensionProperties:{range:{sheetId:entry.sheetId,dimension:'COLUMNS',startIndex:i,endIndex:i+1},properties:{pixelSize:spec.columnWidths[spec.headerAliases[h]??h]??spec.defaultColumnWidth},fields:'pixelSize'}});
      requests.push({updateDimensionProperties:{range:{sheetId:entry.sheetId,dimension:'COLUMNS',startIndex:i,endIndex:i+1},properties:{hiddenByUser:spec.hiddenHeaders.includes(h)},fields:'hiddenByUser'}},{repeatCell:{range:{...r,endRowIndex:1},cell:{userEnteredFormat:{backgroundColorStyle:{rgbColor:rgb(period?spec.rentalFeeHeaderBackground:'#F2F2F2')},textFormat:{bold:true,...(period?{foregroundColorStyle:{rgbColor:rgb(spec.rentalFeeHeaderForeground)}}:{})},borders:{bottom:{style:'SOLID',colorStyle:{rgbColor:rgb('#A6A6A6')}}}}},fields:'userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.foregroundColorStyle,userEnteredFormat.borders.bottom'}});
      if(period)requests.push({repeatCell:{range:{...r,startRowIndex:1},cell:{userEnteredFormat:{backgroundColorStyle:{rgbColor:rgb(period)}}},fields:'userEnteredFormat.backgroundColorStyle'}});
      if(spec.leftAlignHeaders.includes(h))requests.push({repeatCell:{range:{...r,startRowIndex:1},cell:{userEnteredFormat:{horizontalAlignment:'LEFT'}},fields:'userEnteredFormat.horizontalAlignment'}});
      if(spec.numberHeaders.includes(h))requests.push({repeatCell:{range:{...r,startRowIndex:1},cell:{userEnteredFormat:{numberFormat:{type:'NUMBER',pattern:'#,##0'},horizontalAlignment:'RIGHT'}},fields:'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment'}});
      const colors=h==='상태'?specification.appearance.semanticColors.availabilityText:h==='분류'?specification.appearance.semanticColors.productTypeText:null;
      for(const [text,color] of Object.entries(colors??{})) {
        const found=(s.conditionalFormats??[]).some(rule=>rule.booleanRule?.condition?.type==='TEXT_EQ'&&rule.booleanRule.condition.values?.[0]?.userEnteredValue===text&&rule.ranges?.some(v=>v.startColumnIndex===i&&v.endColumnIndex===i+1&&(v.startRowIndex??0)===1&&v.endRowIndex===height));
        // Re-read after movements: native rules move with columns. Preserve all
        // unknown rules; add semantic rules only against canonical coordinates.
        if(!found&&JSON.stringify(headers)===JSON.stringify(wanted))requests.push({addConditionalFormatRule:{index:0,rule:{ranges:[{...r,startRowIndex:1}],booleanRule:{condition:{type:'TEXT_EQ',values:[{userEnteredValue:text}]},format:{textFormat:{foregroundColor:rgb(color)}}}}}});
      }
      if(h==='사진링크')requests.push({repeatCell:{range:{...r,startRowIndex:1},cell:{userEnteredFormat:{textFormat:{foregroundColorStyle:{rgbColor:rgb(specification.appearance.semanticColors.linkText)}}}},fields:'userEnteredFormat.textFormat.foregroundColorStyle'}});
      if(!entry.summary)requests.push({setDataValidation:{range:{...r,startRowIndex:1},...(spec.dropdowns[h]?{rule:{condition:{type:'ONE_OF_LIST',values:spec.dropdowns[h].map(userEnteredValue=>({userEnteredValue}))},strict:false,showCustomUi:true,inputMessage:'목록 선택 또는 원문 직접 입력. 모델은 제조사와 일치하는지 확인하세요.'}}:{})}});
    }
    if(!entry.summary){
      const n=height-1;if(n<1)hold('Supplier grid empty');
      const src=`${quote(entry.title)}!A2:${column(wanted.length-1)}${height}`;
      const blank=`MAKEARRAY(${n},1,LAMBDA(r,c,""))`, ix=h=>wanted.includes(h)?`INDEX(src,,${wanted.indexOf(h)+1})`:blank;
      const plate=ix('차량번호');
      const photo=ix('사진링크');
      for(let row=1;row<(s.data?.[0]?.rowData?.length??0);row++) {
        const cells=s.data[0].rowData[row].values??[],pc=cells[headers.indexOf('차량번호')],fc=cells[headers.indexOf('사진링크')];
        const uri=fc?.effectiveValue?.stringValue??fc?.userEnteredValue?.stringValue;
        if(!uri)continue;
        if(!/^https?:\/\//i.test(uri))hold('Invalid photo URL');
        const prior=[pc?.hyperlink,pc?.userEnteredFormat?.textFormat?.link?.uri,...(pc?.textFormatRuns??[]).map(v=>v.format?.link?.uri)].filter(Boolean);
        if(prior.some(v=>v!==uri))hold('Plate/photo link conflict');
        if(!pc?.userEnteredValue?.stringValue)continue;
        if(pc.textFormatRuns?.length)continue; // Preserve original rich text runs.
        requests.push({repeatCell:{range:{sheetId:entry.sheetId,startRowIndex:row,endRowIndex:row+1,startColumnIndex:wanted.indexOf('차량번호'),endColumnIndex:wanted.indexOf('차량번호')+1},cell:{userEnteredFormat:{textFormat:{link:{uri}}}},fields:'userEnteredFormat.textFormat.link'}});
      }
      const linkedPlate=`IF(${plate}="","",IF(${photo}="",${plate},HYPERLINK(${photo},${plate})))`;
      const cols=[`IF(keep,${literal(entry.code)},"")`,`IF(keep,${literal(entry.title)},"")`,`SEQUENCE(${n},1,2)`,`IF(${plate}="","차량번호 미입력",IF(COUNTIF(${quote(entry.title)}!${column(wanted.indexOf('차량번호'))}2:${column(wanted.indexOf('차량번호'))}${height},${plate})>1,"중복번호",""))`,...canonical.slice(4).map(h=>h==='차량번호'?linkedPlate:h==='사진용 차량번호'?plate:h==='정책코드(공급사 전용)'?`IF(${ix('정책코드')}="","",${literal(entry.code+':')}&${ix('정책코드')})`:ix(h))];
      blocks.push(`LET(src,IF(${src}="","",${src}),keep,BYROW(src,LAMBDA(r,SUM(LEN(r))>0)),data,HSTACK(${cols.join(',')}),IF(SUM(N(keep))=0,MAKEARRAY(1,${canonical.length},LAMBDA(r,c,"")),FILTER(data,keep)))`);
      const row=14+suppliers.indexOf(entry), end=column(wanted.length-1);
      requests.push({updateCells:{start:{sheetId:binding.guideSheetId,rowIndex:row-1,columnIndex:7},rows:[{values:[{userEnteredValue:{formulaValue:`=IF(SUM(ARRAYFORMULA(N(${quote(entry.title)}!A1:${end}1<>{${wanted.map(literal).join(',')}})))>0,"열 구조 변경 확인","전환 검토용 / 담당자 미등록")`}}]}],fields:'userEnteredValue'}});
    }
  }
  const formula=`=IF(COUNTIF(${quote(spec.guideTitle)}!H14:H${13+suppliers.length},"열 구조 변경 확인")>0,NA(),ARRAYFORMULA(LET(combined,VSTACK(${blocks.join(',')}),IF(COUNTIF(INDEX(combined,,1),"?*")=0,"",FILTER(combined,INDEX(combined,,1)<>"")))))`;
  // FILTER/HSTACK discard hyperlink metadata. Keep the displayed plate column
  // outside the data spills so a direct HYPERLINK array can remain clickable.
  const plateIndex=canonical.indexOf('차량번호'),rawPlateIndex=canonical.indexOf('사진용 차량번호'),photoIndex=canonical.indexOf('사진링크');
  if(plateIndex<1||rawPlateIndex<0||photoIndex<0)hold('Summary photo helper schema missing');
  const end=summary.properties.gridProperties.rowCount,raw=`${column(rawPlateIndex)}2:${column(rawPlateIndex)}${end}`,photo=`${column(photoIndex)}2:${column(photoIndex)}${end}`;
  const select=indices=>`=CHOOSECOLS(${formula.slice(1)},${indices.map(i=>i+1).join(',')})`;
  requests.push({updateSheetProperties:{properties:{sheetId:binding.guideSheetId,title:spec.guideTitle,hidden:true},fields:'title,hidden'}},
    ...[{columnIndex:0,formulaValue:select(Array.from({length:plateIndex},(_,i)=>i))},{columnIndex:plateIndex+1,formulaValue:select(Array.from({length:canonical.length-plateIndex-1},(_,i)=>i+plateIndex+1))},{columnIndex:plateIndex,formulaValue:`=ARRAYFORMULA(IF(${raw}="","",IF(${photo}="",${raw},HYPERLINK(${photo},${raw}))))`}].map(({columnIndex,formulaValue})=>({updateCells:{start:{sheetId:binding.summarySheetId,rowIndex:1,columnIndex},rows:[{values:[{userEnteredValue:{formulaValue}}]}],fields:'userEnteredValue'}})));
  const resized=requests.filter(r=>r.autoResizeDimensions),rest=requests.filter(r=>!r.autoResizeDimensions);
  return {status:'PLANNED',scope:'MANUAL_SUPPLIER_INPUT_PRESENTATION_AND_SUMMARY_NOT_AUTOMATIC_SOURCE_REFRESH',spreadsheetId:binding.spreadsheetId,requests:[...rest,...resized]};
}
// Source policies stay in their original units. Blank/duplicate codes never
// select a generic default. No inventory/monetary field is normalized here.
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
    if(!sh?.includes('정책코드')||!h?.includes('정책코드')||!h?.includes('차량번호')||new Set(sh).size!==sh.length)hold('Policy headers invalid');
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
      const values=inputSpec.policyDisplay==='COMPACT_VALUES_PRESERVE_UNITS'?{...verbose,
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
  try {const path=process.argv.find(a=>a.startsWith('--input='))?.slice(8);if(!path)hold('--input=private-fresh-readback.json required'); console.log(JSON.stringify(planSupplierInput(JSON.parse(fs.readFileSync(path,'utf8'))),null,2));}catch(e){console.error(e.message);process.exitCode=2;}
}
