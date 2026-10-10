import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { resolveTargetProject } from './firebase-target.js';
import type { AicaGridBinding, AicaGridObservation, SupplierGridCell } from '../domain/source-intake.js';

export const AICA_GRID_FIELDS = 'spreadsheetId,sheets(properties(sheetId),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,formattedValue,hyperlink,userEnteredFormat(textFormat(link(uri))),textFormatRuns(startIndex,format(link(uri)))))))';
const metadataFields = 'spreadsheetId,sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)))';
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
  /** Explicit opt-in: proves only the bound whole tab, never all supplier inventory. */
  verifyBoundTab?: boolean;
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
    const observedAt = (ports.now ?? (() => new Date().toISOString()))();
    const get = async (target: URL): Promise<unknown> => {
      let response: Response;
      try {
        response = await (ports.fetcher ?? fetch)(target, { method: 'GET', redirect: 'error',
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      } catch { throw new Error('AICA_GRID_READ_UNKNOWN'); }
      if (!response.ok) throw new Error(`AICA_GRID_HTTP_${response.status}`);
      try { return await response.json(); } catch { throw new Error('AICA_GRID_RESPONSE_INVALID'); }
    };
    const metadataUrl = new URL(url);
    metadataUrl.search = '';
    metadataUrl.searchParams.set('fields', metadataFields);
    const readBoundMetadata = async () => {
      const value = await get(metadataUrl) as { spreadsheetId?: string; sheets?: Array<{ properties?: {
        sheetId?: number; title?: string; hidden?: boolean; gridProperties?: { rowCount?: number; columnCount?: number };
      } }> };
      const matches = value?.sheets?.filter(item => item.properties?.sheetId === binding.tabId);
      const p = matches?.[0]?.properties;
      const title = (range[1] ?? range[2]!).replace(/''/g, "'");
      if (value?.spreadsheetId !== binding.sheetId || matches?.length !== 1 || !p || p.title !== title
        || p.hidden === true || !Number.isSafeInteger(p.gridProperties?.rowCount)
        || !Number.isSafeInteger(p.gridProperties?.columnCount)
        || p.gridProperties!.rowCount !== rowLimit || p.gridProperties!.columnCount !== columns)
        throw new Error('AICA_BOUND_TAB_COVERAGE_UNVERIFIED');
      return p;
    };
    const before = ports.verifyBoundTab ? await readBoundMetadata() : null;
    const raw = await get(url) as GridResponse;
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
    if (ports.verifyBoundTab) {
      // A second read is evidence comparison, not a retry after an ambiguous failure.
      const repeated = await get(url);
      const after = await readBoundMetadata();
      if (JSON.stringify(before) !== JSON.stringify(after)
        || revision !== createHash('sha256').update(JSON.stringify(repeated)).digest('hex'))
        throw new Error('AICA_GRID_CHANGED_DURING_CAPTURE');
    }
    return { ...binding, firstDataRow: 1, headers, rows, revision,
      observedAt,
      // Optional proof is bounded-tab coverage only: never supplier modification time or all inventory.
      complete: ports.verifyBoundTab === true, expectedRows: ports.verifyBoundTab ? rows.length : null };
  };
}
