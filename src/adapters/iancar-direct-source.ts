import { createHash } from 'node:crypto';
import type { SourceIntakeBatch } from '../domain/source-intake.js';

// This is a FreePass Data adapter to Iancar's ORIGINAL ERP. No ERP4 import,
// checkout, Firestore initialization, Google Sheet mutation or rate inference.
export const IANCAR_DIRECT_ORIGIN = 'https://xn--le5bt3bwxk.com';
export const IANCAR_DIRECT_SOURCE_ID = 'supplier:RP031:iancar-original-erp-inventory';
export const IANCAR_DIRECT_PARSER = 'iancar-direct-inventory/1';
const MAX_SOURCE_AGE_MS = 2 * 60 * 60 * 1000;
const VALID_STATES = new Set(['available', 'merchandising', 'reserved', 'sold', 'unavailable']);
type Dict = Record<string, unknown>;
type Fetcher = typeof fetch;
const dict = (x: unknown): x is Dict => !!x && typeof x === 'object' && !Array.isArray(x);
const clean = (x: unknown): string => typeof x === 'string' ? x.trim() : '';
const plate = (x: unknown): string => clean(x).replace(/\s+/g, '').toUpperCase();
const sha = (x: unknown): string => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const date = (x: unknown) => typeof x === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(x)
  && Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
const unitFields = ['vehicleNo', 'plate', 'name', 'year', 'fuel', 'color', 'mileage',
  'status', 'affiliation', 'dispatchLocation', 'thumbnail'] as const;
const keepUnit = (x: Dict) => Object.fromEntries(unitFields
  .filter(key => x[key] !== undefined && x[key] !== null)
  .map(key => [key, x[key]]));

export type IancarDirectInventory = {
  batch: SourceIntakeBatch;
  evidence: {
    sourceDigest: string; capturedAt: string; upstreamSyncedAt: string | null;
    declaredTotal: number | null; modelUnits: number; reservedUnits: number;
    unknownStatusCount: number; issues: string[]; readyForRawIngest: boolean;
    pricingVerified: false; canonicalWriteAuthorized: false; publicationAuthorized: false;
  };
};

