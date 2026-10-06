import {inputSpec} from './supplier-input-sheet.mjs';

// UI choices are not a vehicle master: published labels plus exact values
// already entered on this workbook. Nothing is renamed or promoted here.
export function planInputWarningCleanup(metadata,captures,masterCapture,spec=inputSpec){
  const policy=spec.dropdownPolicy.lightweight,helper=policy.validationChoices;
  if(!helper?.enabled)throw new Error('HOLD: input choice policy required');
  const headers=[...policy.listHeaders,...policy.masterHeaders],read=c=>{
    const v=c?.effectiveValue??c?.userEnteredValue??{};
    if(v.errorValue)throw new Error('HOLD: formula error in input');
    return v.stringValue??v.numberValue??v.boolValue??'';
  };
  const blocks=masterCapture.sheets.find(s=>s.properties.title===spec.vehicleMaster.tab)?.data;
  if(!blocks)throw new Error('HOLD: published choice capture required');
  const options=headers.map(h=>{
    const column=spec.vehicleMaster.columns[h];
    const values=column?blocks.flatMap(b=>(b.rowData??[]).flatMap((r,i)=>(b.startRow??0)+i>0?[read(r.values?.[column.charCodeAt(0)-65])]:[])):spec.dropdowns[h];
    return [...new Set(values.filter(v=>v!=='').map(String))];
  });
  const targets=metadata.sheets.filter(s=>!s.properties.hidden),rowsById=new Map();
  for(const s of targets){
    const capture=captures.sheets.find(t=>t.properties.sheetId===s.properties.sheetId);
    if(!capture)throw new Error('HOLD: full input capture required');
    const rows=new Map();for(const b of capture.data??[])for(const[i,r]of(b.rowData??[]).entries())rows.set((b.startRow??0)+i,r.values??[]);
    if(JSON.stringify((rows.get(0)??[]).map(read))!==JSON.stringify(spec.inputHeaders))throw new Error('HOLD: header mismatch');
    rowsById.set(s.properties.sheetId,rows);
    for(const[row,cells]of rows)if(row>0)headers.forEach((h,i)=>{const v=read(cells[spec.inputHeaders.indexOf(h)]);if(v!==''&&!options[i].includes(String(v)))options[i].push(String(v));});
  }
  const existing=metadata.sheets.find(s=>s.properties.title===helper.tab||s.properties.sheetId===helper.sheetId),height=Math.max(...options.map(v=>v.length))+1,requests=[];
  if(existing&&(existing.properties.title!==helper.tab||existing.properties.sheetId!==helper.sheetId||!existing.properties.hidden))throw new Error('HOLD: choice tab binding collision');
  if(!existing)requests.push({addSheet:{properties:{sheetId:helper.sheetId,title:helper.tab,hidden:true,gridProperties:{rowCount:height,columnCount:headers.length}}}});
  else requests.push({updateSheetProperties:{properties:{sheetId:helper.sheetId,gridProperties:{rowCount:Math.max(height,existing.properties.gridProperties.rowCount),columnCount:headers.length}},fields:'gridProperties.rowCount,gridProperties.columnCount'}});
  const rows=Array.from({length:height},(_,r)=>({values:headers.map((h,i)=>r===0?{userEnteredValue:{stringValue:h}}:options[i][r-1]!==undefined?{userEnteredValue:{stringValue:options[i][r-1]}}:{})}));
  requests.push({updateCells:{range:{sheetId:helper.sheetId,startRowIndex:0,endRowIndex:existing?Math.max(height,existing.properties.gridProperties.rowCount):height,startColumnIndex:0,endColumnIndex:headers.length},rows,fields:'userEnteredValue'}});
  let yellowCells=0;
  for(const s of targets){
    const p=s.properties,end=p.gridProperties.rowCount;
    if(p.title!==spec.summaryTitle)headers.forEach((h,i)=>requests.push({setDataValidation:{range:{sheetId:p.sheetId,startRowIndex:1,endRowIndex:end,startColumnIndex:spec.inputHeaders.indexOf(h),endColumnIndex:spec.inputHeaders.indexOf(h)+1},filteredRowsIncluded:true,rule:{condition:{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='${helper.tab}'!$${String.fromCharCode(65+i)}$2:$${String.fromCharCode(65+i)}$${options[i].length+1}`}]},strict:false,showCustomUi:true}}}));
    const cells=rowsById.get(p.sheetId);
    for(let column=0;column<spec.inputHeaders.length;column++){
      let start=null;
      for(let row=0;row<=end;row++){
        const f=cells.get(row)?.[column]?.userEnteredFormat,color=f?.backgroundColorStyle?.rgbColor??f?.backgroundColor;
        const yellow=row<end&&color&&Math.round((color.red??0)*255)===255&&Math.round((color.green??0)*255)===255&&Math.round((color.blue??0)*255)===0;
        if(yellow){yellowCells++;start??=row;}
        else if(start!==null){requests.push({updateCells:{start:{sheetId:p.sheetId,rowIndex:start,columnIndex:column},rows:Array.from({length:row-start},()=>({values:[{userEnteredFormat:{backgroundColor:{red:1,green:1,blue:1},backgroundColorStyle:{rgbColor:{red:1,green:1,blue:1}}}}]})),fields:'userEnteredFormat.backgroundColor,userEnteredFormat.backgroundColorStyle'}});start=null;}
      }
    }
  }
  return {requests,yellowCells,options:Object.fromEntries(headers.map((h,i)=>[h,options[i]]))};
}

// Published static lists only: no vehicle facts, helper formulas, or triggers.
export function planLightweightPresentation(metadata, captures, spec=inputSpec) {
  const policy=spec.dropdownPolicy.lightweight;
  const hold=message=>{throw new Error(`HOLD: ${message}`);};
  if(!policy?.enabled||policy.conditionalCascade||policy.helperFormulas)hold('Lightweight fixed-list policy required');
  const allowed=new Set(spec.supplierChannels.sharedInputSheet.map(s=>s.tab));
  const targets=metadata.sheets.filter(s=>!s.properties.hidden);
  if(targets.some(s=>s.properties.title!==spec.summaryTitle&&!allowed.has(s.properties.title)))hold('Unbound visible tab');
  const master=metadata.sheets.find(s=>s.properties.title===spec.vehicleMaster.tab&&s.properties.hidden);
  if(!master||master.properties.gridProperties.rowCount<policy.masterRangeEnd)hold('Published master missing or too short');
  const requests=[],moves=[];
  const rgb=h=>({red:parseInt(h.slice(1,3),16)/255,green:parseInt(h.slice(3,5),16)/255,blue:parseInt(h.slice(5,7),16)/255});
  for(const sheet of targets){
    const p=sheet.properties,summary=p.title===spec.summaryTitle,end=summary?policy.summaryRows:policy.supplierRows;
    const capture=captures.sheets.find(s=>s.properties.title===p.title),rows=new Map();
    if(!capture)hold(`Full value capture required: ${p.title}`);
    for(const b of capture.data??[])for(const [i,r]of(b.rowData??[]).entries())rows.set((b.startRow??0)+i,r.values??[]);
    if(JSON.stringify((rows.get(0)??[]).map(c=>c.userEnteredValue?.stringValue??''))!==JSON.stringify(spec.inputHeaders))hold('Exact header order required');
    const occupied=[...rows].filter(([r,c])=>r>0&&c.some(v=>v.userEnteredValue&&Object.keys(v.userEnteredValue).length));
    const overflow=occupied.filter(([r])=>r>=end);
    if(occupied.some(([,cells])=>cells.some(c=>c.userEnteredValue?.formulaValue)))hold('Formula dependency review required before shrinking');
    if(summary&&overflow.length)hold('Summary data exceeds target');
    const used=new Set(occupied.map(([r])=>r));
    for(const [source,cells]of overflow){
      let destination=1;while(destination<end&&used.has(destination))destination++;
      if(destination>=end)hold('Supplier data exceeds capacity');
      used.add(destination);moves.push({tab:p.title,from:source+1,to:destination+1});
      const range=row=>({sheetId:p.sheetId,startRowIndex:row,endRowIndex:row+1,startColumnIndex:0,endColumnIndex:spec.inputHeaders.length});
      requests.push({copyPaste:{source:range(source),destination:range(destination),pasteType:'PASTE_NORMAL'}});
      // copyPaste can omit filtered source rows. Explicit values make the
      // preservation independent of the active filter, including 출고불가.
      requests.push({updateCells:{start:{sheetId:p.sheetId,rowIndex:destination,columnIndex:0},rows:[{values:Array.from({length:spec.inputHeaders.length},(_,i)=>cells[i]?.userEnteredValue?{userEnteredValue:cells[i].userEnteredValue}:{})}],fields:'userEnteredValue'}});
    }
    requests.push({updateSheetProperties:{properties:{sheetId:p.sheetId,gridProperties:{rowCount:end}},fields:'gridProperties.rowCount'}});
    // Clear previous presentation rules before rebuilding this narrow scope.
    requests.push({setDataValidation:{range:{sheetId:p.sheetId,startRowIndex:1,endRowIndex:end,startColumnIndex:0,endColumnIndex:spec.inputHeaders.length},filteredRowsIncluded:true}});
    for(let i=(sheet.conditionalFormats?.length??0)-1;i>=0;i--)requests.push({deleteConditionalFormatRule:{sheetId:p.sheetId,index:i}});
    if(!summary)for(const h of [...policy.listHeaders,...policy.masterHeaders]){
      const column=spec.inputHeaders.indexOf(h),boundary=spec.inputHeaders.indexOf(policy.beforeHeader);
      if(column<0||column>=boundary)hold('Dropdown outside pre-rent scope');
      const masterColumn=spec.vehicleMaster.columns[h];
      const helper=policy.validationChoices,choiceSheet=helper?.enabled?metadata.sheets.find(s=>s.properties.sheetId===helper.sheetId&&s.properties.title===helper.tab&&s.properties.hidden):null;
      if(helper?.enabled&&!choiceSheet)hold('Run planInputWarningCleanup to publish input choices first');
      const choiceColumn=String.fromCharCode(65+[...policy.listHeaders,...policy.masterHeaders].indexOf(h));
      const condition=choiceSheet?{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='${helper.tab}'!$${choiceColumn}$2:$${choiceColumn}$${choiceSheet.properties.gridProperties.rowCount}`}]}:masterColumn?{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='${spec.vehicleMaster.tab}'!$${masterColumn}$2:$${masterColumn}$${policy.masterRangeEnd}`}]}:{type:'ONE_OF_LIST',values:spec.dropdowns[h].map(userEnteredValue=>({userEnteredValue}))};
      requests.push({setDataValidation:{range:{sheetId:p.sheetId,startRowIndex:1,endRowIndex:end,startColumnIndex:column,endColumnIndex:column+1},filteredRowsIncluded:true,rule:{condition,strict:false,showCustomUi:true}}});
    }
    for(const h of policy.colorHeaders){
      const column=spec.inputHeaders.indexOf(h);
      if(column<0||column>=spec.inputHeaders.indexOf(policy.beforeHeader))hold('Color outside pre-rent scope');
      for(const [value,color]of Object.entries(spec.retroLook.valueTextColors[h]))requests.push({addConditionalFormatRule:{index:0,rule:{ranges:[{sheetId:p.sheetId,startRowIndex:1,endRowIndex:end,startColumnIndex:column,endColumnIndex:column+1}],booleanRule:{condition:{type:'TEXT_EQ',values:[{userEnteredValue:value}]},format:{textFormat:{foregroundColor:rgb(color),bold:true}}}}}});
    }
  }
  return {status:'PLANNED',requests,moves,missingRegisteredTabs:[...allowed].filter(t=>!targets.some(s=>s.properties.title===t))};
}
