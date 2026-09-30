import { describe, expect, it, vi } from 'vitest';
import {
  buildIancarOneSourceBatch,
  collectIancarOneVehicleList,
  createIancarOneApiClient,
  IANCAR_ONE_API_ORIGIN,
  IancarOneApiError,
  iancarOneApiConfigFromEnv,
  summarizeJsonShape
} from '../src/adapters/iancar-one-api.js';

const config = {
  baseUrl: IANCAR_ONE_API_ORIGIN,
  apiKey: 'synthetic-key-never-real'
};

const vehicle = (id: string, extra: Record<string, unknown> = {}) => ({
  vehicle_id: id,
  plate: `plate-${id}`,
  availability: 'AVAILABLE',
  manufacturer: '현대',
  monthly_rate: null,
  ...extra
});

const page = (input: {
  page: number;
  total: number;
  data: Array<Record<string, unknown>>;
  syncedAt?: string;
  stale?: boolean;
}) => ({
  success: true,
  data: input.data,
  pagination: { page: input.page, page_size: 100, total: input.total },
  synced_at: input.syncedAt ?? '2026-10-01T00:00:00.000Z',
  stale: input.stale ?? false
});

describe('EANCAR ONE official partner API', () => {
  it('uses the verified Bearer scheme and /v1/vehicles contract', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('https://eancarone.com/v1/vehicles?page=1&page_size=100');
      expect((init?.headers as Record<string, string>).Authorization)
        .toBe('Bearer synthetic-key-never-real');
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('manual');
      return new Response(JSON.stringify(page({ page: 1, total: 1, data: [vehicle('v1')] })), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });

    const capture = await collectIancarOneVehicleList(
      config,
      fetcher as typeof fetch,
      '2026-10-01T00:01:00.000Z'
    );

    expect(capture).toMatchObject({
      total: 1,
      pages: 1,
      syncedAt: '2026-10-01T00:00:00.000Z',
      stale: false,
      readyForRawIngest: true,
      issues: []
    });
    expect(capture.records[0]?.vehicleId).toBe('v1');
    expect(capture.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('collects every page and binds completeness to exact total', async () => {
    const firstData = Array.from({ length: 100 }, (_, index) => vehicle(`v${index + 1}`));
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const n = Number(url.searchParams.get('page'));
      return new Response(JSON.stringify(n === 1
        ? page({ page: 1, total: 101, data: firstData })
        : page({ page: 2, total: 101, data: [vehicle('v101')] })), { status: 200 });
    });

    const capture = await collectIancarOneVehicleList(config, fetcher as typeof fetch);
    expect(capture).toMatchObject({ total: 101, pages: 2, readyForRawIngest: true });
    expect(capture.records).toHaveLength(101);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const batch = buildIancarOneSourceBatch(capture);
    expect(batch.coverage).toMatchObject({ mode: 'FULL', completeness: 'COMPLETE' });
    expect(batch.records).toHaveLength(101);
    expect(batch.records[0]?.payload).toHaveProperty('sourceSystem', 'EANCAR_ONE');
  });

  it('HOLDs stale provider snapshots instead of publishing previous sales facts as current', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(page({
      page: 1,
      total: 1,
      data: [vehicle('v1')],
      stale: true
    })), { status: 200 }));

    const capture = await collectIancarOneVehicleList(config, fetcher as typeof fetch);
    expect(capture.readyForRawIngest).toBe(false);
    expect(capture.issues).toContain('IANCAR_ONE_SOURCE_STALE');
    expect(buildIancarOneSourceBatch(capture).coverage)
      .toMatchObject({ mode: 'PARTIAL', completeness: 'INCOMPLETE' });
  });

  it('HOLDs a non-atomic refresh when synced_at changes during pagination', async () => {
    const firstData = Array.from({ length: 100 }, (_, index) => vehicle(`v${index + 1}`));
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const n = Number(new URL(String(input)).searchParams.get('page'));
      return new Response(JSON.stringify(n === 1
        ? page({ page: 1, total: 101, data: firstData, syncedAt: '2026-10-01T00:00:00Z' })
        : page({ page: 2, total: 101, data: [vehicle('v101')], syncedAt: '2026-10-01T00:15:00Z' })
      ), { status: 200 });
    });

    const capture = await collectIancarOneVehicleList(config, fetcher as typeof fetch);
    expect(capture.readyForRawIngest).toBe(false);
    expect(capture.issues).toContain('IANCAR_ONE_SYNC_TIME_DRIFT');
  });

  it('rejects duplicate or missing provider-stable vehicle_id values', async () => {
    const duplicate = vi.fn(async () => new Response(JSON.stringify(page({
      page: 1, total: 2, data: [vehicle('v1'), vehicle('v1')]
    })), { status: 200 }));
    await expect(collectIancarOneVehicleList(config, duplicate as typeof fetch))
      .rejects.toThrow('DUPLICATE_IANCAR_ONE_VEHICLE_ID');

    const missing = vi.fn(async () => new Response(JSON.stringify(page({
      page: 1, total: 1, data: [{ plate: '12가3456' }]
    })), { status: 200 }));
    await expect(collectIancarOneVehicleList(config, missing as typeof fetch))
      .rejects.toThrow('IANCAR_ONE_VEHICLE_ID_REQUIRED');
  });

  it('keeps null provider facts as null and never turns them into zero or unavailable', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(page({
      page: 1,
      total: 1,
      data: [vehicle('v1', { deposit: null, available_from: null })]
    })), { status: 200 }));

    const capture = await collectIancarOneVehicleList(config, fetcher as typeof fetch);
    const source = capture.records[0]?.payload;
    expect(source?.deposit).toBeNull();
    expect(source?.available_from).toBeNull();
    const batch = buildIancarOneSourceBatch(capture);
    const raw = batch.records[0]?.payload.source as Record<string, unknown>;
    expect(raw.deposit).toBeNull();
  });

  it('exposes official detail, availability, rates and authenticated photo paths', async () => {
    const called: string[] = [];
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      called.push(url.pathname);
      expect((init?.headers as Record<string, string>).Authorization)
        .toBe('Bearer synthetic-key-never-real');
      if (url.pathname.includes('/photos/')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200, headers: { 'content-type': 'image/jpeg' }
        });
      }
      return new Response('{"success":true,"data":{}}', { status: 200 });
    });

    const client = createIancarOneApiClient(config, fetcher as typeof fetch);
    await client.getVehicle('veh 1');
    await client.getAvailability('veh 1');
    await client.getRates('veh 1');
    const photo = await client.getPhoto('veh 1', 'photo/1');

    expect(photo.status).toBe(200);
    expect(called).toEqual([
      '/v1/vehicles/veh%201',
      '/v1/vehicles/veh%201/availability',
      '/v1/vehicles/veh%201/rates',
      '/v1/vehicles/veh%201/photos/photo%2F1'
    ]);
  });

  it('returns safe HTTP metadata without exposing the credential on API errors', async () => {
    const fetcher = vi.fn(async () => new Response(
      '{"success":false,"code":"RATE_LIMIT","message":"later"}',
      {
        status: 429,
        headers: { 'retry-after': '12', 'x-request-id': 'req-safe-1' }
      }
    ));

    try {
      await createIancarOneApiClient(config, fetcher as typeof fetch).listVehicles();
      throw new Error('expected error');
    } catch (error) {
      expect(error).toBeInstanceOf(IancarOneApiError);
      const typed = error as IancarOneApiError;
      expect(typed).toMatchObject({
        code: 'IANCAR_ONE_API_HTTP_429',
        status: 429,
        requestId: 'req-safe-1',
        retryAfterSeconds: 12
      });
      expect(String(typed)).not.toContain(config.apiKey);
    }
  });

  it('defaults to the verified ONE origin and requires only the secret at runtime', () => {
    expect(iancarOneApiConfigFromEnv({
      EANCAR_ONE_API_KEY: 'synthetic'
    } as NodeJS.ProcessEnv)).toMatchObject({
      apiKey: 'synthetic',
      baseUrl: 'https://eancarone.com'
    });
  });

  it('summarizes schema without leaking values for controlled live inspection', () => {
    const shape = summarizeJsonShape({
      vehicle_id: 'private-id',
      rates: [{ monthly_rate: 700000, deposit: null }],
      contract_conditions: { version: 'private-version' }
    });
    expect(shape).toContainEqual({ path: 'vehicle_id', types: ['string'] });
    expect(shape).toContainEqual({ path: 'rates[].deposit', types: ['null'] });
    expect(JSON.stringify(shape)).not.toContain('private-id');
    expect(JSON.stringify(shape)).not.toContain('700000');
  });
});
