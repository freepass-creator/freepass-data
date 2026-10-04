import { readFile } from 'node:fs/promises';
import { evaluateDailyWriterGuard, type DailyWriterLogEntry, type DailyWriterRun } from '../domain/daily-writer-guard.js';

// Inputs come from the hourly audit: Cloud Logging data_access entries (gcloud logging read, JSON) and the
// data-owned-refresh workflow runs list (GitHub API JSON).
const entriesPath = process.env.DAILY_WRITER_LOG_JSON?.trim();
const runsPath = process.env.DAILY_WRITER_RUNS_JSON?.trim();
const account = process.env.DAILY_WRITER_ACCOUNT?.trim();
if (!entriesPath || !runsPath || !account) {
  throw new Error('DAILY_WRITER_LOG_JSON, DAILY_WRITER_RUNS_JSON and DAILY_WRITER_ACCOUNT are required');
}
const entries = JSON.parse(await readFile(entriesPath, 'utf8')) as DailyWriterLogEntry[];
if (!Array.isArray(entries)) throw new Error('DAILY_WRITER_LOG_JSON must be a JSON array');
const runs = (JSON.parse(await readFile(runsPath, 'utf8')) as { workflow_runs?: DailyWriterRun[] }).workflow_runs;
if (!Array.isArray(runs)) throw new Error('DAILY_WRITER_RUNS_JSON must carry workflow_runs');
const report = evaluateDailyWriterGuard({ entries, runs, account, now: new Date() });
// Public log: counts and collection names only (no document ids).
console.log(JSON.stringify({ version: 'daily-writer-guard/1', ...report }, null, 2));
if (report.status !== 'OK') process.exitCode = 1;
