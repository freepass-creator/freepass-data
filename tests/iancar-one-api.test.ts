import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildIancarOneSourceBatch,
  collectIancarOneVehicleList,
  collectIancarOneFullFacts,
  collectIancarOnePhaseOneFacts,
  buildIancarOnePublicationProducts,
  createIancarOneApiClient,
  createIancarPhotoByteCache,
  IANCAR_ONE_API_ORIGIN,
  IancarOneApiError,
  iancarOneApiConfigFromEnv,
  iancarOnePhotoIds,
  readIancarOnePhotoBytes,
  projectIancarOneReservation,
  projectIancarOnePhaseOne,
  compareIancarOneInventoryParity,
  compareIancarOnePhaseOneParity,
  summarizeJsonShape
} from '../src/adapters/iancar-one-api.js';

const config = {
  baseUrl: IANCAR_ONE_API_ORIGIN,
  apiKey: 'synthetic-key-never-real'
};

it('private photo cache coalesces exact identities and expires without caching failures', async () => {
  let now = 1;
  const cache = createIancarPhotoByteCache(() => now);
  const load = vi.fn(async () => ({ bytes: Buffer.from([255, 216, 255]), contentType: 'image/jpeg' }));
  await Promise.all([cache('V1', 'P1', load), cache('V1', 'P1', load)]);
  expect(load).toHaveBeenCalledTimes(1);
  await cache('V2', 'P1', load); expect(load).toHaveBeenCalledTimes(2);
  now += 30_001; await cache('V1', 'P1', load); expect(load).toHaveBeenCalledTimes(3);
  await expect(cache('V1', 'bad', async () => { throw new Error('synthetic'); })).rejects.toThrow('synthetic');
  await cache('V1', 'bad', load); expect(load).toHaveBeenCalledTimes(4);
});

it('private photo cache bounds byte memory and concurrent supplier fetches', async () => {
  const cache = createIancarPhotoByteCache();
  const load = vi.fn(async () => ({ bytes: Buffer.alloc(8 * 1024 * 1024), contentType: 'image/jpeg' }));
  for (let i = 0; i < 5; i++) await cache('V1', String(i), load);
  await cache('V1', '0', load); expect(load).toHaveBeenCalledTimes(6);
  const pending = Array.from({ length: 8 }, (_, i) => cache('V2', String(i), () => new Promise<any>(() => {})));
  await expect(cache('V2', 'overflow', load)).rejects.toThrow('IANCAR_PHOTO_BUSY');
  expect(pending).toHaveLength(8);
});

