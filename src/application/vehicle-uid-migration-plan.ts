import type { VehicleAsset, VehicleExternalId } from '../domain/catalog.js';
import type { CanonicalSourceBinding } from '../domain/canonicalization.js';
import {
  addExternalId,
  newVehicleUid,
  resolveVehicleUid,
  type VehicleUidClock,
  type VehicleUidRandom,
} from '../domain/vehicle-uid.js';
import { stableDigest } from '../shared/stable-digest.js';

export type VehicleUidMigrationProduct = Record<string, unknown>;

export type VehicleUidMigrationItem =
  | {
      kind: 'ASSET_ADD_EXTERNAL_IDS';
      componentId: string;
      assetId: string;
      externalIds: VehicleExternalId[];
      public: { componentHash: string; assetHash: string; externalIdKinds: string[] };
    }
  | {
      kind: 'PRODUCT_SET_UID';
      componentId: string;
      productKey: string;
      vehicleUid: string;
      reason: 'SOURCE_BINDING' | 'PLATE_UNIQUE_ASSET' | 'PLANNED_NEW_UID' | 'CREATED_IN_PLAN';
      identifiers: VehicleUidMigrationIdentifierSummary;
      assetIdentifierDigest?: string;
      public: { componentHash: string; productHash: string; vehicleUidHash: string; reason: string };
    }
  | {
      kind: 'HOLD';
      componentId: string;
      productKey: string;
      reason: string;
      public: { componentHash: string; productHash: string; reason: string };
    };

