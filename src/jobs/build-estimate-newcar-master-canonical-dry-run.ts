import { readFileSync, writeFileSync } from 'node:fs';
import { buildEstimateMasterFromCanonicalVehicleMaster, type EstimateMasterCanonicalBridge } from '../application/estimate-master-canonical.js';
import { createVehicleMasterJobRuntime } from './data-access-runtime.js';
import { stableDigest } from '../shared/stable-digest.js';

const S = (value: unknown) => String(value ?? '').trim();
const arg = (name: string) => {
  const prefix = `--${name}=`;
  return S(process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length));
};

const bridgePath = arg('bridge');
const outputPath = arg('output');
const bridge: EstimateMasterCanonicalBridge = bridgePath
  ? JSON.parse(readFileSync(bridgePath, 'utf8'))
  : {};

const { access, store } = createVehicleMasterJobRuntime();
const result = await access.read({
  context: {
    actor: { id: 'service:freepass-data-estimate-master-dry-run', kind: 'SERVICE' },
    clientId: 'job:build-estimate-newcar-master-canonical-dry-run',
    purpose: 'derive Estimate master readiness from canonical Vehicle Master'
  },
  operation: 'READ_ESTIMATE_MASTER_CANONICAL_DRY_RUN',
  resource: {
    kind: 'PROJECTION',
    name: 'estimate-newcar-master-canonical-dry-run',
    projectionId: 'estimate-newcar-master'
  },
  requestDigest: stableDigest({ bridge }),
  summarize: (value) => ({
    count: value.summary.total,
    digest: stableDigest(value.records),
    inputDigest: value.summary.inputDigest
  })
}, () => buildEstimateMasterFromCanonicalVehicleMaster(store, { bridge }));

const artifact = {
  contract: 'estimate-newcar-master-canonical-dry-run/v1',
  generatedAt: new Date().toISOString(),
  bridge: bridgePath || null,
  summary: result.summary,
  canonicalInputs: result.canonicalInputs,
  records: result.records,
};

const output = JSON.stringify(artifact, null, 2) + '\n';
if (outputPath) writeFileSync(outputPath, output, 'utf8');

process.stdout.write(JSON.stringify({
  contract: artifact.contract,
  bridge: artifact.bridge,
  summary: artifact.summary,
  output: outputPath || null,
}, null, 2) + '\n');

if (result.summary.active === 0) process.exitCode = 2;
else if (result.summary.hold > 0) process.exitCode = 1;
