import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectIancarOneFullFacts, IancarOneApiError, IANCAR_ONE_API_ORIGIN, IANCAR_ONE_DRIFT_HOLD_RATIO } from '../src/adapters/iancar-one-api.js';

// 읽는 동안 상태가 바뀐 차 한 대가 회차 전체를 실패시키지 않는다(2026-10-16 10:05 KST RP031 READ_FAILED_..._AVAILABILITY_DRIFT). 값은 전부 합성.
const config = { baseUrl: IANCAR_ONE_API_ORIGIN, apiKey: 'synthetic-key-never-real' };
const N = 10;
const plate = (i: number) => `${100 + i}가${String(1000 + i)}`;
const row = (i: number, state: { status: string; available: boolean }) => ({ vehicle_id: `veh${i}`, plate_number: plate(i), plate: plate(i),
  availability: 'AVAILABLE', manufacturer: '현대', monthly_rate: null, inventory_status: state.status, available: state.available, available_from: null,
  synced_at: '2026-10-01T00:00:00.000Z', stale: false });
const rate = { rental_period: 24, monthly_rate: 500000, deposit: 700000, contracted_mileage: 20000, mileage_period: 'year', currency: 'KRW',
  vat_included: true, contract_conditions: { version: 'synthetic-v1' } };

/** changes: 차 번호 → 어느 시점부터 RESERVED 로 보이는지('detail' = 상세·가용 읽기부터, 'end' = 끝 목록부터). */
function fetcher(changes: Record<number, 'detail' | 'end'> = {}) {
  let lists = 0;
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const reserved = { status: 'RESERVED', available: false }, open = { status: 'AVAILABLE', available: true };
    if (path === '/v1/vehicles') {
      lists++;
      const data = Array.from({ length: N }, (_, i) => row(i, lists > 1 && changes[i] ? reserved : open));
      return Response.json({ success: true, data, pagination: { page: 1, page_size: 100, total: N }, synced_at: '2026-10-01T00:00:00.000Z', stale: false });
    }
    const id = /\/v1\/vehicles\/veh(\d+)/.exec(path)?.[1];
    const i = Number(id);
    if (path.endsWith('/rates')) return Response.json({ success: true, updated_at: '2026-09-26T00:00:00Z', data: [rate] });
    return Response.json({ success: true, data: row(i, changes[i] === 'detail' ? reserved : open) });
  }) as typeof fetch;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('개별 응답 수신 시각과 전체 검증 시각 구분', () => {
  const observed = '2026-10-17T11:47:31.055Z';
  const started = '2026-10-17T12:00:04.459Z';
  const completed = '2026-10-17T12:02:39.693Z';
  const slowRates = (extra: Record<string, unknown> = {}, endingFresh = true) => {
    const base = fetcher(); let lists = 0;
    return (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const body = await (await base(input)).json();
      if (path === '/v1/vehicles') {
        const stamp = ++lists > 1 && endingFresh ? completed : observed;
        body.data = body.data.slice(0, 2).map((r: Record<string, unknown>) => ({ ...r, synced_at: stamp }));
        body.pagination.total = 2; body.synced_at = stamp;
      } else if (path.endsWith('/rates')) {
        await new Promise(resolve => setTimeout(resolve, 155_234));
      } else Object.assign(body.data, { synced_at: observed }, extra);
      return Response.json(body);
    }) as typeof fetch;
  };
  it('제때 받은 상세·가용을 느린 요금 때문에 만료로 오인하지 않으며 끝 목록은 신선해야 한다', async () => {
    vi.setSystemTime(new Date(started));
    const pending = collectIancarOneFullFacts(config, slowRates()).catch(e => e);
    await vi.runAllTimersAsync();
    const capture = await pending;
    expect(capture.readyForRawIngest).toBe(true);
    expect(capture.records.filter((r: { hold?: unknown }) => r.hold)).toHaveLength(0);
    expect(capture.syncedAt).toBe(observed); // 시작 원천 시각을 완료/현재 시각으로 덮지 않는다.
    expect(capture.observationWindow).toMatchObject({ startInventorySyncedAt: observed, endInventorySyncedAt: completed });
  });
  it.each([
    ['NOT_FRESH_FLAG', { stale: true }],
    ['FUTURE', { synced_at: '2026-10-17T12:01:05.459Z' }],
    ['BEHIND_LIST', { synced_at: '2026-10-17T11:46:31.055Z' }],
    ['EXPIRED', { synced_at: '2026-10-17T11:44:00.000Z' }],
  ] as const)('늦은 요금이 와도 수신 당시 %s는 계속 보류한다', async (reason, extra) => {
    vi.setSystemTime(new Date(started));
    const pending = collectIancarOneFullFacts(config, slowRates(extra)).catch(e => e);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error.code).toBe('IANCAR_ONE_DETAIL_SOURCE_DRIFT');
    expect(error.clockDiagnostic.reasonEnvelopeCounts[reason]).toBe(4);
    expect(error.clockDiagnostic.examples[0]).toMatchObject({ receivedAt: started, checkedAt: completed });
  });
  it('끝 목록도 여전히 같은 오래된 원천이면 회복/완전 읽기로 처리하지 않는다', async () => {
    vi.setSystemTime(new Date(started));
    const pending = collectIancarOneFullFacts(config, slowRates({}, false)).catch(e => e);
    await vi.runAllTimersAsync();
    const capture = await pending;
    expect(capture.readyForRawIngest).toBe(false);
    expect(capture.issues).toContain('IANCAR_ONE_SOURCE_FRESHNESS_EXCEEDED');
  });
  it.each([
    ['2026-09-26T00:00:00Z', true], // 요금 개정일과 실제 읽은 시각은 다르다.
    ['2026-10-17T12:01:05.459Z', false],
  ] as const)('요금 갱신 %s: 실제 수신 시각을 보존하고 수신 당시 미래는 대기로 숨기지 않는다', async (updatedAt, valid) => {
    vi.setSystemTime(new Date(started));
    const base = slowRates();
    const calls = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/rates')) return Response.json({ success: true, updated_at: updatedAt, data: [rate] });
      const body = await (await base(input)).json();
      if (path !== '/v1/vehicles') {
        await new Promise(resolve => setTimeout(resolve, 155_234));
        body.data.synced_at = completed;
      }
      return Response.json(body);
    }) as typeof fetch;
    const pending = collectIancarOneFullFacts(config, calls).catch(e => e);
    await vi.runAllTimersAsync();
    const result = await pending;
    if (!valid) expect(result.code).toBe('INVALID_IANCAR_ONE_RATES_RESPONSE');
    else {
      expect(result.readyForRawIngest).toBe(true);
      expect(result.records[0].payload.rateRequestEvidence.captured_at).toBe(started);
      expect(result.records[0].payload.rates.updated_at).toBe(updatedAt);
    }
  });
});

