import { describe, expect, it, vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import publicSchema from '../contracts/public-product-feed-v1.schema.json' with { type: 'json' };
import { createConsumerGateway, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { publicRuntimeStatsForTest, resetPublicRuntimeForTest } from '../src/api/consumer-gateway.js';
import { buildPublicProductFeed } from '../src/api/public-product-feed.js';
import type { CatalogCompatibilitySnapshot } from '../src/infra/erp5-compat-catalog-reader.js';

const token = 'test-service-token-0123456789abcdef';
const bindings: ConsumerBinding[] = [
  { id: 'erp-com', projectionId: 'erp-public', token },
  { id: 'whitelabel-test', projectionId: 'erp-public', token: token + '-wl' },
];

const snapshot = (products: Record<string, Record<string, unknown>>): CatalogCompatibilitySnapshot => ({
  schema: 'freepass-data.catalog-compat/v1',
  data: {
    products,
    policies: {
      POLICY_PUBLIC: {
        policy_name: 'PUBLIC_BASIC',
        insurance_included: true,
        annual_mileage: 20000,
      },
    },
    partners: {},
    users: {},
  },
  meta: {
    consumerId: 'erp-com',
    authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE',
    sourceProject: 'freepasserp5',
    observedAt: '2026-10-10T00:00:00.000Z',
    collectionCounts: { products: Object.keys(products).length, policy: 1 },
    depositEvidenceVersion: 'catalog-compat-deposit/1',
  },
});

const product = (extra: Record<string, unknown> = {}) => ({
  _key: 'P1',
  product_code: 'P1',
  publicProductKey: 'P1',
  listable: true,
  provider_company_code: 'RP_TEST',
  partner_code: 'RP_TEST',
  whitelabels: ['test'],
  maker: '테스트제조사',
  model: '테스트모델',
  trim_name: '테스트트림',
  product_type: 'USED_SUBSCRIPTION',
  status_kind: '가용',
  policy_id: 'POLICY_PUBLIC',
  image_urls: ['https://example.test/public-car.jpg'],
  price: {
    '36': { rent: 500000, deposit: 1000000, depositState: 'AMOUNT' },
  },
  supplierBillingFee: 1,
  channelPayoutFee: 1,
  margin: 1,
  vin: 'TEST_ONLY_NOT_REAL',
  ...extra,
});

const appWith = (snap: CatalogCompatibilitySnapshot) => {
  const access = new DataAccessGateway(new MemoryDataAccessLogStore());
  return createConsumerGateway(
    { getActive: async () => null, getManifest: async () => null, listProjectionLineage: async () => [] },
    bindings,
    access,
    undefined,
    { read: async () => snap },
  );
};

describe('public product feed v1', () => {
  it('builds products from the allowlist and excludes internal fields and vin', () => {
    const feed = buildPublicProductFeed(snapshot({ P1: product() }), { p: 'RP_TEST', wl: 'test' });
    expect(feed.count).toBe(1);
    expect(feed.products[0]).toMatchObject({
      publicProductKey: 'P1',
      product_code: 'P1',
      maker: '테스트제조사',
      price: { '36': { rent: 500000, deposit: 1000000, depositState: 'AMOUNT' } },
    });
    expect(JSON.stringify(feed)).not.toContain('supplierBillingFee');
    expect(JSON.stringify(feed)).not.toContain('channelPayoutFee');
    expect(JSON.stringify(feed)).not.toContain('"vin"');
  });

  it('keeps provider and whitelabel fences server-side', () => {
    const feed = buildPublicProductFeed(snapshot({
      P1: product(),
      P2: product({ _key: 'P2', product_code: 'P2', publicProductKey: 'P2', provider_company_code: 'OTHER', partner_code: 'OTHER' }),
      P3: product({ _key: 'P3', product_code: 'P3', publicProductKey: 'P3', whitelabels: ['other'] }),
    }), { p: 'RP_TEST', wl: 'test' });
    expect(feed.products.map((item) => item.product_code)).toEqual(['P1']);
  });

  it('resolves public quote code and rejects caller-selected internal consumer identity', async () => {
    const app = appWith(snapshot({ P1: product() }));
    const ok = await app.inject({ url: '/v1/public/catalog/quote?code=P1&wl=test&consumerId=freepass-admin-catalog&collection=products' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().product.product_code).toBe('P1');
    const missing = await app.inject({ url: '/v1/public/catalog/quote?code=NOPE&wl=test' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('fails response creation when public text contains fee words or percent text', () => {
    expect(() => buildPublicProductFeed(snapshot({ P1: product({ note: '수수료 안내' }) }), {})).toThrow();
    expect(() => buildPublicProductFeed(snapshot({ P1: product({ options: '할인 10%' }) }), {})).toThrow();
  });

  it('fails response creation when any string value contains a VIN-like value or va_ UID', () => {
    const fakeVin = '1HGCM82633A004352';
    const cases = [
      { note: `memo ${fakeVin}` },
      { options: `option ${fakeVin}` },
      { _key: `public_${fakeVin}` },
      { image_urls: [`https://example.test/${fakeVin}.jpg`] },
      { photo_link: `https://example.test/va_internal_asset_123.jpg` },
      { note: 'memo_va_secret1234' },
    ];
    for (const [index, extra] of cases.entries()) {
      expect(() => buildPublicProductFeed(snapshot({ P1: product({ ...extra, product_code: `P${index + 1}`, publicProductKey: `P${index + 1}` }) }), {})).toThrow();
    }
  });

  it('preserves compatibility deposit state without recalculating deposit', () => {
    const feed = buildPublicProductFeed(snapshot({
      P1: product({ price: { '36': { rent: 500000, deposit: 0, depositState: 'VERIFIED_NO_DEPOSIT' } } }),
      P2: product({ _key: 'P2', product_code: 'P2', publicProductKey: 'P2', price: { '36': { rent: 500000, deposit: 0, depositState: 'UNKNOWN' } } }),
    }), {});
    expect(feed.products[0]!.price['36']).toEqual({ rent: 500000, deposit: 0, depositState: 'VERIFIED_NO_DEPOSIT' });
    expect(feed.products[1]!.price['36']).toEqual({ rent: 500000, deposit: null, depositState: 'UNKNOWN' });
  });

  it('returns 503 when schema validation fails before response export', async () => {
    const app = appWith(snapshot({ P1: product({ publicProductKey: 'bad key' }) }));
    const response = await app.inject({ url: '/v1/public/catalog/feed' });
    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it('logs public route failures without message text or values', async () => {
    const app = appWith(snapshot({}));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await app.inject({ url: '/v1/public/catalog/feed?p=bad-secret&wl=test&token=secret-token&plate=12가3456' });
      expect(response.statusCode).toBe(400);
      expect(spy).toHaveBeenCalled();
      const logged = String(spy.mock.calls.at(-1)?.[0] ?? '');
      const parsed = JSON.parse(logged);
      expect(parsed).toMatchObject({ event: 'route_error', route: '/v1/public/catalog/feed', stage: 'public_feed' });
      expect(logged).not.toContain('bad-secret');
      expect(logged).not.toContain('secret-token');
      expect(logged).not.toContain('12가3456');
      expect(logged).not.toContain('PUBLIC_PROVIDER_INVALID');
    } finally {
      spy.mockRestore();
      await app.close();
    }
  });

  it('rate limits public routes by request.ip and ignores forged forwarded headers', async () => {
    process.env.FREEPASS_PUBLIC_TRUST_PROXY_HOPS = '0';
    resetPublicRuntimeForTest();
    const app = appWith(snapshot({ P1: product() }));
    let response;
    for (let i = 0; i < 121; i++) {
      response = await app.inject({ url: '/v1/public/catalog/feed', headers: { 'x-forwarded-for': `198.51.100.${i}` } });
    }
    expect(response!.statusCode).toBe(429);
    expect(response!.headers['retry-after']).toBe('30');
    expect(publicRuntimeStatsForTest().rateLimitEntries).toBe(1);
    await app.close();
    delete process.env.FREEPASS_PUBLIC_TRUST_PROXY_HOPS;
  });

  it('trusts only the last configured proxy hop for public rate limiting', async () => {
    process.env.FREEPASS_PUBLIC_TRUST_PROXY_HOPS = '1';
    resetPublicRuntimeForTest();
    const app = appWith(snapshot({ P1: product() }));
    let response;
    for (let i = 0; i < 121; i++) {
      response = await app.inject({
        url: '/v1/public/catalog/feed',
        remoteAddress: '10.0.0.10',
        headers: { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.10` },
      });
    }
    expect(response!.statusCode).toBe(429);
    expect(publicRuntimeStatsForTest().rateLimitEntries).toBe(1);
    await app.close();
    delete process.env.FREEPASS_PUBLIC_TRUST_PROXY_HOPS;
  });

  it('bounds public cache and rate-limit maps under arbitrary public query values', async () => {
    resetPublicRuntimeForTest();
    const app = appWith(snapshot({ P1: product() }));
    for (let i = 0; i < 80; i++) {
      await app.inject({ url: `/v1/public/catalog/feed?p=RP_${i}` });
    }
    for (let i = 0; i < 5000; i++) {
      await app.inject({
        url: `/v1/public/catalog/feed?p=bad-${i}&wl=unknown-${i}`,
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
      });
    }
    expect(publicRuntimeStatsForTest().cacheEntries).toBeLessThanOrEqual(64);
    expect(publicRuntimeStatsForTest().rateLimitEntries).toBeLessThanOrEqual(4096);
    await app.close();
  });

  it('keeps schema objects closed and avoids unknown schema type', () => {
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const rec = node as Record<string, unknown>;
      expect(rec.type).not.toBe('unknown');
      if (rec.type === 'object' || (Array.isArray(rec.type) && rec.type.includes('object'))) {
        expect(rec.additionalProperties).toBe(false);
      }
      for (const value of Object.values(rec)) visit(value);
    };
    visit(publicSchema);
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(publicSchema);
    expect(ajv.getSchema('https://freepass.teamjpk.com/contracts/public-product-feed-v1.schema.json#/$defs/feed')).toBeTruthy();
  });
});
