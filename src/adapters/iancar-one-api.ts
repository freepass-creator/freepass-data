import { validateVehiclePhotoMedia, VEHICLE_PHOTO_MAX_CONCURRENT, VEHICLE_PHOTO_CACHE_TTL_MS } from '../domain/consumer-output-contract.js';
import { createHash } from 'node:crypto';
import { cachedIancarDetailFor, iancarListRowDigest, iancarRotationIds, IANCAR_DETAIL_CACHE_VERSION, type IancarDetailCache, type IancarDetailCacheEntry } from './iancar-detail-cache.js';
import type { SourceIntakeBatch } from '../domain/source-intake.js';
import type { SourceClockDiagnostic, SourceClockReason } from '../ports/source-cycle.js';

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
  typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
const IANCAR_PLATE = /^\d{2,3}[가-힣]\d{4}$/;
const IANCAR_STATES = ['AVAILABLE', 'RESERVED', 'RENTED', 'PREPARING', 'UNAVAILABLE'];

export const IANCAR_ONE_API_VERSION = 'iancar-one-api/1';
export const IANCAR_ONE_API_ORIGIN = 'https://eancarone.com';
export const IANCAR_ONE_SOURCE_ID = 'supplier:RP031:iancar-one-api';
export const IANCAR_ONE_EXPECTED_FRESHNESS_SECONDS = 15 * 60;
export const IANCAR_ONE_PAGE_SIZE = 100;

/** Supplier catalogue assets observed on 2026-10-02; not photographs of an individual vehicle.
 * Exact supplier variant names only. Never infer a trim/generation from our display model.
 * Source cards use one illustration for mixed inventory colours: colours/options may differ.
 */
export function iancarOneModelIllustration(detail: unknown, vehicleId: string, plate: string) {
  if (!isObject(detail)) return null;
  if (isObject(detail.data)) detail = detail.data;
  if (!isObject(detail)) return null;
  const variants: Record<string, string> = {
    '아토 3 EV 플러스': 'complete-import-104-white.webp',
    '아르카나 1.6 GTe Iconic': 'renault-arkana-urban-gray.webp',
    '트랙스 크로스오버 1.2 가솔린 터보 RS': 'complete-trax-rs-black.webp',
    '쿠퍼(4세대) 2.0 C 5 Door 클래식': 'complete-import-108-blue.webp',
    '라브4(6세대) 2.5 HEV 2WD XLE': 'toyota-rav4-2026-v2-white.webp',
    'E클래스(6세대) E200 익스클루시브': 'complete-import-129-white.webp',
    '더 뉴기아 레이 트렌디': 'kia-ray-2023-gray.webp',
  };
  const name = clean(detail.name);
  const file = Object.hasOwn(variants, name) ? variants[name] : undefined;
  if (!file || detail.stale !== false || detail.vehicle_id !== vehicleId
    || !vehicleId || !plate || clean(detail.plate_number).replace(/\s/g, '') !== plate.replace(/\s/g, '')) return null;
  // SHA-256 of supplier originals observed/decoded on 2026-10-02. URLs remain supplier-owned/live.
  const checksums: Record<string, string> = {
    'complete-import-104-white.webp': '971034fadd67aa0a84d5b9fc30cce560da18bf7626e232c557fc1843eb20fad2',
    'renault-arkana-urban-gray.webp': 'adf96dbf4775a4050888eb53f5fcc980b2fc53781350300df48a12c60fbb10be',
    'complete-trax-rs-black.webp': '371bd89335166e09691dd80ade00a19d3922784b8f6e6145e599e1d9b473237a',
    'complete-import-108-blue.webp': 'f17ea06ef25434e105e0736461b5b0c016b8d0b218fa6a498db8855ad0e293ce',
    'toyota-rav4-2026-v2-white.webp': 'aca456cd3b1f3d050042f3c9095c1acbf6f372c904d6bee5c25a8921398f5b3b',
    'complete-import-129-white.webp': '31d527359056aa6f3b0fb427c98f71c24e5148262580299c45ca6529f7bbd916',
    'kia-ray-2023-gray.webp': '00efe02e9658b5f06a2802fd0f51ef72c457fe9399e374ab7c40164ea19d9180',
  };
  return { url: `${IANCAR_ONE_API_ORIGIN}/catalog-images/neutral/${file}`, sourceName: name,
    kind: 'MODEL_ILLUSTRATION' as const, sourcePage: `${IANCAR_ONE_API_ORIGIN}/`, mappingVersion: 'supplier-catalogue-20261002/1', observedSha256: checksums[file]! };
}

export type IancarOneApiConfig = {
  apiKey: string;
  baseUrl?: string | null;
  timeoutMs?: number;
  /** 일시 오류(502/503/504) 재시도 간격(ms). 기본 [500, 1500]. 상류 갱신 감시 회차는 더 길게 준다(지수 백오프, 각 100~120000ms·최대 5회). */
  retryDelaysMs?: readonly number[];
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
    /** 차 한 대만 보류(전량 읽기 FULL_FACTS 전용). identity=true 는 번호로 문서를 특정할 수 없는 보류(번호 없음·형식 불일치·중복 번호),
     * false 는 번호는 확인됐지만 요금 사실이 검토 기준에 못 미친 보류(요금 없음·기준 밖 값·중복 요금 행). 나머지 차의 회차는 계속된다. */
    hold?: { code: string; identity: boolean };
  }>;
  sourceDigest: string;
  issues: string[];
  readyForRawIngest: boolean;
  factScope?: 'FULL_FACTS' | 'PHASE_ONE_FACTS';
  /** 상세·가용 캐시(iancar-detail-cache)를 쓴 회차만: 재사용 대수·갱신된 캐시(호출자가 파일로 저장). 요금은 캐시하지 않는다. */
  detailsCached?: number;
  detailCacheOut?: IancarDetailCache;
  observationWindow?: {
    startedAt: string; completedAt: string; startInventorySyncedAt: string; endInventorySyncedAt: string;
    consistency: 'BOUNDED_OBSERVATION_NOT_ATOMIC';
  };
};

