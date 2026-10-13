#!/usr/bin/env node
// 원천 신선도 감시(대표 2026-10-13 「데이터 원천 신선하게 erp5에 반영되게 확실하게 관리해」).
// 무인 회차가 남기는 heartbeats.jsonl / alerts.jsonl 만 읽어 원천별 마지막 정상 완료(lastCompleteAt)가
// 허용 시간 안인지 판정한다. 네트워크·Firestore 접근 없음. 원문·토큰을 출력하지 않는다.
//   node scripts/check-source-freshness.mjs [--dir <SOURCE_CYCLE_PRIVATE_DIR>] [--max-age-minutes 120] [--expect RP004,RP006]
// 종료 코드: 0 전부 신선, 1 하나라도 STALE/STOPPED/ERROR/MISSING, 2 입력 오류.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

export function assessFreshness(heartbeatLines, alertLines, { now = Date.now(), maxAgeMinutes = 120, expect = [] } = {}) {
  const parse = (lines) => lines.map(l => l.trim()).filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  const latest = new Map();
  for (const h of parse(heartbeatLines)) if (h && typeof h.source === 'string') latest.set(h.source, h);
  const recentAlerts = parse(alertLines).filter(a => a && Number.isFinite(Date.parse(a.at)) && now - Date.parse(a.at) <= maxAgeMinutes * 60_000);
  const sources = [];
  for (const source of new Set([...expect, ...latest.keys()])) {
    const h = latest.get(source);
    const completeAt = h?.lastCompleteAt && Number.isFinite(Date.parse(h.lastCompleteAt)) ? Date.parse(h.lastCompleteAt) : null;
    const ageMinutes = completeAt === null ? null : Math.round((now - completeAt) / 60_000);
    let status = 'FRESH';
    if (!h) status = 'MISSING';
    else if (h.stopped) status = 'STOPPED';
    else if (completeAt === null) status = 'NEVER_COMPLETED';
    else if (ageMinutes > maxAgeMinutes) status = 'STALE';
    else if (h.error) status = 'ERROR';
    sources.push({ source, status, ageMinutes, lastCompleteAt: h?.lastCompleteAt ?? null, lastAttemptAt: h?.lastAttemptAt ?? null,
      failures: h?.failures ?? null, error: h?.error ?? null, readCount: h?.readCount ?? null, sourceCount: h?.sourceCount ?? null,
      alerts: recentAlerts.filter(a => a.source === source).map(a => a.reason) });
  }
  sources.sort((a, b) => a.source.localeCompare(b.source));
  const unhealthy = sources.filter(s => s.status !== 'FRESH');
  return { checkedAt: new Date(now).toISOString(), maxAgeMinutes, status: unhealthy.length ? 'UNHEALTHY' : 'HEALTHY',
    fresh: sources.length - unhealthy.length, unhealthy: unhealthy.map(s => `${s.source}:${s.status}`), sources };
}

async function readLines(path) {
  try { return (await readFile(path, 'utf8')).split('\n'); } catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
}

export async function freshnessCli(argv, env = process.env) {
  const get = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const dir = get('--dir') || env.SOURCE_CYCLE_PRIVATE_DIR || join(homedir(), '.codex', 'private', 'source-cycle');
  const maxAgeMinutes = Number(get('--max-age-minutes') ?? env.SOURCE_CYCLE_MAX_AGE_MINUTES ?? '120');
  if (!(maxAgeMinutes > 0)) throw new Error('MAX_AGE_INVALID');
  const expect = (get('--expect') ?? env.SOURCE_CYCLE_EXPECT_SOURCES ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const report = assessFreshness(await readLines(join(dir, 'heartbeats.jsonl')), await readLines(join(dir, 'alerts.jsonl')), { maxAgeMinutes, expect });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  freshnessCli(process.argv.slice(2)).then(report => {
    console.log(JSON.stringify(report));
    process.exitCode = report.status === 'HEALTHY' ? 0 : 1;
  }, e => { console.error(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'FRESHNESS_CHECK_ERROR'); process.exitCode = 2; });
}
