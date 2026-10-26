import {describe,it,expect} from 'vitest';
import {MemoryDataStore} from '../src/infra/memory-store.js';
import {isSupplierContractStandard,projectSupplierContractStandard,type SupplierContractStandard} from '../src/domain/supplier-contract-standard.js';
import {registerSupplierContractStandards,contractStandardPolicyId} from '../src/application/register-supplier-contract-standards.js';
const source=(value:string)=>({value,origin:'SUPPLIER' as const});
const standard=():SupplierContractStandard=>({schema:'supplier-contract-standard/v1',version:'fixture-v1',adoptedOn:'2026-10-26',
  supplierName:'검증 공급사',supplierCodes:['RP999'],sourceCatalogSha256:'a'.repeat(64),profiles:[{id:'fixture-rental',label:'검증 공급사 · 렌트',
    kinds:['RENT'],customerTypes:[],sourceSha256:'b'.repeat(64),facts:{early_termination_rate_y1:source('35'),
      early_termination_rate_y2:source('35'),late_fee_rate:{value:'24',origin:'FREEPASS_STANDARD'}},cleared:['self_damage_deductible_rate'],
    dimensions:[{id:'age',label:'연령 구분',options:[{id:'26',label:'만 26세 이상',facts:{driver_age:source('만 26세 이상'),self_damage_deductible_min:source('50만원')},cleared:['self_damage_deductible_rate']},
      {id:'21',label:'만 21세 이상',facts:{driver_age:source('만 21세 이상'),self_damage_deductible_min:source('80만원')},cleared:['self_damage_deductible_rate']}]},
      {id:'vehicleClass',label:'차량 구분',options:[{id:'compact',label:'준중형 이하',facts:{over_mileage_rate:source('100')},cleared:[]},
        {id:'large',label:'준대형 이상',facts:{over_mileage_rate:source('300')},cleared:['self_damage_deductible_min']},
        {id:'imported',label:'수입',facts:{over_mileage_rate:source('300')},cleared:[]}]}]}]});
