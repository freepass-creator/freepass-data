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

const registration = findConsumerSwitch(consumerId);
if (!registration) throw new Error('Unknown consumer cutover registration');

const runtime = await createSheetDeliveryEvidenceDataAccessRuntime();
const result = await runtime.assess(registration, target);

console.log(JSON.stringify({
  consumerId,
  target,
  receiptId: result.record?.receiptId ?? null,
  releaseAuthority: result.record?.receipt.releaseAuthority ?? null,
  approvedRelease: result.registration.evidence.approvedRelease,
  freepassReadVerified: result.registration.evidence.freepassReadVerified,
  productionReadbackVerified:
    result.registration.evidence.productionReadbackVerified,
  decision: result.decision
}, null, 2));

if (!result.decision.allowed) process.exitCode = 2;