/** No caller-selected URL, logged body or persisted credentials. Sessions live only in memory. */
export async function readOriginalIancarInventory(
  account: { email: string; password: string },
  fetcher: Fetcher = fetch
): Promise<unknown> {
  if (!clean(account?.email) || !clean(account?.password)) throw new Error('IANCAR_CREDENTIALS_REQUIRED');
  const jar = new Map<string, string>();
  const merge = (res: Response) => {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const pair = line.split(';', 1)[0]?.trim() ?? '';
      const key = pair.split('=', 1)[0]?.trim() ?? '';
      if (key && pair.includes('=')) jar.set(key, pair);
    }
  };
  const request = async (path: '/login' | '/api/auth/login' | '/api/inventory',
    method: 'GET' | 'POST' = 'GET', body?: object) => {
    const res = await fetcher(`${IANCAR_DIRECT_ORIGIN}${path}`, {
      method, redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'User-Agent': 'FreePassData/1 direct-read',
        ...(jar.size ? { cookie: [...jar.values()].join('; ') } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    // Redirects, including to a third-party login page, are NOT followed.
    if (!res.ok) throw new Error(`IANCAR_SOURCE_HTTP_${path === '/login' ? 'SESSION' : path === '/api/auth/login' ? 'AUTH' : 'INVENTORY'}_${res.status}`);
    merge(res);
    return res;
  };
  await request('/login');
  await request('/api/auth/login', 'POST', { login: account.email, password: account.password });
  if (!jar.has('eancar_session')) throw new Error('IANCAR_AUTH_SESSION_MISSING');
  const response = await request('/api/inventory');
  // The API does not provide authorized rental rates to this credential.
  return response.json();
}

/**
 * Convert the ORIGINAL supplier API's inventory into the EXISTING Data RAW
 * intake contract. Completeness and freshness are independent of HTTP 200.
 * No guessed prices, no fallback to ERP4/RTDB, no automatic retirement.
 */
export function prepareIancarDirectInventory(
  original: unknown,
  capturedAt = new Date().toISOString()
): IancarDirectInventory {
  if (!dict(original) || !Array.isArray(original.models) || !Array.isArray(original.reservedVehicles)
    || !Number.isFinite(date(capturedAt))) throw new Error('INVALID_IANCAR_INVENTORY_ENVELOPE');
  const units = new Map<string, Dict>();
  let modelUnits = 0;
  let unknownStatusCount = 0;
  const issues: string[] = [];
  for (const model of original.models) {
    if (!dict(model) || !Array.isArray(model.units)) throw new Error('INVALID_IANCAR_MODEL');
    for (const raw of model.units) {
      if (!dict(raw) || !plate(raw.plate) || units.has(plate(raw.plate))) {
        throw new Error('INVALID_OR_DUPLICATE_IANCAR_PLATE');
      }
      const state = clean(raw.status).toLowerCase();
      if (!VALID_STATES.has(state)) unknownStatusCount++;
      units.set(plate(raw.plate), { ...keepUnit(raw), modelName: clean(model.name), sourceStatus: state });
      modelUnits++;
    }
  }
  const reservations = new Set<string>();
  for (const reserved of original.reservedVehicles) {
    if (!dict(reserved) || !plate(reserved.plate) || reservations.has(plate(reserved.plate))) {
      throw new Error('INVALID_OR_DUPLICATE_IANCAR_RESERVATION');
    }
    const id = plate(reserved.plate);
    reservations.add(id);
    const existing = units.get(id);
    if (existing && existing.sourceStatus === 'available') issues.push('RESERVATION_STATUS_CONFLICT');
    units.set(id, {
      ...(existing ?? { ...keepUnit(reserved), modelName: clean(reserved.name) }),
      sourceStatus: 'reserved',
      reservationObserved: true
    });
  }
  const upstreamSyncedAt = clean(original.syncedAt) || null;
  const upstreamMs = date(upstreamSyncedAt);
  const observedMs = date(capturedAt);
  if (original.stale !== false) issues.push('UPSTREAM_STALE_OR_UNVERIFIED');
  if (!Number.isFinite(upstreamMs) || upstreamMs > observedMs + 5 * 60_000
    || observedMs - upstreamMs > MAX_SOURCE_AGE_MS) issues.push('UPSTREAM_FRESHNESS_UNVERIFIED');
  if (!Number.isSafeInteger(original.total) || original.total !== modelUnits) issues.push('INVENTORY_COUNT_MISMATCH');
  if (original.reservedTotal !== undefined &&
    (!Number.isSafeInteger(original.reservedTotal) || original.reservedTotal !== reservations.size))
    issues.push('RESERVATION_COUNT_MISMATCH');
  if (modelUnits === 0) issues.push('EMPTY_INVENTORY_REQUIRES_REVIEW');
  if (unknownStatusCount) issues.push('UNKNOWN_SOURCE_STATUS');
  const sourceDigest = sha(original);
  const records = [...units.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => ({
    sourceRecordId: id,
    payload: { providerCompanyCode: 'RP031', ...value }
  }));
  const readyForRawIngest = issues.length === 0;
  const batch: SourceIntakeBatch = {
    laneId: 'PRODUCT_VEHICLE',
    source: {
      sourceId: IANCAR_DIRECT_SOURCE_ID, kind: 'API',
      displayName: '이안카 원본 ERP 재고 직접 수집',
      authorityScope: ['RP031 vehicle inventory / availability evidence only; NO rental rates'],
      expectedFreshnessSeconds: MAX_SOURCE_AGE_MS / 1000
    },
    // The upstream time determines freshness; retrieval time alone never proves it.
    observedAt: Number.isFinite(upstreamMs) ? new Date(upstreamMs).toISOString() : capturedAt,
    sourceRevision: `${IANCAR_DIRECT_PARSER}:${sourceDigest}`,
    checksum: sourceDigest,
    coverage: readyForRawIngest
      ? { mode: 'FULL', completeness: 'COMPLETE', scope: 'original ERP model units and reserved plates',
          note: 'RAW_ONLY: pricing/canonical/publication are NOT authorized' }
      : { mode: 'PARTIAL', completeness: 'INCOMPLETE', scope: 'original ERP inventory observation',
          note: `HOLD: ${[...new Set(issues)].join(',')}` },
    records
  };
  return {
    batch,
    evidence: {
      sourceDigest, capturedAt, upstreamSyncedAt, declaredTotal: Number.isSafeInteger(original.total) ? original.total as number : null,
      modelUnits, reservedUnits: reservations.size, unknownStatusCount, issues: [...new Set(issues)],
      readyForRawIngest, pricingVerified: false, canonicalWriteAuthorized: false, publicationAuthorized: false
    }
  };
}

export type InventoryParityRow = { plate: string; status: string };
const ERP_STATE: Record<string, string> = {
  '출고가능': 'available', '출고협의': 'merchandising', '예약중': 'reserved', '계약중': 'reserved',
  '판매완료': 'sold', '출고불가': 'unavailable'
};

/** Count-only external ERP vs Data/ERP5 observation: never a publication PASS. */
export function compareIancarInventory(input: IancarDirectInventory, target: InventoryParityRow[]) {
  const upstream = new Map(input.batch.records.map(r =>
    [r.sourceRecordId, clean(r.payload.sourceStatus).toLowerCase()]));
  const downstream = new Map<string, string>();
  let duplicateTarget = 0;
  for (const row of target) {
    const key = plate(row.plate);
    if (!key || downstream.has(key)) { duplicateTarget++; continue; }
    downstream.set(key, ERP_STATE[clean(row.status)] ?? 'UNKNOWN');
  }
  let sourceOnly = 0, targetOnly = 0, statusMismatch = 0;
  for (const [key, state] of upstream) {
    if (!downstream.has(key)) sourceOnly++;
    else if (state !== downstream.get(key)) statusMismatch++;
  }
  for (const key of downstream.keys()) if (!upstream.has(key)) targetOnly++;
  return {
    sourceCount: upstream.size, targetCount: downstream.size, sourceOnly, targetOnly,
    statusMismatch, duplicateTarget,
    status: input.evidence.readyForRawIngest && sourceOnly === 0 && targetOnly === 0 &&
      statusMismatch === 0 && duplicateTarget === 0 ? 'SOURCE_INVENTORY_PARITY_ONLY' : 'HOLD_SOURCE_PARITY',
    // This is not a rate audit, Canonical activation, F01/F86 audit or consumer readback.
    pricingVerified: false, publicationAuthorized: false
  } as const;
}
