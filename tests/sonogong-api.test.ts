import { describe, expect, it, vi } from 'vitest';
import { createSonogongApiClient, parseSonogongAmount, readSonogongApi, sonogongApiRowFloor, SonogongApiError, SONOGONG_API_POLICY, SONOGONG_API_TABS, SONOGONG_WITHDRAWN_PRODUCT_TYPES } from '../src/adapters/sonogong-api.js';

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

/** 목록 2쪽부터는 빈 페이지(총수가 없을 때 어댑터는 빈 페이지까지 읽는다). 페이지별 응답을 직접 시험할 때는 paged=false. */
function world(handler: (url: URL) => Response | Promise<Response>, paged = true) {
  const calls: string[] = [], sleeps: number[] = [];
  let clock = Date.parse('2026-10-14T06:00:00Z');
  const fakeFetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(u.pathname + u.search);
    expect((init?.headers as Record<string, string>)['x-partner-key']).toBe(KEY);
    expect(init?.redirect).toBe('error');
    expect(init?.method).toBe('GET');
    if (paged && u.pathname.endsWith('/vehicles') && Number(u.searchParams.get('page')) > 1) return json([]);
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
  it('오공구독(sub) 탭 하나만 목록+상세를 직렬·간격 두고 읽고(중고렌트·픽업구독 탭은 요청하지 않는다) 반납형 요금·상세 보증금·계약중 상태를 매핑한다', async () => {
    const w = world(ok);
    const read = await readSonogongApi(w.client);
    expect(read.complete).toBe(true);
    expect(read.listed).toBe(2);
    expect(read.detailsRead).toBe(2);
    // 신선도 창 기준은 «읽은 시각»(상류 generatedAt 이 아니다): generatedAt 은 따로 보존
    expect(read.generatedAt).toBe('2026-10-14T06:00:00.000Z');
    expect(read.observedAt).not.toBe(read.generatedAt);
    expect(Date.now() - Date.parse(read.observedAt)).toBeLessThan(60_000);
    expect(w.calls.filter(c => c.startsWith('/api/partner/v1/vehicles?')).length).toBe(1);
    // 대표 2026-10-28 «ㅇㅇ 손오공 구독은 연동하고 나머지는 다 내리고»: 중고렌트·픽업구독 탭은 요청 자체를 하지 않는다
    expect(w.calls.some(c => c.includes('tab=pick') || c.includes('tab=rent'))).toBe(false);
    expect(read.tabsRead).toEqual(['sub']);
    expect(w.sleeps.length).toBe(w.calls.length);
    const by = Object.fromEntries(read.records.map(r => [r.plate!.slice(-4), r]));
    expect(by['1111']!.status).toEqual({ raw: '출고가능', saleAvailable: true });
    // 계약중은 모든 원천에서 같게: 판매 가능(문서 유지·«계약중» 선점 표시 노출), 출고가능 비교에서는 raw 로 제외
    expect(by['2222']!.status).toEqual({ raw: '계약중', saleAvailable: true });
    expect(by['1111']!.raw.images).toEqual(['https://example.invalid/a.jpg']);   // 사진: images[].url 중 https 만
    // 숫자가 먼저: 구독(sub)이어도 API 양수 보증금은 원문 금액 그대로(KNOWN, 계산 표식 없음 — 규칙 값은 raw.rule_deposit 검토용).
    // API 0(24개월)·빈칸(48개월)은 자리채움 → 손오공 정책 «월 대여료×약정연수(최대 3개월)» 계산값(ZERO·UNKNOWN 아님).
    expect(by['1111']!.terms.map(t => [t.months, t.monthlyRent.value, t.deposit.state, t.deposit.value, t.raw.deposit_rule, t.raw.rule_deposit])).toEqual([
      [12, 900000, 'KNOWN', 1000000, undefined, 900000], [24, 800000, 'KNOWN', 1600000, 'RENT_X_CONTRACT_YEARS_MAX3', undefined],
      [36, 700000, 'KNOWN', 2000000, undefined, 2100000], [48, 650000, 'KNOWN', 1950000, 'RENT_X_CONTRACT_YEARS_MAX3', undefined],
      [60, 600000, 'KNOWN', 3000000, undefined, 1800000]]);
    expect(read.notes).toContain('DEPOSIT_RULE_DIFFERS:6');   // 두 대 × (12·36·60개월)
    expect((by['1111']!.raw.prices as Record<string, unknown>).SUBSCRIBE_BUYOUT).toBeDefined();
    expect(by['1111']!.raw.detail).toBeDefined();
    expect(by['1111']!.raw.spec).toMatchObject({ year: '2023', manufacture_year_month: '2023-05', mileage: '12345', fuel_type: '가솔린' });
    expect(by['1111']!.raw.spec).not.toHaveProperty('first_registration_date');   // 제조연월 ≠ 최초등록일
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
    // 운영은 sub 한 탭만 읽는다(대표 2026-10-28). 여러 탭 우선순위 판정은 시험용 탭 지정으로 계속 고정한다.
    const read = await readSonogongApi(w.client, { tabs: ['rent', 'sub'] });
    expect(read.complete).toBe(true);
    expect(read.records.map(r => [r.plate!.slice(-4), r.raw.tab])).toEqual([['1111', 'rent'], ['2222', 'sub']]);
    // 구독 항의 API 양수 보증금(원문 금액 채택)이 정책 계산값과 다른 건수를 검토 경고로 센다(12·36·60개월 — 2222 의 상세)
    expect(read.notes).toEqual(['CROSS_TAB_DUPLICATE:1', 'CROSS_TAB_GENERATION_DIFFERENCE:1', 'DEPOSIT_RULE_DIFFERS:3']);
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
  it('상세 429 는 회차 전체를 멈추고, 상세 404 한두 건은 그 차만 건너뛰고(보증금 미확인) 완전 읽기로 계속한다', async () => {
    const stop = world(u => u.pathname.endsWith('/vehicles') ? ok(u) : new Response('', { status: 429 }));
    await expect(readSonogongApi(stop.client)).rejects.toMatchObject({ status: 429 });
    const w = world(u => u.pathname.endsWith('/vehicles') ? ok(u)
      : Number(u.pathname.split('/').at(-1)) === 2 ? new Response('', { status: 404 }) : ok(u));
    const read = await readSonogongApi(w.client);
    expect(read.complete).toBe(true);                                   // 허용 한도 max(5, 목록의 2%) 이내의 404
    expect(read.notes).toContain('DETAIL_404:2222');                    // 끝 4자리만
    const r2 = read.records.find(r => r.plate!.endsWith('2222'))!;
    // 구독(sub) 보증금은 상세 원문이 아니라 손오공 정책 산출식이라 목록 대여료로 계산된다(상세 원문 대조값만 없다)
    expect(r2.terms.every(t => t.deposit.state === 'KNOWN' && t.raw.deposit_rule === 'RENT_X_CONTRACT_YEARS_MAX3' && !('api_deposit' in t.raw))).toBe(true);
    expect(read.records).toHaveLength(2);                               // 목록 행은 보존
  });
  it('상세 404 가 허용 한도(5건·2%)를 넘으면 불완전, 404 가 아닌 상세 실패(500)는 한 건이어도 불완전', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(i + 1, `100하${1000 + i}`));
    const many = world(u => u.pathname.endsWith('/vehicles')
      ? json(u.searchParams.get('tab') === 'sub' ? rows : [], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: u.searchParams.get('tab') === 'sub' ? 6 : 0 })
      : new Response('', { status: 404 }));
    const overLimit = await readSonogongApi(many.client);
    expect(overLimit.complete).toBe(false);
    expect(overLimit.incompleteReason).toBe('API_DETAIL_FAILED_HTTP_404_6OF6');
    const five = world(u => u.pathname.endsWith('/vehicles') ? ok(u) : Number(u.pathname.split('/').at(-1)) === 2 ? new Response('', { status: 500 }) : ok(u));
    const server = await readSonogongApi(five.client);
    expect(server.complete).toBe(false);
    expect(server.incompleteReason).toBe('API_DETAIL_FAILED_HTTP_500_1OF2');
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
  it('Codex #643 ①: 소수 금액은 반올림하지 않고 읽을 수 없는 값(UNKNOWN)이다 — 0.4 를 ZERO 로, 1000.5 를 1001 로 확정하지 않는다', async () => {
    for (const fractional of [0.4, 0.5, 1000.5, 512345.5, '0.4' as unknown, '1000.5' as unknown])
      expect(parseSonogongAmount(fractional)).toEqual({ amount: { state: 'UNKNOWN', value: null }, unparseable: true });
    expect(parseSonogongAmount(0)).toEqual({ amount: { state: 'ZERO', value: 0 }, unparseable: false });
    expect(parseSonogongAmount(1000)).toEqual({ amount: { state: 'KNOWN', value: 1000 }, unparseable: false });
    const prices = { SUBSCRIBE_RETURN: { monthly: { 36: 700000 }, deposit: { 36: 0.4 } } };
    const read = await readSonogongApi(world(u => u.pathname.endsWith('/vehicles')
      ? json(u.searchParams.get('tab') === 'sub' ? [row(1, '100하1111', { prices })] : [])
      : json(detail(1, '100하1111', { prices }))).client);
    // 구독 보증금 칸이 읽을 수 없는 값이면 원문 금액이 없는 것과 같다 → 손오공 정책 산출식(월 대여료×약정연수, 최대 3개월) 계산값
    expect(read.records[0]!.terms.map(t => [t.months, t.deposit.state, t.deposit.value, t.raw.deposit_rule])).toEqual([[36, 'KNOWN', 2100000, 'RENT_X_CONTRACT_YEARS_MAX3']]);
    expect(read.notes).toContain('AMOUNT_UNPARSEABLE:1');
  });
  it('Codex #643 ②: 앞선 탭은 출고가능인데 뒤 탭이 계약중이면 계약중이 이긴다(조용히 출고가능으로 두지 않는다), 반대는 계약중 유지', async () => {
    const list = (tab: string | null) => {
      if (tab === 'rent') return [row(1, '100하1111', { hasActiveContract: false }), row(2, '100하2222', { hasActiveContract: true })];
      if (tab === 'sub') return [row(3, '100하1111', { hasActiveContract: true }), row(4, '100하2222', { hasActiveContract: false })];
      return [];
    };
    const read = await readSonogongApi(world(u => u.pathname.endsWith('/vehicles')
      ? json(list(u.searchParams.get('tab')))
      : json((() => { const id = Number(u.pathname.split('/').at(-1)); return detail(id, id % 2 ? '100하1111' : '100하2222'); })())).client, { tabs: ['rent', 'sub'] });
    const by =Object.fromEntries(read.records.map(r => [r.plate!.slice(-4), r.status.raw]));
    expect(by['1111']).toBe('계약중');
    expect(by['2222']).toBe('계약중');
    expect(read.notes).toContain('CROSS_TAB_CONTRACT_CONFLICT:1');
  });
  it('Codex #643 ③: 완료는 누적 행 수가 아니라 서로 다른 차 id 수로 판정한다 — 같은 차가 두 쪽에 겹치면 총수에 닿은 것처럼 보여도 불완전', async () => {
    const pages: Record<number, unknown[]> = { 1: [row(1, '100하1111'), row(2, '100하2222')], 2: [row(2, '100하2222')], 3: [] };
    const read = await readSonogongApi(world(u => {
      if (!u.pathname.endsWith('/vehicles')) { const id = Number(u.pathname.split('/').at(-1)); return json(detail(id, `100하${String(id).repeat(4)}`)); }
      return json(u.searchParams.get('tab') === 'sub' ? pages[Number(u.searchParams.get('page'))] ?? [] : [],
        { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: u.searchParams.get('tab') === 'sub' ? 3 : 0 });
    }, false).client);
    expect(read.complete).toBe(false);
    expect(read.incompleteReason).toBe('API_PAGE_OVERLAP');
    expect(read.listed).toBe(2);   // 겹친 행은 한 번만 센다
  });
  it('금액: 숫자 문자열(쉼표 허용)은 읽고, 읽을 수 없는 값(소수 포함)은 UNKNOWN 이면서 AMOUNT_UNPARSEABLE 로 센다(중고렌트 보증금 0 은 자리채움 → UNKNOWN)', async () => {
    expect(parseSonogongAmount('480000')).toEqual({ amount: { state: 'KNOWN', value: 480000 }, unparseable: false });
    expect(parseSonogongAmount('1,250,000')).toEqual({ amount: { state: 'KNOWN', value: 1250000 }, unparseable: false });
    expect(parseSonogongAmount(0)).toEqual({ amount: { state: 'ZERO', value: 0 }, unparseable: false });
    expect(parseSonogongAmount(null)).toEqual({ amount: { state: 'UNKNOWN', value: null }, unparseable: false });
    for (const bad of [Number.NaN, -1, '문의', '12,34', '1.5만', Infinity, {}])
      expect(parseSonogongAmount(bad)).toEqual({ amount: { state: 'UNKNOWN', value: null }, unparseable: true });
    // 중고렌트(rent): 보증금 = 상세 원문 양수 금액. 0 은 자리채움(무보증 표시 칸이 API 에 없다) → UNKNOWN, 정책 규칙을 걸지 않는다.
    const prices = { RENT_RETURN: { monthly: { 12: 512345, 24: '480000', 36: '문의', 48: 650000, 60: null },
      deposit: { 12: '1,000,000', 24: 0, 48: -5, 60: 1 } } };
    const read = await readSonogongApi(world(u => u.pathname.endsWith('/vehicles')
      ? json(u.searchParams.get('tab') === 'rent' ? [row(1, '100하1111', { prices, tab: 'rent' })] : [])
      : json(detail(1, '100하1111', { prices }))).client, { tabs: ['rent', 'sub'] });   // 운영은 rent 를 읽지 않는다(대표 2026-10-28) — 정책 판정만 고정
    expect(read.complete).toBe(true);
    expect(read.records[0]!.terms.map(t => [t.months, t.monthlyRent.value, t.deposit.state, t.deposit.value, t.raw.deposit_rule])).toEqual([
      [12, 512000, 'KNOWN', 1000000, undefined], [24, 480000, 'UNKNOWN', null, undefined], [48, 650000, 'UNKNOWN', null, undefined]]);
    expect(read.notes).toContain('AMOUNT_UNPARSEABLE:2');   // 36개월 월 대여료 '문의' + 48개월 보증금 -5 (소수 금액은 Codex #643 ① 테스트가 본다)
    expect(read.notes).toContain('DEPOSIT_PLACEHOLDER_ZERO:1');
  });
  it('오공구독: API 보증금이 0·빈칸(자리채움)이면 월 대여료×약정연수(최대 3개월) 계산값(KNOWN), ZERO 가 되지 않는다 — 픽업구독 탭 행은 읽지 않는다', async () => {
    const sub = { SUBSCRIBE_RETURN: { monthly: { 12: 500000, 24: 500000, 36: 500000, 48: 500000 }, deposit: { 12: 0, 24: 0, 36: null } } };
    const read = await readSonogongApi(world(u => {
      if (u.pathname.endsWith('/vehicles')) {
        const tab = u.searchParams.get('tab');
        return json(tab === 'sub' ? [row(1, '100하1111', { prices: sub })] : tab === 'pick' ? [row(2, '100하2222', { prices: sub, tab: 'pick' })] : []);
      }
      const id = Number(u.pathname.split('/').at(-1));
      return json(detail(id, id === 1 ? '100하1111' : '100하2222', { prices: sub }));
    }).client);
    for (const r of read.records) {
      expect(r.terms.map(t => [t.months, t.deposit.state, t.deposit.value, t.raw.deposit_rule])).toEqual([
        [12, 'KNOWN', 500000, 'RENT_X_CONTRACT_YEARS_MAX3'], [24, 'KNOWN', 1000000, 'RENT_X_CONTRACT_YEARS_MAX3'],
        [36, 'KNOWN', 1500000, 'RENT_X_CONTRACT_YEARS_MAX3'], [48, 'KNOWN', 1500000, 'RENT_X_CONTRACT_YEARS_MAX3']]);
      expect(r.terms.some(t => t.deposit.state === 'ZERO')).toBe(false);
    }
    expect(read.records.map(r => r.raw.product_type)).toEqual(['오공구독']);
  });
  it('쪽 나눔: 총수가 없으면 요청 크기보다 작은 쪽에서 멈추지 않고 빈 쪽까지 읽는다, 상한 초과·총수 불일치·읽는 도중 스냅숏 변경은 불완전', async () => {
    const pages: Record<number, unknown[]> = { 1: [row(1, '100하1111'), row(2, '100하2222')], 2: [row(3, '100하3333')], 3: [] };
    const short = world(u => {
      if (!u.pathname.endsWith('/vehicles')) { const id = Number(u.pathname.split('/').at(-1)); return json(detail(id, `100하${String(id).repeat(4)}`)); }
      return json(u.searchParams.get('tab') === 'sub' ? pages[Number(u.searchParams.get('page'))] ?? [] : []);
    }, false);
    const read = await readSonogongApi(short.client);
    expect(read.complete).toBe(true);
    expect(read.records.map(r => r.plate!.slice(-4))).toEqual(['1111', '2222', '3333']);   // 전에는 1쪽(2건 < 50)에서 끝나 3333 을 놓쳤다
    // 끝없이 차 있는 쪽 → 상한(maxPages) 초과 = 불완전
    let n = 0;
    const endless = await readSonogongApi(world(u => u.pathname.endsWith('/vehicles')
      ? json(u.searchParams.get('tab') === 'sub' ? [row(++n, `10${String(n % 10)}하${String(1000 + n)}`)] : [])
      : json(detail(1, 'x')), false).client);
    expect(endless.complete).toBe(false);
    expect(endless.incompleteReason).toBe('API_PAGE_LIMIT');
    // 총수가 있는데 모자라게 오면(뒤 쪽이 비어 있음) 불일치
    const missing = await readSonogongApi(world(u => u.pathname.endsWith('/vehicles')
      ? json(u.searchParams.get('tab') === 'sub' && u.searchParams.get('page') === '1' ? [row(1, '100하1111')] : [],
        { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: u.searchParams.get('tab') === 'sub' ? 2 : 0 })
      : json(detail(1, '100하1111')), false).client);
    expect(missing.incompleteReason).toBe('API_COUNT_MISMATCH');
    // 탭끼리 생성 시각이 달라도 이상이 아니다(탭별 스냅숏) — 요약에만 남기고 신선도는 가장 오래된 시각으로 판정한다
    const tabsDiffer = await readSonogongApi(world(u => u.pathname.endsWith('/vehicles')
      ? json(u.searchParams.get('tab') === 'sub' ? [row(1, '100하1111')] : [],
        { generatedAt: u.searchParams.get('tab') === 'sub' ? '2026-10-14T07:00:00.000Z' : '2026-10-14T06:00:00.000Z', totalCount: u.searchParams.get('tab') === 'sub' ? 1 : 0 })
      : json(detail(1, '100하1111'))).client, { tabs: ['rent', 'sub'] });
    expect(tabsDiffer.complete).toBe(true);
    expect(tabsDiffer.notes).toContain('TAB_GENERATIONS_DIFFER');
    expect(tabsDiffer.generatedAt).toBe('2026-10-14T06:00:00.000Z');
    // 한 탭 안에서 쪽마다 생성 시각이 다르면 그 탭을 다시 읽고, 그래도 섞여 있으면 불완전
    const mixedPages = (secondTotal: number) => world(u => {
      if (!u.pathname.endsWith('/vehicles')) { const id = Number(u.pathname.split('/').at(-1)); return json(detail(id, `100하${String(id).repeat(4)}`)); }
      if (u.searchParams.get('tab') !== 'sub') return json([], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: 0 });
      const page = Number(u.searchParams.get('page'));
      return page === 1 ? json([row(1, '100하1111'), row(2, '100하2222')], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: 3 })
        : json(page === 2 ? [row(3, '100하3333')] : [], { generatedAt: '2026-10-14T06:30:00.000Z', totalCount: secondTotal });
    }, false);
    // 쪽마다 판이 다르면 총수·고유 id 수가 맞아도 받지 않는다(한 대가 빠지고 다른 한 대가 들어와도 수는 같다 — Codex #666 ⑶)
    const consistent = await readSonogongApi(mixedPages(3).client);
    expect(consistent.complete).toBe(false);
    expect(consistent.incompleteReason).toBe('SNAPSHOT_CHANGED_DURING_READ');
    // 총수까지 바뀌었으면(판이 정말 바뀜) 불완전
    const changed = await readSonogongApi(mixedPages(4).client);
    expect(changed.complete).toBe(false);
    expect(changed.incompleteReason).toBe('SNAPSHOT_CHANGED_DURING_READ');
    // 겹침이 섞이면(쪽이 밀림) 불완전
    const overlapped = await readSonogongApi(world(u => {
      if (!u.pathname.endsWith('/vehicles')) { const id = Number(u.pathname.split('/').at(-1)); return json(detail(id, `100하${String(id).repeat(4)}`)); }
      if (u.searchParams.get('tab') !== 'sub') return json([], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: 0 });
      const page = Number(u.searchParams.get('page'));
      return page === 1 ? json([row(1, '100하1111'), row(2, '100하2222')], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: 3 })
        : json(page === 2 ? [row(2, '100하2222'), row(3, '100하3333')] : [], { generatedAt: '2026-10-14T06:30:00.000Z', totalCount: 3 });
    }, false).client);
    expect(overlapped.complete).toBe(false);
    expect(overlapped.incompleteReason).toBe('SNAPSHOT_CHANGED_DURING_READ');
    // generatedAt 이 없는 쪽은 판정에 쓰지 않는다
    const none = await readSonogongApi(world(u => u.pathname.endsWith('/vehicles')
      ? json(u.searchParams.get('tab') === 'sub' ? [row(1, '100하1111')] : [], {})
      : json(detail(1, '100하1111'))).client);
    expect(none.complete).toBe(true);
  });
  it('읽는 동안 목록이 바뀌어 상세의 번호가 다른 차는 그 차만 보류하고 나머지는 정상 반영한다, 많이 바뀌었을 때만 회차를 불완전로 둔다', async () => {
    const rows = [row(1, '100하1111'), row(2, '100하2222'), row(3, '100하3333')];
    const one = await readSonogongApi(world(u => {
      if (u.pathname.endsWith('/vehicles')) return json(u.searchParams.get('tab') === 'sub' ? rows : [], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: u.searchParams.get('tab') === 'sub' ? 3 : 0 });
      const id = Number(u.pathname.split('/').at(-1));
      return json(detail(id, id === 2 ? '100하9999' : `100하${String(id).repeat(4)}`));   // 2번 차만 상세의 번호가 다르다
    }).client);
    expect(one.complete).toBe(true);
    expect(one.records.map(r => r.plate!.slice(-4)).sort()).toEqual(['1111', '3333']);
    expect(one.held).toEqual([{ tab: 'sub', reason: 'IDENTITY_MISMATCH' }]);
    expect(one.notes).toContain('IDENTITY_MISMATCH_HELD:1');
    // 목록의 10%·5대를 넘게 어긋나면 회차 전체 불완전
    const many = Array.from({ length: 8 }, (_, i) => row(i + 1, `100하${String(i + 1).repeat(4)}`));
    const wide = await readSonogongApi(world(u => {
      if (u.pathname.endsWith('/vehicles')) return json(u.searchParams.get('tab') === 'sub' ? many : [], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: u.searchParams.get('tab') === 'sub' ? 8 : 0 });
      const id = Number(u.pathname.split('/').at(-1));
      return json(detail(id, '100하0000'));   // 전부 어긋남
    }).client);
    expect(wide.complete).toBe(false);
    expect(wide.incompleteReason).toBe('API_IDENTITY_MISMATCH');
  });
  it('최초등록일은 상세의 실제 칸이 있을 때만, 연료는 공통 별칭으로 바꾸고 모르면 비운다(원문은 raw 에 보존)', async () => {
    const read = await readSonogongApi(world(u => {
      if (u.pathname.endsWith('/vehicles')) return json(u.searchParams.get('tab') === 'sub'
        ? [row(1, '100하1111', { fuel: 'HEV' }), row(2, '100하2222', { fuel: '가솔린+전기' }), row(3, '100하3333', { fuel: '휘발유' }), row(4, '100하4444', { fuel: 'GSL' })] : []);
      const id = Number(u.pathname.split('/').at(-1));
      return json(detail(id, `100하${String(id).repeat(4)}`, id === 1 ? { firstRegistrationDate: '2023-07-15' } : id === 2 ? { firstRegistrationDate: '2023-02-30' } : {}));
    }).client);
    const by = Object.fromEntries(read.records.map(r => [r.plate!.slice(-4), r.raw.spec as Record<string, string>]));
    expect(by['1111']).toMatchObject({ fuel_type: '하이브리드', first_registration_date: '2023-07-15', manufacture_year_month: '2023-05', year: '2023' });
    expect(by['2222']).toMatchObject({ fuel_type: '하이브리드' });       // 대표 2026-10-19 연료 별칭 표: «가솔린+전기» → 하이브리드(차명에 플러그인/PHEV 가 있으면 보류)
    expect(by['2222']).not.toHaveProperty('first_registration_date');    // 없는 날짜는 거른다
    expect((read.records.find(r => r.plate!.endsWith('2222'))!.raw.list as Record<string, unknown>).fuel).toBe('가솔린+전기');
    expect(by['3333']).toMatchObject({ fuel_type: '가솔린' });
    expect(by['4444']).not.toHaveProperty('fuel_type');                  // 표에 없는 표기는 추정하지 않는다
    expect(read.notes).toContain('FUEL_UNRESOLVED:1');
  });
  it('보류된 행(상태 미상·ID 없음)은 다른 탭의 같은 번호 정상 행을 가리지 않는다, 정상 행끼리는 rent > sub(픽업구독 탭은 읽지 않음)', async () => {
    const read = await readSonogongApi(world(u => {
      if (u.pathname.endsWith('/vehicles')) {
        const tab = u.searchParams.get('tab');
        if (tab === 'rent') return json([row(1, '100하1111', { tab: 'rent', hasActiveContract: null }), row(2, '100하2222', { id: null, tab: 'rent' }),
          row(3, '100하3333', { tab: 'rent', prices: { RENT_RETURN: { monthly: { 36: 500000 } } } })]);
        if (tab === 'sub') return json([row(11, '100하1111'), row(12, '100하2222'), row(13, '100하3333')]);
        return json([row(21, '100하1111', { tab: 'pick' })]);
      }
      const id = Number(u.pathname.split('/').at(-1));
      return json(detail(id, `100하${String(id % 10).repeat(4)}`));
    }).client, { tabs: ['rent', 'sub'] });
    expect(read.records.map(r => [r.plate!.slice(-4), r.raw.tab])).toEqual([['3333', 'rent'], ['1111', 'sub'], ['2222', 'sub']]);
    expect(read.held.map(h => h.reason)).toEqual(['STATUS_UNKNOWN', 'ID_MISSING']);
    expect(read.notes).toContain('CROSS_TAB_DUPLICATE:1');   // sub 3333(rent 채택). pick 1111 은 요청 자체를 하지 않는다
    expect(read.duplicatePlates).toEqual([]);
  });
  it('행 수 하한과 정책 상수', () => {
    expect(sonogongApiRowFloor(100, 0)).toBe(80);
    expect(sonogongApiRowFloor(10, 200)).toBe(160);
    expect(SONOGONG_API_POLICY.pageSize).toBeLessThanOrEqual(50);
    expect(SONOGONG_API_POLICY.minIntervalMs).toBeGreaterThanOrEqual(1000);
    // 대표 2026-10-28 «ㅇㅇ 손오공 구독은 연동하고 나머지는 다 내리고»: 읽는 탭 = 오공구독, 결정 하향 구분 = 중고렌트·픽업구독
    expect(SONOGONG_API_TABS).toEqual(['sub']);
    expect(SONOGONG_WITHDRAWN_PRODUCT_TYPES).toEqual(['중고렌트', '픽업구독']);
  });
});

