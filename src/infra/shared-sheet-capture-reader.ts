import { GoogleAuth } from 'google-auth-library';
import { sharedSheetChannels, sharedSheetCaptureDigest, buildSharedSheetBatch, sharedSheetHeaders, type SharedSheetCapture, type SheetCell } from '../adapters/shared-sheet-source.js';
import spec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };

type BatchGet = { spreadsheetId?: string; valueRanges?: Array<{ range?: string; values?: unknown[][] }> };
const WIDTH = sharedSheetHeaders.length;
const LAST_COLUMN = (n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; })(WIDTH);
export const sharedSheetTabs = (): string[] => [...new Set(sharedSheetChannels.map(x => x.tab))];
export const sharedSheetCaptureRanges = () => sharedSheetTabs().map(t => `'${t.replace(/'/g, "''")}'!A1:${LAST_COLUMN}`);

/** Sheets read-only token. An explicit sheets credential file (ERP4 manual step) wins over ADC. No key is created here. */
async function sheetsAccessToken(): Promise<string> {
  try {
    const keyFile = process.env.GOOGLE_SHEETS_APPLICATION_CREDENTIALS;
    const auth = new GoogleAuth({ ...(keyFile ? { keyFile } : {}), scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const token = await auth.getAccessToken();
    if (!token) throw new Error('missing token');
    return token;
  } catch { throw new Error('SHEETS_AUTH_UNAVAILABLE'); }
}

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

export async function readSharedSheetCapture(spreadsheetId: string, ports: { accessToken?: () => Promise<string>;
  fetcher?: typeof fetch; now?: () => string } = {}): Promise<SharedSheetCapture> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)) throw new Error('SHARED_SHEET_ID_INVALID');
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet`);
  for (const r of sharedSheetCaptureRanges()) url.searchParams.append('ranges', r);
  url.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');
  url.searchParams.set('majorDimension', 'ROWS');
  const readTime = (ports.now ?? (() => new Date().toISOString()))();
  const token = await (ports.accessToken ?? sheetsAccessToken)();
  if (!token || /\s/.test(token)) throw new Error('SHEETS_AUTH_UNAVAILABLE');
  let response: Response;
  try {
    response = await (ports.fetcher ?? fetch)(url, { method: 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  } catch { throw new Error('SHARED_SHEET_READ_UNKNOWN'); }
  if (!response.ok) throw new Error(`SHARED_SHEET_HTTP_${response.status}`);
  let raw: BatchGet;
  try { raw = await response.json() as BatchGet; } catch { throw new Error('SHARED_SHEET_RESPONSE_INVALID'); }
  return captureFromBatchGet(spreadsheetId, raw, readTime);
}
