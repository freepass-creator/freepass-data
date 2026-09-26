import { readFileSync, writeFileSync } from 'node:fs';
import { buildEstimateMasterFromCanonicalVehicleMaster, type EstimateMasterCanonicalBridge } from '../application/estimate-master-canonical.js';
import { createFirestoreVehicleMasterStore } from '../infra/vehicle-master-firestore-store.js';

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

const store = createFirestoreVehicleMasterStore();
const result = await buildEstimateMasterFromCanonicalVehicleMaster(store, { bridge });

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
