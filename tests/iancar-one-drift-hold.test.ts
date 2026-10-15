import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectIancarOneFullFacts, IANCAR_ONE_API_ORIGIN, IANCAR_ONE_DRIFT_HOLD_RATIO } from '../src/adapters/iancar-one-api.js';

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
