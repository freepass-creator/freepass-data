import { createHash } from 'node:crypto';
import type { SourceIntakeBatch } from '../domain/source-intake.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Fetcher = typeof fetch;

const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const isObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isJson = (value: unknown): value is Json =>
  value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value))
  || (Array.isArray(value) && value.every(isJson))
  || (isObject(value) && Object.values(value).every(isJson));
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const instant = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

export const IANCAR_ONE_API_VERSION = 'iancar-one-api/1';
export const IANCAR_ONE_API_ORIGIN = 'https://eancarone.com';
export const IANCAR_ONE_SOURCE_ID = 'supplier:RP031:iancar-one-api';
export const IANCAR_ONE_EXPECTED_FRESHNESS_SECONDS = 15 * 60;
export const IANCAR_ONE_PAGE_SIZE = 100;

export type IancarOneApiConfig = {
  apiKey: string;
  baseUrl?: string | null;
  timeoutMs?: number;
};

export type IancarOneListPage = {
  success: true;
  data: JsonObject[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
  };
  synced_at: string;
  stale: boolean;
};

export type IancarOneListCapture = {
  version: typeof IANCAR_ONE_API_VERSION;
  capturedAt: string;
  origin: string;
  syncedAt: string;
  stale: boolean;
  total: number;
  pages: number;
  records: Array<{
    vehicleId: string;
    payload: JsonObject;
    fingerprint: string;
  }>;
  sourceDigest: string;
  issues: string[];
  readyForRawIngest: boolean;
};

export class IancarOneApiError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly requestId?: string | null,
    readonly retryAfterSeconds?: number | null
  ) {
    super(code);
    this.name = 'IancarOneApiError';
  }
}

function normalizedConfig(config: IancarOneApiConfig) {
  const apiKey = clean(config.apiKey);
  if (!apiKey) throw new IancarOneApiError('IANCAR_ONE_API_KEY_REQUIRED');

  const baseUrl = clean(config.baseUrl) || IANCAR_ONE_API_ORIGIN;
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new IancarOneApiError('IANCAR_ONE_API_BASE_URL_NOT_ALLOWED');

  const timeoutMs = config.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000)
    throw new IancarOneApiError('IANCAR_ONE_API_TIMEOUT_NOT_ALLOWED');

  return { origin: url.origin, apiKey, timeoutMs };
}

function apiUrl(origin: string, path: string) {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://') || path.includes('#'))
    throw new IancarOneApiError('IANCAR_ONE_API_PATH_NOT_ALLOWED');
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new IancarOneApiError('IANCAR_ONE_API_ORIGIN_ESCAPE');
  return url;
}

