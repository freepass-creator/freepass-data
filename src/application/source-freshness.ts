/** 원천 신선도 판정(순수). 무인 회차가 남기는 heartbeats/alerts 줄만 읽고 네트워크·저장소에 접근하지 않는다.
 * 대표 2026-10-13 「데이터 원천 신선하게 ERP5 에 반영되게 확실하게 관리해」 — 판단은 기억이 아니라 이 기록으로만 한다. */
export type FreshnessStatus = 'FRESH' | 'STALE' | 'STOPPED' | 'ERROR' | 'NEVER_COMPLETED' | 'MISSING';
export type SourceFreshness = {
  source: string; status: FreshnessStatus; ageMinutes: number | null; lastCompleteAt: string | null; lastAttemptAt: string | null;
  failures: number | null; error: string | null; readCount: number | null; sourceCount: number | null; alerts: string[];
};
export type FreshnessReport = {
  checkedAt: string; maxAgeMinutes: number; status: 'HEALTHY' | 'UNHEALTHY'; fresh: number; unhealthy: string[]; sources: SourceFreshness[];
};
type Beat = { source?: unknown; stopped?: unknown; lastCompleteAt?: unknown; lastAttemptAt?: unknown; failures?: unknown; error?: unknown;
  readCount?: unknown; sourceCount?: unknown };

const parseLines = (lines: readonly string[]): Array<Record<string, unknown>> => lines.map(l => l.trim()).filter(Boolean)
  .flatMap(l => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v as Record<string, unknown>] : []; } catch { return []; } });
const iso = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;

export function assessFreshness(heartbeatLines: readonly string[], alertLines: readonly string[],
  options: { now?: number; maxAgeMinutes?: number; expect?: readonly string[]; only?: readonly string[] } = {}): FreshnessReport {
  const now = options.now ?? Date.now(), maxAgeMinutes = options.maxAgeMinutes ?? 120, expect = options.expect ?? [];
  const latest = new Map<string, Beat>();
  for (const beat of parseLines(heartbeatLines) as Beat[]) if (typeof beat.source === 'string') latest.set(beat.source, beat);
  const alerts = parseLines(alertLines).filter(a => iso(a.at) && now - Date.parse(a.at as string) <= maxAgeMinutes * 60_000);
  // only: 이번 회차가 실제로 읽는 원천만 판정한다(제외한 원천의 옛 heartbeat 가 영원히 UNHEALTHY 로 남는 것을 막는다).
  const scope = options.only ? [...options.only] : [...latest.keys()];
  const sources: SourceFreshness[] = [...new Set([...expect, ...scope])].sort().map(source => {
    const beat = latest.get(source), completeAt = iso(beat?.lastCompleteAt);
    const ageMinutes = completeAt === null ? null : Math.round((now - Date.parse(completeAt)) / 60_000);
    const error = typeof beat?.error === 'string' ? beat.error : null;
    const status: FreshnessStatus = !beat ? 'MISSING' : beat.stopped === true ? 'STOPPED' : completeAt === null ? 'NEVER_COMPLETED' :
      ageMinutes! > maxAgeMinutes ? 'STALE' : error ? 'ERROR' : 'FRESH';
    return { source, status, ageMinutes, lastCompleteAt: completeAt, lastAttemptAt: iso(beat?.lastAttemptAt), failures: num(beat?.failures),
      error, readCount: num(beat?.readCount), sourceCount: num(beat?.sourceCount),
      alerts: alerts.filter(a => a.source === source).map(a => String(a.reason)) };
  });
  const unhealthy = sources.filter(s => s.status !== 'FRESH');
  return { checkedAt: new Date(now).toISOString(), maxAgeMinutes, status: unhealthy.length ? 'UNHEALTHY' : 'HEALTHY',
    fresh: sources.length - unhealthy.length, unhealthy: unhealthy.map(s => `${s.source}:${s.status}`), sources };
}