export type VehicleUidMigrationSummary = {
  totalProducts: number;
  totalAssets: number;
  totalItems: number;
  graphComponents: number;
  holdGraphComponents: number;
  holdProducts: number;
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

export type VehicleUidMigrationIdentifierSummary = {
  plateHashes: string[];
  vinHashes: string[];
  supplierVehicleIdHashes: string[];
};

export type PlanVehicleUidMigrationInput = {
  products: Record<string, VehicleUidMigrationProduct>;
  assets: VehicleAsset[];
  bindings: CanonicalSourceBinding[];
  clock: VehicleUidClock;
  random: VehicleUidRandom;
  observedAt: string;
  processingOrder?: string[];
};

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const hash = (value: unknown) => stableDigest(value).slice(0, 12);
const uidHash = (value: unknown) => `va_${stableDigest(value).slice(0, 26).toUpperCase()}`;
const hasOwn = (object: Record<string, unknown>, key: string) => Object.hasOwn(object, key);
const active = (id: VehicleExternalId, at: string) => id.validFrom <= at && (id.validTo === undefined || id.validTo === null || id.validTo > at);
const supplierScoped = (kind: VehicleExternalId['kind']) => kind === 'SUPPLIER_VEHICLE' || kind === 'SHEET_ROW';

function field(product: VehicleUidMigrationProduct, names: string[]) {
  for (const name of names) {
    const value = text(product[name]);
    if (value) return value;
  }
  return undefined;
}

function fields(product: VehicleUidMigrationProduct, names: string[]) {
  return names.map(name => text(product[name])).filter(Boolean);
}

function uniqueValues(values: string[], normalize: (value: string) => string = value => value) {
  return [...new Set(values.map(normalize))];
}

function productIds(product: VehicleUidMigrationProduct) {
  const plateFields = ['plateNumber', 'plate_number', 'car_number', 'vehicle_number', '차량번호'];
  const vinFields = ['vin', 'VIN', 'vehicle_vin', 'vehicle_id_number', '차대번호'];
  const supplierVehicleFields = [
    'iancar_one_vehicle_id',
    'sourceVehicleId',
    'supplier_vehicle_id',
    'supplierVehicleId',
    'vehicleId',
    'vehicle_id',
    'source_vehicle_id',
    'sourceRecordId',
    'source_record_id',
    'raw_id',
    'rawId',
    'id',
  ];
  const plateValues = fields(product, plateFields);
  const vinValues = fields(product, vinFields);
  const supplierVehicleValues = fields(product, supplierVehicleFields);
  const plates = uniqueValues(plateValues);
  const vins = uniqueValues(vinValues, value => value.toUpperCase());
  const supplierVehicleIds = uniqueValues(supplierVehicleValues);
  const plate = field(product, plateFields);
  const vin = field(product, vinFields);
  const supplierCode = field(product, ['provider_company_code', 'supplierCode', 'supplier_code', 'supplierId', 'supplier_id', 'sourceSupplierId']);
  const supplierVehicleId = supplierVehicleIds[0];
  const sameKindFieldDisagreements = [
    ...(plates.length > 1 ? ['PLATE:SAME_KIND_FIELDS_DISAGREE'] : []),
    ...(vins.length > 1 ? ['VIN:SAME_KIND_FIELDS_DISAGREE'] : []),
    ...(supplierVehicleIds.length > 1 ? ['SUPPLIER_VEHICLE:SAME_KIND_FIELDS_DISAGREE'] : []),
  ];
  return { plate, plates, vin, vins, supplierCode, supplierVehicleId, supplierVehicleIds, sameKindFieldDisagreements };
}

export function summarizeVehicleUidMigrationIdentifiers(product: VehicleUidMigrationProduct): VehicleUidMigrationIdentifierSummary {
  const ids = productIds(product);
  return {
    plateHashes: ids.plates.map(value => hash({ kind: 'PLATE', value })).sort(),
    vinHashes: ids.vins.map(value => hash({ kind: 'VIN', value })).sort(),
    supplierVehicleIdHashes: ids.supplierVehicleIds
      .map(value => hash({ kind: 'SUPPLIER_VEHICLE', supplierCode: ids.supplierCode?.toUpperCase() ?? '', value }))
      .sort(),
  };
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

function sortExternalIds(ids: VehicleExternalId[]) {
  return [...ids].sort((a, b) =>
    `${a.kind}:${a.supplierCode ?? ''}:${a.value}:${a.validFrom}:${a.validTo ?? ''}`
      .localeCompare(`${b.kind}:${b.supplierCode ?? ''}:${b.value}:${b.validFrom}:${b.validTo ?? ''}`)
  );
}

function candidateExternalIds(ids: ReturnType<typeof productIds>, observedAt: string): VehicleExternalId[] {
  const out: VehicleExternalId[] = [];
  for (const vin of ids.vins) {
    out.push({ kind: 'VIN', value: vin.toUpperCase(), validFrom: observedAt, source: 'vehicle-uid-migration-plan' });
  }
  if (ids.supplierCode) for (const supplierVehicleId of ids.supplierVehicleIds) {
    out.push({
      kind: 'SUPPLIER_VEHICLE',
      supplierCode: ids.supplierCode.toUpperCase(),
      value: supplierVehicleId,
      validFrom: observedAt,
      source: 'vehicle-uid-migration-plan',
    });
  }
  for (const plate of ids.plates) {
    out.push({ kind: 'PLATE', value: plate, validFrom: observedAt, source: 'vehicle-uid-migration-plan' });
  }
  return sortExternalIds(out);
}

function identifierKey(id: VehicleExternalId) {
  return `${id.kind}:${supplierScoped(id.kind) ? id.supplierCode ?? '' : ''}:${id.value}`;
}

function identifierNamespace(id: VehicleExternalId) {
  return `${id.kind}:${supplierScoped(id.kind) ? id.supplierCode ?? '' : ''}`;
}

function productCandidate(product: VehicleUidMigrationProduct, observedAt: string) {
  const ids = productIds(product);
  return {
    ids,
    externalIds: candidateExternalIds(ids, observedAt),
    candidate: {
      ...(ids.plate ? { plate: ids.plate } : {}),
      ...(ids.vin ? { vin: ids.vin } : {}),
      ...(ids.supplierCode ? { supplierCode: ids.supplierCode } : {}),
      ...(ids.supplierVehicleId ? { supplierVehicleId: ids.supplierVehicleId } : {}),
    },
  };
}

class UnionFind {
  private parent = new Map<string, string>();
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    this.add(x);
    const p = this.parent.get(x)!;
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
  groups() {
    const out = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const list = out.get(root) ?? [];
      list.push(key);
      out.set(root, list);
    }
    return [...out.values()];
  }
}

function componentIdFor(key: string) {
  return `component_${hash(key)}`;
}

function upsertAssetExternalIdsItem(items: VehicleUidMigrationItem[], componentId: string, assetId: string, externalIds: VehicleExternalId[]) {
  if (externalIds.length === 0) return;
  const existing = items.find((item): item is Extract<VehicleUidMigrationItem, { kind: 'ASSET_ADD_EXTERNAL_IDS' }> =>
    item.kind === 'ASSET_ADD_EXTERNAL_IDS' && item.componentId === componentId && item.assetId === assetId
  );
  if (existing) {
    const keyed = new Map<string, VehicleExternalId>();
    for (const id of [...existing.externalIds, ...externalIds]) {
      keyed.set(`${id.kind}:${id.supplierCode ?? ''}:${id.value}:${id.validFrom}:${id.validTo ?? ''}`, id);
    }
    existing.externalIds = sortExternalIds([...keyed.values()]);
    existing.public.externalIdKinds = [...new Set(existing.externalIds.map(id => id.kind))].sort();
    return;
  }
  items.push({
    kind: 'ASSET_ADD_EXTERNAL_IDS',
    componentId,
    assetId,
    externalIds: sortExternalIds(externalIds),
    public: { componentHash: hash(componentId), assetHash: hash(assetId), externalIdKinds: [...new Set(externalIds.map(id => id.kind))].sort() },
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

function bindingsForProduct(bindings: CanonicalSourceBinding[], productKey: string) {
  return bindings.filter(binding => binding.sourceRecordId === productKey || binding.productId === productKey);
}

function normalizedActiveIds(asset: VehicleAsset, observedAt: string): VehicleExternalId[] {
  return [...(asset.externalIds ?? []), ...externalIdsForAsset(asset)]
    .map(id => ({
      ...id,
      value: id.kind === 'VIN' ? id.value.trim().toUpperCase() : id.value.trim(),
      ...(id.supplierCode ? { supplierCode: id.supplierCode.trim().toUpperCase() } : {}),
    }))
    .filter(id => id.value && active(id, observedAt));
}

export function summarizeVehicleUidMigrationAssetIdentifiers(asset: VehicleAsset, observedAt: string) {
  return stableDigest(normalizedActiveIds(asset, observedAt));
}

function assetContradictsProduct(asset: VehicleAsset, ids: ReturnType<typeof productIds>, observedAt: string) {
  const activeIds = normalizedActiveIds(asset, observedAt);
  const hasDifferent = (kind: VehicleExternalId['kind'], value: string | undefined, supplierCode?: string) => {
    if (!value) return false;
    const normalizedValue = kind === 'VIN' ? value.toUpperCase() : value;
    const normalizedSupplier = supplierCode?.toUpperCase();
    const sameNamespace = activeIds.filter(id => id.kind === kind && (kind !== 'SUPPLIER_VEHICLE' || id.supplierCode === normalizedSupplier));
    return sameNamespace.length > 0 && sameNamespace.every(id => id.value !== normalizedValue);
  };
  return hasDifferent('VIN', ids.vin) ||
    hasDifferent('PLATE', ids.plate) ||
    hasDifferent('SUPPLIER_VEHICLE', ids.supplierVehicleId, ids.supplierCode);
}

function plannedAssetFromCreate(vehicleUid: string, ids: ReturnType<typeof productIds>, externalIds: VehicleExternalId[], createdAt: string): VehicleAsset {
  const actor = { id: 'vehicle-uid-migration-plan', kind: 'SERVICE' as const };
  return {
    schemaVersion: '1',
    revision: 1,
    validationStatus: 'VALID',
    createdAt,
    updatedAt: createdAt,
    createdBy: actor,
    updatedBy: actor,
    lineageId: `planned:${vehicleUid}`,
    id: vehicleUid,
    vehicleModelId: `planned:${vehicleUid}`,
    status: 'AVAILABLE',
    ...(ids.plate ? { plateNumber: ids.plate } : {}),
    ...(ids.vin ? { vin: ids.vin.toUpperCase() } : {}),
    externalIds: sortExternalIds(externalIds.map(id => ({ ...id, source: 'vehicle-uid-migration-plan' }))),
  };
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
    for (const plate of ids.plates) {
      const list = plateProducts.get(plate) ?? [];
      list.push({ key, ...(ids.supplierCode ? { supplier: ids.supplierCode } : {}) });
      plateProducts.set(plate, list);
    }
  }

  const productEntries = input.processingOrder
    ? [
        ...input.processingOrder.filter(key => hasOwn(input.products, key)).map(key => [key, input.products[key]!] as [string, VehicleUidMigrationProduct]),
        ...Object.entries(input.products).filter(([key]) => !input.processingOrder!.includes(key)),
      ]
    : Object.entries(input.products);
  const productInfo = new Map(productEntries.map(([key, product]) => [key, productCandidate(product, input.observedAt)]));
  const assetById = new Map(input.assets.map(asset => [asset.id, asset]));
  const uf = new UnionFind();
  for (const [key, product] of productEntries) {
    const productNode = `product:${key}`;
    uf.add(productNode);
    const info = productInfo.get(key)!;
    for (const id of info.externalIds) uf.union(productNode, `id:${identifierKey(id)}`);
    const existingVehicleUid = text(product.vehicle_uid);
    if (existingVehicleUid) uf.union(productNode, `asset:${existingVehicleUid}`);
    for (const binding of bindingsForProduct(input.bindings, key)) {
      if (binding.vehicleAssetId) uf.union(productNode, `asset:${binding.vehicleAssetId}`);
    }
  }
  for (const asset of input.assets) {
    const assetNode = `asset:${asset.id}`;
    uf.add(assetNode);
    for (const id of normalizedActiveIds(asset, input.observedAt)) uf.union(assetNode, `id:${identifierKey(id)}`);
  }

  const componentPlans: Array<{ key: string; products: string[]; assetIds: string[]; ids: VehicleExternalId[]; reasons: string[] }> = [];
  for (const nodes of uf.groups()) {
    const products = nodes.filter(x => x.startsWith('product:')).map(x => x.slice('product:'.length)).sort();
    if (!products.length) continue;
    const assetIds = [...new Set(nodes.filter(x => x.startsWith('asset:')).map(x => x.slice('asset:'.length)))].sort();
    const ids = products.flatMap(key => productInfo.get(key)?.externalIds ?? []);
    for (const assetId of assetIds) {
      const asset = assetById.get(assetId);
      if (asset) ids.push(...normalizedActiveIds(asset, input.observedAt));
    }
    const key = [...new Set(ids.map(identifierKey))].sort()[0] ?? `product:${products[0]}`;
    const reasons: string[] = [];
    if (assetIds.length > 1) reasons.push('IDENTIFIER_POINTS_TO_DIFFERENT_ASSETS');
    const valuesByNamespace = new Map<string, Set<string>>();
    for (const id of ids) {
      const set = valuesByNamespace.get(identifierNamespace(id)) ?? new Set<string>();
      set.add(id.value);
      valuesByNamespace.set(identifierNamespace(id), set);
    }
    for (const [namespace, values] of valuesByNamespace) {
      if (values.size > 1) reasons.push(`${namespace.split(':')[0]}_CONFLICT`);
    }
    for (const productKey of products) {
      const product = input.products[productKey]!;
      const info = productInfo.get(productKey)!;
      if (info.ids.sameKindFieldDisagreements.length) {
        reasons.push('SAME_KIND_FIELDS_DISAGREE', ...info.ids.sameKindFieldDisagreements);
      }
      if (isPrefixProductKey(productKey)) reasons.push('PREFIX_PRODUCT_KEY_REQUIRES_REVIEW');
      if (isIancarProductKey(productKey)) reasons.push('IANCAR_PRODUCT_KEY_REQUIRES_REVIEW');
      const samePlate = info.ids.plates.flatMap(plate => plateProducts.get(plate) ?? []);
      const suppliers = new Set(samePlate.map(x => x.supplier).filter(Boolean));
      if (samePlate.length > 1 && suppliers.size > 1) reasons.push('PLATE_DUPLICATED_ACROSS_SUPPLIERS');
      const matchedBindings = bindingsForProduct(input.bindings, productKey);
      if (matchedBindings.length > 1) reasons.push('MULTIPLE_BINDINGS');
      const bound = matchedBindings.length === 1 ? matchedBindings[0] : undefined;
      const boundAsset = bound?.vehicleAssetId ? assetById.get(bound.vehicleAssetId) : undefined;
      if (bound?.vehicleAssetId && !boundAsset) reasons.push('BINDING_TARGET_MISSING');
      const existingVehicleUid = text(product.vehicle_uid);
      if (existingVehicleUid && !assetById.has(existingVehicleUid)) reasons.push('UID_ASSET_MISSING');
      if (boundAsset && assetContradictsProduct(boundAsset, info.ids, input.observedAt)) reasons.push('BINDING_CONTRADICTS_PRODUCT');
      const resolution = resolveVehicleUid(info.candidate, input.assets, {
        now: input.observedAt,
        clock: input.clock,
        random: input.random,
        uidOptions: { monotonic: false },
      });
      if (boundAsset && (resolution.action !== 'LINK' || resolution.asset.id !== boundAsset.id)) reasons.push('BINDING_DISAGREES_WITH_RESOLVER');
      if (resolution.action === 'HOLD' || resolution.action === 'UNKNOWN') reasons.push(resolution.reason);
    }
    componentPlans.push({ key, products, assetIds, ids: sortExternalIds(ids), reasons: [...new Set(reasons)].sort() });
  }

  const existingUidSet = new Set(input.assets.map(asset => asset.id));
  const plannedUidSet = new Set(existingUidSet);
  const cleanWithoutAsset = componentPlans.filter(component => component.reasons.length === 0 && component.assetIds.length === 0)
    .sort((a, b) => a.key.localeCompare(b.key));
  const newUidByComponentKey = new Map<string, string>();
  for (const component of cleanWithoutAsset) {
    let uid = newVehicleUid(input.clock, input.random, { monotonic: false });
    if (plannedUidSet.has(uid)) uid = uidHash({ createdAt, componentKey: component.key, ids: component.ids.map(identifierKey) });
    plannedUidSet.add(uid);
    newUidByComponentKey.set(component.key, uid);
  }

  for (const component of componentPlans.sort((a, b) => a.key.localeCompare(b.key))) {
    const componentId = componentIdFor(component.key);
    if (component.reasons.length) {
      const holdsExistingProducts = component.reasons.includes('UID_ASSET_MISSING');
      for (const productKey of component.products) {
        const product = input.products[productKey]!;
        if (text(product.vehicle_uid) && !holdsExistingProducts) continue;
        for (const reason of ['GRAPH_COMPONENT_CONFLICT', ...component.reasons]) {
          items.push({ kind: 'HOLD', componentId, productKey, reason, public: { componentHash: hash(componentId), productHash: hash(productKey), reason } });
        }
      }
      continue;
    }
    const uid = component.assetIds[0] ?? newUidByComponentKey.get(component.key)!;
    const existingAsset = component.assetIds[0] ? assetById.get(uid) : undefined;
    const reason = component.assetIds[0] ? (component.products.some(productKey => bindingsForProduct(input.bindings, productKey).some(b => b.vehicleAssetId === uid)) ? 'SOURCE_BINDING' : 'PLATE_UNIQUE_ASSET') : 'PLANNED_NEW_UID';
    if (component.assetIds[0]) {
      const asset = existingAsset;
      if (asset) {
        const added = component.ids.filter(id =>
          stableDigest(addExternalId(asset, id, input.observedAt).externalIds ?? []) !== stableDigest(asset.externalIds ?? [])
        );
        upsertAssetExternalIdsItem(items, componentId, uid, added);
      }
    }
    for (const productKey of component.products) {
      const product = input.products[productKey]!;
      if (text(product.vehicle_uid)) continue;
      items.push({
        kind: 'PRODUCT_SET_UID',
        componentId,
        productKey,
        vehicleUid: uid,
        reason,
        identifiers: summarizeVehicleUidMigrationIdentifiers(product),
        ...(existingAsset ? { assetIdentifierDigest: summarizeVehicleUidMigrationAssetIdentifiers(existingAsset, input.observedAt) } : {}),
        public: { componentHash: hash(componentId), productHash: hash(productKey), vehicleUidHash: hash(uid), reason },
      });
    }
  }

  const componentAssetIds = new Set(componentPlans.flatMap(component => component.assetIds));
  for (const asset of [...input.assets].sort((a, b) => a.id.localeCompare(b.id))) {
    if (componentAssetIds.has(asset.id)) continue;
    const externalIds = needsExternalIds(asset, input.observedAt);
    if (externalIds.length) {
      const componentId = componentIdFor(`asset:${asset.id}`);
      items.push({
        kind: 'ASSET_ADD_EXTERNAL_IDS',
        componentId,
        assetId: asset.id,
        externalIds: sortExternalIds(externalIds),
        public: { componentHash: hash(componentId), assetHash: hash(asset.id), externalIdKinds: [...new Set(externalIds.map(id => id.kind))].sort() },
      });
    }
  }

  const holdAssetIds = new Set(componentPlans.filter(component => component.reasons.length > 0).flatMap(component => component.assetIds));
  if (holdAssetIds.size) {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      if (item.kind === 'ASSET_ADD_EXTERNAL_IDS' && holdAssetIds.has(item.assetId)) items.splice(index, 1);
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
    graphComponents: componentPlans.length,
    holdGraphComponents: componentPlans.filter(component => component.reasons.length > 0).length,
    holdProducts: new Set(items.filter(item => item.kind === 'HOLD').map(item => item.productKey)).size,
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
