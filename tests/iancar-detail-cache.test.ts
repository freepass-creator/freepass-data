import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectIancarOneFullFacts, IANCAR_ONE_API_ORIGIN } from '../src/adapters/iancar-one-api.js';
import { cachedIancarDetailFor, IANCAR_DETAIL_CACHE_POLICY, IANCAR_DETAIL_CACHE_VERSION, iancarListRowDigest, iancarRotationIds,
  parseIancarDetailCache, mergeIancarDetailCache, type IancarDetailCache, type IancarDetailCacheEntry } from '../src/adapters/iancar-detail-cache.js';

// 값은 전부 가짜. 이안카 상세·가용 캐시: 목록 행 지문이 같은 차는 상세·가용을 재사용하고 요금만 다시 읽는다. 요금은 캐시하지 않는다.
const config = { apiKey: 'SYNTHETIC_KEY', origin: IANCAR_ONE_API_ORIGIN, timeoutMs: 5000, retryDelaysMs: [] as number[] };
const N = 30;   // 순환 몫(20) 보다 많아야 «순환 밖 차는 캐시 재사용» 이 보인다
const plate = (i: number) => `${100 + i}가${String(1000 + i)}`;
const row = (i: number, state = { status: 'AVAILABLE', available: true }, extra: Record<string, unknown> = {}) => ({ vehicle_id: `veh${i}`, plate_number: plate(i),
  manufacturer: '현대', model: '아반떼', name: '더 뉴 아반떼 CN7', trim: null, year: 2024, fuel: '가솔린', color: '흰색', mileage: 1000 + i,
  photos: [{ photo_id: `p${i}-${Math.random()}` }], merchandising_status: 'COMPLETE', inventory_status: state.status, available: state.available,
  available_from: null, synced_at: '2026-10-01T00:00:00.000Z', stale: false, ...extra });
const rate = { rental_period: 24, monthly_rate: 500000, deposit: 700000, contracted_mileage: 20000, mileage_period: 'year', currency: 'KRW',
  vat_included: true, contract_conditions: { version: 'synthetic-v1' } };
const reserved = { status: 'RESERVED', available: false };

