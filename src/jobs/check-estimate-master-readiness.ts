import { readFileSync } from 'node:fs';
import { createVehicleMasterReadOnlyDataAccessRuntime } from './data-access-runtime.js';
import type { EstimateMasterCanonicalBridge } from '../application/estimate-master-canonical.js';

const S = (value: unknown) => String(value ?? '').trim();
const arg = (name: string) => {
  const prefix = `--${name}=`;
  return S(process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length));
};

const scheduledReadOnly = process.argv.includes('--scheduled-read-only');
if (!scheduledReadOnly) {
  throw new Error('ESTIMATE_MASTER_READINESS_READ_ONLY_MODE_REQUIRED');
}

const accessToken = S(process.env.FREEPASS_ERP5_READ_ACCESS_TOKEN);
const evidenceBucket = S(process.env.EVIDENCE_BUCKET);
if (!accessToken) throw new Error('FREEPASS_ERP5_READ_ACCESS_TOKEN is required');
if (!evidenceBucket) throw new Error('EVIDENCE_BUCKET is required');

const bridgePath = arg('bridge');
const bridge: EstimateMasterCanonicalBridge = bridgePath
  ? JSON.parse(readFileSync(bridgePath, 'utf8'))
  : {};

const runtime = createVehicleMasterReadOnlyDataAccessRuntime({
  accessToken,
  evidenceBucket,
});
// The production SSOT explicitly remains vehicle_master + vehicle_trim_master.
// Empty future graph nodes are not evidence that the operating master is empty.
const operationalSource = await runtime.operationalEstimateReadiness({includeIdentityReview:process.argv.includes('--identity-review')});
const result = {
  contractVersion:'estimate-master-readiness-v1', schemaVersion:'1.0.0',
  status:'BLOCKED', generatedAt:new Date().toISOString(), projectionId:'estimate-newcar-master',
  activeReleaseAuthorized:false, publicationImplemented:false,
  counts:{total:operationalSource.counts.products,active:0,hold:operationalSource.counts.products},activeRate:0,
  inputDigest:operationalSource.inputDigest,
  blockers:['ESTIMATE_RELEASE_NOT_PUBLISHED', ...operationalSource.holdReasons.map(row=>row.reason)],
  holdReasons:operationalSource.holdReasons,
  operationalSource,
};

process.stdout.write(JSON.stringify({
  ...result,
  bridgeConfigured: Boolean(bridgePath),
  bridgePath: bridgePath || null,
}, null, 2) + '\n');

if (result.status !== 'READY') process.exitCode = 2;
