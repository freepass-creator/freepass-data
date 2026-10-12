#!/usr/bin/env node
// 이안카 «감지 후 자동 동기화» 실행기 — ONE synced_at 이 바뀔 때마다 계획→건수 관문→적용을 «새 갱신 한 번당 한 번» 돌린다.
// 기본은 시험(적용 없음, 계획만). 적용은 명시 `--apply` 이고, 승인·건수 범위·백업 버킷은 «외부에서 환경변수로만» 받는다(이 파일은 설정하지 않는다):
//   EANCAR_ONE_SYNC_APPROVED=true            (적용 승인)
//   IANCAR_SYNC_EXPECT='{...필수 8키...}'    (승인된 건수 범위, src/domain/iancar-sync-gate.ts)
//   EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET=freepasserp5-data-audit-evidence
// ONE 열쇠는 Secret Manager(freepass-data-iancar-one-api 버전 1)에서 프로세스 메모리로만 읽고, 명령행 인자·출력·파일에 두지 않는다
// (gcloud 에는 비밀 이름만, 자식 수집기에는 환경변수로만 전달).
// 사용: node scripts/iancar-sync-watch.mjs [--apply] [--once] [--reset-halt] [--break-stale-lock] [--state-dir <경로>]
//   --once   새 갱신을 한 번 처리하고 종료(종료 코드: 정상 0 / 건수 관문 중단 3 / 그 밖의 실패 1 / 정지 상태 2 / 다른 실행 중 75 / 설정 오류 64·65)
//   기본은 계속 감시. 어떤 실패든(감지 조회 연속 3번 실패 포함) 정지(종료 코드 2)하고 자동 재시도하지 않는다. 사람이 확인한 뒤 --reset-halt 로만 다시 시작한다.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOutcome, classifyRun, decide, exitCodeFor, initialState, noteObservation, parseReport } from './iancar-sync-watch-lib.mjs';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply'), once = argv.includes('--once'), resetHalt = argv.includes('--reset-halt'), breakStale = argv.includes('--break-stale-lock');
const root = process.env.LOCALAPPDATA ?? process.env.TMPDIR ?? '/tmp';
const stateDir = argv.includes('--state-dir') ? argv[argv.indexOf('--state-dir') + 1] : join(root, 'freepass-data', 'iancar-sync-watch');
mkdirSync(stateDir, { recursive: true });
const stateFile = join(stateDir, 'state.json'), logFile = join(stateDir, 'history.jsonl'), alertFile = join(stateDir, 'alerts.log');
const log = event => appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const alert = message => { appendFileSync(alertFile, `${new Date().toISOString()} ${message}\n`); console.error(`ALERT ${message}`); };

if (apply) {
  for (const name of ['EANCAR_ONE_SYNC_APPROVED', 'IANCAR_SYNC_EXPECT', 'EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET']) {
    if (!process.env[name]) { console.error(`적용 모드는 외부에서 ${name} 를 받아야 시작한다(이 실행기는 승인을 대신 설정하지 않는다)`); process.exit(64); }
  }
  if (process.env.EANCAR_ONE_SYNC_APPROVED !== 'true') { console.error('EANCAR_ONE_SYNC_APPROVED=true 필요'); process.exit(64); }
}

// 배타 잠금: 감시 둘·감시와 단발이 동시에 같은 적용을 하지 못하게 한다.
// 자동으로 넘겨받지 않는다(두 실행기가 죽은 잠금을 동시에 넘겨받는 경쟁을 만들지 않기 위해). 비정상 종료로 남은 잠금은
// 사람이 --break-stale-lock 로 «프로세스가 죽은 것을 확인한 경우에만» 지운다(그 실행 하나만 실행 중이어야 한다).
const lockDir = join(root, 'freepass-data', 'iancar-sync.lock');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function readLockPid() { try { return Number(readFileSync(join(lockDir, 'pid'), 'utf8')); } catch { return NaN; } }
function takeLock() {
  mkdirSync(join(root, 'freepass-data'), { recursive: true });
  try { mkdirSync(lockDir); writeFileSync(join(lockDir, 'pid'), String(process.pid)); return 'OK'; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = readLockPid();
    if (breakStale && Number.isFinite(pid) && !alive(pid)) {
      rmSync(lockDir, { recursive: true, force: true });
      try { mkdirSync(lockDir); writeFileSync(join(lockDir, 'pid'), String(process.pid)); return 'OK'; } catch { return 'BUSY'; }
    }
    return Number.isFinite(pid) && !alive(pid) ? 'STALE' : 'BUSY';
  }
}
const lock = takeLock();
if (lock === 'BUSY') { console.error('다른 이안카 동기화가 실행 중이다(잠금) — 종료'); process.exit(75); }
if (lock === 'STALE') { console.error('이전 실행이 비정상 종료하며 남긴 잠금(프로세스 없음) — 확인 후 --break-stale-lock 로 다시 시작'); process.exit(75); }

