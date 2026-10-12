import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOutcome, classifyRun, decide, exitCodeFor, initialState, noteObservation, parseReport, MAX_OBSERVE_FAILURES } from '../scripts/iancar-sync-watch-lib.mjs';

const T = Date.parse('2026-10-12T10:00:00Z');
const sync = minAgo => new Date(T - minAgo * 60000).toISOString();
const NL = String.fromCharCode(10);

test('새 갱신(신선 창 안)이면 한 번 실행', () => {
  assert.deepEqual(decide(initialState(), sync(1), T), { action: 'RUN', syncedAt: sync(1) });
});
test('이미 처리한 갱신·읽기 실패·이미 15분 지난 갱신·잘못된 값은 기다린다', () => {
  assert.equal(decide({ ...initialState(), lastHandledSyncedAt: sync(1) }, sync(1), T).reason, 'ALREADY_HANDLED');
  assert.equal(decide(initialState(), null, T).reason, 'OBSERVE_FAILED');
  assert.equal(decide(initialState(), sync(16), T).reason, 'SOURCE_ALREADY_STALE');
  assert.equal(decide(initialState(), 'not-a-date', T).reason, 'OBSERVED_INVALID');
});
test('성공(적용 영수증/시험 계획)만 이어가고, 같은 갱신은 다시 실행하지 않는다', () => {
  for (const kind of ['APPLIED', 'DRY_OK']) {
    const s = applyOutcome(initialState(), sync(2), { kind });
    assert.equal(s.halted, false);
    assert.equal(decide(s, sync(2), T).reason, 'ALREADY_HANDLED');
    assert.equal(decide(s, sync(0.5), T).action, 'RUN');
  }
});
test('어떤 실패든 정지하고 자동 재시도하지 않는다(같은 갱신·새 갱신 모두)', () => {
  for (const kind of ['TRANSIENT', 'FAILED', 'STALE', 'RATE_LIMITED', 'GATE_HOLD']) {
    const s = applyOutcome(initialState(), sync(2), { kind });
    assert.equal(s.halted, true); assert.equal(s.haltReason, kind);
    assert.deepEqual(decide(s, sync(2), T), { action: 'HALTED', reason: kind });
    assert.equal(decide(s, sync(0.1), T).action, 'HALTED');
  }
});

// 수집기 출력 모양: 진행 줄은 한 줄 JSON, 최종 보고는 "{" 다음 줄바꿈으로 시작하는 들여쓴 JSON.
const progress = JSON.stringify({ phase: 'READING_PHASE_ONE_FACTS', completed: 5, total: 5 });
const pretty = value => JSON.stringify(value, null, 2);
const applied = (over = {}) => progress + NL + pretty({ status: 'IANCAR_ATOM_SYNC_VERIFIED_CONSUMERS_PENDING', publicationPlan: { planDigest: 'd' }, publication: { status: 'PHASE_ONE_ATOM_READBACK_VERIFIED', open: 80 }, ...over }) + NL;
const dryOut = (over = {}) => pretty({ status: 'OBSERVED_NOT_PUBLISHED', publicationPlan: { planDigest: 'd' }, ...over }) + NL;

