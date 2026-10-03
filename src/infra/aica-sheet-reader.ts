import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { resolveTargetProject } from './firebase-target.js';
import type { AicaGridBinding, AicaGridObservation, SupplierGridCell } from '../domain/source-intake.js';

export const AICA_GRID_FIELDS = 'spreadsheetId,sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,hyperlink,userEnteredFormat(textFormat(link(uri))),textFormatRuns(startIndex,format(link(uri)))))))';
type GridResponse = { spreadsheetId?: string; sheets?: Array<{ properties?: { sheetId?: number };
  data?: Array<{ startRow?: number; startColumn?: number; rowData?: Array<{ values?: SupplierGridCell[] }> }> }> };

/** Reuse Data's ADC resolution with a Sheets read-only scope. Firebase's default
 * Cloud scopes alone do not authorize Sheets. No new key or second Firebase app.
 * Existing user ADC must already permit this scope; a 403 is HOLD, not re-login.
 */
async function dataGoogleAccessToken(): Promise<string> {
  try {
    const auth = new GoogleAuth({ projectId: resolveTargetProject(),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const token = await auth.getAccessToken();
    if (!token) throw new Error('missing token');
    return token;
  } catch { throw new Error('DATA_GOOGLE_AUTH_UNAVAILABLE'); }
}

export function aicaSheetsGridReader(ports: {
  accessToken?: () => Promise<string>; fetcher?: typeof fetch; now?: () => string;
} = {}): (binding: AicaGridBinding) => Promise<AicaGridObservation> {
  return async binding => {
    // Explicit header-first bounded A1 range. A different slice must get its own reviewed binding.
    const range = /^(?:'((?:[^']|'')+)'|([^'!]+))!A1:([A-Z]+)([1-9]\d*)$/.exec(binding.range);
    if (!range || !binding.sheetId || !Number.isSafeInteger(binding.tabId) || binding.tabId < 0)
      throw new Error('AICA_GRID_RANGE_INVALID');
    const rowLimit = Number(range[4]);
    const columns = [...range[3]!].reduce((count, letter) => count * 26 + letter.charCodeAt(0) - 64, 0);
    if (!Number.isSafeInteger(rowLimit) || rowLimit > 100_000 || columns > 1_000
      || !Number.isSafeInteger(binding.plateColumn) || binding.plateColumn < 0 || binding.plateColumn >= columns)
      throw new Error('AICA_GRID_RANGE_INVALID');
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(binding.sheetId)}`);
    url.searchParams.set('includeGridData', 'true');
    url.searchParams.set('ranges', binding.range);
    url.searchParams.set('fields', AICA_GRID_FIELDS);
    const token = await (ports.accessToken ?? dataGoogleAccessToken)();
    if (!token || /\s/.test(token)) throw new Error('DATA_GOOGLE_AUTH_UNAVAILABLE');
    let response: Response;
    try {
      response = await (ports.fetcher ?? fetch)(url, { method: 'GET', redirect: 'error',
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    } catch { throw new Error('AICA_GRID_READ_UNKNOWN'); }
    if (!response.ok) throw new Error(`AICA_GRID_HTTP_${response.status}`);
    let raw: GridResponse;
    try { raw = await response.json() as GridResponse; } catch { throw new Error('AICA_GRID_RESPONSE_INVALID'); }
    const sheet = raw?.sheets?.[0], grid = sheet?.data?.[0];
    if (raw?.spreadsheetId !== binding.sheetId || raw.sheets?.length !== 1 || sheet?.properties?.sheetId !== binding.tabId
      || sheet.data?.length !== 1 || !grid || (grid.startRow ?? 0) !== 0 || (grid.startColumn ?? 0) !== 0
      || !Array.isArray(grid.rowData) || grid.rowData.length < 1 || grid.rowData.length > rowLimit
      || grid.rowData.some(row => row.values !== undefined && (!Array.isArray(row.values) || row.values.length > columns)))
      throw new Error('AICA_GRID_RESPONSE_INVALID');
    const rows = grid.rowData.map(row => structuredClone(row.values ?? []));
    const headers = rows.shift()!;
    if (headers.length <= binding.plateColumn) throw new Error('AICA_GRID_HEADER_MISSING');
    const revision = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
    return { ...binding, firstDataRow: 1, headers, rows, revision,
      observedAt: (ports.now ?? (() => new Date().toISOString()))(),
      // API read success is not proof of full inventory, supplier freshness or trailing blanks.
      complete: false, expectedRows: null };
  };
}
