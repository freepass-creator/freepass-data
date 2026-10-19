import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFields, intakeCoverage } from '../scripts/supplier-intake-coverage-lib.mjs';

const NOW = Date.parse('2026-10-12T00:00:00Z');
const runs = [
  { sourceId: 'shared-sheet:x', observedAt: '2026-10-11T22:00:00.000Z', status: 'COMPLETED' },
  { sourceId: 'shared-sheet:x', observedAt: '2026-10-11T23:00:00.000Z', status: 'FAILED' }
];

test('빌린카: 판매 중 차량 전부가 최신 완료 run 원문에 있으면 FULL, 공백 차이는 무시', () => {
  const [r] = intakeCoverage({ nowMs: NOW, runs,
    products: [{ plate: '11가1111', supplier: 'RP021', listable: true }, { plate: '22나 2222', supplier: 'RP021', listable: true }, { plate: '33다3333', supplier: 'RP021', listable: false }],
    rawRows: [{ tab: '빌린카', plate: '11가1111' }, { tab: '빌린카', plate: '22나2222' }] });
  assert.equal(r.code, 'RP021');
  assert.equal(r.intaken, 2);
  assert.equal(r.verdict, 'FULL');
  assert.equal(r.lastRunAgeMin, 120); // 실패 run 은 마지막 성공으로 세지 않는다
});

test('다른 탭의 같은 번호는 편입으로 세지 않는다', () => {
  const [r] = intakeCoverage({ nowMs: NOW, runs,
    products: [{ plate: '11가1111', supplier: 'RP021', listable: true }],
    rawRows: [{ tab: '웰릭스', plate: '11가1111' }] });
  assert.equal(r.verdict, 'NOT_INTAKEN');
});

test('아이카: 직접 수집기 run 이 없으면 편입 0, 있어도 차량 대조 전에는 0 으로 둔다', () => {
  const noRun = intakeCoverage({ nowMs: NOW, runs, products: [{ plate: '44라4444', supplier: 'RP004', listable: true }], rawRows: [] })[1];
  assert.equal(noRun.code, 'RP004');
  assert.equal(noRun.intaken, 0);
  assert.equal(noRun.lastRunObservedAt, null);
  assert.equal(noRun.verdict, 'NOT_INTAKEN');
  const withRun = intakeCoverage({ nowMs: NOW, products: [{ plate: '44라4444', supplier: 'RP004', listable: true }], rawRows: [],
    runs: [...runs, { sourceId: 'supplier:RP004:aica-original-sheet', observedAt: '2026-10-11T23:30:00.000Z', status: 'COMPLETED' }] })[1];
  assert.equal(withRun.lastRunAgeMin, 30);
});

test('차량번호는 결과에 나오지 않는다', () => {
  const out = JSON.stringify(intakeCoverage({ nowMs: NOW, runs, products: [{ plate: '11가1111', supplier: 'RP021', listable: true }], rawRows: [{ tab: '빌린카', plate: '11가1111' }] }));
  assert.ok(!out.includes('11가1111'));
});

test('Firestore 값 해석', () => {
  assert.deepEqual(decodeFields({ a: { stringValue: 'x' }, b: { integerValue: '3' }, c: { mapValue: { fields: { d: { booleanValue: true } } } } }), { a: 'x', b: 3, c: { d: true } });
});
