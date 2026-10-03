import { createHash } from 'node:crypto';
import type { SourceIntakeBatch } from '../domain/source-intake.js';

export const IANCAR_SOURCE_CAPTURE_VERSION = 'iancar-source-capture/1';
// Iancar inventory authority is the Iancar system only (ONE API, then this logged-in ERP inventory as
// backup). The supplier Google Sheet and F54 are not Iancar sources (2026-10-04 user decision).
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const text = (x: unknown): x is string => typeof x === 'string' && !!x.trim() && x === x.trim();
const instant = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x)
  && Number.isFinite(Date.parse(x));
const json = (x: unknown): x is Json => x === null || typeof x === 'string' || typeof x === 'boolean'
  || (typeof x === 'number' && Number.isFinite(x)) || (Array.isArray(x) && x.every(json))
  || (!!x && typeof x === 'object' && !Array.isArray(x)
    && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null)
    && Object.values(x).every(json));
const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

export const IANCAR_ERP_ORIGIN = 'https://xn--le5bt3bwxk.com';
export type IancarErpRead = { sourceRevision: string; observedAt: string; collectionComplete: boolean;
  parserVersion: string; vehicles: Json[]; rateQuotes: Json[]; rateCoverageComplete: boolean; raw: Json; capturedAt: string };

/** Reuses the supplier's authenticated inventory protocol. Never logs bodies, cookies or credentials. */
export function iancarErpReadTransport(input: { accountJson: string; fetchImpl?: typeof fetch }) {
  let account: { email?: unknown; password?: unknown };
  try { account = JSON.parse(input.accountJson); } catch { throw new Error('IANCAR_CREDENTIAL_INVALID'); }
  if (!account || !text(account.email) || !text(account.password)) throw new Error('IANCAR_CREDENTIAL_INVALID');
  const request = input.fetchImpl ?? fetch;
  return async (): Promise<IancarErpRead> => {
    const jar = new Map<string, string>();
    const call = async (path: string, body?: object) => {
      let response: Response;
      try {
        response = await request(`${IANCAR_ERP_ORIGIN}${path}`, {
          method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.timeout(20_000),
          headers: { 'User-Agent': 'FreePassData iancar-source', Cookie: [...jar.values()].join('; '),
            ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {})
        });
      } catch { throw new Error('IANCAR_ERP_TRANSPORT_FAILED'); }
      if (!response.ok) throw new Error(`IANCAR_ERP_HTTP_${response.status}`);
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0]!;
        jar.set(pair.split('=')[0]!, pair);
      }
      return response;
    };
    await call('/login');
    const login = await call('/api/auth/login', { login: account.email, password: account.password });
    let accepted: unknown;
    try { accepted = await login.json(); } catch { throw new Error('IANCAR_AUTH_RESPONSE_INVALID'); }
    if (!accepted || typeof accepted !== 'object' || (accepted as { ok?: unknown }).ok !== true
      || !jar.has('eancar_session')) throw new Error('IANCAR_AUTH_NOT_CONFIRMED');
    let raw: unknown;
    try { raw = await (await call('/api/inventory')).json(); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('IANCAR_ERP_')) throw error;
      throw new Error('IANCAR_INVENTORY_JSON_INVALID');
    }
    return parseIancarErpInventory(raw);
  };
}

