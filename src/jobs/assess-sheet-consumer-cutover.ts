import {
  findConsumerSwitch,
  type ConsumerCutoverStage
} from '../domain/consumer-cutover.js';
import { createSheetDeliveryEvidenceDataAccessRuntime } from './data-access-runtime.js';

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

const consumerId = requiredArg('consumer');
const target = requiredArg('target') as ConsumerCutoverStage;
const allowedTargets = new Set<ConsumerCutoverStage>([
  'LEGACY_DIRECT',
  'OBSERVE',
  'SHADOW_READ',
  'PARITY_VERIFIED',
  'FREEPASS_DATA_READ'
]);
if (!allowedTargets.has(target)) {
  throw new Error('Unsupported cutover target');
}

const maxAgeMinutes = Number(requiredArg('max-age-minutes'));
if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) {
  throw new Error('--max-age-minutes must be a positive number');
}

const maxFutureSkewSeconds = Number(optionalArg('max-future-skew-seconds') ?? '0');
if (!Number.isFinite(maxFutureSkewSeconds) || maxFutureSkewSeconds < 0) {
  throw new Error('--max-future-skew-seconds must be zero or positive');
}

const assessedAt = optionalArg('assessed-at') ?? new Date().toISOString();
if (!Number.isFinite(Date.parse(assessedAt))) {
  throw new Error('--assessed-at must be a valid timestamp');
}

const registration = findConsumerSwitch(consumerId);
if (!registration) throw new Error('Unknown consumer cutover registration');

const runtime = await createSheetDeliveryEvidenceDataAccessRuntime();
const result = await runtime.assess(registration, target, {
  assessedAt,
  maxAgeMs: Math.round(maxAgeMinutes * 60_000),
  maxFutureSkewMs: Math.round(maxFutureSkewSeconds * 1_000)
});

console.log(JSON.stringify({
  consumerId,
  target,
  freshnessPolicy: {
    assessedAt,
    maxAgeMinutes,
    maxFutureSkewSeconds
  },
  receiptId: result.record?.receiptId ?? null,
  evidenceDigest: result.record?.evidenceDigest ?? null,
  releaseAuthority: result.record?.receipt.releaseAuthority ?? null,
  approvedRelease: result.registration.evidence.approvedRelease,
  freepassReadVerified: result.registration.evidence.freepassReadVerified,
  productionReadbackVerified:
    result.registration.evidence.productionReadbackVerified,
  freshness: result.freshness,
  decision: result.decision
}, null, 2));

if (!result.decision.allowed) process.exitCode = 2;
