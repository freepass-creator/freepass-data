import { describe, expect, it } from 'vitest';
import { parseIronListingPage, parseIronDetail, readIronHomepage, IRON_HOMEPAGE_POLICY } from '../src/adapters/iron-homepage.js';

// 값은 전부 가짜(합성). 구조만 실제 홈페이지의 클래스 이름을 따른다.
const BASE = IRON_HOMEPAGE_POLICY.baseUrl;
const card = (id: string, sold = false) => `<article class="rental-product-card${sold ? ' rental-product-card--sold' : ''}"><a href="/vehicles/${id}?condition=new">차량</a></article>`;
const listPage = (cards: string, next?: string) => `<!doctype html><html><body><main>${cards}${next ? `<a href="${next}">더보기</a>` : ''}</main></body></html>`;
const detail = (plate: string, opts: { title?: string; badges?: string[]; rent?: Array<[number, string]>; deposit?: string; img?: string } = {}) => `<!doctype html><html><body><main>
<h1 class="product-detail-title">${opts.title ?? '현대 아반떼 CN7 프리미엄'}</h1>
<div class="product-detail-subtitle">2.0 가솔린 · 24년식</div>
<dl><dt>차량번호</dt><dd>${plate}</dd><dt>유종</dt><dd>가솔린</dd><dt>주행거리</dt><dd>12,345 km</dd><dt>외장 색상</dt><dd>흰색</dd></dl>
${(opts.rent ?? [[12, '월 90만원'], [36, '월 70만원']]).map(([m, v]) => `<div class="product-detail-rent-row"><dt>${m}개월</dt><dd>${v}</dd></div>`).join('')}
<div class="product-detail-price-block--deposit">보증금 ${opts.deposit ?? '200만원'}</div>
<div class="product-detail-badges">${(opts.badges ?? ['출고가능']).map(b => `<span class="badge-pill">${b}</span>`).join('')}</div>
<div class="product-detail-gallery"><img src="${opts.img ?? '/_next/image?url=https%3A%2F%2Fironrentcar.com%2Fa.jpg&w=640'}"/><img src="https://ironrentcar.com/b.jpg"/></div>
</main></body></html>`;
const listing = (id = 'v1', sold = false, condition: 'new' | 'used' = 'new') => ({ id, url: `${BASE}/vehicles/${id}`, condition, sold });

