import fs from 'node:fs';
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
  if(!suppliers.length||new Set(suppliers.map(s=>s.sheetId)).size!==suppliers.length||new Set(suppliers.map(s=>s.code)).size!==suppliers.length||new Set(suppliers.map(s=>s.title)).size!==suppliers.length)hold('Unique supplier bindings required');
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
    for(let i=0;i<wanted.length;i++){const at=working.indexOf(wanted[i]);if(at!==i){requests.push({moveDimension:{source:{sheetId:entry.sheetId,dimension:'COLUMNS',startIndex:at,endIndex:at+1},destinationIndex:i}});working.splice(i,0,working.splice(at,1)[0]);}}
    requests.push({updateSheetProperties:{properties:{sheetId:entry.sheetId,title:entry.title,hidden:false,gridProperties:{frozenRowCount:1,frozenColumnCount:entry.summary?6:2},tabColorStyle:{rgbColor:rgb(entry.summary?'#4A86E8':'#7F8C8D')}},fields:'title,hidden,gridProperties.frozenRowCount,gridProperties.frozenColumnCount,tabColorStyle'}});
    const height=s.properties.gridProperties.rowCount, range={sheetId:entry.sheetId,startColumnIndex:0,endColumnIndex:wanted.length,startRowIndex:0,endRowIndex:height};
    requests.push({repeatCell:{range,cell:{userEnteredFormat:{textFormat:{fontFamily:'Malgun Gothic',fontSize:9,italic:true,bold:false},horizontalAlignment:'CENTER',verticalAlignment:'MIDDLE',wrapStrategy:'OVERFLOW_CELL',padding:{top:2,right:3,bottom:2,left:3}}},fields:'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.italic,userEnteredFormat.textFormat.bold,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy,userEnteredFormat.padding'}},{updateDimensionProperties:{range:{sheetId:entry.sheetId,dimension:'ROWS',startIndex:0,endIndex:height},properties:{pixelSize:21},fields:'pixelSize'}});
    for(let i=0;i<wanted.length;i++) {
      const h=wanted[i], r={...range,startColumnIndex:i,endColumnIndex:i+1};
      const period=specification.appearance.semanticColors.periodBackground[h];
      requests.push({updateDimensionProperties:{range:{sheetId:entry.sheetId,dimension:'COLUMNS',startIndex:i,endIndex:i+1},properties:{pixelSize:spec.columnWidths[spec.headerAliases[h]??h]??spec.defaultColumnWidth},fields:'pixelSize'}});
      requests.push({updateDimensionProperties:{range:{sheetId:entry.sheetId,dimension:'COLUMNS',startIndex:i,endIndex:i+1},properties:{hiddenByUser:spec.hiddenHeaders.includes(h)},fields:'hiddenByUser'}},{repeatCell:{range:{...r,endRowIndex:1},cell:{userEnteredFormat:{backgroundColorStyle:{rgbColor:rgb(period??'#F2F2F2')},textFormat:{bold:true},borders:{bottom:{style:'SOLID',colorStyle:{rgbColor:rgb('#A6A6A6')}}}}},fields:'userEnteredFormat.backgroundColorStyle,userEnteredFormat.textFormat.bold,userEnteredFormat.borders.bottom'}});
      if(period)requests.push({repeatCell:{range:{...r,startRowIndex:1},cell:{userEnteredFormat:{backgroundColorStyle:{rgbColor:rgb(period)}}},fields:'userEnteredFormat.backgroundColorStyle'}});
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
      const cols=[`IF(keep,${literal(entry.code)},"")`,`IF(keep,${literal(entry.title)},"")`,`SEQUENCE(${n},1,2)`,`IF(${plate}="","차량번호 미입력",IF(COUNTIF(${quote(entry.title)}!${column(wanted.indexOf('차량번호'))}2:${column(wanted.indexOf('차량번호'))}${height},${plate})>1,"중복번호",""))`,...canonical.slice(4).map(h=>h==='정책코드(공급사 전용)'?`IF(${ix('정책코드')}="","",${literal(entry.code+':')}&${ix('정책코드')})`:ix(h))];
      blocks.push(`LET(src,IF(${src}="","",${src}),keep,BYROW(src,LAMBDA(r,SUM(LEN(r))>0)),data,HSTACK(${cols.join(',')}),IF(SUM(N(keep))=0,MAKEARRAY(1,${canonical.length},LAMBDA(r,c,"")),FILTER(data,keep)))`);
      const row=14+suppliers.indexOf(entry), end=column(wanted.length-1);
      requests.push({updateCells:{start:{sheetId:binding.guideSheetId,rowIndex:row-1,columnIndex:7},rows:[{values:[{userEnteredValue:{formulaValue:`=IF(SUM(ARRAYFORMULA(N(${quote(entry.title)}!A1:${end}1<>{${wanted.map(literal).join(',')}})))>0,"열 구조 변경 확인","전환 검토용 / 담당자 미등록")`}}]}],fields:'userEnteredValue'}});
    }
  }
  const formula=`=IF(COUNTIF(${quote(spec.guideTitle)}!H14:H${13+suppliers.length},"열 구조 변경 확인")>0,NA(),ARRAYFORMULA(LET(combined,VSTACK(${blocks.join(',')}),IF(COUNTIF(INDEX(combined,,1),"?*")=0,"",FILTER(combined,INDEX(combined,,1)<>"")))))`;
  requests.push({updateSheetProperties:{properties:{sheetId:binding.guideSheetId,title:spec.guideTitle,hidden:true},fields:'title,hidden'}},{updateCells:{start:{sheetId:binding.summarySheetId,rowIndex:1,columnIndex:0},rows:[{values:[{userEnteredValue:{formulaValue:formula}}]}],fields:'userEnteredValue'}});
  return {status:'PLANNED',scope:'SUPPLIER_INPUT_PRESENTATION_AND_SUMMARY_NOT_SOURCE_CUTOVER',spreadsheetId:binding.spreadsheetId,requests};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===fs.realpathSync(process.argv[1])){
  try {const path=process.argv.find(a=>a.startsWith('--input='))?.slice(8);if(!path)hold('--input=private-fresh-readback.json required'); console.log(JSON.stringify(planSupplierInput(JSON.parse(fs.readFileSync(path,'utf8'))),null,2));}catch(e){console.error(e.message);process.exitCode=2;}
}
