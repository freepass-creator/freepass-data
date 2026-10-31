import { createConsumerGateway } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { describe, expect, it, vi } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { prepareOperationalEstimatePublication, publishOperationalEstimateMaster } from '../src/application/estimate-operational-publication.js';
import { stableDigest, stableRecordSetDigest } from '../src/shared/stable-digest.js';
import { verifyProjectionReleaseIntegrity } from '../src/shared/projection-integrity.js';
import type { OperationalEstimateSourceSnapshot } from '../src/ports/estimate-operational-source.js';
import type { OperationalEstimateReviewedBinding, OperationalManufacturerFacts, OperationalManufacturerFactsPacket, OperationalEstimateSourceDocument } from '../src/ports/estimate-operational-publication.js';

const now='2026-10-31T16:00:00.000Z',nowMs=Date.parse(now),version={seconds:Math.floor(nowMs/1000),nanoseconds:123};
function fixture() {
  const masters=[{id:'master-op',updateTime:{...version},data:{maker:'기아',model:'쏘렌토',sub_model:'더 뉴 쏘렌토 MQ4'}}];
  const trims=[{id:'trim-op',updateTime:{...version},data:{master_id:'master-op',maker:'기아',model:'쏘렌토',sub_model:'더 뉴 쏘렌토 MQ4',trim:'프레스티지',powertrain:'가솔린 2.5',fuel:'가솔린',engine_cc:2497,turbo:true,seats:5,drivetrain:'2WD',model_year_start:'2024',model_year_end:'현재'}}];
  const newCarTrims=[{id:'commercial-op',updateTime:{...version},data:{maker:'기아',trim:'프레스티지',trimKey:'provider-local-key',priceBefore:999,optionsMaster:{},availableOptions:[],extColors:[],intColors:[]}}];
  const snapshot:OperationalEstimateSourceSnapshot={contract:'estimate-operational-source-snapshot/v1',source:'freepasserp5/vehicle_master+vehicle_trim_master+new_car_trim',complete:true,readAt:now,inputDigest:stableDigest({masters,trims,newCarTrims}),masters,trims,newCarTrims};
  const facts:OperationalManufacturerFacts={contract:'estimate-manufacturer-facts/v1',sourceDocumentId:'source-official',sourceBytesSha256:'a'.repeat(64),maker:'기아',model:'쏘렌토',trimName:'프레스티지',modelYear:2027,basePrice:{amount:36410000,currency:'KRW'},priceBefore:{amount:36410000,currency:'KRW'},priceAfter:null,priceBasis:'제조사 공식 가격',
    options:[{optionId:'trim-op::roof',name:'선루프',price:{amount:450000,currency:'KRW'},requires:[],excludes:[]}],exteriorColors:[{colorId:'trim-op::exterior:black',name:'블랙',price:{amount:0,currency:'KRW'}}],interiorColors:[{colorId:'trim-op::interior:black',name:'블랙',price:{amount:0,currency:'KRW'}}],physical:{fuel:'가솔린',engineCc:2497,turbo:true,drivetrain:'2WD',seats:5,bodyConfiguration:null}};
  const packet:OperationalManufacturerFactsPacket={sourceDocument:{collection:'vehicle_master_source_documents',id:'source-official',updateTime:{...version},data:{sourceType:'MANUFACTURER_OFFICIAL',sourceUrl:'https://www.kia.com/kr/vehicles/sorento/price',observedAt:now,sha256:'a'.repeat(64)}},normalizedDocument:{collection:'vehicle_master_normalized_records',id:'normalized-official',updateTime:{...version},data:{sourceDocumentId:'source-official',payload:{estimateFacts:facts}}},normalizedFactsPath:'payload.estimateFacts'};
  const binding:OperationalEstimateReviewedBinding={productId:'commercial-op',masterId:'master-op',trimId:'trim-op',vehicleModelId:'reviewed-model-op',modelYearId:'reviewed-model-year-2027',powertrainId:'reviewed-powertrain-op',expectedMasterDigest:stableDigest(masters[0]!.data),expectedTrimDigest:stableDigest(trims[0]!.data),expectedProductDigest:stableDigest(newCarTrims[0]!.data),manufacturerFactsDigest:stableDigest(facts),sourceDocumentId:'source-official',normalizedDocumentId:'normalized-official',normalizedFactsPath:'payload.estimateFacts'};
  const input={snapshot,bindings:[binding],manufacturerPackets:[packet],approval:{reviewId:'review-explicit-001',reviewedBy:'operator:test-fixture',reviewedAt:now,expiresAt:new Date(nowMs+120000).toISOString(),bindingsDigest:stableDigest([binding])},expectedActiveReleaseId:null as string|null,publicationRevision:1,now};
  const current:OperationalEstimateSourceDocument[]=[...masters.map(doc=>({...doc,collection:'vehicle_master' as const})),...trims.map(doc=>({...doc,collection:'vehicle_trim_master' as const})),...newCarTrims.map(doc=>({...doc,collection:'new_car_trim' as const})),packet.sourceDocument,packet.normalizedDocument];
  const store=new MemoryDataStore({readOperationalEstimateDocuments:async()=>structuredClone(current)});
  return {facts,packet,binding,input,current,store};
}
function seal(f:ReturnType<typeof fixture>) {
  f.input.snapshot.inputDigest=stableDigest({masters:f.input.snapshot.masters,trims:f.input.snapshot.trims,newCarTrims:f.input.snapshot.newCarTrims});
  f.binding.expectedMasterDigest=stableDigest(f.input.snapshot.masters[0]!.data);f.binding.expectedTrimDigest=stableDigest(f.input.snapshot.trims[0]!.data);f.binding.expectedProductDigest=stableDigest(f.input.snapshot.newCarTrims[0]!.data);
  f.binding.manufacturerFactsDigest=stableDigest(f.facts);f.input.approval.bindingsDigest=stableDigest(f.input.bindings);
}
describe('current-authority Estimate publication',()=>{
  it('rejects absent producer facts, missing review, empty records and forged producer hashes before writing',()=>{
    const f=fixture(),stage=vi.spyOn(f.store,'stage');
    expect(()=>prepareOperationalEstimatePublication({...f.input,manufacturerPackets:[]})).toThrow('MANUFACTURER_FACTS_REQUIRED');
    expect(()=>prepareOperationalEstimatePublication({...f.input,bindings:[]})).toThrow('PUBLICATION_EMPTY');
    expect(()=>prepareOperationalEstimatePublication({...f.input,approval:{...f.input.approval,bindingsDigest:'b'.repeat(64)}})).toThrow('REVIEW_REQUIRED');
    f.facts.basePrice.amount=1;
    expect(()=>prepareOperationalEstimatePublication(f.input)).toThrow('MANUFACTURER_FACTS_REQUIRED');
    expect(stage).not.toHaveBeenCalled();
  });
  it('uses current immutable documents and official producer prices without creating graph revisions',async()=>{
    const f=fixture(),plan=prepareOperationalEstimatePublication(f.input);
    expect(plan.records[0]?.basePrice.amount).toBe(36410000);expect(plan.records[0]?.trimId).toBe('trim-op');
    expect(plan.proof.documents[0]?.updateTime).toEqual(version);
    expect(plan.proof.publicationRevision).toBe(1);
    await expect(publishOperationalEstimateMaster(f.store,plan,()=>now)).resolves.toMatchObject({status:'ACTIVATED'});
    const active=await f.store.getActive('estimate-newcar-master'),manifest=await f.store.getManifest(plan.releaseId);
    expect(active?.canonicalRevision).toBe(0);expect(active?.status).toBe('ACTIVE');
    expect(manifest?.canonicalInputs).toEqual([]);expect(manifest?.operationalEstimateProof?.publicationRevision).toBe(1);
    expect(verifyProjectionReleaseIntegrity(active!,manifest!,[]).valid).toBe(true);
  });
  it('serves a real ACTIVE proof with positive publication revision while preserving zero graph revisions',async()=>{
    const f=fixture(),plan=prepareOperationalEstimatePublication(f.input);await publishOperationalEstimateMaster(f.store,plan,()=>now);
    process.env.FREEPASS_SHEET_F04_ID ||= 'test-sheet-f04';
    const token='test-estimate-operational-service-token-0123456789';
    const app=createConsumerGateway(f.store,[{id:'freepass-estimate',projectionId:'estimate-newcar-master',token}],new DataAccessGateway(new MemoryDataAccessLogStore()));
    try {
      const response=await app.inject({url:'/v1/consumers/freepass-estimate/estimate-newcar-master',headers:{authorization:`Bearer ${token}`}});
      expect(response.statusCode).toBe(200);expect(response.json().meta).toMatchObject({authority:'CANONICAL_ACTIVE',inputAuthority:'FREEPASS_DATA_OPERATIONAL_VEHICLE_MASTER',evidenceContract:'estimate-operational-release-proof/v1',revision:1,inputDigest:plan.inputDigest});
      expect(response.json().data[0].basePrice.amount).toBe(36410000);
    } finally { await app.close(); }
  });
  it('replays the same successful input without another stage, and checks the active-pointer CAS',async()=>{
    const f=fixture(),plan=prepareOperationalEstimatePublication(f.input),stage=vi.spyOn(f.store,'stage');
    await publishOperationalEstimateMaster(f.store,plan,()=>now);
    await expect(publishOperationalEstimateMaster(f.store,plan,()=>now)).resolves.toMatchObject({status:'IDEMPOTENT_REPLAY'});expect(stage).toHaveBeenCalledTimes(1);
    const stale=fixture();stale.input.approval.reviewId='another-review';stale.input.snapshot.newCarTrims[0]!.data.priceBefore=1001;seal(stale);const stalePlan=prepareOperationalEstimatePublication(stale.input);
    await expect(publishOperationalEstimateMaster(f.store,stalePlan,()=>now)).rejects.toThrow('SOURCE_ACTIVE_CHANGED');
  });
  it('allows an explicitly reviewed successor with a separate sequential publication revision',async()=>{
    const f=fixture(),first=prepareOperationalEstimatePublication(f.input);await publishOperationalEstimateMaster(f.store,first,()=>now);
    f.input.expectedActiveReleaseId=first.releaseId;f.input.publicationRevision=2;f.input.approval.reviewId='review-explicit-002';
    f.input.snapshot.newCarTrims[0]!.data.priceBefore=1000;seal(f);
    const second=prepareOperationalEstimatePublication(f.input);await expect(publishOperationalEstimateMaster(f.store,second,()=>now)).resolves.toMatchObject({status:'ACTIVATED'});
    expect((await f.store.getManifest(second.releaseId))?.operationalEstimateProof?.publicationRevision).toBe(2);
  });
  it('treats repeated fresh reads of identical source versions as idempotent',async()=>{
    const f=fixture(),first=prepareOperationalEstimatePublication(f.input);await publishOperationalEstimateMaster(f.store,first,()=>now);
    f.input.expectedActiveReleaseId=first.releaseId;f.input.publicationRevision=2;f.input.snapshot.readAt=new Date(nowMs+1000).toISOString();f.input.now=f.input.snapshot.readAt;
    const repeated=prepareOperationalEstimatePublication(f.input),stage=vi.spyOn(f.store,'stage');
    await expect(publishOperationalEstimateMaster(f.store,repeated,()=>f.input.now)).resolves.toEqual({status:'IDEMPOTENT_REPLAY',releaseId:first.releaseId});
    expect(stage).not.toHaveBeenCalled();
  });
  it('requires every additional official source and its field mapping, and CAS protects those documents',async()=>{
    const f=fixture();
    const api:OperationalEstimateSourceDocument={collection:'vehicle_master_source_documents',id:'source-official-colors',updateTime:{...version},data:{sourceType:'MANUFACTURER_OFFICIAL',sourceUrl:'https://www.kia.com/kr/api/trims',observedAt:now,sha256:'c'.repeat(64)}};
    f.facts.additionalSourceDocuments=[{id:api.id,sha256:'c'.repeat(64)}];
    f.facts.fieldSources={basePrice:'source-official',modelYear:'source-official',options:'source-official',exteriorColors:api.id,interiorColors:api.id};
    seal(f);
    expect(()=>prepareOperationalEstimatePublication(f.input)).toThrow('ADDITIONAL_SOURCE_REQUIRED');
    f.packet.additionalSourceDocuments=[api];f.current.push(api);
    const plan=prepareOperationalEstimatePublication(f.input);
    expect(plan.proof.products[0]?.additionalSourceDocumentIds).toEqual([api.id]);
    api.updateTime={...version,nanoseconds:999};
    await expect(publishOperationalEstimateMaster(f.store,plan,()=>now)).rejects.toThrow('OPERATIONAL_SOURCE_CHANGED');
    expect(await f.store.getActive('estimate-newcar-master')).toBeNull();
  });
  it('rejects current source version/content drift transactionally and leaves the active pointer unchanged',async()=>{
    const f=fixture(),plan=prepareOperationalEstimatePublication(f.input);
    f.current[0]!.updateTime={...version,nanoseconds:124};
    await expect(publishOperationalEstimateMaster(f.store,plan,()=>now)).rejects.toThrow('OPERATIONAL_SOURCE_CHANGED');
    expect(await f.store.getActive('estimate-newcar-master')).toBeNull();
    const changed=fixture(),changedPlan=prepareOperationalEstimatePublication(changed.input);changed.current[1]!.data.seats=7;
    await expect(publishOperationalEstimateMaster(changed.store,changedPlan,()=>now)).rejects.toThrow('OPERATIONAL_SOURCE_CHANGED');
  });
  it('keeps the last known good release when a successor source changes after review',async()=>{
    const f=fixture(),first=prepareOperationalEstimatePublication(f.input);await publishOperationalEstimateMaster(f.store,first,()=>now);
    f.input.snapshot.newCarTrims[0]!.data.priceBefore=1000;seal(f);f.input.expectedActiveReleaseId=first.releaseId;f.input.publicationRevision=2;
    const second=prepareOperationalEstimatePublication(f.input);f.current[2]!.updateTime={...version,nanoseconds:999};
    await expect(publishOperationalEstimateMaster(f.store,second,()=>now)).rejects.toThrow('OPERATIONAL_SOURCE_CHANGED');
    expect((await f.store.getActive('estimate-newcar-master'))?.releaseId).toBe(first.releaseId);
  });
  it('rechecks the memory pointer after an awaited source read to close the publication race',async()=>{
    const f=fixture(),first=prepareOperationalEstimatePublication(f.input);
    f.input.approval.reviewId='competing-approved-operation';const competing=prepareOperationalEstimatePublication(f.input);
    let intercept=true;
    const store=new MemoryDataStore({readOperationalEstimateDocuments:async()=>{
      if(intercept){intercept=false;await publishOperationalEstimateMaster(store,competing,()=>now);}
      return structuredClone(f.current);
    }});
    await expect(publishOperationalEstimateMaster(store,first,()=>now)).rejects.toThrow('SOURCE_ACTIVE_CHANGED');
    expect((await store.getActive('estimate-newcar-master'))?.releaseId).toBe(competing.releaseId);
  });
  it('refuses missing source CAS readers, absent approval, expired approvals and physical conflicts',async()=>{
    const f=fixture(),plan=prepareOperationalEstimatePublication(f.input);
    await expect(publishOperationalEstimateMaster(new MemoryDataStore(),plan,()=>now)).rejects.toThrow('SOURCE_READER_REQUIRED');
    f.input.snapshot.trims[0]!.data.turbo=false;seal(f);
    expect(()=>prepareOperationalEstimatePublication(f.input)).toThrow('PHYSICAL_CONFLICT:turbo');
    const expired=fixture(),expiredPlan=prepareOperationalEstimatePublication(expired.input);
    await expect(publishOperationalEstimateMaster(expired.store,expiredPlan,()=>new Date(nowMs+120001).toISOString())).rejects.toThrow('PUBLICATION_EXPIRED');
  });
  it('rejects injected prices against persisted official producer facts even if plan hashes are recomputed',async()=>{
    const f=fixture(),plan=prepareOperationalEstimatePublication(f.input);
    plan.records[0]!.basePrice.amount=1;plan.dataDigest=stableDigest(plan.records);plan.proof.dataDigest=plan.dataDigest;plan.proof.products[0]!.recordDigest=stableDigest(plan.records[0]);
    plan.inputDigest=stableDigest(plan.proof);plan.releaseId=`rel_estimate-operational-${plan.inputDigest.slice(0,32)}`;plan.manifestId=`manifest_${plan.inputDigest.slice(0,32)}`;
    await expect(publishOperationalEstimateMaster(f.store,plan,()=>now)).rejects.toThrow('PRODUCER_RECORD_MISMATCH');
    expect(await f.store.getActive('estimate-newcar-master')).toBeNull();
  });
  it('detects incomplete operational proofs even when data or input digests are recomputed',async()=>{
    const f=fixture(),plan=prepareOperationalEstimatePublication(f.input);await publishOperationalEstimateMaster(f.store,plan,()=>now);
    const active=(await f.store.getActive('estimate-newcar-master'))!,manifest=(await f.store.getManifest(plan.releaseId))!;
    manifest.operationalEstimateProof!.documents.pop();manifest.operationalEstimateProof!.sourceInputDigest=stableDigest(manifest.operationalEstimateProof!.documents);
    manifest.inputDigest=stableDigest(manifest.operationalEstimateProof);active.inputDigest=manifest.inputDigest;
    expect(verifyProjectionReleaseIntegrity(active,manifest,[]).failures).toContain('OPERATIONAL_ESTIMATE_PROOF_INVALID');
    expect(manifest.fieldEvidenceDigest).toBe(stableRecordSetDigest([]));
  });
});