describe('손오공 공식 API 대여료 천원 미만 절사(대표 2026-10-19)', () => {
  it('정리값만 절사, 원문은 record.raw.prices 와 term.raw.source_monthly_rent 에 보존, 보증금 산출식도 절사 대여료로', async () => {
    const sub = { SUBSCRIBE_RETURN: { monthly: { 12: 929381, 24: 1000999, 36: 929000 }, deposit: { 12: 0, 24: 0, 36: 0 } } };
    const read = await readSonogongApi(world(u => u.pathname.endsWith('/vehicles')
      ? json(u.searchParams.get('tab') === 'sub' ? [row(1, '100하1111', { prices: sub })] : [])
      : json(detail(1, '100하1111', { prices: sub }))).client);
    const r = read.records[0]!;
    expect(r.terms.map(t => [t.months, t.monthlyRent.value, t.raw.source_monthly_rent, t.raw.rent_rule, t.deposit.value])).toEqual([
      [12, 929000, 929381, 'SONOGONG_RENT_TRUNCATE_1000', 929000],
      [24, 1000000, 1000999, 'SONOGONG_RENT_TRUNCATE_1000', 2000000],
      [36, 929000, undefined, undefined, 2787000]]);
    expect((r.raw.prices as { SUBSCRIBE_RETURN: { monthly: Record<string, number> } }).SUBSCRIBE_RETURN.monthly).toEqual({ 12: 929381, 24: 1000999, 36: 929000 });
  });
});
