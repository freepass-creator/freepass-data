import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import publicSchema from '../contracts/public-product-feed-v1.schema.json' with { type: 'json' };
import { createConsumerGateway, parseConsumerBindings, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { publicRuntimeStatsForTest, resetPublicRuntimeForTest } from '../src/api/consumer-gateway.js';
import { buildPublicProductFeed, buildPublicProductQuote, publicProductShareToken } from '../src/api/public-product-feed.js';
import type { CatalogCompatibilitySnapshot } from '../src/infra/erp5-compat-catalog-reader.js';

const token = 'test-service-token-0123456789abcdef';
const bindings: ConsumerBinding[] = [
  { id: 'erp-com', projectionId: 'erp-public', token },
  { id: 'whitelabel-uniplan', projectionId: 'erp-public', token: token + '-wl' },
  { id: 'erp5-public-catalog', projectionId: 'erp-public', token: token + '-erp5-catalog', capabilities: ['catalog'] },
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
  provider_company_code: 'RP013',
  partner_code: 'RP013',
  whitelabels: ['uniplan'],
  maker: '테스트제조사',
  model: '테스트모델',
  trim_name: '테스트트림',
  product_type: 'USED_SUBSCRIPTION',
  status_kind: '가용',
  policy_id: 'POLICY_PUBLIC',
  image_urls: ['https://example.test/public-car.jpg'],
  price: {
    '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' },
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
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.FREEPASS_PUBLIC_PROVIDER_ALLOWLIST;
    delete process.env.FREEPASS_PUBLIC_WHITELABEL_ALLOWLIST;
    delete process.env.FREEPASS_PUBLIC_TRUST_PROXY_HOPS;
    resetPublicRuntimeForTest();
  });

  it('keeps legacy input aliases compatible with live deposit enums and display brand', () => {
    const feed = buildPublicProductFeed(snapshot({ P1: product({ provider_company_code: 'PT-0001', provider_name: '공급사', price: {
      '24': { rent: 1, deposit: 10, depositState: 'AMOUNT' },
      '36': { rent: 1, deposit: null, depositState: 'VERIFIED_NO_DEPOSIT' },
      '48': { rent: 1, deposit: 0, depositState: 'UNKNOWN' },
      '60': { rent: 1, deposit: 0, depositState: 'NOT_APPLICABLE' },
    } }) }), { p: 'PT-0001' });
    expect(feed.brand).toBe('공급사');
    expect(feed.products[0]?.price).toEqual({
      '24': { rent: 1, deposit: 10, depositState: 'KNOWN' },
      '36': { rent: 1, deposit: 0, depositState: 'ZERO' },
      '48': { rent: 1, deposit: null, depositState: 'UNKNOWN' },
      '60': { rent: 1, deposit: null, depositState: 'NOT_APPLICABLE' },
    });
  });

  it('preserves Korean vehicle-number identity and rejects ambiguous share tokens', () => {
    const code = '100가2364';
    const snap = snapshot({ a: product({ product_code: code, _key: 'veh_183어2364', publicProductKey: code }), b: product({ product_code: code, _key: 'other', publicProductKey: 'other' }) });
    expect(buildPublicProductQuote(snap, code, {})?.product.publicProductKey).toBe(code);
    expect(buildPublicProductQuote(snap, publicProductShareToken(code), {})).toBeNull();
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(publicSchema);
    expect(ajv.getSchema('https://freepass.teamjpk.com/contracts/public-product-feed-v1.schema.json#/$defs/quote')!(buildPublicProductQuote(snap, code, {}))).toBe(true);
    expect(() => buildPublicProductQuote(snap, 'https://example.test', {})).toThrow();
    expect(() => buildPublicProductQuote(snap, '100가2364\u0000', {})).toThrow();
  });

  it('rejects ambiguous exact aliases independently of product order', () => {
    const a = product({ publicProductKey: 'a', _key: 'a', product_code: 'shared' });
    const b = product({ publicProductKey: 'b', _key: 'b', product_code: 'shared' });
    for (const entries of [{ a, b }, { b, a }]) {
      expect(buildPublicProductQuote(snapshot(entries), 'shared', {})).toBeNull();
      expect(buildPublicProductQuote(snapshot(entries), 'a', {})?.product.publicProductKey).toBe('a');
    }
    const duplicate = snapshot({ a, b: { ...b, publicProductKey: 'a' } });
    expect(buildPublicProductQuote(duplicate, 'a', {})).toBeNull();
  });

  it('photo_cache 맵({src,urls})의 드라이브 사진도 이미지 목록에 포함한다', () => {
    const quote = buildPublicProductQuote(snapshot({ P1: product({ image_urls: [], photo_cache: { src: 'https://drive.example/folder', urls: ['https://example.test/cache-0.jpg', 'https://example.test/cache-1.jpg'] } }) }), 'P1', {});
    expect(quote?.product.image_urls).toEqual(['https://example.test/cache-0.jpg', 'https://example.test/cache-1.jpg']);
  });

  it('preserves complete galleries and rejects oversized galleries', () => {
    const images = Array.from({ length: 50 }, (_, i) => `https://example.test/${i}.jpg`);
    const quote = buildPublicProductQuote(snapshot({ P1: product({ image_urls: images }) }), 'P1', {});
    expect(quote?.product.image_urls).toHaveLength(50);
    expect(() => buildPublicProductQuote(snapshot({ P1: product({ image_urls: Array.from({ length: 201 }, (_, i) => `https://example.test/${i}.jpg`) }) }), 'P1', {})).toThrow('PUBLIC_IMAGES_LIMIT');
  });

  it('resolves whole hyphenated keys before tokens and legacy share suffixes', () => {
    const snap = snapshot({ a: product({ product_code: 'PD-260506-020', _key: 'veh_PD-260506-020', publicProductKey: 'PD-260506-020' }), b: product({ product_code: 'PD', _key: 'PD', publicProductKey: 'PD' }) });
    for (const code of ['PD-260506-020', publicProductShareToken('PD-260506-020'), 'PD-260506-020-share']) {
      expect(buildPublicProductQuote(snap, code, {})?.product.product_code).toBe('PD-260506-020');
    }
    expect(buildPublicProductQuote(snap, '260506-020', {})).toBeNull();
  });

  it('builds products from the allowlist and excludes internal fields and vin', () => {
    const feed = buildPublicProductFeed(snapshot({ P1: product() }), { p: 'RP013', wl: 'uniplan' });
    expect(feed.count).toBe(1);
    expect(feed.products[0]).toMatchObject({
      publicProductKey: 'P1',
      product_code: 'P1',
      maker: '테스트제조사',
      price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } },
    });
    expect(JSON.stringify(feed)).not.toContain('supplierBillingFee');
    expect(JSON.stringify(feed)).not.toContain('channelPayoutFee');
    expect(JSON.stringify(feed)).not.toContain('"vin"');
  });

  it('registers erp5-public-catalog only with explicit catalog capability', () => {
    expect(parseConsumerBindings(JSON.stringify([
      { id: 'erp5-public-catalog', projectionId: 'erp-public', token: token + '-erp5-catalog', capabilities: ['catalog'] },
    ]))).toMatchObject([{ id: 'erp5-public-catalog', capabilities: ['catalog'] }]);
    expect(() => parseConsumerBindings(JSON.stringify([
      { id: 'erp5-public-catalog', projectionId: 'erp-public', token: token + '-implicit' },
    ]))).toThrow('ERP5 public consumer capability must be explicit');
    expect(() => parseConsumerBindings(JSON.stringify([
      { id: 'erp5-public-catalog', projectionId: 'erp-public', token: token + '-fees', capabilities: ['catalog', 'contract-fee-link-read'] },
    ]))).toThrow('ERP5 public catalog registration requires its exclusive catalog capability');
    expect(() => parseConsumerBindings(JSON.stringify([
      { id: 'erp5-public-catalog', projectionId: 'erp-public', token: token + '-photos', capabilities: ['photos'] },
    ]))).toThrow('ERP5 media registration requires its exclusive photos capability');
  });

  it('serves erp5-public-catalog through the whitelabel public exposure filter without fees, margin, vin or raw fields', async () => {
    let readConsumerId = '';
    const access = new DataAccessGateway(new MemoryDataAccessLogStore());
    const app = createConsumerGateway(
      { getActive: async () => null, getManifest: async () => null, listProjectionLineage: async () => [] },
      bindings,
      access,
      undefined,
      { read: async (consumerId) => { readConsumerId = consumerId; return snapshot({ P1: product({
        _source_row_product: { raw: 'PRIVATE_RAW', supplierBillingFee: 1 },
        price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN',
          supplierBillingFee: 1, channelPayoutFee: 1, expectedGrossMargin: { amount: 1234 } } },
      }) }); } },
    );
    const response = await app.inject({
      url: '/v1/consumers/erp5-public-catalog/catalog-compat',
      headers: { authorization: `Bearer ${token}-erp5-catalog` },
    });
    expect(response.statusCode).toBe(200);
    expect(readConsumerId).toBe('whitelabel-uniplan');
    const body = response.json();
    expect(body.meta.consumerId).toBe('erp5-public-catalog');
    expect(body.data.products.P1.price['36']).toEqual({ rent: 500000, deposit: 1000000, depositState: 'KNOWN' });
    expect(JSON.stringify(body)).not.toMatch(/supplierBillingFee|channelPayoutFee|expectedGrossMargin|margin|vin|_source_row_product|PRIVATE_RAW/);
    await app.close();
  });

  it('rejects cross-consumer tokens and non-catalog erp5-public-catalog routes without logging token plaintext', async () => {
    const app = appWith(snapshot({ P1: product() }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const erp5Token = `${token}-erp5-catalog`;
    try {
      const wrongToken = await app.inject({
        url: '/v1/consumers/erp5-public-catalog/catalog-compat',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(wrongToken.statusCode).toBe(401);
      expect(wrongToken.body).not.toContain(token);

      const wrongConsumer = await app.inject({
        url: '/v1/consumers/erp-com/catalog-compat',
        headers: { authorization: `Bearer ${erp5Token}` },
      });
      expect(wrongConsumer.statusCode).toBe(401);
      expect(wrongConsumer.body).not.toContain(erp5Token);

      const photos = await app.inject({
        url: '/v1/consumers/erp5-public-catalog/catalog-compat/products/P1/photos',
        headers: { authorization: `Bearer ${erp5Token}` },
      });
      expect(photos.statusCode).toBe(403);
      expect(photos.body).not.toContain(erp5Token);

      const health = await app.inject({
        url: '/v1/consumers/erp5-public-catalog/catalog-health',
        headers: { authorization: `Bearer ${erp5Token}` },
      });
      expect(health.statusCode).toBe(403);
      expect(health.body).not.toContain(erp5Token);

      await app.inject({
        url: '/v1/consumers/erp5-public-catalog/catalog-compat',
        headers: { authorization: `Bearer ${erp5Token}` },
      });
      const logged = spy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).not.toContain(erp5Token);
      expect(logged).not.toContain(token);
    } finally {
      spy.mockRestore();
      await app.close();
    }
  });

  it('strips source-row fee, margin and provenance from nested prices even if a downstream caller marks it listable', () => {
    const internal = { state: 'CALCULATED', amount: 123456, totalAmount: 135802, sourceRefs: ['PRIVATE_RULE'] };
    const feed = buildPublicProductFeed(snapshot({ P1: product({
      _source_row_product: { supplierBillingFee: internal, channelPayoutFee: internal },
      price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN',
        supplierBillingFee: internal, channelPayoutFee: internal, expectedGrossMargin: { amount: 1234 },
        priceSourceRefs: [{ rawRecordId: 'PRIVATE_RAW' }] } },
    }) }), { p: 'RP013', wl: 'uniplan' });
    expect(feed.count).toBe(1);
    expect(Object.keys(feed.products[0]!.price['36']!)).toEqual(['rent','deposit','depositState']);
    expect(JSON.stringify(feed)).not.toMatch(/supplierBillingFee|channelPayoutFee|expectedGrossMargin|priceSourceRefs|PRIVATE_/);
  });

  it('keeps provider and whitelabel fences server-side', () => {
    const feed = buildPublicProductFeed(snapshot({
      P1: product(),
      P2: product({ _key: 'P2', product_code: 'P2', publicProductKey: 'P2', provider_company_code: 'OTHER', partner_code: 'OTHER' }),
      P3: product({ _key: 'P3', product_code: 'P3', publicProductKey: 'P3', whitelabels: ['other'] }),
    }), { p: 'RP013', wl: 'uniplan' });
    expect(feed.products.map((item) => item.product_code)).toEqual(['P1']);
  });

  it('resolves public quote code and rejects caller-selected internal consumer identity', async () => {
    const app = appWith(snapshot({ P1: product() }));
    const ok = await app.inject({ url: '/v1/public/catalog/quote?code=P1&wl=uniplan&consumerId=freepass-admin-catalog&collection=products' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().product.product_code).toBe('P1');
    const missing = await app.inject({ url: '/v1/public/catalog/quote?code=NOPE&wl=uniplan' });
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
      P1: product({ price: { '36': { rent: 500000, deposit: 0, depositState: 'ZERO' } } }),
      P2: product({ _key: 'P2', product_code: 'P2', publicProductKey: 'P2', price: { '36': { rent: 500000, deposit: 0, depositState: 'UNKNOWN' } } }),
    }), {});
    expect(feed.products[0]!.price['36']).toEqual({ rent: 500000, deposit: 0, depositState: 'ZERO' });
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
      const response = await app.inject({ url: '/v1/public/catalog/feed?p=bad-secret&wl=uniplan&token=secret-token&plate=12가3456' });
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

  it('starts with code constants when public allowlist env is absent', async () => {
    const app = appWith(snapshot({ P1: product() }));
    const response = await app.inject({ url: '/v1/public/catalog/feed?p=RP013&wl=uniplan' });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('fails startup for empty or contradictory public allowlist env', () => {
    vi.stubEnv('FREEPASS_PUBLIC_PROVIDER_ALLOWLIST', '');
    expect(() => appWith(snapshot({}))).toThrow('FREEPASS_PUBLIC_PROVIDER_ALLOWLIST_EMPTY');
    vi.stubEnv('FREEPASS_PUBLIC_PROVIDER_ALLOWLIST', 'RP999');
    expect(() => appWith(snapshot({}))).toThrow('FREEPASS_PUBLIC_PROVIDER_ALLOWLIST_OUTSIDE_CODE_CONSTANT');
    vi.stubEnv('FREEPASS_PUBLIC_PROVIDER_ALLOWLIST', 'RP013');
    vi.stubEnv('FREEPASS_PUBLIC_WHITELABEL_ALLOWLIST', '');
    expect(() => appWith(snapshot({}))).toThrow('FREEPASS_PUBLIC_WHITELABEL_ALLOWLIST_EMPTY');
    vi.stubEnv('FREEPASS_PUBLIC_WHITELABEL_ALLOWLIST', 'unknown');
    expect(() => appWith(snapshot({}))).toThrow('FREEPASS_PUBLIC_WHITELABEL_ALLOWLIST_OUTSIDE_CODE_CONSTANT');
  });

  it('rejects unknown provider before reader, cache or in-flight key creation', async () => {
    let reads = 0;
    const access = new DataAccessGateway(new MemoryDataAccessLogStore());
    const app = createConsumerGateway(
      { getActive: async () => null, getManifest: async () => null, listProjectionLineage: async () => [] },
      bindings,
      access,
      undefined,
      { read: async () => { reads++; return snapshot({ P1: product() }); } },
    );
    const response = await app.inject({ url: '/v1/public/catalog/feed?p=RP999&wl=uniplan' });
    expect(response.statusCode).toBe(400);
    expect(reads).toBe(0);
    expect(publicRuntimeStatsForTest().cacheEntries).toBe(0);
    expect(publicRuntimeStatsForTest().inFlightEntries).toBe(0);
    await app.close();
  });

  it.each([
    ['/v1/public/catalog/feed?p=RP999&p=RP998&wl=uniplan', 'duplicate provider'],
    ['/v1/public/catalog/feed?p=RP013&wl=uniplan&wl=eancar', 'duplicate whitelabel'],
    ['/v1/public/catalog/feed?p=&wl=uniplan', 'empty provider'],
    ['/v1/public/catalog/feed?p=RP013&wl=', 'empty whitelabel'],
  ])('rejects %s before reader, cache or in-flight key creation', async (url) => {
    let reads = 0;
    const access = new DataAccessGateway(new MemoryDataAccessLogStore());
    const app = createConsumerGateway(
      { getActive: async () => null, getManifest: async () => null, listProjectionLineage: async () => [] },
      bindings,
      access,
      undefined,
      { read: async () => { reads++; return snapshot({ P1: product() }); } },
    );
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(400);
    expect(reads).toBe(0);
    expect(publicRuntimeStatsForTest().cacheEntries).toBe(0);
    expect(publicRuntimeStatsForTest().inFlightEntries).toBe(0);
    await app.close();
  });

  it('rejects array query values before reader, cache or in-flight key creation', async () => {
    let reads = 0;
    const access = new DataAccessGateway(new MemoryDataAccessLogStore());
    const app = createConsumerGateway(
      { getActive: async () => null, getManifest: async () => null, listProjectionLineage: async () => [] },
      bindings,
      access,
      undefined,
      { read: async () => { reads++; return snapshot({ P1: product() }); } },
    );
    const response = await app.inject({ url: '/v1/public/catalog/feed', query: { p: ['RP999', 'RP998'], wl: 'uniplan' } });
    expect(response.statusCode).toBe(400);
    expect(reads).toBe(0);
    expect(publicRuntimeStatsForTest().cacheEntries).toBe(0);
    expect(publicRuntimeStatsForTest().inFlightEntries).toBe(0);
    await app.close();
  });

  it('coalesces concurrent reads for the same allowed provider', async () => {
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const access = new DataAccessGateway(new MemoryDataAccessLogStore());
    const app = createConsumerGateway(
      { getActive: async () => null, getManifest: async () => null, listProjectionLineage: async () => [] },
      bindings,
      access,
      undefined,
      { read: async () => { reads++; await gate; return snapshot({ P1: product() }); } },
    );
    const first = app.inject({ url: '/v1/public/catalog/feed?p=RP013&wl=uniplan' });
    const second = app.inject({ url: '/v1/public/catalog/feed?p=RP013&wl=uniplan' });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(reads).toBe(1);
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
