import { describe, expect, it } from 'vitest';
import { inspectOperationalEstimateSource } from '../src/application/estimate-operational-master.js';
import { stableDigest } from '../src/shared/stable-digest.js';
import type { OperationalEstimateSourceSnapshot } from '../src/ports/estimate-operational-source.js';
const now=Date.parse('2026-10-31T15:00:00Z');
function source(overrides:Record<string,unknown> = {}) {
  const version={seconds:Math.floor(now/1000),nanoseconds:1};
  const data={
    masters:[{id:'immutable-master',data:{maker:'기아',model:'쏘렌토',sub_model:'더 뉴 쏘렌토 MQ4'},updateTime:version}],
    trims:[{id:'immutable-trim',data:{master_id:'immutable-master',trim_row_key:'permanent::v01::t01',maker:'기아',model:'쏘렌토',sub_model:'더 뉴 쏘렌토 MQ4',trim:'프레스티지',model_year_start:'2024',model_year_end:'현재'},updateTime:version}],
    newCarTrims:[{id:'private-commercial-id',data:{maker:'기아',sub_model:'더 뉴 쏘렌토 MQ4',trim:'프레스티지',modelYear:2027,trimKey:'immutable-trim',priceBefore:36410000,
      optionsMaster:{roof:{name:'선루프',price:450000}},availableOptions:['roof'],optionExcludes:{},exclusiveGroups:[],extColors:[{code:'B',name:'블랙',price:0}],intColors:[{code:'BK',name:'블랙',price:0}],...overrides},updateTime:version}],
  };
  return {contract:'estimate-operational-source-snapshot/v1',source:'freepasserp5/vehicle_master+vehicle_trim_master+new_car_trim',complete:true,readAt:new Date(now).toISOString(),inputDigest:stableDigest(data),...data} as OperationalEstimateSourceSnapshot;
}
function reseal(snapshot:OperationalEstimateSourceSnapshot) {
  snapshot.inputDigest=stableDigest({masters:snapshot.masters,trims:snapshot.trims,newCarTrims:snapshot.newCarTrims});
  return snapshot;
}
describe('current operational Estimate source readiness',()=>{
  it('reads reviewed immutable references without manufacturing ACTIVE release metadata',()=>{
    const result=inspectOperationalEstimateSource(source(),now);
    expect(result.rows[0]).toMatchObject({masterId:'immutable-master',trimId:'immutable-trim',explicitModelYear:2027,status:'READY_FOR_REVIEW'});
    expect(result.summary.counts).toMatchObject({masters:1,trims:1,products:1,explicitModelYearProducts:1,exactTrimReferences:1,readyForReview:1,hold:0});
    expect(result.summary.publicationState).toBe('NOT_PUBLISHED');
    expect(JSON.stringify(result.summary)).not.toMatch(/36410000|450000|private-commercial-id|쏘렌토|CANONICAL_ACTIVE/);
  });
  it('never treats a supplier-local trim key or matching display name as a stable master bridge',()=>{
    const result=inspectOperationalEstimateSource(source({trimKey:'signature'}),now);
    expect(result.summary.counts.exactTrimReferences).toBe(0);
    expect(result.rows[0]?.holdReasons).toContain('EXACT_TRIM_REFERENCE_REQUIRED');
    expect(result.rows[0]?.status).toBe('HOLD');
  });
  it('accepts a unique actual trim_row_key, while preserving conflicts and duplicate references as HOLD',()=>{
    expect(inspectOperationalEstimateSource(source({trimKey:'permanent::v01::t01'}),now).summary.counts.exactTrimReferences).toBe(1);
    const contradictory=source({trimKey:'immutable-trim',trim_master_id:'different-trim'});
    expect(inspectOperationalEstimateSource(contradictory,now).rows[0]?.holdReasons).toContain('TRIM_REFERENCE_CONFLICT');
    const duplicate=source({trimKey:'permanent::v01::t01'});
    duplicate.trims.push({...duplicate.trims[0]!,id:'another-trim'});reseal(duplicate);
    expect(inspectOperationalEstimateSource(duplicate,now).rows[0]?.holdReasons).toContain('TRIM_REFERENCE_AMBIGUOUS');
  });
  it('does not infer model year from the current year, master range, generic year, price date or trim name',()=>{
    const snapshot=source({year:2027,crawledAt:'2026-10-31'});
    delete snapshot.newCarTrims[0]!.data.modelYear;reseal(snapshot);
    const result=inspectOperationalEstimateSource(snapshot,now);
    expect(result.summary.counts.explicitModelYearProducts).toBe(0);
    expect(result.rows[0]?.holdReasons).toContain('MODEL_YEAR_UNVERIFIED');
    expect(inspectOperationalEstimateSource(source({model_year:2026}),now).rows[0]?.holdReasons).toContain('MODEL_YEAR_CONFLICT');
  });
  it('rejects identity drift, absent prices, incomplete option dependencies and unknown color price',()=>{
    const result=inspectOperationalEstimateSource(source({maker:'현대',priceBefore:0,optionsMaster:{roof:{name:'선루프',price:450000,requires:['missing']}},extColors:[{code:'B',name:'블랙'}]}),now);
    expect(result.rows[0]?.holdReasons).toEqual(expect.arrayContaining(['PRODUCT_IDENTITY_DRIFT','BASE_PRICE_UNVERIFIED','OPTIONS_UNVERIFIED','COLORS_UNVERIFIED']));
    expect(result.rows[0]?.status).toBe('HOLD');
  });
  it('requires explicit complete exclusion metadata rather than assuming packages are compatible',()=>{
    expect(inspectOperationalEstimateSource(source({optionExcludes:undefined}),now).rows[0]?.holdReasons).toContain('OPTIONS_UNVERIFIED');
    expect(inspectOperationalEstimateSource(source({exclusiveGroups:[{id:'roof',members:['roof','missing']}]}),now).rows[0]?.holdReasons).toContain('OPTIONS_UNVERIFIED');
  });
  it('protects snapshot completeness, freshness and byte-level input identity',()=>{
    const altered=source();altered.newCarTrims[0]!.data.priceBefore=1;
    expect(()=>inspectOperationalEstimateSource(altered,now)).toThrow('DIGEST_MISMATCH');
    expect(()=>inspectOperationalEstimateSource(source(),now+300001)).toThrow('STALE');
    const duplicate=source();duplicate.newCarTrims.push(duplicate.newCarTrims[0]!);reseal(duplicate);
    expect(()=>inspectOperationalEstimateSource(duplicate,now)).toThrow('SOURCE_INVALID:newCarTrims');
  });
});

