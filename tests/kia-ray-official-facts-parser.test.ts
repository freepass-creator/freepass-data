import { describe,it,expect } from 'vitest';
import { parseKiaRayOfficialFacts, type KiaRayOfficialFactsInput } from '../src/adapters/kia-ray-official-facts-parser.js';
const API='https://kwpapi.kia.com/kr/ko/api/v1/purchase/configurator/';
// Structural test fixtures only; never loaded by serving/publication paths.
function fixture():KiaRayOfficialFactsInput {
  const source=(url:string,body:unknown)=>({url,bytes:Buffer.from(JSON.stringify({code:'0000',body}))});
  const codes=['UD','M9Y','M7G','ABP','AEQ','A2G'];
  const definitions=[{no:'2905',name:'프레스티지',base:18150000,model:'TMJC5AC3I',options:[['STY','KRTM311P02','스타일',500000],['15R','KRTM311P03','15인치 전면가공 휠',400000],['CPT2','KRTM311P05','컴포트 Ⅱ',300000],['DWP','KRTM311P06','드라이브 와이즈',300000],['NAV','KRTM311P09','8인치 내비게이션',500000]]},
    {no:'2906',name:'시그니처',base:19550000,model:'TMJC5AH3I',options:[['NAV','KRTM311P09','8인치 내비게이션',500000],['STY','KRTM311P02','스타일',500000]]}];
  let html='<h2 class="main-title">The 2027 Ray</h2>';
  const rows=[],options:KiaRayOfficialFactsInput['options']=[],combinations:KiaRayOfficialFactsInput['combinations']=[];
  for(const d of definitions) {
    html+=`<table class="price_list__table"><h3 class="price_list__item-title">${d.name}</h3><p class="trim_price"><strong>${d.base.toLocaleString('en-US')}</strong></p><ul class="accor_con__list">${d.options.map(o=>`<li><a data-modal-id="${o[1]}">${o[2]}</a><p class="item-price">${Number(o[3]).toLocaleString('en-US')}</p></li>`).join('')}</ul></table>`;
    rows.push({trimNo:d.no,rcCode:'KRTM311',trimCodeName:d.name,engineCdNm:'1.0 가솔린',engineSctCode:'GS',capaCode:'5',saleModelCode:d.model,salePrice:d.base,
      exteriorColors:codes.map(colorCode=>({colorCode,colorName:colorCode,colorPrice:0,specCode:'A,N'})),
      interiorColors:[{colorCode:'EQ',colorName:'블랙',colorPrice:0,specCode:'A,O'},{colorCode:'EQ',colorName:'라이트 그레이',colorPrice:0,specCode:'N,P'}]});
    for(const specCode of ['A','N'] as const) {
      options.push({...source(API+`${d.model}/spec-grade/${specCode}/options`,{optionList:d.options.map(o=>({optionCode:o[0],dscpId:o[1],optionName:o[2],optionPrice:o[3]}))}),trimNo:d.no,specCode});
      for(const exteriorCode of codes) {
        const body=Array.from({length:2**d.options.length},(_,mask)=>{
          const selected=d.options.filter((_,i)=>mask&(1<<i));return {exteriorColorCode:exteriorCode,interiorColorCode:'EQ',exteriorColorYn:true,interiorColorYn:true,
            optionCodeList:selected.map(o=>o[0]).join(','),salePrice:d.base+selected.reduce((sum,o)=>sum+Number(o[3]),0)};
        });
        const query=new URLSearchParams({extColrCd:exteriorCode,intColrCd:'EQ',optCds:'',specCode});
        combinations.push({...source(API+`${d.no}/color-option-combination?${query}`,body),trimNo:d.no,exteriorCode,specCode});
      }
    }
  }
  return {observedAt:'2026-10-31T00:00:00Z',pricePage:{url:'https://www.kia.com/kr/vehicles/ray/price',bytes:Buffer.from(html)},trims:source(API+'KRTM311/trims',rows),options,combinations};
}
function mutate(input:KiaRayOfficialFactsInput,key:'trims'|'options'|'combinations',run:(body:any)=>void,index=0) {
  const doc=key==='trims'?input.trims:input[key][index]!;
  const json=JSON.parse(doc.bytes.toString());run(json.body);doc.bytes=Buffer.from(JSON.stringify(json));
}
describe('reviewed 2027 Ray manufacturer facts',()=>{
  it('reconciles HTML/API prices and all 432 option/color combinations while preserving two EQ interiors',()=>{
    const result=parseKiaRayOfficialFacts(fixture());
    expect(result.records.map(r=>[r.trimName,r.basePrice,r.options.length])).toEqual([['프레스티지',18150000,5],['시그니처',19550000,2]]);
    expect(result.records[0]!.interiorColors.map(c=>c.sourceColorKey)).toEqual(['EQ:A','EQ:N']);
    expect(result.records.flatMap(r=>r.evidence.combinations).reduce((sum,row)=>sum+row.combinations,0)).toBe(432);
    expect(result.records.every(r=>r.scope.postDeliveryAccessoriesIncluded===false)).toBe(true);
  });
  it('never turns absent color money into zero',()=>{
    const f=fixture();mutate(f,'trims',rows=>delete rows[0].exteriorColors[0].colorPrice);
    expect(()=>parseKiaRayOfficialFacts(f)).toThrow('EXPLICIT_PRICE_REQUIRED');
  });
  it('rejects API option price drift from the manufacturer HTML',()=>{
    const f=fixture();for(let i=0;i<2;i++)mutate(f,'options',body=>body.optionList.find((o:any)=>o.optionCode==='NAV').optionPrice=750000,i);
    expect(()=>parseKiaRayOfficialFacts(f)).toThrow('HTML_API_OPTION_PRICE_MISMATCH');
  });
  it('does not infer unrestricted options from an incomplete combination matrix',()=>{
    const f=fixture();mutate(f,'combinations',body=>body.pop());
    expect(()=>parseKiaRayOfficialFacts(f)).toThrow('COMBINATION_MATRIX_INCOMPLETE');
  });
  it('rejects a combination whose actual total differs by one won',()=>{
    const f=fixture();mutate(f,'combinations',body=>body[1].salePrice++);
    expect(()=>parseKiaRayOfficialFacts(f)).toThrow('COMBINATION_PRICE_MISMATCH');
  });
  it('requires independent option equality for black and light-grey interiors',()=>{
    const f=fixture();mutate(f,'options',body=>body.optionList.pop(),1);
    expect(()=>parseKiaRayOfficialFacts(f)).toThrow('API_OPTION_COVERAGE_MISMATCH');
  });
  it('fails if the manufacturer scope moves to a different physical vehicle or model year',()=>{
    const f=fixture();mutate(f,'trims',rows=>rows[0].capaCode='2');expect(()=>parseKiaRayOfficialFacts(f)).toThrow('PHYSICAL_IDENTITY_MISMATCH');
    const g=fixture();g.pricePage.bytes=Buffer.from(g.pricePage.bytes.toString().replace('2027','2028'));expect(()=>parseKiaRayOfficialFacts(g)).toThrow('UNREVIEWED_MODEL_YEAR');
  });
  it('refuses a color-combination result filed under another exterior',()=>{
    const f=fixture();mutate(f,'combinations',body=>body[0].exteriorColorCode='NOT-UD');
    expect(()=>parseKiaRayOfficialFacts(f)).toThrow('COMBINATION_COLOR_MISMATCH');
  });
});
