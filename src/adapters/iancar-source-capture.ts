import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SourceIntakeBatch } from '../domain/source-intake.js';

export const IANCAR_SOURCE_CAPTURE_VERSION = 'iancar-source-capture/1';
export const IANCAR_SHEET_ID = '1fJuFSdaW559niD0ow7vVC3qcgjy8KRb8Cr3U8Of01vs';
export const IANCAR_SHEET_TABS = [
  { title: '이안카', gid: '2008897223' }, { title: '이안카 재렌트', gid: '126495265' }
] as const;
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
export type IancarErpRead = Awaited<ReturnType<IancarCaptureTransport['readErp']>> & { capturedAt: string };

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

export type IancarCaptureTransport = {
  readErp(): Promise<{ sourceRevision: string; observedAt: string; collectionComplete: boolean;
    parserVersion: string; vehicles: Json[]; rateQuotes: Json[]; rateCoverageComplete: boolean; raw: Json }>;
  readSheetTab(tab: typeof IANCAR_SHEET_TABS[number]): Promise<{ sourceRevision: string; observedAt: string;
    collectionComplete: boolean; rowCount: number; rawCsv: string }>;
};

export type IancarSourceCapture = {
  version: typeof IANCAR_SOURCE_CAPTURE_VERSION; capturedAt: string;
  crossSourceConsistency: 'NON_ATOMIC';
  erp: Awaited<ReturnType<IancarCaptureTransport['readErp']>> & {
    rawDigest: string; vehicleDigest: string; rateQuoteDigest: string;
  };
  sheet: { spreadsheetId: typeof IANCAR_SHEET_ID; tabs: Array<typeof IANCAR_SHEET_TABS[number]
    & Awaited<ReturnType<IancarCaptureTransport['readSheetTab']>>>; };
  digest: string;
};

/** Captures both sources as one evidence bundle; no source or canonical writes. */
export async function captureIancarSource(transport: IancarCaptureTransport): Promise<IancarSourceCapture> {
  const [erp, ...tabs] = await Promise.all([
    transport.readErp(), ...IANCAR_SHEET_TABS.map(tab => transport.readSheetTab(tab))
  ]);
  if (!text(erp.sourceRevision) || !instant(erp.observedAt) || !text(erp.parserVersion) || typeof erp.collectionComplete !== 'boolean'
    || typeof erp.rateCoverageComplete !== 'boolean' || !Array.isArray(erp.vehicles) || !erp.vehicles.every(json)
    || !Array.isArray(erp.rateQuotes) || !erp.rateQuotes.every(json) || !json(erp.raw)) throw new Error('INVALID_IANCAR_ERP_CAPTURE');
  const sheetTabs = tabs.map((value, index) => {
    if (!text(value.sourceRevision) || !instant(value.observedAt) || typeof value.collectionComplete !== 'boolean'
      || !Number.isSafeInteger(value.rowCount) || value.rowCount < 0 || typeof value.rawCsv !== 'string') {
      throw new Error('INVALID_IANCAR_SHEET_CAPTURE');
    }
    return { ...IANCAR_SHEET_TABS[index]!, ...structuredClone(value) };
  });
  const unsigned = { version: IANCAR_SOURCE_CAPTURE_VERSION as typeof IANCAR_SOURCE_CAPTURE_VERSION,
    capturedAt: new Date().toISOString(), crossSourceConsistency: 'NON_ATOMIC' as const,
    erp: { ...structuredClone(erp), rawDigest: digest(erp.raw), vehicleDigest: digest(erp.vehicles),
      rateQuoteDigest: digest(erp.rateQuotes) },
    sheet: { spreadsheetId: IANCAR_SHEET_ID as typeof IANCAR_SHEET_ID, tabs: sheetTabs } };
  return { ...unsigned, digest: digest(unsigned) };
}

/** Count-only inspection. Incomplete/freshness-unknown evidence can be preserved but never activated. */
export function inspectIancarCapture(capture: IancarSourceCapture) {
  const { digest: claimed, ...unsigned } = capture;
  if (claimed !== digest(unsigned)) throw new Error('IANCAR_CAPTURE_DIGEST_MISMATCH');
  if (capture.crossSourceConsistency !== 'NON_ATOMIC' || capture.erp.rawDigest !== digest(capture.erp.raw)
    || capture.erp.vehicleDigest !== digest(capture.erp.vehicles)
    || capture.erp.rateQuoteDigest !== digest(capture.erp.rateQuotes)) throw new Error('IANCAR_DERIVATION_DIGEST_MISMATCH');
  const coverageComplete = capture.erp.collectionComplete && capture.sheet.tabs.every(tab => tab.collectionComplete);
  const pricingComplete = capture.erp.rateCoverageComplete;
  return {
    status: coverageComplete && pricingComplete ? 'READY_FOR_MAPPING_REVIEW' as const : 'HOLD' as const,
    canonicalWriteAuthorized: false as const, cutoverAuthorized: false as const, sourceDigest: capture.digest,
    erpVehicles: capture.erp.vehicles.length, erpRateQuotes: capture.erp.rateQuotes.length,
    sheetRows: Object.fromEntries(capture.sheet.tabs.map(tab => [tab.title, tab.rowCount])),
    coverageComplete, pricingComplete, crossSourceConsistency: capture.crossSourceConsistency,
    remaining: [...(!coverageComplete ? ['SOURCE_COLLECTION_INCOMPLETE'] : []),
      ...(!pricingComplete ? ['ERP_RATE_COVERAGE_INCOMPLETE'] : []), 'NO_CANONICAL_WRITE_OR_CONSUMER_CUTOVER']
  };
}

/** Fixed private, exclusive-create persistence. No caller-selected output path and no overwrite. */
export async function persistIancarCapture(capture: IancarSourceCapture) {
  inspectIancarCapture(capture);
  const privateRoot = join(homedir(), '.codex', 'private', 'freepass-data-iancar-captures');
  await mkdir(privateRoot, { recursive: true });
  if ((await realpath(privateRoot)).toLowerCase() !== privateRoot.toLowerCase()) throw new Error('PRIVATE_PATH_REDIRECT');
  for (let folder = privateRoot; ; folder = dirname(folder)) {
    if ((await lstat(folder)).isSymbolicLink()) throw new Error('PRIVATE_PATH_SYMLINK');
    if (dirname(folder) === folder) break;
  }
  const runId = randomUUID();
  const runDir = join(privateRoot, runId);
  await mkdir(runDir, { recursive: false, mode: 0o700 });
  const capturePath = join(runDir, 'capture.json');
  await writeFile(capturePath, JSON.stringify(capture), { flag: 'wx', mode: 0o600 });
  const readback = JSON.parse(await readFile(capturePath, 'utf8')) as IancarSourceCapture;
  if (readback.digest !== capture.digest || inspectIancarCapture(readback).sourceDigest !== capture.digest) {
    throw new Error('PRIVATE_CAPTURE_READBACK_MISMATCH');
  }
  return { runId, capturePath, digest: capture.digest };
}
