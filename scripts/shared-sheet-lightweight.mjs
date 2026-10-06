import {inputSpec} from './supplier-input-sheet.mjs';

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
      const condition=masterColumn?{type:'ONE_OF_RANGE',values:[{userEnteredValue:`='${spec.vehicleMaster.tab}'!$${masterColumn}$2:$${masterColumn}$${policy.masterRangeEnd}`}]}:{type:'ONE_OF_LIST',values:spec.dropdowns[h].map(userEnteredValue=>({userEnteredValue}))};
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
