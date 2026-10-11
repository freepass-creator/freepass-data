import Fastify from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import publicProductFeedSchema from '../../contracts/public-product-feed-v1.schema.json' with { type: 'json' };
import { assertConsumerRuntime } from './runtime-policy.js';
import { buildPublicProductFeed, buildPublicProductQuote, publicConsumerIdFromWhitelabel } from './public-product-feed.js';
import { logRouteError } from '../shared/route-error-log.js';
import { createFirestoreCatalogCompatibilityReader } from '../infra/erp5-compat-catalog-reader.js';
import type { CatalogCompatibilitySnapshot } from '../infra/erp5-compat-catalog-reader.js';
import { assertPublicAllowlistsConfigured, publicProviderAllowlist, publicWhitelabelAllowlist } from './public-allowlist.js';

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
const CACHE_MAX_ENTRIES = 64;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_MAX_ENTRIES = 4096;
const RETRY_AFTER_SECONDS = 30;
const cache = new Map<string, { expiresAt: number; value: CatalogCompatibilitySnapshot }>();
const inFlight = new Map<string, Promise<CatalogCompatibilitySnapshot>>();
const timeoutCooldown = new Map<string, { resetAt: number }>();
const rateLimits = new Map<string, { resetAt: number; count: number }>();

const single = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? undefined : value;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const trustProxyHops = (): number => {
  const raw = process.env.FREEPASS_PUBLIC_TRUST_PROXY_HOPS?.trim() ?? '';
  if (!raw) return 0;
  if (!/^[0-3]$/.test(raw)) throw new Error('FREEPASS_PUBLIC_TRUST_PROXY_HOPS must be 0, 1, 2 or 3');
  return Number(raw);
};
const sweepExpired = <T extends { expiresAt?: number; resetAt?: number }>(items: Map<string, T>, now: number): void => {
  for (const [key, value] of items) {
    const expiresAt = value.expiresAt ?? value.resetAt;
    if (expiresAt !== undefined && expiresAt <= now) items.delete(key);
  }
};
const trimOldest = <T>(items: Map<string, T>, maxEntries: number): void => {
  while (items.size > maxEntries) {
    const oldest = items.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    items.delete(oldest);
  }
};
const clientIpAtHops = (request: { ip?: string; ips?: string[] | undefined }, hops: number): string =>
  request.ips?.[Math.min(hops, request.ips.length - 1)] ?? request.ip ?? 'unknown';
const rateLimited = (key: string, now = Date.now()): boolean => {
  sweepExpired(rateLimits, now);
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { resetAt: now + RATE_LIMIT_WINDOW_MS, count: 1 });
    trimOldest(rateLimits, RATE_LIMIT_MAX_ENTRIES);
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT_MAX;
};
const withTimeout = async <T>(work: Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> => {
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
  if (p !== undefined) {
    if (!/^(?:RP|PT-)\d+$/.test(p)) throw Object.assign(new Error('PUBLIC_PROVIDER_INVALID'), { statusCode: 400 });
    const allowed = publicProviderAllowlist();
    if (!allowed.has(p)) throw Object.assign(new Error('PUBLIC_PROVIDER_NOT_ALLOWED'), { statusCode: 400 });
  }
  if (wl !== undefined) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(wl)) throw Object.assign(new Error('PUBLIC_WL_INVALID'), { statusCode: 400 });
    const allowed = publicWhitelabelAllowlist();
    if (!allowed.has(wl)) throw Object.assign(new Error('PUBLIC_WL_NOT_ALLOWED'), { statusCode: 400 });
  }
  if (code !== undefined && !/^[A-Za-z0-9가-힣_-]{1,120}$/.test(code)) throw Object.assign(new Error('PUBLIC_CODE_INVALID'), { statusCode: 400 });
  return { p, wl, code };
};

assertConsumerRuntime();
assertPublicAllowlistsConfigured();
const publicProxyHops = trustProxyHops();
const app = Fastify({ logger: false, trustProxy: publicProxyHops > 0 ? (_address, hop) => hop < publicProxyHops : false });
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema(publicProductFeedSchema);
const validateFeed = ajv.getSchema('https://freepass.teamjpk.com/contracts/public-product-feed-v1.schema.json#/$defs/feed')!;
const validateQuote = ajv.getSchema('https://freepass.teamjpk.com/contracts/public-product-feed-v1.schema.json#/$defs/quote')!;
const reader = createFirestoreCatalogCompatibilityReader(undefined, undefined, { readCollections: ['products', 'policy'] });

app.get('/health', async () => ({ service: 'freepass-data-public', status: 'SERVING', readiness: 'NOT_ASSERTED' }));

const readSnapshot = async (consumerId: string, key: string) => {
  const now = Date.now();
  sweepExpired(cache, now);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const current = inFlight.get(key);
  if (current) return current;
  sweepExpired(timeoutCooldown, now);
  const cooldown = timeoutCooldown.get(key);
  if (cooldown && cooldown.resetAt > now) throw Object.assign(new Error('PUBLIC_CATALOG_TIMEOUT_COOLDOWN'), { statusCode: 503 });
  const work = withTimeout(reader.read(consumerId))
    .then((value) => {
      cache.set(key, { expiresAt: Date.now() + CACHE_MS, value });
      trimOldest(cache, CACHE_MAX_ENTRIES);
      return value;
    })
    .finally(() => {
      if (inFlight.get(key) === work) inFlight.delete(key);
    });
  inFlight.set(key, work);
  try {
    return await work;
  } catch (error) {
    if (error instanceof Error && error.message === 'PUBLIC_CATALOG_TIMEOUT') {
      timeoutCooldown.set(key, { resetAt: Date.now() + 1_000 });
      trimOldest(timeoutCooldown, CACHE_MAX_ENTRIES);
    }
    logRouteError('/v1/public/catalog/*', 'compat_reader_read', error);
    throw error;
  }
};
const publicRouteAllowed = (
  request: { routeOptions?: { url?: string | undefined }; url: string; ip?: string; ips?: string[] | undefined },
  reply: { header(name: string, value: string): unknown; code(statusCode: number): { send(payload: unknown): unknown } }
) => {
  const route = request.routeOptions?.url ?? request.url.split('?')[0]!;
  const key = `${clientIpAtHops(request, publicProxyHops)}:${route}`;
  if (!rateLimited(key)) return true;
  reply.header('Retry-After', String(RETRY_AFTER_SECONDS));
  reply.code(429).send({ error: '요청이 너무 많습니다.' });
  return false;
};

app.get<{ Querystring: PublicCatalogQuery }>('/v1/public/catalog/feed', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!publicRouteAllowed(request, reply)) return;
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
    if (statusCode === 404) return reply.code(404).send({ error: '현재 안내 가능한 상품이 아닙니다.' });
    if (statusCode === 400) return reply.code(400).send({ error: '잘못된 공개 상품 요청입니다.' });
    return reply.code(503).send({ error: '상품 안내를 불러오지 못했습니다.' });
  }
});

app.get<{ Querystring: PublicCatalogQuery }>('/v1/public/catalog/quote', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (!publicRouteAllowed(request, reply)) return;
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
    if (statusCode === 404) return reply.code(404).send({ error: '현재 안내 가능한 상품이 아닙니다.' });
    if (statusCode === 400) return reply.code(400).send({ error: '잘못된 공개 상품 요청입니다.' });
    return reply.code(503).send({ error: '상품 안내를 불러오지 못했습니다.' });
  }
});

app.setNotFoundHandler((_, reply) => reply.code(404).send({ code: 'NOT_FOUND' }));

await app.listen({ port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? '127.0.0.1' });
