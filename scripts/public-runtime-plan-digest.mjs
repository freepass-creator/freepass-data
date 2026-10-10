import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const markerStart = '```json public-runtime-plan';
const markerEnd = '```';
const path = process.argv[2] ?? 'docs/PUBLIC-RUNTIME-PLAN.md';
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
console.log(createHash('sha256').update(JSON.stringify(stable(parsed))).digest('hex'));
