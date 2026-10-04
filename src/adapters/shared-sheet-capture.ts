import { sharedSheetChannels, sharedSheetCaptureDigest, buildSharedSheetBatch, sharedSheetHeaders, type SharedSheetCapture, type SheetCell,
  type SupplierEnteredRecord, type SheetCorrection } from './shared-sheet-source.js';
import { decodeErp5Value, inspectErp5Capture, type Erp5SourceCapture } from './erp5-source-capture.js';
import { plateIdentityKey, isAssignedPlate } from '../domain/vehicle-plate.js';
import { stableDigest } from '../shared/stable-digest.js';
import spec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };

export type SheetsBatchGet = { spreadsheetId?: string; valueRanges?: Array<{ range?: string; values?: unknown[][] }> };
/** spreadsheets.get?fields=… — the tab grid sizes that prove each returned range covered the whole tab. */
export type SheetsGridMeta = { spreadsheetId?: string; sheets?: Array<{ properties?: { title?: string; gridProperties?: { rowCount?: number } } }> };
export const SHEETS_GRID_META_FIELDS = 'spreadsheetId,sheets.properties(title,gridProperties(rowCount))';
const WIDTH = sharedSheetHeaders.length;
const LAST_COLUMN = (n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; })(WIDTH);
export const sharedSheetTabs = (): string[] => [...new Set(sharedSheetChannels.map(x => x.tab))];
export const sharedSheetCaptureRanges = () => sharedSheetTabs().map(t => `'${t.replace(/'/g, "''")}'!A1:${LAST_COLUMN}`);

/** One values.batchGet response → validated capture v1. Rows are padded to the 74-column contract, blank rows kept. */
export function captureFromBatchGet(spreadsheetId: string, raw: SheetsBatchGet, meta: SheetsGridMeta, readTime: string): SharedSheetCapture {
  const tabs = sharedSheetTabs();
  if (raw?.spreadsheetId !== spreadsheetId || meta?.spreadsheetId !== spreadsheetId) throw new Error('SHARED_SHEET_CAPTURE_WRONG_SPREADSHEET');
  if (!Array.isArray(raw?.valueRanges) || raw.valueRanges.length !== tabs.length) throw new Error('SHARED_SHEET_CAPTURE_INCOMPLETE');
  // complete:true is only claimed when each returned range is exactly A1:<last column><full grid rows> of the expected tab, in order.
  const gridRows = new Map((meta.sheets ?? []).map(x => [x.properties?.title, x.properties?.gridProperties?.rowCount]));
  raw.valueRanges.forEach((r, i) => {
    const m = /^(?:'((?:[^']|'')+)'|([^'!]+))!A1:([A-Z]+)(\d+)$/.exec(r?.range ?? '');
    const title = m ? (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]) : undefined;
    const rows = gridRows.get(tabs[i]);
    if (!m || title !== tabs[i] || m[3] !== LAST_COLUMN || typeof rows !== 'number' || !Number.isSafeInteger(rows) ||
        Number(m[4]) !== rows || (r.values ?? []).length > rows) throw new Error('SHARED_SHEET_CAPTURE_RANGE_MISMATCH');
  });
  const cell = (v: unknown): SheetCell => v === null || v === undefined ? '' :
    typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? v : (() => { throw new Error('SHARED_SHEET_CAPTURE_CELL_INVALID'); })();
  const capture: SharedSheetCapture = { schema: 'shared-sheet-capture/v1', spreadsheetId, layoutVersion: spec.layoutVersion, readTime,
    tabs: raw.valueRanges.map((range, i) => {
      const values = (range.values ?? []).map(row => {
        if (!Array.isArray(row) || row.length > WIDTH) throw new Error('SHARED_SHEET_CAPTURE_ROW_INVALID');
        return Array.from({ length: WIDTH }, (_, c) => cell(row[c]));
      });
      return { title: tabs[i]!, readTime, complete: true as const, rowCount: values.length, values };
    }) };
  capture.digest = sharedSheetCaptureDigest(capture);
  buildSharedSheetBatch(capture); // fail closed: header, tabs, widths, identities
  return capture;
}

/** Layer ②: products.원문 (written by the supplier-sheet collectors, never by the shared sheet) per plate, from an existing
 * verified ERP5 capture. Plates whose products disagree on 원문 are left out rather than guessed. */
export function supplierEnteredFromErp5(capture: Erp5SourceCapture): SupplierEnteredRecord[] {
  inspectErp5Capture(capture);
  const byPlate = new Map<string, SupplierEnteredRecord | null>();
  for (const doc of capture.collections.products.documents as Array<{ name?: string; fields?: Record<string, unknown> }>) {
    let plate: unknown, text: unknown;
    try { plate = decodeErp5Value(doc.fields?.car_number ?? { nullValue: null }); text = decodeErp5Value(doc.fields?.['원문'] ?? { nullValue: null }); }
    catch { continue; }
    if (!isAssignedPlate(plate) || !text || typeof text !== 'object' || Array.isArray(text)) continue;
    const key = plateIdentityKey(plate);
    const record: SupplierEnteredRecord = { plate: key, source: 'ERP5_PRODUCTS_SOURCE_TEXT', sourceRef: String(doc.name ?? '').split('/').pop() ?? '',
      observedAt: capture.readTime, values: text as Record<string, unknown> };
    const seen = byPlate.get(key);
    byPlate.set(key, seen === undefined ? record : seen && stableDigest(seen.values) === stableDigest(record.values) ? seen : null);
  }
  return [...byPlate.values()].filter((x): x is SupplierEnteredRecord => x !== null).sort((a, b) => a.plate.localeCompare(b.plate));
}
/** Merge supplements into a capture and re-seal its digest. Sheet plates without a products record may come from a backup. */
export function withSupplements(capture: SharedSheetCapture, supplierEntered: SupplierEnteredRecord[], corrections: SheetCorrection[]): SharedSheetCapture {
  const sheetPlates = new Set(capture.tabs.flatMap(t => t.values.slice(1).map(r => isAssignedPlate(r[4]) ? plateIdentityKey(r[4]) : '')).filter(Boolean));
  const keep = supplierEntered.filter(x => sheetPlates.has(plateIdentityKey(x.plate)));
  const out: SharedSheetCapture = { ...structuredClone(capture), ...(keep.length ? { supplierEntered: keep } : {}),
    ...(corrections.length ? { corrections: corrections.filter(x => sheetPlates.has(plateIdentityKey(x.plate))) } : {}) };
  delete out.digest;
  out.digest = sharedSheetCaptureDigest(out);
  buildSharedSheetBatch(out);
  return out;
}
