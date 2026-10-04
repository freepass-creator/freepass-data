import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { captureFromBatchGet, readSharedSheetCapture } from '../infra/shared-sheet-capture-reader.js';
import { buildSharedSheetBatch } from '../adapters/shared-sheet-source.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

/** Capture the 15-tab shared input sheet into a private capture v1 file. stdout carries counts only (no plates/fees). */
export async function main(args = process.argv.slice(2)) {
  const get = (k: string) => { const i = args.indexOf(k); const v = i >= 0 ? args[i + 1] : undefined; return v && !v.startsWith('--') ? v : undefined; };
  const known = new Set(['--spreadsheet', '--out', '--from-batchget', '--read-time']);
  for (let i = 0; i < args.length; i += 2) if (!known.has(args[i]!) || !get(args[i]!)) throw new Error('INVALID_ARGUMENT');
  const id = get('--spreadsheet'), out = get('--out');
  if (!id || !out) throw new Error('SPREADSHEET_AND_OUT_REQUIRED');
  const local = get('--from-batchget');
  if (local && !get('--read-time')) throw new Error('READ_TIME_REQUIRED_FOR_LOCAL_BATCHGET');
  const capture = local ? captureFromBatchGet(id, JSON.parse(await readFile(local, 'utf8')), get('--read-time')!)
    : await readSharedSheetCapture(id);
  const batch = buildSharedSheetBatch(capture);
  await writePrivateArtifact(out, capture);
  console.log(JSON.stringify({ schema: capture.schema, tabs: capture.tabs.length, records: batch.records.length,
    readTime: capture.readTime, digest: capture.digest }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`SHARED_SHEET_CAPTURE_HOLD ${e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : ''}`.trim()); process.exitCode = 1; });
}