describe('RP031 읽는 동안 상태가 바뀐 차는 그 차만 보류한다', () => {
  it('상세·가용이 목록과 다른 차 1대: 회차는 완전하고 그 차만 보류(값 계열)', async () => {
    const capture = await collectIancarOneFullFacts(config, fetcher({ 3: 'detail' }));
    expect(capture.readyForRawIngest).toBe(true);
    expect(capture.issues).toEqual([]);
    const held = capture.records.filter(r => r.hold);
    expect(held).toHaveLength(1);
    expect(held[0]!.hold).toEqual({ code: 'IANCAR_ONE_DETAIL_AVAILABILITY_DRIFT', identity: false });
    expect(held[0]!.vehicleId).toBe('veh3');
    expect(capture.records.filter(r => !r.hold)).toHaveLength(N - 1);
  });

  it('끝 목록에서만 바뀐 차 1대: 그 차만 보류, 회차 이슈 없음', async () => {
    const capture = await collectIancarOneFullFacts(config, fetcher({ 5: 'end' }));
    expect(capture.readyForRawIngest).toBe(true);
    expect(capture.issues).toEqual([]);
    expect(capture.records.filter(r => r.hold).map(r => [r.vehicleId, r.hold!.code]))
      .toEqual([['veh5', 'IANCAR_ONE_LIST_CHANGED_DURING_READ']]);
  });

  it('불일치 차라도 가용·상세 봉투 검증(신원·시효·번호)을 건너뛰지 않는다 — 신원 불일치는 보류로 둔갑하지 않는다', async () => {
    const base = fetcher({ 3: 'detail' });
    // veh3: 가용 읽기가 다른 차 ID 를 돌려주면(신원 불일치) 상태 어긋남과 겹쳐도 회차 실패여야 한다.
    const spoof = (async (input: string | URL | Request) => {
      const response = await base(input);
      if (/\/v1\/vehicles\/veh3\/availability/.test(new URL(String(input)).pathname)) {
        const body = await response.json(); body.data.vehicle_id = 'other'; return Response.json(body);
      }
      return response;
    }) as typeof fetch;
    await expect(collectIancarOneFullFacts(config, spoof)).rejects.toThrow('IANCAR_ONE_DETAIL_IDENTITY_MISMATCH');
  });

  it('이미 요금 보류인 차도 끝 목록 변화를 센다(전 차 보류여도 한도 판정에서 빠지지 않음)', async () => {
    const inner = fetcher({ 1: 'end', 2: 'end', 3: 'end' });   // 한 번만 만든다(목록 읽기 횟수 상태 공유)
    const emptyRates = (async (input: string | URL | Request) => {
      const response = await inner(input);
      if (new URL(String(input)).pathname.endsWith('/rates')) return Response.json({ success: true, updated_at: '2026-09-26T00:00:00Z', data: [] });
      return response;
    }) as typeof fetch;
    const capture = await collectIancarOneFullFacts(config, emptyRates);
    expect(capture.readyForRawIngest).toBe(false);
    expect(capture.issues).toContain('IANCAR_ONE_ENRICHMENT_SOURCE_DRIFT');
  });

  it('시작 목록에 없다가 끝 목록에 나타난 ID 는 예전처럼 원천 드리프트(부재 판정 보호)', async () => {
    let lists = 0;
    const withExtra = (async (input: string | URL | Request) => {
      const response = await fetcher()(input);
      if (new URL(String(input)).pathname === '/v1/vehicles' && ++lists > 1) {
        const body = await response.json();
        body.data.push(row(99, { status: 'AVAILABLE', available: true }));
        body.pagination.total = N + 1;
        return Response.json(body);
      }
      return response;
    }) as typeof fetch;
    const capture = await collectIancarOneFullFacts(config, withExtra);
    expect(capture.readyForRawIngest).toBe(false);
    expect(capture.issues).toContain('IANCAR_ONE_ENRICHMENT_SOURCE_DRIFT');
  });

  it('어긋난 차가 한도(20%)를 넘으면 예전처럼 회차 전체 실패/이슈', async () => {
    expect(IANCAR_ONE_DRIFT_HOLD_RATIO).toBe(0.2);
    // 상세 읽기에서 3대(> floor(10*0.2)=2) → 회차 전체 실패
    await expect(collectIancarOneFullFacts(config, fetcher({ 1: 'detail', 2: 'detail', 3: 'detail' }))).rejects.toThrow('IANCAR_ONE_DETAIL_AVAILABILITY_DRIFT');
    // 끝 목록에서 3대 → 원천 드리프트 이슈로 불완전
    const capture = await collectIancarOneFullFacts(config, fetcher({ 1: 'end', 2: 'end', 3: 'end' }));
    expect(capture.readyForRawIngest).toBe(false);
    expect(capture.issues).toContain('IANCAR_ONE_ENRICHMENT_SOURCE_DRIFT');
    // 한도 안(2대)이면 보류만
    const ok = await collectIancarOneFullFacts(config, fetcher({ 1: 'detail', 2: 'end' }));
    expect(ok.readyForRawIngest).toBe(true);
    expect(ok.records.filter(r => r.hold)).toHaveLength(2);
  });
});

