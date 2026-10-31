import { operationalManufacturerFacts, deriveOperationalEstimateRecord } from '../domain/estimate-operational-record.js';
import type { EstimateNewcarMasterRecord } from '../domain/estimate-master.js';
import { stableDigest } from './stable-digest.js';
import { OPERATIONAL_ESTIMATE_COLLECTIONS, type OperationalEstimateSourceDocument, type OperationalEstimateSourceWitness, type OperationalEstimateReleaseProof } from '../domain/estimate-operational-publication.js';

export function operationalDocumentData(value:unknown):unknown {
  if(value==null||['string','number','boolean'].includes(typeof value)) return value;
  if(value instanceof Date) return value.toISOString();
  if(Array.isArray(value)) return value.map(operationalDocumentData);
  if(typeof value==='object') {
    const timestamp=value as {seconds?:unknown;nanoseconds?:unknown;toDate?:unknown};
    if(typeof timestamp.toDate==='function'&&typeof timestamp.seconds==='number'&&typeof timestamp.nanoseconds==='number') return {seconds:timestamp.seconds,nanoseconds:timestamp.nanoseconds};
    return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,operationalDocumentData(child)]));
  }
  throw new Error('ESTIMATE_OPERATIONAL_SOURCE_VALUE_INVALID');
}
export function operationalSourceWitness(document:OperationalEstimateSourceDocument):OperationalEstimateSourceWitness {
  if(!OPERATIONAL_ESTIMATE_COLLECTIONS.includes(document.collection)||!document.id||document.id.includes('/')||!document.updateTime||!Number.isSafeInteger(document.updateTime.seconds)||!Number.isInteger(document.updateTime.nanoseconds)||document.updateTime.nanoseconds<0||document.updateTime.nanoseconds>=1e9) throw new Error('ESTIMATE_OPERATIONAL_SOURCE_VERSION_REQUIRED');
  return {collection:document.collection,documentId:document.id,updateTime:{...document.updateTime},dataDigest:stableDigest(operationalDocumentData(document.data))};
}
export const operationalSourceKey=(document:Pick<OperationalEstimateSourceWitness,'collection'|'documentId'>)=>`${document.collection}/${document.documentId}`;
export function orderedOperationalWitnesses(documents:OperationalEstimateSourceDocument[]):OperationalEstimateSourceWitness[] {
  const witnesses=new Map<string,OperationalEstimateSourceWitness>();
  for(const document of documents) {
    const witness=operationalSourceWitness(document),key=operationalSourceKey(witness),previous=witnesses.get(key);
    if(previous&&stableDigest(previous)!==stableDigest(witness)) throw new Error('ESTIMATE_OPERATIONAL_SOURCE_DUPLICATE_CONFLICT');
    witnesses.set(key,witness);
  }
  return [...witnesses.values()].sort((a,b)=>operationalSourceKey(a).localeCompare(operationalSourceKey(b),'en-US'));
}
export function validateOperationalProof(proof:OperationalEstimateReleaseProof,recordDigests:Map<string,string>,dataDigest:string):boolean {
  if(proof?.contract!=='estimate-operational-release-proof/v1'||proof.authority!=='FREEPASS_DATA_OPERATIONAL_VEHICLE_MASTER'||!Number.isSafeInteger(proof.publicationRevision)||proof.publicationRevision<1||proof.dataDigest!==dataDigest||!Array.isArray(proof.documents)||!proof.documents.length||!Array.isArray(proof.products)||!proof.products.length||proof.products.length!==recordDigests.size) return false;
  if((proof.expectedActiveReleaseId!==null&&typeof proof.expectedActiveReleaseId!=='string')||!proof.approval?.reviewId||!proof.approval.reviewedBy||!/^[a-f0-9]{64}$/.test(proof.approval.bindingsDigest)||![proof.sourceReadAt,proof.approval.reviewedAt,proof.approval.expiresAt].every(value=>Number.isFinite(Date.parse(value)))||Date.parse(proof.approval.expiresAt)<=Date.parse(proof.approval.reviewedAt)) return false;
  if(!Array.isArray(proof.reviewedBindings)||proof.reviewedBindings.length!==proof.products.length||stableDigest(proof.reviewedBindings)!==proof.approval.bindingsDigest) return false;
  const keys=new Set<string>(),witnesses=new Map<string,OperationalEstimateSourceWitness>();
  for(const witness of proof.documents) {
    if(!OPERATIONAL_ESTIMATE_COLLECTIONS.includes(witness.collection)||!witness.documentId||witness.documentId.includes('/')||!witness.updateTime||!Number.isSafeInteger(witness.updateTime.seconds)||!Number.isInteger(witness.updateTime.nanoseconds)||witness.updateTime.nanoseconds<0||witness.updateTime.nanoseconds>=1e9||!/^[a-f0-9]{64}$/.test(witness.dataDigest)) return false;
    const key=operationalSourceKey(witness);if(witnesses.has(key)) return false;witnesses.set(key,witness);
  }
  if(stableDigest(proof.documents)!==proof.sourceInputDigest) return false;
  for(const product of proof.products) {
    if(keys.has(product.productId)||recordDigests.get(product.productId)!==product.recordDigest||!/^[a-f0-9]{64}$/.test(product.manufacturerFactsDigest)||!product.normalizedFactsPath) return false;
    const bindings=proof.reviewedBindings.filter(binding=>binding.productId===product.productId);
    if(bindings.length!==1) return false;
    const binding=bindings[0]!;
    if(binding.masterId!==product.masterDocumentId||binding.trimId!==product.trimDocumentId||binding.sourceDocumentId!==product.sourceDocumentId||binding.normalizedDocumentId!==product.normalizedDocumentId||binding.normalizedFactsPath!==product.normalizedFactsPath||binding.manufacturerFactsDigest!==product.manufacturerFactsDigest) return false;
    if(witnesses.get(`vehicle_master/${product.masterDocumentId}`)?.dataDigest!==binding.expectedMasterDigest||witnesses.get(`vehicle_trim_master/${product.trimDocumentId}`)?.dataDigest!==binding.expectedTrimDigest||witnesses.get(`new_car_trim/${product.productId}`)?.dataDigest!==binding.expectedProductDigest) return false;
    keys.add(product.productId);
    if(!Array.isArray(product.additionalSourceDocumentIds)||new Set(product.additionalSourceDocumentIds).size!==product.additionalSourceDocumentIds.length||product.additionalSourceDocumentIds.some(id=>id===product.sourceDocumentId||!witnesses.has(`vehicle_master_source_documents/${id}`))) return false;
    for(const [collection,id] of [['vehicle_master',product.masterDocumentId],['vehicle_trim_master',product.trimDocumentId],['new_car_trim',product.productId],['vehicle_master_source_documents',product.sourceDocumentId],['vehicle_master_normalized_records',product.normalizedDocumentId]]) {
      if(!witnesses.has(`${collection}/${id}`)) return false;
    }
  }
  return true;
}
/** Called inside the existing activation transaction after reading current source documents. */
export function assertOperationalActivationSources(proof:OperationalEstimateReleaseProof,current:OperationalEstimateSourceDocument[],guard:{proofDigest:string;approvalReviewId:string}|undefined,now:string,records:EstimateNewcarMasterRecord[]) {
  if(!guard||guard.proofDigest!==stableDigest(proof)||guard.approvalReviewId!==proof.approval.reviewId) throw new Error('ESTIMATE_OPERATIONAL_PUBLICATION_APPROVAL_REQUIRED');
  const at=Date.parse(now);
  if(!Number.isFinite(at)||at<Date.parse(proof.approval.reviewedAt)-1000||at>Date.parse(proof.approval.expiresAt)||at-Date.parse(proof.sourceReadAt)< -1000||at-Date.parse(proof.sourceReadAt)>300000) throw new Error('ESTIMATE_OPERATIONAL_PUBLICATION_EXPIRED');
  const witnesses=orderedOperationalWitnesses(current);
  if(stableDigest(witnesses)!==proof.sourceInputDigest) throw new Error('ESTIMATE_OPERATIONAL_SOURCE_CHANGED');
  const source=new Map(current.map(document=>[`${document.collection}/${document.id}`,document]));
  const get=(collection:string,id:string)=>{const document=source.get(`${collection}/${id}`);if(!document)throw new Error('ESTIMATE_OPERATIONAL_SOURCE_CHANGED');return document;};
  for(const product of proof.products) {
    const binding=proof.reviewedBindings.find(row=>row.productId===product.productId);
    if(!binding)throw new Error('ESTIMATE_OPERATIONAL_REVIEW_BINDING_REQUIRED');
    const packet={sourceDocument:get('vehicle_master_source_documents',product.sourceDocumentId),normalizedDocument:get('vehicle_master_normalized_records',product.normalizedDocumentId),normalizedFactsPath:product.normalizedFactsPath,additionalSourceDocuments:product.additionalSourceDocumentIds.map(id=>get('vehicle_master_source_documents',id))};
    const facts=operationalManufacturerFacts(packet,binding);
    const expected=deriveOperationalEstimateRecord(get('vehicle_master',product.masterDocumentId),get('vehicle_trim_master',product.trimDocumentId),facts,binding,get('new_car_trim',product.productId));
    const record=records.find(row=>row.productId===product.productId);
    if(!record||stableDigest(expected)!==stableDigest(record)||stableDigest(expected)!==product.recordDigest)throw new Error('ESTIMATE_OPERATIONAL_PRODUCER_RECORD_MISMATCH');
  }
}
