import { parseKiaRayOfficialFacts, type KiaRaySourceBytes, type KiaRayOfficialFactsInput } from '../adapters/kia-ray-official-facts-parser.js';
import { mapKiaRayEstimateFacts } from './kia-ray-estimate-facts.js';
import { prepareOperationalEstimatePublication, publishOperationalEstimateMaster } from './estimate-operational-publication.js';
import { inspectOperationalEstimateSource } from './estimate-operational-master.js';
import { KIA_RAY_SOURCE_PLAN, KIA_RAY_REVIEWED_BINDINGS, KIA_RAY_REVIEWED_FACTS_DIGEST } from '../domain/kia-ray-recovery-preset.js';
import type { OperationalEstimateSourceSnapshot, OperationalMasterDocument } from '../ports/estimate-operational-source.js';
import type { OperationalEstimateSourceDocument, OperationalManufacturerFactsPacket, OperationalManufacturerFacts, OperationalEstimatePublicationPlan, OperationalEstimateReviewedBinding } from '../domain/estimate-operational-publication.js';
import type { ProjectionStore } from '../ports/catalog-store.js';
import { stableDigest } from '../shared/stable-digest.js';

type Captured=KiaRaySourceBytes & {document:OperationalEstimateSourceDocument};
export type EstimateRecoveryPorts={
  snapshot:()=>Promise<OperationalEstimateSourceSnapshot>;
  capture:(url:string,observedAt:string)=>Promise<Captured>;
  normalize:(facts:OperationalManufacturerFacts,observedAt:string,additional:OperationalEstimateSourceDocument[])=>Promise<OperationalManufacturerFactsPacket>;
  savePlan:(plan:OperationalEstimatePublicationPlan)=>Promise<string>;
  loadPlan:(id:string)=>Promise<OperationalEstimatePublicationPlan>;
  projection:ProjectionStore;
  now:()=>string;
};
function exact(rows:OperationalMasterDocument[],id:string){const found=rows.filter(row=>row.id===id||row.data.trim_row_key===id);if(found.length!==1)throw new Error('ESTIMATE_RECOVERY_EXACT_IDENTITY_REQUIRED:'+id);return found[0]!;}
export async function runKiaRayEstimateRecovery(ports:EstimateRecoveryPorts,input:{mode:'inspect'|'prepare'|'publish'|'restore';planId?:string;planDigest?:string}) {
  if(input.mode==='inspect')return {mode:input.mode,status:'INSPECTED',source:inspectOperationalEstimateSource(await ports.snapshot()).summary};
  if(input.mode==='publish') {
    if(!input.planId||!input.planDigest||!/^[a-f0-9]{64}$/.test(input.planDigest))throw new Error('ESTIMATE_RECOVERY_REVIEWED_PLAN_REQUIRED');
    const plan=await ports.loadPlan(input.planId);
    if(stableDigest(plan)!==input.planDigest)throw new Error('ESTIMATE_RECOVERY_PLAN_DIGEST_MISMATCH');
    return {mode:input.mode,...await publishOperationalEstimateMaster(ports.projection,plan,ports.now)};
  }
  const current=await ports.projection.getActive('estimate-newcar-master');
  if(input.mode==='restore'&&current) {
    // Never replace an existing release with the narrow first-release scope.
    const ids=current.data.map(row=>row.productId).sort();
    const manifest=await ports.projection.getManifest(current.releaseId);
    if(manifest?.operationalEstimateProof?.approval.reviewId!=='user-directed-ray-2027-recovery-v1'||manifest.operationalEstimateProof.publicationRevision!==1||manifest.operationalEstimateProof.expectedActiveReleaseId!==null||stableDigest(ids)!==stableDigest(KIA_RAY_REVIEWED_BINDINGS.map(row=>row.productId).sort()))throw new Error('ESTIMATE_RECOVERY_ACTIVE_RELEASE_ALREADY_PRESENT');
    return {mode:input.mode,status:'ALREADY_ACTIVE',releaseId:current.releaseId};
  }
  const observedAt=ports.now();
  const captured=new Map<string,Captured>();
  const get=async<T extends {url:string}>(descriptor:T)=>{
    const result=await ports.capture(descriptor.url,observedAt);captured.set(descriptor.url,result);return {...descriptor,url:result.url,bytes:result.bytes};
  };
  // A deliberately bounded anonymous manufacturer read plan, not a crawler.
  const pricePage=await get(KIA_RAY_SOURCE_PLAN.pricePage),trims=await get(KIA_RAY_SOURCE_PLAN.trims);
  const options:KiaRayOfficialFactsInput['options']=[];
  for(const descriptor of KIA_RAY_SOURCE_PLAN.options)options.push(await get(descriptor));
  const combinations:KiaRayOfficialFactsInput['combinations']=[];
  for(const descriptor of KIA_RAY_SOURCE_PLAN.combinations)combinations.push(await get(descriptor));
  const parsed=parseKiaRayOfficialFacts({observedAt,pricePage,trims,options,combinations});
  const semantic=parsed.records.map(({evidence,...record})=>record);
  if(stableDigest(semantic)!==KIA_RAY_REVIEWED_FACTS_DIGEST)throw new Error('ESTIMATE_RECOVERY_MANUFACTURER_FACTS_CHANGED_REVIEW_REQUIRED');
  const sourceDocumentsByUrl=Object.fromEntries([...captured].map(([url,item])=>[url,{id:item.document.id,sha256:String(item.document.data.sha256)}]));
  const packets:OperationalManufacturerFactsPacket[]=[];
  for(const binding of KIA_RAY_REVIEWED_BINDINGS) {
    const record=parsed.records.find(row=>row.sourceTrimNo===binding.sourceTrimNo);
    if(!record||record.trimName!==binding.trimName)throw new Error('ESTIMATE_RECOVERY_MANUFACTURER_IDENTITY_REQUIRED');
    const primary=captured.get(pricePage.url)!.document;
    const facts=mapKiaRayEstimateFacts(record,{sourceDocumentId:primary.id,sourceBytesSha256:String(primary.data.sha256),trimRowKey:binding.trimRowKey,sourceDocumentsByUrl});
    const additional=(facts.additionalSourceDocuments??[]).map(ref=>{const item=[...captured.values()].find(row=>row.document.id===ref.id);if(!item)throw new Error('ESTIMATE_RECOVERY_SOURCE_MISSING');return item.document;});
    packets.push(await ports.normalize(facts,observedAt,additional));
  }
  const snapshot=await ports.snapshot(),now=ports.now();
  const bindings:OperationalEstimateReviewedBinding[]=KIA_RAY_REVIEWED_BINDINGS.map((binding,index)=>{
    const master=exact(snapshot.masters,binding.masterId),trim=exact(snapshot.trims,binding.trimRowKey),product=exact(snapshot.newCarTrims,binding.productId),packet=packets[index]!;
    if(master.data.maker!=='기아'||master.data.model!=='레이'||trim.data.trim!==binding.trimName||trim.data.seats!==5||Number(trim.data.engine_cc)!==998||trim.data.turbo!==false)throw new Error('ESTIMATE_RECOVERY_REVIEWED_PHYSICAL_IDENTITY_CHANGED');
    const rowKey=String(trim.data.trim_row_key||trim.id),masterId=master.id;
    if(!rowKey.startsWith(masterId+'::v01::t')||trim.data.master_id!==masterId)throw new Error('ESTIMATE_RECOVERY_PERMANENT_AXIS_REQUIRED');
    const facts=(packet.normalizedDocument.data.payload as {estimateFacts:OperationalManufacturerFacts}).estimateFacts;
    return {productId:product.id,masterId,trimId:trim.id,vehicleModelId:'mf-002.md-058',powertrainId:masterId+'::v01',modelYearId:masterId+'::model-year:2027',
      expectedMasterDigest:stableDigest(master.data),expectedTrimDigest:stableDigest(trim.data),expectedProductDigest:stableDigest(product.data),manufacturerFactsDigest:stableDigest(facts),
      sourceDocumentId:packet.sourceDocument.id,normalizedDocumentId:packet.normalizedDocument.id,normalizedFactsPath:packet.normalizedFactsPath};
  });
  const previous=current?await ports.projection.getManifest(current.releaseId):null;
  const plan=prepareOperationalEstimatePublication({snapshot,bindings,manufacturerPackets:packets,approval:{reviewId:'user-directed-ray-2027-recovery-v1',reviewedBy:'service:estimate-manufacturer-facts-verifier/v1',reviewedAt:now,expiresAt:new Date(Date.parse(now)+240000).toISOString(),bindingsDigest:stableDigest(bindings)},expectedActiveReleaseId:current?.releaseId??null,publicationRevision:(previous?.operationalEstimateProof?.publicationRevision??0)+1,now});
  const planId=await ports.savePlan(plan),summary={mode:input.mode,planId,planDigest:stableDigest(plan),releaseId:plan.releaseId,products:plan.records.map(row=>({id:row.productId,modelYear:row.modelYear,trim:row.trimName,basePrice:row.basePrice.amount,options:row.options.length,exteriorColors:row.exteriorColors.length,interiorColors:row.interiorColors.length})),manufacturerCombinations:432};
  if(input.mode==='restore')return {...summary,...await publishOperationalEstimateMaster(ports.projection,plan,ports.now)};
  return {...summary,status:'PREPARED_NOT_PUBLISHED'};
}
