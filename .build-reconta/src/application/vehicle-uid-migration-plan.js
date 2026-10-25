import { addExternalId, newVehicleUid, resolveVehicleUid, } from '../domain/vehicle-uid.js';
import { stableDigest } from '../shared/stable-digest.js';
export { summarizeVehicleUidMigrationAssetIdentifiers, summarizeVehicleUidMigrationIdentifiers } from '../shared/vehicle-uid-migration-identifiers.js';
import { normalizedVehicleUidMigrationAssetIdentifiers, summarizeVehicleUidMigrationAssetIdentifiers, summarizeVehicleUidMigrationIdentifiers, vehicleUidMigrationProductIds, } from '../shared/vehicle-uid-migration-identifiers.js';
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const hash = (value) => stableDigest(value).slice(0, 12);
const uidHash = (value) => `va_${stableDigest(value).slice(0, 26).toUpperCase()}`;
const hasOwn = (object, key) => Object.hasOwn(object, key);
const active = (id, at) => id.validFrom <= at && (id.validTo === undefined || id.validTo === null || id.validTo > at);
const supplierScoped = (kind) => kind === 'SUPPLIER_VEHICLE' || kind === 'SHEET_ROW';
const productIds = vehicleUidMigrationProductIds;
function externalIdsForAsset(asset) {
    const out = [];
    if (asset.plateNumber) {
        out.push({ kind: 'PLATE', value: asset.plateNumber, validFrom: asset.createdAt, source: 'vehicle-uid-migration-plan' });
    }
    if (asset.vin) {
        out.push({ kind: 'VIN', value: asset.vin.toUpperCase(), validFrom: asset.createdAt, source: 'vehicle-uid-migration-plan' });
    }
    return out;
}
function needsExternalIds(asset, observedAt) {
    return externalIdsForAsset(asset).filter((id) => {
        const projected = addExternalId(asset, id, observedAt);
        return stableDigest(projected.externalIds ?? []) !== stableDigest(asset.externalIds ?? []);
    });
}
function sortExternalIds(ids) {
    return [...ids].sort((a, b) => `${a.kind}:${a.supplierCode ?? ''}:${a.value}:${a.validFrom}:${a.validTo ?? ''}`
        .localeCompare(`${b.kind}:${b.supplierCode ?? ''}:${b.value}:${b.validFrom}:${b.validTo ?? ''}`));
}
function candidateExternalIds(ids, observedAt) {
    const out = [];
    for (const vin of ids.vins) {
        out.push({ kind: 'VIN', value: vin.toUpperCase(), validFrom: observedAt, source: 'vehicle-uid-migration-plan' });
    }
    if (ids.supplierCode)
        for (const supplierVehicleId of ids.supplierVehicleIds) {
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
function identifierKey(id) {
    return `${id.kind}:${supplierScoped(id.kind) ? id.supplierCode ?? '' : ''}:${id.value}`;
}
function identifierNamespace(id) {
    return `${id.kind}:${supplierScoped(id.kind) ? id.supplierCode ?? '' : ''}`;
}
function productCandidate(product, observedAt) {
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
    parent = new Map();
    add(x) {
        if (!this.parent.has(x))
            this.parent.set(x, x);
    }
    find(x) {
        this.add(x);
        const p = this.parent.get(x);
        if (p === x)
            return x;
        const root = this.find(p);
        this.parent.set(x, root);
        return root;
    }
    union(a, b) {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra !== rb)
            this.parent.set(rb, ra);
    }
    groups() {
        const out = new Map();
        for (const key of this.parent.keys()) {
            const root = this.find(key);
            const list = out.get(root) ?? [];
            list.push(key);
            out.set(root, list);
        }
        return [...out.values()];
    }
}
function componentIdFor(key) {
    return `component_${hash(key)}`;
}
function upsertAssetExternalIdsItem(items, componentId, asset, externalIds, observedAt) {
    if (externalIds.length === 0)
        return;
    const assetId = asset.id;
    const existing = items.find((item) => item.kind === 'ASSET_ADD_EXTERNAL_IDS' && item.componentId === componentId && item.assetId === assetId);
    if (existing) {
        const keyed = new Map();
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
        assetIdentifierDigest: summarizeVehicleUidMigrationAssetIdentifiers(asset, observedAt),
        public: { componentHash: hash(componentId), assetHash: hash(assetId), externalIdKinds: [...new Set(externalIds.map(id => id.kind))].sort() },
    });
}
function activePlateCountByUid(assets, planned, observedAt) {
    const byUid = new Map();
    for (const asset of assets) {
        const ids = [...(asset.externalIds ?? []), ...externalIdsForAsset(asset)].filter(id => id.kind === 'PLATE' && active(id, observedAt));
        for (const id of ids) {
            const set = byUid.get(asset.id) ?? new Set();
            set.add(id.value);
            byUid.set(asset.id, set);
        }
    }
    for (const item of planned) {
        if (item.kind !== 'ASSET_ADD_EXTERNAL_IDS')
            continue;
        for (const id of item.externalIds.filter(id => id.kind === 'PLATE' && active(id, observedAt))) {
            const set = byUid.get(item.assetId) ?? new Set();
            set.add(id.value);
            byUid.set(item.assetId, set);
        }
    }
    return [...byUid.values()].every(plates => plates.size <= 1);
}
function bindingsForProduct(bindings, productKey) {
    return bindings.filter(binding => binding.sourceRecordId === productKey || binding.productId === productKey);
}
const normalizedActiveIds = normalizedVehicleUidMigrationAssetIdentifiers;
function assetContradictsProduct(asset, ids, observedAt) {
    const activeIds = normalizedActiveIds(asset, observedAt);
    const hasDifferent = (kind, value, supplierCode) => {
        if (!value)
            return false;
        const normalizedValue = kind === 'VIN' ? value.toUpperCase() : value;
        const normalizedSupplier = supplierCode?.toUpperCase();
        const sameNamespace = activeIds.filter(id => id.kind === kind && (kind !== 'SUPPLIER_VEHICLE' || id.supplierCode === normalizedSupplier));
        return sameNamespace.length > 0 && sameNamespace.every(id => id.value !== normalizedValue);
    };
    return hasDifferent('VIN', ids.vin) ||
        hasDifferent('PLATE', ids.plate) ||
        hasDifferent('SUPPLIER_VEHICLE', ids.supplierVehicleId, ids.supplierCode);
}
function plannedAssetFromCreate(vehicleUid, ids, externalIds, createdAt) {
    const actor = { id: 'vehicle-uid-migration-plan', kind: 'SERVICE' };
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
function isPrefixProductKey(key) {
    return /^RP\d{3}_.+/.test(key);
}
function isIancarProductKey(key) {
    return /^iancar[_-]/i.test(key);
}
export function planVehicleUidMigration(input) {
    const createdAtRaw = input.clock();
    const createdAt = createdAtRaw instanceof Date ? createdAtRaw.toISOString() : new Date(createdAtRaw).toISOString();
    if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(input.observedAt))) {
        throw new Error('VEHICLE_UID_PLAN_TIME_INVALID');
    }
    const items = [];
    const plateProducts = new Map();
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
            ...input.processingOrder.filter(key => hasOwn(input.products, key)).map(key => [key, input.products[key]]),
            ...Object.entries(input.products).filter(([key]) => !input.processingOrder.includes(key)),
        ]
        : Object.entries(input.products);
    const productInfo = new Map(productEntries.map(([key, product]) => [key, productCandidate(product, input.observedAt)]));
    const assetById = new Map(input.assets.map(asset => [asset.id, asset]));
    const uf = new UnionFind();
    for (const [key, product] of productEntries) {
        const productNode = `product:${key}`;
        uf.add(productNode);
        const info = productInfo.get(key);
        for (const id of info.externalIds)
            uf.union(productNode, `id:${identifierKey(id)}`);
        const existingVehicleUid = text(product.vehicle_uid);
        if (existingVehicleUid)
            uf.union(productNode, `asset:${existingVehicleUid}`);
        for (const binding of bindingsForProduct(input.bindings, key)) {
            if (binding.vehicleAssetId)
                uf.union(productNode, `asset:${binding.vehicleAssetId}`);
        }
    }
    for (const asset of input.assets) {
        const assetNode = `asset:${asset.id}`;
        uf.add(assetNode);
        for (const id of normalizedActiveIds(asset, input.observedAt))
            uf.union(assetNode, `id:${identifierKey(id)}`);
    }
    const componentPlans = [];
    for (const nodes of uf.groups()) {
        const products = nodes.filter(x => x.startsWith('product:')).map(x => x.slice('product:'.length)).sort();
        if (!products.length)
            continue;
        const assetIds = [...new Set(nodes.filter(x => x.startsWith('asset:')).map(x => x.slice('asset:'.length)))].sort();
        const ids = products.flatMap(key => productInfo.get(key)?.externalIds ?? []);
        for (const assetId of assetIds) {
            const asset = assetById.get(assetId);
            if (asset)
                ids.push(...normalizedActiveIds(asset, input.observedAt));
        }
        const key = [...new Set(ids.map(identifierKey))].sort()[0] ?? `product:${products[0]}`;
        const reasons = [];
        if (assetIds.length > 1)
            reasons.push('IDENTIFIER_POINTS_TO_DIFFERENT_ASSETS');
        const valuesByNamespace = new Map();
        for (const id of ids) {
            const set = valuesByNamespace.get(identifierNamespace(id)) ?? new Set();
            set.add(id.value);
            valuesByNamespace.set(identifierNamespace(id), set);
        }
        for (const [namespace, values] of valuesByNamespace) {
            if (values.size > 1)
                reasons.push(`${namespace.split(':')[0]}_CONFLICT`);
        }
        for (const productKey of products) {
            const product = input.products[productKey];
            const info = productInfo.get(productKey);
            if (info.ids.sameKindFieldDisagreements.length) {
                reasons.push('SAME_KIND_FIELDS_DISAGREE', ...info.ids.sameKindFieldDisagreements);
            }
            if (isPrefixProductKey(productKey))
                reasons.push('PREFIX_PRODUCT_KEY_REQUIRES_REVIEW');
            if (isIancarProductKey(productKey))
                reasons.push('IANCAR_PRODUCT_KEY_REQUIRES_REVIEW');
            const samePlate = info.ids.plates.flatMap(plate => plateProducts.get(plate) ?? []);
            const suppliers = new Set(samePlate.map(x => x.supplier).filter(Boolean));
            if (samePlate.length > 1 && suppliers.size > 1)
                reasons.push('PLATE_DUPLICATED_ACROSS_SUPPLIERS');
            const matchedBindings = bindingsForProduct(input.bindings, productKey);
            if (matchedBindings.length > 1)
                reasons.push('MULTIPLE_BINDINGS');
            const bound = matchedBindings.length === 1 ? matchedBindings[0] : undefined;
            const boundAsset = bound?.vehicleAssetId ? assetById.get(bound.vehicleAssetId) : undefined;
            if (bound?.vehicleAssetId && !boundAsset)
                reasons.push('BINDING_TARGET_MISSING');
            const existingVehicleUid = text(product.vehicle_uid);
            if (existingVehicleUid && !assetById.has(existingVehicleUid))
                reasons.push('UID_ASSET_MISSING');
            if (boundAsset && assetContradictsProduct(boundAsset, info.ids, input.observedAt))
                reasons.push('BINDING_CONTRADICTS_PRODUCT');
            const resolution = resolveVehicleUid(info.candidate, input.assets, {
                now: input.observedAt,
                clock: input.clock,
                random: input.random,
                uidOptions: { monotonic: false },
            });
            if (boundAsset && (resolution.action !== 'LINK' || resolution.asset.id !== boundAsset.id))
                reasons.push('BINDING_DISAGREES_WITH_RESOLVER');
            if (resolution.action === 'HOLD' || resolution.action === 'UNKNOWN')
                reasons.push(resolution.reason);
        }
        componentPlans.push({ key, products, assetIds, ids: sortExternalIds(ids), reasons: [...new Set(reasons)].sort() });
    }
    const existingUidSet = new Set(input.assets.map(asset => asset.id));
    const plannedUidSet = new Set(existingUidSet);
    const cleanWithoutAsset = componentPlans.filter(component => component.reasons.length === 0 && component.assetIds.length === 0)
        .sort((a, b) => a.key.localeCompare(b.key));
    const newUidByComponentKey = new Map();
    for (const component of cleanWithoutAsset) {
        let uid = newVehicleUid(input.clock, input.random, { monotonic: false });
        if (plannedUidSet.has(uid))
            uid = uidHash({ createdAt, componentKey: component.key, ids: component.ids.map(identifierKey) });
        plannedUidSet.add(uid);
        newUidByComponentKey.set(component.key, uid);
    }
    for (const component of componentPlans.sort((a, b) => a.key.localeCompare(b.key))) {
        const componentId = componentIdFor(component.key);
        if (component.reasons.length) {
            const holdsExistingProducts = component.reasons.includes('UID_ASSET_MISSING');
            for (const productKey of component.products) {
                const product = input.products[productKey];
                if (text(product.vehicle_uid) && !holdsExistingProducts)
                    continue;
                for (const reason of ['GRAPH_COMPONENT_CONFLICT', ...component.reasons]) {
                    items.push({ kind: 'HOLD', componentId, productKey, reason, public: { componentHash: hash(componentId), productHash: hash(productKey), reason } });
                }
            }
            continue;
        }
        const uid = component.assetIds[0] ?? newUidByComponentKey.get(component.key);
        const existingAsset = component.assetIds[0] ? assetById.get(uid) : undefined;
        const reason = component.assetIds[0] ? (component.products.some(productKey => bindingsForProduct(input.bindings, productKey).some(b => b.vehicleAssetId === uid)) ? 'SOURCE_BINDING' : 'PLATE_UNIQUE_ASSET') : 'PLANNED_NEW_UID';
        if (component.assetIds[0]) {
            const asset = existingAsset;
            if (asset) {
                const added = component.ids.filter(id => stableDigest(addExternalId(asset, id, input.observedAt).externalIds ?? []) !== stableDigest(asset.externalIds ?? []));
                upsertAssetExternalIdsItem(items, componentId, asset, added, input.observedAt);
            }
        }
        for (const productKey of component.products) {
            const product = input.products[productKey];
            if (text(product.vehicle_uid)) {
                if (text(product.vehicle_uid) === uid) {
                    items.push({
                        kind: 'PRODUCT_VERIFY_UID',
                        componentId,
                        productKey,
                        vehicleUid: uid,
                        identifiers: summarizeVehicleUidMigrationIdentifiers(product),
                        ...(existingAsset ? { assetIdentifierDigest: summarizeVehicleUidMigrationAssetIdentifiers(existingAsset, input.observedAt) } : {}),
                        public: { componentHash: hash(componentId), productHash: hash(productKey), vehicleUidHash: hash(uid), reason: 'VERIFY_EXISTING_UID' },
                    });
                }
                continue;
            }
            items.push({
                kind: 'PRODUCT_SET_UID',
                componentId,
                productKey,
                vehicleUid: uid,
                reason,
                assetState: existingAsset ? 'LINKED_EXISTING' : 'PRODUCT_ONLY',
                identifiers: summarizeVehicleUidMigrationIdentifiers(product),
                ...(existingAsset ? { assetIdentifierDigest: summarizeVehicleUidMigrationAssetIdentifiers(existingAsset, input.observedAt) } : {}),
                public: { componentHash: hash(componentId), productHash: hash(productKey), vehicleUidHash: hash(uid), reason },
            });
        }
    }
    const componentAssetIds = new Set(componentPlans.flatMap(component => component.assetIds));
    for (const asset of [...input.assets].sort((a, b) => a.id.localeCompare(b.id))) {
        if (componentAssetIds.has(asset.id))
            continue;
        const externalIds = needsExternalIds(asset, input.observedAt);
        if (externalIds.length) {
            const componentId = componentIdFor(`asset:${asset.id}`);
            items.push({
                kind: 'ASSET_ADD_EXTERNAL_IDS',
                componentId,
                assetId: asset.id,
                externalIds: sortExternalIds(externalIds),
                assetIdentifierDigest: summarizeVehicleUidMigrationAssetIdentifiers(asset, input.observedAt),
                public: { componentHash: hash(componentId), assetHash: hash(asset.id), externalIdKinds: [...new Set(externalIds.map(id => id.kind))].sort() },
            });
        }
    }
    const holdAssetIds = new Set(componentPlans.filter(component => component.reasons.length > 0).flatMap(component => component.assetIds));
    if (holdAssetIds.size) {
        for (let index = items.length - 1; index >= 0; index--) {
            const item = items[index];
            if (item.kind === 'ASSET_ADD_EXTERNAL_IDS' && holdAssetIds.has(item.assetId))
                items.splice(index, 1);
        }
    }
    const byKind = { ASSET_ADD_EXTERNAL_IDS: 0, PRODUCT_SET_UID: 0, PRODUCT_VERIFY_UID: 0, HOLD: 0 };
    const byReason = {};
    for (const item of items) {
        byKind[item.kind]++;
        const reason = item.kind === 'HOLD' ? item.reason : item.kind === 'PRODUCT_SET_UID' ? item.reason : item.kind === 'PRODUCT_VERIFY_UID' ? 'VERIFY_EXISTING_UID' : 'ASSET_EXTERNAL_IDS';
        byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
    const summary = {
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
        schema: 'vehicle-uid-migration-plan/v1',
        planId: `vehicle_uid_plan_${hash({ createdAt, observedAt: input.observedAt, items })}`,
        createdAt,
        observedAt: input.observedAt,
        items,
        summary,
    };
    return { ...body, planDigest: stableDigest(body) };
}
