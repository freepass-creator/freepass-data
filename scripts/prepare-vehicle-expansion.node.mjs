import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { prepare } from './prepare-vehicle-expansion.mjs';
const row = (id, brand = 'BMW') => ({ id, brand, model: 'Z4', lineup: 'X4 M40i LCI ', trim: '3.0L 트윈파워 터보 가솔린 엔진', price: 99600000, visible: true });
const pack = rows => gzipSync(JSON.stringify({ schema: 'kamatch-reference-catalog/v1', observedDate: '2026-10-31', rows }));
test('HKG stays excluded while non-operating source rows remain catalog evidence', () => {
  const p = prepare(pack([row('a'), ...['현대', '기아', '제네시스', '현대 전기차', '기아 전기차'].map((b, i) => row(String(i), b)), { ...row('hidden'), visible: false }]));
  assert.equal(p.records.length, 2);
  assert.equal(p.records.find(r => r.sourceId === 'hidden').raw.visible, false);
});
test('preserves conflicting taxonomy and unknown identity without inventing a year', () => {
  const r = prepare(pack([row('a')])).records[0];
  assert.equal(r.raw.lineup, 'X4 M40i LCI ');
  assert.equal(r.canonical.modelYear, null);
  assert.equal(r.canonical.powertrainId, null);
  assert.equal(r.priceUse, 'AUDIT_ONLY_NOT_CANONICAL');
});
test('same provider labels with separate IDs stay separate evidence, duplicate IDs fail', () => {
  assert.equal(prepare(pack([row('a'), row('b')])).records.length, 2);
  assert.throws(() => prepare(pack([row('a'), row('a')])), /SOURCE_ID_MISSING_OR_DUPLICATE/);
});
test('malformed schema and incomplete identity fail instead of dropping rows', () => {
  assert.throws(() => prepare(gzipSync('{}')), /SOURCE_SCHEMA_REQUIRED/);
  assert.throws(() => prepare(pack([{ ...row('a'), trim: '' }])), /SOURCE_IDENTITY_REQUIRED/);
});
test('0 price remains audit evidence and does not become a canonical free vehicle', () => {
  const p = prepare(pack([{ ...row('a'), price: 0 }]));
  assert.equal(p.records[0].raw.price, 0);
  assert.equal(p.productionReady, false);
  assert.equal(p.records[0].canonical.trimId, null);
});

test('provider credit categories are retained without opening operations', () => {
  const p = prepare(pack([{ ...row('a'), creditTypes: 'income-only', visible: false }]));
  assert.equal(p.records[0].raw.creditTypes, 'income-only');
  assert.equal(p.records[0].raw.visible, false);
  assert.equal(p.productionReady, false);
});