test('보고 JSON 추출: 진행 줄은 무시하고 최종 보고만, 깨지면 null', () => {
  assert.equal(parseReport(applied()).status, 'IANCAR_ATOM_SYNC_VERIFIED_CONSUMERS_PENDING');
  assert.equal(parseReport('no json'), null);
  assert.equal(parseReport('{' + NL + '  "broken": '), null);
});
test('결과 분류: 성공은 종료 코드 0 + 구조화된 영수증 값 일치로만(문자열 포함 여부 아님)', () => {
  assert.equal(classifyRun({ exitCode: 0, stdout: applied() }).kind, 'APPLIED');
  // 영수증 상태가 다르면 사유 문장에 성공 문구가 있어도 성공이 아니다(astra 반례)
  assert.equal(classifyRun({ exitCode: 0, stdout: applied({ status: 'FAILED', reasons: ['missing PHASE_ONE_ATOM_READBACK_VERIFIED'], publication: { status: 'NOT_VERIFIED' } }) }).kind, 'FAILED');
  assert.equal(classifyRun({ exitCode: 0, stdout: applied({ publication: { status: 'WRITE_ONLY' } }) }).kind, 'FAILED');
  assert.equal(classifyRun({ exitCode: 0, stdout: applied({ publication: undefined }) }).kind, 'FAILED');
  assert.equal(classifyRun({ exitCode: 1, stdout: applied() }).kind, 'FAILED');                          // 종료 코드가 0 이 아니면 영수증이 있어도 성공 아님
  assert.equal(classifyRun({ exitCode: 0, stdout: 'PHASE_ONE_ATOM_READBACK_VERIFIED' }).kind, 'FAILED'); // 구조화된 보고 없음
  assert.equal(classifyRun({ exitCode: 0, stdout: '' }).kind, 'FAILED');
  assert.equal(classifyRun({ exitCode: 0, stdout: dryOut(), dry: true }).kind, 'DRY_OK');
  assert.equal(classifyRun({ exitCode: 0, stdout: dryOut({ publicationPlan: undefined }), dry: true }).kind, 'FAILED');
  assert.equal(classifyRun({ exitCode: 0, stdout: dryOut({ publication: { status: 'x' } }), dry: true }).kind, 'FAILED');
  assert.equal(classifyRun({ exitCode: 0, stdout: dryOut(), dry: false }).kind, 'FAILED');               // 적용 모드에서 계획만 있으면 실패
  assert.equal(classifyRun({ exitCode: 3, stdout: '' }).kind, 'GATE_HOLD');
  assert.equal(classifyRun({ exitCode: 1, stdout: pretty({ status: 'HOLD_PLAN_OUT_OF_APPROVED_RANGE' }) }).kind, 'GATE_HOLD');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'IANCAR_ONE_API_HTTP_429' }).kind, 'RATE_LIMITED');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'IANCAR_ONE_SOURCE_FRESHNESS_EXCEEDED' }).kind, 'STALE');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'TimeoutError' }).kind, 'FAILED');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'IANCAR_PUBLICATION_REVISION_CHANGED' }).kind, 'FAILED');
  assert.equal(classifyRun({ exitCode: 1, stderr: 'something else' }).kind, 'FAILED');
});
test('감지 조회가 연속 실패하면 정지(조용한 무한 재시도 금지), 한 번 성공하면 초기화', () => {
  let s = initialState();
  for (let i = 0; i < MAX_OBSERVE_FAILURES - 1; i++) { s = noteObservation(s, null); assert.equal(s.halted, false); }
  assert.equal(noteObservation(s, sync(1)).observeFailures, 0);
  s = noteObservation(s, null);
  assert.equal(s.halted, true); assert.equal(s.haltReason, 'OBSERVE_FAILED');
  assert.deepEqual(decide(s, sync(1), T), { action: 'HALTED', reason: 'OBSERVE_FAILED' });
});
test('날짜로 해석되지 않는 응답(잘못된 값)도 조회 실패로 세어 연속이면 정지', () => {
  let s = initialState();
  for (let i = 0; i < MAX_OBSERVE_FAILURES; i++) s = noteObservation(s, 'not-a-date');
  assert.equal(s.halted, true); assert.equal(s.haltReason, 'OBSERVE_FAILED');
});
test('미래 날짜(1분 넘게)는 잘못된 값으로 기다리고 실패로 센다', () => {
  const future = new Date(T + 10 * 60000).toISOString();
  assert.equal(decide(initialState(), future, T).reason, 'OBSERVED_INVALID');
});
test('종료 코드: 정상 0, 건수 관문 중단 3, 그 밖의 실패 1', () => {
  assert.equal(exitCodeFor({ kind: 'APPLIED' }), 0);
  assert.equal(exitCodeFor({ kind: 'DRY_OK' }), 0);
  assert.equal(exitCodeFor({ kind: 'GATE_HOLD' }), 3);
  for (const kind of ['FAILED', 'STALE', 'RATE_LIMITED', 'TRANSIENT']) assert.equal(exitCodeFor({ kind }), 1);
});

