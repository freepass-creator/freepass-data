import { describe, expect, it } from 'vitest';
import { createAutoplusHomepageClient, collectAutoplusHomepage, type AutoplusHomepageClient } from '../src/adapters/autoplus-homepage.js';

const html = '<script>var RB_TOKEN = "t0";</script><input name="_csrf" value="c1">';
const make = (post: { ok?: boolean; status?: number; body: unknown }, pageStatus = 200) => createAutoplusHomepageClient({
  sleep: async () => undefined,
  fetcher: (async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return { ok: post.ok ?? true, status: post.status ?? 200, text: async () => JSON.stringify(post.body), headers: { get: () => null } };
    return { ok: pageStatus < 400, status: pageStatus, text: async () => html, headers: { get: () => 'JSESSIONID=s; Path=/', getSetCookie: () => ['JSESSIONID=s; Path=/'] } };
  }) as never,
});
const product = { productId: 'C12345678901', url: 'https://www.reborncar.co.kr/rent/ab12/C12345678901' };
const data = { productId: 'C12345678901', carNumber: '12가3456' };

describe('오토플러스 상세 성공 판정(독립 검토 2026-10-14)', () => {
  it('requires HTTP 200, a zero resultCode and a matching product id', async () => {
    expect(await make({ body: { header: { resultCode: '0' }, data } }).detail(product)).toMatchObject({ ok: true });
    expect(await make({ ok: false, status: 500, body: { header: { resultCode: '0' }, data } }).detail(product)).toMatchObject({ ok: false, code: 'DETAIL_HTTP_500' });
    expect(await make({ body: { header: { resultCode: '1010' }, data } }).detail(product)).toMatchObject({ ok: false, code: 'RESULT_1010' });
    expect(await make({ body: { header: { resultCode: '0' }, data: { ...data, productId: 'C99999999999' } } }).detail(product)).toMatchObject({ ok: false, code: 'PRODUCT_ID_MISMATCH' });
  });

  it('judges the HTTP status first: 500/201 with a 1400 resultCode or data is a failure, never an exclusion or a success', async () => {
    expect(await make({ ok: false, status: 500, body: { header: { resultCode: '1400' } } }).detail(product)).toMatchObject({ ok: false, code: 'DETAIL_HTTP_500' });
    expect(await make({ status: 201, body: { header: { resultCode: '0' }, data } }).detail(product)).toMatchObject({ ok: false, code: 'DETAIL_HTTP_201' });
    expect(await make({ body: { header: { resultCode: '1400' } } }).detail(product)).toMatchObject({ ok: false, code: 'RESULT_1400' });   // 200 + 1400 만 제외 후보
  });

  it('sitemap floor: 0 when nothing is exposed (even with a large previous count), else the larger of 95% exposed and 80% previous', async () => {
    const { autoplusSitemapFloor } = await import('../src/adapters/autoplus-homepage.js');
    expect(autoplusSitemapFloor(0, 1000)).toBe(0);
    expect(autoplusSitemapFloor(100, 0)).toBe(95);
    expect(autoplusSitemapFloor(100, 1000)).toBe(800);
  });

  it('only an explicit resultCode 1400 is excluded; a plain HTTP 400 page is a failure', async () => {
    const client: AutoplusHomepageClient = {
      listProductUrls: async () => [1, 2].map(i => ({ productId: `C1234567890${i}`, url: `https://x/C1234567890${i}` })),
      detail: async p => p.productId.endsWith('1') ? { ok: false, productId: p.productId, code: 'PAGE_HTTP_400' } : { ok: false, productId: p.productId, code: 'RESULT_1400' },
    };
    const out = await collectAutoplusHomepage(client, undefined, { maxExcludedRatio: 1 });
    expect(out.failures).toEqual([{ productId: 'C12345678901', code: 'PAGE_HTTP_400' }]);
    expect(out.excluded).toEqual(['C12345678902']);
    expect(out.complete).toBe(false);
  });

  it('a closed but partial sitemap below the expected floor is incomplete', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => String(i).padStart(11, '0'));
    const client: AutoplusHomepageClient = {
      listProductUrls: async () => ids.map(id => ({ productId: `C${id}`, url: `https://x/C${id}` })),
      detail: async p => ({ ok: true, productId: p.productId, data: { productId: p.productId, carNumber: `12가${p.productId.slice(-4)}`,
        rentPriceObjs: JSON.stringify([{ rentMonth: 36, rentPrice2: 500000 }]) } }),
    };
    expect(await collectAutoplusHomepage(client, undefined, { minExpectedProducts: Math.ceil(100 * 0.95) })).toMatchObject({ complete: false, incompleteReason: 'SITEMAP_SHRUNK' });
    expect((await collectAutoplusHomepage(client, undefined, { minExpectedProducts: 0 })).complete).toBe(true);   // 노출 0 → 하한 0, 편입 허용
  });
});
