import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOutcome, classifyRun, decide, exitCodeFor, initialState } from '../scripts/iancar-sync-watch-lib.mjs';

const T = Date.parse('2026-10-12T10:00:00Z');
const sync = minAgo => new Date(T - minAgo * 60000).toISOString();

test('새 갱신(신선 창 안)이면 한 번 실행', () => {
  assert.deepEqual(decide(initialState(), sync(1), T), { action: 'RUN', syncedAt: sync(1) });
});
test('이미 처리한 갱신·읽기 실패·이미 15분 지난 갱신·잘못된 값은 기다린다', () => {
  assert.equal(decide({ ...initialState(), lastHandledSyncedAt: sync(1) }, sync(1), T).reason, 'ALREADY_HANDLED');
  assert.equal(decide(initialState(), null, T).reason, 'OBSERVE_FAILED');
  assert.equal(decide(initialState(), sync(16), T).reason, 'SOURCE_ALREADY_STALE');
  assert.equal(decide(initialState(), 'not-a-date', T).reason, 'OBSERVED_INVALID');
});
test('성공(적용 증거/시험 계획)만 이어가고, 같은 갱신은 다시 실행하지 않는다', () => {
  for (const kind of ['APPLIED', 'DRY_OK']) {
    const s = applyOutcome(initialState(), sync(2), { kind });
    assert.equal(s.halted, false);
    assert.equal(decide(s, sync(2), T).reason, 'ALREADY_HANDLED');
    assert.equal(decide(s, sync(0.5), T).action, 'RUN');                    // 새 갱신은 실행
  }
});
test('어떤 실패든 정지하고 자동 재시도하지 않는다(같은 갱신·새 갱신 모두)', () => {
  for (const kind of ['TRANSIENT', 'FAILED', 'STALE', 'RATE_LIMITED', 'GATE_HOLD']) {
    const s = applyOutcome(initialState(), sync(2), { kind });
    assert.equal(s.halted, true); assert.equal(s.haltReason, kind);
    assert.deepEqual(decide(s, sync(2), T), { action: 'HALTED', reason: kind });
    assert.equal(decide(s, sync(0.1), T).action, 'HALTED');                 // 새 갱신이 와도 사람이 풀 때까지 정지
  }
});
test('결과 분류: 적용 증거 없는 정상 종료는 성공이 아니다', () => {
  assert.equal(classifyRun({ exitCode: 0, stdout: 'IANCAR_ATOM_SYNC_VERIFIED_CONSUMERS_PENDING' }).kind, 'APPLIED');
  assert.equal(classifyRun({ exitCode: 0, stdout: 'PHASE_ONE_ATOM_READBACK_VERIFIED' }).kind, 'APPLIED');
  assert.equal(classifyRun({ exitCode: 0, stdout: '"status":"OBSERVED_NOT_PUBLISHED","publicationPlan":{}' }).kind, 'FAILED');      // 적용 모드에서 계획만 있음
  assert.equal(classifyRun({ exitCode: 0, stdout: '' }).kind, 'FAILED');
  assert.equal(classifyRun({ exitCode: 0, stdout: '"status":"OBSERVED_NOT_PUBLISHED","publicationPlan":{}', dry: true }).kind, 'DRY_OK');
  assert.equal(classifyRun({ exitCode: 0, stdout: '"status":"OBSERVED_NOT_PUBLISHED"', dry: true }).kind, 'FAILED');                  // 계획 없음
  assert.equal(classifyRun({ exitCode: 3, stdout: 'HOLD_PLAN_OUT_OF_APPROVED_RANGE' }).kind, 'GATE_HOLD');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'IANCAR_ONE_API_HTTP_429' }).kind, 'RATE_LIMITED');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'IANCAR_ONE_SOURCE_FRESHNESS_EXCEEDED' }).kind, 'STALE');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'TimeoutError' }).kind, 'FAILED');                                                  // 시간 초과도 자동 재시도하지 않는다
  assert.equal(classifyRun({ exitCode: 1, stderr: 'IANCAR_PUBLICATION_REVISION_CHANGED' }).kind, 'FAILED');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'something else' }).kind, 'FAILED');
});
test('종료 코드: 정상 0, 건수 관문 중단 3, 그 밖의 실패 1', () => {
  assert.equal(exitCodeFor({ kind: 'APPLIED' }), 0);
  assert.equal(exitCodeFor({ kind: 'DRY_OK' }), 0);
  assert.equal(exitCodeFor({ kind: 'GATE_HOLD' }), 3);
  for (const kind of ['FAILED', 'STALE', 'RATE_LIMITED', 'TRANSIENT']) assert.equal(exitCodeFor({ kind }), 1);
});

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/iancar-sync-watch.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const run = (args, env) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });

test('적용 모드는 승인·건수 범위·백업 버킷을 외부에서 받지 못하면 시작을 거부(64) — 실행기가 승인을 대신하지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'iancar-watch-'));
  const result = run(['--apply', '--once'], { LOCALAPPDATA: root, TMPDIR: root });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /EANCAR_ONE_SYNC_APPROVED|IANCAR_SYNC_EXPECT|EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET/);
  const wrong = run(['--apply', '--once'], { LOCALAPPDATA: root, TMPDIR: root, EANCAR_ONE_SYNC_APPROVED: 'yes', IANCAR_SYNC_EXPECT: '{}', EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET: 'b' });
  assert.equal(wrong.status, 64);                                  // 값이 true 가 아니면 거부
});
test('이미 살아 있는 프로세스가 잠금을 쥐고 있으면 종료 75(동시 실행 금지)', () => {
  const root = mkdtempSync(join(tmpdir(), 'iancar-watch-'));
  const lock = join(root, 'freepass-data', 'iancar-sync.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), String(process.pid));          // 이 시험 프로세스 = 살아 있음
  const result = run(['--once'], { LOCALAPPDATA: root, TMPDIR: root });
  assert.equal(result.status, 75);
  assert.match(result.stderr, /잠금/);
});
