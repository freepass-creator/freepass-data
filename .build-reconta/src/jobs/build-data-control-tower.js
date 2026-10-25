import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDataControlTower } from '../application/data-control-tower.js';
function optionalArg(name) {
    const prefix = `--${name}=`;
    return process.argv.find((item) => item.startsWith(prefix))
        ?.slice(prefix.length) ?? null;
}
async function readJson(baseDir, file) {
    const absolute = path.resolve(baseDir, file);
    const raw = await readFile(absolute, 'utf8');
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new Error(`INVALID_CONTROL_TOWER_JSON:${file}`);
    }
}
async function readOptionalJson(baseDir, file) {
    try {
        return await readJson(baseDir, file);
    }
    catch (error) {
        if (error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
const baseDir = optionalArg('dir') ?? process.cwd();
const [auditSchedule, sourceInventory, consumerHealth, consumerReadiness, sheetHealth, estimateMasterReadiness] = await Promise.all([
    readJson(baseDir, 'audit-schedule-health.json'),
    readJson(baseDir, 'source-inventory.json'),
    readJson(baseDir, 'consumer-health-summary.json'),
    readJson(baseDir, 'consumer-readiness-summary.json'),
    readJson(baseDir, 'sheet-consumer-health-summary.json'),
    readOptionalJson(baseDir, 'estimate-master-readiness.json')
]);
const report = buildDataControlTower({
    auditSchedule,
    sourceInventory,
    consumerHealth,
    consumerReadiness,
    sheetHealth,
    estimateMasterReadiness
});
console.log(JSON.stringify(report, null, 2));
