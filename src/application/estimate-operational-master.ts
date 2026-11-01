import { stableDigest } from '../shared/stable-digest.js';
import type { OperationalEstimateSourceSnapshot, OperationalMasterDocument } from '../ports/estimate-operational-source.js';

const text = (value:unknown) => typeof value === 'string' ? value.trim() : '';
const own = (value:Record<string,unknown>,key:string) => Object.prototype.hasOwnProperty.call(value,key);
const object = (value:unknown):Record<string,unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : null;
const knownFieldKeys = [
  'modelYear','model_year','year','modelYearId','model_year_id',
  'masterId','master_id','vehicleMasterId','vehicle_master_id',
  'trimMasterId','trim_master_id','vehicleTrimMasterId','vehicle_trim_master_id','trim_row_key','trimKey',
  'priceBefore','priceAfter','priceBasis','optionsMaster','availableOptions','impliedOptions','optionExcludes','exclusiveGroups','extColors','intColors','crawledAt',
] as const;
const trimReferenceKeys = ['trimMasterId','trim_master_id','vehicleTrimMasterId','vehicle_trim_master_id','trim_row_key','trimKey'] as const;
const masterReferenceKeys = ['masterId','master_id','vehicleMasterId','vehicle_master_id'] as const;
function explicitYear(row:Record<string,unknown>) {
  const values = ['modelYear','model_year'].filter(key=>own(row,key)).map(key=>Number(row[key]));
  if (!values.length) return {value:null,reason:'MODEL_YEAR_UNVERIFIED'};
  if (values.some(value=>!Number.isSafeInteger(value)||value<1900||value>2200)) return {value:null,reason:'MODEL_YEAR_INVALID'};
  if (new Set(values).size!==1) return {value:null,reason:'MODEL_YEAR_CONFLICT'};
  return {value:values[0]!,reason:null};
}
const validPrice = (value:unknown,positive=false) => typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive?1:0);
function validColors(raw:unknown) {
  if (!Array.isArray(raw) || raw.length===0) return false;
  const keys = new Set<string>();
  return raw.every(item=>{
    const row=object(item),code=text(row?.code);
    if (!row||!text(row.name)||!code||keys.has(code)||!validPrice(row.price)) return false;
    keys.add(code);return true;
  });
}
function optionsComplete(row:Record<string,unknown>) {
  const master=object(row.optionsMaster),available=row.availableOptions;
  if (!master || !Array.isArray(available) || available.some(value=>typeof value!=='string')) return false;
  const implied=Array.isArray(row.impliedOptions)?row.impliedOptions:[];
  if (new Set(available).size!==available.length) return false;
  if (available.length) {
    const excludes=object(row.optionExcludes),groups=row.exclusiveGroups;
    if(!excludes||!Array.isArray(groups)) return false;
    for(const [id,targets] of Object.entries(excludes)) {
      if(!own(master,id)||!Array.isArray(targets)||targets.some(target=>typeof target!=='string'||!own(master,target))) return false;
    }
    if(groups.some(group=>{
      const g=object(group),members=g?.members;
      return !g||!text(g.id)||!Array.isArray(members)||new Set(members).size!==members.length||members.some(id=>typeof id!=='string'||!own(master,id));
    })) return false;
  }
  return available.every(id=>{
    if (implied.includes(id)) return true;
    const option=object(master[id as string]);
    return option && text(option.name) && !/^옵션\s*\d+$/.test(text(option.name)) && validPrice(option.price)
      && (option.requires===undefined || Array.isArray(option.requires) && option.requires.every(key=>typeof key==='string'&&(available.includes(key)||implied.includes(key))));
  });
}
function uniqueDocuments(documents:OperationalMasterDocument[],name:string) {
  const rows=new Map<string,OperationalMasterDocument>();
  for(const doc of documents) {
    if(!doc.id||rows.has(doc.id)||!object(doc.data)) throw new Error(`ESTIMATE_OPERATIONAL_SOURCE_INVALID:${name}`);
    rows.set(doc.id,doc);
  }
  return rows;
}
export type OperationalEstimateRowDiagnostic = {
  productId:string;
  masterId:string|null;
  trimId:string|null;
  explicitModelYear:number|null;
  status:'READY_FOR_REVIEW'|'HOLD';
  holdReasons:string[];
};

/** Pure source readiness, not a published release and never CANONICAL_ACTIVE metadata.
 * No display-name/fuzzy matching, no current-calendar year, no generated master identity.
 */
