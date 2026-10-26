/** Versioned, public-business-only facts from the representative-approved held contract catalog.
 * Field translation implements the existing commercial dictionary; it does not choose a customer's contract.
 * Original files, account/customer data and private provenance never enter this contract.
 */
export const STANDARD_CONTRACT_SCHEMA = 'supplier-contract-standard/v1' as const;
type Definition = readonly [target: string, label: string, unit?: 'percent' | 'annualPercent' | 'days' | 'count' | 'perKm'];
export const STANDARD_CONTRACT_FIELDS: Record<string, Definition> = {
  late_fee_rate:['late_fee_rate','지연손해금률','annualPercent'],
  early_termination_rate_y1:['early_termination_rate_under1y','중도해지 위약금 · 1년 미만','percent'],
  early_termination_rate_y2:['early_termination_rate_over1y','중도해지 위약금 · 1년 이상','percent'],
  over_mileage_rate:['over_mileage_rate_per_km','초과주행 요금','perKm'],
  driver_age:['basic_driver_age','운전자 연령'], driver_scope:['driver_scope','운전자 범위'],
  coverage_liability_person:['injury_compensation_limit','대인 보상'],
  coverage_liability_property:['property_compensation_limit','대물 보상'],
  coverage_self_injury:['self_body_accident','자기신체 보상'],coverage_uninsured:['uninsured_damage','무보험차 상해'],
  emergency_dispatch_limit:['annual_roadside_assistance','긴급출동'],
  deductible_liability_person:['injury_deductible','대인 면책금'],deductible_liability_property:['property_deductible','대물 면책금'],
  self_damage_coverage:['own_damage_compensation','자차 보상'],self_damage_deductible_rate:['own_damage_repair_ratio','일반 자차 부담률'],
  self_damage_deductible_min:['own_damage_min_deductible','자차 최소 면책금'],self_damage_deductible_max:['own_damage_max_deductible','자차 최대 면책금'],
  extra_deductibles:['extra_deductibles','사유별 추가 면책금'],overdue_policy:['overdue_policy','연체 적용 조건'],
  engine_control_overdue_days:['engine_control_overdue_days','시동제어 연체 기준','days'],
  auto_terminate_overdue_days:['auto_terminate_overdue_days','해지·회수 연체 기준','days'],
  deposit_overdue_rounds:['deposit_overdue_rounds','보증금 미납 기준','count'],
  accident_termination_total_count:['accident_termination_count','원본 조건에 해당하는 사고 누적','count'],
  accident_termination_count:['accident_termination_count','원본 조건에 해당하는 사고 누적','count'],
  late_fee_basis:['late_fee_basis','지연손해금 적용 기준'],return_delay_basis:['return_delay_basis','차량 반환 지연 기준'],
  early_termination_basis:['early_termination_basis','중도해지 계산 기준'],over_mileage_basis:['over_mileage_basis','초과주행 계산 기준'],
  engine_control_basis:['engine_control_basis','시동제어 적용 기준'],auto_terminate_basis:['auto_terminate_basis','해지·회수 적용 기준'],
  deposit_overdue_basis:['deposit_overdue_basis','보증금 미납 적용 기준'],self_damage_deductible_basis:['self_damage_deductible_basis','자차 자기부담금 기준'],
  maintenance_benefit:['maintenance_benefit','정비·소모품 제공 조건'],smoking_cleaning_fee:['smoking_cleaning_fee','흡연 청소비 기준'],
  gross_negligence_basis:['gross_negligence_basis','중과실 사고 부담 기준'],pre_delivery_cancellation_basis:['pre_delivery_cancellation_basis','차량 인도 전 취소 기준'],
  deposit_return_basis:['deposit_return_basis','보증금 반환 기준'],total_loss_termination_basis:['total_loss_termination_basis','전손·수리비 정산 기준'],
  payment_cycle:['payment_cycle','납부 주기'],payment_timing:['payment_timing','납부 시점'],payment_method:['payment_method','납부 방법'],
  deposit_return_term:['deposit_return_days','보증금 반환'],insurance_condition:['insurance_included','보험료'],maintenance_product:['maintenance_service','정비 서비스'],
  replacement_car_policy:['replacement_car_policy','대차 제공'],maintenance_replacement:['maintenance_replacement','정비 시 대차'],
  succession_fee:['succession_fee','승계 비용'],succession_allowed:['succession_allowed','승계 가능 여부'],
  designated_garage:['designated_garage','정비점'],claim_basis:['claim_basis','청구 기준'],
  invoice_type:['invoice_type','증빙 종류'],invoice_cycle:['invoice_cycle','증빙 주기'],self_damage_exclusions:['self_damage_exclusions','자차 제외 사유'],
  auto_debit_date:['payment_due_date','월 납부일'],gps_installed:['gps_installed','GPS 조건'],
  deposit_installment:['deposit_installment','보증금 분납'],driver_age_upper_limit:['driver_age_upper_limit','운전자 상한 연령'],
  driver_age_lowering:['driver_age_lowering','연령 하향'],license_period:['license_period','면허 보유기간'],
  annual_mileage:['annual_mileage','기본 주행약정'],mileage_upcharge_per_10000km:['mileage_upcharge_per_10000km','약정거리 추가요금'],
  over_mileage_rate_domestic:['over_mileage_rate_domestic','국산차 초과주행 요금','perKm'],over_mileage_rate_imported:['over_mileage_rate_imported','수입차 초과주행 요금','perKm'],
  personal_driver_scope:['personal_driver_scope','개인 운전자 범위'],business_driver_scope:['business_driver_scope','사업자 운전자 범위'],
  additional_driver_allowance_count:['additional_driver_allowance_count','추가 운전자'],additional_driver_cost:['additional_driver_cost','추가 운전자 요금'],
  deposit_card_payment:['deposit_card_payment','보증금 카드 납부'],rental_card_payment:['rental_card_payment','대여료 카드 납부'],
  rental_region:['rental_region','이용 지역'],delivery_fee:['delivery_fee','배송비'],screening_criteria:['screening_criteria','심사 조건'],
  self_body_deductible:['self_body_deductible','자기신체 면책금'],uninsured_deductible:['uninsured_deductible','무보험차 면책금'],
  accident_termination_basis:['accident_termination_basis','사고 누적 해지 적용 기준'],
};
export type StandardFact = {value: string | number; origin: 'SUPPLIER' | 'FREEPASS_STANDARD'};
export type StandardFacts = Record<string, StandardFact>;
export type StandardOption = {id:string;label:string;facts:StandardFacts;cleared:string[]};
export type StandardDimension = {id:string;label:string;options:StandardOption[]};
export type StandardProfile = {id:string;label:string;kinds:Array<'RENT'|'SUBSCRIPTION'>;customerTypes:string[];sourceSha256:string;
  facts:StandardFacts;cleared:string[];dimensions:StandardDimension[]};
