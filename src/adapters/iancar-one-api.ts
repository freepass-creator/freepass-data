import { createHash } from 'node:crypto';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Fetcher = typeof fetch;

const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const isJson = (value: unknown): value is Json =>
  value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value))
  || (Array.isArray(value) && value.every(isJson))
  || (!!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.values(value as Record<string, unknown>).every(isJson));
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const IANCAR_ONE_API_CAPTURE_VERSION = 'iancar-one-api-capture/1';

export type IancarOneApiConfig = {
  baseUrl: string;
  apiKey: string;
  authHeader: string;
  authPrefix?: string | null;
  snapshotPath: string;
  timeoutMs?: number;
};

export type IancarOneApiCapture = {
  version: typeof IANCAR_ONE_API_CAPTURE_VERSION;
  capturedAt: string;
  endpoint: {
    origin: string;
    path: string;
  };
  response: Json;
  responseDigest: string;
  responseBytes: number;
  sourceRevision: string | null;
  observedAt: string | null;
  mappingAuthorized: false;
  canonicalWriteAuthorized: false;
  publicationAuthorized: false;
};

function normalizedConfig(config: IancarOneApiConfig) {
  if (!clean(config.baseUrl) || !clean(config.apiKey) || !clean(config.authHeader)
    || !clean(config.snapshotPath)) throw new Error('IANCAR_ONE_API_CONFIG_REQUIRED');
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('IANCAR_ONE_API_BASE_URL_NOT_ALLOWED');
  if (!/^[-a-z0-9]+$/i.test(config.authHeader))
    throw new Error('IANCAR_ONE_API_AUTH_HEADER_NOT_ALLOWED');
  if (!config.snapshotPath.startsWith('/') || config.snapshotPath.startsWith('//')
    || config.snapshotPath.includes('://') || config.snapshotPath.includes('#'))
    throw new Error('IANCAR_ONE_API_PATH_NOT_ALLOWED');
  const timeoutMs = config.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000)
    throw new Error('IANCAR_ONE_API_TIMEOUT_NOT_ALLOWED');
  return {
    origin: url.origin,
    apiKey: config.apiKey,
    authHeader: config.authHeader,
    authValue: `${clean(config.authPrefix) ? `${clean(config.authPrefix)} ` : ''}${config.apiKey}`,
    snapshotPath: config.snapshotPath,
    timeoutMs
  };
}

function optionalSourceMetadata(value: Json) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { sourceRevision: null, observedAt: null };
  }
  const object = value as Record<string, Json>;
  const revisionKeys = ['sourceRevision', 'revision', 'version', 'snapshotId'];
  const timeKeys = ['observedAt', 'syncedAt', 'updatedAt', 'generatedAt'];
  const revision = revisionKeys.map((key) => clean(object[key])).find(Boolean) ?? null;
  const observed = timeKeys.map((key) => clean(object[key]))
    .find((candidate) => candidate && Number.isFinite(Date.parse(candidate))) ?? null;
  return { sourceRevision: revision, observedAt: observed };
}

/**
 * ONE API transport only.
 * - no endpoint guessing
 * - no redirect following
 * - no response/body logging
 * - no ERP4/Google Sheet/Firebase fallback
 * - no business-field interpretation before the provider schema is observed
 */
export async function captureIancarOneApi(
  config: IancarOneApiConfig,
  fetcher: Fetcher = fetch,
  now = new Date().toISOString()
): Promise<IancarOneApiCapture> {
  if (!Number.isFinite(Date.parse(now))) throw new Error('INVALID_CAPTURE_TIME');
  const normalized = normalizedConfig(config);
  const endpoint = new URL(normalized.snapshotPath, normalized.origin);
  if (endpoint.origin !== normalized.origin) throw new Error('IANCAR_ONE_API_ORIGIN_ESCAPE');

  const response = await fetcher(endpoint, {
    method: 'GET',
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(normalized.timeoutMs),
    headers: {
      'User-Agent': 'FreePassData/1 iancar-one-api',
      'Accept': 'application/json',
      [normalized.authHeader]: normalized.authValue
    }
  });
  if (response.status >= 300 && response.status < 400)
    throw new Error('IANCAR_ONE_API_REDIRECT_REJECTED');
  if (!response.ok) throw new Error(`IANCAR_ONE_API_HTTP_${response.status}`);

  const rawText = await response.text();
  if (!rawText.trim()) throw new Error('IANCAR_ONE_API_EMPTY_RESPONSE');
  let parsed: unknown;
  try { parsed = JSON.parse(rawText); } catch { throw new Error('IANCAR_ONE_API_NON_JSON_RESPONSE'); }
  if (!isJson(parsed)) throw new Error('IANCAR_ONE_API_UNSUPPORTED_JSON');

  const metadata = optionalSourceMetadata(parsed);
  return {
    version: IANCAR_ONE_API_CAPTURE_VERSION,
    capturedAt: now,
    endpoint: { origin: normalized.origin, path: normalized.snapshotPath },
    response: parsed,
    responseDigest: digest(parsed),
    responseBytes: Buffer.byteLength(rawText),
    sourceRevision: metadata.sourceRevision,
    observedAt: metadata.observedAt,
    mappingAuthorized: false,
    canonicalWriteAuthorized: false,
    publicationAuthorized: false
  };
}

export function iancarOneApiConfigFromEnv(env = process.env): IancarOneApiConfig {
  const timeout = clean(env.EANCAR_ONE_API_TIMEOUT_MS);
  return {
    baseUrl: clean(env.EANCAR_ONE_API_BASE_URL),
    apiKey: clean(env.EANCAR_ONE_API_KEY),
    authHeader: clean(env.EANCAR_ONE_API_AUTH_HEADER),
    authPrefix: clean(env.EANCAR_ONE_API_AUTH_PREFIX) || null,
    snapshotPath: clean(env.EANCAR_ONE_API_SNAPSHOT_PATH),
    ...(timeout ? { timeoutMs: Number(timeout) } : {})
  };
}