export class IancarOneApiError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly requestId?: string | null,
    readonly retryAfterSeconds?: number | null,
    readonly clockDiagnostic?: SourceClockDiagnostic
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
  if (url.origin !== IANCAR_ONE_API_ORIGIN || url.pathname !== '/')
    throw new IancarOneApiError('IANCAR_ONE_API_BASE_URL_NOT_ALLOWED');

  const timeoutMs = config.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000)
    throw new IancarOneApiError('IANCAR_ONE_API_TIMEOUT_NOT_ALLOWED');

  const retry = config.retryDelaysMs;
  if (retry !== undefined && (retry.length > 5 || retry.some(ms => !Number.isSafeInteger(ms) || ms < 100 || ms > 120_000)))
    throw new IancarOneApiError('IANCAR_ONE_API_RETRY_NOT_ALLOWED');
  return { origin: url.origin, apiKey, timeoutMs, retryDelaysMs: retry ?? [500, 1500] };
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

  // GET 은 멱등이라 공급사 일시 오류(502/503/504)만 짧게 두 번 더 시도한다. 인증·404·429 는 재시도하지 않는다(신선도 15분 창 안에서만).
  const TRANSIENT_STATUS = new Set([502, 503, 504]);
  const RETRY_DELAYS_MS = normalized.retryDelaysMs;
  const requestJson = async (path: string): Promise<Json> => {
    let response: Response | undefined;
    let timeouts = 0;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        response = await fetcher(apiUrl(normalized.origin, path), {
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
      } catch (error) {
        // ONE 가 느릴 때(상세·요금 5~13초) 한 요청의 시간 초과가 전량 읽기 회차 전체를 죽이지 않게 «한 번만» 더 시도한다.
        // 두 번째도 시간 초과면 원래 오류 그대로 던진다(신선도 15분 창을 더 잡아먹지 않는다).
        if ((error as { name?: string })?.name === 'TimeoutError' && ++timeouts <= 1) continue;
        throw error;
      }
      if (!TRANSIENT_STATUS.has(response.status) || attempt === RETRY_DELAYS_MS.length) break;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
    if (!response) throw new IancarOneApiError('IANCAR_ONE_API_NO_RESPONSE');

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
    // One deadline covers both attempts and the returned response body. Never
    // retry auth/not-found/rate-limit errors or restart a timed-out request budget.
    const signal = AbortSignal.timeout(normalized.timeoutMs);
    const started = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await fetcher(apiUrl(
          normalized.origin,
          `/v1/vehicles/${encodeURIComponent(vehicleId)}/photos/${encodeURIComponent(photoId)}`
        ), {
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          signal,
          headers: {
            'User-Agent': 'FreePassData/1 iancar-one-api',
            'Authorization': `Bearer ${normalized.apiKey}`
          }
        });
      } catch (error) {
        if (signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)))
          throw new IancarOneApiError('IANCAR_ONE_PHOTO_TIMEOUT');
        throw new IancarOneApiError('IANCAR_ONE_PHOTO_TRANSPORT_FAILED');
      }
      if (attempt === 0 && [502, 503, 504].includes(response.status) && Date.now() - started < 2_000 && !signal.aborted) {
        await response.body?.cancel();
        continue;
      }
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
    }
    throw new IancarOneApiError('IANCAR_ONE_PHOTO_TRANSPORT_FAILED');
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
  if (expectedPages > 1000) throw new IancarOneApiError('IANCAR_ONE_PAGE_LIMIT_EXCEEDED');
  const pages = [first];

  for (let page = 2; page <= expectedPages; page++) {
    pages.push(parseListPage(await client.listVehicles(page, IANCAR_ONE_PAGE_SIZE), page));
  }

  const issues: string[] = [];
  const syncedAt = first.synced_at;
  const sourceAgeMs = Date.parse(now) - Date.parse(syncedAt);
  // Bounded clock skew permits a snapshot created while the request is in flight.
  if (sourceAgeMs < -60_000) issues.push('IANCAR_ONE_SOURCE_TIME_IN_FUTURE');
  if (sourceAgeMs > IANCAR_ONE_EXPECTED_FRESHNESS_SECONDS * 1000)
    issues.push('IANCAR_ONE_SOURCE_FRESHNESS_EXCEEDED');
  if (pages.some(page => page.pagination.total !== first.pagination.total))
    issues.push('IANCAR_ONE_PAGINATION_METADATA_DRIFT');
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

/** Display-only supplier reservation mapping; does not create a contract or grant publication. */
export function projectIancarOneReservation(
  payload: JsonObject,
  capture: Pick<IancarOneListCapture, 'readyForRawIngest' | 'stale'>
) {
  if (payload.inventory_status !== 'RESERVED') return null;
  if (payload.available !== false || capture.readyForRawIngest !== true || capture.stale !== false)
    throw new IancarOneApiError('IANCAR_ONE_RESERVED_STATE_REQUIRES_REVIEW');
  return {
    source_inventory_status: 'RESERVED' as const,
    vehicle_status: '계약중' as const,
    status: '계약중' as const,
    status_kind: '선점' as const,
    available: false as const
  };
}

/** Phase-one review payload only: no policy/default/deposit mutation or publication grant. */
export function projectIancarOnePhaseOne(capture: IancarOneListCapture, now = new Date().toISOString()) {
  if (!['FULL_FACTS', 'PHASE_ONE_FACTS'].includes(capture.factScope ?? '') || capture.origin !== IANCAR_ONE_API_ORIGIN
    || !capture.readyForRawIngest || capture.stale || capture.issues.length
    || !instant(now) || !instant(capture.syncedAt)
    || Date.parse(now) - Date.parse(capture.syncedAt) > IANCAR_ONE_EXPECTED_FRESHNESS_SECONDS * 1000
    || Date.parse(capture.syncedAt) - Date.parse(now) > 60_000
    || capture.total < 1 || capture.records.length !== capture.total)
    throw new IancarOneApiError('IANCAR_ONE_PHASE_ONE_SOURCE_REQUIRES_REVIEW');
  const ids = new Set<string>();
  const plates = new Set<string>();
  const vehicles = capture.records.map(record => {
    const p = record.payload;
    const plate = clean(p.plate_number).replace(/\s/g, '');
    const detail = isObject(p.detail) && isObject(p.detail.data) ? p.detail.data : null;
    const rates = isObject(p.rates) ? p.rates : null;
    const evidence = isObject(p.rateRequestEvidence) ? p.rateRequestEvidence : null;
    if (!record.vehicleId || ids.has(record.vehicleId) || plates.has(plate)
      || !IANCAR_PLATE.test(plate) || p.vehicle_id !== record.vehicleId
      || (capture.factScope === 'FULL_FACTS'
        && (!detail || detail.vehicle_id !== record.vehicleId || detail.plate_number !== p.plate_number))
      || (capture.factScope === 'PHASE_ONE_FACTS'
        && (evidence?.attribution !== 'REQUEST_PATH_BOUND_BY_LIST_ID'
          || !instant(evidence.captured_at)
          || Date.parse(now) - Date.parse(evidence.captured_at) > IANCAR_ONE_EXPECTED_FRESHNESS_SECONDS * 1000
          || Date.parse(evidence.captured_at) - Date.parse(now) > 60_000))
      || !rates || rates.success !== true || !Array.isArray(rates.data) || !rates.data.length
      || !instant(rates.updated_at) || Date.parse(rates.updated_at) > Date.parse(now) + 60_000
      || (rates.vehicle_id != null && rates.vehicle_id !== record.vehicleId)
      || !evidence || evidence.vehicle_id !== record.vehicleId
      || evidence.path !== `/v1/vehicles/${encodeURIComponent(record.vehicleId)}/rates`
      || evidence.response_digest !== digest(rates))
      throw new IancarOneApiError('IANCAR_ONE_PHASE_ONE_IDENTITY_REQUIRES_REVIEW');
    ids.add(record.vehicleId); plates.add(plate);
    const state = clean(p.inventory_status);
    if (!IANCAR_STATES.includes(state)
      || p.available !== (state === 'AVAILABLE'))
      throw new IancarOneApiError('IANCAR_ONE_PHASE_ONE_STATE_REQUIRES_REVIEW');
    const keys = new Set<string>();
    const terms = rates.data.map(rate => {
      if (!isObject(rate) || !integer(rate.rental_period) || rate.rental_period < 1 || rate.rental_period > 60
        || !integer(rate.monthly_rate) || rate.monthly_rate < 100_000 || rate.monthly_rate > 20_000_000
        || (capture.factScope === 'PHASE_ONE_FACTS' && (!integer(rate.deposit) || rate.deposit < 0))
        || !integer(rate.contracted_mileage) || rate.contracted_mileage < 1
        || !['month', 'year'].includes(String(rate.mileage_period))
        || rate.currency !== 'KRW' || rate.vat_included !== true)
        throw new IancarOneApiError('IANCAR_ONE_PHASE_ONE_RATE_REQUIRES_REVIEW');
      const key = `${rate.rental_period}:${rate.contracted_mileage}:${rate.mileage_period}`;
      if (keys.has(key)) throw new IancarOneApiError('IANCAR_ONE_DUPLICATE_RATE');
      keys.add(key);
      return { key, termMonths: rate.rental_period,
        contractedMileage: { km: rate.contracted_mileage, period: rate.mileage_period as 'month' | 'year' },
        monthlyRent: { amount: rate.monthly_rate, currency: 'KRW' as const }, vatIncluded: true as const };
    });
    return { sourceVehicleId: record.vehicleId, plate, sourceInventoryStatus: state,
      displayStatus: state === 'AVAILABLE' || state === 'PREPARING' ? '출고가능' : state === 'RESERVED' ? '계약중' : '출고불가',
      available: p.available, ratesUpdatedAt: rates.updated_at, terms };
  });
  return { stage: 'PHASE_ONE_REVIEW_ONLY' as const, sourceDigest: capture.sourceDigest,
    syncedAt: capture.syncedAt, policyStage: 'DEFERRED' as const,
    publicationAuthorized: false as const, vehicles };
}

