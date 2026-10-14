/** 원천 신선도 판정(순수). 무인 회차가 남기는 heartbeats/alerts 줄만 읽고 네트워크·저장소에 접근하지 않는다.
 * 대표 2026-10-13 「데이터 원천 신선하게 ERP5 에 반영되게 확실하게 관리해」 — 판단은 기억이 아니라 이 기록으로만 한다. */
export type FreshnessStatus = 'FRESH' | 'STALE' | 'STOPPED' | 'ERROR' | 'NEVER_COMPLETED' | 'MISSING';
export type SourceFreshness = {
  source: string; status: FreshnessStatus; ageMinutes: number | null; lastCompleteAt: string | null; lastAttemptAt: string | null;
  failures: number | null; error: string | null; readCount: number | null; sourceCount: number | null; alerts: string[];
};
export type FreshnessReport = {
  checkedAt: string; maxAgeMinutes: number; status: 'HEALTHY' | 'UNHEALTHY'; fresh: number; unhealthy: string[];
  /** 마지막 정상 완료가 escalateAfterMinutes(기본 6시간) 넘게 지난 원천 — 소프트 보류(상류 시각 문제)가 «조용히 계속 못 읽는 상태» 로 묻히지 않게 커맨드 센터에 올릴 대상. */
  escalate: string[];
  /** 임시 오탐 표기(ERP4 가 «바뀐 문서만 쓰기» 라 문서 갱신 시각이 수집 성공 시각이 아닌 원천). 24시간 안에서만 적용하며 unhealthy·escalate 에서 뺀다. */
  knownFalsePositive: string[];
  /** 알려진 예외로 감시에서 뺀 원천(원천:사유:상태[:경과분]). 만료 조건 충족 시 목록에서 사라지고 다시 감시된다. */
  exempt: string[];
  sources: SourceFreshness[];
};
type Beat = { source?: unknown; stopped?: unknown; lastCompleteAt?: unknown; lastAttemptAt?: unknown; failures?: unknown; error?: unknown;
  readCount?: unknown; sourceCount?: unknown };

const parseLines = (lines: readonly string[]): Array<Record<string, unknown>> => lines.map(l => l.trim()).filter(Boolean)
  .flatMap(l => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v as Record<string, unknown>] : []; } catch { return []; } });
const iso = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;

/** 환경 값 파서: «RP012=SONOGONG_LOCKED>RP0xx,RP034=EXCLUDED_BY_DECISION» — 코드 형식·사유 대문자만 받고 나머지는 무시한다(잘못된 설정이 감시를 넓히지 않게). */
export function parseFreshnessExempt(value: string | undefined): Array<{ source: string; reason: string; liftWhenCompleted?: string }> {
  return (value ?? '').split(',').map(v => v.trim()).flatMap(item => {
    const m = /^((?:RP\d{3}|PT-\d{4}))=([A-Z][A-Z0-9_]{2,40})(?:>((?:RP\d{3}|PT-\d{4})))?$/.exec(item);
    return m ? [{ source: m[1]!, reason: m[2]!, ...(m[3] ? { liftWhenCompleted: m[3] } : {}) }] : [];
  });
}
export function assessFreshness(heartbeatLines: readonly string[], alertLines: readonly string[],
  options: { now?: number; maxAgeMinutes?: number; escalateAfterMinutes?: number; knownFalsePositive?: readonly string[]; expect?: readonly string[]; only?: readonly string[];
    /** 알려진 예외(대표/커맨드 센터 결정): 기간 제한(24h) 없이 unhealthy·escalate 에서 빼되 «만료 조건»을 코드로 박는다 —
     * liftWhenCompleted 원천(대체 어댑터의 새 원천 코드)이 실패 없이 한 번이라도 완료하면 예외가 풀리고 다시 감시한다. */
    exempt?: ReadonlyArray<{ source: string; reason: string; liftWhenCompleted?: string }> } = {}): FreshnessReport {
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
  const falsePositive = new Set(options.knownFalsePositive ?? []);
  const isFalsePositive = (s: SourceFreshness) => falsePositive.has(s.source) && s.status === 'STALE' && s.ageMinutes !== null && s.ageMinutes < 24 * 60;
  // 알려진 예외: 만료 조건(대체 원천의 첫 성공 완료)이 충족되면 풀린다.
  const lifted = (e: { liftWhenCompleted?: string }) => {
    if (!e.liftWhenCompleted) return false;
    const b = latest.get(e.liftWhenCompleted);
    return !!b && iso(b.lastCompleteAt) !== null && (num(b.failures) ?? 0) === 0 && b.stopped !== true;
  };
  const exempt = new Map((options.exempt ?? []).filter(e => !lifted(e)).map(e => [e.source, e.reason]));
  const isExempt = (s: SourceFreshness) => exempt.has(s.source) && s.status !== 'FRESH';
  const unhealthy = sources.filter(s => s.status !== 'FRESH' && !isFalsePositive(s) && !isExempt(s));
  return { checkedAt: new Date(now).toISOString(), maxAgeMinutes, status: unhealthy.length ? 'UNHEALTHY' : 'HEALTHY',
    fresh: sources.length - unhealthy.length - sources.filter(isFalsePositive).length - sources.filter(isExempt).length,
    unhealthy: unhealthy.map(s => `${s.source}:${s.status}`),
    knownFalsePositive: sources.filter(isFalsePositive).map(s => `${s.source}:${s.ageMinutes}m`),
    exempt: sources.filter(isExempt).map(s => `${s.source}:${exempt.get(s.source)}:${s.status}${s.ageMinutes === null ? '' : `:${s.ageMinutes}m`}`),
    escalate: unhealthy.filter(s => s.ageMinutes !== null && s.ageMinutes >= (options.escalateAfterMinutes ?? 360))
      .map(s => `${s.source}:${s.status}:${s.ageMinutes}m`), sources };
}
