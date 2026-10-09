import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { captureFromBatchGet, type CaptureDateStats, sharedSheetCaptureRanges, supplierEnteredFromErp5, withSupplements, SHEETS_GRID_META_FIELDS, type SheetsBatchGet, type SheetsGridMeta } from '../adapters/shared-sheet-capture.js';
import type { SupplierEnteredRecord, SheetCorrection } from '../adapters/shared-sheet-source.js';
import { readSheetsBatchGet, readSheetsMetadata } from '../infra/shared-sheet-capture-reader.js';
import { assertCurrentSharedSheetSource, buildSharedSheetBatch, sharedSheetCaptureDigest } from '../adapters/shared-sheet-source.js';
import { captureVehicleMasterSnapshotReadOnly } from './data-access-runtime.js';
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
  if (local && (!get('--from-batchget-serials') || !get('--from-batchget-serials-after'))) throw new Error('SHARED_SHEET_CAPTURE_SERIALS_REQUIRED');
  const json = async (k: string) => (get(k) ? JSON.parse(await readFile(get(k)!, 'utf8')) : undefined);
  const stats: CaptureDateStats = { datesFromSerial: 0 };
  const capture = local
    ? captureFromBatchGet(id, await json('--from-batchget'), await json('--grid-meta'), get('--read-time')!,
      await json('--from-batchget-serials'), await json('--from-batchget-serials-after'), stats)
    : await (async () => {
      const ranges = sharedSheetCaptureRanges();
      // 날짜 칸은 표시 형식이 연도를 숨길 수 있어(입고일자 mm-dd) 실제 값도 읽는다 — 원문 기록에서 연도를 잃지 않는다.
      // 실제 값 → 표시값 → 실제 값 순서로 읽고 앞뒤 실제 값이 같아야 쓴다(그 사이 누가 고쳤으면 멈춤). 사람이 고치는 중이거나
      // 시트 읽기가 일시로 실패하면(시간 초과·429·5xx) 30초 뒤 다시 읽되 세 번까지만, 그래도 안 되면 멈춘다
      // (쓰기 전이라 프리패스 데이터에는 아무것도 쓰이지 않는다).
      const retryable = /^(SHARED_SHEET_CAPTURE_CHANGED_DURING_READ|SHARED_SHEET_CAPTURE_SERIALS_MISMATCH|SHARED_SHEET_READ_UNKNOWN|SHARED_SHEET_RESPONSE_INVALID|SHARED_SHEET_HTTP_(429|500|502|503|504))$/;
      for (let attempt = 1; ; attempt++) {
        try {
          const readTime = new Date().toISOString();
          const meta = await readSheetsMetadata(id, SHEETS_GRID_META_FIELDS) as SheetsGridMeta;
          const before = await readSheetsBatchGet(id, ranges, {}, 'SERIAL') as SheetsBatchGet;
          const shown = await readSheetsBatchGet(id, ranges) as SheetsBatchGet;
          const after = await readSheetsBatchGet(id, ranges, {}, 'SERIAL') as SheetsBatchGet;
          stats.datesFromSerial = 0;
          return captureFromBatchGet(id, shown, meta, readTime, before, after, stats);
        } catch (e) {
          if (attempt >= 3 || !(e instanceof Error) || !retryable.test(e.message)) throw e;
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
  // Offline captures must never quietly reach live Firestore. They remain master-HOLD until supplied by the existing gateway.
  if (!local) {
    sealed.vehicleMasterSnapshot = await captureVehicleMasterSnapshotReadOnly();
    sealed.digest = sharedSheetCaptureDigest(sealed);
  }
  const batch = buildSharedSheetBatch(sealed);
  await writePrivateArtifact(out, sealed);
  console.log(JSON.stringify({ schema: sealed.schema, tabs: sealed.tabs.length, records: batch.records.length,
    supplierEntered: sealed.supplierEntered?.length ?? 0, corrections: sealed.corrections?.length ?? 0,
    datesFromSerial: stats.datesFromSerial,
    readTime: sealed.readTime, digest: sealed.digest }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => {
    // The explicit local evidence importer does not contact legacy supplier sheets.
    if (!process.argv.includes('--from-batchget')) {
      const position = process.argv.indexOf('--spreadsheet');
      assertCurrentSharedSheetSource(position < 0 ? undefined : process.argv[position + 1]);
    }
    return main();
  }).catch(e => { console.error(`SHARED_SHEET_CAPTURE_HOLD ${e instanceof Error && /^[A-Z0-9_]+$/.test(e.message) ? e.message : ''}`.trim()); process.exitCode = 1; });
}