/** Count equality alone is insufficient: require the exact plate + source-state multiset. */
export function compareIancarOneInventoryParity(
  source: Array<{ plate: string; sourceInventoryStatus: string }>,
  consumer: Array<{ plate: string; sourceInventoryStatus: string }>
) {
  const index = (rows: typeof source) => {
    const byPlate = new Map<string, string>();
    let duplicates = 0; let invalid = 0;
    for (const row of rows) {
      const plate = clean(row.plate).replace(/\s/g, '');
      if (!IANCAR_PLATE.test(plate) || !IANCAR_STATES.includes(row.sourceInventoryStatus)) { invalid++; continue; }
      if (byPlate.has(plate)) { duplicates++; continue; }
      byPlate.set(plate, row.sourceInventoryStatus);
    }
    return { byPlate, duplicates, invalid };
  };
  const a = index(source); const b = index(consumer);
  const missing = [...a.byPlate.keys()].filter(plate => !b.byPlate.has(plate)).length;
  const extra = [...b.byPlate.keys()].filter(plate => !a.byPlate.has(plate)).length;
  const stateMismatch = [...a.byPlate].filter(([plate, state]) => b.byPlate.has(plate) && b.byPlate.get(plate) !== state).length;
  const issues = missing + extra + stateMismatch + a.duplicates + b.duplicates + a.invalid + b.invalid;
  return { status: issues || !source.length ? 'HOLD' as const : 'MATCH' as const, sourceCount: source.length,
    consumerCount: consumer.length, missing, extra, stateMismatch,
    sourceDuplicates: a.duplicates, consumerDuplicates: b.duplicates,
    sourceInvalid: a.invalid, consumerInvalid: b.invalid };
}

/** Full phase-one readback gate: snapshot, identity, display state and all observed rental tuples. */
export function compareIancarOnePhaseOneParity(
  source: ReturnType<typeof projectIancarOnePhaseOne>,
  consumer: Pick<ReturnType<typeof projectIancarOnePhaseOne>, 'sourceDigest' | 'syncedAt' | 'vehicles'>,
  now = new Date().toISOString()
) {
  const inventory = compareIancarOneInventoryParity(source.vehicles, consumer.vehicles);
  const snapshotMismatch = !instant(now) || !instant(source.syncedAt)
    || !/^[a-f0-9]{64}$/.test(source.sourceDigest)
    || !source.vehicles.length || source.sourceDigest !== consumer.sourceDigest || source.syncedAt !== consumer.syncedAt
    || Date.parse(now) - Date.parse(source.syncedAt) > IANCAR_ONE_EXPECTED_FRESHNESS_SECONDS * 1000
    || Date.parse(source.syncedAt) - Date.parse(now) > 60_000;
  const plateKey = (plate: string) => clean(plate).replace(/\s/g, '');
  const lookup = new Map(consumer.vehicles.map(vehicle => [plateKey(vehicle.plate), vehicle]));
  let displayMismatch = 0; let rateMismatch = 0; let identityMismatch = 0;
  for (const vehicle of source.vehicles) {
    const observed = lookup.get(plateKey(vehicle.plate)); if (!observed) continue;
    if (observed.sourceVehicleId !== vehicle.sourceVehicleId) identityMismatch++;
    if (observed.displayStatus !== vehicle.displayStatus || observed.available !== vehicle.available) displayMismatch++;
    const tuples = (v: typeof vehicle) => v.terms.map(term => [term.key, term.termMonths,
      term.contractedMileage.km, term.contractedMileage.period,
      term.monthlyRent.amount, term.monthlyRent.currency, term.vatIncluded])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (digest(tuples(observed)) !== digest(tuples(vehicle)) || observed.ratesUpdatedAt !== vehicle.ratesUpdatedAt) rateMismatch++;
  }
  return { ...inventory, snapshotMismatch, displayMismatch, rateMismatch, identityMismatch,
    status: inventory.status === 'MATCH' && !snapshotMismatch && !displayMismatch && !rateMismatch && !identityMismatch
      ? 'PHASE_ONE_PARITY_VERIFIED' as const : 'HOLD' as const };
}

/** Vehicle-scoped GET evidence binds rates even where the provider does not echo ID. */
/** 한 회차 읽는 동안 상태가 바뀌어 상세·끝 목록과 어긋난 차를 «그 차만 보류»할 수 있는 한도(전체 대수 비율). 넘으면 원천 불안정으로 회차를 실패시킨다. */
export const IANCAR_ONE_DRIFT_HOLD_RATIO = 0.2;
/** 캐시 봉투 재사용 조건: 두 봉투가 성공 구조이고 vehicle_id·번호가 이 차와 같고 stale 이 아니며, 가용 3칸이 현재 목록 행과 같고,
 * 상세 synced_at 이 현재 목록 synced_at 보다 뒤(미래·역행)가 아니다. 하나라도 어긋나면 재사용하지 않는다(다시 읽는다). */
function cachedEnvelopesMatch(entry: IancarDetailCacheEntry, record: IancarOneListCapture['records'][number], listSyncedAt: string): boolean {
  for (const envelope of [entry.detail, entry.availability]) {
    if (!isObject(envelope) || envelope.success !== true || !isObject(envelope.data) || envelope.data.vehicle_id !== record.vehicleId
      || envelope.data.stale !== false || !instant(envelope.data.synced_at) || Date.parse(envelope.data.synced_at) > Date.parse(listSyncedAt)) return false;
    for (const field of ['inventory_status', 'available', 'available_from'])
      if (JSON.stringify(envelope.data[field]) !== JSON.stringify(record.payload[field])) return false;
  }
  if (!isObject(entry.detail.data) || (entry.detail.data as JsonObject).plate_number !== record.payload.plate_number) return false;
  return true;
}
export async function collectIancarOneFullFacts(
  config: IancarOneApiConfig, fetcher: Fetcher = fetch,
  now = new Date().toISOString(), onProgress?: (completed: number, total: number) => void,
  opts: { detailCache?: IancarDetailCache | null;
    /** 캐시 «적재» 전용(1번 커맨드 2026-10-16 닭과 달걀 해소): 차량별 검증을 모두 통과한 상세·가용 봉투를 읽는 즉시 여기에 쌓는다.
     *  회차가 503 등 «이미 검증한 차의 증거를 무효화하지 않는» 일시 실패로 끝나도 남아 다음 회차에 재사용된다(호출자가 파일에 병합).
     *  신원 불일치·목록 붕괴 같은 비일시 실패면 비운다. 발행·Firestore 쓰기와 무관(캐시 적재 경로만). */
    cacheSink?: Record<string, IancarDetailCacheEntry> } = {}
): Promise<IancarOneListCapture> {
  const sink = opts.cacheSink;
  try {
    return await collectIancarOneFullFactsInner(config, fetcher, now, onProgress, opts, sink);
  } catch (error) {
    // 일시 실패(502·503·504·429·시간 초과)만 sink 를 남긴다 — 신원·번호·목록 일관성 실패는 그 회차의 적재를 전부 버린다(Codex P1 ①).
    if (sink && !isTransientIancarFailure(error)) clearSink(sink);
    throw error;
  }
}
/** 일시 실패(이미 검증한 차의 증거를 무효화하지 않는 실패)만 캐시 적재를 남긴다: 429·502·503·504·시간 초과. */
const isTransientIancarFailure = (error: unknown): boolean => error instanceof IancarOneApiError
  && ((error.status !== undefined && [429, 502, 503, 504].includes(error.status)) || /TIMEOUT/.test(error.code));
