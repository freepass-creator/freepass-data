import { describe, expect, it, vi } from 'vitest';
import {
  captureIancarOneApi, iancarOneApiConfigFromEnv
} from '../src/adapters/iancar-one-api.js';

const config = {
  baseUrl: 'https://one.example.test',
  apiKey: 'synthetic-key-never-real',
  authHeader: 'x-api-key',
  authPrefix: null,
  snapshotPath: '/v1/snapshot'
};

describe('Iancar ONE API transport', () => {
  it('sends the secret only in the configured header and returns RAW-only evidence', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('https://one.example.test/v1/snapshot');
      expect(init?.redirect).toBe('manual');
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('synthetic-key-never-real');
      expect(JSON.stringify(init)).not.toContain('Authorization');
      return new Response(JSON.stringify({
        snapshotId: 's-1',
        generatedAt: '2026-09-30T13:00:00Z',
        vehicles: [{ plate: '12가3456', monthlyRent: 100 }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await captureIancarOneApi(config, fetcher as typeof fetch, '2026-09-30T13:01:00Z');
    expect(result).toMatchObject({
      sourceRevision: 's-1',
      observedAt: '2026-09-30T13:00:00Z',
      mappingAuthorized: false,
      canonicalWriteAuthorized: false,
      publicationAuthorized: false
    });
    expect(result.responseDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('supports bearer-style auth only when explicitly configured', async () => {
    const fetcher = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-key-never-real');
      return new Response('{"ok":true}', { status: 200 });
    });
    await captureIancarOneApi({ ...config, authHeader: 'Authorization', authPrefix: 'Bearer' }, fetcher as typeof fetch);
  });

  it('rejects redirects, non-json and cross-origin/path tricks', async () => {
    await expect(captureIancarOneApi({ ...config, snapshotPath: '//evil.example/x' }))
      .rejects.toThrow('IANCAR_ONE_API_PATH_NOT_ALLOWED');
    await expect(captureIancarOneApi(config, (async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })) as typeof fetch))
      .rejects.toThrow('IANCAR_ONE_API_REDIRECT_REJECTED');
    await expect(captureIancarOneApi(config, (async () =>
      new Response('<html>no</html>', { status: 200 })) as typeof fetch))
      .rejects.toThrow('IANCAR_ONE_API_NON_JSON_RESPONSE');
  });

  it('requires endpoint and auth contract explicitly; no guessed defaults', () => {
    const parsed = iancarOneApiConfigFromEnv({
      EANCAR_ONE_API_KEY: 'secret-only'
    } as NodeJS.ProcessEnv);
    expect(parsed).toMatchObject({
      apiKey: 'secret-only',
      baseUrl: '',
      authHeader: '',
      snapshotPath: ''
    });
  });
});
