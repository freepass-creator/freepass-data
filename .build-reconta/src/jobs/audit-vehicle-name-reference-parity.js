import { readFile } from 'node:fs/promises';
import { auditVehicleNameReferenceParity, } from '../application/vehicle-master-reference-parity.js';
async function rows(envName) {
    const path = process.env[envName]?.trim();
    if (!path)
        throw new Error(`${envName} is required`);
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(value))
        throw new Error(`${envName} must point to a JSON array`);
    return value;
}
const report = auditVehicleNameReferenceParity({
    referenceRows: await rows('VEHICLE_NAME_REFERENCE_JSON'),
    masterRows: await rows('VEHICLE_NAME_MASTER_JSON'),
    productRows: process.env.VEHICLE_NAME_PRODUCT_JSON?.trim()
        ? await rows('VEHICLE_NAME_PRODUCT_JSON')
        : [],
});
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS')
    process.exitCode = 2;
