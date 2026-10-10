import type { VehicleAsset, VehicleExternalId, VehicleExternalIdKind } from './catalog.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const NEW_VEHICLE_UID = /^va_[0-9A-HJKMNP-TV-Z]{26}$/;
const EXISTING_VEHICLE_ASSET_ID = /^va_[0-9a-f]{24}$/;

export type VehicleUidClock = () => number | Date;
export type VehicleUidRandom = () => number;
export type VehicleUidOptions = { monotonic?: boolean };
export type VehicleUidCandidate = {
  plate?: string | null;
  vin?: string | null;
  supplierCode?: string | null;
  supplierVehicleId?: string | null;
  externalIds?: VehicleExternalId[];
};
export type NormalizedVehicleIds = {
  plate?: string;
  vin?: string;
  supplierCode?: string;
  supplierVehicleId?: string;
  externalIds: VehicleExternalId[];
};
export type VehicleUidResolution =
  | { action: 'LINK'; vehicleUid: string; asset: VehicleAsset; reason: 'VIN' | 'SUPPLIER_VEHICLE' | 'PLATE' }
  | { action: 'CREATE'; vehicleUid: string; externalIds: VehicleExternalId[] }
  | { action: 'HOLD'; reason: string }
  | { action: 'UNKNOWN'; reason: 'INSUFFICIENT_IDENTITY' };

let lastTime = -1;
let lastRandom: number[] = [];

function clockMillis(clock: VehicleUidClock): number {
  const value = clock();
  const millis = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(millis) || millis < 0 || millis > 0xffffffffffff) {
    throw new Error('INVALID_VEHICLE_UID_TIME');
  }
  return millis;
}

function randomChars(random: VehicleUidRandom): number[] {
  return Array.from({ length: 16 }, () => {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('INVALID_VEHICLE_UID_RANDOM');
    return Math.floor(value * 32);
  });
}

function incrementRandom(chars: number[]) {
  const next = [...chars];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i] = next[i]! + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error('VEHICLE_UID_MONOTONIC_OVERFLOW');
}

function encodeTime(millis: number) {
  let value = millis;
  const chars = Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[value % 32]!;
    value = Math.floor(value / 32);
  }
  return chars.join('');
}

export function newVehicleUid(
  clock: VehicleUidClock = () => Date.now(),
  random: VehicleUidRandom = Math.random,
  options: VehicleUidOptions = { monotonic: true },
) {
  let time = clockMillis(clock);
  let rand = randomChars(random);
  if (options.monotonic !== false) {
    if (time <= lastTime) {
      time = lastTime;
      rand = incrementRandom(lastRandom);
    }
    lastTime = time;
    lastRandom = rand;
  }
  return `va_${encodeTime(time)}${rand.map(x => CROCKFORD[x]).join('')}`;
}

export function isVehicleUid(value: string) {
  return NEW_VEHICLE_UID.test(value);
}

export function isExistingVehicleAssetId(value: string) {
  return EXISTING_VEHICLE_ASSET_ID.test(value);
}

const clean = (value: string | null | undefined) => {
  const v = value?.trim();
  return v ? v : undefined;
};
const normalizeVin = (value: string | null | undefined) => clean(value)?.toUpperCase();
const normalizePlate = (value: string | null | undefined) => clean(value);
const normalizeSupplierCode = (value: string | null | undefined) => clean(value)?.toUpperCase();

function normalizeId(id: VehicleExternalId): VehicleExternalId | null {
  const kind = id.kind;
  const value = kind === 'VIN' ? normalizeVin(id.value) : clean(id.value);
  if (!value) return null;
  const supplierCode = kind === 'SUPPLIER_VEHICLE' || kind === 'SHEET_ROW'
    ? normalizeSupplierCode(id.supplierCode)
    : normalizeSupplierCode(id.supplierCode);
  return {
    ...id,
    kind,
    value,
    ...(supplierCode ? { supplierCode } : {}),
    validTo: id.validTo ?? null,
  };
}

export function normalizeExternalIds(candidate: VehicleUidCandidate): NormalizedVehicleIds {
  const plate = normalizePlate(candidate.plate);
  const vin = normalizeVin(candidate.vin);
  const supplierCode = normalizeSupplierCode(candidate.supplierCode);
  const supplierVehicleId = clean(candidate.supplierVehicleId);
  const externalIds = (candidate.externalIds ?? []).map(normalizeId).filter((x): x is VehicleExternalId => Boolean(x));
  return {
    ...(plate ? { plate } : {}),
    ...(vin ? { vin } : {}),
    ...(supplierCode ? { supplierCode } : {}),
    ...(supplierVehicleId ? { supplierVehicleId } : {}),
    externalIds,
  };
}

export function isActiveExternalId(id: VehicleExternalId, at = new Date().toISOString()) {
  return id.validFrom <= at && (id.validTo === undefined || id.validTo === null || id.validTo > at);
}

function activeIds(asset: VehicleAsset, at: string): VehicleExternalId[] {
  const ids = (asset.externalIds ?? []).map(normalizeId).filter((x): x is VehicleExternalId => Boolean(x));
  const legacy: VehicleExternalId[] = [];
  if (asset.vin) legacy.push({ kind: 'VIN', value: normalizeVin(asset.vin)!, validFrom: asset.createdAt, source: 'legacy-field' });
  if (asset.plateNumber) legacy.push({ kind: 'PLATE', value: normalizePlate(asset.plateNumber)!, validFrom: asset.createdAt, source: 'legacy-field' });
  return [...ids, ...legacy].filter(id => isActiveExternalId(id, at));
}