const clearSink = (sink: Record<string, IancarDetailCacheEntry>) => { for (const key of Object.keys(sink)) delete sink[key]; };
async function collectIancarOneFullFactsInner(
  config: IancarOneApiConfig, fetcher: Fetcher, now: string, onProgress: ((completed: number, total: number) => void) | undefined,
  opts: { detailCache?: IancarDetailCache | null }, sink: Record<string, IancarDetailCacheEntry> | undefined
): Promise<IancarOneListCapture> {
  // 상세·가용 캐시(기본 없음): opts.detailCache 가 주어진 회차만 재사용·갱신한다. 요금(rates)은 항상 다시 읽는다(Codex P1: 가격은 캐시 금지).
  const cacheOn = opts.detailCache !== undefined;
  const cache = opts.detailCache ?? null;
  const cacheNext: Record<string, IancarDetailCacheEntry> = {};
  let detailsCached = 0, reread = 0;
  const wallStartedAt = Date.now();
  const observationNow = () => Date.parse(now) + Date.now() - wallStartedAt;
  const capture = await collectIancarOneVehicleList(config, fetcher, now);
  if (!capture.readyForRawIngest) return { ...capture, factScope: 'FULL_FACTS' };
  // 번호 문제는 그 차만 보류한다(대표 2026-10-14 «데이터만큼은 정확하게»: 한 대의 번호 문제로 나머지 전부를 멈추지 않는다).
  // 번호가 없거나 형식이 다르거나 두 차가 같은 번호면 어느 문서인지 특정할 수 없으므로 상세를 읽지 않고 «식별 보류»로 넘긴다.
  const plates = capture.records.map(record => clean(record.payload.plate_number).replace(/\s/g, ''));
  const plateCounts = new Map<string, number>();
  for (const plate of plates) plateCounts.set(plate, (plateCounts.get(plate) ?? 0) + 1);
  const identityHold = (index: number): string | null => !IANCAR_PLATE.test(plates[index]!)
    ? 'IANCAR_ONE_PLATE_IDENTITY_REQUIRES_REVIEW' : plateCounts.get(plates[index]!)! > 1 ? 'IANCAR_ONE_DUPLICATE_PLATE' : null;
  for (const record of capture.records) {
    if (!['AVAILABLE', 'RESERVED', 'RENTED', 'PREPARING', 'UNAVAILABLE'].includes(clean(record.payload.inventory_status))
      || typeof record.payload.available !== 'boolean'
      || record.payload.available !== (record.payload.inventory_status === 'AVAILABLE'))
      throw new IancarOneApiError('IANCAR_ONE_AVAILABILITY_REQUIRES_REVIEW');
  }
  const rotation = cacheOn ? iancarRotationIds(cache, capture.records.map(record => record.vehicleId)) : new Set<string>();
  const client = createIancarOneApiClient(config, fetcher);
  const records = new Array<IancarOneListCapture['records'][number]>(capture.records.length);
  let next = 0;
  let completed = 0;
  let aborted = false;
  let driftHolds = 0, sourceDriftHolds = 0;
  const reasonEnvelopeCounts: Record<SourceClockReason, number> = {
    INVALID_SYNC: 0, NOT_FRESH_FLAG: 0, EXPIRED: 0, FUTURE: 0, BEHIND_LIST: 0,
  };
  const clockExamples: SourceClockDiagnostic['examples'] = [];
  const safeInstant = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString() : null;
  const noteClock = (envelope: 'DETAIL' | 'AVAILABILITY', value: unknown, receivedAt: number, checkedAt: number, reasons: SourceClockReason[]) => {
    for (const reason of reasons) reasonEnvelopeCounts[reason]++;
    if (clockExamples.length >= 4) return;
    const syncedAt = safeInstant(value);
    clockExamples.push({ envelope, syncedAt, checkedAt: new Date(checkedAt).toISOString(),
      receivedAt: new Date(receivedAt).toISOString(), receivedAgeMs: syncedAt ? receivedAt - Date.parse(syncedAt) : null,
      ageMs: syncedAt ? checkedAt - Date.parse(syncedAt) : null,
      behindListMs: syncedAt ? Date.parse(capture.syncedAt) - Date.parse(syncedAt) : null, reasons: [...reasons] });
  };
  const clockDiagnostic = (stage: SourceClockDiagnostic['stage']): SourceClockDiagnostic => ({
    kind: 'IANCAR_DETAIL_CLOCK', stage, listSyncedAt: safeInstant(capture.syncedAt), checkedAt: new Date(observationNow()).toISOString(),
    listedVehicles: capture.records.length, rereadVehicles: reread, cachedVehicles: detailsCached,
    heldVehicles: driftHolds, clockHeldVehicles: sourceDriftHolds,
    driftLimit: Math.floor((cacheOn ? reread : capture.records.length) * IANCAR_ONE_DRIFT_HOLD_RATIO),
    reasonEnvelopeCounts: { ...reasonEnvelopeCounts }, examples: structuredClone(clockExamples),
  });
  const worker = async () => {
  for (;;) {
    if (aborted) return;
    const index = next++;
    const record = capture.records[index];
    if (!record) return;
    const identityCode = identityHold(index);
    if (identityCode) {
      records[index] = { ...structuredClone(record), hold: { code: identityCode, identity: true } };
      onProgress?.(++completed, capture.total);
      continue;
    }
    const rowDigest = cacheOn ? iancarListRowDigest(record.payload) : '';
    // 캐시 적중이어도 봉투의 신원·번호·가용 사실·시각 순서를 «현재 목록»과 다시 대조한다(관문 Codex P1): 어긋나면 캐시를 버리고 전부 다시 읽는다.
    // 상세 봉투의 15분 창은 다시 적용하지 않는다 — 상세 사실(이름·번호·제원)은 정적이고, 그 시효는 유효 상한(24h)·순환 전수·행 지문으로 묶인다(이 PR 의 목적).
    const candidate = cacheOn && !rotation.has(record.vehicleId) ? cachedIancarDetailFor(cache, record.vehicleId, rowDigest, observationNow()) : null;
    const cached = candidate && cachedEnvelopesMatch(candidate, record, capture.syncedAt) ? candidate : null;
    const requests = cached
      ? [Promise.resolve(cached.detail as Json), Promise.resolve(cached.availability as Json), client.getRates(record.vehicleId)]
      : [client.getVehicle(record.vehicleId), client.getAvailability(record.vehicleId), client.getRates(record.vehicleId)];
    // JSON 수신이 끝난 각 시각을 보존한다. 느린 다른 응답을 기다린 시각으로 수신을 대신하지 않는다.
    const responses = await Promise.allSettled(requests.map(async request => ({ value: await request, receivedAt: observationNow() })));
    if (cached) detailsCached++; else reread++;
    const requestFailure = responses.find(result => result.status === 'rejected'
      && result.reason instanceof IancarOneApiError && result.reason.status === 429)
      ?? responses.find(result => result.status === 'rejected');
    if (requestFailure?.status === 'rejected') throw requestFailure.reason;
    const received = responses.map(result => {
      if (result.status !== 'fulfilled') throw new Error('IANCAR_ONE_UNSETTLED_REQUEST');
      return result.value;
    });
    const [detail, availability, rates] = received.map(response => response.value) as [Json, Json, Json];
    let availabilityDrift = false, sourceDrift = false;
    let detailSyncedAt: string | null = null;
    // 캐시 재사용 차: 봉투 신원·신선도·가용 대조는 캐시 시점에 통과했고, 행 지문이 같으므로(번호·가용 상태 포함) 다시 검사하지 않는다.
    for (const [envelope, receivedAt] of cached ? [] : [[detail, received[0]!.receivedAt], [availability, received[1]!.receivedAt]] as const) {
      if (!isObject(envelope) || envelope.success !== true || !isObject(envelope.data)
        || envelope.data.vehicle_id !== record.vehicleId)
        throw new IancarOneApiError('IANCAR_ONE_DETAIL_IDENTITY_MISMATCH');
      // A supplier refresh clock can advance while unchanged inventory is being read.
      // Validate freshness and facts separately; clock equality is not fact equality.
      const responseNow = receivedAt, checkedAt = observationNow();
      // 갱신 시각 형식 자체가 깨진 응답은 전송 문제라 회차 전체 실패로 남긴다(봉투 검증).
      if (!instant(envelope.data.synced_at)) {
        noteClock(envelope === detail ? 'DETAIL' : 'AVAILABILITY', envelope.data.synced_at, responseNow, checkedAt, ['INVALID_SYNC']);
        throw new IancarOneApiError('IANCAR_ONE_DETAIL_SOURCE_DRIFT');
      }
      if (envelope === detail) detailSyncedAt = envelope.data.synced_at;
      // 한 차의 상세 시각이 오래됐거나(stale·신선도 창 밖)·미래이거나·목록보다 이전이면 «그 차만» 보류한다(다음 회차에 다시 읽는다) — 한 대 때문에 회차 전체를
      // 못 쓰던 것(2026-10-16 16:00 회차 이안카 노출 89대 STALE)을 좁힌다. 어긋난 차가 많으면(아래 한도 20%) 원천 불안정으로 예전처럼 회차 전체를 실패시킨다.
      if (envelope.data.stale !== false
        || responseNow - Date.parse(envelope.data.synced_at) > IANCAR_ONE_EXPECTED_FRESHNESS_SECONDS * 1000
        || Date.parse(envelope.data.synced_at) - responseNow > 60_000
        || Date.parse(capture.syncedAt) > Date.parse(envelope.data.synced_at)) {
        const reasons: SourceClockReason[] = [];
        if (envelope.data.stale !== false) reasons.push('NOT_FRESH_FLAG');
        if (responseNow - Date.parse(envelope.data.synced_at) > IANCAR_ONE_EXPECTED_FRESHNESS_SECONDS * 1000) reasons.push('EXPIRED');
        if (Date.parse(envelope.data.synced_at) - responseNow > 60_000) reasons.push('FUTURE');
        if (Date.parse(capture.syncedAt) > Date.parse(envelope.data.synced_at)) reasons.push('BEHIND_LIST');
        noteClock(envelope === detail ? 'DETAIL' : 'AVAILABILITY', envelope.data.synced_at, responseNow, checkedAt, reasons);
        sourceDrift = true; continue;
      }
      for (const field of ['inventory_status', 'available', 'available_from']) {
        // 목록을 읽은 뒤 이 차의 가용 상태가 실제로 바뀌면(읽는 데 수 분 걸린다) 상세와 목록이 어긋난다. 한 대의 전이로 회차 전체를 실패시키지 않고
        // 그 차만 요금 사실 보류(값 계열)로 둔다 — 다음 회차에 일관된 값으로 다시 읽는다. 어긋난 차가 많으면(아래 한도) 원천 불안정으로 회차를 실패시킨다.
        if (JSON.stringify(envelope.data[field]) !== JSON.stringify(record.payload[field])) { availabilityDrift = true; break; }
      }
    }
    if (((detail as JsonObject).data as JsonObject).plate_number !== record.payload.plate_number)
      throw new IancarOneApiError('IANCAR_ONE_PLATE_MISMATCH');
    // 응답 봉투(성공·배열·갱신 시각·차량 ID)가 깨진 것은 전송 문제라 회차 전체 실패로 남긴다. 봉투가 정상이고 «이 차의 요금 사실»만 기준에
    // 못 미치면(요금 없음·기준 밖 값·중복 행) 그 차만 보류한다 — 틀린 요금은 어디에도 쓰지 않고, 나머지 차는 계속 진행한다.
    if (!isObject(rates) || rates.success !== true || !Array.isArray(rates.data)
      || !rates.data.every(isObject) || !instant(rates.updated_at)
      || Date.parse(rates.updated_at) > received[2]!.receivedAt + 60_000
      || (rates.vehicle_id != null && rates.vehicle_id !== record.vehicleId))
      throw new IancarOneApiError('INVALID_IANCAR_ONE_RATES_RESPONSE');
    // 신원·시효·번호·요금 봉투가 모두 정상일 때만 «가용 상태가 읽는 동안 바뀐 차»를 그 차만 보류한다(검증을 건너뛰어 불일치가 보류로 둔갑하지 않게).
    if (availabilityDrift || sourceDrift) {
      driftHolds++;
      if (sourceDrift) sourceDriftHolds++;
      records[index] = { ...structuredClone(record), hold: { code: sourceDrift ? 'IANCAR_ONE_DETAIL_SOURCE_DRIFT' : 'IANCAR_ONE_DETAIL_AVAILABILITY_DRIFT', identity: false } };
      onProgress?.(++completed, capture.total);
      continue;
    }
    let rateHold: string | null = rates.data.length ? null : 'IANCAR_ONE_RATES_EMPTY';
    const keys = new Set<string>();
    for (const rate of rates.data as JsonObject[]) {
      if (rateHold) break;
      if (!integer(rate.rental_period) || rate.rental_period < 1 || rate.rental_period > 60
        || !integer(rate.monthly_rate) || rate.monthly_rate < 100_000 || rate.monthly_rate > 20_000_000
        || !integer(rate.deposit) || rate.deposit < 0
        || !integer(rate.contracted_mileage) || rate.contracted_mileage < 1
        || !['month', 'year'].includes(String(rate.mileage_period))
        || rate.currency !== 'KRW' || rate.vat_included !== true
        || !isObject(rate.contract_conditions) || !clean(rate.contract_conditions.version)) { rateHold = 'IANCAR_ONE_RATE_FACT_REQUIRES_REVIEW'; break; }
      const key = `${rate.rental_period}:${rate.contracted_mileage}:${rate.mileage_period}`;
      if (keys.has(key)) { rateHold = 'IANCAR_ONE_DUPLICATE_RATE'; break; }
      keys.add(key);
    }
    if (cacheOn) {
      cacheNext[record.vehicleId] = cached ? cached : { rowDigest, detail: structuredClone(detail) as Record<string, unknown>,
        availability: structuredClone(availability) as Record<string, unknown>, cachedAt: new Date(observationNow()).toISOString(), detailSyncedAt };
      if (sink && !cached) sink[record.vehicleId] = structuredClone(cacheNext[record.vehicleId]!);   // 새로 읽어 검증을 통과한 차만 적재(재사용 차는 파일에 이미 있음)
    }
    const payload: JsonObject = { ...structuredClone(record.payload),
      detail: structuredClone(detail), availability: structuredClone(availability),
      rates: structuredClone(rates), rateRequestEvidence: {
        vehicle_id: record.vehicleId,
        path: `/v1/vehicles/${encodeURIComponent(record.vehicleId)}/rates`,
        captured_at: new Date().toISOString(), response_digest: digest(rates),
        attribution: 'REQUEST_PATH_BOUND_BY_DETAIL_ECHO', coverage: 'UNKNOWN'
      } };
    const providerFacts = { ...payload, rateRequestEvidence: {
      ...(payload.rateRequestEvidence as JsonObject), captured_at: null } };
    records[index] = { vehicleId: record.vehicleId, payload, fingerprint: digest(providerFacts),
      ...(rateHold ? { hold: { code: rateHold, identity: false } } : {}) };
    onProgress?.(++completed, capture.total);
  }
  };
  // Two vehicles / at most six independent GETs in flight; bounded provider burst.
  // Settle outstanding workers before reporting failure: no dangling requests after return.
  const guardedWorker = () => worker().catch(error => { aborted = true; throw error; });
  const settled = await Promise.allSettled([guardedWorker(), guardedWorker()]);
  // 대표 예외는 429 우선이지만, 어느 워커든 비일시 실패(신원·번호 불일치 등)가 있으면 이번 회차 적재를 전부 버린다(관문 Codex P1).
  if (sink && settled.some(result => result.status === 'rejected' && !isTransientIancarFailure(result.reason))) clearSink(sink);
  const failed = settled.find(result => result.status === 'rejected'
    && result.reason instanceof IancarOneApiError && result.reason.status === 429)
    ?? settled.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    const error = failed.reason;
    if (error instanceof IancarOneApiError && error.code === 'IANCAR_ONE_DETAIL_SOURCE_DRIFT' && reasonEnvelopeCounts.INVALID_SYNC > 0) {
      throw new IancarOneApiError(error.code, error.status, error.requestId, error.retryAfterSeconds, clockDiagnostic('INVALID_SYNC'));
    }
    throw error;
  }
  // 목록·상세 시차로 어긋난 차가 한도(전체의 20%)를 넘으면 개별 전이가 아니라 원천 불안정이다: 예전처럼 회차 전체를 실패시킨다.
  // 캐시를 쓴 회차는 실제로 다시 읽은 차 수를 분모로 둔다(캐시 적중을 «통과»로 세어 비율이 희석되지 않게, Codex P2).
  const driftLimit = Math.floor((cacheOn ? reread : capture.records.length) * IANCAR_ONE_DRIFT_HOLD_RATIO);
  if (driftHolds > driftLimit) throw new IancarOneApiError(
    sourceDriftHolds > 0 ? 'IANCAR_ONE_DETAIL_SOURCE_DRIFT' : 'IANCAR_ONE_DETAIL_AVAILABILITY_DRIFT',
    undefined, undefined, undefined, sourceDriftHolds > 0 ? clockDiagnostic('DRIFT_LIMIT') : undefined);
  const ending = await collectIancarOneVehicleList(config, fetcher, new Date(observationNow()).toISOString());
  const issues = [...ending.issues];
  // Photo credentials may be reissued on every GET; do not compare ephemeral URLs.
  // 끝 목록 대조는 차마다 한다: 읽는 동안 상태가 바뀐 차(또는 목록에서 사라진 차)만 보류하고, 번호가 바뀐 차·한도 초과는 예전처럼 원천 드리프트다.
  // 읽는 동안 새로 생긴 차는 이번 회차 대상이 아니므로 무시한다(다음 회차에 읽는다).
  const endById = new Map(ending.records.map(record => [record.vehicleId, record]));
  const factsOf = (record: IancarOneListCapture['records'][number]) =>
    digest([record.payload.inventory_status, record.payload.available, record.payload.available_from]);
  const startIds = new Set(capture.records.map(record => record.vehicleId));
  // 시작 목록에 없던 ID 가 끝 목록에 있으면(신규·시작에서 빠졌다 복원) 그 차의 부재 판정이 어긋날 수 있어 예전처럼 원천 드리프트로 둔다.
  const membershipChanged = ending.records.some(record => !startIds.has(record.vehicleId));
  let listChanged = 0, plateChanged = false;
  for (let index = 0; index < capture.records.length; index++) {
    const before = capture.records[index]!, written = records[index];
    if (!written) continue;
    const end = endById.get(before.vehicleId);
    if (end && end.payload.plate_number !== before.payload.plate_number) { plateChanged = true; continue; }
    if (end && factsOf(end) === factsOf(before)) continue;
    // 이미 요금·식별 보류인 차도 변화를 센다(전 차 보류라도 끝 목록 전체 변화가 한도 판정에서 빠지지 않게). 보류 사유는 덮어쓰지 않는다.
    if (written.hold?.code !== 'IANCAR_ONE_DETAIL_AVAILABILITY_DRIFT' && written.hold?.code !== 'IANCAR_ONE_DETAIL_SOURCE_DRIFT') listChanged++;   // 상세 어긋남으로 이미 센 차는 두 번 세지 않는다
    if (!written.hold) records[index] = { ...structuredClone(before), hold: { code: 'IANCAR_ONE_LIST_CHANGED_DURING_READ', identity: false } };
  }
  if (membershipChanged || plateChanged || driftHolds + listChanged > driftLimit) issues.push('IANCAR_ONE_ENRICHMENT_SOURCE_DRIFT');
  if (Date.parse(capture.syncedAt) > Date.parse(ending.syncedAt))
    issues.push('IANCAR_ONE_ENRICHMENT_CLOCK_REGRESSION');
  // 끝 목록 대조에서 회차가 불완전(비일시: 번호 변경·목록 붕괴·시계 역행·한도 초과)해지면 적재 전부를 버리고,
  // 읽는 동안 바뀐 차(LIST_CHANGED_DURING_READ 보류)는 그 차만 적재에서 뺀다(관문 Codex P1).
  if (sink) {
    if (issues.length) clearSink(sink);
    else for (const written of records) if (written?.hold?.code === 'IANCAR_ONE_LIST_CHANGED_DURING_READ') delete sink[written.vehicleId];   // 요금 보류 차는 상세·가용이 검증됐으므로 남긴다
  }
  return { ...capture, records, factScope: 'FULL_FACTS', issues,
    observationWindow: { startedAt: capture.capturedAt, completedAt: ending.capturedAt,
      startInventorySyncedAt: capture.syncedAt, endInventorySyncedAt: ending.syncedAt,
      consistency: 'BOUNDED_OBSERVATION_NOT_ATOMIC' },
    readyForRawIngest: issues.length === 0,
    sourceDigest: digest({ syncedAt: capture.syncedAt,
      records: records.map(record => [record.vehicleId, record.fingerprint]) }),
    ...(cacheOn ? { detailsCached, detailCacheOut: { version: IANCAR_DETAIL_CACHE_VERSION, writtenAt: new Date(observationNow()).toISOString(), entries: cacheNext } } : {}) };
}

