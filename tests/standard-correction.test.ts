import {describe,it,expect} from 'vitest';
import {Timestamp,type Firestore} from 'firebase-admin/firestore';
import {validatePolicyCorrectionPlan,policyCorrectionValuesEqual,type PolicyCorrectionPlan} from '../src/domain/policy-correction.js';
import {readSingleProductCompatibility} from '../src/infra/erp5-compat-catalog-reader.js';
const bundle={schema:'supplier-contract-standard/v1',version:'fixture-v1',adoptedOn:'2026-10-26',supplierName:'검증 공급사',supplierCodes:['RP999'],sourceCatalogSha256:'a'.repeat(64),profiles:[{id:'fixture-rental',label:'렌트',kinds:['RENT'],customerTypes:[],sourceSha256:'b'.repeat(64),facts:{early_termination_rate_y1:{value:'35',origin:'SUPPLIER'}},cleared:['self_damage_deductible_rate'],dimensions:[]}]};
const evidence={source:'대표결정' as const,location:'검증 계약 기준',effectiveDate:'2026-10-27',answerSha256:'c'.repeat(64),applicability:'검증 공급사 표준 계약'};
const plan=():PolicyCorrectionPlan=>({planId:'fixture',createdAt:'2026-10-27T00:00:00Z',items:[{policyCode:'STD-RP999',supplierCode:'RP999',field:'standard_contract',layer:'supplierCondition',from:null,to:structuredClone(bundle) as never,evidence}],createDefaults:[{policyCode:'STD-RP999',supplierCode:'RP999'}]});
describe('registered standard correction and read boundaries',()=>{
it('registers only an exact supplier-bound default and compares native facts by content',()=>{
 expect(validatePolicyCorrectionPlan(plan()).policyCount).toBe(1);
 expect(policyCorrectionValuesEqual(bundle,structuredClone(bundle))).toBe(true);
 const wrong=plan();wrong.createDefaults![0]!.supplierCode='RP998';expect(()=>validatePolicyCorrectionPlan(wrong)).toThrow();
 const foreign=plan();foreign.items[0]!.supplierCode='RP998';delete foreign.createDefaults;expect(()=>validatePolicyCorrectionPlan(foreign)).toThrow('STANDARD_SUPPLIER_MISMATCH');
});
it('allows a misleading scalar to be cleared only with its source-bound standard replacement',()=>{
 const p=plan();delete p.createDefaults;p.items.push({policyCode:'STD-RP999',supplierCode:'RP999',field:'own_damage_repair_ratio',layer:'supplierCondition',from:'20%',operation:'clear',evidence});
 expect(validatePolicyCorrectionPlan(p).itemCount).toBe(2);
 p.items[1]!.field='injury_deductible';expect(()=>validatePolicyCorrectionPlan(p)).toThrow('CLEAR_NOT_ALLOWED');
});
it('returns a registered exact supplier default with one point policy read, never another supplier or an invalid default',async()=>{
 const at=Timestamp.fromDate(new Date('2026-10-27T00:00:00Z')),reads:string[]=[];
 const policy:Record<string,unknown>={policy_code:'STD-RP999',provider_company_code:'RP999',policy_scope:'SUPPLIER_CONTRACT_STANDARD_DEFAULT',policy_field_owner:'policy-corrector',standard_contract:bundle};
 const records:Record<string,Record<string,unknown>>={'products/car':{provider_company_code:'RP999'},'policy/STD-RP999':policy,'partner/RP999':{partner_code:'RP999'}};
 const db={collection:(collection:string)=>({doc:(id:string)=>({id,path:collection+'/'+id})}),runTransaction:async(fn:(tx:unknown)=>Promise<unknown>)=>fn({get:async(ref:{id:string;path:string})=>{reads.push(ref.path);return {id:ref.id,exists:!!records[ref.path],data:()=>records[ref.path],readTime:at,updateTime:at};}})} as unknown as Firestore;
 const result=await readSingleProductCompatibility(db,'erp-com','car',new Set(['products','policy','partner']));
 expect(Object.keys(result.data.policies)).toEqual(['STD-RP999']);expect(result.data.policies['STD-RP999']!.standard_contract).toEqual(bundle);
 expect(reads).toEqual(['products/car','policy/STD-RP999','partner/RP999']);
 policy.provider_company_code='RP998';expect(Object.keys((await readSingleProductCompatibility(db,'erp-com','car',new Set(['products','policy','partner']))).data.policies)).toEqual([]);
});
});
