import { GoogleAuth } from 'google-auth-library';

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

/** One bearer-authorized values.batchGet over the given ranges. Returns the raw response; conversion lives in adapters. */
export async function readSheetsBatchGet(spreadsheetId: string, ranges: string[], ports: { accessToken?: () => Promise<string>;
  fetcher?: typeof fetch } = {}): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spreadsheetId)) throw new Error('SHARED_SHEET_ID_INVALID');
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet`);
  for (const r of ranges) url.searchParams.append('ranges', r);
  url.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');
  url.searchParams.set('majorDimension', 'ROWS');
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
