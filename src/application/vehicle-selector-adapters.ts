import type { EstimateNewcarMasterRecord } from '../domain/estimate-master.js';
import {
  usedcarMasterToSelectorRecord,
  type UsedcarMasterRecord,
} from '../domain/usedcar-master.js';
import {
  selectVehicles,
  type VehicleSelectorRecord,
  type VehicleSelectorRequest,
  type VehicleSelectorResult,
} from '../domain/vehicle-selector.js';

function textValue(id: string | null | undefined, label: string | null | undefined) {
  return { id: id ?? null, label: label ?? null };
}

function numberValue(
  id: string | null | undefined,
  value: number | null | undefined,
  label?: string | null
) {
  return {
    id: id ?? null,
    label: label ?? (value == null ? null : String(value)),
    value: value ?? null,
  };
}

export function selectorRecordsFromUsedcarMaster(
  records: readonly UsedcarMasterRecord[]
): VehicleSelectorRecord[] {
  return records.map(usedcarMasterToSelectorRecord);
}

export function selectorRecordsFromNewcarMaster(
  records: readonly EstimateNewcarMasterRecord[]
): VehicleSelectorRecord[] {
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


export function selectVehiclesFromNewcarMaster(
  records: readonly EstimateNewcarMasterRecord[],
  request: Omit<VehicleSelectorRequest, 'mode'>
): VehicleSelectorResult {
  return selectVehicles(selectorRecordsFromNewcarMaster(records), {
    ...request,
    mode: 'NEW_CAR',
  });
}

export function selectVehiclesFromUsedcarMaster(
  records: readonly UsedcarMasterRecord[],
  request: Omit<VehicleSelectorRequest, 'mode'>
): VehicleSelectorResult {
  return selectVehicles(selectorRecordsFromUsedcarMaster(records), {
    ...request,
    mode: 'USED_CAR',
  });
}
