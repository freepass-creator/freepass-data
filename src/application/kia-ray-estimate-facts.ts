import type { parseKiaRayOfficialFacts } from '../adapters/kia-ray-official-facts-parser.js';
import type { OperationalManufacturerFacts } from '../domain/estimate-operational-publication.js';

export type KiaRayOfficialRecord = ReturnType<typeof parseKiaRayOfficialFacts>['records'][number];
export type KiaRayEstimateFactsSources = {
  sourceDocumentId:string;
  sourceBytesSha256:string;
  trimRowKey:string;
  sourceDocumentsByUrl:Record<string,{id:string;sha256:string}>;
};
const fail=(reason:string):never=>{throw new Error('KIA_RAY_ESTIMATE_FACTS_'+reason);};
const required=(value:string)=>typeof value==='string'&&value.trim()?value:fail('IDENTITY_REQUIRED');
const sha=(value:string)=>/^[a-f0-9]{64}$/.test(value);
const money=(amount:number)=>Number.isSafeInteger(amount)&&amount>=0?{amount,currency:'KRW' as const}:fail('EXPLICIT_PRICE_REQUIRED');

/** Pure projection of the fully reconciled manufacturer parser result; never reads storage or network. */
export function mapKiaRayEstimateFacts(record:KiaRayOfficialRecord,sources:KiaRayEstimateFactsSources):OperationalManufacturerFacts {
  const primary=record.evidence.baseAndOptions[0];
  required(sources.sourceDocumentId);required(sources.trimRowKey);
  if(!primary||primary.url!=='https://www.kia.com/kr/vehicles/ray/price'||!sha(sources.sourceBytesSha256)||primary.sha256!==sources.sourceBytesSha256)fail('PRIMARY_SOURCE_MISMATCH');
  if(record.modelYear!==2027||record.maker!=='기아'||record.model!=='레이'||record.powertrainName!=='1.0 가솔린'||record.seats!==5||!['2905','2906'].includes(record.sourceTrimNo))fail('UNREVIEWED_SCOPE');
  if(!record.scope.allOptionSubsetsVerified||record.scope.postDeliveryAccessoriesIncluded!==false||record.evidence.baseAndOptions.length!==4||record.evidence.combinations.length!==12)fail('COMPLETE_EVIDENCE_REQUIRED');
  const fieldSources:Record<string,string>={modelYear:sources.sourceDocumentId,basePrice:sources.sourceDocumentId,priceBefore:sources.sourceDocumentId,priceAfter:sources.sourceDocumentId,options:sources.sourceDocumentId};
  const additionalSourceDocuments:Array<{id:string;sha256:string}>=[];
  const ids=new Set([sources.sourceDocumentId]);
  const bind=(evidence:{url:string;sha256:string},field:string)=>{
    const ref=sources.sourceDocumentsByUrl[evidence.url];
    if(!ref)return fail('ADDITIONAL_SOURCE_MISMATCH');
    if(!ref.id?.trim()||!sha(ref.sha256)||ref.sha256!==evidence.sha256||ids.has(ref.id))fail('ADDITIONAL_SOURCE_MISMATCH');
    ids.add(ref.id);additionalSourceDocuments.push({id:ref.id,sha256:ref.sha256});fieldSources[field]=ref.id;
    return ref.id;
  };
  const trims=bind(record.evidence.baseAndOptions[1]!,'physical');
  fieldSources.exteriorColors=trims;fieldSources.interiorColors=trims;fieldSources.trimName=trims;
  record.evidence.baseAndOptions.slice(2).forEach((evidence,i)=>bind(evidence,`options.factorySpec.${i===0?'A':'N'}`));
  const combinations=new Set<string>();
  record.evidence.combinations.forEach(evidence=>{
    const key=`${evidence.exteriorCode}.${evidence.interiorSpecCode}`;
    if(combinations.has(key)||evidence.combinations!==2**record.options.length)fail('COMPLETE_EVIDENCE_REQUIRED');
    combinations.add(key);bind(evidence,`configuration.validCombinations.${key}`);
  });
  if(record.options.length!==(record.sourceTrimNo==='2905'?5:2)||record.exteriorColors.length!==6||record.interiorColors.length!==2)fail('UNREVIEWED_SCOPE');
  for(const exterior of record.exteriorColors)for(const interior of record.interiorColors)if(!combinations.has(`${exterior.sourceColorCode}.${interior.sourceSpecCode}`))fail('COMPLETE_EVIDENCE_REQUIRED');
  return {
    contract:'estimate-manufacturer-facts/v1',sourceDocumentId:sources.sourceDocumentId,sourceBytesSha256:sources.sourceBytesSha256,
    additionalSourceDocuments,fieldSources,maker:record.maker,model:record.model,trimName:record.trimName,modelYear:record.modelYear,
    basePrice:money(record.basePrice),priceBefore:money(record.basePrice),priceAfter:money(record.basePrice),priceBasis:'MANUFACTURER_OFFICIAL_SALE_PRICE',
    options:record.options.map(option=>{
      if(option.requires.length||option.excludes.length)fail('UNREVIEWED_CONSTRAINT');
      return {optionId:`${sources.trimRowKey}::option:${required(option.sourceOptionCode)}`,name:required(option.name),price:money(option.price),requires:[],excludes:[],exclusiveGroupId:null};
    }),
    exteriorColors:record.exteriorColors.map(color=>({colorId:`${sources.trimRowKey}::exterior:${required(color.sourceColorCode)}`,code:color.sourceColorCode,name:required(color.name),price:money(color.price)})),
    interiorColors:record.interiorColors.map(color=>({colorId:`${sources.trimRowKey}::interior:${required(color.sourceColorCode)}:${required(color.sourceSpecCode)}`,code:color.sourceColorKey,name:required(color.name),price:money(color.price)})),
    physical:{fuel:'가솔린',seats:record.seats,engineCc:null,turbo:null,drivetrain:null,bodyConfiguration:null},
  };
}