/** Phase one observes list identity/state and vehicle-scoped rates, not policy/detail facts.
 * Re-read the list after rates: state transitions do not invalidate unchanged rate identities.
 * New IDs/plate changes require another bounded pass, never invented rates or deletions.
 */
/** Finite source-only transport: no publication, persistence, photo or retry path. */
export function createIancarSourceOnlyFetcher(fetcher: Fetcher, now: () => number = Date.now) {
  let calls = 0;
  const bounded: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== IANCAR_ONE_API_ORIGIN || (init?.method ?? 'GET') !== 'GET'
      || !(/^\/v1\/vehicles$/.test(url.pathname) || /^\/v1\/vehicles\/[^/]+\/rates$/.test(url.pathname)))
      throw new Error('SOURCE_ONLY_ROUTE_REJECTED');
    if (calls >= 612) throw new Error('SOURCE_ONLY_BUDGET_EXCEEDED');
    if (url.pathname === '/v1/vehicles' && Number(url.searchParams.get('page')) > 2)
      throw new Error('SOURCE_ONLY_SCOPE_EXCEEDED');
    calls++;
    const response = await fetcher(input, init);
    if (!response.ok) throw new Error('SOURCE_ONLY_HTTP_REJECTED');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SOURCE_ONLY_SCHEMA_REJECTED');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 1_048_576) { await reader.cancel(); throw new Error('SOURCE_ONLY_BODY_LIMIT'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const boundedResponse = new Response(bytes, { status: response.status, headers: response.headers });
    if (url.pathname === '/v1/vehicles') {
      const body = JSON.parse(new TextDecoder().decode(bytes));
      const synced = Date.parse(body.synced_at);
      if (!Number.isSafeInteger(body.pagination?.total) || body.pagination.total < 0 || body.pagination.total > 200
        || !Number.isSafeInteger(body.pagination?.page_size) || body.pagination.page_size < 1
        || Math.ceil(body.pagination.total / body.pagination.page_size) > 2)
        throw new Error('SOURCE_ONLY_SCOPE_EXCEEDED');
      if (body.stale !== false || !Number.isFinite(synced) || now() - synced > 900_000 || synced - now() > 60_000)
        throw new Error('SOURCE_ONLY_NOT_FRESH');
    }
    return boundedResponse;
  };
  return { fetcher: bounded, calls: () => calls };
}

