import { describe, expect, it } from 'vitest';
import { createAutoplusHomepageClient, collectAutoplusHomepage, type AutoplusHomepageClient } from '../src/adapters/autoplus-homepage.js';

const url = (id: string) => `<url><loc>https://www.reborncar.co.kr/rent/ab12/C${id}</loc></url>`;
const fetcherFor = (xml: string) => async () => ({ ok: true, status: 200, text: async () => xml, headers: { get: () => null } });

describe('오토플러스 사이트맵 완전성(독립 검토 2026-10-14)', () => {
  it('treats a truncated sitemap (no closing tag) as a read failure instead of a partial list', async () => {
    const client = createAutoplusHomepageClient({ fetcher: fetcherFor(`<urlset>${url('12345678901')}${url('12345678902')}`) as never, sleep: async () => undefined });
    await expect(client.listProductUrls()).rejects.toThrow('AUTOPLUS_SITEMAP_TRUNCATED');
    const ok = createAutoplusHomepageClient({ fetcher: fetcherFor(`<urlset>${url('12345678901')}</urlset>\n`) as never, sleep: async () => undefined });
    expect(await ok.listProductUrls()).toHaveLength(1);
  });

  const detailOf = (plate: string, id: string) => ({ ok: true as const, productId: `C${id}`, data: { productId: `C${id}`, carNumber: plate,
    rentPriceObjs: JSON.stringify([{ rentMonth: 36, rentPrice2: 500000 }]) } });
  const clientOf = (ids: string[]): AutoplusHomepageClient => ({
    listProductUrls: async () => ids.map(id => ({ productId: `C${id}`, url: `https://x/C${id}` })),
    detail: async p => detailOf(`12가${p.productId.slice(-4)}`, p.productId.slice(1)),
  });

  it('marks the read incomplete when the sitemap shrinks below the expected floor, so absence is never inferred', async () => {
    const ids = ['00000000001', '00000000002'];
    const normal = await collectAutoplusHomepage(clientOf(ids), undefined, { minExpectedProducts: 2 });
    expect(normal.complete).toBe(true);
    const shrunk = await collectAutoplusHomepage(clientOf(ids), undefined, { minExpectedProducts: 5 });
    expect(shrunk).toMatchObject({ complete: false, incompleteReason: 'SITEMAP_SHRUNK' });
  });

  it('marks the read incomplete when too many products are excluded (1400)', async () => {
    const client: AutoplusHomepageClient = {
      listProductUrls: async () => ['00000000001', '00000000002', '00000000003'].map(id => ({ productId: `C${id}`, url: `https://x/C${id}` })),
      detail: async p => p.productId.endsWith('1') ? detailOf('12가1001', '00000000001') : { ok: false, productId: p.productId, code: 'RESULT_1400' },
    };
    expect(await collectAutoplusHomepage(client)).toMatchObject({ complete: false, incompleteReason: 'EXCLUDED_RATIO_HIGH' });
  });
});
