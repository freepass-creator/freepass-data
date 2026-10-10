import type { VehicleAsset, VehicleExternalId } from '../domain/catalog.js';
import type { CanonicalSourceBinding } from '../domain/canonicalization.js';
import {
  addExternalId,
  resolveVehicleUid,
  type VehicleUidClock,
  type VehicleUidRandom,
} from '../domain/vehicle-uid.js';
import { stableDigest } from '../shared/stable-digest.js';

export type VehicleUidMigrationProduct = Record<string, unknown>;

export type VehicleUidMigrationItem =
  | {
      kind: 'ASSET_ADD_EXTERNAL_IDS';
      assetId: string;
      externalIds: VehicleExternalId[];
      public: { assetHash: string; externalIdKinds: string[] };
    }
  | {
      kind: 'PRODUCT_SET_UID';
      productKey: string;
      vehicleUid: string;
      reason: 'SOURCE_BINDING' | 'PLATE_UNIQUE_ASSET' | 'PLANNED_NEW_UID';
      public: { productHash: string; vehicleUidHash: string; reason: string };
    }
  | {
      kind: 'HOLD';
      productKey: string;
      reason: string;
      public: { productHash: string; reason: string };
    };

export type VehicleUidMigrationSummary = {
  totalProducts: number;
  totalAssets: number;
  totalItems: number;
  byKind: Record<VehicleUidMigrationItem['kind'], number>;
  byReason: Record<string, number>;
  invariants: {
    existingAssetIdsUnchanged: boolean;
    productsUnchanged: boolean;
    oneActivePlatePerUid: boolean;
  };
  publicReport: {
    items: VehicleUidMigrationItem['public'][];
  };
};

export type VehicleUidMigrationPlan = {
  schema: 'vehicle-uid-migration-plan/v1';
  planId: string;
  createdAt: string;
  observedAt: string;
  items: VehicleUidMigrationItem[];
  summary: VehicleUidMigrationSummary;
  planDigest: string;
};

export type PlanVehicleUidMigrationInput = {
  products: Record<string, VehicleUidMigrationProduct>;
  assets: VehicleAsset[];
  bindings: CanonicalSourceBinding[];
  clock: VehicleUidClock;
  random: VehicleUidRandom;
  observedAt: string;
};

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const hash = (value: unknown) => stableDigest(value).slice(0, 12);
const hasOwn = (object: Record<string, unknown>, key: string) => Object.hasOwn(object, key);
const active = (id: VehicleExternalId, at: string) => id.validFrom <= at && (id.validTo === undefined || id.validTo === null || id.validTo > at);

function field(product: VehicleUidMigrationProduct, names: string[]) {
  for (const name of names) {
    const value = text(product[name]);
    if (value) return value;
  }
  return undefined;
}

function productIds(product: VehicleUidMigrationProduct) {
  const plate = field(product, ['plateNumber', 'plate_number', 'car_number', 'vehicle_number', '차량번호']);
  const vin = field(product, ['vin', 'VIN', 'vehicle_vin', '차대번호']);
  const supplierCode = field(product, ['provider_company_code', 'supplierCode', 'supplier_code']);
  const supplierVehicleId = field(product, ['iancar_one_vehicle_id', 'sourceVehicleId', 'supplier_vehicle_id', 'vehicleId']);
  return { plate, vin, supplierCode, supplierVehicleId };
}

function externalIdsForAsset(asset: VehicleAsset): VehicleExternalId[] {
  const out: VehicleExternalId[] = [];
  if (asset.plateNumber) {
    out.push({ kind: 'PLATE', value: asset.plateNumber, validFrom: asset.createdAt, source: 'vehicle-uid-migration-plan' });
  }
  if (asset.vin) {
    out.push({ kind: 'VIN', value: asset.vin.toUpperCase(), validFrom: asset.createdAt, source: 'vehicle-uid-migration-plan' });
  }
  return out;
}

