import { createHash } from 'node:crypto';

export type KiaRaySourceBytes = { url:string; bytes:Buffer };
export type KiaRayOfficialFactsInput = {
  observedAt:string;
  pricePage:KiaRaySourceBytes;
  trims:KiaRaySourceBytes;
  options:Array<KiaRaySourceBytes & {trimNo:string;specCode:'A'|'N'}>;
  combinations:Array<KiaRaySourceBytes & {trimNo:string;exteriorCode:string;specCode:'A'|'N'}>;
};
type Rec=Record<string,unknown>;
const API='https://kwpapi.kia.com/kr/ko/api/v1/purchase/configurator/';
const trimScope=[{trimNo:'2905',name:'프레스티지',optionCount:5},{trimNo:'2906',name:'시그니처',optionCount:2}] as const;
function fail(code:string):never {throw new Error('KIA_RAY_FACTS_'+code);}
function rec(value:unknown):Rec {if(!value||typeof value!=='object'||Array.isArray(value))fail('OBJECT_REQUIRED');return value as Rec;}
function list(value:unknown):Rec[] {if(!Array.isArray(value))fail('ARRAY_REQUIRED');return value.map(rec);}
function text(value:unknown) {if(typeof value!=='string'||!value.trim())fail('TEXT_REQUIRED');return value.trim();}
function money(value:unknown) {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)fail('EXPLICIT_PRICE_REQUIRED');return value;}
function evidence(source:KiaRaySourceBytes) {return {url:source.url,sha256:createHash('sha256').update(source.bytes).digest('hex'),byteCount:source.bytes.length};}
function read(source:KiaRaySourceBytes,expectedUrl:string) {
  if(source.url!==expectedUrl||!Buffer.isBuffer(source.bytes)||!source.bytes.length)fail('SOURCE_IDENTITY_MISMATCH');
  const body=rec(JSON.parse(source.bytes.toString('utf8')));
  if(body.code!=='0000')fail('SOURCE_API_NOT_SUCCESS');
  return body.body;
}
function plain(value:string) {return value.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();}
function one<T>(values:T[],code:string):T {if(values.length!==1)fail(code);return values[0]!;}
function setKey(values:string[]) {return [...values].sort().join(',');}
function optionSets(codes:string[]) {return Array.from({length:2**codes.length},(_,mask)=>setKey(codes.filter((_,i)=>mask&(1<<i))));}

/** Pure parser for the explicitly reviewed 2027 Ray 5-seat A/N factory scope.
 * HTTP, archive/persistence, reviewed permanent identity bindings and publication
 * remain outside this module. Missing color prices/option combinations are HOLD,
 * never zero or an empty option list. O/P post-delivery two-tone accessories are
 * outside this factory-options scope and cannot silently enter it as free paint.
 */
