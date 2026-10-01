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
  factScope?: 'FULL_FACTS';
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
  if (url.origin !== IANCAR_ONE_API_ORIGIN || url.pathname !== '/')
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
  if (capture.factScope !== 'FULL_FACTS' || capture.origin !== IANCAR_ONE_API_ORIGIN
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
      || !detail || detail.vehicle_id !== record.vehicleId || detail.plate_number !== p.plate_number
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
      displayStatus: state === 'AVAILABLE' ? '출고가능' : state === 'RESERVED' ? '계약중' : '출고불가',
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
export async function collectIancarOneFullFacts(
  config: IancarOneApiConfig, fetcher: Fetcher = fetch,
  now = new Date().toISOString(), onProgress?: (completed: number, total: number) => void
): Promise<IancarOneListCapture> {
  const capture = await collectIancarOneVehicleList(config, fetcher, now);
  if (!capture.readyForRawIngest) return { ...capture, factScope: 'FULL_FACTS' };
  const plates = capture.records.map(record => clean(record.payload.plate_number).replace(/\s/g, ''));
  if (plates.some(plate => !/^\d{2,3}[가-힣]\d{4}$/.test(plate)) || new Set(plates).size !== plates.length)
    throw new IancarOneApiError('IANCAR_ONE_PLATE_IDENTITY_REQUIRES_REVIEW');
  for (const record of capture.records) {
    if (!['AVAILABLE', 'RESERVED', 'RENTED', 'PREPARING', 'UNAVAILABLE'].includes(clean(record.payload.inventory_status))
      || typeof record.payload.available !== 'boolean'
      || record.payload.available !== (record.payload.inventory_status === 'AVAILABLE'))
      throw new IancarOneApiError('IANCAR_ONE_AVAILABILITY_REQUIRES_REVIEW');
  }
  const client = createIancarOneApiClient(config, fetcher);
  const records = new Array<IancarOneListCapture['records'][number]>(capture.records.length);
  let next = 0;
  let completed = 0;
  let aborted = false;
  const worker = async () => {
  for (;;) {
    if (aborted) return;
    const index = next++;
    const record = capture.records[index];
    if (!record) return;
    const responses = await Promise.allSettled([
      client.getVehicle(record.vehicleId),
      client.getAvailability(record.vehicleId),
      client.getRates(record.vehicleId)
    ]);
    const requestFailure = responses.find(result => result.status === 'rejected'
      && result.reason instanceof IancarOneApiError && result.reason.status === 429)
      ?? responses.find(result => result.status === 'rejected');
    if (requestFailure?.status === 'rejected') throw requestFailure.reason;
    const [detail, availability, rates] = responses.map(result => {
      if (result.status !== 'fulfilled') throw new Error('IANCAR_ONE_UNSETTLED_REQUEST');
      return result.value;
    }) as [Json, Json, Json];
    for (const envelope of [detail, availability]) {
      if (!isObject(envelope) || envelope.success !== true || !isObject(envelope.data)
        || envelope.data.vehicle_id !== record.vehicleId)
        throw new IancarOneApiError('IANCAR_ONE_DETAIL_IDENTITY_MISMATCH');
      if (envelope.data.synced_at !== capture.syncedAt || envelope.data.stale !== false)
        throw new IancarOneApiError('IANCAR_ONE_DETAIL_SOURCE_DRIFT');
      for (const field of ['inventory_status', 'available', 'available_from']) {
        if (JSON.stringify(envelope.data[field]) !== JSON.stringify(record.payload[field]))
          throw new IancarOneApiError('IANCAR_ONE_DETAIL_AVAILABILITY_DRIFT');
      }
    }
    if (((detail as JsonObject).data as JsonObject).plate_number !== record.payload.plate_number)
      throw new IancarOneApiError('IANCAR_ONE_PLATE_MISMATCH');
    if (!isObject(rates) || rates.success !== true || !Array.isArray(rates.data)
      || !rates.data.length || !rates.data.every(isObject) || !instant(rates.updated_at)
      || Date.parse(rates.updated_at) > Date.parse(now) + 60_000
      || (rates.vehicle_id != null && rates.vehicle_id !== record.vehicleId))
      throw new IancarOneApiError('INVALID_IANCAR_ONE_RATES_RESPONSE');
    const keys = new Set<string>();
    for (const rate of rates.data as JsonObject[]) {
      if (!integer(rate.rental_period) || rate.rental_period < 1 || rate.rental_period > 60
        || !integer(rate.monthly_rate) || rate.monthly_rate < 100_000 || rate.monthly_rate > 20_000_000
        || !integer(rate.deposit) || rate.deposit < 0
        || !integer(rate.contracted_mileage) || rate.contracted_mileage < 1
        || !['month', 'year'].includes(String(rate.mileage_period))
        || rate.currency !== 'KRW' || rate.vat_included !== true
        || !isObject(rate.contract_conditions) || !clean(rate.contract_conditions.version))
        throw new IancarOneApiError('IANCAR_ONE_RATE_FACT_REQUIRES_REVIEW');
      const key = `${rate.rental_period}:${rate.contracted_mileage}:${rate.mileage_period}`;
      if (keys.has(key)) throw new IancarOneApiError('IANCAR_ONE_DUPLICATE_RATE');
      keys.add(key);
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
    records[index] = { vehicleId: record.vehicleId, payload, fingerprint: digest(providerFacts) };
    onProgress?.(++completed, capture.total);
  }
  };
  // Two vehicles / at most six independent GETs in flight; bounded provider burst.
  // Settle outstanding workers before reporting failure: no dangling requests after return.
  const guardedWorker = () => worker().catch(error => { aborted = true; throw error; });
  const settled = await Promise.allSettled([guardedWorker(), guardedWorker()]);
  const failed = settled.find(result => result.status === 'rejected'
    && result.reason instanceof IancarOneApiError && result.reason.status === 429)
    ?? settled.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  const ending = await collectIancarOneVehicleList(config, fetcher);
  const issues = [...ending.issues];
  // Photo credentials may be reissued on every GET; do not compare ephemeral URLs.
  const inventoryFacts = (value: IancarOneListCapture) => ({ syncedAt: value.syncedAt,
    records: value.records.map(record => [record.vehicleId, record.payload.plate_number,
      record.payload.inventory_status, record.payload.available, record.payload.available_from]) });
  if (digest(inventoryFacts(ending)) !== digest(inventoryFacts(capture)))
    issues.push('IANCAR_ONE_ENRICHMENT_SOURCE_DRIFT');
  return { ...capture, records, factScope: 'FULL_FACTS', issues,
    readyForRawIngest: issues.length === 0,
    sourceDigest: digest({ syncedAt: capture.syncedAt,
      records: records.map(record => [record.vehicleId, record.fingerprint]) }) };
}

export function buildIancarOneSourceBatch(capture: IancarOneListCapture): SourceIntakeBatch {
  const complete = capture.readyForRawIngest;
  return {
    laneId: 'PRODUCT_VEHICLE',
    source: {
      sourceId: capture.factScope === 'FULL_FACTS' ? `${IANCAR_ONE_SOURCE_ID}:full-facts` : IANCAR_ONE_SOURCE_ID,
      kind: 'API',
      displayName: '이안카 ONE 제휴 API',
      authorityScope: capture.factScope === 'FULL_FACTS' ? [
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
    coverage: capture.factScope === 'FULL_FACTS' && complete ? {
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
          scope: capture.factScope === 'FULL_FACTS' ? 'Iancar ONE full-facts attempt' : 'Iancar ONE /v1/vehicles attempted list',
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