export type SupplierContractStandard = {schema:typeof STANDARD_CONTRACT_SCHEMA;version:string;adoptedOn:string;supplierName:string;
  supplierCodes:string[];sourceCatalogSha256:string;profiles:StandardProfile[]};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const safeText=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|https?:\/\/|file:\/\/|[A-Z]:[\\/]|-----BEGIN|\bBearer\s|\bsk-[A-Za-z0-9_-]{16,}|AIza|ya29\./i.test(v);
const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:+-]{0,159}$/.test(v);
const digest=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const unique=(v:unknown[],key:(x:unknown)=>unknown=x=>x)=>new Set(v.map(key)).size===v.length;
const cleared=(v:unknown)=>Array.isArray(v)&&v.length<=100&&unique(v)&&v.every(k=>typeof k==='string'&&Object.hasOwn(STANDARD_CONTRACT_FIELDS,k));
const facts=(v:unknown)=>record(v)&&Object.keys(v).length<=100&&Object.entries(v).every(([key,fact])=>Object.hasOwn(STANDARD_CONTRACT_FIELDS,key)
  &&record(fact)&&exact(fact,['value','origin'])&&['SUPPLIER','FREEPASS_STANDARD'].includes(String(fact.origin))
  &&(safeText(fact.value,10000)||typeof fact.value==='number'&&Number.isFinite(fact.value)&&fact.value>=0)
  &&!(STANDARD_CONTRACT_FIELDS[key]![2]&&typeof fact.value==='string'&&/^-\d+(?:\.\d+)?$/.test(fact.value.trim()))
  &&!(STANDARD_CONTRACT_FIELDS[key]![2]==='annualPercent'&&number(fact.value as string|number)!==null&&number(fact.value as string|number)!>100));