export async function inspectIancarSourceOnly(config: IancarOneApiConfig, fetcher: Fetcher = fetch) {
  const bounded = createIancarSourceOnlyFetcher(fetcher);
  try {
    const capture = await collectIancarOnePhaseOneFacts(config, bounded.fetcher, new Date().toISOString(), undefined,
      { sourceOnly: true });
    if (!capture.readyForRawIngest || capture.issues.length) throw new Error('SOURCE_ONLY_INCOMPLETE');
    const phase = projectIancarOnePhaseOne(capture);
    return { stage: 'SOURCE_ONLY', status: 'COMPLETE', count: phase.vehicles.length,
      logicalCalls: bounded.calls(), fresh: true, writes: 0, photoBytes: 0 };
  } catch {
    return { stage: 'SOURCE_ONLY', status: 'STOP', count: 0,
      logicalCalls: bounded.calls(), fresh: false, writes: 0, photoBytes: 0 };
  }
}

export async function collectIancarOnePhaseOneFacts(
  config: IancarOneApiConfig, fetcher: Fetcher = fetch,
  now = new Date().toISOString(), onProgress?: (completed: number, total: number) => void,
  options: { photos?: boolean; sourceOnly?: boolean } = {}
): Promise<IancarOneListCapture> {
  const wallStartedAt = Date.now();
  const observationNow = () => new Date(Date.parse(now) + Date.now() - wallStartedAt).toISOString();
  let inventory = await collectIancarOneVehicleList(config, fetcher, now);
  const started = inventory;
  const client = createIancarOneApiClient(config, fetcher);
  const observed = new Map<string, { plate: string; rates: Json; evidence: JsonObject; photoDetail?: Json; photosObservedAt?: string }>();
  for (let pass = 0; pass < 3; pass++) {
    if (!inventory.readyForRawIngest) return { ...inventory, factScope: 'PHASE_ONE_FACTS' };
    let completed = 0;
    // Rates-only behavior remains sequential. Full sync uses two bounded workers to fit the freshness budget.
    let cursor = 0;
    let aborted = false;
    const worker = async () => { while (!aborted && cursor < inventory.records.length) {
      const record = inventory.records[cursor++]!;
      const plate = clean(record.payload.plate_number).replace(/\s/g, '');
      if (!IANCAR_PLATE.test(plate)) throw new IancarOneApiError('IANCAR_ONE_PLATE_IDENTITY_REQUIRES_REVIEW');
      if (observed.get(record.vehicleId)?.plate !== plate) {
        const rates = await client.getRates(record.vehicleId);
        const rateCapturedAt = observationNow();
        if (aborted) return;
        if (options.sourceOnly) projectIancarOnePhaseOne({ ...inventory, factScope: 'PHASE_ONE_FACTS',
          total: 1, pages: 1, records: [{ ...record, payload: { ...record.payload, rates,
            rateRequestEvidence: { vehicle_id: record.vehicleId,
              path: `/v1/vehicles/${encodeURIComponent(record.vehicleId)}/rates`,
              captured_at: rateCapturedAt, response_digest: digest(rates), attribution: 'REQUEST_PATH_BOUND_BY_LIST_ID' } } }] }, rateCapturedAt);
        // List photo summaries are not authoritative: inspect every vehicle detail, including hidden stock.
        const photoDetail = options.photos ? await client.getVehicle(record.vehicleId) : undefined;
        if (photoDetail !== undefined) iancarOnePhotoIds(photoDetail, record.vehicleId, plate);
        observed.set(record.vehicleId, { plate, rates, evidence: {
          vehicle_id: record.vehicleId,
          path: `/v1/vehicles/${encodeURIComponent(record.vehicleId)}/rates`,
          captured_at: rateCapturedAt, response_digest: digest(rates),
          attribution: 'REQUEST_PATH_BOUND_BY_LIST_ID', coverage: 'UNKNOWN'
        }, ...(photoDetail !== undefined ? { photoDetail, photosObservedAt: observationNow() } : {}) });
      }
      onProgress?.(++completed, inventory.total);
    } };
    const settled = await Promise.allSettled(Array.from({ length: options.photos ? 2 : 1 }, () =>
      worker().catch(error => { aborted = true; throw error; })));
    const failed = settled.find(result => result.status === 'rejected'
      && result.reason instanceof IancarOneApiError && result.reason.status === 429)
      ?? settled.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const ending = await collectIancarOneVehicleList(config, fetcher, observationNow());
    if (Date.parse(ending.syncedAt) < Date.parse(inventory.syncedAt))
      throw new IancarOneApiError('IANCAR_ONE_ENRICHMENT_CLOCK_REGRESSION');
    if (options.sourceOnly && (!ending.readyForRawIngest || ending.records.length !== inventory.records.length
      || ending.records.some(record => !inventory.records.some(previous => previous.vehicleId === record.vehicleId
        && previous.fingerprint === record.fingerprint)))) throw new Error('SOURCE_ONLY_UNSTABLE');
    inventory = ending;
    if (!ending.readyForRawIngest) continue;
    if (!ending.records.every(record => observed.get(record.vehicleId)?.plate
      === clean(record.payload.plate_number).replace(/\s/g, ''))) continue;
    const records = ending.records.map(record => {
      const rate = observed.get(record.vehicleId)!;
      const payload = { ...structuredClone(record.payload), rates: structuredClone(rate.rates),
        rateRequestEvidence: structuredClone(rate.evidence),
        ...(rate.photoDetail !== undefined ? { photoDetail: structuredClone(rate.photoDetail), photosObservedAt: rate.photosObservedAt! } : {}) };
      const providerFacts = { ...payload, rateRequestEvidence: {
        ...payload.rateRequestEvidence, captured_at: null }, ...(options.photos ? { photosObservedAt: null } : {}) };
      return { ...record, payload, fingerprint: digest(providerFacts) };
    });
    const capture: IancarOneListCapture = { ...ending, records, factScope: 'PHASE_ONE_FACTS',
      observationWindow: { startedAt: started.capturedAt, completedAt: ending.capturedAt,
        startInventorySyncedAt: started.syncedAt, endInventorySyncedAt: ending.syncedAt,
        consistency: 'BOUNDED_OBSERVATION_NOT_ATOMIC' },
      sourceDigest: digest({ syncedAt: ending.syncedAt,
        records: records.map(record => [record.vehicleId, record.fingerprint]) }) };
    projectIancarOnePhaseOne(capture, observationNow());
    return capture;
  }
  return { ...inventory, factScope: 'PHASE_ONE_FACTS', readyForRawIngest: false,
    issues: [...inventory.issues, 'IANCAR_ONE_PHASE_ONE_IDENTITY_RECONCILIATION_PENDING'] };
}