// 자식 수집기가 살아 있는 동안에는 잠금을 놓지 않는다: 종료·신호 때 자식 트리를 먼저 끝낸 뒤 잠금을 지운다.
let child = null;
function killChildTree() {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ } } }
}
const releaseLock = () => { killChildTree(); try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* 무시 */ } };
process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const key = execFileSync('gcloud', ['secrets', 'versions', 'access', '1', '--secret=freepass-data-iancar-one-api', '--project=freepasserp5'], { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
if (!key) { console.error('ONE 열쇠를 읽지 못함'); process.exit(65); }

async function observe() {
  try {   // 열쇠는 프로세스 안에서만 헤더로 쓴다(명령행 인자 없음)
    const res = await fetch('https://eancarone.com/v1/vehicles?page=1&page_size=1', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { synced: null, status: res.status };
    const body = await res.json();
    return { synced: typeof body.synced_at === 'string' ? body.synced_at : null, status: 200 };
  } catch { return { synced: null, status: 0 }; }
}

function runSync() {
  return new Promise(resolve => {
    const args = ['tsx', 'src/jobs/collect-iancar-one-api.ts', '--sync', '--photos-pending', '--keep-withdrawn', ...(apply ? ['--apply-sync'] : [])];
    child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
      shell: process.platform === 'win32', detached: process.platform !== 'win32',
      env: { ...process.env, EANCAR_ONE_API_KEY: key, FIREBASE_PROJECT_ID: 'freepasserp5', EANCAR_ONE_API_TIMEOUT_MS: '45000' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    child.on('close', exitCode => { child = null; resolve({ exitCode, stdout, stderr }); });
  });
}

let state = existsSync(stateFile) ? { ...initialState(), ...JSON.parse(readFileSync(stateFile, 'utf8')) } : initialState();
if (resetHalt) { state = { ...state, halted: false, haltReason: null, observeFailures: 0 }; log({ event: 'RESET_HALT' }); }
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 1));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastWait = '';
console.error(`감시 시작(${apply ? '적용' : '시험(적용 없음)'}${once ? ', 한 번' : ''}) — 상태 폴더 ${stateDir}`);

let finalCode = 0;
for (;;) {
  const { synced, status } = await observe();
  state = noteObservation(state, synced);
  if (state.halted && state.haltReason === 'OBSERVE_FAILED') save();
  const decision = decide(state, synced, Date.now());
  if (decision.action === 'HALTED') { alert(`정지 상태(${decision.reason}) — 사람이 확인한 뒤 --reset-halt 로 다시 시작`); finalCode = decision.reason === 'OBSERVE_FAILED' ? 1 : 2; break; }
  if (decision.action === 'RUN') {
    log({ event: 'RUN_START', syncedAt: decision.syncedAt, apply });
    const result = await runSync();
    const outcome = classifyRun({ ...result, dry: !apply });
    state = applyOutcome(state, decision.syncedAt, outcome);
    save();
    // 기록에는 건수·상태만 남긴다(비밀·원문 없음).
    const j = parseReport(result.stdout);
    const summary = j ? { status: j.status, publication: j.publication ? { status: j.publication.status, open: j.publication.open, created: j.publication.created, absenceHeld: j.publication.absenceHeld, runId: j.publication.runId } : undefined, reasons: j.reasons } : {};
    log({ event: 'RUN_END', syncedAt: decision.syncedAt, exitCode: result.exitCode, outcome: outcome.kind, summary });
    if (outcome.kind === 'GATE_HOLD') alert(`건수 승인 범위 밖으로 적용 중단(쓰기 0) — 사람 확인 필요 (syncedAt ${decision.syncedAt})`);
    else if (!state.halted) console.error(`처리 완료(${outcome.kind}) syncedAt ${decision.syncedAt}`);
    if (state.halted) alert(`정지: ${state.haltReason} — 자동 재시도 없음, 사람 확인 필요`);
    finalCode = exitCodeFor(outcome);
    if (once || state.halted) break;
  } else {
    const waitKey = `${decision.reason}|${synced}`;
    if (waitKey !== lastWait) { lastWait = waitKey; log({ event: 'WAIT', reason: decision.reason, observeStatus: status, syncedAt: synced }); }
  }
  await sleep(decision.action === 'RUN' ? 5_000 : 20_000);
}
process.exit(finalCode);
