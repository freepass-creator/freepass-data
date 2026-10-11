#!/usr/bin/env node
// 수집 15분 감시 — AI 토큰 0, gh 읽기 전용. 공통 시트 15분 갱신 워크플로의 «예약 실행» 기록만 읽어
// 마지막 성공 시각·연속 실패 수·준수율을 파일에 남기고, 정지/연속 실패면 경보 한 줄을 남긴다.
// 쓰기·배포·dispatch 없음. 시트 ID·차량번호·토큰은 읽지도 쓰지도 않는다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, appendFile, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const WORKFLOW = 'shared-sheet-daily.yml';
const EXPECTED_PER_DAY = 96;
export const STALL_MINUTES = 45;
export const FAIL_STREAK = 3;
const ALERT_REPEAT_MINUTES = 60;

/** runs: gh run list 의 {event, conclusion, status, createdAt, updatedAt}. 예약 실행만 쓴다. */
export function evaluate(runs, now = new Date()) {
  const sched = runs.filter(r => r.event === 'schedule')
    .map(r => ({ ...r, at: new Date(r.createdAt) }))
    .sort((a, b) => b.at - a.at);
  const done = sched.filter(r => r.status === 'completed' && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped');
  const lastSuccess = done.find(r => r.conclusion === 'success') ?? null;
  let streak = 0;
  for (const r of done) { if (r.conclusion === 'success') break; streak += 1; }
  const within = ms => sched.filter(r => now - r.at <= ms).length;
  const minutesSinceSuccess = lastSuccess ? Math.round((now - lastSuccess.at) / 60000) : null;
  const alerts = [];
  if (minutesSinceSuccess === null) alerts.push('NO_SCHEDULED_SUCCESS_IN_WINDOW');
  else if (minutesSinceSuccess > STALL_MINUTES) alerts.push(`STALLED_${minutesSinceSuccess}MIN`);
  if (streak >= FAIL_STREAK) alerts.push(`CONSECUTIVE_FAILURES_${streak}`);
  return {
    observedAt: now.toISOString(),
    lastScheduledSuccessAt: lastSuccess ? lastSuccess.at.toISOString() : null,
    minutesSinceSuccess,
    consecutiveFailures: streak,
    scheduledRuns24h: within(24 * 3600e3),
    compliance24h: +(within(24 * 3600e3) / EXPECTED_PER_DAY).toFixed(3),
    scheduledRuns7d: within(7 * 24 * 3600e3),
    compliance7d: +(within(7 * 24 * 3600e3) / (EXPECTED_PER_DAY * 7)).toFixed(3),
    alerts,
  };
}

export function shouldLogAlert(previous, current, now = new Date()) {
  if (!current.alerts.length) return false;
  const same = previous && JSON.stringify(previous.alerts.map(a => a.replace(/\d+MIN/, 'MIN'))) === JSON.stringify(current.alerts.map(a => a.replace(/\d+MIN/, 'MIN')));
  if (!same) return true;
  return now - new Date(previous.lastAlertAt ?? 0) >= ALERT_REPEAT_MINUTES * 60000;
}

async function main() {
  const repo = process.env.FREEPASS_DATA_REPO || 'freepass-creator/freepass-data';
  const dir = process.env.COLLECTION_HEALTH_DIR || join(process.env.LOCALAPPDATA || homedir(), 'freepass-data', 'collection-health');
  await mkdir(dir, { recursive: true });
  const { stdout } = await run('gh', ['run', 'list', '-R', repo, '--workflow', WORKFLOW, '--event', 'schedule', '--limit', '200',
    '--json', 'event,conclusion,status,createdAt'], { maxBuffer: 8 << 20 });
  const state = evaluate(JSON.parse(stdout));
  let previous = null;
  try { previous = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')); } catch { /* 첫 실행 */ }
  const now = new Date();
  const logAlert = shouldLogAlert(previous, state, now);
  state.lastAlertAt = logAlert ? now.toISOString() : previous?.lastAlertAt ?? null;
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  await appendFile(join(dir, 'history.jsonl'), JSON.stringify(state) + '\n');
  if (logAlert) await appendFile(join(dir, 'alerts.log'), `${state.observedAt} 경보 ${state.alerts.join(',')} 마지막성공=${state.lastScheduledSuccessAt ?? '없음'} 연속실패=${state.consecutiveFailures} 24h준수율=${state.compliance24h}\n`);
  console.log(JSON.stringify(state));
}

if (process.argv[1]?.endsWith('collection-health-watch.mjs')) {
  main().catch(e => { console.error('COLLECTION_HEALTH_WATCH_FAILED', e.message); process.exit(1); });
}