/** Resolve only provider vehicle photos; ephemeral URLs and credentials never leave the server. */
export function iancarOnePhotoIds(detail: unknown, vehicleId: string, plate: string): string[] {
  const envelope = detail as { data?: unknown };
  const raw = (envelope?.data ?? detail) as Record<string, unknown>;
  // Separate codes so a failed round shows which gate stopped it; no vehicle ID/plate in the code.
  if (!raw || raw.vehicle_id !== vehicleId || clean(raw.plate_number).replace(/\s/g, '') !== plate.replace(/\s/g, ''))
    throw new IancarOneApiError('IANCAR_PHOTO_IDENTITY_MISMATCH');
  if (raw.stale !== false) throw new IancarOneApiError('IANCAR_PHOTO_DETAIL_STALE');
  if (!Array.isArray(raw.photos)) throw new IancarOneApiError('IANCAR_PHOTO_LIST_MISSING');
  if (raw.photos.length > 200) throw new IancarOneApiError('IANCAR_PHOTO_LIMIT_EXCEEDED');
  const ids = new Set<string>();
  const photos = raw.photos.map((value: unknown) => {
    const photo = value as Record<string, unknown>;
    const id = clean(photo?.photo_id);
    if (!id || id.length > 2048 || ids.has(id) || typeof photo.url !== 'string'
      || typeof photo.representative !== 'boolean') throw new IancarOneApiError('IANCAR_PHOTO_REFERENCE_INVALID');
    const expected = `/v1/vehicles/${encodeURIComponent(vehicleId)}/photos/${encodeURIComponent(id)}`;
    let url: URL;
    try { url = new URL(photo.url, IANCAR_ONE_API_ORIGIN); }
    catch { throw new IancarOneApiError('IANCAR_PHOTO_REFERENCE_INVALID'); }
    if (url.origin !== IANCAR_ONE_API_ORIGIN || url.username || url.password || url.search || url.hash || url.pathname !== expected)
      throw new IancarOneApiError('IANCAR_PHOTO_REFERENCE_INVALID');
    ids.add(id);
    return { id, representative: photo.representative };
  });
  if (photos.filter(p => p.representative).length > 1) throw new IancarOneApiError('IANCAR_PHOTO_REPRESENTATIVE_AMBIGUOUS');
  return photos.sort((a, b) => Number(b.representative) - Number(a.representative)).map(p => p.id);
}