/** Inventory API is available + reserved stock, NOT all fleet vehicles and NOT the rate source. */
export function parseIancarErpInventory(raw: unknown, now = new Date()): IancarErpRead {
  if (!json(raw) || !raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('IANCAR_INVENTORY_SHAPE_INVALID');
  const data = raw as Record<string, Json>;
  const count = (value: Json | undefined): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!Array.isArray(data.models) || !Array.isArray(data.reservedVehicles) || !count(data.total)
    || !count(data.reservedTotal) || !count(data.fleetTotal) || !instant(data.syncedAt)
    || typeof data.stale !== 'boolean') throw new Error('IANCAR_INVENTORY_SHAPE_INVALID');
  const vehicles: Json[] = [];
  const ids = new Set<string>();
  const append = (unit: Json, modelName: Json | undefined, inventoryGroup: string) => {
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) throw new Error('IANCAR_VEHICLE_SHAPE_INVALID');
    const row = unit as Record<string, Json>;
    if (!text(row.vehicleNo) || !text(row.plate) || ids.has(row.vehicleNo)) throw new Error('IANCAR_VEHICLE_ID_INVALID');
    ids.add(row.vehicleNo);
    vehicles.push({ ...row, modelName: modelName ?? null, inventoryGroup });
  };
  for (const model of data.models) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('IANCAR_MODEL_SHAPE_INVALID');
    const row = model as Record<string, Json>;
    if (!Array.isArray(row.units) || !count(row.count) || row.count !== row.units.length) throw new Error('IANCAR_MODEL_COUNT_MISMATCH');
    for (const unit of row.units) append(unit, row.name, 'MODEL_INVENTORY');
  }
  if (vehicles.length !== data.total || data.reservedVehicles.length !== data.reservedTotal
    || data.fleetTotal < data.total + data.reservedTotal) throw new Error('IANCAR_INVENTORY_COUNT_MISMATCH');
  for (const unit of data.reservedVehicles) append(unit, null, 'RESERVED');
  const age = now.getTime() - Date.parse(data.syncedAt);
  return { sourceRevision: digest(raw), observedAt: data.syncedAt, capturedAt: now.toISOString(),
    collectionComplete: data.stale === false && age >= 0 && age <= 3_600_000,
    parserVersion: 'iancar-erp-inventory/1', vehicles, rateQuotes: [], rateCoverageComplete: false, raw };
}

/** Every observed vehicle enters RAW, including ERP-only new stock. No existing-product filter. */
export function buildIancarErpRawIntakeBatch(capture: IancarErpRead): SourceIntakeBatch {
  if (!instant(capture.capturedAt)) throw new Error('IANCAR_ERP_CAPTURE_TIME_INVALID');
  const checked = parseIancarErpInventory(capture.raw, new Date(capture.capturedAt));
  if (capture.sourceRevision !== checked.sourceRevision || capture.observedAt !== checked.observedAt
    || capture.collectionComplete !== checked.collectionComplete
    || capture.parserVersion !== checked.parserVersion || digest(capture.vehicles) !== digest(checked.vehicles)
    || capture.rateCoverageComplete !== false || capture.rateQuotes.length !== 0) throw new Error('IANCAR_ERP_DERIVATION_MISMATCH');
  return { laneId: 'PRODUCT_VEHICLE',
    source: { sourceId: 'supplier/RP031/erp-inventory', kind: 'API', displayName: 'Iancar ERP inventory',
      authorityScope: ['RP031:observed-vehicle-inventory'], expectedFreshnessSeconds: 3600 },
    observedAt: checked.observedAt, sourceRevision: checked.sourceRevision, checksum: digest(checked.raw),
    coverage: { mode: 'PARTIAL', completeness: checked.collectionComplete ? 'COMPLETE' : 'INCOMPLETE',
      scope: 'available+reserved inventory only; not full fleet; no rental rates',
      note: 'Never infer fleet absence or replace rental rates from this response.' },
    records: [ { sourceRecordId: '__inventory_snapshot', sourceFingerprint: digest(checked.raw),
      payload: { raw: checked.raw, capturedAt: checked.capturedAt } },
      ...checked.vehicles.map(vehicle => ({ sourceRecordId: `vehicle:${(vehicle as Record<string, Json>).vehicleNo}`,
        sourceFingerprint: digest(vehicle), payload: { vehicle, parserVersion: checked.parserVersion,
          pricingState: 'UNKNOWN', supplierCode: 'RP031' } })) ] };
}