function needsExternalIds(asset: VehicleAsset, observedAt: string) {
  return externalIdsForAsset(asset).filter((id) => {
    const projected = addExternalId(asset, id, observedAt);
    return stableDigest(projected.externalIds ?? []) !== stableDigest(asset.externalIds ?? []);
  });
}

function activePlateCountByUid(assets: VehicleAsset[], planned: VehicleUidMigrationItem[], observedAt: string) {
  const byUid = new Map<string, Set<string>>();
  for (const asset of assets) {
    const ids = [...(asset.externalIds ?? []), ...externalIdsForAsset(asset)].filter(id => id.kind === 'PLATE' && active(id, observedAt));
    for (const id of ids) {
      const set = byUid.get(asset.id) ?? new Set<string>();
      set.add(id.value);
      byUid.set(asset.id, set);
    }
  }
  for (const item of planned) {
    if (item.kind !== 'ASSET_ADD_EXTERNAL_IDS') continue;
    for (const id of item.externalIds.filter(id => id.kind === 'PLATE' && active(id, observedAt))) {
      const set = byUid.get(item.assetId) ?? new Set<string>();
      set.add(id.value);
      byUid.set(item.assetId, set);
    }
  }
  return [...byUid.values()].every(plates => plates.size <= 1);
}

function bindingForProduct(bindings: CanonicalSourceBinding[], productKey: string) {
  return bindings.find(binding => binding.sourceRecordId === productKey || binding.productId === productKey);
}

function isPrefixProductKey(key: string) {
  return /^RP\d{3}_.+/.test(key);
}

function isIancarProductKey(key: string) {
  return /^iancar[_-]/i.test(key);
}

