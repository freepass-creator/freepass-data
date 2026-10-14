import { describe, expect, it } from 'vitest';
import { readSheetsUrl } from '../src/infra/shared-sheet-capture-reader.js';

describe('source-engine sheets read over ADC (online runner, no gws)', () => {
  const id = 'A'.repeat(40);
  it('reads spreadsheets.get / values:batchGet with a bearer token, GET only', async () => {
    const seen: Array<{ url: string; method: string | undefined; auth: string | undefined }> = [];
    const fetcher = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), method: init.method, auth: (init.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify({ valueRanges: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?ranges=%27A%27`);
    expect(await readSheetsUrl(url, { fetcher, accessToken: async () => 'synthetic' })).toEqual({ valueRanges: [] });
    expect(seen).toEqual([{ url: String(url), method: 'GET', auth: 'Bearer synthetic' }]);
  });
  it('refuses any other host or API path and maps HTTP errors to codes', async () => {
    const ports = { accessToken: async () => 'synthetic', fetcher: (async () => new Response('', { status: 403 })) as unknown as typeof fetch };
    await expect(readSheetsUrl(new URL('https://example.com/v4/spreadsheets/x'), ports)).rejects.toThrow('SHEETS_URL_UNSUPPORTED');
    await expect(readSheetsUrl(new URL(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`), ports)).rejects.toThrow('SHEETS_URL_UNSUPPORTED');
    await expect(readSheetsUrl(new URL(`https://sheets.googleapis.com/v4/spreadsheets/${id}`), ports)).rejects.toThrow('SHARED_SHEET_HTTP_403');
  });
});
