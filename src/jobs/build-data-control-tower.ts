import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildDataControlTower,
  type AuditScheduleHealthSummary,
  type ConsumerHealthScheduleSummary,
  type ConsumerReadinessScheduleSummary,
  type SheetHealthScheduleSummary,
  type SourceInventorySummary
} from '../application/data-control-tower.js';

function optionalArg(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))
    ?.slice(prefix.length) ?? null;
}

async function readJson<T>(baseDir: string, file: string): Promise<T> {
  const absolute = path.resolve(baseDir, file);
  const raw = await readFile(absolute, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`INVALID_CONTROL_TOWER_JSON:${file}`);
  }
}

const baseDir = optionalArg('dir') ?? process.cwd();

const [
  auditSchedule,
  sourceInventory,
  consumerHealth,
  consumerReadiness,
  sheetHealth
] = await Promise.all([
  readJson<AuditScheduleHealthSummary>(
    baseDir,
    'audit-schedule-health.json'
  ),
  readJson<SourceInventorySummary>(
    baseDir,
    'source-inventory.json'
  ),
  readJson<ConsumerHealthScheduleSummary>(
    baseDir,
    'consumer-health-summary.json'
  ),
  readJson<ConsumerReadinessScheduleSummary>(
    baseDir,
    'consumer-readiness-summary.json'
  ),
  readJson<SheetHealthScheduleSummary>(
    baseDir,
    'sheet-consumer-health-summary.json'
  )
]);

const report = buildDataControlTower({
  auditSchedule,
  sourceInventory,
  consumerHealth,
  consumerReadiness,
  sheetHealth
});

console.log(JSON.stringify(report, null, 2));
