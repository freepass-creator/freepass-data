import { decodeErp5Value, inspectErp5Capture } from './erp5-source-capture.js';
import { plateIdentityKey, isAssignedPlate } from '../domain/vehicle-plate.js';
import { stableDigest } from '../shared/stable-digest.js';
// @ts-expect-error Existing pure planner has no TypeScript declaration.
import { vehicleMasterSnapshotRows } from '../../scripts/supplier-input-sheet.mjs';
export function verifiedMasterRecords(master, now = Date.now()) {
    const records = vehicleMasterSnapshotRows(master, now).records;
    const trims = new Map(master.trims.map(row => [row.id, row.data]));
    const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value :
        typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
    const drive = (value) => typeof value === 'string' ?
        ['FWD', 'RWD'].includes(value) ? '2WD' : ['4MATIC', '콰트로', 'xDrive'].includes(value) ? 'AWD' : value : null;
    return records.map(record => {
        const trim = trims.get(record.trimId);
        return { ...record, specs: { fuel: typeof trim.fuel === 'string' ? trim.fuel : null,
                displacementCc: numeric(trim.engine_cc), drive: drive(trim.drivetrain), seats: numeric(trim.seats) },
            modelYearStart: numeric(trim.model_year_start),
            modelYearEnd: trim.model_year_end === '현재' ? 2100 : numeric(trim.model_year_end) };
    });
}
/** Check the immutable pair itself; matching display names or a reference_vm_ hash is not proof. */
export function verifiedVehicleMasterReference(master, ids, now = Date.now()) {
    const records = verifiedMasterRecords(master, now);
    if (records.filter(record => record.masterId === ids.masterId && record.trimId === ids.trimId).length !== 1) {
        return { state: 'HOLD', reason: 'MASTER_TRIM_PAIR_NOT_VERIFIED' };
    }
    return { state: 'KNOWN', authority: 'FREEPASS_DATA_VEHICLE_MASTER', identityKind: 'FIRESTORE_DOCUMENT_ID',
        masterId: ids.masterId, trimId: ids.trimId, snapshotDigest: master.digest, readAt: master.readAt };
}
/** Existing plate values are evidence; contradictory rows are excluded, never silently deduplicated. */
export function dataIdentitiesFromErp5(capture) {
    const byPlate = new Map();
    const field = (doc, key) => {
        try {
            const value = decodeErp5Value(doc.fields?.[key] ?? { nullValue: null });
            return typeof value === 'string' ? value.trim() : '';
        }
        catch {
            return '';
        }
    };
    for (const doc of capture.collections.products.documents) {
        const plateRaw = field(doc, 'car_number');
        if (!isAssignedPlate(plateRaw))
            continue;
        const plate = plateIdentityKey(plateRaw);
        const identity = [field(doc, 'maker'), field(doc, 'model'), field(doc, 'sub_model'), field(doc, 'trim_name')];
        if (!identity[0] || !identity[1])
            continue;
        const seen = byPlate.get(plate);
        byPlate.set(plate, seen === undefined ? identity : seen && seen.join('|') === identity.join('|') ? seen : null);
    }
    return [...byPlate].filter((entry) => entry[1] !== null)
        .map(([plate, identity]) => ({ plate, identity })).sort((a, b) => a.plate.localeCompare(b.plate));
}
export function verifiedErp5CaptureFromJson(json) {
    inspectErp5Capture(json);
    return json;
}
export function buildVehicleIdentityInputs(master, capture) {
    verifiedMasterRecords(master);
    const data = dataIdentitiesFromErp5(capture);
    const result = { schema: 'vehicle-identity-inputs/v2', master,
        data, dataReadTime: capture.readTime, dataDigest: stableDigest(data) };
    assertVehicleIdentityInputs(result);
    return result;
}
export function assertVehicleIdentityInputs(value, now = Date.now()) {
    const v = value;
    if (!v || v.schema !== 'vehicle-identity-inputs/v2' || !Array.isArray(v.data) ||
        stableDigest(v.data) !== v.dataDigest)
        throw new Error('VEHICLE_IDENTITY_INPUTS_INVALID');
    verifiedMasterRecords(v.master, now);
    const age = now - Date.parse(v.dataReadTime), plates = new Set();
    if (!Number.isFinite(age) || age < -1000 || age > 300000)
        throw new Error('VEHICLE_IDENTITY_DATA_STALE');
    for (const row of v.data) {
        if (!row || typeof row.plate !== 'string' || !isAssignedPlate(row.plate) ||
            row.plate !== plateIdentityKey(row.plate) || plates.has(row.plate) ||
            !Array.isArray(row.identity) || row.identity.length !== 4 || row.identity.some(x => typeof x !== 'string')) {
            throw new Error('VEHICLE_IDENTITY_INPUTS_INVALID');
        }
        plates.add(row.plate);
    }
}