import { FirestoreDataStore } from '../src/infra/firestore-store.js';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE_COLLECTIONS } from '../src/infra/firestore-layout.js';
describe('Firestore operational activation transaction',()=>{
  async function staged() {
    const f=fixture(),plan=prepareOperationalEstimatePublication(f.input);
    await publishOperationalEstimateMaster(f.store,plan,()=>now);
    const release=(await f.store.getActive('estimate-newcar-master'))!,manifest=(await f.store.getManifest(plan.releaseId))!;
    const C=FIRESTORE_COLLECTIONS.projection;
    const data=new Map<string,Record<string,unknown>>([
      [`${C.releases}/${plan.releaseId}`,{...release,status:'READY'}],
      [`${C.manifests}/${plan.releaseId}`,manifest as unknown as Record<string,unknown>],
    ]);
    const versions=new Map<string,{seconds:number;nanoseconds:number}>();
    for(const document of f.current){data.set(`${document.collection}/${document.id}`,structuredClone(document.data));versions.set(`${document.collection}/${document.id}`,{...document.updateTime!});}
    const snapshot=(reference:{path:string})=>{
      const body=data.get(reference.path);
      return {id:reference.path.split('/').at(-1),exists:!!body,data:()=>structuredClone(body),get:(key:string)=>body?.[key],updateTime:versions.get(reference.path)};
    };
    let writes=0;
    const db={collection:(name:string)=>({doc:(id:string)=>({path:`${name}/${id}`}),where:()=>({query:true})}),runTransaction:async(callback:(transaction:unknown)=>unknown)=>{
      const pending:Array<()=>void>=[];
      const result=await callback({get:async(ref:{path:string;query?:boolean})=>ref.query?{docs:[]}:snapshot(ref),getAll:async(...refs:Array<{path:string}>)=>refs.map(snapshot),
        update:(ref:{path:string},patch:Record<string,unknown>)=>pending.push(()=>{data.set(ref.path,{...data.get(ref.path),...patch});writes++;}),
        set:(ref:{path:string},body:Record<string,unknown>)=>pending.push(()=>{data.set(ref.path,body);writes++;}),
        create:()=>{throw new Error('unexpected receipt create');}});
      for(const commit of pending)commit();return result;
    }} as unknown as Firestore;
    return {f,plan,data,versions,store:new FirestoreDataStore(db),writes:()=>writes};
  }
  it('checks persisted nanosecond versions inside the transaction before setting ACTIVE',async()=>{
    const t=await staged();
    await t.store.activate(t.plan.releaseId,{now:()=>now,sources:[],expectedActiveReleaseId:null,operationalEstimate:{proofDigest:t.plan.inputDigest,approvalReviewId:t.plan.proof.approval.reviewId}});
    expect(t.data.get(`${FIRESTORE_COLLECTIONS.projection.active}/estimate-newcar-master`)?.releaseId).toBe(t.plan.releaseId);
    expect(t.writes()).toBe(2);
  });
  it('does no writes when a source changes after planning',async()=>{
    const t=await staged(),witness=t.plan.proof.documents[0]!;
    t.versions.set(`${witness.collection}/${witness.documentId}`,{...witness.updateTime,nanoseconds:999});
    await expect(t.store.activate(t.plan.releaseId,{now:()=>now,sources:[],expectedActiveReleaseId:null,operationalEstimate:{proofDigest:t.plan.inputDigest,approvalReviewId:t.plan.proof.approval.reviewId}})).rejects.toThrow('OPERATIONAL_SOURCE_CHANGED');
    expect(t.writes()).toBe(0);expect(t.data.has(`${FIRESTORE_COLLECTIONS.projection.active}/estimate-newcar-master`)).toBe(false);
  });
});