describe('아이언 홈페이지 어댑터', () => {
  it('parses listing pages: ids, sold card class, and the 더보기 next link (same host only)', () => {
    const parsed = parseIronListingPage(listPage(card('a1') + card('a2', true), '/vehicles?condition=new&page=2'), `${BASE}/vehicles?condition=new`, 'new');
    expect(parsed.listings.map(l => [l.id, l.sold])).toEqual([['a1', false], ['a2', true]]);
    expect(parsed.nextUrl).toBe(`${BASE}/vehicles?condition=new&page=2`);
    expect(parseIronListingPage(listPage(card('a1'), 'https://evil.example/vehicles?page=2'), `${BASE}/vehicles`, 'new').nextUrl).toBeNull();
  });

  it('maps a detail page to an engine record: plate key, 월 요금·보증금, 배지 상태, 갤러리, 상품 구분', () => {
    const r = parseIronDetail(detail('12가3456'), listing('v1', false, 'new'), '2026-10-14T06:00:00.000Z');
    expect(r).toMatchObject({ sourceId: 'RP006', uid: '12가3456', plate: '12가3456', vehicleText: '현대 아반떼 CN7 프리미엄',
      status: { raw: '출고가능', saleAvailable: true } });
    expect(r.terms.map(t => [t.months, t.monthlyRent.value, t.deposit.value])).toEqual([[12, 900000, 2000000], [36, 700000, 2000000]]);
    expect(r.raw).toMatchObject({ product_type: '신차렌트', source_external_id: 'v1', sold: false });
    expect(r.raw.images).toEqual(['https://ironrentcar.com/a.jpg', 'https://ironrentcar.com/b.jpg']);
    expect(r.raw.spec).toMatchObject({ fuel_type: '가솔린', year: '2024', mileage: '12345' });
    expect(parseIronDetail(detail('12가3456', { badges: ['즉시출고'] }), listing('v1', false, 'used'), 't').status.raw).toBe('즉시출고');
    expect(parseIronDetail(detail('12가3456', { badges: [] }), listing('v1', false, 'used'), 't').status.raw).toBe('출고협의');
    expect(parseIronDetail(detail('12가3456'), listing('v1', false, 'used'), 't').raw.product_type).toBe('중고렌트');
  });

  it('a sold card or 판매완료 badge is not sellable (brought in as a non-exposed document by the first pass)', () => {
    const bySold = parseIronDetail(detail('12가3456'), listing('v1', true), 't');
    expect(bySold.status).toEqual({ raw: '출고불가', saleAvailable: false });
    const byBadge = parseIronDetail(detail('12가3456', { badges: ['판매완료'] }), listing('v1', false), 't');
    expect(byBadge.status).toEqual({ raw: '출고불가', saleAvailable: false });
  });

  it('rejects a missing title and an invalid plate; a price-less page still yields a record with no terms (정보 부족 편입)', () => {
    expect(() => parseIronDetail(detail('12가3456', { title: '' }), listing(), 't')).toThrow('IRON_TITLE_MISSING');
    expect(() => parseIronDetail(detail('신차'), listing(), 't')).toThrow('IRON_PLATE_INVALID');
    const noPrice = parseIronDetail(detail('12가3456', { rent: [] }), listing(), 't');
    expect(noPrice.terms).toEqual([]);
  });

  it('reads both conditions with pagination and every detail, serially, and flags failures as incomplete', async () => {
    const sleeps: number[] = [];
    const pages: Record<string, string> = {
      [`${BASE}/vehicles?condition=new`]: listPage(card('n1') + card('n2', true), '/vehicles?condition=new&page=2'),
      [`${BASE}/vehicles?condition=new&page=2`]: listPage(card('n3')),
      [`${BASE}/vehicles?condition=used`]: listPage(card('u1')),
      [`${BASE}/vehicles/n1`]: detail('12가1001'), [`${BASE}/vehicles/n2`]: detail('12가1002'),
      [`${BASE}/vehicles/n3`]: detail('12가1003'), [`${BASE}/vehicles/u1`]: detail('12가1004'),
    };
    const calls: string[] = [];
    const read = await readIronHomepage(async url => { calls.push(url); const p = pages[url]; if (!p) throw new Error('IRON_HTTP_404'); return p; },
      { now: () => '2026-10-14T06:00:00.000Z', sleep: async ms => { sleeps.push(ms); } });
    expect(read).toMatchObject({ complete: true, listed: 4, sold: 1 });
    expect(read.records.map(r => r.plate)).toEqual(['12가1001', '12가1002', '12가1003', '12가1004']);
    expect(calls.length).toBe(7);
    expect(sleeps.every(ms => ms === IRON_HOMEPAGE_POLICY.minIntervalMs)).toBe(true);
    expect(sleeps.length).toBe(6);                                                  // 첫 요청만 간격 없음
    // 상세 하나가 실패하면 읽기 불완전(부재 하향·적용 차단), 나머지는 읽는다
    delete pages[`${BASE}/vehicles/n3`];
    const partial = await readIronHomepage(async url => { const p = pages[url]; if (!p) throw new Error('IRON_HTTP_404'); return p; }, { sleep: async () => undefined });
    expect(partial.complete).toBe(false);
    expect(partial.incompleteReason).toBe('IRON_DETAIL_FAILED');
    expect(partial.records).toHaveLength(3);
    // 목록이 비면 불완전
    const empty = await readIronHomepage(async () => listPage(''), { sleep: async () => undefined });
    expect(empty).toMatchObject({ complete: false });
  });
});
