import { operationalManufacturerFacts, deriveOperationalEstimateRecord } from '../domain/estimate-operational-record.js';
import { validateEstimateMasterSemantics, type EstimateNewcarMasterRecord } from '../domain/estimate-master.js';
import type { ProjectionRelease } from '../domain/catalog.js';
import type { ProjectionReleaseManifest } from '../domain/projection-evidence.js';
import type { ProjectionStore } from '../ports/catalog-store.js';
import type { OperationalEstimateSourceSnapshot, OperationalMasterDocument } from '../ports/estimate-operational-source.js';
import type { OperationalEstimateReviewedBinding, OperationalManufacturerFacts, OperationalManufacturerFactsPacket, OperationalEstimateSourceDocument, OperationalEstimatePublicationPlan, OperationalEstimateReleaseProof } from '../ports/estimate-operational-publication.js';
import { inspectOperationalEstimateSource } from './estimate-operational-master.js';
import { orderedOperationalWitnesses, validateOperationalProof } from '../shared/estimate-operational-proof.js';
import { assertProjectionReleaseIntegrity } from '../shared/projection-integrity.js';
import { stableDigest, stableRecordSetDigest } from '../shared/stable-digest.js';

const PROJECTION='estimate-newcar-master';
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const collectionDocument=(collection:OperationalEstimateSourceDocument['collection'],doc:OperationalMasterDocument):OperationalEstimateSourceDocument=>({...doc,collection});
function exactDocument(documents:OperationalMasterDocument[],id:string) {
  const matches=documents.filter(doc=>doc.id===id||text(doc.data.trim_row_key)===id);
  if(matches.length!==1)throw new Error('ESTIMATE_OPERATIONAL_EXACT_REFERENCE_REQUIRED');
  return matches[0]!;
}
export function prepareOperationalEstimatePublication(input:{
  snapshot:OperationalEstimateSourceSnapshot;
  bindings:OperationalEstimateReviewedBinding[];
  manufacturerPackets:OperationalManufacturerFactsPacket[];
  approval:{reviewId:string;reviewedBy:string;reviewedAt:string;expiresAt:string;bindingsDigest:string};
  expectedActiveReleaseId:string|null;
  publicationRevision:number;
  now:string;
}):OperationalEstimatePublicationPlan {
  const now=Date.parse(input.now);
  if(!Number.isFinite(now))throw new Error('ESTIMATE_PUBLICATION_TIME_INVALID');
  inspectOperationalEstimateSource(input.snapshot,now);
  if(!input.bindings.length)throw new Error('ESTIMATE_PUBLICATION_EMPTY');
  if(!input.manufacturerPackets.length)throw new Error('ESTIMATE_MANUFACTURER_FACTS_REQUIRED');
  if(!input.approval.reviewId||!input.approval.reviewedBy||stableDigest(input.bindings)!==input.approval.bindingsDigest||!Number.isFinite(Date.parse(input.approval.reviewedAt))||Date.parse(input.approval.reviewedAt)>now+1000||Date.parse(input.approval.expiresAt)<=now||Date.parse(input.approval.expiresAt)>Date.parse(input.snapshot.readAt)+300000)throw new Error('ESTIMATE_PUBLICATION_REVIEW_REQUIRED');
  if(!Number.isSafeInteger(input.publicationRevision)||input.publicationRevision<1)throw new Error('ESTIMATE_PUBLICATION_REVISION_REQUIRED');
  const records:EstimateNewcarMasterRecord[]=[],documents:OperationalEstimateSourceDocument[]=[],products:OperationalEstimateReleaseProof['products']=[],ids=new Set<string>();
  for(const binding of input.bindings) {
    if(ids.has(binding.productId))throw new Error('ESTIMATE_PUBLICATION_DUPLICATE_PRODUCT');ids.add(binding.productId);
    const master=exactDocument(input.snapshot.masters,binding.masterId),trim=exactDocument(input.snapshot.trims,binding.trimId),product=exactDocument(input.snapshot.newCarTrims,binding.productId);
    if(master.id!==binding.masterId||trim.data.master_id!==master.id||master.data.retired===true||trim.data.retired===true||['maker','model','sub_model'].some(key=>!text(master.data[key])||master.data[key]!==trim.data[key])||!text(trim.data.trim))throw new Error('ESTIMATE_OPERATIONAL_MASTER_IDENTITY_CONFLICT');
    if([['expectedMasterDigest',master],['expectedTrimDigest',trim],['expectedProductDigest',product]].some(([key,doc])=>binding[key as keyof OperationalEstimateReviewedBinding]!==stableDigest((doc as OperationalMasterDocument).data)))throw new Error('ESTIMATE_PUBLICATION_REVIEW_STALE');
    const packets=input.manufacturerPackets.filter(packet=>packet.sourceDocument.id===binding.sourceDocumentId&&packet.normalizedDocument.id===binding.normalizedDocumentId&&packet.normalizedFactsPath===binding.normalizedFactsPath);
    if(packets.length!==1)throw new Error('ESTIMATE_MANUFACTURER_FACTS_REQUIRED');
    const packet=packets[0]!,facts=operationalManufacturerFacts(packet,binding);
    const record=deriveOperationalEstimateRecord(master,trim,facts,binding,product);
    records.push(record);documents.push(collectionDocument('vehicle_master',master),collectionDocument('vehicle_trim_master',trim),collectionDocument('new_car_trim',product),packet.sourceDocument,packet.normalizedDocument,...(packet.additionalSourceDocuments??[]));
    products.push({productId:record.productId,masterDocumentId:master.id,trimDocumentId:trim.id,sourceDocumentId:packet.sourceDocument.id,normalizedDocumentId:packet.normalizedDocument.id,normalizedFactsPath:packet.normalizedFactsPath,manufacturerFactsDigest:binding.manufacturerFactsDigest,recordDigest:stableDigest(record),additionalSourceDocumentIds:(facts.additionalSourceDocuments??[]).map(ref=>ref.id)});
  }
  if(validateEstimateMasterSemantics(records).length)throw new Error('ESTIMATE_PUBLICATION_RECORDS_INVALID');
  const witnesses=orderedOperationalWitnesses(documents),dataDigest=stableDigest(records);
  const proof:OperationalEstimateReleaseProof={contract:'estimate-operational-release-proof/v1',authority:'FREEPASS_DATA_OPERATIONAL_VEHICLE_MASTER',publicationRevision:input.publicationRevision,expectedActiveReleaseId:input.expectedActiveReleaseId,approval:{...input.approval},sourceReadAt:input.snapshot.readAt,sourceInputDigest:stableDigest(witnesses),documents:witnesses,products,dataDigest,reviewedBindings:structuredClone(input.bindings)};
  if(!validateOperationalProof(proof,new Map(records.map(record=>[record.productId,stableDigest(record)])),dataDigest))throw new Error('ESTIMATE_PUBLICATION_PROOF_INVALID');
  const inputDigest=stableDigest(proof),releaseId=`rel_estimate-operational-${inputDigest.slice(0,32)}`;
  return {contract:'estimate-operational-publication-plan/v1',releaseId,manifestId:`manifest_${inputDigest.slice(0,32)}`,generatedAt:input.now,records,proof,inputDigest,dataDigest};
}