// 2026-10-16 16:00 회차: 한 대의 상세 갱신 시각이 목록·신선도 창 밖이라 IANCAR_ONE_DETAIL_SOURCE_DRIFT 로 회차 전체가 멈췄다(노출 89대 STALE). 그 차만 보류한다.
describe('RP031 상세 갱신 시각이 어긋난 차는 그 차만 보류한다', () => {
  const withDetailClock = (ids: number[], syncedAt: string, extra: Record<string, unknown> = {}) => {
    const inner = fetcher();
    return (async (input: string | URL | Request) => {
      const response = await inner(input);
      const path = new URL(String(input)).pathname;
      const id = /\/v1\/vehicles\/veh(\d+)$/.exec(path)?.[1] ?? /\/v1\/vehicles\/veh(\d+)\/availability$/.exec(path)?.[1];
      if (id !== undefined && ids.includes(Number(id))) {
        const body = await response.json(); body.data.synced_at = syncedAt; Object.assign(body.data, extra); return Response.json(body);
      }
      return response;
    }) as typeof fetch;
  };

  it('상세 시각이 목록보다 오래된 차 1대(또는 stale:true): 회차는 완전하고 그 차만 SOURCE_DRIFT 보류', async () => {
    for (const make of [() => withDetailClock([4], '2026-09-30T23:30:00.000Z'), () => withDetailClock([4], '2026-10-01T00:00:00.000Z', { stale: true })]) {
      const capture = await collectIancarOneFullFacts(config, make());
      expect(capture.readyForRawIngest).toBe(true);
      expect(capture.issues).toEqual([]);
      expect(capture.records.filter(r => r.hold).map(r => [r.vehicleId, r.hold!.code, r.hold!.identity]))
        .toEqual([['veh4', 'IANCAR_ONE_DETAIL_SOURCE_DRIFT', false]]);
    }
  });

  it('한도(전체의 20%)를 넘으면 예전처럼 회차 전체 실패, 형식이 깨진 갱신 시각은 즉시 실패', async () => {
    await expect(collectIancarOneFullFacts(config, withDetailClock([1, 2, 3], '2026-09-30T23:30:00.000Z'))).rejects.toThrow('IANCAR_ONE_DETAIL_SOURCE_DRIFT');
    await expect(collectIancarOneFullFacts(config, withDetailClock([4], 'invalid'))).rejects.toThrow('IANCAR_ONE_DETAIL_SOURCE_DRIFT');
    const two = await collectIancarOneFullFacts(config, withDetailClock([1, 2], '2026-09-30T23:30:00.000Z'));
    expect(two.records.filter(r => r.hold)).toHaveLength(2);   // 한도 안(2대)
  });

  it('목록보다 1분 이전인 상세·가용: 기존 보류를 유지하며 시각 차이와 봉투 수를 남기고 신원·본문은 싣지 않는다', async () => {
    const error = await collectIancarOneFullFacts(config, withDetailClock([1, 2, 3], '2026-09-30T23:59:00.000Z',
      { private_note: 'DO_NOT_LOG_SOURCE_BODY' })).catch(e => e);
    expect(error).toBeInstanceOf(IancarOneApiError);
    expect(error.code).toBe('IANCAR_ONE_DETAIL_SOURCE_DRIFT');
    expect(error.clockDiagnostic).toMatchObject({ kind: 'IANCAR_DETAIL_CLOCK', stage: 'DRIFT_LIMIT',
      listSyncedAt: '2026-10-01T00:00:00.000Z', listedVehicles: N, rereadVehicles: N, cachedVehicles: 0,
      heldVehicles: 3, clockHeldVehicles: 3, driftLimit: 2, reasonEnvelopeCounts: { BEHIND_LIST: 6 } });
    expect(error.clockDiagnostic.examples).toHaveLength(4);
    expect(error.clockDiagnostic.examples[0]).toMatchObject({ syncedAt: '2026-09-30T23:59:00.000Z',
      checkedAt: '2026-10-01T00:00:00.000Z', ageMs: 60_000, behindListMs: 60_000, reasons: ['BEHIND_LIST'] });
    const serialized = JSON.stringify(error.clockDiagnostic);
    for (const secret of ['DO_NOT_LOG_SOURCE_BODY', config.apiKey, 'veh1', plate(1), 'monthly_rate', 'private_note'])
      expect(serialized).not.toContain(secret);
  });

  it.each([
    ['NOT_FRESH_FLAG', '2026-10-01T00:00:00.000Z', { stale: true }],
    ['EXPIRED', '2026-09-30T23:44:00.000Z', {}],
    ['FUTURE', '2026-10-01T00:02:00.000Z', {}],
  ] as const)('기존 %s 검사는 바꾸지 않고 실제 응답 봉투별 사유를 보존한다', async (reason, stamp, extra) => {
    const error = await collectIancarOneFullFacts(config, withDetailClock([1, 2, 3], stamp, extra)).catch(e => e);
    expect(error.code).toBe('IANCAR_ONE_DETAIL_SOURCE_DRIFT');
    expect(error.clockDiagnostic.stage).toBe('DRIFT_LIMIT');
    expect(error.clockDiagnostic.reasonEnvelopeCounts[reason]).toBe(6);
    expect(error.clockDiagnostic.examples.every((s: { reasons: string[] }) => s.reasons.includes(reason))).toBe(true);
  });

  it('깨진 synced_at 원문은 null로만 기록하고 모든 워커가 정리된 뒤 진단을 전달한다', async () => {
    const secret = 'invalid synthetic-key-never-real veh4';
    const error = await collectIancarOneFullFacts(config, withDetailClock([4], secret)).catch(e => e);
    expect(error.code).toBe('IANCAR_ONE_DETAIL_SOURCE_DRIFT');
    expect(error.clockDiagnostic.stage).toBe('INVALID_SYNC');
    expect(error.clockDiagnostic.reasonEnvelopeCounts.INVALID_SYNC).toBeGreaterThan(0);
    expect(error.clockDiagnostic.examples[0]).toMatchObject({ syncedAt: null, ageMs: null, behindListMs: null, reasons: ['INVALID_SYNC'] });
    expect(JSON.stringify(error.clockDiagnostic)).not.toContain(secret);
    expect(JSON.stringify(error.clockDiagnostic)).not.toContain(config.apiKey);
  });
});
