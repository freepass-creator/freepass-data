const ORIGIN='https://eancarone.com';
const H={'user-agent':'FreePassData/1 public-partner-api-discovery',accept:'text/html,application/javascript,*/*'};
async function get(path){
  const u=new URL(path,ORIGIN);
  if(u.origin!==ORIGIN) throw new Error('ORIGIN_ESCAPE');
  const r=await fetch(u,{redirect:'manual',cache:'no-store',headers:H,signal:AbortSignal.timeout(20000)});
  if(r.status>=300&&r.status<400) throw new Error('REDIRECT_'+r.status+'_'+u.pathname);
  if(!r.ok) throw new Error('HTTP_'+r.status+'_'+u.pathname);
  return r.text();
}
const html=await get('/');
const indexRef=[...html.matchAll(/["'](\/assets\/index-[^"']+\.js)["']/g)].map(m=>m[1])[0];
if(!indexRef) throw new Error('INDEX_ASSET_NOT_FOUND');
const index=await get(indexRef);
const imported=[...new Set([...index.matchAll(/(?:import\(|from\s*)[`'"]\.\/([A-Za-z0-9_~.-]+\.js)/g)].map(m=>'/assets/'+m[1]))];
const named=[...new Set([
  ...imported.filter(x=>/partner|api|guide|manager/i.test(x)),
  ...[...index.matchAll(/\.\/([A-Za-z0-9_~.-]+\.js)/g)].map(m=>'/assets/'+m[1]).filter(x=>/partner|api|guide|manager/i.test(x))
])];
const contexts=[];
function scan(asset,body){
  for(const rx of [/partner-api/ig,/api[-_ ]?key/ig,/x-api-key/ig,/authorization/ig,/bearer/ig,/\/api\/[A-Za-z0-9_?&=./:%{}$-]+/ig,/curl\s/ig,/header/ig]){
    for(const m of body.matchAll(rx)){
      const i=m.index??0;
      contexts.push({asset,keyword:m[0],context:body.slice(Math.max(0,i-300),Math.min(body.length,i+900)).replace(/\s+/g,' ').slice(0,1150)});
    }
  }
}
scan(indexRef,index);
const fetched=[];
for(const asset of named.slice(0,80)){
  try{const body=await get(asset);fetched.push({asset,bytes:Buffer.byteLength(body)});scan(asset,body)}
  catch(e){fetched.push({asset,error:e instanceof Error?e.message:'ERR'})}
}
console.log(JSON.stringify({
  origin:ORIGIN,indexAsset:indexRef,
  candidateAssets:named,
  fetched,
  contexts:contexts.filter(x=>/partner-api|api[-_ ]?key|x-api-key|authorization|bearer|\/api\//i.test(x.keyword)).slice(0,250),
  note:'PUBLIC_CODE_ONLY_NO_KEY_NO_AUTHENTICATED_CALL'
},null,2));