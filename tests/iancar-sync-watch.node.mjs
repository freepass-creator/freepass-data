import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOutcome, classifyRun, decide, initialState, MAX_ATTEMPTS_PER_SYNC } from '../scripts/iancar-sync-watch-lib.mjs';

const T = Date.parse('2026-10-12T10:00:00Z');
const sync = minAgo => new Date(T - minAgo * 60000).toISOString();

test('새 갱신(신선 창 안)이면 실행', () => {
  assert.deepEqual(decide(initialState(), sync(1), T), { action: 'RUN', syncedAt: sync(1) });
});
test('이미 처리한 갱신·읽기 실패·이미 15분 지난 갱신은 기다린다', () => {
  assert.equal(decide({ ...initialState(), lastHandledSyncedAt: sync(1) }, sync(1), T).reason, 'ALREADY_HANDLED');
  assert.equal(decide(initialState(), null, T).reason, 'OBSERVE_FAILED');
  assert.equal(decide(initialState(), sync(16), T).reason, 'SOURCE_ALREADY_STALE');
  assert.equal(decide(initialState(), 'not-a-date', T).reason, 'OBSERVED_INVALID');
});
test('같은 갱신에서 일시 실패는 5분 안·최대 2회까지만 재시도', () => {
  let s = applyOutcome(initialState(), sync(2), { kind: 'TRANSIENT' }, T);
  assert.equal(s.lastHandledSyncedAt, null);
  assert.equal(decide(s, sync(2), T).action, 'RUN');
  assert.equal(decide(s, sync(2), T).syncedAt, sync(2));
  s = applyOutcome(s, sync(2), { kind: 'TRANSIENT' }, T);
  assert.equal(s.attemptsForSyncedAt, MAX_ATTEMPTS_PER_SYNC);
  assert.equal(s.lastHandledSyncedAt, sync(2));
  assert.equal(decide(s, sync(2), T).reason, 'ALREADY_HANDLED');
  // 5분이 지난 뒤에는 재시도하지 않는다(전량 읽기 10분 > 남은 창)
  const late = applyOutcome(initialState(), sync(7), { kind: 'TRANSIENT' }, T);
  assert.equal(decide(late, sync(7), T).reason, 'RETRY_WINDOW_PASSED');
});
test('건수 관문 중단은 사람이 볼 때까지 정지(재시도 없음)', () => {
  const s = applyOutcome(initialState(), sync(1), { kind: 'GATE_HOLD' }, T);
  assert.equal(s.halted, true);
  assert.deepEqual(decide(s, sync(0.1), T), { action: 'HALTED', reason: 'GATE_HOLD_NEEDS_HUMAN' });
});
test('429 는 10분 물러난다', () => {
  const s = applyOutcome(initialState(), sync(1), { kind: 'RATE_LIMITED' }, T);
  assert.equal(decide(s, sync(0.5), T).reason, 'BACKOFF');
  assert.equal(decide(s, new Date(T + 11 * 60000).toISOString(), T + 11 * 60000).action, 'RUN');
});
test('연속 실패 3번이면 정지, 성공하면 실패 횟수가 0', () => {
  let s = initialState();
  for (let i = 0; i < 3; i++) s = applyOutcome(s, sync(30 - i), { kind: 'FAILED' }, T);
  assert.equal(s.halted, true); assert.equal(s.haltReason, 'CONSECUTIVE_FAILURES');
  let ok = applyOutcome(applyOutcome(initialState(), sync(5), { kind: 'FAILED' }, T), sync(3), { kind: 'APPLIED' }, T);
  assert.equal(ok.consecutiveFailures, 0); assert.equal(ok.halted, false);
});
test('신선도 초과는 실패로 세지 않고 다음 갱신을 기다린다', () => {
  const s = applyOutcome(initialState(), sync(1), { kind: 'STALE' }, T);
  assert.equal(s.consecutiveFailures, 0); assert.equal(s.lastHandledSyncedAt, sync(1));
});
test('결과 분류', () => {
  assert.equal(classifyRun({ exitCode: 0, stdout: 'IANCAR_ATOM_SYNC_VERIFIED_CONSUMERS_PENDING' }).kind, 'APPLIED');
  assert.equal(classifyRun({ exitCode: 0, stdout: '"status":"OBSERVED_NOT_PUBLISHED"' }).kind, 'FAILED'); // 적용 증거 없는 성공 종료는 성공이 아니다
  assert.equal(classifyRun({ exitCode: 3, stdout: 'HOLD_PLAN_OUT_OF_APPROVED_RANGE' }).kind, 'GATE_HOLD');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'IANCAR_ONE_API_HTTP_429' }).kind, 'RATE_LIMITED');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'IANCAR_ONE_SOURCE_FRESHNESS_EXCEEDED' }).kind, 'STALE');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'IANCAR_PUBLICATION_SOURCE_STALE_OR_INVALID' }).kind, 'STALE');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'TimeoutError' }).kind, 'TRANSIENT');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'IANCAR_PUBLICATION_PLAN_CHANGED' }).kind, 'TRANSIENT');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'something else' }).kind, 'FAILED');
});
