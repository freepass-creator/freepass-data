import test from 'node:test';
import assert from 'node:assert/strict';
import { applySnapshot, computeMetrics, digestOf, emptyState, percentile } from '../scripts/supplier-freshness-lib.mjs';

const H = 3600_000;
const row = (id, sup, price, ourMs, listable = true) => ({ id, sup, listable, digest: digestOf({ price }), ourMs, touchedMs: null });

test('첫 회차는 기준선이라 변경 0, 판정은 수집 중', () => {
  const st = emptyState(); const t = Date.UTC(2026, 9, 12);
  applySnapshot(st, [row('a', 'S1', 100, t)], t);
  const [m] = computeMetrics(st, [row('a', 'S1', 100, t)], t);
  assert.equal(m.changed24h, 0); assert.equal(m.verdict, 'BASELINE_COLLECTING');
});

test('값이 달라진 차만 변경으로 세고 평소 주기 3배 초과면 공급사 정체', () => {
  const st = emptyState(); const t0 = Date.UTC(2026, 9, 12);
  applySnapshot(st, [row('a', 'S1', 1, t0), row('b', 'S1', 1, t0)], t0);
  let price = 1;
  for (let i = 1; i <= 4; i++) { price++; const t = t0 + i * 2 * H; applySnapshot(st, [row('a', 'S1', price, t), row('b', 'S1', 1, t)], t); }
  const tNow = t0 + 8 * H + 12 * H; // 마지막 변경 후 12시간(평소 2시간의 6배), 그동안 우리는 계속 관측
  applySnapshot(st, [row('a', 'S1', price, tNow), row('b', 'S1', 1, tNow)], tNow);
  const [m] = computeMetrics(st, [row('a', 'S1', price, tNow), row('b', 'S1', 1, tNow)], tNow);
  assert.equal(m.typicalIntervalH, 2); assert.equal(m.verdict, 'SUPPLIER_STALE');
});

test('관측 도장이 오래되면 공급사 정체가 아니라 도장 정체로 분리', () => {
  const st = emptyState(); const t = Date.UTC(2026, 9, 12);
  applySnapshot(st, [row('a', 'S1', 1, t - 100 * H)], t);
  const [m] = computeMetrics(st, [row('a', 'S1', 1, t - 100 * H)], t);
  assert.equal(m.verdict, 'OBSERVATION_STAMP_STALE');
});

test('백분위', () => { assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9); assert.equal(percentile([], 0.5), null); });

test('기준선 이후 72시간 변경이 한 번도 없으면 정체, 사라진 차도 변경으로 센다', () => {
  const st = emptyState(); const t0 = Date.UTC(2026, 9, 12);
  applySnapshot(st, [row('a', 'S1', 1, t0), row('b', 'S1', 1, t0)], t0);
  for (let i = 1; i <= 4; i++) { const t = t0 + i * 24 * H; applySnapshot(st, [row('a', 'S1', 1, t), row('b', 'S1', 1, t)], t); }
  const tn = t0 + 4 * 24 * H;
  const [m] = computeMetrics(st, [row('a', 'S1', 1, tn), row('b', 'S1', 1, tn)], tn);
  assert.equal(m.verdict, 'SUPPLIER_STALE');
  applySnapshot(st, [row('a', 'S1', 1, tn + H)], tn + H); // b 사라짐
  assert.equal(st.sup.S1.lastChangeMs, tn + H);
});
