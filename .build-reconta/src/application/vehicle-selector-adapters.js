import { usedcarMasterToSelectorRecord, } from '../domain/usedcar-master.js';
import { selectVehicles, } from '../domain/vehicle-selector.js';
function textValue(id, label) {
    return { id: id ?? null, label: label ?? null };
}
function numberValue(id, value, label) {
    return {
        id: id ?? null,
        label: label ?? (value == null ? null : String(value)),
        value: value ?? null,
    };
}
export function selectorRecordsFromUsedcarMaster(records) {
    return records.map(usedcarMasterToSelectorRecord);
}
export function selectorRecordsFromNewcarMaster(records) {
    return records.map((record) => ({
        recordId: record.productId,
        lifecycle: record.status === 'ACTIVE' ? 'CURRENT' : 'HOLD',
        identityStatus: record.status === 'ACTIVE' ? 'RESOLVED' : 'HOLD',
        maker: textValue(null, record.maker),
        model: textValue(record.vehicleModelId, record.model),
        generation: textValue(null, null),
        phase: textValue(null, null),
        modelYear: numberValue(record.modelYearId, record.modelYear),
        powertrain: textValue(record.powertrainId, record.powertrainName),
        fuelType: textValue(null, null),
        drivetrain: textValue(null, record.configuration.drivetrain),
        seats: numberValue(null, record.configuration.seats),
        trim: textValue(record.trimId, record.trimName),
        aliases: [],
    }));
}
export function selectVehiclesFromNewcarMaster(records, request) {
    return selectVehicles(selectorRecordsFromNewcarMaster(records), {
        ...request,
        mode: 'NEW_CAR',
    });
}
export function selectVehiclesFromUsedcarMaster(records, request) {
    return selectVehicles(selectorRecordsFromUsedcarMaster(records), {
        ...request,
        mode: 'USED_CAR',
    });
}