const disjoint=(a:Record<string,unknown>,b:unknown[])=>!b.some(k=>Object.hasOwn(a,String(k)));
export function isSupplierContractStandard(value:unknown):value is SupplierContractStandard {
  if(!record(value)||!exact(value,['schema','version','adoptedOn','supplierName','supplierCodes','sourceCatalogSha256','profiles'])
    ||value.schema!==STANDARD_CONTRACT_SCHEMA||!safeText(value.version,160)||!safeText(value.supplierName,100)
    ||typeof value.adoptedOn!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.adoptedOn)||!Number.isFinite(Date.parse(value.adoptedOn+'T00:00:00Z'))
    ||!Array.isArray(value.supplierCodes)||value.supplierCodes.length>12||!unique(value.supplierCodes)||!value.supplierCodes.every(id)
    ||!digest(value.sourceCatalogSha256)||!Array.isArray(value.profiles)||!value.profiles.length||value.profiles.length>12
    ||!unique(value.profiles,p=>record(p)?p.id:null))return false;
  const valid=value.profiles.every(p=>record(p)&&exact(p,['id','label','kinds','customerTypes','sourceSha256','facts','cleared','dimensions'])
    &&id(p.id)&&safeText(p.label,160)&&digest(p.sourceSha256)&&Array.isArray(p.kinds)&&p.kinds.length>0&&p.kinds.length<=2
    &&unique(p.kinds)&&p.kinds.every(k=>k==='RENT'||k==='SUBSCRIPTION')&&Array.isArray(p.customerTypes)&&p.customerTypes.length<=8
    &&p.customerTypes.every(t=>safeText(t,60))&&facts(p.facts)&&cleared(p.cleared)&&disjoint(p.facts as Record<string,unknown>,p.cleared as unknown[])
    &&Array.isArray(p.dimensions)&&p.dimensions.length<=8&&unique(p.dimensions,d=>record(d)?d.id:null)&&p.dimensions.every(d=>record(d)
      &&exact(d,['id','label','options'])&&id(d.id)&&safeText(d.label,300)&&Array.isArray(d.options)&&d.options.length>0&&d.options.length<=30
      &&unique(d.options,o=>record(o)?o.id:null)&&d.options.every(o=>record(o)&&exact(o,['id','label','facts','cleared'])&&id(o.id)
        &&safeText(o.label,1000)&&facts(o.facts)&&cleared(o.cleared)&&disjoint(o.facts as Record<string,unknown>,o.cleared as unknown[]))));
  return valid&&Buffer.byteLength(JSON.stringify(value),'utf8')<=256*1024;
}
export function assertSupplierContractStandard(value:unknown):asserts value is SupplierContractStandard {
  if(!isSupplierContractStandard(value))throw new Error('INVALID_SUPPLIER_CONTRACT_STANDARD');
}
const number=(v:string|number)=>typeof v==='number'?v:/^\d+(?:\.\d+)?$/.test(v.trim())?Number(v):null;
function convert(key:string,fact:StandardFact):string|number {
  const definition=STANDARD_CONTRACT_FIELDS[key]!,n=number(fact.value);
  if(n===null)return fact.value;
  if(definition[2]==='annualPercent')return n/100;
  if(definition[2]==='percent')return `${n}%`;
  if(definition[2]==='days')return `${n}일`;
  return n;
}
function display(key:string,fact:StandardFact,markStandard:boolean):string {
  const unit=STANDARD_CONTRACT_FIELDS[key]![2],n=number(fact.value);
  const text=n===null?String(fact.value):unit==='annualPercent'?`연 ${n}%`:unit==='percent'?`${n}%`:unit==='days'?`${n}일`:unit==='count'?`${n}회`:unit==='perKm'?`${n}원/km`:String(fact.value);
  return text+(markStandard&&fact.origin==='FREEPASS_STANDARD'?' (프리패스 표준 보완)':'');
}
export type StandardPolicyProjection={values:Record<string,string|number|null>;displayValues:Record<string,string>;managedKeys:string[];notes:string[]};
/** No vehicle classification or customer/price decision. Unknown dimensions stay conditional; original option order is retained. */
export function projectSupplierContractStandard(value:unknown,input:{supplierCode:string;productType?:unknown;baseDriverAge?:unknown}):StandardPolicyProjection|null {
  if(!isSupplierContractStandard(value)||!value.supplierCodes.includes(input.supplierCode))return null;
  const type=typeof input.productType==='string'?input.productType:'';
  const kind=/구독/.test(type)?'SUBSCRIPTION':/렌트|렌탈/.test(type)?'RENT':null;
  const profiles=value.profiles.filter(p=>!kind||p.kinds.includes(kind));
  const output:StandardPolicyProjection={values:{},displayValues:{},managedKeys:[],notes:[]};
  const allFields=new Set(value.profiles.flatMap(p=>[...Object.keys(p.facts),...p.cleared,...p.dimensions.flatMap(d=>d.options.flatMap(o=>[...Object.keys(o.facts),...o.cleared]))]));
  const managed=new Set([...allFields].map(k=>STANDARD_CONTRACT_FIELDS[k]![0]));
  managed.add('penalty_condition');managed.add('policy_extra_terms');
  if(allFields.has('driver_scope')){managed.add('personal_driver_scope');managed.add('business_driver_scope');}
  output.managedKeys=[...managed];
  for(const key of managed)output.values[key]=null;
  if(!profiles.length){output.notes.push('등록된 표준 계약의 상품 유형 확인이 필요합니다.');return output;}
  const age=typeof input.baseDriverAge==='string'?input.baseDriverAge.match(/^만\s*(\d+)세\s*이상$/)?.[1]:undefined;
  const collected=new Map<string,Array<{scope:string;fact:StandardFact|null}>>();
  for(const p of profiles){
    const base={...p.facts};for(const key of p.cleared)delete base[key];
    const ageDimension=p.dimensions.find(d=>d.id==='age');
    const selectedAge=ageDimension?.options.find(o=>o.id===age);
    if(selectedAge){Object.assign(base,selectedAge.facts);for(const key of selectedAge.cleared)delete base[key];}
    const unresolved=p.dimensions.filter(d=>!(d.id==='age'&&selectedAge));
    const pFields=new Set([...Object.keys(base),...p.cleared,...p.dimensions.flatMap(d=>d.options.flatMap(o=>[...Object.keys(o.facts),...o.cleared]))]);
    for(const key of pFields){
      const target=STANDARD_CONTRACT_FIELDS[key]![0],list=collected.get(target)??[];
      const affecting=unresolved.filter(d=>d.options.some(o=>Object.hasOwn(o.facts,key)||o.cleared.includes(key)));
      if(!affecting.length)list.push({scope:profiles.length>1?p.label:'',fact:base[key]??null});
      else for(const d of affecting)for(const o of d.options){
        const fact=o.cleared.includes(key)?null:o.facts[key]??base[key]??null;
        list.push({scope:[profiles.length>1?p.label:'',d.label,o.label].filter(Boolean).join(' · '),fact});
      }
      collected.set(target,list);
      // Mileage classes are source-labelled alternatives, not inferred vehicle attributes.
      if(key==='over_mileage_rate'){
        const dimension=p.dimensions.find(d=>d.id==='vehicleClass');
        if(dimension)for(const bucket of ['domestic','imported'] as const){
          const options=dimension.options.filter(o=>(o.id==='imported')===(bucket==='imported'));
          if(options.length){const subset=options.map(o=>({scope:o.label,fact:o.cleared.includes(key)?null:o.facts[key]??null}));
            const name=bucket==='domestic'?'over_mileage_rate_domestic':'over_mileage_rate_imported';
            collected.set(name,[...(collected.get(name)??[]),...subset]);managed.add(name);
          }
        }
      }
    }
    for(const dimension of p.dimensions){
      const lines=dimension.options.map(option=>{
        const entries=Object.entries(option.facts).map(([key,fact])=>`${STANDARD_CONTRACT_FIELDS[key]![1]} ${display(key,fact,true)}`);
        entries.push(...option.cleared.map(key=>`${STANDARD_CONTRACT_FIELDS[key]![1]}: 원본 미기재·별도 확인`));
        return `${option.label}: ${entries.join(' / ')}`;
      });
      if(lines.length)output.notes.push(`${p.label} · ${dimension.label}\n${lines.join('\n')}`);
    }
  }
  for(const [target,cases] of collected){
    const sourceKey=Object.keys(STANDARD_CONTRACT_FIELDS).find(k=>STANDARD_CONTRACT_FIELDS[k]![0]===target)??'over_mileage_rate';
    const known=cases.filter((c):c is {scope:string;fact:StandardFact}=>!!c.fact);
    const same=known.length===cases.length&&known.length>0&&known.every(c=>JSON.stringify(convert(sourceKey,c.fact))===JSON.stringify(convert(sourceKey,known[0]!.fact)));
    if(same){
      output.values[target]=convert(sourceKey,known[0]!.fact);
      const standard=known.some(c=>c.fact.origin==='FREEPASS_STANDARD');
      output.displayValues[target]=display(sourceKey,{...known[0]!.fact,origin:standard?'FREEPASS_STANDARD':'SUPPLIER'},true);
    }else{
      output.values[target]=null;
      if(known.length)output.displayValues[target]=[...new Set(cases.map(c=>`${c.scope||'기본 조건'}: ${c.fact?display(sourceKey,c.fact,true):'원본 미기재·별도 확인'}`))].join('\n');
    }
  }
  output.managedKeys=[...managed];
  output.displayValues.standard_contract_basis=`현재 보유한 공급사 표준 계약 기준 · ${value.adoptedOn} 확인`;
  if(output.notes.length)output.displayValues.standard_contract_options=output.notes.join('\n\n');
  return output;
}

/** Explicit registered supplier default only; no name/code inference or fallback from a broken reference. */
export function isRegisteredSupplierStandardDefault(value:unknown,supplierCode:string):boolean {
  return record(value)&&value.provider_company_code===supplierCode&&value.policy_code==='STD-'+supplierCode
    &&value.policy_scope==='SUPPLIER_CONTRACT_STANDARD_DEFAULT'&&value.policy_field_owner==='policy-corrector'
    &&isSupplierContractStandard(value.standard_contract)&&value.standard_contract.supplierCodes.includes(supplierCode);
}
