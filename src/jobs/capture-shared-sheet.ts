import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { captureFromBatchGet, type CaptureDateStats, sharedSheetCaptureRanges, supplierEnteredFromErp5, withSupplements, SHEETS_GRID_META_FIELDS, type SheetsBatchGet, type SheetsGridMeta } from '../adapters/shared-sheet-capture.js';
import type { SupplierEnteredRecord, SheetCorrection } from '../adapters/shared-sheet-source.js';
import { readSheetsBatchGet, readSheetsMetadata } from '../infra/shared-sheet-capture-reader.js';
import { buildSharedSheetBatch } from '../adapters/shared-sheet-source.js';
import { writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

/** Capture the 15-tab shared input sheet into a private capture v1 file. stdout carries counts only (no plates/fees). */
export async function main(args = process.argv.slice(2)) {
  const get = (k: string) => { const i = args.indexOf(k); const v = i >= 0 ? args[i + 1] : undefined; return v && !v.startsWith('--') ? v : undefined; };
  const known = new Set(['--spreadsheet', '--out', '--from-batchget', '--from-batchget-serials', '--from-batchget-serials-after', '--grid-meta', '--read-time', '--erp5-capture', '--supplement']);
  for (let i = 0; i < args.length; i += 2) if (!known.has(args[i]!) || !get(args[i]!)) throw new Error('INVALID_ARGUMENT');
  const id = get('--spreadsheet'), out = get('--out');
  if (!id || !out) throw new Error('SPREADSHEET_AND_OUT_REQUIRED');
  const local = get('--from-batchget');
  if (local && (!get('--read-time') || !get('--grid-meta'))) throw new Error('READ_TIME_AND_GRID_META_REQUIRED_FOR_LOCAL_BATCHGET');
  const json = async (k: string) => (get(k) ? JSON.parse(await readFile(get(k)!, 'utf8')) : undefined);
  const stats: CaptureDateStats = { datesFromSerial: 0 };
  const capture = local
    ? captureFromBatchGet(id, await json('--from-batchget'), await json('--grid-meta'), get('--read-time')!,
      await json('--from-batchget-serials'), await json('--from-batchget-serials-after'), stats)
    : await (async () => {
      const meta = await readSheetsMetadata(id, SHEETS_GRID_META_FIELDS) as SheetsGridMeta;
      const ranges = sharedSheetCaptureRanges();
      // 날짜 칸은 표시 형식이 연도를 숨길 수 있어(입고일자 mm-dd) 실제 값도 읽는다 — 원문 기록에서 연도를 잃지 않는다.
      // 실제 값 → 표시값 → 실제 값 순서로 읽고 앞뒤 실제 값이 같아야 쓴다(그 사이 누가 고쳤으면 멈춤). 사람이 고치는 중이면
      // 잠시 뒤 다시 읽되 세 번까지만, 그래도 다르면 멈춘다(쓰기 전이라 프리패스 데이터에는 아무것도 쓰이지 않는다).
      for (let attempt = 1; ; attempt++) {
        const readTime = new Date().toISOString();
        const before = await readSheetsBatchGet(id, ranges, {}, 'SERIAL') as SheetsBatchGet;
        const shown = await readSheetsBatchGet(id, ranges) as SheetsBatchGet;
        const after = await readSheetsBatchGet(id, ranges, {}, 'SERIAL') as SheetsBatchGet;
        try { stats.datesFromSerial = 0; return captureFromBatchGet(id, shown, meta, readTime, before, after, stats); } catch (e) {
          if (attempt >= 3 || !(e instanceof Error) || !['SHARED_SHEET_CAPTURE_CHANGED_DURING_READ', 'SHARED_SHEET_CAPTURE_SERIALS_MISMATCH'].includes(e.message)) throw e;
          await new Promise(r => setTimeout(r, 30_000));
        }
      }
    })();
  // Layer ②: products.원문 from an existing ERP5 capture, plus a reviewed supplement (sheet backup rows · correction history).
  const erp5 = get('--erp5-capture'), supplementPath = get('--supplement');
  const supplement = supplementPath ? JSON.parse(await readFile(supplementPath, 'utf8')) as { supplierEntered?: SupplierEnteredRecord[]; corrections?: SheetCorrection[] } : {};
  const fromErp5 = erp5 ? supplierEnteredFromErp5(JSON.parse(await readFile(erp5, 'utf8'))) : [];
  const covered = new Set(fromErp5.map(x => `${x.supplierCode}|${x.plate}`));
  const sealed = erp5 || supplementPath ? withSupplements(capture,
    [...fromErp5, ...(supplement.supplierEntered ?? []).filter(x => !covered.has(`${x.supplierCode}|${x.plate}`))], supplement.corrections ?? []) : capture;
  const batch = buildSharedSheetBatch(sealed);
  await writePrivateArtifact(out, sealed);
  console.log(JSON.stringify({ schema: sealed.schema, tabs: sealed.tabs.length, records: batch.records.length,
    supplierEntered: sealed.supplierEntered?.length ?? 0, corrections: sealed.corrections?.length ?? 0,
    datesFromSerial: stats.datesFromSerial,
    readTime: sealed.readTime, digest: sealed.digest }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`SHARED_SHEET_CAPTURE_HOLD ${e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : ''}`.trim()); process.exitCode = 1; });
}