function retryAfterSeconds(response: Response) {
  const raw = clean(response.headers.get('retry-after'));
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

async function readJsonResponse(response: Response): Promise<Json> {
  const text = await response.text();
  if (!text.trim()) throw new IancarOneApiError(
    'IANCAR_ONE_API_EMPTY_RESPONSE',
    response.status,
    response.headers.get('x-request-id')
  );
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch {
    throw new IancarOneApiError(
      'IANCAR_ONE_API_NON_JSON_RESPONSE',
      response.status,
      response.headers.get('x-request-id')
    );
  }
  if (!isJson(parsed)) throw new IancarOneApiError(
    'IANCAR_ONE_API_UNSUPPORTED_JSON',
    response.status,
    response.headers.get('x-request-id')
  );
  return parsed;
}

export function createIancarOneApiClient(
  config: IancarOneApiConfig,
  fetcher: Fetcher = fetch
) {
  const normalized = normalizedConfig(config);

  const requestJson = async (path: string): Promise<Json> => {
    const response = await fetcher(apiUrl(normalized.origin, path), {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(normalized.timeoutMs),
      headers: {
        'User-Agent': 'FreePassData/1 iancar-one-api',
        'Accept': 'application/json',
        'Authorization': `Bearer ${normalized.apiKey}`
      }
    });

    const requestId = response.headers.get('x-request-id');
    if (response.status >= 300 && response.status < 400)
      throw new IancarOneApiError('IANCAR_ONE_API_REDIRECT_REJECTED', response.status, requestId);
    if (!response.ok) {
      throw new IancarOneApiError(
        `IANCAR_ONE_API_HTTP_${response.status}`,
        response.status,
        requestId,
        response.status === 429 ? retryAfterSeconds(response) : null
      );
    }
    return readJsonResponse(response);
  };

  const requestPhoto = async (vehicleId: string, photoId: string) => {
    if (!clean(vehicleId) || !clean(photoId)) throw new IancarOneApiError('IANCAR_ONE_PHOTO_ID_REQUIRED');
    const response = await fetcher(apiUrl(
      normalized.origin,
      `/v1/vehicles/${encodeURIComponent(vehicleId)}/photos/${encodeURIComponent(photoId)}`
    ), {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(normalized.timeoutMs),
      headers: {
        'User-Agent': 'FreePassData/1 iancar-one-api',
        'Authorization': `Bearer ${normalized.apiKey}`
      }
    });
    const requestId = response.headers.get('x-request-id');
    if (response.status >= 300 && response.status < 400)
      throw new IancarOneApiError('IANCAR_ONE_API_REDIRECT_REJECTED', response.status, requestId);
    if (!response.ok) throw new IancarOneApiError(
      `IANCAR_ONE_API_HTTP_${response.status}`,
      response.status,
      requestId,
      response.status === 429 ? retryAfterSeconds(response) : null
    );
    return response;
  };

  return {
    origin: normalized.origin,
    listVehicles: (page = 1, pageSize = IANCAR_ONE_PAGE_SIZE) =>
      requestJson(`/v1/vehicles?page=${page}&page_size=${pageSize}`),
    getVehicle: (vehicleId: string) =>
      requestJson(`/v1/vehicles/${encodeURIComponent(vehicleId)}`),
    getAvailability: (vehicleId: string) =>
      requestJson(`/v1/vehicles/${encodeURIComponent(vehicleId)}/availability`),
    getRates: (vehicleId: string) =>
      requestJson(`/v1/vehicles/${encodeURIComponent(vehicleId)}/rates`),
    getPhoto: requestPhoto
  };
}

function parseListPage(value: Json, requestedPage: number): IancarOneListPage {
  if (!isObject(value) || value.success !== true || !Array.isArray(value.data)
    || !value.data.every(isObject) || !isObject(value.pagination)
    || !integer(value.pagination.page) || value.pagination.page !== requestedPage
    || !integer(value.pagination.page_size) || value.pagination.page_size < 1
    || value.pagination.page_size > IANCAR_ONE_PAGE_SIZE
    || !integer(value.pagination.total) || value.pagination.total < 0
    || !instant(value.synced_at) || typeof value.stale !== 'boolean') {
    throw new IancarOneApiError('INVALID_IANCAR_ONE_LIST_RESPONSE');
  }
  return value as unknown as IancarOneListPage;
}

function vehicleIdOf(payload: JsonObject) {
  const id = clean(payload.vehicle_id);
  if (!id) throw new IancarOneApiError('IANCAR_ONE_VEHICLE_ID_REQUIRED');
  return id;
}

export async function collectIancarOneVehicleList(
  config: IancarOneApiConfig,
  fetcher: Fetcher = fetch,
  now = new Date().toISOString()
): Promise<IancarOneListCapture> {
  if (!instant(now)) throw new IancarOneApiError('INVALID_CAPTURE_TIME');
  const client = createIancarOneApiClient(config, fetcher);
  const first = parseListPage(await client.listVehicles(1, IANCAR_ONE_PAGE_SIZE), 1);
  const expectedPages = Math.max(1, Math.ceil(first.pagination.total / first.pagination.page_size));
  const pages = [first];

  for (let page = 2; page <= expectedPages; page++) {
    pages.push(parseListPage(await client.listVehicles(page, IANCAR_ONE_PAGE_SIZE), page));
  }

  const issues: string[] = [];
  const syncedAt = first.synced_at;
  if (pages.some(page => page.synced_at !== syncedAt)) issues.push('IANCAR_ONE_SYNC_TIME_DRIFT');
  if (pages.some(page => page.stale)) issues.push('IANCAR_ONE_SOURCE_STALE');

  const records = new Map<string, { vehicleId: string; payload: JsonObject; fingerprint: string }>();
  let observedRows = 0;
  for (const page of pages) {
    for (const payload of page.data) {
      observedRows++;
      const vehicleId = vehicleIdOf(payload);
      if (records.has(vehicleId)) throw new IancarOneApiError('DUPLICATE_IANCAR_ONE_VEHICLE_ID');
      records.set(vehicleId, {
        vehicleId,
        payload: structuredClone(payload),
        fingerprint: digest(payload)
      });
    }
  }
  if (observedRows !== first.pagination.total)
    issues.push('IANCAR_ONE_PAGINATION_TOTAL_MISMATCH');
  if (first.pagination.total === 0) issues.push('IANCAR_ONE_EMPTY_INVENTORY_REQUIRES_REVIEW');

  const orderedRecords = [...records.values()].sort((a, b) => a.vehicleId.localeCompare(b.vehicleId));
  const sourceDigest = digest({
    version: IANCAR_ONE_API_VERSION,
    syncedAt,
    stale: pages.some(page => page.stale),
    total: first.pagination.total,
    records: orderedRecords.map(record => [record.vehicleId, record.fingerprint])
  });

  return {
    version: IANCAR_ONE_API_VERSION,
    capturedAt: now,
    origin: client.origin,
    syncedAt,
    stale: pages.some(page => page.stale),
    total: first.pagination.total,
    pages: pages.length,
    records: orderedRecords,
    sourceDigest,
    issues: [...new Set(issues)],
    readyForRawIngest: issues.length === 0
  };
}

export function buildIancarOneSourceBatch(capture: IancarOneListCapture): SourceIntakeBatch {
  const complete = capture.readyForRawIngest;
  return {
    laneId: 'PRODUCT_VEHICLE',
    source: {
      sourceId: IANCAR_ONE_SOURCE_ID,
      kind: 'API',
      displayName: '이안카 ONE 제휴 API',
      authorityScope: [
        'RP031 vehicle inventory/detail',
        'RP031 partner rates/deposit by rental period and contracted mileage',
        'RP031 contract conditions',
        'RP031 representative/detail photo references'
      ],
      expectedFreshnessSeconds: IANCAR_ONE_EXPECTED_FRESHNESS_SECONDS
    },
    observedAt: capture.syncedAt,
    sourceRevision: `${IANCAR_ONE_API_VERSION}:${capture.sourceDigest}`,
    checksum: capture.sourceDigest,
    coverage: complete
      ? {
          mode: 'FULL',
          completeness: 'COMPLETE',
          scope: 'Iancar ONE /v1/vehicles full paginated list',
          note: 'RAW inventory evidence. Detail/rates/photos remain separately fetched provider facts.'
        }
      : {
          mode: 'PARTIAL',
          completeness: 'INCOMPLETE',
          scope: 'Iancar ONE /v1/vehicles attempted list',
          note: `HOLD: ${capture.issues.join(',')}`
        },
    records: capture.records.map(record => ({
      sourceRecordId: record.vehicleId,
      sourceFingerprint: record.fingerprint,
      payload: {
        providerCompanyCode: 'RP031',
        sourceSystem: 'EANCAR_ONE',
        sourceVehicleId: record.vehicleId,
        source: structuredClone(record.payload)
      }
    }))
  };
}

export function summarizeJsonShape(value: Json, maxDepth = 5) {
  const paths = new Map<string, Set<string>>();
  const visit = (node: Json, path: string, depth: number) => {
    const type = node === null ? 'null' : Array.isArray(node) ? 'array' : typeof node;
    if (!paths.has(path || '$')) paths.set(path || '$', new Set());
    paths.get(path || '$')!.add(type);
    if (depth >= maxDepth) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 5)) visit(item, `${path || '$'}[]`, depth + 1);
    } else if (isObject(node)) {
      for (const [key, item] of Object.entries(node)) {
        visit(item, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };
  visit(value, '', 0);
  return [...paths.entries()]
    .map(([path, types]) => ({ path, types: [...types].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function iancarOneApiConfigFromEnv(env = process.env): IancarOneApiConfig {
  const timeout = clean(env.EANCAR_ONE_API_TIMEOUT_MS);
  return {
    apiKey: clean(env.EANCAR_ONE_API_KEY),
    baseUrl: clean(env.EANCAR_ONE_API_BASE_URL) || IANCAR_ONE_API_ORIGIN,
    ...(timeout ? { timeoutMs: Number(timeout) } : {})
  };
}

// Compatibility wrapper for the earlier transport-only tests/callers.
// The official ONE contract is now Bearer + /v1 namespace.
export async function captureIancarOneApi(
  config: IancarOneApiConfig,
  fetcher: Fetcher = fetch,
  now = new Date().toISOString()
) {
  return collectIancarOneVehicleList(config, fetcher, now);
}
