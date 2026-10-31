import { createServer } from 'node:http';
import { createEstimateOperationalRecoveryRuntime } from './data-access-runtime.js';

// Private, isolated builder process. It exposes health only, never consumer data
// or a remotely callable publication command. Existing consumer services stay separate.
const mode=process.env.ESTIMATE_RECOVERY_MODE;
if(!['inspect','prepare','publish','restore'].includes(mode||'')||process.env.NODE_ENV!=='production'||process.env.FIREBASE_PROJECT_ID!=='freepasserp5'||process.env.FREEPASS_DATA_DRIVER!=='firestore')throw new Error('ESTIMATE_RECOVERY_EXACT_PRODUCTION_TARGET_REQUIRED');
let status='RUNNING';
const server=createServer((request,response)=>{
  response.setHeader('Content-Type','application/json');
  response.statusCode=request.url==='/health'?200:404;
  response.end(JSON.stringify(request.url==='/health'?{contract:'estimate-recovery-health/v1',status}:{code:'NOT_FOUND'}));
});
await new Promise<void>(resolve=>server.listen(Number(process.env.PORT??8080),'0.0.0.0',resolve));
try {
  const result=await createEstimateOperationalRecoveryRuntime().run({mode:mode as 'inspect'|'prepare'|'publish'|'restore',...(process.env.ESTIMATE_RECOVERY_PLAN_ID?{planId:process.env.ESTIMATE_RECOVERY_PLAN_ID}:{}),...(process.env.ESTIMATE_RECOVERY_PLAN_DIGEST?{planDigest:process.env.ESTIMATE_RECOVERY_PLAN_DIGEST}:{})});
  status='COMPLETED';console.log(JSON.stringify({contract:'estimate-operational-recovery-result/v1',...result}));
}catch(error){status='BLOCKED';console.error(JSON.stringify({contract:'estimate-operational-recovery-result/v1',status,code:(error instanceof Error?error.message:'UNKNOWN').slice(0,240)}));}