export function inspectOperationalEstimateSource(snapshot:OperationalEstimateSourceSnapshot, now=Date.now()) {
  if(snapshot.contract!=='estimate-operational-source-snapshot/v1'||snapshot.source!=='freepasserp5/vehicle_master+vehicle_trim_master+new_car_trim'||snapshot.complete!==true||!Number.isFinite(Date.parse(snapshot.readAt))) {
    throw new Error('ESTIMATE_OPERATIONAL_SOURCE_INVALID');
  }
  const age=now-Date.parse(snapshot.readAt);
  if(!Number.isFinite(age)||age < -1000||age>300000) throw new Error('ESTIMATE_OPERATIONAL_SOURCE_STALE');
  if(stableDigest({masters:snapshot.masters,trims:snapshot.trims,newCarTrims:snapshot.newCarTrims})!==snapshot.inputDigest) throw new Error('ESTIMATE_OPERATIONAL_SOURCE_DIGEST_MISMATCH');
  const masters=uniqueDocuments(snapshot.masters,'masters'),trims=uniqueDocuments(snapshot.trims,'trims');
  uniqueDocuments(snapshot.newCarTrims,'newCarTrims');
  const trimByRowKey=new Map<string,OperationalMasterDocument[]>();
  for(const trim of trims.values()) {
    const key=text(trim.data.trim_row_key);
    if(key) trimByRowKey.set(key,[...(trimByRowKey.get(key)||[]),trim]);
  }
  const fields=new Set<string>();
  let explicitYears=0,priceComplete=0,optionComplete=0,colorComplete=0,exactTrimReferences=0;
  const rows:OperationalEstimateRowDiagnostic[]=snapshot.newCarTrims.map(product=>{
    const raw=product.data,reasons:string[]=[];
    for(const key of knownFieldKeys) if(own(raw,key)) fields.add(key);
    const year=explicitYear(raw);if(year.reason) reasons.push(year.reason);else explicitYears++;
    const references=[...new Set(trimReferenceKeys.map(key=>text(raw[key])).filter(Boolean))];
    const matches=new Map<string,OperationalMasterDocument>();
    for(const reference of references) {
      const direct=trims.get(reference);
      for(const match of direct?[direct]:(trimByRowKey.get(reference)||[])) matches.set(match.id,match);
    }
    const trim=matches.size===1?[...matches.values()][0]!:null;
    if(!trim) reasons.push(matches.size>1?'TRIM_REFERENCE_AMBIGUOUS':'EXACT_TRIM_REFERENCE_REQUIRED');
    else exactTrimReferences++;
    if(trim && references.some(reference=>reference!==trim.id&&reference!==text(trim.data.trim_row_key))) reasons.push('TRIM_REFERENCE_CONFLICT');
    const parentId=trim?text(trim.data.master_id):'';
    const master=parentId?masters.get(parentId):null;
    if(trim && !master) reasons.push('MASTER_REFERENCE_NOT_FOUND');
    if(master && masterReferenceKeys.some(key=>text(raw[key])&&text(raw[key])!==master.id)) reasons.push('MASTER_REFERENCE_CONFLICT');
    if(trim?.data.retired===true||master?.data.retired===true) reasons.push('MASTER_REFERENCE_RETIRED');
    if(trim&&master) {
      if(['maker','model','sub_model'].some(key=>!text(master.data[key])||text(master.data[key])!==text(trim.data[key]))||!text(trim.data.trim)) reasons.push('MASTER_IDENTITY_DRIFT');
      for(const [key,expected] of [['maker',master.data.maker],['sub_model',master.data.sub_model],['trim',trim.data.trim]] as const) {
        if(text(raw[key])&&text(raw[key])!==text(expected)) reasons.push('PRODUCT_IDENTITY_DRIFT');
      }
      const start=Number(trim.data.model_year_start),end=Number(trim.data.model_year_end);
      if(year.value!=null&&(Number.isInteger(start)&&start>0&&year.value<start||Number.isInteger(end)&&end>0&&year.value>end)) reasons.push('PRODUCT_MODEL_YEAR_OUTSIDE_MASTER_RANGE');
    }
    if(validPrice(raw.priceBefore,true)||validPrice(raw.priceAfter,true)) priceComplete++;else reasons.push('BASE_PRICE_UNVERIFIED');
    if(optionsComplete(raw)) optionComplete++;else reasons.push('OPTIONS_UNVERIFIED');
    if(validColors(raw.extColors)&&validColors(raw.intColors)) colorComplete++;else reasons.push('COLORS_UNVERIFIED');
    return {productId:product.id,masterId:master?.id||null,trimId:trim?.id||null,explicitModelYear:year.value,status:reasons.length?'HOLD':'READY_FOR_REVIEW',holdReasons:[...new Set(reasons)]};
  });
  const counts=new Map<string,number>();
  for(const row of rows)for(const reason of row.holdReasons)counts.set(reason,(counts.get(reason)||0)+1);
  const ready=rows.filter(row=>row.status==='READY_FOR_REVIEW').length;
  // Inventory is distinct from quote readiness. Catalog-only manufacturers must
  // remain visible in diagnostics without claiming that they have live tariffs.
  const inventory=new Map<string,{maker:string|null;masters:number;models:Set<string>;retiredMasters:number;trims:number;retiredTrims:number;products:number;exactlyLinkedProducts:number;readyForReviewProducts:number;holdProducts:number;reasons:Map<string,number>}>();
  const makerInventory=(raw:Record<string,unknown>)=>{
    const maker=text(raw.maker),key=maker||'\u0000UNSPECIFIED';
    if(!inventory.has(key))inventory.set(key,{maker:maker||null,masters:0,models:new Set(),retiredMasters:0,trims:0,retiredTrims:0,products:0,exactlyLinkedProducts:0,readyForReviewProducts:0,holdProducts:0,reasons:new Map()});
    return inventory.get(key)!;
  };
  for(const master of masters.values()){const item=makerInventory(master.data);item.masters++;if(text(master.data.model))item.models.add(text(master.data.model));if(master.data.retired===true)item.retiredMasters++;}
  for(const trim of trims.values()){const item=makerInventory(trim.data);item.trims++;if(trim.data.retired===true)item.retiredTrims++;}
  snapshot.newCarTrims.forEach((product,index)=>{const item=makerInventory(product.data),diagnostic=rows[index]!;item.products++;if(diagnostic.masterId&&diagnostic.trimId)item.exactlyLinkedProducts++;if(diagnostic.status==='READY_FOR_REVIEW')item.readyForReviewProducts++;else item.holdProducts++;for(const reason of diagnostic.holdReasons)item.reasons.set(reason,(item.reasons.get(reason)||0)+1);});
  const manufacturerInventory=[...inventory.values()].sort((a,b)=>(a.maker||'').localeCompare(b.maker||'')).map(item=>({maker:item.maker,catalogMasters:item.masters,catalogModels:item.models.size,retiredMasters:item.retiredMasters,catalogTrims:item.trims,retiredTrims:item.retiredTrims,newCarProducts:item.products,exactlyLinkedProducts:item.exactlyLinkedProducts,readyForReviewProducts:item.readyForReviewProducts,holdProducts:item.holdProducts,holdReasons:[...item.reasons].sort(([a],[b])=>a.localeCompare(b)).map(([reason,count])=>({reason,count}))}));

  return {
    summary:{contract:'estimate-operational-source-readiness/v1',source:snapshot.source,readAt:snapshot.readAt,inputDigest:snapshot.inputDigest,publicationState:'NOT_PUBLISHED',manufacturerInventory,
      counts:{masters:masters.size,trims:trims.size,products:rows.length,explicitModelYearProducts:explicitYears,exactTrimReferences,priceCompleteProducts:priceComplete,optionCompleteProducts:optionComplete,colorCompleteProducts:colorComplete,readyForReview:ready,hold:rows.length-ready},
      knownFieldKeysPresent:[...fields].sort(),holdReasons:[...counts].sort(([a],[b])=>a.localeCompare(b)).map(([reason,count])=>({reason,count}))},
    rows,
  };
}

