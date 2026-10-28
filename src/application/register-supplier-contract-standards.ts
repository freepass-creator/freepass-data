import {createHash} from 'node:crypto';
import type {ActorRef,CommandReceipt,Policy} from '../domain/catalog.js';
import {assertSupplierContractStandard,type SupplierContractStandard} from '../domain/supplier-contract-standard.js';
import {assertCatalogWriterOwnership,resolveExecutionWriter,type ExecutionWriterRef} from '../domain/writer-ownership.js';
import type {CatalogStore} from '../ports/catalog-store.js';
import {stableDigest} from '../shared/stable-digest.js';

export type RegisterContractStandardsInput={commandId:string;idempotencyKey:string;actor:ActorRef;writer?:ExecutionWriterRef;
  reason:string;effectiveFrom:string;standards:SupplierContractStandard[]};
export const contractStandardPolicyId=(standard:SupplierContractStandard)=>'std_'+createHash('sha256')
  .update([standard.profiles[0]!.id,standard.version,stableDigest(standard)].join('|')).digest('hex').slice(0,40);
/** Immutable source-standard editions. Existing products/offers, pricing and ACTIVE projections are untouched. */
export async function registerSupplierContractStandards(store:CatalogStore,input:RegisterContractStandardsInput,
  now=new Date().toISOString()):Promise<CommandReceipt>{
  if(!input.commandId?.trim()||!input.idempotencyKey?.trim()||!input.reason?.trim()
    ||!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(input.effectiveFrom)||!Number.isFinite(Date.parse(input.effectiveFrom))
    ||!Array.isArray(input.standards)||!input.standards.length||input.standards.length>100)throw new Error('INVALID_STANDARD_REGISTRATION');
  if(input.actor?.kind!=='SERVICE'||input.actor.id!=='service:freepass-data')throw new Error('STANDARD_REGISTRATION_ACTOR_DENIED');
  input.standards.forEach(value=>{assertSupplierContractStandard(value);if(value.profiles.length!==1)throw new Error('ONE_PROFILE_PER_IMMUTABLE_POLICY');});
  const ids=input.standards.map(contractStandardPolicyId);
  if(new Set(ids).size!==ids.length)throw new Error('DUPLICATE_STANDARD_REGISTRATION');
  const writer=resolveExecutionWriter(input.actor,input.writer);
  const requestDigest=stableDigest({...input,writer});
  return store.transact(async tx=>{
    assertCatalogWriterOwnership(await tx.getCatalogWriterOwnership(),writer);
    const receipt=await tx.getCommandReceipt(input.idempotencyKey);
    if(receipt){if(receipt.requestDigest!==requestDigest)throw new Error('STANDARD_REGISTRATION_IDEMPOTENCY_CONFLICT');return receipt;}
    // All reads precede every write; existing editions are never overwritten.
    const existing=await Promise.all(ids.map(id=>tx.getPolicy(id)));
    if(existing.some(Boolean))throw new Error('STANDARD_EDITION_ALREADY_EXISTS_WITHOUT_RECEIPT');
    const policies:Policy[]=input.standards.map((standard,index)=>({id:ids[index]!,kind:'OTHER',version:standard.version,
      effectiveFrom:input.effectiveFrom,schemaVersion:'policy/v1',revision:1,validationStatus:'VALID',createdAt:now,updatedAt:now,
      createdBy:input.actor,updatedBy:input.actor,lineageId:'supplier-contract:'+standard.sourceCatalogSha256,
      sourceRevision:standard.version,facts:{standardContract:structuredClone(standard),
        supplierBindingState:standard.supplierCodes.length?'BOUND':'UNLINKED_SUPPLIER'}}));
    for(const policy of policies){
      await tx.putPolicy(policy);
      await tx.appendAudit({eventId:'std_audit_'+createHash('sha256').update(input.commandId+'|'+policy.id).digest('hex').slice(0,32),
        commandId:input.commandId,actor:input.actor,entityType:'Policy',entityId:policy.id,action:'SUPPLIER_CONTRACT_STANDARD_REGISTERED',
        before:null,after:policy,reason:input.reason,writerId:writer.id,revisionBefore:0,revisionAfter:1,occurredAt:now});
    }
    const result:CommandReceipt={idempotencyKey:input.idempotencyKey,commandId:input.commandId,status:'CANONICAL_COMMITTED',
      entityType:'PolicyBatch',entityId:'std_batch_'+requestDigest.slice(0,24),revision:1,committedAt:now,requestDigest,writerId:writer.id};
    await tx.putCommandReceipt(result);return result;
  });
}
