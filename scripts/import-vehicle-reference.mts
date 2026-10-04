import { readFile } from 'node:fs/promises';
import { persistVehicleReferenceDataset } from '../src/application/persist-vehicle-reference.js';
import { createVehicleMasterJobRuntime } from '../src/jobs/data-access-runtime.js';

if (process.env.VEHICLE_REFERENCE_IMPORT_APPROVED !== 'true') {
  throw new Error('VEHICLE_REFERENCE_IMPORT_APPROVED=true required');
}
const filePath = process.env.VEHICLE_REFERENCE_IMPORT_FILE;
if (!filePath) throw new Error('VEHICLE_REFERENCE_IMPORT_FILE required');

const bytes = await readFile(filePath);
const { store, archive } = createVehicleMasterJobRuntime();
const result = await persistVehicleReferenceDataset({ store, archive }, bytes);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