/** Manual read-only identity/price review. Not a master export or publication input. */
export function operationalEstimateIdentityReview(snapshot:OperationalEstimateSourceSnapshot,now=Date.now()) {
  inspectOperationalEstimateSource(snapshot,now);
  const fields=['maker','model','sub_model','trim','powertrain','fuel','fuelRaw','drivetrain','seats','engine_cc','displacement_l','turbo','modelYear','model_year','model_year_start','model_year_end','year_start','year_end','retired','master_id','trim_row_key','powertrain_seq','trim_seq','trimKey','carType','priceBefore','priceAfter','priceBasis','crawledAt',...masterReferenceKeys,...trimReferenceKeys];
  const project=(documents:OperationalMasterDocument[])=>documents.map(doc=>({id:doc.id,updateTime:doc.updateTime,fields:Object.fromEntries([...new Set(fields)].filter(key=>own(doc.data,key)&& (doc.data[key]==null||['string','number','boolean'].includes(typeof doc.data[key]))).map(key=>[key,doc.data[key]]))}));
  return {contract:'estimate-operational-identity-review/v1',readOnly:true,notCanonicalPublished:true,canIssueQuote:false,source:snapshot.source,readAt:snapshot.readAt,sourceInputDigest:snapshot.inputDigest,masters:project(snapshot.masters),trims:project(snapshot.trims),products:project(snapshot.newCarTrims)};
}
