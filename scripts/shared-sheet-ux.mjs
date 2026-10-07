import {inputSpec} from './supplier-input-sheet.mjs';
import {verifyLockedTabInventory} from './shared-sheet-lightweight.mjs';

export function planFilterRangeRepair(metadata,spec=inputSpec){
  verifyLockedTabInventory(metadata,spec);
  return metadata.sheets.filter(s=>!s.properties.hidden).flatMap(s=>{
    const p=s.properties,f=s.basicFilter;
    if(!f)return []; // Do not invent a missing filter or erase user's selection.
    const range={sheetId:p.sheetId,startRowIndex:0,endRowIndex:p.gridProperties.rowCount,startColumnIndex:0,endColumnIndex:spec.inputHeaders.length};
    if(JSON.stringify(f.range)===JSON.stringify(range))return [];
    if((f.sortSpecs??[]).length)throw new Error('HOLD: sorted filter requires value-order preservation review');
    return [{setBasicFilter:{filter:{...f,range}}}];
  });
}

export function planHeaderProtection(metadata,spec=inputSpec){
  verifyLockedTabInventory(metadata,spec);
  if(!spec.uiOwnership?.headerProtection)throw new Error('HOLD: protection ownership required');
  return metadata.sheets.filter(s=>!s.properties.hidden).flatMap(s=>{
    const range={sheetId:s.properties.sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:spec.inputHeaders.length};
    const existing=(s.protectedRanges??[]).find(p=>JSON.stringify(p.range)===JSON.stringify(range));
    if(existing){
      if(Boolean(existing.warningOnly)!==Boolean(spec.uiOwnership.headerProtection.warningOnly)||(!existing.warningOnly&&JSON.stringify(existing.editors?.users)!==JSON.stringify(spec.uiOwnership.headerProtection.editors)))throw new Error('HOLD: existing protection owner drift; no silent ACL rewrite');
      return [];
    }
    return [{addProtectedRange:{protectedRange:{range,description:`공통시트 정본 머리글 / ${spec.changeControl.baselineVersion}`,warningOnly:spec.uiOwnership.headerProtection.warningOnly,...(spec.uiOwnership.headerProtection.warningOnly?{}:{editors:{users:spec.uiOwnership.headerProtection.editors}})}}}];
  });
}

// This writer owns presentation only. Supplier values/formulas belong to input owners.
export function assertUxRequests(requests) {
  const allowed=new Set(['repeatCell','updateCells','addConditionalFormatRule','setDataValidation']);
  for(const request of requests){
    const keys=Object.keys(request);
    if(keys.length!==1||!allowed.has(keys[0]))throw new Error('HOLD: UX request outside presentation ownership');
    const key=keys[0],body=request[key];
    if(['repeatCell','updateCells'].includes(key)){
      const fields=body.fields.split(',');
      if(fields.some(f=>!['note','userEnteredFormat.textFormat.fontSize','userEnteredFormat.numberFormat'].includes(f)))throw new Error('HOLD: UX writer cannot mutate input values or structural fields');
      if(key==='updateCells'&&body.start?.rowIndex!==0)throw new Error('HOLD: notes restricted to header');
    }
    if(key==='addConditionalFormatRule'&&(body.rule.booleanRule?.condition.type!=='TEXT_EQ'||body.rule.ranges.some(r=>r.startColumnIndex!==2||r.endColumnIndex!==3||r.endRowIndex>300)))throw new Error('HOLD: status rules must be bounded exact-value matches');
    if(key==='setDataValidation'&&(body.range.startColumnIndex!==2||body.range.endColumnIndex!==3||body.rule.strict!==false))throw new Error('HOLD: status validation scope');
  }
}

export function planSharedSheetUx(metadata,capture,spec=inputSpec){
  verifyLockedTabInventory(metadata,spec);
  if(!spec.uiOwnership?.statusDisplay)throw new Error('HOLD: versioned UI ownership required');
  const requests=[];
  for(const sheet of metadata.sheets.filter(s=>!s.properties.hidden)){
    const p=sheet.properties, data=capture.sheets.find(s=>s.properties.sheetId===p.sheetId);
    const header=data?.data?.find(b=>(b.startRow??0)===0)?.rowData?.[0]?.values?.map(c=>c.userEnteredValue?.stringValue);
    if(JSON.stringify(header)!==JSON.stringify(spec.inputHeaders))throw new Error('HOLD: fresh exact header capture required');
    const range={sheetId:p.sheetId,startRowIndex:0,endRowIndex:p.gridProperties.rowCount,startColumnIndex:0,endColumnIndex:74};
    requests.push({repeatCell:{range,cell:{userEnteredFormat:{textFormat:{fontSize:spec.font.size}}},fields:'userEnteredFormat.textFormat.fontSize'}});
    for(const h of ['입고일자','최초등록일']){
      const col=spec.inputHeaders.indexOf(h);
      requests.push({repeatCell:{range:{...range,startRowIndex:1,startColumnIndex:col,endColumnIndex:col+1},cell:{userEnteredFormat:{numberFormat:{type:'DATE',pattern:spec.valueFormats[h].pattern}}},fields:'userEnteredFormat.numberFormat'}});
    }
    requests.push({updateCells:{start:{sheetId:p.sheetId,rowIndex:0,columnIndex:0},rows:[{values:spec.inputHeaders.map(h=>({note:`${spec.uiOwnership.headerNote}\n${h==='차량상태'?spec.uiOwnership.statusNote:h==='입고일자'||h==='최초등록일'?'날짜 yy-mm-dd. 일 미확정 연월은 yy-mm 원문 유지.':''}`}))}],fields:'note'}});
    for(const [value,color] of Object.entries(spec.uiOwnership.statusDisplay)){
      const hex=color.slice(1),rgb={red:parseInt(hex.slice(0,2),16)/255,green:parseInt(hex.slice(2,4),16)/255,blue:parseInt(hex.slice(4,6),16)/255};
      if(!(sheet.conditionalFormats??[]).some(r=>r.booleanRule?.condition.values?.[0]?.userEnteredValue===value&&r.ranges?.some(r=>r.startColumnIndex===2)))requests.push({addConditionalFormatRule:{index:0,rule:{ranges:[{...range,startRowIndex:1,startColumnIndex:2,endColumnIndex:3}],booleanRule:{condition:{type:'TEXT_EQ',values:[{userEnteredValue:value}]},format:{textFormat:{foregroundColor:rgb,bold:true}}}}}});
    }
    if(p.title!==spec.summaryTitle)requests.push({setDataValidation:{range:{...range,startRowIndex:1,startColumnIndex:2,endColumnIndex:3},filteredRowsIncluded:true,rule:{condition:{type:'ONE_OF_LIST',values:spec.dropdowns['차량상태'].map(userEnteredValue=>({userEnteredValue}))},strict:false,showCustomUi:true}}});
  }
  assertUxRequests(requests);
  return {baselineVersion:spec.changeControl.baselineVersion,requests};
}