function sameId(id: VehicleExternalId, kind: VehicleExternalIdKind, value: string, supplierCode?: string) {
  if (id.kind !== kind || id.value !== value) return false;
  if (kind !== 'SUPPLIER_VEHICLE') return true;
  return id.supplierCode === supplierCode;
}

export function findActiveAssets(
  assets: VehicleAsset[],
  kind: VehicleExternalIdKind,
  value: string | undefined,
  at = new Date().toISOString(),
  supplierCode?: string,
) {
  if (!value) return [];
  return assets.filter(asset => activeIds(asset, at).some(id => sameId(id, kind, value, supplierCode)));
}

function activeValue(asset: VehicleAsset, kind: VehicleExternalIdKind, at: string, supplierCode?: string) {
  return activeIds(asset, at).find(id => id.kind === kind && (kind !== 'SUPPLIER_VEHICLE' || id.supplierCode === supplierCode))?.value;
}

function contradicts(asset: VehicleAsset, ids: NormalizedVehicleIds, assets: VehicleAsset[], at: string) {
  const activeVin = activeValue(asset, 'VIN', at);
  if (ids.vin && activeVin && activeVin !== ids.vin) return true;
  const activeSupplier = activeValue(asset, 'SUPPLIER_VEHICLE', at, ids.supplierCode);
  if (ids.supplierVehicleId && activeSupplier && activeSupplier !== ids.supplierVehicleId) return true;
  const activePlate = activeValue(asset, 'PLATE', at);
  if (ids.plate && activePlate && activePlate !== ids.plate) {
    if (ids.vin === activeVin || (ids.supplierVehicleId === activeSupplier && ids.supplierCode)) {
      const plateOwners = findActiveAssets(assets, 'PLATE', ids.plate, at).filter(x => x.id !== asset.id);
      return plateOwners.length > 0;
    }
    return true;
  }
  return false;
}

function createExternalIds(ids: NormalizedVehicleIds, now: string): VehicleExternalId[] {
  const out: VehicleExternalId[] = [];
  if (ids.vin) out.push({ kind: 'VIN', value: ids.vin, validFrom: now, source: 'vehicle-uid-resolver' });
  if (ids.supplierVehicleId && ids.supplierCode) {
    out.push({ kind: 'SUPPLIER_VEHICLE', supplierCode: ids.supplierCode, value: ids.supplierVehicleId, validFrom: now, source: 'vehicle-uid-resolver' });
  }
  if (ids.plate) out.push({ kind: 'PLATE', value: ids.plate, validFrom: now, source: 'vehicle-uid-resolver' });
  return out;
}

export function resolveVehicleUid(
  candidate: VehicleUidCandidate,
  assets: VehicleAsset[],
  options: { now?: string; clock?: VehicleUidClock; random?: VehicleUidRandom } = {},
): VehicleUidResolution {
  const now = options.now ?? new Date().toISOString();
  const ids = normalizeExternalIds(candidate);
  const vin = findActiveAssets(assets, 'VIN', ids.vin, now);
  const supplier = findActiveAssets(assets, 'SUPPLIER_VEHICLE', ids.supplierVehicleId, now, ids.supplierCode);
  const plate = findActiveAssets(assets, 'PLATE', ids.plate, now);
  if (vin.length > 1) return { action: 'HOLD', reason: 'VIN_CONFLICT' };
  if (supplier.length > 1) return { action: 'HOLD', reason: 'SUPPLIER_VEHICLE_CONFLICT' };
  if (plate.length > 1) return { action: 'HOLD', reason: 'PLATE_CONFLICT' };
  const linked = [...new Map([...vin, ...supplier, ...plate].map(asset => [asset.id, asset])).values()];
  if (linked.length > 1) return { action: 'HOLD', reason: 'IDENTIFIER_POINTS_TO_DIFFERENT_ASSETS' };
  if (linked.length === 1) {
    const asset = linked[0]!;
    if (contradicts(asset, ids, assets, now)) return { action: 'HOLD', reason: 'IDENTIFIER_CONTRADICTION' };
    const reason = vin[0]?.id === asset.id ? 'VIN' : supplier[0]?.id === asset.id ? 'SUPPLIER_VEHICLE' : 'PLATE';
    return { action: 'LINK', vehicleUid: asset.id, asset, reason };
  }
  if (ids.vin || (ids.supplierCode && ids.supplierVehicleId) || ids.plate) {
    return {
      action: 'CREATE',
      vehicleUid: newVehicleUid(options.clock, options.random),
      externalIds: createExternalIds(ids, now),
    };
  }
  return { action: 'UNKNOWN', reason: 'INSUFFICIENT_IDENTITY' };
}

export function addExternalId(asset: VehicleAsset, id: VehicleExternalId, now: string): VehicleAsset {
  const normalized = normalizeId(id);
  if (!normalized) return structuredClone(asset);
  const externalIds = structuredClone(asset.externalIds ?? []);
  const activeIndex = externalIds.findIndex(existing =>
    existing.kind === normalized.kind &&
    (normalized.kind !== 'SUPPLIER_VEHICLE' || normalizeSupplierCode(existing.supplierCode) === normalized.supplierCode) &&
    isActiveExternalId(existing, now)
  );
  if (activeIndex >= 0) {
    const active = normalizeId(externalIds[activeIndex]!)!;
    if (active.value === normalized.value) return { ...structuredClone(asset), externalIds };
    externalIds[activeIndex] = { ...externalIds[activeIndex]!, validTo: now };
  }
  externalIds.push({ ...normalized, validFrom: normalized.validFrom || now, validTo: normalized.validTo ?? null });
  return { ...structuredClone(asset), externalIds };
}
