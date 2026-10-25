const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const NEW_VEHICLE_UID = /^va_[0-9A-HJKMNP-TV-Z]{26}$/;
const EXISTING_VEHICLE_ASSET_ID = /^va_[0-9a-f]{24}$/;
let lastTime = -1;
let lastRandom = [];
function clockMillis(clock) {
    const value = clock();
    const millis = value instanceof Date ? value.getTime() : value;
    if (!Number.isSafeInteger(millis) || millis < 0 || millis > 0xffffffffffff) {
        throw new Error('INVALID_VEHICLE_UID_TIME');
    }
    return millis;
}
function randomChars(random) {
    return Array.from({ length: 16 }, () => {
        const value = random();
        if (!Number.isFinite(value) || value < 0 || value >= 1)
            throw new Error('INVALID_VEHICLE_UID_RANDOM');
        return Math.floor(value * 32);
    });
}
function incrementRandom(chars) {
    const next = [...chars];
    for (let i = next.length - 1; i >= 0; i--) {
        if (next[i] < 31) {
            next[i] = next[i] + 1;
            return next;
        }
        next[i] = 0;
    }
    throw new Error('VEHICLE_UID_MONOTONIC_OVERFLOW');
}
function encodeTime(millis) {
    let value = millis;
    const chars = Array(10);
    for (let i = 9; i >= 0; i--) {
        chars[i] = CROCKFORD[value % 32];
        value = Math.floor(value / 32);
    }
    return chars.join('');
}
export function newVehicleUid(clock = () => Date.now(), random = Math.random, options = { monotonic: true }) {
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
export function isVehicleUid(value) {
    return NEW_VEHICLE_UID.test(value);
}
export function isExistingVehicleAssetId(value) {
    return EXISTING_VEHICLE_ASSET_ID.test(value);
}
const clean = (value) => {
    const v = value?.trim();
    return v ? v : undefined;
};
const normalizeVin = (value) => clean(value)?.toUpperCase();
const normalizePlate = (value) => clean(value);
const normalizeSupplierCode = (value) => clean(value)?.toUpperCase();
function normalizeId(id) {
    const kind = id.kind;
    const value = kind === 'VIN' ? normalizeVin(id.value) : clean(id.value);
    if (!value)
        return null;
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
export function normalizeExternalIds(candidate) {
    const plate = normalizePlate(candidate.plate);
    const vin = normalizeVin(candidate.vin);
    const supplierCode = normalizeSupplierCode(candidate.supplierCode);
    const supplierVehicleId = clean(candidate.supplierVehicleId);
    const externalIds = (candidate.externalIds ?? []).map(normalizeId).filter((x) => Boolean(x));
    return {
        ...(plate ? { plate } : {}),
        ...(vin ? { vin } : {}),
        ...(supplierCode ? { supplierCode } : {}),
        ...(supplierVehicleId ? { supplierVehicleId } : {}),
        externalIds,
    };
}
export function isActiveExternalId(id, at = new Date().toISOString()) {
    return id.validFrom <= at && (id.validTo === undefined || id.validTo === null || id.validTo > at);
}
function activeIds(asset, at) {
    const ids = (asset.externalIds ?? []).map(normalizeId).filter((x) => Boolean(x));
    const activeExternalIds = ids.filter(id => isActiveExternalId(id, at));
    const legacy = [];
    const addLegacy = (kind, value) => {
        if (!value)
            return;
        const hasExternalKind = ids.some(id => id.kind === kind);
        const matchesActiveExternalValue = activeExternalIds.some(id => id.kind === kind && id.value === value);
        if (!hasExternalKind || matchesActiveExternalValue) {
            legacy.push({ kind, value, validFrom: asset.createdAt, source: 'legacy-field' });
        }
    };
    addLegacy('VIN', normalizeVin(asset.vin));
    addLegacy('PLATE', normalizePlate(asset.plateNumber));
    return [...activeExternalIds, ...legacy].filter(id => isActiveExternalId(id, at));
}
/** 공급사 범위 식별자: 같은 값이어도 공급사가 다르면 다른 식별자다(공급사 차량 ID·시트 행 키는 (공급사, 값) 쌍). */
const isSupplierScoped = (kind) => kind === 'SUPPLIER_VEHICLE' || kind === 'SHEET_ROW';
function sameId(id, kind, value, supplierCode) {
    if (id.kind !== kind || id.value !== value)
        return false;
    if (!isSupplierScoped(kind))
        return true;
    return id.supplierCode === supplierCode;
}
export function findActiveAssets(assets, kind, value, at = new Date().toISOString(), supplierCode) {
    if (!value)
        return [];
    return assets.filter(asset => activeIds(asset, at).some(id => sameId(id, kind, value, supplierCode)));
}
function activeValue(asset, kind, at, supplierCode) {
    return activeIds(asset, at).find(id => id.kind === kind && (!isSupplierScoped(kind) || id.supplierCode === supplierCode))?.value;
}
function candidateIdentifierKey(id) {
    return `${id.kind}:${isSupplierScoped(id.kind) ? id.supplierCode ?? '' : ''}:${id.value}`;
}
function candidateIdentifiers(ids, now) {
    const out = [];
    const push = (id) => {
        const normalized = normalizeId(id);
        if (!normalized)
            return;
        if (normalized.validFrom > now || (normalized.validTo !== null && normalized.validTo !== undefined && normalized.validTo <= now))
            return;
        if (isSupplierScoped(normalized.kind) && !normalized.supplierCode)
            return;
        if (!out.some(existing => candidateIdentifierKey(existing) === candidateIdentifierKey(normalized)))
            out.push(normalized);
    };
    if (ids.vin)
        push({ kind: 'VIN', value: ids.vin, validFrom: now, source: 'vehicle-uid-resolver' });
    if (ids.supplierVehicleId && ids.supplierCode) {
        push({ kind: 'SUPPLIER_VEHICLE', supplierCode: ids.supplierCode, value: ids.supplierVehicleId, validFrom: now, source: 'vehicle-uid-resolver' });
    }
    if (ids.plate)
        push({ kind: 'PLATE', value: ids.plate, validFrom: now, source: 'vehicle-uid-resolver' });
    for (const id of ids.externalIds)
        push(id);
    return out;
}
function hasInternalContradiction(identifiers) {
    const seen = new Map();
    for (const id of identifiers) {
        // 차 한 대에 하나뿐인 값(VIN·번호)만 후보 내부 모순으로 본다. 공급사 차량 ID·시트 행이 여럿 오는 경우는 자산 매칭 단계가 판정한다.
        if (id.kind !== 'VIN' && id.kind !== 'PLATE')
            continue;
        const ns = id.kind;
        const prev = seen.get(ns);
        if (prev !== undefined && prev !== id.value)
            return true;
        seen.set(ns, id.value);
    }
    return false;
}
function conflictReason(kind) {
    return `${kind}_CONFLICT`;
}
function contradicts(asset, identifiers, assets, at) {
    const active = activeIds(asset, at);
    for (const id of identifiers) {
        if (active.some(existing => sameId(existing, id.kind, id.value, id.supplierCode)))
            continue;
        const sameNamespace = active.filter(existing => existing.kind === id.kind &&
            (!isSupplierScoped(id.kind) || existing.supplierCode === id.supplierCode));
        if (sameNamespace.length > 0) {
            if (id.kind === 'PLATE') {
                const plateOwners = findActiveAssets(assets, 'PLATE', id.value, at).filter(x => x.id !== asset.id);
                if (plateOwners.length === 0)
                    continue;
            }
            return true;
        }
    }
    return false;
}
function createExternalIds(identifiers, now) {
    return identifiers.map(id => ({ ...id, validFrom: now, validTo: id.validTo ?? null, source: 'vehicle-uid-resolver' }));
}
export function resolveVehicleUid(candidate, assets, options = {}) {
    const now = options.now ?? new Date().toISOString();
    const ids = normalizeExternalIds(candidate);
    const identifiers = candidateIdentifiers(ids, now);
    // 한 후보 안에서 같은 종류(공급사 범위는 공급사별)의 식별자가 서로 다른 값이면 한 차를 두 값으로 말하는 모순 → 새 UID 도, 연결도 하지 않는다.
    if (hasInternalContradiction(identifiers))
        return { action: 'HOLD', reason: 'CANDIDATE_INTERNAL_CONTRADICTION' };
    const matches = identifiers.map(id => ({
        id,
        assets: findActiveAssets(assets, id.kind, id.value, now, id.supplierCode),
    }));
    const conflict = matches.find(match => match.assets.length > 1);
    if (conflict)
        return { action: 'HOLD', reason: conflictReason(conflict.id.kind) };
    const linked = [...new Map(matches.flatMap(match => match.assets).map(asset => [asset.id, asset])).values()];
    if (linked.length > 1)
        return { action: 'HOLD', reason: 'IDENTIFIER_POINTS_TO_DIFFERENT_ASSETS' };
    if (linked.length === 1) {
        const asset = linked[0];
        if (contradicts(asset, identifiers, assets, now))
            return { action: 'HOLD', reason: 'IDENTIFIER_CONTRADICTION' };
        const reason = matches.find(match => match.assets[0]?.id === asset.id)?.id.kind ?? 'PLATE';
        return { action: 'LINK', vehicleUid: asset.id, asset, reason };
    }
    if (identifiers.length > 0) {
        return {
            action: 'CREATE',
            vehicleUid: newVehicleUid(options.clock, options.random, options.uidOptions),
            externalIds: createExternalIds(identifiers, now),
        };
    }
    return { action: 'UNKNOWN', reason: 'INSUFFICIENT_IDENTITY' };
}
export function addExternalId(asset, id, now) {
    const normalized = normalizeId(id);
    if (!normalized)
        return structuredClone(asset);
    const externalIds = structuredClone(asset.externalIds ?? []);
    const activeIndex = externalIds.findIndex(existing => existing.kind === normalized.kind &&
        (!isSupplierScoped(normalized.kind) || normalizeSupplierCode(existing.supplierCode) === normalized.supplierCode) &&
        isActiveExternalId(existing, now));
    if (activeIndex >= 0) {
        const active = normalizeId(externalIds[activeIndex]);
        if (active.value === normalized.value)
            return { ...structuredClone(asset), externalIds };
        // 기존 값의 종료는 «새 값의 시작일»부터다 — 새 값이 미래 날짜면 그날까지 옛 값도 유효해서, 전환일 전에 옛 값으로 찾아도 같은 UID 에 연결된다.
        const closeAt = normalized.validFrom && normalized.validFrom > now ? normalized.validFrom : now;
        externalIds[activeIndex] = { ...externalIds[activeIndex], validTo: closeAt };
    }
    externalIds.push({ ...normalized, validFrom: normalized.validFrom || now, validTo: normalized.validTo ?? null });
    return { ...structuredClone(asset), externalIds };
}
