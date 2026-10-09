import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildVehicleIdentityInputs, verifiedErp5CaptureFromJson, type VehicleMasterSnapshot } from '../adapters/vehicle-identity-inputs.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';
/** Reuses the sealed Data snapshot supplied by the audited collector; never reads F03. */
export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--erp5-capture', '--master-snapshot', '--out']), values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('INVALID_ARGUMENT');
    values.set(key, value);
  }
  if (values.size !== 3) throw new Error('ERP5_CAPTURE_MASTER_SNAPSHOT_AND_OUT_REQUIRED');
  const capture = verifiedErp5CaptureFromJson(JSON.parse(await readFile(values.get('--erp5-capture')!, 'utf8')));
  const master = JSON.parse(await readFile(values.get('--master-snapshot')!, 'utf8')) as VehicleMasterSnapshot;
  const inputs = buildVehicleIdentityInputs(master, capture);
  await writePrivateArtifact(values.get('--out')!, inputs);
  console.log(JSON.stringify({ schema: inputs.schema, masterDigest: inputs.master.digest,
    dataPlates: inputs.data.length, dataDigest: inputs.dataDigest }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('VEHICLE_IDENTITY_INPUTS_HOLD'); process.exitCode = 1; });
}
