import Fastify from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import publicProductFeedSchema from '../../contracts/public-product-feed-v1.schema.json' with { type: 'json' };
import { assertConsumerRuntime } from './runtime-policy.js';
import { buildPublicProductFeed, buildPublicProductQuote, publicConsumerIdFromWhitelabel } from './public-product-feed.js';
import { logRouteError } from '../shared/route-error-log.js';
import { createFirestoreCatalogCompatibilityReader } from '../infra/erp5-compat-catalog-reader.js';

type PublicCatalogQuery = { p?: string; wl?: string; code?: string; a?: string };

const addFormats = (
  typeof addFormatsModule === 'function'
    ? addFormatsModule
    : (addFormatsModule as unknown as { default: FormatsPlugin }).default
) as FormatsPlugin;
const CACHE_MS = 45_000;
const TIMEOUT_MS = 5_000;
const FEED_MAX_BYTES = 1_000_000;
const QUOTE_MAX_BYTES = 512_000;
const cache = new Map<string, { expiresAt: number; value: Awaited<ReturnType<ReturnType<typeof createFirestoreCatalogCompatibilityReader>['read']>> }>();

const single = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? undefined : value;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => { timeout = setTimeout(() => reject(new Error('PUBLIC_CATALOG_TIMEOUT')), TIMEOUT_MS); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const normalize = (query: PublicCatalogQuery) => {
  const p = single(query.p);
  const wl = single(query.wl);
  const code = single(query.code);
  if (p !== undefined && !/^[A-Z0-9_]{2,40}$/.test(p)) throw Object.assign(new Error('PUBLIC_PROVIDER_INVALID'), { statusCode: 400 });
  if (wl !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(wl)) throw Object.assign(new Error('PUBLIC_WL_INVALID'), { statusCode: 400 });
  if (code !== undefined && !/^[A-Za-z0-9_-]{1,120}$/.test(code)) throw Object.assign(new Error('PUBLIC_CODE_INVALID'), { statusCode: 400 });
  return { p, wl, code };
};

assertConsumerRuntime();
const app = Fastify({ logger: false, trustProxy: false });
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema(publicProductFeedSchema);
const validateFeed = ajv.getSchema('https://freepass.teamjpk.com/contracts/public-product-feed-v1.schema.json#/$defs/feed')!;
const validateQuote = ajv.getSchema('https://freepass.teamjpk.com/contracts/public-product-feed-v1.schema.json#/$defs/quote')!;
const reader = createFirestoreCatalogCompatibilityReader(undefined, { readCollections: ['products', 'policy'] });

app.get('/health', async () => ({ service: 'freepass-data-public', status: 'SERVING', readiness: 'NOT_ASSERTED' }));

const readSnapshot = async (consumerId: string, key: string) => {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  try {
    const value = await withTimeout(reader.read(consumerId));
    cache.set(key, { expiresAt: now + CACHE_MS, value });
    return value;
  } catch (error) {
    logRouteError('/v1/public/catalog/*', 'compat_reader_read', error);
    throw error;
  }
};

app.get<{ Querystring: PublicCatalogQuery }>('/v1/public/catalog/feed', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  try {
    const { p, wl } = normalize(request.query);
    const consumerId = publicConsumerIdFromWhitelabel(wl);
    const response = buildPublicProductFeed(await readSnapshot(consumerId, `${consumerId}:${p ?? ''}:${wl ?? ''}`), { p, wl });
    if (response.products.length > 5000 || bytes(response) > FEED_MAX_BYTES || !validateFeed(response)) {
      return reply.code(503).send({ error: '상품 안내를 불러오지 못했습니다.' });
    }
    return response;
  } catch (error) {
    logRouteError('/v1/public/catalog/feed', 'public_feed', error);
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : 503;
    if (statusCode === 400) return reply.code(400).send({ error: '잘못된 공개 상품 요청입니다.' });
    return reply.code(503).send({ error: '상품 안내를 불러오지 못했습니다.' });
  }
});

app.get<{ Querystring: PublicCatalogQuery }>('/v1/public/catalog/quote', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  try {
    const { p, wl, code } = normalize(request.query);
    if (!code) return reply.code(400).send({ error: '상품 코드가 없습니다.' });
    const consumerId = publicConsumerIdFromWhitelabel(wl);
    const response = buildPublicProductQuote(await readSnapshot(consumerId, `${consumerId}:${p ?? ''}:${wl ?? ''}`), code, { p, wl });
    if (!response) return reply.code(404).send({ error: '현재 안내 가능한 상품이 아닙니다.' });
    if (bytes(response) > QUOTE_MAX_BYTES || !validateQuote(response)) return reply.code(503).send({ error: '상품 안내를 불러오지 못했습니다.' });
    return response;
  } catch (error) {
    logRouteError('/v1/public/catalog/quote', 'public_quote', error);
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? Number((error as { statusCode?: unknown }).statusCode) : 503;
    if (statusCode === 400) return reply.code(400).send({ error: '잘못된 공개 상품 요청입니다.' });
    return reply.code(503).send({ error: '상품 안내를 불러오지 못했습니다.' });
  }
});

app.setNotFoundHandler((_, reply) => reply.code(404).send({ code: 'NOT_FOUND' }));

await app.listen({ port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? '127.0.0.1' });
