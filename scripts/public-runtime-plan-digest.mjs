import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const markerStart = '```json public-runtime-plan';
const markerEnd = '```';
const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith('--')) ?? 'docs/PUBLIC-RUNTIME-PLAN.md';
const optionValue = (name, envName) => {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1];
  return process.env[envName];
};
const actualDeployment = {
  service: optionValue('service', 'SERVICE_NAME'),
  serviceAccount: optionValue('service-account', 'RUNTIME_SERVICE_ACCOUNT'),
  entrypoint: optionValue('entrypoint', 'RUNTIME_ENTRYPOINT'),
  useConsumerSecrets: optionValue('use-consumer-secrets', 'USE_CONSUMER_SECRETS'),
  maxInstances: optionValue('max-instances', 'MAX_INSTANCES'),
  runtimeConcurrency: optionValue('runtime-concurrency', 'RUNTIME_CONCURRENCY'),
};
for (const [key, value] of Object.entries(actualDeployment)) {
  if (value === undefined || value === '') throw new Error(`PUBLIC_RUNTIME_DIGEST_ARG_MISSING:${key}`);
}
const text = readFileSync(path, 'utf8');
const start = text.indexOf(markerStart);
if (start < 0) throw new Error('PUBLIC_RUNTIME_PLAN_JSON_BLOCK_MISSING');
const jsonStart = text.indexOf('\n', start);
const end = text.indexOf(markerEnd, jsonStart + 1);
if (jsonStart < 0 || end < 0) throw new Error('PUBLIC_RUNTIME_PLAN_JSON_BLOCK_UNCLOSED');

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  }
  return value;
};
const parsed = JSON.parse(text.slice(jsonStart + 1, end));
console.log(createHash('sha256').update(JSON.stringify(stable({ plan: parsed, actualDeployment }))).digest('hex'));
