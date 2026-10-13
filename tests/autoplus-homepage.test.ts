import { describe, expect, it, vi } from 'vitest';
import { parseSitemapProductUrls, parseBootstrap, createAutoplusHomepageClient, mapAutoplusDetail,
  collectAutoplusHomepage, compareAutoplusHomepage, type AutoplusHomepageClient } from '../src/adapters/autoplus-homepage.js';

const sitemap = `<urlset><url><loc>https://www.reborncar.co.kr/rent/ab12/C12345678901</loc></url>
<url><loc>https://www.reborncar.co.kr/rent/cd34/C12345678902</loc></url>
<url><loc>https://www.reborncar.co.kr/rent/ab12/C12345678901</loc></url>
<url><loc>https://www.reborncar.co.kr/notice/1</loc></url>
<url><loc>https://www.reborncar.co.kr/rent/ab12/not-a-product</loc></url></urlset>`;
const detail = (over: Record<string, unknown> = {}) => ({ productId: 'C12345678901', carNumber: '12가3456', apCarId: 'AP1',
  bmname: '합성제조사', boname: '합성모델', gradename: '합성트림',
  rentPriceObjs: JSON.stringify([{ rentMonth: 36, rentPrice2: 500000, rentPrice3: 450000, originPrice2: 520000, originPrice3: 470000 }, { rentMonth: 48, rentPrice2: 480000 }]),
  ...over });

describe('오토플러스 홈피 어댑터(관측 전용)', () => {
  it('lists only rent product URLs, de-duplicated by product id', () => {
    expect(parseSitemapProductUrls(sitemap).map(p => p.productId)).toEqual(['C12345678901', 'C12345678902']);
  });
  it('bootstraps from cookies, inline token and csrf input; any missing piece fails', () => {
    const html = '<script>var RB_TOKEN="jwt.token.value";</script><input type="hidden" name="_csrf" value="csrf-value">';
    expect(parseBootstrap(html, ['JSESSIONID=abc; Path=/; HttpOnly', 'X=1; Path=/'])).toEqual({ cookie: 'JSESSIONID=abc; X=1', token: 'jwt.token.value', csrf: 'csrf-value' });
    expect(parseBootstrap(html, [])).toBeNull();
    expect(parseBootstrap('<input name="_csrf" value="c">', ['A=1'])).toBeNull();
  });
  it('maps detail: plate identity, 2만/3만km terms per month, unknown deposit, no state field needed', () => {
    const mapped = mapAutoplusDetail(detail(), '2026-10-14T00:00:00Z');
    if ('hold' in mapped) throw new Error('unexpected hold');
    const r = mapped.record;
    expect(r).toMatchObject({ sourceId: 'RP023', uid: '12가3456', plate: '12가3456', vehicleText: '합성제조사 합성모델 합성트림', status: { saleAvailable: true } });
    expect(r.terms.map(t => [t.months, t.mileage, t.monthlyRent.value])).toEqual([[36, '20000km/year', 500000], [36, '30000km/year', 450000], [48, '20000km/year', 480000]]);
    expect(r.terms.every(t => t.deposit.state === 'UNKNOWN')).toBe(true);
    expect(mapAutoplusDetail(detail({ carNumber: '신차' }), 'x')).toEqual({ hold: 'PLATE_INVALID' });
    expect(mapAutoplusDetail(detail({ productId: 'x' }), 'x')).toEqual({ hold: 'PRODUCT_ID_MISSING' });
    const noPrice = mapAutoplusDetail(detail({ rentPriceObjs: '[]' }), 'x');
    expect('record' in noPrice && noPrice.record.terms).toEqual([]);          // 가격 없는 행은 항 0개로 보존(listable 은 소비 쪽 정책)
  });
  it('client: serial calls with spacing, per-product bootstrap and token refresh on 1020', async () => {
    const calls: string[] = [], slept: number[] = [];
    const html = '<script>RB_TOKEN="t0"</script><input name="_csrf" value="c0">';
    let post = 0;
    const fetcher = vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
      calls.push(`${init?.method ?? 'GET'} ${url.replace('https://www.reborncar.co.kr', '')}`);
      if (url.endsWith('sitemap-ext.xml')) return { ok: true, status: 200, text: async () => sitemap, headers: { get: () => null } };
      if (init?.method === 'POST') {
        post++;
        const body = post === 1 ? { header: { resultCode: '1020', msg: 't1' }, data: null } : { header: { resultCode: '0' }, data: detail() };
        if (post === 2) expect(init.headers!.Authorization).toBe('t1');          // 새 토큰으로 재시도
        return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } };
      }
      return { ok: true, status: 200, text: async () => html, headers: { get: () => 'JSESSIONID=s1; Path=/' } };
    });
    const client = createAutoplusHomepageClient({ fetcher: fetcher as never, sleep: async ms => { slept.push(ms); } });
    const list = await client.listProductUrls();
    const first = await client.detail(list[0]!);
    expect(first).toMatchObject({ ok: true, productId: 'C12345678901' });
    expect(slept).toEqual([60]);                                                  // 첫 상품은 간격 없음, 1020 재시도 60ms
    await client.detail(list[1]!);
    expect(slept[1]).toBe(150);                                                   // 상품 사이 150ms
    expect(calls.filter(c => c.startsWith('POST')).length).toBeGreaterThanOrEqual(3);
  });
  it('collect: any failure, hold or duplicate plate makes the collection incomplete (never used to infer absence)', async () => {
    const urls = [1, 2, 3].map(i => ({ productId: `C1234567890${i}`, url: `https://x/rent/ab12/C1234567890${i}` }));
    const results: Record<string, object> = {
      C12345678901: { ok: true, productId: 'C12345678901', data: detail() },
      C12345678902: { ok: false, productId: 'C12345678902', code: 'RESULT_1010' },
      C12345678903: { ok: true, productId: 'C12345678903', data: detail({ productId: 'C12345678903' }) },   // 같은 번호
    };
    const client: AutoplusHomepageClient = { listProductUrls: async () => urls, detail: async p => results[p.productId] as never };
    const out = await collectAutoplusHomepage(client, () => '2026-10-14T00:00:00Z');
    expect(out).toMatchObject({ complete: false, productCount: 3 });
    expect(out.failures).toEqual([{ productId: 'C12345678902', code: 'RESULT_1010' }]);
    expect(out.duplicatePlates).toEqual(['12가3456']);
    expect(out.records).toHaveLength(1);
  });
  it('compare: set differences by plate, last 4 digits only', () => {
    const records = [mapAutoplusDetail(detail(), 't'), mapAutoplusDetail(detail({ productId: 'C12345678902', carNumber: '34나7890' }), 't')]
      .map(m => ('record' in m ? m.record : null)!);
    const cmp = compareAutoplusHomepage(records, [{ plate: '12가3456', listable: true }, { plate: '99다1111', listable: true }, { plate: '34나7890', listable: false }]);
    expect(cmp).toMatchObject({ homepage: 2, exposedDocs: 2, both: 1, onlyHomepageCount: 0, exposedNotOnHomepageCount: 1, exposedNotOnHomepageLast4: ['1111'] });
  });
});
