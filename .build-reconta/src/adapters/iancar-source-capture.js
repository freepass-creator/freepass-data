import { createHash } from 'node:crypto';
export const IANCAR_SOURCE_CAPTURE_VERSION = 'iancar-source-capture/1';
const text = (x) => typeof x === 'string' && !!x.trim() && x === x.trim();
const instant = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x)
    && Number.isFinite(Date.parse(x));
const json = (x) => x === null || typeof x === 'string' || typeof x === 'boolean'
    || (typeof x === 'number' && Number.isFinite(x)) || (Array.isArray(x) && x.every(json))
    || (!!x && typeof x === 'object' && !Array.isArray(x)
        && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null)
        && Object.values(x).every(json));
const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const IANCAR_ERP_ORIGIN = 'https://xn--le5bt3bwxk.com';
/** Reuses the supplier's authenticated inventory protocol. Never logs bodies, cookies or credentials. */
export function iancarErpReadTransport(input) {
    let account;
    try {
        account = JSON.parse(input.accountJson);
    }
    catch {
        throw new Error('IANCAR_CREDENTIAL_INVALID');
    }
    if (!account || !text(account.email) || !text(account.password))
        throw new Error('IANCAR_CREDENTIAL_INVALID');
    const request = input.fetchImpl ?? fetch;
    return async () => {
        const jar = new Map();
        const call = async (path, body) => {
            let response;
            try {
                response = await request(`${IANCAR_ERP_ORIGIN}${path}`, {
                    method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store',
                    signal: AbortSignal.timeout(20_000),
                    headers: { 'User-Agent': 'FreePassData iancar-source', Cookie: [...jar.values()].join('; '),
                        ...(body ? { 'Content-Type': 'application/json' } : {}) },
                    ...(body ? { body: JSON.stringify(body) } : {})
                });
            }
            catch {
                throw new Error('IANCAR_ERP_TRANSPORT_FAILED');
            }
            if (!response.ok)
                throw new Error(`IANCAR_ERP_HTTP_${response.status}`);
            for (const cookie of response.headers.getSetCookie()) {
                const pair = cookie.split(';')[0];
                jar.set(pair.split('=')[0], pair);
            }
            return response;
        };
        await call('/login');
        const login = await call('/api/auth/login', { login: account.email, password: account.password });
        let accepted;
        try {
            accepted = await login.json();
        }
        catch {
            throw new Error('IANCAR_AUTH_RESPONSE_INVALID');
        }
        if (!accepted || typeof accepted !== 'object' || accepted.ok !== true
            || !jar.has('eancar_session'))
            throw new Error('IANCAR_AUTH_NOT_CONFIRMED');
        let raw;
        try {
            raw = await (await call('/api/inventory')).json();
        }
        catch (error) {
            if (error instanceof Error && error.message.startsWith('IANCAR_ERP_'))
                throw error;
            throw new Error('IANCAR_INVENTORY_JSON_INVALID');
        }
        return parseIancarErpInventory(raw);
    };
}
/** Inventory API is available + reserved stock, NOT all fleet vehicles and NOT the rate source. */
export function parseIancarErpInventory(raw, now = new Date()) {
    if (!json(raw) || !raw || Array.isArray(raw) || typeof raw !== 'object')
        throw new Error('IANCAR_INVENTORY_SHAPE_INVALID');
    const data = raw;
    const count = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (!Array.isArray(data.models) || !Array.isArray(data.reservedVehicles) || !count(data.total)
        || !count(data.reservedTotal) || !count(data.fleetTotal) || !instant(data.syncedAt)
        || typeof data.stale !== 'boolean')
        throw new Error('IANCAR_INVENTORY_SHAPE_INVALID');
    const vehicles = [];
    const ids = new Set();
    const append = (unit, modelName, inventoryGroup) => {
        if (!unit || typeof unit !== 'object' || Array.isArray(unit))
            throw new Error('IANCAR_VEHICLE_SHAPE_INVALID');
        const row = unit;
        if (!text(row.vehicleNo) || !text(row.plate) || ids.has(row.vehicleNo))
            throw new Error('IANCAR_VEHICLE_ID_INVALID');
        ids.add(row.vehicleNo);
        vehicles.push({ ...row, modelName: modelName ?? null, inventoryGroup });
    };
    for (const model of data.models) {
        if (!model || typeof model !== 'object' || Array.isArray(model))
            throw new Error('IANCAR_MODEL_SHAPE_INVALID');
        const row = model;
        if (!Array.isArray(row.units) || !count(row.count) || row.count !== row.units.length)
            throw new Error('IANCAR_MODEL_COUNT_MISMATCH');
        for (const unit of row.units)
            append(unit, row.name, 'MODEL_INVENTORY');
    }
    if (vehicles.length !== data.total || data.reservedVehicles.length !== data.reservedTotal
        || data.fleetTotal < data.total + data.reservedTotal)
        throw new Error('IANCAR_INVENTORY_COUNT_MISMATCH');
    for (const unit of data.reservedVehicles)
        append(unit, null, 'RESERVED');
    const age = now.getTime() - Date.parse(data.syncedAt);
    return { sourceRevision: digest(raw), observedAt: data.syncedAt, capturedAt: now.toISOString(),
        collectionComplete: data.stale === false && age >= 0 && age <= 3_600_000,
        parserVersion: 'iancar-erp-inventory/1', vehicles, rateQuotes: [], rateCoverageComplete: false, raw };
}
/** Every observed vehicle enters RAW, including ERP-only new stock. No existing-product filter. */
export function buildIancarErpRawIntakeBatch(capture) {
    if (!instant(capture.capturedAt))
        throw new Error('IANCAR_ERP_CAPTURE_TIME_INVALID');
    const checked = parseIancarErpInventory(capture.raw, new Date(capture.capturedAt));
    if (capture.sourceRevision !== checked.sourceRevision || capture.observedAt !== checked.observedAt
        || capture.collectionComplete !== checked.collectionComplete
        || capture.parserVersion !== checked.parserVersion || digest(capture.vehicles) !== digest(checked.vehicles)
        || capture.rateCoverageComplete !== false || capture.rateQuotes.length !== 0)
        throw new Error('IANCAR_ERP_DERIVATION_MISMATCH');
    return { laneId: 'PRODUCT_VEHICLE',
        source: { sourceId: 'supplier/RP031/erp-inventory', kind: 'API', displayName: 'Iancar ERP inventory',
            authorityScope: ['RP031:observed-vehicle-inventory'], expectedFreshnessSeconds: 3600 },
        observedAt: checked.observedAt, sourceRevision: checked.sourceRevision, checksum: digest(checked.raw),
        coverage: { mode: 'PARTIAL', completeness: checked.collectionComplete ? 'COMPLETE' : 'INCOMPLETE',
            scope: 'available+reserved inventory only; not full fleet; no rental rates',
            note: 'Never infer fleet absence or replace rental rates from this response.' },
        records: [{ sourceRecordId: '__inventory_snapshot', sourceFingerprint: digest(checked.raw),
                payload: { raw: checked.raw, capturedAt: checked.capturedAt } },
            ...checked.vehicles.map(vehicle => ({ sourceRecordId: `vehicle:${vehicle.vehicleNo}`,
                sourceFingerprint: digest(vehicle), payload: { vehicle, parserVersion: checked.parserVersion,
                    pricingState: 'UNKNOWN', supplierCode: 'RP031' } }))] };
}
