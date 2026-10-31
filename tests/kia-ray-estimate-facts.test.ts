import {describe,it,expect} from 'vitest';
import {mapKiaRayEstimateFacts,type KiaRayOfficialRecord,type KiaRayEstimateFactsSources} from '../src/application/kia-ray-estimate-facts.js';
// Structural parser-output fixtures, never used as operational source data.
function fixture() {
  const evidence=(url:string)=>({url,sha256:'a'.repeat(64),byteCount:1});
  const exteriorColors=['UD','M9Y','M7G','ABP','AEQ','A2G'].map(sourceColorCode=>({sourceColorCode,name:sourceColorCode,price:0,specCodes:['A','N']}));
  const interiorColors=['A','N'].map(sourceSpecCode=>({sourceColorCode:'EQ',sourceSpecCode,sourceColorKey:`EQ:${sourceSpecCode}`,name:sourceSpecCode,price:0}));
  const record={maker:'기아',model:'레이',modelYear:2027,sourceVehicleCode:'KRTM311',sourceTrimNo:'2906',sourceSaleModelCode:'TMJC5AH3I',powertrainName:'1.0 가솔린',seats:5,trimName:'시그니처',basePrice:19550000,
    options:['NAV','STY'].map(sourceOptionCode=>({sourceOptionCode,sourceDescriptionId:sourceOptionCode,name:sourceOptionCode,price:500000,requires:[],excludes:[]})),exteriorColors,interiorColors,
    scope:{factorySpecCodes:['A','N'],postDeliveryAccessoriesIncluded:false,allOptionSubsetsVerified:true},
    evidence:{baseAndOptions:[evidence('https://www.kia.com/kr/vehicles/ray/price'),evidence('trims'),evidence('optionsA'),evidence('optionsN')],combinations:exteriorColors.flatMap(exterior=>interiorColors.map(interior=>({...evidence(`${exterior.sourceColorCode}/${interior.sourceSpecCode}`),exteriorCode:exterior.sourceColorCode,interiorSpecCode:interior.sourceSpecCode,combinations:4})))},
  } as KiaRayOfficialRecord;
  const sources:KiaRayEstimateFactsSources={sourceDocumentId:'primary',sourceBytesSha256:'a'.repeat(64),trimRowKey:'actual-trim-key',sourceDocumentsByUrl:{}};
  [...record.evidence.baseAndOptions.slice(1),...record.evidence.combinations].forEach((row,index)=>sources.sourceDocumentsByUrl[row.url]={id:`source-${index}`,sha256:row.sha256});
  return {record,sources};
}
describe('Kia Ray operational manufacturer mapper',()=>{
  it('preserves manufacturer money, unknown physicals, distinct interiors, and every archived source reference',()=>{
    const {record,sources}=fixture(),result=mapKiaRayEstimateFacts(record,sources);
    expect(result.basePrice).toEqual({amount:19550000,currency:'KRW'});
    expect(result.priceBefore).toEqual(result.basePrice);expect(result.priceAfter).toEqual(result.basePrice);
    expect(result.physical).toEqual({fuel:'가솔린',seats:5,engineCc:null,turbo:null,drivetrain:null,bodyConfiguration:null});
    expect(result.options[0]!.optionId).toBe('actual-trim-key::option:NAV');
    expect(result.interiorColors.map(c=>c.colorId)).toEqual(['actual-trim-key::interior:EQ:A','actual-trim-key::interior:EQ:N']);
    expect(result.additionalSourceDocuments).toHaveLength(15);
    expect(new Set(Object.values(result.fieldSources!))).toEqual(new Set(['primary',...result.additionalSourceDocuments!.map(ref=>ref.id)]));
  });
  it('fails closed for missing archive references or digest mismatch',()=>{
    const f=fixture();delete f.sources.sourceDocumentsByUrl.trims;expect(()=>mapKiaRayEstimateFacts(f.record,f.sources)).toThrow('ADDITIONAL_SOURCE_MISMATCH');
    const g=fixture();g.sources.sourceBytesSha256='b'.repeat(64);expect(()=>mapKiaRayEstimateFacts(g.record,g.sources)).toThrow('PRIMARY_SOURCE_MISMATCH');
  });
  it('never invents zero prices from absent manufacturer amounts',()=>{
    const f=fixture();delete (f.record.exteriorColors[0] as Partial<typeof f.record.exteriorColors[number]>).price;
    expect(()=>mapKiaRayEstimateFacts(f.record,f.sources)).toThrow('EXPLICIT_PRICE_REQUIRED');
  });
  it('requires the full option/color matrix before publishing unrestricted options',()=>{
    const f=fixture();f.record.scope.allOptionSubsetsVerified=false;expect(()=>mapKiaRayEstimateFacts(f.record,f.sources)).toThrow('COMPLETE_EVIDENCE_REQUIRED');
    const g=fixture();g.record.evidence.combinations[0]!.combinations=3;expect(()=>mapKiaRayEstimateFacts(g.record,g.sources)).toThrow('COMPLETE_EVIDENCE_REQUIRED');
  });
  it('rejects duplicate archived document identities and mismatched evidence hashes',()=>{
    const f=fixture();f.sources.sourceDocumentsByUrl.optionsA!.id='source-0';expect(()=>mapKiaRayEstimateFacts(f.record,f.sources)).toThrow('ADDITIONAL_SOURCE_MISMATCH');
    const g=fixture();g.sources.sourceDocumentsByUrl.optionsN!.sha256='c'.repeat(64);expect(()=>mapKiaRayEstimateFacts(g.record,g.sources)).toThrow('ADDITIONAL_SOURCE_MISMATCH');
  });
});
