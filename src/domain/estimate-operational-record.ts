import { buildEstimateNewcarMasterRecord } from './estimate-master.js';
import type { OperationalMasterDocument } from './estimate-operational-source.js';
import type { OperationalEstimateReviewedBinding, OperationalManufacturerFacts, OperationalManufacturerFactsPacket } from './estimate-operational-publication.js';
import { stableDigest } from '../shared/stable-digest.js';
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function requireText(value:unknown,reason:string):string {const result=text(value);if(!result)throw new Error(reason);return result;}
function atPath(value:unknown,path:string):unknown {
  if(!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(path)||path.split('.').some(part=>['__proto__','prototype','constructor'].includes(part))) throw new Error('ESTIMATE_MANUFACTURER_FACTS_PATH_INVALID');
  let node=value;
  for(const key of path.split('.')) {if(!node||typeof node!=='object'||!Object.hasOwn(node,key))return undefined;node=(node as Record<string,unknown>)[key];}
  return node;
}
export function operationalManufacturerFacts(packet:OperationalManufacturerFactsPacket,binding:OperationalEstimateReviewedBinding):OperationalManufacturerFacts {
  if(packet.sourceDocument.collection!=='vehicle_master_source_documents'||packet.normalizedDocument.collection!=='vehicle_master_normalized_records'||packet.sourceDocument.id!==binding.sourceDocumentId||packet.normalizedDocument.id!==binding.normalizedDocumentId||packet.normalizedFactsPath!==binding.normalizedFactsPath)throw new Error('ESTIMATE_MANUFACTURER_SOURCE_BINDING_MISMATCH');
  if(packet.normalizedDocument.data.sourceDocumentId!==packet.sourceDocument.id)throw new Error('ESTIMATE_MANUFACTURER_SOURCE_BINDING_MISMATCH');
  const source=packet.sourceDocument.data;
  if(source.sourceType!=='MANUFACTURER_OFFICIAL'||!sha(source.sha256)||!Number.isFinite(Date.parse(text(source.observedAt))))throw new Error('ESTIMATE_MANUFACTURER_SOURCE_EVIDENCE_REQUIRED');
  let url:URL;try{url=new URL(text(source.sourceUrl));}catch{throw new Error('ESTIMATE_MANUFACTURER_SOURCE_EVIDENCE_REQUIRED');}
  if(url.protocol!=='https:'||!['kia.com','hyundai.com','genesis.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))throw new Error('ESTIMATE_MANUFACTURER_SOURCE_EVIDENCE_REQUIRED');
  const facts=atPath(packet.normalizedDocument.data,packet.normalizedFactsPath) as OperationalManufacturerFacts|undefined;
  if(!facts||facts.contract!=='estimate-manufacturer-facts/v1'||facts.sourceDocumentId!==packet.sourceDocument.id||facts.sourceBytesSha256!==source.sha256||stableDigest(facts)!==binding.manufacturerFactsDigest)throw new Error('ESTIMATE_MANUFACTURER_FACTS_REQUIRED');
  const additional=facts.additionalSourceDocuments??[],documents=packet.additionalSourceDocuments??[];
  if(additional.length!==documents.length||new Set(additional.map(ref=>ref.id)).size!==additional.length)throw new Error('ESTIMATE_MANUFACTURER_ADDITIONAL_SOURCE_REQUIRED');
  const knownSources=new Set([packet.sourceDocument.id,...additional.map(ref=>ref.id)]);
  for(const ref of additional) {
    const matches=documents.filter(document=>document.id===ref.id);
    if(matches.length!==1||ref.id===packet.sourceDocument.id||!sha(ref.sha256))throw new Error('ESTIMATE_MANUFACTURER_ADDITIONAL_SOURCE_REQUIRED');
    const document=matches[0]!,data=document.data;
    if(document.collection!=='vehicle_master_source_documents'||data.sourceType!=='MANUFACTURER_OFFICIAL'||data.sha256!==ref.sha256||!Number.isFinite(Date.parse(text(data.observedAt))))throw new Error('ESTIMATE_MANUFACTURER_ADDITIONAL_SOURCE_REQUIRED');
    let sourceUrl:URL;try{sourceUrl=new URL(text(data.sourceUrl));}catch{throw new Error('ESTIMATE_MANUFACTURER_ADDITIONAL_SOURCE_REQUIRED');}
    if(sourceUrl.protocol!=='https:'||!['kia.com','hyundai.com','genesis.com'].some(host=>sourceUrl.hostname===host||sourceUrl.hostname.endsWith('.'+host)))throw new Error('ESTIMATE_MANUFACTURER_ADDITIONAL_SOURCE_REQUIRED');
  }
  if(additional.length&&(!facts.fieldSources||!Object.keys(facts.fieldSources).length||additional.some(ref=>!Object.values(facts.fieldSources!).includes(ref.id))))throw new Error('ESTIMATE_MANUFACTURER_FIELD_SOURCES_REQUIRED');
  if(facts.fieldSources&&Object.values(facts.fieldSources).some(id=>!knownSources.has(id)))throw new Error('ESTIMATE_MANUFACTURER_FIELD_SOURCES_REQUIRED');
  return facts;
}
function compareKnownPhysical(trim:Record<string,unknown>,facts:OperationalManufacturerFacts) {
  const source=facts.physical;
  if(!source)throw new Error('ESTIMATE_MANUFACTURER_PHYSICAL_FACTS_REQUIRED');
  for(const [field,value] of [['engine_cc',source.engineCc],['seats',source.seats],['turbo',source.turbo],['drivetrain',source.drivetrain],['fuel',source.fuel]] as const) {
    if(trim[field]!==undefined&&trim[field]!==null&&trim[field]!==''&&value!==null&&String(trim[field])!==String(value))throw new Error('ESTIMATE_OPERATIONAL_MASTER_PHYSICAL_CONFLICT:'+field);
  }
}

export function deriveOperationalEstimateRecord(master:OperationalMasterDocument,trim:OperationalMasterDocument,facts:OperationalManufacturerFacts,binding:OperationalEstimateReviewedBinding,product:OperationalMasterDocument) {
  if(master.id!==binding.masterId||trim.id!==binding.trimId||trim.data.master_id!==master.id||master.data.retired===true||trim.data.retired===true||['maker','model','sub_model'].some(key=>!text(master.data[key])||master.data[key]!==trim.data[key]))throw new Error('ESTIMATE_OPERATIONAL_MASTER_IDENTITY_CONFLICT');
  for(const data of [master.data,trim.data]) {
    if(data.market_status!==undefined&&data.market_status!=='신차'||data.usage_tier!==undefined&&data.usage_tier!=='automatic')throw new Error('ESTIMATE_OPERATIONAL_MASTER_NOT_APPROVED_FOR_NEW_CAR');
  }
  if(facts.maker!==master.data.maker||facts.model!==master.data.model||facts.trimName!==trim.data.trim)throw new Error('ESTIMATE_MANUFACTURER_IDENTITY_CONFLICT');
  if(!Number.isSafeInteger(facts.modelYear)||facts.modelYear<1900||facts.modelYear>2200)throw new Error('ESTIMATE_MANUFACTURER_MODEL_YEAR_REQUIRED');
  for(const key of ['modelYear','model_year'])if(product.data[key]!=null&&Number(product.data[key])!==facts.modelYear)throw new Error('ESTIMATE_MANUFACTURER_MODEL_YEAR_CONFLICT');
  const start=Number(trim.data.model_year_start),end=Number(trim.data.model_year_end);
  if(Number.isInteger(start)&&start>0&&facts.modelYear<start||Number.isInteger(end)&&end>0&&facts.modelYear>end)throw new Error('ESTIMATE_MANUFACTURER_MODEL_YEAR_CONFLICT');
  compareKnownPhysical(trim.data,facts);
  const record=buildEstimateNewcarMasterRecord({productId:binding.productId,vehicleModelId:requireText(binding.vehicleModelId,'ESTIMATE_REVIEWED_ID_REQUIRED'),modelYearId:requireText(binding.modelYearId,'ESTIMATE_REVIEWED_ID_REQUIRED'),trimId:trim.id,powertrainId:requireText(binding.powertrainId,'ESTIMATE_REVIEWED_ID_REQUIRED'),
    maker:String(master.data.maker),model:String(master.data.model),modelYear:facts.modelYear,trimName:String(trim.data.trim),powertrainName:requireText(trim.data.powertrain,'ESTIMATE_MASTER_POWERTRAIN_REQUIRED'),basePrice:facts.basePrice,priceBefore:facts.priceBefore,priceAfter:facts.priceAfter,priceBasis:facts.priceBasis,
    options:facts.options,exteriorColors:facts.exteriorColors,interiorColors:facts.interiorColors,configuration:{drivetrain:facts.physical.drivetrain,seats:facts.physical.seats,bodyConfiguration:facts.physical.bodyConfiguration},holdReasons:[]});
  if(record.status!=='ACTIVE'||!record.exteriorColors.length||!record.interiorColors.length)throw new Error('ESTIMATE_MANUFACTURER_FACTS_INCOMPLETE');
  return record;
}
