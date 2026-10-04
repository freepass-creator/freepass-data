import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildVehicleIdentityInputs, f03SnapshotFromBatchGet, verifiedErp5CaptureFromJson, F03_RANGES, F03_SPREADSHEET_ID } from '../adapters/vehicle-identity-inputs.js';
import { readSheetsBatchGet } from '../infra/shared-sheet-capture-reader.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

/** F03 snapshot + ERP5 products capture → private vehicle-identity inputs for `ingest:shared-sheet-canonical --identity-inputs`.
 * stdout carries counts and digests only (no plates, names or fees). */
export async function main(args = process.argv.slice(2)) {
  const known = new Set(['--erp5-capture', '--f03-batchget', '--f03-read-time', '--out']);
  const get = (k: string) => { const i = args.indexOf(k); const v = i >= 0 ? args[i + 1] : undefined; return v && !v.startsWith('--') ? v : undefined; };
  for (let i = 0; i < args.length; i += 2) if (!known.has(args[i]!) || !get(args[i]!)) throw new Error('INVALID_ARGUMENT');
  const erp5 = get('--erp5-capture'), out = get('--out');
  if (!erp5 || !out) throw new Error('ERP5_CAPTURE_AND_OUT_REQUIRED');
  const capture = verifiedErp5CaptureFromJson(JSON.parse(await readFile(erp5, 'utf8')));
  const local = get('--f03-batchget');
  if (local && !get('--f03-read-time')) throw new Error('F03_READ_TIME_REQUIRED_FOR_LOCAL_BATCHGET');
  const f03ReadAt = local ? get('--f03-read-time')! : new Date().toISOString();
  const raw = local ? JSON.parse(await readFile(local, 'utf8')) : await readSheetsBatchGet(F03_SPREADSHEET_ID, [...F03_RANGES]);
  const inputs = buildVehicleIdentityInputs(f03SnapshotFromBatchGet(raw as Parameters<typeof f03SnapshotFromBatchGet>[0]), f03ReadAt, capture);
  await writePrivateArtifact(out, inputs);
  console.log(JSON.stringify({ schema: inputs.schema, f03Rows: inputs.f03.rows.length, f03Aliases: inputs.f03.aliases.length,
    dataPlates: inputs.data.length, f03Digest: inputs.f03Digest, dataDigest: inputs.dataDigest }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`VEHICLE_IDENTITY_INPUTS_HOLD ${e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : ''}`.trim()); process.exitCode = 1; });
}