function world(opts: { rateOf?: (i: number) => number; changed?: Set<number>; failAt?: { afterDetails: number; status?: number; identity?: boolean }; endChanged?: Set<number>; endExtra?: boolean } = {}) {
  const calls = { list: 0, detail: 0, availability: 0, rates: 0 };
  const state = (i: number) => (opts.changed?.has(i) ? reserved : undefined);
  const fetcher = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/vehicles') {
      calls.list++;
      const ending = calls.list > 1;
      const data = Array.from({ length: N }, (_, i) => row(i, ending && opts.endChanged?.has(i) ? reserved : state(i)));
      if (ending && opts.endExtra) data.push(row(N));
      return Response.json({ success: true, data, pagination: { page: 1, page_size: 100, total: data.length }, synced_at: '2026-10-01T00:00:00.000Z', stale: false });
    }
    const i = Number(/\/v1\/vehicles\/veh(\d+)/.exec(path)?.[1]);
    if (path.endsWith('/rates')) {
      calls.rates++;
      return Response.json({ success: true, updated_at: '2026-09-26T00:00:00Z', data: [{ ...rate, monthly_rate: opts.rateOf?.(i) ?? rate.monthly_rate }] });
    }
    if (path.endsWith('/availability')) { calls.availability++; return Response.json({ success: true, data: row(i, state(i)) }); }
    calls.detail++;
    if (opts.failAt && calls.detail > opts.failAt.afterDetails) {
      if (opts.failAt.identity) return Response.json({ success: true, data: { ...row(i, state(i)), vehicle_id: 'other' } });
      return new Response('upstream', { status: opts.failAt.status ?? 503 });
    }
    return Response.json({ success: true, data: row(i, state(i)) });
  }) as typeof fetch;
  return { fetcher, calls };
}
const roundTrip = (cache: IancarDetailCache) => parseIancarDetailCache(JSON.parse(JSON.stringify(cache)))!;
const monthlyRate = (payload: Record<string, unknown>) => (payload.rates as { data: Array<{ monthly_rate: number }> }).data[0]!.monthly_rate;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('이안카 상세·가용 캐시', () => {
  it('21시 실측 반례: 같은 원천 시각·stale=false라도 읽는 동안 15분을 넘은 14/20대는 보류하고 새 원천에서만 회복한다', async () => {
    // 2026-10-17 21시 익명 시각만 실측. 차량·요금·HTTP는 전부 합성, 외부 호출 0.
    const observed = '2026-10-17T11:47:31.055Z';
    const started = '2026-10-17T12:00:04.459Z';
    const facts = Array.from({ length: 116 }, (_, i) => row(i, undefined, { synced_at: observed, photos: [] }));
    const cache: IancarDetailCache = { version: IANCAR_DETAIL_CACHE_VERSION, writtenAt: observed,
      entries: Object.fromEntries(facts.map((fact, i) => [fact.vehicle_id, {
        rowDigest: iancarListRowDigest(fact), detail: { success: true, data: fact }, availability: { success: true, data: fact },
        cachedAt: new Date(Date.parse(observed) + i).toISOString(), detailSyncedAt: observed }])) };
    const rotation = iancarRotationIds(cache, facts.map(f => f.vehicle_id));
    let stamp = observed, delayed = true, rates = 0, detail = 0, availability = 0;
    const waitById = new Map<string, number>();
    const calls = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/vehicles') {
        const page = Number(url.searchParams.get('page') ?? 1);
        return Response.json({ success: true, data: facts.slice((page - 1) * 100, page * 100).map(f => ({ ...f, synced_at: stamp })),
          pagination: { page, page_size: 100, total: facts.length }, synced_at: stamp, stale: false });
      }
      const id = /\/vehicles\/(veh\d+)/.exec(url.pathname)![1]!;
      const index = Number(id.slice(3));
      if (delayed && rotation.has(id) && !waitById.has(id)) waitById.set(id, waitById.size < 6 ? 45_000 : 20_234);
      if (delayed && rotation.has(id)) await new Promise(resolve => setTimeout(resolve, waitById.get(id)!));
      if (url.pathname.endsWith('/rates')) {
        rates++;
        return Response.json({ success: true, updated_at: stamp, data: [rate] });
      }
      if (url.pathname.endsWith('/availability')) availability++; else detail++;
      return Response.json({ success: true, data: { ...facts[index]!, synced_at: stamp } });
    }) as typeof fetch;
    vi.setSystemTime(new Date(started));
    const pending = collectIancarOneFullFacts(config, calls, undefined, undefined, { detailCache: cache }).catch(error => error);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error.code).toBe('IANCAR_ONE_DETAIL_SOURCE_DRIFT');
    expect(error.clockDiagnostic).toMatchObject({ listSyncedAt: observed, listedVehicles: 116,
      rereadVehicles: 20, cachedVehicles: 96, clockHeldVehicles: 14, driftLimit: 4,
      reasonEnvelopeCounts: { EXPIRED: 28, INVALID_SYNC: 0, NOT_FRESH_FLAG: 0, FUTURE: 0, BEHIND_LIST: 0 } });
    expect(error.clockDiagnostic.examples[0]).toMatchObject({ syncedAt: observed,
      checkedAt: '2026-10-17T12:02:39.693Z', ageMs: 908_638, behindListMs: 0, reasons: ['EXPIRED'] });
    expect({ rates, detail, availability }).toEqual({ rates: 116, detail: 20, availability: 20 });
    // 이 반례는 실제 개별 수신도 만료된 경우다. 새로운 원천 시각에서만 회복한다.
    stamp = '2026-10-17T12:07:00.000Z'; delayed = false; rates = 0;
    vi.setSystemTime(new Date('2026-10-17T12:10:00.000Z'));
    const recovered = await collectIancarOneFullFacts(config, calls, undefined, undefined, { detailCache: cache });
    expect(recovered.readyForRawIngest).toBe(true);
    expect(recovered.records.filter(r => r.hold)).toHaveLength(0);
    expect(rates).toBe(116); // 같은 목록 사실이어도 가격은 다시 확인한다.
  });

  it('시각 진단의 한도·재읽기 수는 캐시 적중으로 희석하지 않는다', async () => {
    const first = await collectIancarOneFullFacts(config, world().fetcher, undefined, undefined, { detailCache: null });
    const cache = roundTrip(first.detailCacheOut!);
    const rereadIds = [...iancarRotationIds(cache, Array.from({ length: N }, (_, i) => `veh${i}`))];
    const bad = new Set(rereadIds.slice(0, 5));
    const w = world();
    const drift = (async (input: string | URL | Request) => {
      const response = await w.fetcher(input), path = new URL(String(input)).pathname;
      const id = /\/v1\/vehicles\/(veh\d+)(?:\/availability)?$/.exec(path)?.[1];
      if (id && bad.has(id)) {
        const body = await response.json(); body.data.synced_at = '2026-09-30T23:59:00.000Z'; return Response.json(body);
      }
      return response;
    }) as typeof fetch;
    const error = await collectIancarOneFullFacts(config, drift, undefined, undefined, { detailCache: cache }).catch(e => e);
    expect(error.code).toBe('IANCAR_ONE_DETAIL_SOURCE_DRIFT');
    expect(error.clockDiagnostic).toMatchObject({ listedVehicles: N, cachedVehicles: 10, rereadVehicles: 20,
      driftLimit: 4, heldVehicles: 5, clockHeldVehicles: 5, reasonEnvelopeCounts: { BEHIND_LIST: 10 } });
    expect(w.calls.rates).toBe(N);
  });

  it('첫 회차(캐시 없음)는 전수 3호출; 둘째 회차는 순환 몫(20)만 상세·가용을 읽고 나머지는 재사용, 요금은 전부 다시 읽는다', async () => {
    const w1 = world();
    const first = await collectIancarOneFullFacts(config, w1.fetcher, undefined, undefined, { detailCache: null });
    expect(first.readyForRawIngest).toBe(true);
    expect(w1.calls).toEqual({ list: 2, detail: N, availability: N, rates: N });
    expect(first.detailsCached).toBe(0);
    expect(Object.keys(first.detailCacheOut!.entries)).toHaveLength(N);

    const w2 = world({ rateOf: i => 600000 + i });
    vi.setSystemTime(new Date('2026-10-01T00:05:00Z'));   // 목록 신선도 창(15분) 안
    const second = await collectIancarOneFullFacts(config, w2.fetcher, undefined, undefined, { detailCache: roundTrip(first.detailCacheOut!) });
    expect(second.readyForRawIngest).toBe(true);
    expect(second.issues).toEqual([]);
    expect(w2.calls).toEqual({ list: 2, detail: IANCAR_DETAIL_CACHE_POLICY.rotationPerCycle, availability: IANCAR_DETAIL_CACHE_POLICY.rotationPerCycle, rates: N });
    expect(second.detailsCached).toBe(N - IANCAR_DETAIL_CACHE_POLICY.rotationPerCycle);
    // 요금은 항상 새로 읽은 값(캐시 적중 차 포함)
    for (const r of second.records) expect(monthlyRate(r.payload)).toBe(600000 + Number(r.vehicleId.slice(3)));
    // 재사용한 차도 상세·가용 봉투가 payload 에 그대로 들어 있어 뒤 단계(투영)가 종전과 같다
    const cachedOne = second.records.find(r => r.vehicleId === 'veh3')!;   // 순환 밖(사전순 22번째) → 캐시 재사용 차
    expect((cachedOne.payload.detail as { data: { vehicle_id: string } }).data.vehicle_id).toBe(cachedOne.vehicleId);
    expect(Object.keys(second.detailCacheOut!.entries)).toHaveLength(N);
  });

  it('지문이 바뀐 차(가용 상태 전이)는 순환 밖이어도 다시 읽고 캐시 항목이 새 지문으로 갱신된다', async () => {
    const w1 = world();
    const first = await collectIancarOneFullFacts(config, w1.fetcher, undefined, undefined, { detailCache: null });
    const cache = roundTrip(first.detailCacheOut!);
    // 캐시 시각이 전부 같아 순환은 ID 사전순 앞 20대(veh0,veh1,veh10..veh19,veh2,veh20..veh27) — veh3·veh4 는 순환 밖
    const rotation = iancarRotationIds(cache, first.records.map(r => r.vehicleId));
    expect(rotation.has('veh3')).toBe(false); expect(rotation.has('veh4')).toBe(false);
    const w2 = world({ changed: new Set([3]) });
    vi.setSystemTime(new Date('2026-10-01T00:08:00Z'));
    const second = await collectIancarOneFullFacts(config, w2.fetcher, undefined, undefined, { detailCache: cache });
    expect(second.readyForRawIngest).toBe(true);
    expect(w2.calls.detail).toBe(IANCAR_DETAIL_CACHE_POLICY.rotationPerCycle + 1);
    expect(w2.calls.rates).toBe(N);
    expect(second.detailsCached).toBe(N - IANCAR_DETAIL_CACHE_POLICY.rotationPerCycle - 1);
    expect(second.detailCacheOut!.entries.veh3!.rowDigest).not.toBe(cache.entries.veh3!.rowDigest);
    expect(second.detailCacheOut!.entries.veh3!.rowDigest).toBe(iancarListRowDigest(row(3, reserved)));
    expect(second.detailCacheOut!.entries.veh4!.rowDigest).toBe(cache.entries.veh4!.rowDigest);
    expect(second.records.find(r => r.vehicleId === 'veh3')!.hold).toBeUndefined();
  });

  it('순수 함수: 지문은 사진·synced_at 을 무시하고 가용 상태·번호·제원 변화에 반응한다; 유효 상한·시계 역행·손상 파일은 캐시 없음', () => {
    const base = row(1);
    expect(iancarListRowDigest(base)).toBe(iancarListRowDigest({ ...base, photos: [{ photo_id: 'other' }], synced_at: '2026-10-02T00:00:00Z' }));
    expect(iancarListRowDigest(base)).not.toBe(iancarListRowDigest({ ...base, available: false }));
    expect(iancarListRowDigest(base)).not.toBe(iancarListRowDigest({ ...base, plate_number: '999가9999' }));
    expect(iancarListRowDigest(base)).not.toBe(iancarListRowDigest({ ...base, mileage: 5 }));
    const { available_from: _dropped, ...withoutKey } = base;   // 키 없음 ≠ null
    expect(iancarListRowDigest(base)).not.toBe(iancarListRowDigest(withoutKey));
    const entry = { rowDigest: iancarListRowDigest(base), detail: { success: true, data: base }, availability: { success: true, data: base },
      cachedAt: '2026-10-01T00:00:00.000Z', detailSyncedAt: '2026-10-01T00:00:00.000Z' };
    const cache: IancarDetailCache = { version: IANCAR_DETAIL_CACHE_VERSION, writtenAt: '2026-10-01T00:00:00.000Z', entries: { veh1: entry } };
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    expect(cachedIancarDetailFor(cache, 'veh1', entry.rowDigest, t0 + 60_000)).not.toBeNull();
    expect(cachedIancarDetailFor(cache, 'veh1', entry.rowDigest, t0 + IANCAR_DETAIL_CACHE_POLICY.maxAgeMs + 1)).toBeNull();
    expect(cachedIancarDetailFor(cache, 'veh1', entry.rowDigest, t0 - 1)).toBeNull();
    expect(cachedIancarDetailFor(cache, 'veh1', 'f'.repeat(64), t0 + 1)).toBeNull();
    expect(cachedIancarDetailFor(cache, 'veh9', entry.rowDigest, t0 + 1)).toBeNull();
    expect(parseIancarDetailCache({ ...cache, version: 'x' })).toBeNull();
    expect(parseIancarDetailCache({ ...cache, entries: { veh1: { ...entry, rowDigest: 'short' } } })).toBeNull();
    expect(parseIancarDetailCache({ ...cache, entries: { veh1: { ...entry, detail: 'nope' } } })).toBeNull();
    expect(parseIancarDetailCache(JSON.parse(JSON.stringify(cache)))).toEqual(cache);
    const many: IancarDetailCache = { ...cache, entries: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`v${i}`, { ...entry, cachedAt: new Date(t0 + i * 1000).toISOString() }])) };
    const ids = Array.from({ length: 30 }, (_, i) => `v${i}`);
    const rot = iancarRotationIds(many, ids);
    expect(rot.size).toBe(IANCAR_DETAIL_CACHE_POLICY.rotationPerCycle);
    expect(rot.has('v0')).toBe(true); expect(rot.has('v29')).toBe(false);
    expect(iancarRotationIds(null, ids).size).toBe(0);
  });

  it('캐시를 주지 않으면(기본) 종전과 같이 전수 3호출이고 캐시 출력이 없다', async () => {
    const w = world();
    const capture = await collectIancarOneFullFacts(config, w.fetcher);
    expect(w.calls).toEqual({ list: 2, detail: N, availability: N, rates: N });
    expect(capture.detailsCached).toBeUndefined();
    expect(capture.detailCacheOut).toBeUndefined();
  });
});

