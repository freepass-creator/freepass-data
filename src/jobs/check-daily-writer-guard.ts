import { readFile } from 'node:fs/promises';
import { evaluateDailyWriterGuard, type DailyWriterLogEntry, type DailyWriterRun } from '../domain/daily-writer-guard.js';

// Inputs come from the daily-writer-guard job: Cloud Logging data_access write entries of the daily identity
// (gcloud logging read, JSON array) and every shared-sheet-daily run created in the lookback (GitHub API, JSON array).
const entriesPath = process.env.DAILY_WRITER_LOG_JSON?.trim();
const runsPath = process.env.DAILY_WRITER_RUNS_JSON?.trim();
const account = process.env.DAILY_WRITER_ACCOUNT?.trim();
const lookbackHours = Number(process.env.DAILY_WRITER_LOOKBACK_HOURS ?? '');
if (!entriesPath || !runsPath || !account || !Number.isFinite(lookbackHours) || lookbackHours <= 0) {
  throw new Error('DAILY_WRITER_LOG_JSON, DAILY_WRITER_RUNS_JSON, DAILY_WRITER_ACCOUNT and DAILY_WRITER_LOOKBACK_HOURS are required');
}
const entries = JSON.parse(await readFile(entriesPath, 'utf8')) as DailyWriterLogEntry[];
const runs = JSON.parse(await readFile(runsPath, 'utf8')) as DailyWriterRun[];
if (!Array.isArray(entries) || !Array.isArray(runs)) throw new Error('daily writer guard inputs must be JSON arrays');
const report = evaluateDailyWriterGuard({ entries, runs, account, now: new Date(), lookbackHours });
// Public log: counts and fixed collection names only (no document ids, unknown names are «(other)»).
console.log(JSON.stringify({ version: 'daily-writer-guard/2', ...report }, null, 2));
if (report.status !== 'OK') process.exitCode = 1;
