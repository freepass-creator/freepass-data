import {
  createConsumerReadinessDataAccessRuntime,
  createConsumerReadinessReadOnlyDataAccessRuntime
} from './data-access-runtime.js';

function requiredArg(name: string) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) throw new Error(`--${name}=... is required`);
  return value;
}

function optionalArg(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))
    ?.slice(prefix.length) ?? null;
}

const maxAgeMinutes = Number(requiredArg('max-age-minutes'));
if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) {
  throw new Error('--max-age-minutes must be a positive number');
}

const maxFutureSkewSeconds = Number(
  optionalArg('max-future-skew-seconds') ?? '0'
);
if (!Number.isFinite(maxFutureSkewSeconds) || maxFutureSkewSeconds < 0) {
  throw new Error('--max-future-skew-seconds must be zero or positive');
}

const eventLimit = Number(optionalArg('event-limit') ?? '1000');
if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > 5000) {
  throw new Error('--event-limit must be an integer between 1 and 5000');
}

const assessedAt = optionalArg('assessed-at') ?? new Date().toISOString();
if (!Number.isFinite(Date.parse(assessedAt))) {
  throw new Error('--assessed-at must be a valid timestamp');
}

const scheduledReadOnly = process.argv.includes('--scheduled-read-only');
const runtime = scheduledReadOnly
  ? await createConsumerReadinessReadOnlyDataAccessRuntime({
      accessToken: process.env.FREEPASS_ERP5_READ_ACCESS_TOKEN ?? '',
      evidenceBucket: process.env.EVIDENCE_BUCKET ?? ''
    })
  : await createConsumerReadinessDataAccessRuntime();
const report = await runtime.readiness({
  assessedAt,
  maxAgeMs: Math.round(maxAgeMinutes * 60_000),
  maxFutureSkewMs: Math.round(maxFutureSkewSeconds * 1_000),
  eventLimit
});

console.log(JSON.stringify(report, null, 2));

if (report.counts.hold > 0) process.exitCode = 2;
