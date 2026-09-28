import { readFile } from 'node:fs/promises';
import {
  auditVehicleNameReferenceParity,
  type LegacyVehicleMasterNameRow,
  type LegacyVehicleProductNameRow,
  type VehicleNameReferenceRow,
} from '../application/vehicle-master-reference-parity.js';

async function rows<T>(envName: string): Promise<T[]> {
  const path = process.env[envName]?.trim();
  if (!path) throw new Error(`${envName} is required`);
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${envName} must point to a JSON array`);
  return value as T[];
}

const report = auditVehicleNameReferenceParity({
  referenceRows: await rows<VehicleNameReferenceRow>('VEHICLE_NAME_REFERENCE_JSON'),
  masterRows: await rows<LegacyVehicleMasterNameRow>('VEHICLE_NAME_MASTER_JSON'),
  productRows: process.env.VEHICLE_NAME_PRODUCT_JSON?.trim()
    ? await rows<LegacyVehicleProductNameRow>('VEHICLE_NAME_PRODUCT_JSON')
    : [],
});

console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exitCode = 2;