describe('held supplier contract standard facts',()=>{
  it('rejects private fields, source files, credentials and malformed dimensions',()=>{
    expect(isSupplierContractStandard(standard())).toBe(true);
    const privateField=standard();(privateField.profiles[0]!.facts as Record<string,unknown>).bank_account=source('private');expect(isSupplierContractStandard(privateField)).toBe(false);
    const url=standard();url.profiles[0]!.facts.early_termination_rate_y1=source('https://private.invalid/source');expect(isSupplierContractStandard(url)).toBe(false);
    const extra=standard();Object.assign(extra.profiles[0]!,{customerName:'private'});expect(isSupplierContractStandard(extra)).toBe(false);
    const negative=standard();negative.profiles[0]!.facts.late_fee_rate=source('-24');expect(isSupplierContractStandard(negative)).toBe(false);
    const duplicate=standard();duplicate.profiles[0]!.dimensions.push(structuredClone(duplicate.profiles[0]!.dimensions[0]!));expect(isSupplierContractStandard(duplicate)).toBe(false);
  });
  it('keeps approved FreePass supplementation distinct from supplier facts and preserves explicit blanks',()=>{
    const result=projectSupplierContractStandard(standard(),{supplierCode:'RP999',productType:'중고렌트',baseDriverAge:'만 26세 이상'})!;
    expect(result.values.early_termination_rate_under1y).toBe('35%');expect(result.values.early_termination_rate_over1y).toBe('35%');
    expect(result.values.late_fee_rate).toBe(0.24);expect(result.displayValues.late_fee_rate).toContain('프리패스 표준 보완');
    expect(result.values.own_damage_repair_ratio).toBeNull();expect(result.displayValues.own_damage_repair_ratio).toBeUndefined();
    expect(result.values.own_damage_min_deductible).toBeNull();expect(result.displayValues.own_damage_min_deductible).toContain('원본 미기재');
    expect(result.values.over_mileage_rate_imported).toBe(300);expect(result.values.over_mileage_rate_domestic).toBeNull();
  });
  it('preserves staged rates and never selects a vehicle class or another supplier',()=>{
    const value=standard();value.profiles[0]!.facts.late_fee_rate=source('송달 전 연 12%, 이후 연 20%');
    const result=projectSupplierContractStandard(value,{supplierCode:'RP999',productType:'렌트'})!;
    expect(result.values.late_fee_rate).toBe('송달 전 연 12%, 이후 연 20%');
    expect(result.values.over_mileage_rate_per_km).toBeNull();expect(result.notes.join('\n')).toContain('준대형 이상');
    expect(projectSupplierContractStandard(value,{supplierCode:'RP998'})).toBeNull();
    value.supplierCodes=[];expect(isSupplierContractStandard(value)).toBe(true);expect(projectSupplierContractStandard(value,{supplierCode:'RP999'})).toBeNull();
  });
  it('does not apply rental profiles to subscription products',()=>{
    const result=projectSupplierContractStandard(standard(),{supplierCode:'RP999',productType:'구독'})!;
    expect(result.values.early_termination_rate_under1y).toBeNull();expect(result.notes.join('')).toContain('상품 유형');
  });
});
describe('immutable CatalogStore policy registration',()=>{
  const input=()=>({commandId:'register-standard-fixture',idempotencyKey:'register-standard-fixture',actor:{id:'service:freepass-data',kind:'SERVICE' as const},
    reason:'reviewed synthetic fixture',effectiveFrom:'2026-10-26T12:00:00.000Z',standards:[standard()]});
  it('creates one immutable policy with an audit and receipt; replay performs no duplicate creation',async()=>{
    const store=new MemoryDataStore(),request=input();
    const receipt=await registerSupplierContractStandards(store,request,'2026-10-26T12:01:00.000Z');
    expect((await store.listPolicies()).map(p=>p.id)).toEqual([contractStandardPolicyId(request.standards[0]!)]);
    expect(await store.listProducts()).toEqual([]);expect(await store.listOffers()).toEqual([]);
    expect(await registerSupplierContractStandards(store,request)).toEqual(receipt);
    expect((await store.listPolicies()).length).toBe(1);
    const changed=input();changed.reason='different payload';await expect(registerSupplierContractStandards(store,changed)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('obeys the existing writer ownership and rejects a non-Data registration actor',async()=>{
    const store=new MemoryDataStore();
    await store.seed({catalogWriterOwnership:{scope:'catalog',revision:1,mode:'EXCLUSIVE',primaryWriterId:'service:other',allowedWriterIds:['service:other'],previousWriterIds:[],
      effectiveAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z',updatedBy:{id:'fixture',kind:'USER'},reason:'synthetic exclusive owner'}});
    await expect(registerSupplierContractStandards(store,input())).rejects.toThrow('denied');expect(await store.listPolicies()).toEqual([]);
    await expect(registerSupplierContractStandards(new MemoryDataStore(),{...input(),actor:{id:'service:freepass-admin',kind:'SERVICE'}})).rejects.toThrow('ACTOR_DENIED');
  });
  it('rolls back policy creation when the enclosing Catalog transaction fails',async()=>{
    const store=new MemoryDataStore();
    await expect(store.transact(async tx=>{await tx.putPolicy({id:'p',kind:'OTHER',version:'v',effectiveFrom:'2026-10-26',facts:{},schemaVersion:'policy/v1',revision:1,validationStatus:'VALID',
      createdAt:'2026-10-26T00:00:00Z',updatedAt:'2026-10-26T00:00:00Z',createdBy:{id:'fixture',kind:'SERVICE'},updatedBy:{id:'fixture',kind:'SERVICE'},lineageId:'fixture'});throw new Error('rollback');})).rejects.toThrow('rollback');
    expect(await store.listPolicies()).toEqual([]);
  });
});
