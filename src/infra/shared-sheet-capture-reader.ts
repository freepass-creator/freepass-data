import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { GoogleAuth } from 'google-auth-library';

type Ports = { accessToken?: () => Promise<string>; fetcher?: typeof fetch };

/** Sheets read-only token. An explicit sheets credential file (ERP4 manual step) wins over ADC. No key is created here. */
async function sheetsAccessToken(): Promise<string> {
  try {
    const keyFile = process.env.GOOGLE_SHEETS_APPLICATION_CREDENTIALS;
    // Same delegation as data-owned-refresh: the sheet owner (GOOGLE_SHEETS_SUBJECT) is impersonated read-only.
    const subject = process.env.GOOGLE_SHEETS_SUBJECT?.trim();
    // Domain-wide delegation only grants the scope already authorized for that client (the existing refresh uses
    // «spreadsheets»); without delegation the narrower read-only scope is requested. This reader only issues GETs.
    const delegated = Boolean(keyFile && subject);
    const auth = new GoogleAuth({ ...(keyFile ? { keyFile } : {}), ...(keyFile && subject ? { clientOptions: { subject } } : {}),
      scopes: [delegated ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const token = await auth.getAccessToken();
    if (!token) throw new Error('missing token');
    return token;
  } catch { throw new Error('SHEETS_AUTH_UNAVAILABLE'); }
}

const sheetsUrl = (spreadsheetId: string, suffix = '') => {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)) throw new Error('SHARED_SHEET_ID_INVALID');
  return new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${suffix}`);
};

/** 운영 PC 전용 읽기 전송: SHEETS_TRANSPORT=gws 이면 이미 인증된 gws CLI(회사 계정 위임)로 읽는다. 비밀은 건드리지 않는다. */
function sheetsViaGws(url: URL): unknown {
  const m = url.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(\/values:batchGet)?$/);
  if (!m) throw new Error('SHEETS_URL_UNSUPPORTED');
  const params: Record<string, unknown> = { spreadsheetId: m[1] };
  const ranges: string[] = [];
  for (const [k, v] of url.searchParams) { if (k === 'ranges') ranges.push(v); else params[k] = v === 'true' ? true : v; }
  if (ranges.length) params.ranges = ranges;
  const args = m[2] ? ['sheets', 'spreadsheets', 'values', 'batchGet'] : ['sheets', 'spreadsheets', 'get'];
  const bin = process.env.GWS_BIN ?? (() => {
    const where = (execFileSync('where', ['gws.cmd'], { encoding: 'utf8' }).split('\n')[0] ?? '').trim();
    const exe = readFileSync(where, 'utf8').match(/"([^"]+gws\.exe)"/)?.[1];
    if (!exe) throw new Error('SHEETS_TRANSPORT_UNAVAILABLE');
    return exe;
  })();
  const out = execFileSync(bin, [...args, '--params', JSON.stringify(params)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.slice(out.indexOf('{')));
}
async function sheetsGet(url: URL, ports: Ports): Promise<unknown> {
  if (process.env.SHEETS_TRANSPORT === 'gws' && !ports.fetcher && !ports.accessToken) return sheetsViaGws(url);
  const token = await (ports.accessToken ?? sheetsAccessToken)();
  if (!token || /\s/.test(token)) throw new Error('SHEETS_AUTH_UNAVAILABLE');
  let response: Response;
  try {
    response = await (ports.fetcher ?? fetch)(url, { method: 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  } catch { throw new Error('SHARED_SHEET_READ_UNKNOWN'); }
  if (!response.ok) throw new Error(`SHARED_SHEET_HTTP_${response.status}`);
  try { return await response.json(); } catch { throw new Error('SHARED_SHEET_RESPONSE_INVALID'); }
}

/** spreadsheets.get limited to the given metadata fields (grid sizes), no cell data. */
export async function readSheetsMetadata(spreadsheetId: string, fields: string, ports: Ports = {}): Promise<unknown> {
  const url = sheetsUrl(spreadsheetId);
  url.searchParams.set('fields', fields);
  return sheetsGet(url, ports);
}

/** One bearer-authorized values.batchGet over the given ranges. Returns the raw response; conversion lives in adapters.
 * render 'SERIAL' reads the real cell values (dates as serial numbers) — used only to keep the year of date cells whose
 * display format hides it (입고일자 mm-dd). */
export async function readSheetsBatchGet(spreadsheetId: string, ranges: string[], ports: Ports = {}, render: 'FORMATTED' | 'SERIAL' | 'FORMULA' = 'FORMATTED'): Promise<unknown> {
  const url = sheetsUrl(spreadsheetId, '/values:batchGet');
  for (const r of ranges) url.searchParams.append('ranges', r);
  url.searchParams.set('valueRenderOption', render === 'SERIAL' ? 'UNFORMATTED_VALUE' : render === 'FORMULA' ? 'FORMULA' : 'FORMATTED_VALUE');
  if (render === 'SERIAL') url.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');
  url.searchParams.set('majorDimension', 'ROWS');
  return sheetsGet(url, ports);
}
