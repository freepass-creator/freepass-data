import {it,expect} from 'vitest';
import {createConsumerGateway,type ConsumerBinding} from '../src/api/consumer-gateway.js';
import {MemoryDataStore} from '../src/infra/memory-store.js';
import {DataAccessGateway} from '../src/application/data-access-gateway.js';
import {MemoryDataAccessLogStore} from '../src/infra/memory-data-access-log.js';
import type {ContractStandardEdition} from '../src/application/contract-standard-catalog.js';
const token='test-service-token-0123456789abcdef',headers={authorization:'Bearer '+token};
const binding:ConsumerBinding={id:'erp-com',projectionId:'erp-public',token,capabilities:['catalog']};
const edition:ContractStandardEdition={policyId:'std_'+'a'.repeat(40),version:'fixture-v1',effectiveFrom:'2026-10-27T00:00:00Z',supplierBindingState:'UNLINKED_SUPPLIER',standard:{schema:'supplier-contract-standard/v1',version:'fixture-v1',adoptedOn:'2026-10-26',supplierName:'검증 공급사',supplierCodes:[],sourceCatalogSha256:'a'.repeat(64),profiles:[{id:'fixture',label:'렌트',kinds:['RENT'],customerTypes:[],sourceSha256:'b'.repeat(64),facts:{},cleared:[],dimensions:[]}]}};
it('publishes validated immutable standard editions with existing catalog authentication and fails closed on private extras',async()=>{
 let rows=[structuredClone(edition)],reads=0;
 const app=createConsumerGateway(new MemoryDataStore(),[binding],new DataAccessGateway(new MemoryDataAccessLogStore()),undefined,{read:async()=>{throw Error('unused');},readContractStandards:async()=>{reads++;return rows;}});
 try{
  const url='/v1/consumers/erp-com/contract-standards';
  expect((await app.inject({method:'GET',url})).statusCode).toBe(401);expect(reads).toBe(0);
  const ok=await app.inject({method:'GET',url,headers});expect(ok.statusCode).toBe(200);expect(ok.json().standards).toEqual([edition]);expect(ok.headers['cache-control']).toBe('private, no-store');
  expect((await app.inject({method:'GET',url:url+'?collection=private',headers})).statusCode).toBe(400);
  rows=[{...edition,customerName:'private'} as ContractStandardEdition];expect((await app.inject({method:'GET',url,headers})).statusCode).toBe(503);
 }finally{await app.close();}
});