describe('캐시 봉투 재검증(관문 Codex P1)', () => {
  it('캐시 봉투의 차량 ID·번호·가용 사실이 현재 목록과 어긋나면 재사용하지 않고 다시 읽는다', async () => {
    const w1 = world();
    const first = await collectIancarOneFullFacts(config, w1.fetcher, undefined, undefined, { detailCache: null });
    const cache = roundTrip(first.detailCacheOut!);
    // veh4(순환 밖)의 가용 봉투에 다른 차 ID, veh5 의 상세 번호를 바꿔 넣은 손상 파일
    (cache.entries.veh4!.availability.data as Record<string, unknown>).vehicle_id = 'other';
    (cache.entries.veh5!.detail.data as Record<string, unknown>).plate_number = '999가9999';
    const w2 = world();
    vi.setSystemTime(new Date('2026-10-01T00:05:00Z'));
    const second = await collectIancarOneFullFacts(config, w2.fetcher, undefined, undefined, { detailCache: cache });
    expect(second.readyForRawIngest).toBe(true);
    expect(w2.calls.detail).toBe(IANCAR_DETAIL_CACHE_POLICY.rotationPerCycle + 2);
    expect(second.records.filter(r => r.hold)).toHaveLength(0);
    // 다시 읽은 뒤 캐시는 정상 봉투로 갱신된다
    expect((second.detailCacheOut!.entries.veh4!.availability.data as { vehicle_id: string }).vehicle_id).toBe('veh4');
  });
  it('캐시 상세의 synced_at 이 현재 목록 synced_at 보다 뒤(역행·미래)면 재사용하지 않는다', async () => {
    const w1 = world();
    const first = await collectIancarOneFullFacts(config, w1.fetcher, undefined, undefined, { detailCache: null });
    const cache = roundTrip(first.detailCacheOut!);
    (cache.entries.veh6!.detail.data as Record<string, unknown>).synced_at = '2026-10-01T00:00:01.000Z';
    const w2 = world();
    vi.setSystemTime(new Date('2026-10-01T00:05:00Z'));
    const second = await collectIancarOneFullFacts(config, w2.fetcher, undefined, undefined, { detailCache: cache });
    expect(w2.calls.detail).toBe(IANCAR_DETAIL_CACHE_POLICY.rotationPerCycle + 1);
    expect(second.readyForRawIngest).toBe(true);
  });
});