/** Existing ProjectionStore is the sole persistence/activation path. */
export async function publishOperationalEstimateMaster(store:ProjectionStore,plan:OperationalEstimatePublicationPlan,now:()=>string=()=>new Date().toISOString()) {
  if(!plan.records.length||!validateOperationalProof(plan.proof,new Map(plan.records.map(record=>[record.productId,stableDigest(record)])),stableDigest(plan.records))||stableDigest(plan.proof)!==plan.inputDigest||stableDigest(plan.records)!==plan.dataDigest)throw new Error('ESTIMATE_PUBLICATION_PLAN_INVALID');
  if(plan.releaseId!==`rel_estimate-operational-${plan.inputDigest.slice(0,32)}`||plan.manifestId!==`manifest_${plan.inputDigest.slice(0,32)}`)throw new Error('ESTIMATE_PUBLICATION_PLAN_IDENTITY_INVALID');
  const active=await store.getActive<EstimateNewcarMasterRecord>(PROJECTION);
  if(active?.releaseId===plan.releaseId&&active.inputDigest===plan.inputDigest&&active.dataDigest===plan.dataDigest&&active.status==='ACTIVE') {
    const manifest=await store.getManifest(active.releaseId);
    if(!manifest?.operationalEstimateProof||stableDigest(manifest.operationalEstimateProof)!==plan.inputDigest)throw new Error('ESTIMATE_PUBLICATION_REPLAY_EVIDENCE_INVALID');
    assertProjectionReleaseIntegrity(active,manifest,await store.listProjectionLineage(active.releaseId));
    return {status:'IDEMPOTENT_REPLAY' as const,releaseId:active.releaseId};
  }
  const previous=active?await store.getManifest(active.releaseId):null;
  if(active?.status==='ACTIVE'&&active.dataDigest===plan.dataDigest&&previous?.operationalEstimateProof?.sourceInputDigest===plan.proof.sourceInputDigest&&previous.operationalEstimateProof.approval.bindingsDigest===plan.proof.approval.bindingsDigest) {
    assertProjectionReleaseIntegrity(active,previous,await store.listProjectionLineage(active.releaseId));
    return {status:'IDEMPOTENT_REPLAY' as const,releaseId:active.releaseId};
  }
  if((active?.releaseId??null)!==plan.proof.expectedActiveReleaseId)throw new Error('PROJECTION_SOURCE_ACTIVE_CHANGED');
  const at=Date.parse(now());
  if(!Number.isFinite(at)||at<Date.parse(plan.proof.approval.reviewedAt)-1000||at>Date.parse(plan.proof.approval.expiresAt)||at-Date.parse(plan.proof.sourceReadAt)< -1000||at-Date.parse(plan.proof.sourceReadAt)>300000)throw new Error('ESTIMATE_OPERATIONAL_PUBLICATION_EXPIRED');
  const previousRevision=previous?.operationalEstimateProof?.publicationRevision??0;
  if(plan.proof.publicationRevision!==previousRevision+1)throw new Error('ESTIMATE_PUBLICATION_REVISION_CONFLICT');
  const release:ProjectionRelease<EstimateNewcarMasterRecord>={releaseId:plan.releaseId,projectionId:PROJECTION,schemaVersion:'1.0.0',canonicalRevision:0,manifestId:plan.manifestId,inputDigest:plan.inputDigest,dataDigest:plan.dataDigest,status:'BUILDING',generatedAt:plan.generatedAt,data:plan.records};
  const manifest:ProjectionReleaseManifest={manifestId:plan.manifestId,releaseId:plan.releaseId,projectionId:PROJECTION,schemaVersion:'1.0.0',generatedAt:plan.generatedAt,canonicalInputs:[],operationalEstimateProof:plan.proof,productCount:plan.records.length,offerCount:0,fieldEvidenceCount:0,fieldEvidenceDigest:stableRecordSetDigest([]),inputDigest:plan.inputDigest,dataDigest:plan.dataDigest};
  await store.stage(release);
  await store.stageEvidence({manifest,lineage:[]});
  await store.markReady(plan.releaseId);
  await store.activate(plan.releaseId,{now,expectedActiveReleaseId:plan.proof.expectedActiveReleaseId,sources:[],operationalEstimate:{proofDigest:plan.inputDigest,approvalReviewId:plan.proof.approval.reviewId}});
  const result=await store.getActive<EstimateNewcarMasterRecord>(PROJECTION);
  if(result?.releaseId!==plan.releaseId||result.status!=='ACTIVE'||result.dataDigest!==plan.dataDigest||stableDigest(result.data)!==plan.dataDigest)throw new Error('ESTIMATE_PUBLICATION_READBACK_FAILED');
  return {status:'ACTIVATED' as const,releaseId:plan.releaseId};
}
