import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, shouldLogAlert } from '../scripts/collection-health-watch.mjs';

const now = new Date('2026-10-12T00:00:00Z');
const mk = (minAgo, conclusion, event = 'schedule', status = 'completed') => ({ event, conclusion, status, createdAt: new Date(now - minAgo * 60000).toISOString() });

test('최근 성공이면 경보 없음', () => {
  const s = evaluate([mk(10, 'success'), mk(25, 'success')], now);
  assert.equal(s.minutesSinceSuccess, 10); assert.deepEqual(s.alerts, []); assert.equal(s.scheduledRuns24h, 2);
});
test('45분 초과 정지', () => {
  const s = evaluate([mk(120, 'success')], now);
  assert.deepEqual(s.alerts, ['STALLED_120MIN']);
});
test('3연속 실패 + 수동 실행은 세지 않음', () => {
  const s = evaluate([mk(5, 'failure'), mk(20, 'failure'), mk(35, 'failure'), mk(40, 'success'), mk(1, 'success', 'workflow_dispatch')], now);
  assert.equal(s.consecutiveFailures, 3); assert.ok(s.alerts.includes('CONSECUTIVE_FAILURES_3'));
});
test('진행 중·취소는 연속 실패로 세지 않음', () => {
  const s = evaluate([mk(2, null, 'schedule', 'in_progress'), mk(15, 'cancelled'), mk(30, 'success')], now);
  assert.equal(s.consecutiveFailures, 0);
});
test('성공 기록이 없으면 경보', () => {
  assert.deepEqual(evaluate([], now).alerts, ['NO_SCHEDULED_SUCCESS_IN_WINDOW']);
});
test('같은 경보는 1시간 안에는 다시 기록하지 않음', () => {
  const cur = evaluate([mk(120, 'success')], now);
  assert.equal(shouldLogAlert(null, cur, now), true);
  assert.equal(shouldLogAlert({ alerts: ['STALLED_100MIN'], lastAlertAt: new Date(now - 10 * 60000).toISOString() }, cur, now), false);
  assert.equal(shouldLogAlert({ alerts: ['STALLED_100MIN'], lastAlertAt: new Date(now - 90 * 60000).toISOString() }, cur, now), true);
});
