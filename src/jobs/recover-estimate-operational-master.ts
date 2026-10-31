import { createEstimateOperationalRecoveryRuntime } from './data-access-runtime.js';
const mode=process.env.ESTIMATE_RECOVERY_MODE;
if(!['inspect','prepare','publish','restore'].includes(mode||''))throw new Error('ESTIMATE_RECOVERY_MODE_REQUIRED');
if(process.env.NODE_ENV!=='production'||process.env.FIREBASE_PROJECT_ID!=='freepasserp5'||process.env.FREEPASS_DATA_DRIVER!=='firestore')throw new Error('ESTIMATE_RECOVERY_EXACT_PRODUCTION_TARGET_REQUIRED');
try {
  const result=await createEstimateOperationalRecoveryRuntime().run({mode:mode as 'inspect'|'prepare'|'publish'|'restore',...(process.env.ESTIMATE_RECOVERY_PLAN_ID?{planId:process.env.ESTIMATE_RECOVERY_PLAN_ID}:{}),...(process.env.ESTIMATE_RECOVERY_PLAN_DIGEST?{planDigest:process.env.ESTIMATE_RECOVERY_PLAN_DIGEST}:{})});
  console.log(JSON.stringify({contract:'estimate-operational-recovery-result/v1',...result}));
} catch(error) {
  const code=error instanceof Error?error.message:'UNKNOWN';
  console.error(JSON.stringify({contract:'estimate-operational-recovery-result/v1',status:'BLOCKED',code:code.slice(0,240)}));
  process.exitCode=1;
}