// Verify the actual reader asks the bound Firestore adapter for one read-only snapshot.
import { readOperationalEstimateSourceSnapshot } from '../src/infra/estimate-operational-master-reader.js';
import type { Firestore } from 'firebase-admin/firestore';
describe('operational source atomic reader',()=>{
  function fakeDatabase(drift=false) {
    const reads:string[]=[],options:unknown[]=[];
    const clock={toDate:()=>new Date(now),isEqual:(other:unknown)=>other===clock};
    const db={collection:(name:string)=>name,runTransaction:async(callback:(transaction:unknown)=>unknown,opts:unknown)=>{
      options.push(opts);
      return callback({get:async(name:string)=>{
        reads.push(name);
        return {readTime:drift&&name==='new_car_trim'?{}:clock,docs:[{id:name,data:()=>({name}),updateTime:{seconds:10,nanoseconds:100}}]};
      }});
    }} as unknown as Firestore;
    return {db,reads,options};
  }
  it('reads current identity and new-car rows atomically without a graph query or write',async()=>{
    const fake=fakeDatabase(),snapshot=await readOperationalEstimateSourceSnapshot(fake.db);
    expect(fake.reads).toEqual(['vehicle_master','vehicle_trim_master','new_car_trim']);
    expect(fake.options).toEqual([{readOnly:true}]);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.inputDigest).toBe(stableDigest({masters:snapshot.masters,trims:snapshot.trims,newCarTrims:snapshot.newCarTrims}));
    expect(snapshot.masters[0]?.updateTime).toEqual({seconds:10,nanoseconds:100});
  });
  it('rejects mixed read timestamps rather than calling them complete',async()=>{
    await expect(readOperationalEstimateSourceSnapshot(fakeDatabase(true).db)).rejects.toThrow('NON_ATOMIC_READ');
  });
});
