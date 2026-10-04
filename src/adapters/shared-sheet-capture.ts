import { sharedSheetChannels, sharedSheetCaptureDigest, buildSharedSheetBatch, sharedSheetHeaders, type SharedSheetCapture, type SheetCell } from './shared-sheet-source.js';
import spec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };

export type SheetsBatchGet = { spreadsheetId?: string; valueRanges?: Array<{ range?: string; values?: unknown[][] }> };
type BatchGet = SheetsBatchGet;
const WIDTH = sharedSheetHeaders.length;
const LAST_COLUMN = (n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; })(WIDTH);
export const sharedSheetTabs = (): string[] => [...new Set(sharedSheetChannels.map(x => x.tab))];
export const sharedSheetCaptureRanges = () => sharedSheetTabs().map(t => `'${t.replace(/'/g, "''")}'!A1:${LAST_COLUMN}`);

/** One values.batchGet response → validated capture v1. Rows are padded to the 74-column contract, blank rows kept. */
export function captureFromBatchGet(spreadsheetId: string, raw: BatchGet, readTime: string): SharedSheetCapture {
  const tabs = sharedSheetTabs();
  if (raw?.spreadsheetId !== undefined && raw.spreadsheetId !== spreadsheetId) throw new Error('SHARED_SHEET_CAPTURE_WRONG_SPREADSHEET');
  if (!Array.isArray(raw?.valueRanges) || raw.valueRanges.length !== tabs.length) throw new Error('SHARED_SHEET_CAPTURE_INCOMPLETE');
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

