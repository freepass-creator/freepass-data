import { readFileSync } from 'node:fs';
import { createVehicleMasterReadOnlyDataAccessRuntime } from './data-access-runtime.js';
import { assessEstimateMasterReadiness } from '../application/estimate-master-readiness.js';
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
const build = await runtime.estimateMasterReadiness(bridge);
const result = assessEstimateMasterReadiness(build);

process.stdout.write(JSON.stringify({
  ...result,
  bridgeConfigured: Boolean(bridgePath),
  bridgePath: bridgePath || null,
}, null, 2) + '\n');

if (result.status !== 'READY') process.exitCode = 2;