/** Bounded raster-only response. Do not relay upstream headers, URLs, SVG or error bodies. */
export async function readIancarOnePhotoBytes(response: Response) {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (!response.ok || !response.body || validateVehiclePhotoMedia(contentType, Number(response.headers.get('content-length') ?? 0))) {
    await response.body?.cancel();
    throw new IancarOneApiError('IANCAR_PHOTO_MEDIA_INVALID');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (validateVehiclePhotoMedia(contentType, size)) throw new IancarOneApiError('IANCAR_PHOTO_MEDIA_OVERSIZED');
      chunks.push(part.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  if (validateVehiclePhotoMedia(contentType, bytes.length, bytes)) throw new IancarOneApiError('IANCAR_PHOTO_MEDIA_SIGNATURE_INVALID');
  return { bytes, contentType: contentType! };
}

export function buildIancarOneSourceBatch(capture: IancarOneListCapture): SourceIntakeBatch {
  const complete = capture.readyForRawIngest;
  const enriched = capture.factScope != null;
  return {
    laneId: 'PRODUCT_VEHICLE',
    source: {
      sourceId: enriched ? `${IANCAR_ONE_SOURCE_ID}:${capture.factScope === 'FULL_FACTS' ? 'full-facts' : 'phase-one-facts'}` : IANCAR_ONE_SOURCE_ID,
      kind: 'API',
      displayName: '이안카 ONE 제휴 API',
      authorityScope: capture.factScope === 'PHASE_ONE_FACTS' ? [
        'RP031 observed list identity/state and vehicle-scoped rental rates; coverage UNKNOWN',
        'NO_POLICY_OR_SOURCE_ABSENCE_AUTHORITY'
      ] : capture.factScope === 'FULL_FACTS' ? [
        'RP031 observed vehicle-scoped rates/deposit; coverage UNKNOWN',
        'RP031 contract conditions',
        'RP031 photo references',
        'NO_INVENTORY_STATE_OR_SOURCE_ABSENCE_AUTHORITY'
      ] : [
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
    coverage: enriched && complete ? {
      mode: 'UNKNOWN', completeness: 'UNKNOWN',
      scope: 'Iancar ONE observed vehicle-scoped facts',
      note: 'Full vehicle list observed. Rate-table response has no completeness declaration; never assert absent terms from this run.'
    } : complete
      ? {
          mode: 'FULL',
          completeness: 'COMPLETE',
          scope: 'Iancar ONE /v1/vehicles full paginated list',
          note: 'RAW inventory evidence. Detail/rates/photos remain separately fetched provider facts.'
        }
      : {
          mode: 'PARTIAL',
          completeness: 'INCOMPLETE',
          scope: enriched ? 'Iancar ONE enriched facts attempt' : 'Iancar ONE /v1/vehicles attempted list',
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
  const retry = clean(env.EANCAR_ONE_API_RETRY_DELAYS_MS);
  return {
    apiKey: clean(env.EANCAR_ONE_API_KEY),
    baseUrl: clean(env.EANCAR_ONE_API_BASE_URL) || IANCAR_ONE_API_ORIGIN,
    ...(timeout ? { timeoutMs: Number(timeout) } : {}),
    ...(retry ? { retryDelaysMs: retry.split(',').map(v => Number(v.trim())) } : {})
  };
}

/** Private bounded byte cache, keyed by exact supplier identity, never mutable gallery index. */
export function createIancarPhotoByteCache(now = Date.now) {
  type Photo = Awaited<ReturnType<typeof readIancarOnePhotoBytes>>;
  const entries = new Map<string, { value: Photo; expires: number }>();
  const pending = new Map<string, Promise<Photo>>();
  let bytes = 0;
  return async (vehicleId: string, photoId: string, load: () => Promise<Photo>): Promise<Photo> => {
    const key = JSON.stringify([vehicleId, photoId]);
    for (const [id, entry] of entries) if (entry.expires <= now()) {
      entries.delete(id); bytes -= entry.value.bytes.length;
    }
    const hit = entries.get(key);
    if (hit) return hit.value;
    const inflight = pending.get(key);
    if (inflight) return inflight;
    if (pending.size >= VEHICLE_PHOTO_MAX_CONCURRENT) throw new Error('IANCAR_PHOTO_BUSY');
    const request = Promise.resolve().then(load).then(value => {
      if (validateVehiclePhotoMedia(value.contentType, value.bytes.length)) throw new Error('IANCAR_PHOTO_RESPONSE_INVALID');
      // A 51-photo album must not evict its first images merely by entry count.
      // Keep the existing 32MiB byte cap, 30s TTL and eight-inflight limit.
      while (entries.size >= 64 || bytes + value.bytes.length > 32 * 1024 * 1024) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        bytes -= entries.get(oldest)!.value.bytes.length; entries.delete(oldest);
      }
      entries.set(key, { value, expires: now() + VEHICLE_PHOTO_CACHE_TTL_MS }); bytes += value.bytes.length;
      return value;
    }).finally(() => { pending.delete(key); });
    pending.set(key, request);
    return request;
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
