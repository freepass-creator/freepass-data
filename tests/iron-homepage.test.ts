import { describe, expect, it } from 'vitest';
import { parseIronListingPage, parseIronDetail, readIronHomepage, parseIronSitemapIds, ironDeposit, ironMileage, ironOdometer, ironStatusFromBadges, ironFloorRecords,
  IRON_HOMEPAGE_POLICY, IRON_PHOTO_POLICY, IRON_SITEMAP_PROBE_MAX, ironFetchFailure } from '../src/adapters/iron-homepage.js';
import { sourceCyclePlugin } from '../src/adapters/source-cycle-plugins.js';
import { judgeSonogongApiRead } from '../src/adapters/sonogong-api-guards.js';
import { validateSourceRecord } from '../src/domain/source-engine.js';
import { planSourceCycle } from '../src/application/source-cycle.js';

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
    expect(parseIronListingPage(listPage(card('a1'), '/vehicles?condition=new&amp;page=2'), `${BASE}/vehicles?condition=new`, 'new').nextUrl)
      .toBe(`${BASE}/vehicles?condition=new&page=2`);
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
      [`${BASE}/vehicles?condition=new`]: listPage(card('n1') + card('n2', true), '/vehicles?condition=new&amp;page=2'),
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
    expect(calls.length).toBe(8);                                                   // 목록 3 + 사이트맵 1(없음 → 기존 기준) + 상세 4
    expect(read.notes).toContain('IRON_SITEMAP_UNAVAILABLE');
    expect(sleeps.every(ms => ms === IRON_HOMEPAGE_POLICY.minIntervalMs)).toBe(true);
    expect(sleeps.length).toBe(7);                                                  // 첫 요청만 간격 없음
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

  it('photos: keeps the supabase photo bucket host (direct and via /_next/image), https only, strict path allow-list', () => {
    const bucket = `https://${IRON_PHOTO_POLICY.host}${IRON_PHOTO_POLICY.pathPrefix}vehicle-products/x1.webp`;
    const html = detail('12가3456', { img: `/_next/image?url=${encodeURIComponent(bucket)}&amp;w=640` })
      .replace('<img src="https://ironrentcar.com/b.jpg"/>', `<img src="${bucket.replace('x1', 'x2')}"/><img src="http://${IRON_PHOTO_POLICY.host}${IRON_PHOTO_POLICY.pathPrefix}x3.webp"/>` +
        `<img src="https://${IRON_PHOTO_POLICY.host}/storage/v1/object/public/other-bucket/x4.webp"/><img src="https://evil.example/x5.webp"/>`);
    expect(parseIronDetail(html, listing(), 't').raw.images).toEqual([bucket, bucket.replace('x1', 'x2')]);
  });

  it('deposit: 0원·없음·무보증 are ZERO (not UNKNOWN); numbers are KNOWN; missing block is UNKNOWN', () => {
    for (const d of ['0원', '없음', '무보증', '0만원']) {
      expect(parseIronDetail(detail('12가3456', { deposit: d }), listing(), 't').terms.map(t => t.deposit)).toEqual([{ state: 'ZERO', value: 0 }, { state: 'ZERO', value: 0 }]);
    }
    expect(ironDeposit('보증금 150만원')).toEqual({ state: 'KNOWN', value: 1_500_000 });
    expect(ironDeposit('')).toEqual({ state: 'UNKNOWN', value: null });
    expect(ironDeposit('보증금 문의')).toEqual({ state: 'UNKNOWN', value: null });
  });

  it('normalizes explicit won/thousand/ten-thousand units without guessing bare numbers or rounding', () => {
    for (const label of ['보증금 2만원', '보증금 20,000원']) expect(ironDeposit(label)).toEqual({state:'KNOWN',value:20_000});
    expect(ironDeposit('보증금 2,000천원')).toEqual({state:'KNOWN',value:2_000_000});
    expect(ironDeposit('보증금 2,000원')).toEqual({state:'KNOWN',value:2_000});
    for (const label of ['보증금 2000', '보증금 2만', '보증금 -2만원', '보증금 1~2만원', '보증금 1만원 또는 2만원', '보증금 1.2원', '보증금 2%', '보증금 1억2만원', '보증금 .5만원', '무보증 또는 2만원', '50만원대', '50만원 이상', '월 39만원부터', '－50,000원', '(5,000원)', '1～2만원', '1〜2만원']) {
      expect(ironDeposit(label), label).toEqual({state:'UNKNOWN',value:null});
    }
    const record = parseIronDetail(detail('12가3456', {rent:[[72,'월 700천원']],deposit:'2,000천원'}), listing(), '2026-10-17T00:00:00Z');
    expect(record.terms[0]).toMatchObject({months:72,monthlyRent:{state:'KNOWN',value:700_000},deposit:{state:'KNOWN',value:2_000_000},raw:{rent_text:'월 700천원',deposit_text:'보증금 2,000천원',normalized_amount_unit:'KRW'}});
    expect(record.raw.price_rows).toEqual([{period:'72개월',rent:'월 700천원',rent_html:'월 700천원'}]);
    const unknown = parseIronDetail(detail('12가3456', {rent:[[72,'월 2000']]}), listing(), 't');
    expect(unknown.terms[0]!.monthlyRent).toEqual({state:'UNKNOWN',value:null});
    expect(unknown.raw.price_rows).toEqual([{period:'72개월',rent:'월 2000',rent_html:'월 2000'}]);
    expect(ironDeposit('무보증 36개월')).toEqual({state:'ZERO',value:0});
    expect(ironDeposit('보증금 1천만원')).toEqual({state:'KNOWN',value:10_000_000});
    expect(ironDeposit('보증금 1억원')).toEqual({state:'KNOWN',value:100_000_000});
    expect(ironDeposit('보증금 1.200만원')).toEqual({state:'UNKNOWN',value:null});
  });

  it('excludes an explicit no-offer period only, keeping valid periods sellable and updateable', () => {
    const at='2026-10-17T00:00:00Z';
    for(const noOffer of ['문의','-','협의']) {
      const prior=parseIronDetail(detail('12가3456'),listing(),at);
      const next=parseIronDetail(detail('12가3456',{rent:[[12,noOffer],[36,'월 80만원'],[72,'월 1천만원']]}),listing(),at);
      expect(next.terms.map(t=>[t.months,t.monthlyRent.value])).toEqual([[36,800000],[72,10_000_000]]);
      expect(next.raw.price_rows).toHaveLength(3);
      expect(validateSourceRecord(next)).toEqual([]);
      const result=planSourceCycle({sourceId:'RP006',family:'OTHER',maxDowngradeRatio:1},
        {records:[next],complete:true,observedAt:at,heldCount:0},
        {products:[{record:prior,listable:true,locked_by_contract:false,publication_withdrawal:null,publication_withdrawal_prior:null}],complete:true},Date.parse(at));
      expect(result.plan.entries[0]).toMatchObject({kind:'UPDATE',after:{listable:true}});
      expect(result.plan.entries[0]!.after.record.terms[0]!.monthlyRent.value).toBe(800000);
    }
  });

  it('holds implausible monthly amounts instead of accepting unit errors or tiny values', () => {
    for(const value of ['월 39원','월 39,000,000만원','월 007원']) {
      const r=parseIronDetail(detail('12가3456',{rent:[[12,value]]}),listing(),'2026-10-17T00:00:00Z');
      expect(r.terms[0]!.monthlyRent).toEqual({state:'UNKNOWN',value:null});
      expect(validateSourceRecord(r)).toContain('TERMS_HOLD');
    }
  });

  it('status: 계약 synonyms → 계약중(sellable, provider spelling kept), sold words → not sellable, unknown/mixed badges hold', () => {
    const st = (badges: string[], sold = false) => parseIronDetail(detail('12가3456', { badges }), listing('v1', sold), 't');
    expect(st(['예약중']).status).toEqual({ raw: '계약중', saleAvailable: true });
    expect(st(['예약중']).raw.provider_status).toBe('예약중');
    expect(st(['계약중']).status).toEqual({ raw: '계약중', saleAvailable: true });
    for (const b of ['출고완료', '판매완료', '출고불가']) expect(st([b]).status).toEqual({ raw: '출고불가', saleAvailable: false });
    expect(st(['출고협의']).status).toEqual({ raw: '출고협의', saleAvailable: true });
    expect(st(['출고대기']).status.saleAvailable).toBeNull();                          // 모르는 배지 → 판매 가능으로 추정하지 않는다
    expect(st(['출고대기']).raw.status_hold).toBe('STATUS_UNKNOWN');
    expect(st(['출고가능', '판매완료']).status.saleAvailable).toBeNull();               // 상태 어휘가 섞이면 보류
    expect(st(['출고가능', '판매완료']).raw.status_hold).toBe('STATUS_AMBIGUOUS');
    expect(st(['출고가능'], true).status).toEqual({ raw: '출고불가', saleAvailable: false });   // 목록 카드 판매완료가 우선
    expect(ironStatusFromBadges([], false)).toEqual({ raw: '출고협의', saleAvailable: true });   // 배지 없음 = ERP4 기준 출고협의
  });

  it('badge scope: badges outside the product badge group (e.g. similar-vehicle cards) do not change the status', () => {
    const html = detail('12가3456', { badges: ['출고가능'] }).replace('</main>',
      '<section class="similar"><article><span class="badge-pill">판매완료</span></article></section></main>');
    expect(parseIronDetail(html, listing(), 't').status).toEqual({ raw: '출고가능', saleAvailable: true });
    // 배지 묶음이 없는 페이지에서 본문 배지가 섞이면 보류(STATUS_AMBIGUOUS)
    const noGroup = html.replace('class="product-detail-badges"', 'class="x"');
    expect(parseIronDetail(noGroup, listing(), 't').raw.status_hold).toBe('STATUS_AMBIGUOUS');
  });

  it('terms: months from «N개월» (not the first number), contract mileage parsed, struck original price ignored', () => {
    const html = detail('12가3456', { rent: [[0, ''], [0, '']] })
      .replace(/<div class="product-detail-rent-row">[\s\S]*?<\/div>\s*<div class="product-detail-rent-row">[\s\S]*?<\/div>/,
        '<div class="product-detail-rent-row"><dt>연 2만km · 48개월</dt><dd><del>월 90만원</del> 월 80만원</dd></div>' +
        '<div class="product-detail-rent-row"><dt>월 2,000km · 36개월</dt><dd><s>950,000원</s>월 850,000원</dd></div>');
    const r = parseIronDetail(html, listing(), 't');
    expect(r.terms.map(t => [t.months, t.mileage, t.monthlyRent.value])).toEqual([[48, '20000km/year', 800000], [36, '2000km/month', 850000]]);
    expect(ironMileage('2만km')).toBe('20000km');
    expect(ironMileage('48개월')).toBeNull();
  });

  it('odometer: 1.2만km is 12000, commas are thousands separators', () => {
    expect(ironOdometer('1.2만km')).toBe('12000');
    expect(ironOdometer('12,345 km')).toBe('12345');
    expect(parseIronDetail(detail('12가3456').replace('12,345 km', '1.2만km'), listing(), 't').raw.spec).toMatchObject({ mileage: '12000' });
  });

  it('completeness: when the sitemap is readable, every sitemap vehicle must be in the listing (otherwise incomplete)', async () => {
    const sitemap = (ids: string[]) => `<?xml version="1.0"?><urlset>${ids.map(id => `<url><loc>${BASE}/vehicles/${id}</loc></url>`).join('')}<url><loc>${BASE}/about</loc></url></urlset>`;
    expect(parseIronSitemapIds(sitemap(['n1', 'u1']))).toEqual(['n1', 'u1']);
    expect(parseIronSitemapIds('<urlset><url><loc>x</loc></url>')).toBeNull();          // 잘린 사이트맵
    const pages: Record<string, string> = {
      [`${BASE}/vehicles?condition=new`]: listPage(card('n1')), [`${BASE}/vehicles?condition=used`]: listPage(card('u1')),
      [`${BASE}/vehicles/n1`]: detail('12가1001'), [`${BASE}/vehicles/u1`]: detail('12가1004'),
    };
    const calls: string[] = [];
    const run = (map: string, extra: Record<string, string | Error> = {}) => readIronHomepage(async url => {
      calls.push(url);
      const p = url.endsWith('/sitemap.xml') ? map : pages[url] ?? extra[url];
      if (p instanceof Error) throw p;
      if (!p) throw new Error('IRON_HTTP_404'); return p;
    }, { sleep: async () => undefined });
    expect(await run(sitemap(['n1', 'u1']))).toMatchObject({ complete: true, notes: ['IRON_SITEMAP:2:missing0:stale0'] });
    // 사이트맵에만 있는 id 의 상세가 열리면(2xx) 목록이 덜 읽힌 것 → 불완전
    expect(await run(sitemap(['n1', 'u1', 'n9']), { [`${BASE}/vehicles/n9`]: detail('12가1009') }))
      .toMatchObject({ complete: false, incompleteReason: 'IRON_LIST_SHORT_OF_SITEMAP', notes: ['IRON_SITEMAP:3:missing1:stale0'] });
  });

  it('completeness: a sitemap-only id whose detail is 404 is a stale entry, not a short listing; anything else stays incomplete', async () => {
    const sitemap = (ids: string[]) => `<?xml version="1.0"?><urlset>${ids.map(id => `<url><loc>${BASE}/vehicles/${id}</loc></url>`).join('')}</urlset>`;
    const pages: Record<string, string> = {
      [`${BASE}/vehicles?condition=new`]: listPage(card('n1')), [`${BASE}/vehicles?condition=used`]: listPage(card('u1')),
      [`${BASE}/vehicles/n1`]: detail('12가1001'), [`${BASE}/vehicles/u1`]: detail('12가1004'),
    };
    const run = async (map: string, extra: Record<string, string | Error> = {}) => {
      const calls: string[] = [];
      const read = await readIronHomepage(async url => {
        calls.push(url);
        const p = url.endsWith('/sitemap.xml') ? map : pages[url] ?? extra[url];
        if (p instanceof Error) throw p;
        if (!p) throw new Error('IRON_HTTP_404'); return p;
      }, { sleep: async () => undefined });
      return { read, calls };
    };
    // 404 → 잔재(stale): 완전, 상세 확인 요청은 그 id 에 한 번만
    const stale = await run(sitemap(['n1', 'u1', 'gone']));
    expect(stale.read).toMatchObject({ complete: true, notes: ['IRON_SITEMAP:3:missing0:stale1'] });
    expect(stale.calls.filter(u => u === `${BASE}/vehicles/gone`)).toHaveLength(1);
    expect(stale.read.records.map(r => r.plate)).toEqual(['12가1001', '12가1004']);
    // 확인 요청도 get() 을 거친다: 호스트 검사 + 500ms 간격(첫 요청 뒤 모든 요청)
    const sleeps: number[] = [];
    const spaced = await readIronHomepage(async url => { const p = url.endsWith('/sitemap.xml') ? sitemap(['n1', 'u1', 'gone']) : pages[url]; if (!p) throw new Error('IRON_HTTP_404'); return p; },
      { sleep: async ms => { sleeps.push(ms); } });
    expect(spaced.complete).toBe(true);
    expect(sleeps).toHaveLength(2 + 1 + 1 + 2 - 1);                              // 목록 2 + 사이트맵 1 + 확인 1 + 상세 2 − 첫 요청 1
    expect(sleeps.every(ms => ms === IRON_HOMEPAGE_POLICY.minIntervalMs)).toBe(true);
    // 5xx·시간 초과·HTML 아님·호스트 거부 → 확인 못 함 = 불완전 그대로(가드 약화 없음)
    for (const err of ['IRON_HTTP_500', 'IRON_HTTP_503', 'IRON_NOT_HTML', 'IRON_HOST_REJECTED', 'The operation was aborted due to timeout']) {
      const { read } = await run(sitemap(['n1', 'u1', 'x1']), { [`${BASE}/vehicles/x1`]: new Error(err) });
      expect(read, err).toMatchObject({ complete: false, incompleteReason: 'IRON_LIST_SHORT_OF_SITEMAP', notes: ['IRON_SITEMAP:3:missing1:stale0'] });
    }
    // 섞임: 404 하나 + 열리는 상세 하나 → 불완전(missing1·stale1)
    const mixed = await run(sitemap(['n1', 'u1', 'gone', 'n9']), { [`${BASE}/vehicles/n9`]: detail('12가1009') });
    expect(mixed.read).toMatchObject({ complete: false, incompleteReason: 'IRON_LIST_SHORT_OF_SITEMAP', notes: ['IRON_SITEMAP:4:missing1:stale1'] });
    // 정확히 상한(IRON_SITEMAP_PROBE_MAX)까지는 전수 확인 — 전부 404 면 완전
    const atCap = Array.from({ length: IRON_SITEMAP_PROBE_MAX }, (_, i) => `g${i}`);
    const full = await run(sitemap(['n1', 'u1', ...atCap]));
    expect(full.read).toMatchObject({ complete: true, notes: [`IRON_SITEMAP:${atCap.length + 2}:missing0:stale${atCap.length}`] });
    expect(full.calls.filter(u => /\/vehicles\/g\d+$/.test(u))).toHaveLength(atCap.length);
    // 상한을 넘게 빠지면 확인 요청 없이 불완전
    const many = Array.from({ length: IRON_SITEMAP_PROBE_MAX + 1 }, (_, i) => `m${i}`);
    const capped = await run(sitemap(['n1', 'u1', ...many]));
    expect(capped.read).toMatchObject({ complete: false, incompleteReason: 'IRON_LIST_SHORT_OF_SITEMAP', notes: [`IRON_SITEMAP:${many.length + 2}:missing${many.length}:stale0`] });
    expect(capped.calls.some(u => /\/vehicles\/m\d+$/.test(u))).toBe(false);
  });

  it('runtime fetch contract: final host is judged before HTTP status, so an external-host 404 is never a stale-sitemap 404', () => {
    const iron = `${BASE}/vehicles/x`;
    expect(ironFetchFailure({ ok: false, status: 404, url: iron }, iron)).toBe('IRON_HTTP_404');
    expect(ironFetchFailure({ ok: false, status: 404, url: 'https://evil.example/vehicles/x' }, iron)).toBe('IRON_HOST_REJECTED');   // 리다이렉트 뒤 외부 404
    expect(ironFetchFailure({ ok: true, status: 200, url: 'https://evil.example/' }, iron)).toBe('IRON_HOST_REJECTED');
    expect(ironFetchFailure({ ok: false, status: 500, url: iron }, iron)).toBe('IRON_HTTP_500');
    expect(ironFetchFailure({ ok: true, status: 200, url: '' }, iron)).toBeNull();                                                // url 비면 요청 주소로 판정
    expect(ironFetchFailure({ ok: true, status: 200, url: 'not a url' }, iron)).toBe('IRON_HOST_REJECTED');
  });

  it('the IRON plugin keeps a held (null) homepage status as null and keeps 계약중 sellable', async () => {
    const t = new Date().toISOString();
    const recs = [parseIronDetail(detail('12가1001', { badges: ['출고대기'] }), listing('a'), t), parseIronDetail(detail('12가1002', { badges: ['예약중'] }), listing('b'), t)];
    const plugin = sourceCyclePlugin({ sourceId: 'RP006', kind: 'IRON', scopes: ['homepage'], maxDowngradeRatio: 0.2 }, async () => ({ observedAt: t, complete: true,
      completedScopes: ['homepage'], visibilityComplete: true, heldCount: 0, rows: recs.map(record => ({ scope: 'homepage', record })) }));
    const out = plugin.toRecords(await plugin.read());
    expect(out.records.map(r => r.status)).toEqual([{ raw: '상태확인필요', saleAvailable: null }, { raw: '계약중', saleAvailable: true }]);
  });

  it('shrink floor compares like with like: sellable non-contracted records vs exposed unlocked docs', () => {
    const t = new Date().toISOString();
    const sellable = Array.from({ length: 5 }, (_, i) => parseIronDetail(detail(`12가100${i}`), listing(`s${i}`), t));
    const sold = Array.from({ length: 10 }, (_, i) => parseIronDetail(detail(`12나100${i}`), listing(`d${i}`, true), t));
    const contracted = parseIronDetail(detail('12다1000', { badges: ['계약중'] }), listing('c'), t);
    const records = [...sellable, ...sold, contracted];
    expect(ironFloorRecords(records)).toHaveLength(5);
    // 노출 10대 → 하한 8. 전체 16건이면 통과했지만, 판매 가능 5대는 축소(API_SHRUNK)로 막힌다.
    expect(judgeSonogongApiRead({ complete: true, records }, { exposedUnlockedDocs: 10, previousCount: 0, stateError: null }).complete).toBe(true);
    expect(judgeSonogongApiRead({ complete: true, records: ironFloorRecords(records) }, { exposedUnlockedDocs: 10, previousCount: 0, stateError: null }))
      .toMatchObject({ complete: false, incompleteReason: 'API_SHRUNK' });
  });
});