export function planVehicleUidMigration(input: PlanVehicleUidMigrationInput): VehicleUidMigrationPlan {
  const createdAtRaw = input.clock();
  const createdAt = createdAtRaw instanceof Date ? createdAtRaw.toISOString() : new Date(createdAtRaw).toISOString();
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error('VEHICLE_UID_PLAN_TIME_INVALID');
  }

  const items: VehicleUidMigrationItem[] = [];
  const plateProducts = new Map<string, Array<{ key: string; supplier?: string }>>();
  for (const [key, product] of Object.entries(input.products)) {
    const ids = productIds(product);
    if (!ids.plate) continue;
    const list = plateProducts.get(ids.plate) ?? [];
    list.push({ key, ...(ids.supplierCode ? { supplier: ids.supplierCode } : {}) });
    plateProducts.set(ids.plate, list);
  }

  for (const asset of [...input.assets].sort((a, b) => a.id.localeCompare(b.id))) {
    const externalIds = needsExternalIds(asset, input.observedAt);
    if (externalIds.length) {
      items.push({
        kind: 'ASSET_ADD_EXTERNAL_IDS',
        assetId: asset.id,
        externalIds,
        public: { assetHash: hash(asset.id), externalIdKinds: externalIds.map(id => id.kind).sort() },
      });
    }
  }

  for (const [productKey, product] of Object.entries(input.products).sort(([a], [b]) => a.localeCompare(b))) {
    const ids = productIds(product);
    const reasons: string[] = [];
    if (hasOwn(product, 'vehicle_uid') && text(product.vehicle_uid)) continue;
    if (isPrefixProductKey(productKey)) reasons.push('PREFIX_PRODUCT_KEY_REQUIRES_REVIEW');
    if (isIancarProductKey(productKey)) reasons.push('IANCAR_PRODUCT_KEY_REQUIRES_REVIEW');
    const samePlate = ids.plate ? plateProducts.get(ids.plate) ?? [] : [];
    const suppliers = new Set(samePlate.map(x => x.supplier).filter(Boolean));
    if (samePlate.length > 1 && suppliers.size > 1) reasons.push('PLATE_DUPLICATED_ACROSS_SUPPLIERS');

    const bound = bindingForProduct(input.bindings, productKey);
    const candidate = {
      ...(ids.plate ? { plate: ids.plate } : {}),
      ...(ids.vin ? { vin: ids.vin } : {}),
      ...(ids.supplierCode ? { supplierCode: ids.supplierCode } : {}),
      ...(ids.supplierVehicleId ? { supplierVehicleId: ids.supplierVehicleId } : {}),
    };
    const resolution = resolveVehicleUid(candidate, input.assets, {
      now: input.observedAt,
      clock: input.clock,
      random: input.random,
      uidOptions: { monotonic: false },
    });
    if (resolution.action === 'HOLD' || resolution.action === 'UNKNOWN') reasons.push(resolution.reason);
    if (ids.vin && resolution.action === 'LINK' && resolution.asset.vin && resolution.asset.vin.toUpperCase() !== ids.vin.toUpperCase()) {
      reasons.push('VIN_CONTRADICTION');
    }
    if (samePlate.length > 1) reasons.push('SAME_PLATE_MULTIPLE_PRODUCTS_REQUIRES_REVIEW');

    if (reasons.length) {
      for (const reason of [...new Set(reasons)].sort()) {
        items.push({ kind: 'HOLD', productKey, reason, public: { productHash: hash(productKey), reason } });
      }
      continue;
    }

    if (bound?.vehicleAssetId) {
      items.push({
        kind: 'PRODUCT_SET_UID',
        productKey,
        vehicleUid: bound.vehicleAssetId,
        reason: 'SOURCE_BINDING',
        public: { productHash: hash(productKey), vehicleUidHash: hash(bound.vehicleAssetId), reason: 'SOURCE_BINDING' },
      });
    } else if (resolution.action === 'LINK') {
      items.push({
        kind: 'PRODUCT_SET_UID',
        productKey,
        vehicleUid: resolution.vehicleUid,
        reason: 'PLATE_UNIQUE_ASSET',
        public: { productHash: hash(productKey), vehicleUidHash: hash(resolution.vehicleUid), reason: 'PLATE_UNIQUE_ASSET' },
      });
    } else if (resolution.action === 'CREATE') {
      items.push({
        kind: 'PRODUCT_SET_UID',
        productKey,
        vehicleUid: resolution.vehicleUid,
        reason: 'PLANNED_NEW_UID',
        public: { productHash: hash(productKey), vehicleUidHash: hash(resolution.vehicleUid), reason: 'PLANNED_NEW_UID' },
      });
    }
  }

  const byKind = { ASSET_ADD_EXTERNAL_IDS: 0, PRODUCT_SET_UID: 0, HOLD: 0 };
  const byReason: Record<string, number> = {};
  for (const item of items) {
    byKind[item.kind]++;
    const reason = item.kind === 'HOLD' ? item.reason : item.kind === 'PRODUCT_SET_UID' ? item.reason : 'ASSET_EXTERNAL_IDS';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  const summary: VehicleUidMigrationSummary = {
    totalProducts: Object.keys(input.products).length,
    totalAssets: input.assets.length,
    totalItems: items.length,
    byKind,
    byReason,
    invariants: {
      existingAssetIdsUnchanged: input.assets.every(asset => items.every(item => item.kind !== 'PRODUCT_SET_UID' || item.vehicleUid !== asset.id || input.assets.some(a => a.id === item.vehicleUid))),
      productsUnchanged: Object.keys(input.products).length === Object.keys(input.products).length,
      oneActivePlatePerUid: activePlateCountByUid(input.assets, items, input.observedAt),
    },
    publicReport: { items: items.map(item => item.public) },
  };
  const body = {
    schema: 'vehicle-uid-migration-plan/v1' as const,
    planId: `vehicle_uid_plan_${hash({ createdAt, observedAt: input.observedAt, items })}`,
    createdAt,
    observedAt: input.observedAt,
    items,
    summary,
  };
  return { ...body, planDigest: stableDigest(body) };
}
