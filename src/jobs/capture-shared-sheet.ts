import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { captureFromBatchGet, sharedSheetCaptureRanges, supplierEnteredFromErp5, withSupplements, SHEETS_GRID_META_FIELDS, type SheetsBatchGet, type SheetsGridMeta } from '../adapters/shared-sheet-capture.js';
import type { SupplierEnteredRecord, SheetCorrection } from '../adapters/shared-sheet-source.js';
import { readSheetsBatchGet, readSheetsMetadata } from '../infra/shared-sheet-capture-reader.js';
import { buildSharedSheetBatch } from '../adapters/shared-sheet-source.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

/** Capture the 15-tab shared input sheet into a private capture v1 file. stdout carries counts only (no plates/fees). */
export async function main(args = process.argv.slice(2)) {
  const get = (k: string) => { const i = args.indexOf(k); const v = i >= 0 ? args[i + 1] : undefined; return v && !v.startsWith('--') ? v : undefined; };
  const known = new Set(['--spreadsheet', '--out', '--from-batchget', '--grid-meta', '--read-time', '--erp5-capture', '--supplement']);
  for (let i = 0; i < args.length; i += 2) if (!known.has(args[i]!) || !get(args[i]!)) throw new Error('INVALID_ARGUMENT');
  const id = get('--spreadsheet'), out = get('--out');
  if (!id || !out) throw new Error('SPREADSHEET_AND_OUT_REQUIRED');
  const local = get('--from-batchget');
  if (local && (!get('--read-time') || !get('--grid-meta'))) throw new Error('READ_TIME_AND_GRID_META_REQUIRED_FOR_LOCAL_BATCHGET');
  const capture = local
    ? captureFromBatchGet(id, JSON.parse(await readFile(local, 'utf8')), JSON.parse(await readFile(get('--grid-meta')!, 'utf8')), get('--read-time')!)
    : await (async () => {
      const readTime = new Date().toISOString();
      const meta = await readSheetsMetadata(id, SHEETS_GRID_META_FIELDS) as SheetsGridMeta;
      return captureFromBatchGet(id, await readSheetsBatchGet(id, sharedSheetCaptureRanges()) as SheetsBatchGet, meta, readTime);
    })();
  // Layer ②: products.원문 from an existing ERP5 capture, plus a reviewed supplement (sheet backup rows · correction history).
  const erp5 = get('--erp5-capture'), supplementPath = get('--supplement');
  const supplement = supplementPath ? JSON.parse(await readFile(supplementPath, 'utf8')) as { supplierEntered?: SupplierEnteredRecord[]; corrections?: SheetCorrection[] } : {};
  const fromErp5 = erp5 ? supplierEnteredFromErp5(JSON.parse(await readFile(erp5, 'utf8'))) : [];
  const covered = new Set(fromErp5.map(x => x.plate));
  const sealed = erp5 || supplementPath ? withSupplements(capture,
    [...fromErp5, ...(supplement.supplierEntered ?? []).filter(x => !covered.has(x.plate))], supplement.corrections ?? []) : capture;
  const batch = buildSharedSheetBatch(sealed);
  await writePrivateArtifact(out, sealed);
  console.log(JSON.stringify({ schema: sealed.schema, tabs: sealed.tabs.length, records: batch.records.length,
    supplierEntered: sealed.supplierEntered?.length ?? 0, corrections: sealed.corrections?.length ?? 0,
    readTime: sealed.readTime, digest: sealed.digest }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`SHARED_SHEET_CAPTURE_HOLD ${e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : ''}`.trim()); process.exitCode = 1; });
}
