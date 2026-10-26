import type {CatalogStore} from '../ports/catalog-store.js';
import {isSupplierContractStandard,type SupplierContractStandard} from '../domain/supplier-contract-standard.js';
export type ContractStandardEdition={policyId:string;version:string;effectiveFrom:string;supplierBindingState:'BOUND'|'UNLINKED_SUPPLIER';standard:SupplierContractStandard};
/** Public business facts only; internal entity metadata and unrelated policy facts never leave this boundary. */
export async function readContractStandardCatalog(store:Pick<CatalogStore,'listPolicies'>):Promise<ContractStandardEdition[]>{
 const policies=await store.listPolicies();
 return policies.filter(p=>p.kind==='OTHER'&&Object.hasOwn(p.facts,'standardContract')).map((p):ContractStandardEdition=>{
  const standard=p.facts.standardContract;
  if(!isSupplierContractStandard(standard)||standard.version!==p.version)throw new Error('STORED_STANDARD_INVALID');
  return {policyId:p.id,version:p.version,effectiveFrom:p.effectiveFrom,supplierBindingState:standard.supplierCodes.length?'BOUND':'UNLINKED_SUPPLIER',standard};
 }).sort((a,b)=>a.policyId.localeCompare(b.policyId));
}
