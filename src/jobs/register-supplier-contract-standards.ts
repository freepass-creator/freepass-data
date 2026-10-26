import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {registerSupplierContractStandards,contractStandardPolicyId,type RegisterContractStandardsInput} from '../application/register-supplier-contract-standards.js';
import {assertSupplierContractStandard} from '../domain/supplier-contract-standard.js';
import {assertCatalogWriterOwnership,resolveExecutionWriter} from '../domain/writer-ownership.js';
import {createContractStandardsRuntime} from './data-access-runtime.js';



import {stableDigest} from '../shared/stable-digest.js';

const path=process.env.CONTRACT_STANDARDS_PLAN?.trim();
if(!path)throw new Error('CONTRACT_STANDARDS_PLAN_REQUIRED');
const plan=JSON.parse(await readFile(path,'utf8')) as RegisterContractStandardsInput;
plan.standards.forEach(assertSupplierContractStandard);
const digest=stableDigest(plan),ids=plan.standards.map(contractStandardPolicyId);
const apply=process.argv.includes('--apply');
if(apply&&process.env.AUTHORIZE_CONTRACT_STANDARDS!==digest)throw new Error('EXACT_DIGEST_AUTHORIZATION_REQUIRED');
const {store,readAccess,access}=await createContractStandardsRuntime();
const spec={context:{actor:{id:'service:freepass-data',kind:'SERVICE' as const},clientId:'job:register-supplier-contract-standards',
 purpose:'register representative-adopted immutable supplier contract facts; preserve products, offers and active releases'},
 operation:'READ_SUPPLIER_CONTRACT_STANDARD_PREFLIGHT',resource:{kind:'CATALOG' as const,name:'supplier-contract-standards'},requestDigest:digest,
 summarize:(v:unknown)=>({digest:stableDigest(v)})};
const before=await readAccess.read(spec,async()=>({
 ownership:await store.getCatalogWriterOwnership(),policies:await store.listPolicies(),
}));
assertCatalogWriterOwnership(before.ownership,resolveExecutionWriter(plan.actor,plan.writer));
if(!apply)console.log(JSON.stringify({status:'DRY_RUN',planDigest:digest,profileCount:ids.length,existingPolicyCount:before.policies.length,
 existingEditionCount:before.policies.filter(p=>ids.includes(p.id)).length}));
else{
 const dir=join(homedir(),'.codex','private','freepass-data-contract-standard-backups');await mkdir(dir,{recursive:true});
 const backup=join(dir,new Date().toISOString().replace(/[:.]/g,'-')+'-'+digest.slice(0,16)+'.json');
 await writeFile(backup,JSON.stringify({planDigest:digest,capturedAt:new Date().toISOString(),before},null,2),{flag:'wx',mode:0o600});
 const receipt=await access.write({...spec,operation:'WRITE_SUPPLIER_CONTRACT_STANDARDS'},
 ()=>registerSupplierContractStandards(store,plan));
 const after=await access.read({...spec,operation:'READ_SUPPLIER_CONTRACT_STANDARD_READBACK'},()=>store.listPolicies());
 for(let i=0;i<ids.length;i++){
  const stored=after.find(p=>p.id===ids[i]);
  if(!stored||stored.kind!=='OTHER'||stableDigest(stored.facts.standardContract)!==stableDigest(plan.standards[i]))throw new Error('STANDARD_READBACK_MISMATCH '+ids[i]);
 }
 console.log(JSON.stringify({status:'PERSISTENCE_VERIFIED',planDigest:digest,backup,profileCount:ids.length,receipt}));
}