describe('Iancar server photo transport', () => {
  const detail = { vehicle_id: 'V1', plate_number: '133호1234', stale: false,
    photos: [ { photo_id: 'other', url: '/v1/vehicles/V1/photos/other', representative: false },
      { photo_id: 'hero', url: '/v1/vehicles/V1/photos/hero', representative: true } ] };
  it('binds photos to the exact stable ID and plate and places the representative first', () => {
    expect(iancarOnePhotoIds({ data: detail }, 'V1', '133 호1234')).toEqual(['hero', 'other']);
    expect(() => iancarOnePhotoIds(detail, 'V2', '133호1234')).toThrow('IANCAR_PHOTO_IDENTITY_OR_SCOPE_INVALID');
    expect(() => iancarOnePhotoIds(detail, 'V1', '133호9999')).toThrow();
    expect(() => iancarOnePhotoIds({ ...detail, stale: true }, 'V1', '133호1234')).toThrow();
    expect(iancarOnePhotoIds({ ...detail, photos: [] }, 'V1', '133호1234')).toEqual([]);
  });
  it('rejects external credential paths, duplicate references and ambiguous representatives', () => {
    for (const url of ['https://evil.example/v1/vehicles/V1/photos/hero', '/v1/vehicles/V2/photos/hero', '/v1/vehicles/V1/photos/hero?token=secret'])
      expect(() => iancarOnePhotoIds({ ...detail, photos: [{ ...detail.photos[1], url }] }, 'V1', '133호1234')).toThrow('IANCAR_PHOTO_REFERENCE_INVALID');
    expect(() => iancarOnePhotoIds({ ...detail, photos: [detail.photos[1], detail.photos[1]] }, 'V1', '133호1234')).toThrow();
    expect(() => iancarOnePhotoIds({ ...detail, photos: detail.photos.map(p => ({ ...p, representative: true })) }, 'V1', '133호1234')).toThrow('IANCAR_PHOTO_REPRESENTATIVE_AMBIGUOUS');
  });
  it('accepts bounded JPEG bytes, not SVG, spoofed raster or large responses', async () => {
    const bytes = Buffer.from([255, 216, 255, 0]);
    expect(await readIancarOnePhotoBytes(new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }))).toEqual({ bytes, contentType: 'image/jpeg' });
    await expect(readIancarOnePhotoBytes(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))).rejects.toThrow('IANCAR_PHOTO_MEDIA_INVALID');
    await expect(readIancarOnePhotoBytes(new Response('<script/>', { headers: { 'content-type': 'image/jpeg' } }))).rejects.toThrow('IANCAR_PHOTO_MEDIA_SIGNATURE_INVALID');
    await expect(readIancarOnePhotoBytes(new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'content-length': '8388609' } }))).rejects.toThrow('IANCAR_PHOTO_MEDIA_INVALID');
    const chunks = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
    await expect(readIancarOnePhotoBytes(new Response(chunks, { headers: { 'content-type': 'image/jpeg' } }))).rejects.toThrow('IANCAR_PHOTO_MEDIA_OVERSIZED');
  });
});

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
  const freshCapture = { readyForRawIngest: true, stale: false };
  it('projects supplier RESERVED as 계약중 without creating contract facts or mutating RAW', () => {
    const raw = { inventory_status: 'RESERVED', available: false, stale: false };
    expect(projectIancarOneReservation(raw, freshCapture)).toEqual({ source_inventory_status: 'RESERVED',
      vehicle_status: '계약중', status: '계약중', status_kind: '선점', available: false });
    expect(raw).toEqual({ inventory_status: 'RESERVED', available: false, stale: false });
    expect(projectIancarOneReservation({ inventory_status: 'AVAILABLE' }, freshCapture)).toBeNull();
    expect(projectIancarOneReservation({ inventory_status: 'UNKNOWN' }, freshCapture)).toBeNull();
  });
  it.each([
    [{ inventory_status: 'RESERVED', available: true }, freshCapture],
    [{ inventory_status: 'RESERVED', available: false }, { readyForRawIngest: true, stale: true }],
    [{ inventory_status: 'RESERVED', available: false, stale: false }, { readyForRawIngest: false, stale: false }]
  ])('does not project contradictory or unaccepted reservations: %j', (raw, capture) => {
    expect(() => projectIancarOneReservation(raw, capture)).toThrow('IANCAR_ONE_RESERVED_STATE_REQUIRES_REVIEW');
  });
  it('uses computed capture freshness and supports envelope-only stale from real list parsing', async () => {
    const fetcher = (async () => new Response(JSON.stringify(page({ page: 1, total: 1,
      data: [vehicle('reserved', { inventory_status: 'RESERVED', available: false })] })))) as typeof fetch;
    const capture = await collectIancarOneVehicleList(config, fetcher);
    expect(capture.records[0]!.payload.stale).toBeUndefined();
    expect(projectIancarOneReservation(capture.records[0]!.payload, capture)?.status).toBe('계약중');
    vi.advanceTimersByTime(16 * 60 * 1000);
    const expired = await collectIancarOneVehicleList(config, fetcher);
    expect(expired.readyForRawIngest).toBe(false);
    expect(() => projectIancarOneReservation(expired.records[0]!.payload, expired))
      .toThrow('IANCAR_ONE_RESERVED_STATE_REQUIRES_REVIEW');
  });
  const fullFetcher = (fault = '') => (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const row = vehicle('veh1', { plate_number: '123가4567', inventory_status: 'AVAILABLE',
      available: true, available_from: null, synced_at: '2026-10-01T00:00:00.000Z', stale: false });
    const rate = { rental_period: 24, monthly_rate: 500000, deposit: 700000,
      contracted_mileage: 20000, mileage_period: 'year', currency: 'KRW', vat_included: true,
      contract_conditions: { version: 'synthetic-v1' } };
    let body: unknown = page({ page: 1, total: 1, data: [row] });
    if (path.endsWith('/rates')) body = { success: true, updated_at: '2026-09-26T00:00:00Z',
      ...(fault === 'wrong-rate-id' ? { vehicle_id: 'other' } : {}),
      data: fault === 'duplicate' ? [rate, rate] : [{ ...rate, ...(fault === 'null-deposit' ? { deposit: null } : {}) }] };
    else if (path !== '/v1/vehicles') body = { success: true, data: { ...row,
      ...(fault === 'wrong-id' ? { vehicle_id: 'other' } : {}),
      ...(fault === 'wrong-plate' && !path.endsWith('/availability') ? { plate_number: '999나9999' } : {}) } };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  it('phase one reads only list/rates and reconciles a reservation without mixing policy facts', async () => {
    let lists = 0;
    const paths: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      const response = await fullFetcher()(input); const body = await response.json();
      if (path === '/v1/vehicles' && ++lists > 1) {
        body.data[0].inventory_status = 'RESERVED'; body.data[0].available = false;
      }
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const capture = await collectIancarOnePhaseOneFacts(config, fetcher);
    expect(paths).toEqual(['/v1/vehicles', '/v1/vehicles/veh1/rates', '/v1/vehicles']);
    expect(projectIancarOnePhaseOne(capture).vehicles[0]?.displayStatus).toBe('계약중');
    expect(capture.records[0]?.payload.detail).toBeUndefined();
    expect(buildIancarOneSourceBatch(capture).coverage.mode).toBe('UNKNOWN');
    expect(buildIancarOneSourceBatch(capture).source.sourceId).toContain('phase-one-facts');
  });

  it('phase one fetches rates again when a list plate changes for the same ID', async () => {
    let lists = 0; let rates = 0;
    const fetcher = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const response = await fullFetcher()(input); const body = await response.json();
      if (path === '/v1/vehicles' && ++lists > 1) body.data[0].plate_number = '999나9999';
      if (path.endsWith('/rates')) { rates++; body.data[0].monthly_rate = rates * 500000; }
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const capture = await collectIancarOnePhaseOneFacts(config, fetcher);
    expect(rates).toBe(2);
    expect(projectIancarOnePhaseOne(capture).vehicles[0]?.terms[0]?.monthlyRent.amount).toBe(1000000);
  });

  it('phase one holds continuous new identities instead of inventing unfetched rates', async () => {
    let lists = 0;
    const fetcher = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const response = await fullFetcher()(input); const body = await response.json();
      if (path === '/v1/vehicles') body.data[0].vehicle_id = `veh${++lists}`;
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const capture = await collectIancarOnePhaseOneFacts(config, fetcher);
    expect(capture.readyForRawIngest).toBe(false);
    expect(capture.issues).toContain('IANCAR_ONE_PHASE_ONE_IDENTITY_RECONCILIATION_PENDING');
    expect(buildIancarOneSourceBatch(capture).coverage.mode).toBe('PARTIAL');
    expect(() => projectIancarOnePhaseOne(capture)).toThrow();
  });

  it('phase one rejects unknown deposits and expired rate observations despite a fresh final list', async () => {
    await expect(collectIancarOnePhaseOneFacts(config, fullFetcher('null-deposit')))
      .rejects.toThrow('RATE_REQUIRES_REVIEW');
    const capture = await collectIancarOnePhaseOneFacts(config, fullFetcher());
    const evidence = capture.records[0]!.payload.rateRequestEvidence as Record<string, unknown>;
    evidence.captured_at = '2026-09-30T23:44:59Z';
    expect(() => projectIancarOnePhaseOne(capture)).toThrow('IDENTITY_REQUIRES_REVIEW');
  });

  it('phase-one fingerprints ignore client observation time while retaining real provenance', async () => {
    const first = await collectIancarOnePhaseOneFacts(config, fullFetcher());
    vi.advanceTimersByTime(1000);
    const second = await collectIancarOnePhaseOneFacts(config, fullFetcher());
    expect(first.records[0]?.fingerprint).toBe(second.records[0]?.fingerprint);
    expect(first.sourceDigest).toBe(second.sourceDigest);
    expect(first.records[0]?.payload.rateRequestEvidence).not.toEqual(second.records[0]?.payload.rateRequestEvidence);
  });

  it('products preserve exact mileage/deposit tiers with explicit base aliases and deferred policy', async () => {
    const capture = await collectIancarOnePhaseOneFacts(config, fullFetcher());
    const [product] = buildIancarOnePublicationProducts(capture);
    expect(product?.price).toEqual({ '24_연20000km': { rent: 500000, deposit: 700000 },
      '24': { rent: 500000, deposit: 700000 } });
    expect(product?.priceAliases).toEqual({ '24': '24:20000:year' });
    expect(product?.terms[0]?.contractedMileage).toEqual({ km: 20000, period: 'year' });
    expect(product?.evidence.policyStage).toBe('DEFERRED');
    expect(product?.facts.maker).toBe('현대');
    expect(product?.evidence).not.toHaveProperty('contract_conditions');
  });

  it('products never annualize monthly limits and never create an unobserved six-month rate', async () => {
    const fetcher = (async (input: string | URL | Request) => {
      const response = await fullFetcher()(input); const body = await response.json();
      if (new URL(String(input)).pathname.endsWith('/rates')) body.data = [
        { ...body.data[0], rental_period: 3, contracted_mileage: 2000, mileage_period: 'month' },
        { ...body.data[0], rental_period: 3, contracted_mileage: 3000, mileage_period: 'month', monthly_rate: 600000 }
      ];
      else body.data[0].manufacturer = null;
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const capture = await collectIancarOnePhaseOneFacts(config, fetcher);
    const [product] = buildIancarOnePublicationProducts(capture);
    expect(product?.price['3_월2000km']?.rent).toBe(500000);
    expect(product?.price['3_월3000km']?.rent).toBe(600000);
    expect(product?.price['3']?.rent).toBe(500000);
    expect(product?.price).not.toHaveProperty('6');
    expect(product?.facts.maker).toBeNull();
    expect(product?.terms[0]).not.toHaveProperty('mileageLimitKmPerYear');
  });

  it('accepts a fresh refresh-clock advance only when exact inventory facts remain unchanged', async () => {
    let lists = 0;
    const fetcher = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const response = await fullFetcher()(input); const body = await response.json();
      if (path === '/v1/vehicles') {
        lists++;
        if (lists > 1) body.synced_at = '2026-10-01T00:00:30Z';
      } else if (!path.endsWith('/rates')) body.data.synced_at = '2026-10-01T00:00:30Z';
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const capture = await collectIancarOneFullFacts(config, fetcher);
    expect(capture.readyForRawIngest).toBe(true);
    expect(capture.syncedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(capture.observationWindow).toMatchObject({ endInventorySyncedAt: '2026-10-01T00:00:30Z',
      consistency: 'BOUNDED_OBSERVATION_NOT_ATOMIC' });
  });

  it('still holds a real inventory change across fresh supplier refresh clocks', async () => {
    let lists = 0;
    const fetcher = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const response = await fullFetcher()(input); const body = await response.json();
      if (path === '/v1/vehicles' && ++lists > 1) {
        body.synced_at = '2026-10-01T00:00:30Z';
        body.data[0].inventory_status = 'RESERVED'; body.data[0].available = false;
      }
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const capture = await collectIancarOneFullFacts(config, fetcher);
    expect(capture.readyForRawIngest).toBe(false);
    expect(capture.issues).toContain('IANCAR_ONE_ENRICHMENT_SOURCE_DRIFT');
  });

  it.each(['2026-09-30T23:40:00Z', '2026-10-01T00:02:01Z', 'invalid'])
    ('rejects stale/future/invalid detail clocks even in eventual mode: %s', async syncedAt => {
      const fetcher = (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        const response = await fullFetcher()(input); const body = await response.json();
        if (path !== '/v1/vehicles' && !path.endsWith('/rates')) body.data.synced_at = syncedAt;
        return new Response(JSON.stringify(body));
      }) as typeof fetch;
      await expect(collectIancarOneFullFacts(config, fetcher)).rejects.toThrow('DETAIL_SOURCE_DRIFT');
    });

  it('holds even a one-second ending inventory clock regression', async () => {
    let lists = 0;
    const fetcher = (async (input: string | URL | Request) => {
      const response = await fullFetcher()(input); const body = await response.json();
      if (new URL(String(input)).pathname === '/v1/vehicles' && ++lists > 1)
        body.synced_at = '2026-09-30T23:59:59Z';
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const capture = await collectIancarOneFullFacts(config, fetcher);
    expect(capture.issues).toContain('IANCAR_ONE_ENRICHMENT_CLOCK_REGRESSION');
    expect(capture.readyForRawIngest).toBe(false);
  });

  it('prepares phase-one plate and exact rental tuples without carrying policies or deposits', async () => {
    const capture = await collectIancarOneFullFacts(config, fullFetcher());
    const before = JSON.stringify(capture);
    const result = projectIancarOnePhaseOne(capture);
    expect(result).toMatchObject({ publicationAuthorized: false, policyStage: 'DEFERRED',
      vehicles: [{ plate: '123가4567', displayStatus: '출고가능', terms: [{ key: '24:20000:year',
        monthlyRent: { amount: 500000, currency: 'KRW' }, contractedMileage: { km: 20000, period: 'year' } }] }] });
    expect(JSON.stringify(result)).not.toContain('deposit');
    expect(JSON.stringify(result)).not.toContain('contract_conditions');
    expect(JSON.stringify(capture)).toBe(before);
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(() => projectIancarOnePhaseOne(capture)).toThrow('PHASE_ONE_SOURCE_REQUIRES_REVIEW');
  });

  it('preserves monthly mileage instead of annualizing and rejects altered rates evidence', async () => {
    const fetcher = (async (input: string | URL | Request) => {
      const response = await fullFetcher()(input);
      const body = await response.json();
      if (new URL(String(input)).pathname.endsWith('/rates')) {
        body.data[0].rental_period = 3; body.data[0].contracted_mileage = 2000; body.data[0].mileage_period = 'month';
      }
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    const capture = await collectIancarOneFullFacts(config, fetcher);
    expect(projectIancarOnePhaseOne(capture).vehicles[0]?.terms[0]?.key).toBe('3:2000:month');
    (capture.records[0]!.payload.rates as any).data[0].monthly_rate = 0;
    expect(() => projectIancarOnePhaseOne(capture)).toThrow('PHASE_ONE_IDENTITY_REQUIRES_REVIEW');
  });

  it('rejects non-full or duplicate phase-one identities', async () => {
    const capture = await collectIancarOneFullFacts(config, fullFetcher());
    const inventoryOnly = { ...capture }; delete inventoryOnly.factScope;
    expect(() => projectIancarOnePhaseOne(inventoryOnly)).toThrow('PHASE_ONE_SOURCE_REQUIRES_REVIEW');
    expect(() => projectIancarOnePhaseOne({ ...capture, total: 2, records: [...capture.records, ...capture.records] }))
      .toThrow('PHASE_ONE_IDENTITY_REQUIRES_REVIEW');
  });

  it.each([
    { monthly_rate: 0 }, { monthly_rate: 20000001 }, { rental_period: 0 },
    { contracted_mileage: 0 }, { currency: 'USD' }, { vat_included: false }, { mileage_period: 'week' }
  ])('rejects malformed rates at ingestion with a consistent response digest: %j', async fault => {
    const fetcher = (async (input: string | URL | Request) => {
      const response = await fullFetcher()(input); const body = await response.json();
      if (new URL(String(input)).pathname.endsWith('/rates')) Object.assign(body.data[0], fault);
      return new Response(JSON.stringify(body));
    }) as typeof fetch;
    await expect(collectIancarOneFullFacts(config, fetcher)).rejects.toThrow('RATE_FACT_REQUIRES_REVIEW');
  });

  it('requires plate-set and source-state parity, not just equal totals', () => {
    expect(compareIancarOneInventoryParity([], []).status).toBe('HOLD');
    const source = [{ plate: '123가4567', sourceInventoryStatus: 'AVAILABLE' }, { plate: '124가4567', sourceInventoryStatus: 'RESERVED' }];
    expect(compareIancarOneInventoryParity(source, [...source].reverse()).status).toBe('MATCH');
    expect(compareIancarOneInventoryParity(source, [source[0]!, { plate: '125가4567', sourceInventoryStatus: 'RESERVED' }]))
      .toMatchObject({ status: 'HOLD', sourceCount: 2, consumerCount: 2, missing: 1, extra: 1 });
    expect(compareIancarOneInventoryParity(source, [source[0]!, { ...source[1]!, sourceInventoryStatus: 'AVAILABLE' }]))
      .toMatchObject({ status: 'HOLD', stateMismatch: 1 });
    expect(compareIancarOneInventoryParity(source, [source[0]!, source[0]!]))
      .toMatchObject({ status: 'HOLD', consumerDuplicates: 1 });
  });

  it('rejects wrong consumer prices, display states, IDs or snapshot despite equal inventory totals', async () => {
    const source = projectIancarOnePhaseOne(await collectIancarOneFullFacts(config, fullFetcher()));
    expect(compareIancarOnePhaseOneParity(source, structuredClone(source)).status).toBe('PHASE_ONE_PARITY_VERIFIED');
    const price = structuredClone(source); price.vehicles[0]!.terms[0]!.monthlyRent.amount++;
    expect(compareIancarOnePhaseOneParity(source, price)).toMatchObject({ status: 'HOLD', rateMismatch: 1 });
    const display = structuredClone(source); display.vehicles[0]!.displayStatus = '출고불가';
    expect(compareIancarOnePhaseOneParity(source, display)).toMatchObject({ status: 'HOLD', displayMismatch: 1 });
    const identity = structuredClone(source); identity.vehicles[0]!.sourceVehicleId = 'other';
    expect(compareIancarOnePhaseOneParity(source, identity)).toMatchObject({ status: 'HOLD', identityMismatch: 1 });
    const snapshot = structuredClone(source); snapshot.sourceDigest = '0'.repeat(64);
    expect(compareIancarOnePhaseOneParity(source, snapshot)).toMatchObject({ status: 'HOLD', snapshotMismatch: true });
    const whitespace = structuredClone(price); whitespace.vehicles[0]!.plate += ' ';
    expect(compareIancarOnePhaseOneParity(source, whitespace)).toMatchObject({ status: 'HOLD', rateMismatch: 1 });
    const reordered = structuredClone(source);
    const term = reordered.vehicles[0]!.terms[0]!;
    reordered.vehicles[0]!.terms[0] = { vatIncluded: term.vatIncluded, monthlyRent: term.monthlyRent,
      contractedMileage: term.contractedMileage, termMonths: term.termMonths, key: term.key };
    expect(compareIancarOnePhaseOneParity(source, reordered).status).toBe('PHASE_ONE_PARITY_VERIFIED');
    expect(compareIancarOnePhaseOneParity({ ...source, vehicles: [] }, { ...source, vehicles: [] }).status).toBe('HOLD');
  });

  it('bounds concurrent enrichment to six GETs while collecting independent endpoints in parallel', async () => {
    const ids = ['veh1', 'veh2', 'veh3'];
    const rows = ids.map((id, index) => vehicle(id, { plate_number: `${123 + index}가4567`,
      inventory_status: 'AVAILABLE', available: true, available_from: null,
      synced_at: '2026-10-01T00:00:00.000Z', stale: false }));
    let active = 0;
    let peak = 0;
    const fetcher = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/vehicles') return new Response(JSON.stringify(page({ page: 1, total: 3, data: rows })));
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (path.endsWith('/rates')) return await fullFetcher()(input);
        const id = path.split('/')[3];
        return new Response(JSON.stringify({ success: true, data: rows[ids.indexOf(id!)] }));
      } finally { active--; }
    }) as typeof fetch;
    const capture = await collectIancarOneFullFacts(config, fetcher);
    expect(capture.records).toHaveLength(3);
    expect(capture.readyForRawIngest).toBe(true);
    expect(peak).toBe(6);
    expect(active).toBe(0);
  });

  it('settles outstanding requests before surfacing transient failure', async () => {
    let active = 0;
    const fetcher = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/vehicles') return fullFetcher()(input);
      active++;
      try {
        if (path.endsWith('/availability')) return new Response('', { status: 503 });
        await new Promise(resolve => setTimeout(resolve, 10));
        return await fullFetcher()(input);
      } finally { active--; }
    }) as typeof fetch;
    await expect(collectIancarOneFullFacts(config, fetcher)).rejects.toThrow('IANCAR_ONE_API_HTTP_503');
    expect(active).toBe(0);
  });

  it('preserves cross-worker 429 and Retry-After instead of masking it with 503', async () => {
    const rows = ['veh1', 'veh2'].map((id, index) => vehicle(id, {
      plate_number: `${123 + index}가4567`, inventory_status: 'AVAILABLE', available: true,
      available_from: null, synced_at: '2026-10-01T00:00:00.000Z', stale: false }));
    const fetcher = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/vehicles') return new Response(JSON.stringify(page({ page: 1, total: 2, data: rows })));
      if (path.endsWith('/availability')) {
        if (path.includes('/veh1/')) { await new Promise(resolve => setTimeout(resolve, 10)); return new Response('', { status: 503 }); }
        return new Response('', { status: 429, headers: { 'retry-after': '7' } });
      }
      if (path.endsWith('/rates')) return fullFetcher()(input);
      return new Response(JSON.stringify({ success: true, data: rows.find(row => path.endsWith(row.vehicle_id)) }));
    }) as typeof fetch;
    await expect(collectIancarOneFullFacts(config, fetcher)).rejects.toMatchObject({ status: 429, retryAfterSeconds: 7 });
  });

  it('retains vehicle-scoped rate request evidence and independent policy updated_at', async () => {
    const capture = await collectIancarOneFullFacts(config, fullFetcher());
    expect(capture.readyForRawIngest).toBe(true);
    expect(capture.factScope).toBe('FULL_FACTS');
    expect(capture.records[0]!.payload.rateRequestEvidence).toMatchObject({
      vehicle_id: 'veh1', path: '/v1/vehicles/veh1/rates' });
    expect(buildIancarOneSourceBatch(capture).coverage.scope).toContain('vehicle-scoped');
    expect(buildIancarOneSourceBatch(capture).coverage.completeness).toBe('UNKNOWN');
    expect(buildIancarOneSourceBatch(capture).source.sourceId).toMatch(/:full-facts$/);
    expect(buildIancarOneSourceBatch(capture).source.authorityScope).toContain('NO_INVENTORY_STATE_OR_SOURCE_ABSENCE_AUTHORITY');
  });
  it.each([
    ['wrong-id', 'IANCAR_ONE_DETAIL_IDENTITY_MISMATCH'],
    ['wrong-plate', 'IANCAR_ONE_PLATE_MISMATCH'],
    ['wrong-rate-id', 'INVALID_IANCAR_ONE_RATES_RESPONSE'],
    ['duplicate', 'IANCAR_ONE_DUPLICATE_RATE'],
    ['null-deposit', 'IANCAR_ONE_RATE_FACT_REQUIRES_REVIEW']
  ])('fails closed on full-fact %s', async (fault, code) => {
    await expect(collectIancarOneFullFacts(config, fullFetcher(fault))).rejects.toThrow(code);
  });
  it('does not churn provider fingerprints just because request observation time changes', async () => {
    const first = await collectIancarOneFullFacts(config, fullFetcher());
    vi.advanceTimersByTime(1000);
    const second = await collectIancarOneFullFacts(config, fullFetcher());
    expect(first.records[0]!.payload.rateRequestEvidence).not.toEqual(second.records[0]!.payload.rateRequestEvidence);
    expect(first.records[0]!.fingerprint).toBe(second.records[0]!.fingerprint);
    expect(first.sourceDigest).toBe(second.sourceDigest);
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:01:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());
  it('rejects credential transmission to any alternate origin', () => {
    expect(() => createIancarOneApiClient({ ...config, baseUrl: 'https://other.example' }))
      .toThrow('IANCAR_ONE_API_BASE_URL_NOT_ALLOWED');
  });

  it.each([
    ['2026-09-30T23:00:00.000Z', 'IANCAR_ONE_SOURCE_FRESHNESS_EXCEEDED'],
    ['2026-10-01T00:03:00.000Z', 'IANCAR_ONE_SOURCE_TIME_IN_FUTURE']
  ])('HOLDs invalid source time %s even when provider stale=false', async (syncedAt, issue) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(page({
      page: 1, total: 1, data: [vehicle('v1')], syncedAt
    })), { status: 200 }));
    const capture = await collectIancarOneVehicleList(config, fetcher as typeof fetch,
      '2026-10-01T00:01:00.000Z');
    expect(capture.readyForRawIngest).toBe(false);
    expect(capture.issues).toContain(issue);
  });

  it('HOLDs pagination total drift even when observed rows match the first page', async () => {
    const firstData = Array.from({ length: 100 }, (_, index) => vehicle(`v${index}`));
    const syncedAt = new Date().toISOString();
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const n = Number(new URL(String(input)).searchParams.get('page'));
      return new Response(JSON.stringify(page({ page: n, total: n === 1 ? 101 : 102,
        data: n === 1 ? firstData : [vehicle('last')], syncedAt })), { status: 200 });
    });
    const capture = await collectIancarOneVehicleList(config, fetcher as typeof fetch);
    expect(capture.issues).toContain('IANCAR_ONE_PAGINATION_METADATA_DRIFT');
    expect(capture.readyForRawIngest).toBe(false);
  });

  it('permits bounded clock skew but rejects timestamps without an offset', async () => {
    const fetcher = (syncedAt: string) => vi.fn(async () => new Response(JSON.stringify(page({
      page: 1, total: 1, data: [vehicle('v1')], syncedAt
    })), { status: 200 }));
    const capture = await collectIancarOneVehicleList(config,
      fetcher('2026-10-01T00:01:30Z') as typeof fetch);
    expect(capture.readyForRawIngest).toBe(true);
    await expect(collectIancarOneVehicleList(config,
      fetcher('2026-10-01T00:00:00') as typeof fetch))
      .rejects.toThrow('INVALID_IANCAR_ONE_LIST_RESPONSE');
  });

  it('bounds upstream page declarations before issuing additional requests', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(page({
      page: 1, total: 100001, data: [vehicle('v1')]
    })), { status: 200 }));
    await expect(collectIancarOneVehicleList(config, fetcher as typeof fetch))
      .rejects.toThrow('IANCAR_ONE_PAGE_LIMIT_EXCEEDED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the verified Bearer scheme and /v1/vehicles contract', async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('https://eancarone.com/v1/vehicles?page=1&page_size=100');
      expect((init?.headers as Record<string, string>).Authorization)
        .toBe('Bearer synthetic-key-never-real');
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('manual');
      return new Response(JSON.stringify(page({ page: 1, total: 1, data: [vehicle('v1')], syncedAt: '2026-10-01T00:00:00.000Z' })), {
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