const script = new URL('../scripts/iancar-sync-watch.mjs', import.meta.url).pathname.replace(/^[/]([A-Za-z]:)/, '$1');
const run = (args, env) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir(), ...env } });

test('적용 모드는 승인·건수 범위·백업 버킷을 외부에서 받지 못하면 시작을 거부(64) — 실행기가 승인을 대신하지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'iancar-watch-'));
  const result = run(['--apply', '--once', '--lock-root', root], {});
  assert.equal(result.status, 64);
  assert.match(result.stderr, /EANCAR_ONE_SYNC_APPROVED|IANCAR_SYNC_EXPECT|EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET/);
  const wrong = run(['--apply', '--once', '--lock-root', root], { EANCAR_ONE_SYNC_APPROVED: 'yes', IANCAR_SYNC_EXPECT: '{}', EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET: 'b' });
  assert.equal(wrong.status, 64);
});
test('이미 살아 있는 프로세스가 잠금을 쥐고 있으면 종료 75(동시 실행 금지)', () => {
  const root = mkdtempSync(join(tmpdir(), 'iancar-watch-'));
  const lock = join(root, 'iancar-sync.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), String(process.pid));
  const result = run(['--once', '--lock-root', root], {});
  assert.equal(result.status, 75);
  assert.match(result.stderr, /잠금/);
});
test('죽은 프로세스의 잠금도 자동으로 넘겨받지 않는다(인계 경쟁 자체가 없음) — 종료 75, 사람이 확인 뒤 직접 지운다', () => {
  const root = mkdtempSync(join(tmpdir(), 'iancar-watch-'));
  const lock = join(root, 'iancar-sync.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), '2147483646');
  const auto = run(['--once', '--lock-root', root], {});
  assert.equal(auto.status, 75);
  assert.match(auto.stderr, /직접 지우고/);
  assert.equal(run(['--once', '--break-stale-lock', '--lock-root', root], {}).status, 75);     // 인계 옵션은 없다
  rmSync(lock, { recursive: true, force: true });                                              // 사람이 지운 뒤에는 잠금을 잡는다(열쇠 조회에서 멈추도록 gcloud 없는 PATH — 비밀을 읽지 않는다)
  const empty = mkdtempSync(join(tmpdir(), 'iancar-nopath-'));
  const taken = spawnSync(process.execPath, [script, '--once', '--lock-root', root], { encoding: 'utf8', timeout: 20000, env: { PATH: empty, TEMP: tmpdir(), TMP: tmpdir() } });
  assert.notEqual(taken.status, 75);
});
test('--lock-root 는 시스템 임시 폴더 아래의 시험(적용 없음)에서만 — 적용 모드와 함께 쓰면 거부', () => {
  assert.equal(run(['--once', '--lock-root', join(process.cwd(), 'elsewhere')], {}).status, 64);
  const root = mkdtempSync(join(tmpdir(), 'iancar-watch-'));
  const env = { EANCAR_ONE_SYNC_APPROVED: 'true', IANCAR_SYNC_EXPECT: '{}', EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET: 'freepasserp5-data-audit-evidence' };
  const result = run(['--apply', '--once', '--lock-root', root], env);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /적용은 고정 잠금만/);
});
test('잠금 위치는 LOCALAPPDATA/TMPDIR 같은 환경변수에 의존하지 않는다(환경이 달라도 같은 잠금을 본다)', () => {
  const root = mkdtempSync(join(tmpdir(), 'iancar-watch-'));
  const lock = join(root, 'iancar-sync.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), String(process.pid));
  for (const env of [{ LOCALAPPDATA: join(root, 'a'), HOME: join(root, 'b') }, { HOME: join(root, 'c'), USERPROFILE: join(root, 'd') }, {}]) {
    assert.equal(run(['--once', '--lock-root', root], env).status, 75);
  }
});
