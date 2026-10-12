#!/usr/bin/env node
// 이안카 «감지 후 자동 동기화» 실행기 — ONE synced_at 이 바뀔 때마다 계획→건수 관문→적용을 한 번 돌린다.
// 사람 승인은 그대로 남는다: 시작할 때 아래 환경변수를 «운영자가» 직접 설정해야 하며(없으면 시작 거부, fail-closed), 건수 승인 범위를
// 벗어나면 적용 없이 멈추고 사람이 볼 때까지 대기한다.
//   EANCAR_ONE_SYNC_APPROVED=true            (적용 승인)
//   IANCAR_SYNC_EXPECT='{...필수 8키...}'    (건수 승인 범위, src/domain/iancar-sync-gate.ts)
//   EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET=freepasserp5-data-audit-evidence
// ONE 열쇠는 Secret Manager(freepass-data-iancar-one-api 버전 1)에서 프로세스 메모리로만 읽고 출력·저장하지 않는다.
// 사용: node scripts/iancar-sync-watch.mjs [--once] [--dry] [--state-dir <경로>]
//   --dry  적용 없이 계획만(시험)   --once  한 번 실행하고 끝   기본은 계속 감시
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyOutcome, classifyRun, decide, initialState } from './iancar-sync-watch-lib.mjs';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry'), once = argv.includes('--once');
const stateDir = argv.includes('--state-dir') ? argv[argv.indexOf('--state-dir') + 1] : join(process.env.LOCALAPPDATA ?? process.env.TMPDIR ?? '/tmp', 'freepass-data', 'iancar-sync-watch');
mkdirSync(stateDir, { recursive: true });
const stateFile = join(stateDir, 'state.json'), logFile = join(stateDir, 'history.jsonl'), alertFile = join(stateDir, 'alerts.log');
const log = event => appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const alert = message => { appendFileSync(alertFile, `${new Date().toISOString()} ${message}\n`); console.error(`ALERT ${message}`); };

if (!dry) {
  for (const name of ['EANCAR_ONE_SYNC_APPROVED', 'IANCAR_SYNC_EXPECT', 'EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET']) {
    if (!process.env[name]) { console.error(`필수 환경변수 없음: ${name} (적용 모드는 운영자가 직접 설정해야 시작한다)`); process.exit(64); }
  }
  if (process.env.EANCAR_ONE_SYNC_APPROVED !== 'true') { console.error('EANCAR_ONE_SYNC_APPROVED=true 필요'); process.exit(64); }
}
const key = execFileSync('gcloud', ['secrets', 'versions', 'access', '1', '--secret=freepass-data-iancar-one-api', '--project=freepasserp5'], { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
if (!key) { console.error('ONE 열쇠를 읽지 못함'); process.exit(65); }

async function observe() {
  try {
    const res = await fetch('https://eancarone.com/v1/vehicles?page=1&page_size=1', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { synced: null, status: res.status };
    const body = await res.json();
    return { synced: typeof body.synced_at === 'string' ? body.synced_at : null, status: 200 };
  } catch { return { synced: null, status: 0 }; }
}

function runSync() {
  return new Promise(resolve => {
    const args = ['tsx', 'src/jobs/collect-iancar-one-api.ts', '--sync', '--photos-pending', '--keep-withdrawn', ...(dry ? [] : ['--apply-sync'])];
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
      shell: process.platform === 'win32',
      env: { ...process.env, EANCAR_ONE_API_KEY: key, FIREBASE_PROJECT_ID: 'freepasserp5', EANCAR_ONE_API_TIMEOUT_MS: '45000' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    child.on('close', exitCode => resolve({ exitCode, stdout, stderr }));
  });
}

let lastWait = '';
let state = existsSync(stateFile) ? { ...initialState(), ...JSON.parse(readFileSync(stateFile, 'utf8')) } : initialState();
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 1));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
console.error(`감시 시작(${dry ? '시험(적용 없음)' : '적용'}) — 상태 폴더 ${stateDir}`);

for (;;) {
  const { synced, status } = await observe();
  const decision = decide(state, synced, Date.now());
  if (decision.action === 'RUN') {
    log({ event: 'RUN_START', syncedAt: decision.syncedAt, dry });
    const result = await runSync();
    const outcome = classifyRun(result);
    state = applyOutcome(state, decision.syncedAt, outcome, Date.now());
    save();
    // 출력에는 건수·상태만 남긴다(비밀·원문 없음).
    let summary = {};
    try { const text = result.stdout; const j = JSON.parse(text.slice(text.indexOf('{\n'))); summary = { status: j.status, publication: j.publication ? { status: j.publication.status, open: j.publication.open, created: j.publication.created, absenceHeld: j.publication.absenceHeld, runId: j.publication.runId } : undefined, reasons: j.reasons }; } catch { /* 요약 불가 */ }
    log({ event: 'RUN_END', syncedAt: decision.syncedAt, exitCode: result.exitCode, outcome: outcome.kind, summary });
    if (outcome.kind === 'GATE_HOLD') alert(`건수 승인 범위 밖으로 적용 중단(쓰기 0) — 사람 확인 필요 (syncedAt ${decision.syncedAt})`);
    if (state.halted) alert(`감시 정지: ${state.haltReason}`);
  } else if (decision.action === 'HALTED') {
    if (once) break;
  } else {
    const waitKey = `${decision.reason}|${synced}`;
    if (waitKey !== lastWait) { lastWait = waitKey; log({ event: 'WAIT', reason: decision.reason, observeStatus: status, syncedAt: synced }); } // 같은 사유는 한 번만 기록
  }
  if (once && decision.action !== 'WAIT') break;
  await sleep(decision.action === 'RUN' ? 5_000 : 20_000);
}
