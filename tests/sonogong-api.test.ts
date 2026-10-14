import { describe, expect, it, vi } from 'vitest';
import { createSonogongApiClient, readSonogongApi, sonogongApiRowFloor, SonogongApiError, SONOGONG_API_POLICY } from '../src/adapters/sonogong-api.js';

// 값은 전부 가짜. 키는 시험용 표지(센티널).
const KEY = 'SYNTHETIC_PARTNER_KEY_SENTINEL';
const BASE = 'https://sokrc.com/api/partner/v1';
const json = (data: unknown, attrs: unknown = { generatedAt: '2026-10-14T06:00:00.000Z' }, status = 200) =>
  new Response(JSON.stringify({ success: status === 200, data, attrs }), { status });
const row = (id: number, plate: string, extra: Record<string, unknown> = {}) => ({ id, carNumber: plate, brand: '현대', model: '아반떼', detailName: 'CN7',
  fuel: '가솔린', exteriorColor: '흰색', manufactureYearMonth: '2023-05', mileageKm: 12345, displacementCc: 1598, hasActiveContract: false,
  prices: { SUBSCRIBE_RETURN: { monthly: { 12: 900000, 24: 800000, 36: 700000, 48: 650000, 60: 600000 } } }, tab: 'sub', thumbnailUrl: null, ...extra });
const detail = (id: number, plate: string, extra: Record<string, unknown> = {}) => ({ id, carNumber: plate, carName: '현대_아반떼_CN7',
  images: [{ url: 'https://example.invalid/a.jpg', sortOrder: 0 }],
  prices: { SUBSCRIBE_RETURN: { monthly: { 12: 900000, 24: 800000, 36: 700000, 48: 650000, 60: 600000 },
    deposit: { 12: 1000000, 24: 0, 36: 2000000, 48: null, 60: 3000000 } },
    SUBSCRIBE_BUYOUT: { monthly: { 36: 900000 }, deposit: { 36: 5000000 } } }, ...extra });

function world(handler: (url: URL) => Response | Promise<Response>) {
  const calls: string[] = [], sleeps: number[] = [];
  let clock = Date.parse('2026-10-14T06:00:00Z');
  const fakeFetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    expect((init?.headers as Record<string, string>)['x-partner-key']).toBe(KEY);
    expect(init?.redirect).toBe('error');
    expect(init?.method).toBe('GET');
    return handler(u);
  }) as unknown as typeof fetch;
  const client = createSonogongApiClient({ base: BASE, key: KEY, fetch: fakeFetch, now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; } });
  return { client, calls, sleeps, fakeFetch };
}
const ok = (u: URL) => {
  if (u.pathname.endsWith('/vehicles')) {
    const tab = u.searchParams.get('tab');
    return json(tab === 'sub' ? [row(1, '100하1111'), row(2, '100하2222', { hasActiveContract: true })] : [],
      { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: tab === 'sub' ? 2 : 0 });
  }
  const id = Number(u.pathname.split('/').at(-1));
  return json(detail(id, id === 1 ? '100하1111' : '100하2222'));
};