describe('캐시 적재는 회차 실패와 분리(닭과 달걀 해소)', () => {
  it('N대 검증 뒤 503 으로 회차가 실패해도 sink 에는 검증 통과 차만 남고, 회차는 종전처럼 실패한다', async () => {
    const w = world({ failAt: { afterDetails: 26, status: 503 } });   // 순환 몫(20)보다 많이 쌓여야 적중이 보인다
    const sink: Record<string, IancarDetailCacheEntry> = {};
    await expect(collectIancarOneFullFacts(config, w.fetcher, undefined, undefined, { detailCache: null, cacheSink: sink })).rejects.toThrow();
    const ids = Object.keys(sink);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(27); expect(ids.length).toBeGreaterThan(IANCAR_DETAIL_CACHE_POLICY.rotationPerCycle);
    for (const id of ids) expect((sink[id]!.detail.data as { vehicle_id: string }).vehicle_id).toBe(id);
    // 다음 회차: 병합된 파일로 sink 차는 상세·가용을 건너뛴다(요금만)
    const merged = mergeIancarDetailCache(null, sink, Date.parse('2026-10-01T00:01:00Z'));
    const w2 = world();
    vi.setSystemTime(new Date('2026-10-01T00:05:00Z'));
    const second = await collectIancarOneFullFacts(config, w2.fetcher, undefined, undefined, { detailCache: merged });
    expect(second.readyForRawIngest).toBe(true);
    expect(second.detailsCached).toBe(ids.length - IANCAR_DETAIL_CACHE_POLICY.rotationPerCycle);
    expect(w2.calls.detail).toBe(N - ids.length + IANCAR_DETAIL_CACHE_POLICY.rotationPerCycle);
  });
  it('신원 불일치(비일시 실패)로 끝나면 sink 를 비운다', async () => {
    const w = world({ failAt: { afterDetails: 6, identity: true } });
    const sink: Record<string, IancarDetailCacheEntry> = {};
    await expect(collectIancarOneFullFacts(config, w.fetcher, undefined, undefined, { detailCache: null, cacheSink: sink })).rejects.toThrow('IANCAR_ONE_DETAIL_IDENTITY_MISMATCH');
    expect(Object.keys(sink)).toHaveLength(0);
  });
  it('병합은 차량별 통째 덮어쓰기, 유효 상한 지난 항목은 버림, cachedAt 은 보존', () => {
    const base = row(1);
    const old: IancarDetailCacheEntry = { rowDigest: iancarListRowDigest(base), detail: { success: true, data: base }, availability: { success: true, data: base },
      cachedAt: '2026-10-01T00:00:00.000Z', detailSyncedAt: null };
    const stale: IancarDetailCacheEntry = { ...old, cachedAt: '2026-09-29T00:00:00.000Z' };
    const existing: IancarDetailCache = { version: IANCAR_DETAIL_CACHE_VERSION, writtenAt: '2026-10-01T00:00:00.000Z', entries: { veh1: old, veh2: stale } };
    const fresh: IancarDetailCacheEntry = { ...old, rowDigest: 'a'.repeat(64), cachedAt: '2026-10-01T00:30:00.000Z' };
    const merged = mergeIancarDetailCache(existing, { veh1: fresh }, Date.parse('2026-10-01T01:00:00Z'));
    expect(Object.keys(merged.entries)).toEqual(['veh1']);
    expect(merged.entries.veh1!.rowDigest).toBe('a'.repeat(64));
    expect(merged.entries.veh1!.cachedAt).toBe('2026-10-01T00:30:00.000Z');
    expect(parseIancarDetailCache(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
  });
});

describe('끝 목록 대조와 적재(관문 Codex P1)', () => {
  it('읽는 동안 바뀐 차(LIST_CHANGED_DURING_READ 보류)는 적재에서 빠지고 나머지는 남는다', async () => {
    const w = world({ endChanged: new Set([7]) });
    const sink: Record<string, IancarDetailCacheEntry> = {};
    const capture = await collectIancarOneFullFacts(config, w.fetcher, undefined, undefined, { detailCache: null, cacheSink: sink });
    expect(capture.readyForRawIngest).toBe(true);
    expect(capture.records.find(r => r.vehicleId === 'veh7')!.hold?.code).toBe('IANCAR_ONE_LIST_CHANGED_DURING_READ');
    expect(sink.veh7).toBeUndefined();
    expect(Object.keys(sink)).toHaveLength(N - 1);
  });
  it('끝 목록에 새 차가 생겨 회차가 불완전(ENRICHMENT_SOURCE_DRIFT)하면 적재 전부를 버린다', async () => {
    const w = world({ endExtra: true });
    const sink: Record<string, IancarDetailCacheEntry> = {};
    const capture = await collectIancarOneFullFacts(config, w.fetcher, undefined, undefined, { detailCache: null, cacheSink: sink });
    expect(capture.readyForRawIngest).toBe(false);
    expect(capture.issues).toContain('IANCAR_ONE_ENRICHMENT_SOURCE_DRIFT');
    expect(Object.keys(sink)).toHaveLength(0);
  });
});
