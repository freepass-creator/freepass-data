export type AdminViewAuthDecision =
  | { ok:true }
  | { ok:false; status:401|503; code:'UNAUTHORIZED'|'ADMIN_VIEW_AUTH_NOT_BOUND' };

export function adminViewAuthDecision(
  env:NodeJS.ProcessEnv,
  authorizationHeader:string|undefined,
):AdminViewAuthDecision{
  const required=String(env.FREEPASS_DATA_ADMIN_VIEW_TOKEN??'').trim();
  if(env.NODE_ENV==='production'&&!required){
    return{ok:false,status:503,code:'ADMIN_VIEW_AUTH_NOT_BOUND'};
  }
  if(required&&String(authorizationHeader??'')!=='Bearer '+required){
    return{ok:false,status:401,code:'UNAUTHORIZED'};
  }
  return{ok:true};
}