export function parseKiaRayOfficialFacts(input:KiaRayOfficialFactsInput) {
  if(!Number.isFinite(Date.parse(input.observedAt)))fail('OBSERVATION_TIME_REQUIRED');
  if(input.pricePage.url!=='https://www.kia.com/kr/vehicles/ray/price')fail('SOURCE_IDENTITY_MISMATCH');
  const html=input.pricePage.bytes.toString('utf8');
  const marketingTitle=one([...html.matchAll(/<h2\b[^>]*class="main-title"[^>]*>([\s\S]*?)<\/h2>/g)].map(match=>plain(match[1]!)).filter(value=>/^The \d{4} Ray$/.test(value)),'MODEL_YEAR_UNVERIFIED');
  const modelYear=Number(marketingTitle.match(/\d{4}/)![0]);
  if(modelYear!==2027)fail('UNREVIEWED_MODEL_YEAR');
  const trims=list(read(input.trims,API+'KRTM311/trims'));
  const tables=[...html.matchAll(/<table\b[^>]*class="price_list__table"[^>]*>[\s\S]*?<\/table>/g)].map(match=>match[0]);
  const records=trimScope.map(scope=>{
    const trim=one(trims.filter(row=>row.trimNo===scope.trimNo),'TRIM_AMBIGUOUS');
    if(trim.rcCode!=='KRTM311'||trim.trimCodeName!==scope.name||trim.engineCdNm!=='1.0 가솔린'||trim.engineSctCode!=='GS'||trim.capaCode!=='5')fail('PHYSICAL_IDENTITY_MISMATCH');
    const basePrice=money(trim.salePrice),saleModelCode=text(trim.saleModelCode);
    const table=one(tables.filter(table=>{
      const title=table.match(/<h3\b[^>]*class="price_list__item-title"[^>]*>([\s\S]*?)<\/h3>/)?.[1];
      const price=table.match(/<p\b[^>]*class="trim_price"[^>]*>\s*<strong>([\d,]+)<\/strong>/)?.[1];
      return title&&plain(title)===scope.name&&price&&Number(price.replaceAll(',',''))===basePrice;
    }),'HTML_API_BASE_PRICE_MISMATCH');
    const firstOptions=one([...table.matchAll(/<ul\b[^>]*class="accor_con__list"[^>]*>([\s\S]*?)<\/ul>/g)].slice(0,1),'HTML_OPTIONS_MISSING')[1]!;
    const htmlOptions=[...firstOptions.matchAll(/<li>\s*<a\b[^>]*data-modal-id="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p\b[^>]*class="item-price"[^>]*>([\d,]+)<\/p>[\s\S]*?<\/li>/g)].map(match=>({sourceDescriptionId:match[1]!,name:plain(match[2]!),price:Number(match[3]!.replaceAll(',',''))}));
    if(htmlOptions.length!==scope.optionCount)fail('HTML_OPTION_COVERAGE_MISMATCH');
    const optionDocs=(['A','N'] as const).map(specCode=>one(input.options.filter(doc=>doc.trimNo===scope.trimNo&&doc.specCode===specCode),'OPTION_SOURCE_MISSING'));
    const optionsBySpec=optionDocs.map(doc=>list(rec(read(doc,API+`${saleModelCode}/spec-grade/${doc.specCode}/options`)).optionList).map(option=>({sourceOptionCode:text(option.optionCode),sourceDescriptionId:text(option.dscpId),name:text(option.optionName),price:money(option.optionPrice)})));
    const optionKey=(option:typeof optionsBySpec[number][number])=>JSON.stringify(option);
    if(optionsBySpec.some(options=>options.length!==scope.optionCount||new Set(options.map(option=>option.sourceOptionCode)).size!==options.length))fail('API_OPTION_COVERAGE_MISMATCH');
    if(optionsBySpec[0]!.map(optionKey).sort().join('\n')!==optionsBySpec[1]!.map(optionKey).sort().join('\n'))fail('INTERIOR_OPTION_PRICE_DRIFT');
    const options=optionsBySpec[0]!;
    for(const option of options) {
      const match=one(htmlOptions.filter(row=>row.sourceDescriptionId===option.sourceDescriptionId),'HTML_OPTION_ID_MISMATCH');
      if(match.name!==option.name||match.price!==option.price)fail('HTML_API_OPTION_PRICE_MISMATCH');
    }
    const exteriorColors=list(trim.exteriorColors).map(color=>({sourceColorCode:text(color.colorCode),name:text(color.colorName),price:money(color.colorPrice),specCodes:text(color.specCode).split(',')}));
    if(exteriorColors.length!==6||new Set(exteriorColors.map(color=>color.sourceColorCode)).size!==6||exteriorColors.some(color=>!color.specCodes.includes('A')||!color.specCodes.includes('N')))fail('COLOR_COVERAGE_MISMATCH');
    const interiorRows=list(trim.interiorColors);
    const interiorColors=(['A','N'] as const).map(specCode=>{
      const color=one(interiorRows.filter(color=>text(color.specCode).split(',').includes(specCode)),'INTERIOR_COLOR_AMBIGUOUS');
      const name=text(color.colorName);
      if(name!==(specCode==='A'?'블랙':'라이트 그레이'))fail('INTERIOR_IDENTITY_MISMATCH');
      return {sourceColorCode:text(color.colorCode),sourceSpecCode:specCode,sourceColorKey:`${text(color.colorCode)}:${specCode}`,name,price:money(color.colorPrice)};
    });
    const codes=options.map(option=>option.sourceOptionCode),expectedSets=new Set(optionSets(codes));
    const combinationEvidence=[];
    for(const exterior of exteriorColors) for(const interior of interiorColors) {
      const doc=one(input.combinations.filter(doc=>doc.trimNo===scope.trimNo&&doc.exteriorCode===exterior.sourceColorCode&&doc.specCode===interior.sourceSpecCode),'COMBINATION_SOURCE_MISSING');
      const expectedUrl=new URL(API+`${scope.trimNo}/color-option-combination`);
      expectedUrl.search=new URLSearchParams({extColrCd:exterior.sourceColorCode,intColrCd:interior.sourceColorCode,optCds:'',specCode:interior.sourceSpecCode}).toString();
      const combinations=list(read(doc,expectedUrl.href));
      const observed=new Set<string>();
      for(const row of combinations) {
        if(row.exteriorColorCode!==exterior.sourceColorCode||row.interiorColorCode!==interior.sourceColorCode||row.exteriorColorYn!==true||row.interiorColorYn!==true)fail('COMBINATION_COLOR_MISMATCH');
        const selected=typeof row.optionCodeList==='string'?row.optionCodeList.split(',').filter(Boolean):fail('COMBINATION_OPTIONS_UNKNOWN');
        if(new Set(selected).size!==selected.length||selected.some(code=>!codes.includes(code)))fail('COMBINATION_OPTIONS_UNKNOWN');
        const key=setKey(selected);if(observed.has(key))fail('COMBINATION_DUPLICATE');observed.add(key);
        const expected=basePrice+exterior.price+interior.price+options.filter(option=>selected.includes(option.sourceOptionCode)).reduce((sum,option)=>sum+option.price,0);
        if(money(row.salePrice)!==expected)fail('COMBINATION_PRICE_MISMATCH');
      }
      if(observed.size!==expectedSets.size||[...expectedSets].some(key=>!observed.has(key)))fail('COMBINATION_MATRIX_INCOMPLETE');
      combinationEvidence.push({...evidence(doc),exteriorCode:exterior.sourceColorCode,interiorSpecCode:interior.sourceSpecCode,combinations:observed.size});
    }
    return {maker:'기아',model:'레이',modelYear,sourceVehicleCode:'KRTM311',sourceTrimNo:scope.trimNo,sourceSaleModelCode:saleModelCode,powertrainName:text(trim.engineCdNm),seats:5,trimName:scope.name,basePrice,
      options:options.map(option=>({...option,requires:[] as string[],excludes:[] as string[]})),exteriorColors,interiorColors,
      scope:{factorySpecCodes:['A','N'],postDeliveryAccessoriesIncluded:false,allOptionSubsetsVerified:true},
      evidence:{baseAndOptions:[evidence(input.pricePage),evidence(input.trims),...optionDocs.map(evidence)],combinations:combinationEvidence},
    };
  });
  return {contract:'kia-ray-official-facts/v1' as const,observedAt:input.observedAt,marketingTitle,records};
}