describe('손오공 공식 API 어댑터', () => {
  it('키·주소가 없거나 허용 호스트가 아니면 호출 0으로 NOT_CONFIGURED', () => {
    const f = vi.fn();
    for (const bad of [{ base: '', key: KEY }, { base: BASE, key: '' }, { base: 'https://evil.example/api/partner/v1', key: KEY },
      { base: 'http://sokrc.com/api/partner/v1', key: KEY }, { base: 'https://sokrc.com/other', key: KEY }])
      expect(() => createSonogongApiClient({ ...bad, fetch: f as never })).toThrow('SONOGONG_API_NOT_CONFIGURED');
    expect(f).not.toHaveBeenCalled();
  });
  it('3탭 목록+상세를 직렬·간격 두고 읽고 반납형 요금·상세 보증금·계약중 상태를 매핑한다', async () => {
    const w = world(ok);
    const read = await readSonogongApi(w.client);
    expect(read.complete).toBe(true);
    expect(read.listed).toBe(2);
    expect(read.detailsRead).toBe(2);
    expect(w.calls.filter(c => c.startsWith('/api/partner/v1/vehicles?')).length).toBe(3);
    expect(w.sleeps.length).toBe(w.calls.length);
    const by = Object.fromEntries(read.records.map(r => [r.plate!.slice(-4), r]));
    expect(by['1111']!.status).toEqual({ raw: '출고가능', saleAvailable: true });
    // 계약중은 모든 원천에서 같게: 판매 가능(문서 유지·«계약중» 선점 표시 노출), 출고가능 비교에서는 raw 로 제외
    expect(by['2222']!.status).toEqual({ raw: '계약중', saleAvailable: true });
    expect(by['1111']!.raw.images).toEqual(['https://example.invalid/a.jpg']);   // 사진: images[].url 중 https 만
    expect(by['1111']!.terms.map(t => [t.months, t.monthlyRent.value, t.deposit.state, t.deposit.value])).toEqual([
      [12, 900000, 'KNOWN', 1000000], [24, 800000, 'ZERO', 0], [36, 700000, 'KNOWN', 2000000], [48, 650000, 'UNKNOWN', null], [60, 600000, 'KNOWN', 3000000]]);
    expect((by['1111']!.raw.prices as Record<string, unknown>).SUBSCRIBE_BUYOUT).toBeDefined();
    expect(by['1111']!.raw.detail).toBeDefined();
    expect(by['1111']!.raw.spec).toMatchObject({ year: '2023', first_registration_date: '2023-05', mileage: '12345' });
    expect(JSON.stringify(read)).not.toContain(KEY);
  });
  it('같은 번호가 다른 탭에도 있으면 rent > sub > pick 우선순위로 하나만 채택하고 경고만 남긴다(불완전 아님), 같은 탭 안 중복은 불완전', async () => {
    const w = world(u => {
      if (u.pathname.endsWith('/vehicles')) {
        const tab = u.searchParams.get('tab');
        if (tab === 'rent') return json([row(1, '100하1111', { tab: 'rent', manufactureYearMonth: '2023-05', prices: { RENT_RETURN: { monthly: { 36: 500000 } } } })], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: 1 });
        if (tab === 'sub') return json([row(1, '100하1111', { manufactureYearMonth: '2024-02' }), row(2, '100하2222')], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: 2 });
        return json([], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: 0 });
      }
      const id = Number(u.pathname.split('/').at(-1));
      return json(detail(id, id === 1 ? '100하1111' : '100하2222'));
    });
    const read = await readSonogongApi(w.client);
    expect(read.complete).toBe(true);
    expect(read.records.map(r => [r.plate!.slice(-4), r.raw.tab])).toEqual([['1111', 'rent'], ['2222', 'sub']]);
    expect(read.notes).toEqual(['CROSS_TAB_DUPLICATE:1', 'CROSS_TAB_GENERATION_DIFFERENCE:1']);
    const within = await readSonogongApi(world(u => u.pathname.endsWith('/vehicles')
      ? json(u.searchParams.get('tab') === 'sub' ? [row(1, '100하1111'), row(3, '100하1111')] : [], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: u.searchParams.get('tab') === 'sub' ? 2 : 0 })
      : json(detail(1, '100하1111'))).client);
    expect(within.complete).toBe(false);
    expect(within.incompleteReason).toBe('DUPLICATE_PLATES');
  });
  it('429·401 은 첫 응답에서 정지하고 재시도하지 않으며 오류에 키·본문이 없다', async () => {
    for (const status of [429, 401]) {
      const w = world(() => new Response('{"error":"SECRET_BODY"}', { status }));
      const error = await readSonogongApi(w.client).catch(e => e) as SonogongApiError;
      expect(error).toBeInstanceOf(SonogongApiError);
      expect(error.status).toBe(status);
      expect(w.fakeFetch).toHaveBeenCalledTimes(1);
      expect(`${error.message}${error.stack}`).not.toContain(KEY);
      expect(error.message).not.toContain('SECRET_BODY');
    }
  });
  it('상세 429 는 회차 전체를 멈추고, 상세 404 는 그 차만 보증금 미확인으로 두고 불완전', async () => {
    const stop = world(u => u.pathname.endsWith('/vehicles') ? ok(u) : new Response('', { status: 429 }));
    await expect(readSonogongApi(stop.client)).rejects.toMatchObject({ status: 429 });
    const w = world(u => u.pathname.endsWith('/vehicles') ? ok(u)
      : Number(u.pathname.split('/').at(-1)) === 2 ? new Response('', { status: 404 }) : ok(u));
    const read = await readSonogongApi(w.client);
    expect(read.complete).toBe(false);
    expect(read.incompleteReason).toBe('API_DETAIL_FAILED');
    const r2 = read.records.find(r => r.plate!.endsWith('2222'))!;
    expect(r2.terms.every(t => t.deposit.state === 'UNKNOWN')).toBe(true);
  });
  it('목록·상세 번호가 다르면 차를 만들지 않고, 형식 이상·중복 번호·상태 미상은 보류·불완전', async () => {
    const w = world(u => {
      if (u.pathname.endsWith('/vehicles')) return json(u.searchParams.get('tab') === 'sub'
        ? [row(1, '100하1111'), row(3, 'BAD'), row(4, '100하1111'), row(5, '100하5555', { hasActiveContract: null })] : []);
      return json(detail(1, '100하9999'));
    });
    const read = await readSonogongApi(w.client);
    expect(read.records).toEqual([]);
    expect(read.held.map(h => h.reason).sort()).toEqual(['IDENTITY_MISMATCH', 'PLATE_INVALID', 'STATUS_UNKNOWN']);
    expect(read.duplicatePlates).toEqual(['100하1111']);
    expect(read.complete).toBe(false);
  });
  it('빈 응답은 쓰기 근거가 아니고(불완전·레코드 0), 목록 수가 총수와 다르면 불완전', async () => {
    const empty = await readSonogongApi(world(() => json([])).client);
    expect(empty.complete).toBe(false);
    expect(empty.records).toEqual([]);
    const mismatch = await readSonogongApi(world(u => u.pathname.endsWith('/vehicles')
      ? json(u.searchParams.get('tab') === 'sub' ? [row(1, '100하1111')] : [],
        { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: u.searchParams.get('tab') === 'sub' ? 3 : 0 })
      : json(detail(1, '100하1111'))).client);
    expect(mismatch.incompleteReason).toBe('API_COUNT_MISMATCH');
  });
  it('행 수 하한과 정책 상수', () => {
    expect(sonogongApiRowFloor(100, 0)).toBe(80);
    expect(sonogongApiRowFloor(10, 200)).toBe(160);
    expect(SONOGONG_API_POLICY.pageSize).toBeLessThanOrEqual(50);
    expect(SONOGONG_API_POLICY.minIntervalMs).toBeGreaterThanOrEqual(1000);
  });
});
