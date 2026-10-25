const parseLines = (lines) => lines.map(l => l.trim()).filter(Boolean)
    .flatMap(l => { try {
    const v = JSON.parse(l);
    return v && typeof v === 'object' ? [v] : [];
}
catch {
    return [];
} });
const iso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
/** 환경 값 파서: «RP012=SONOGONG_LOCKED>RP0xx,RP034=EXCLUDED_BY_DECISION» — 코드 형식·사유 대문자만 받고 나머지는 무시한다(잘못된 설정이 감시를 넓히지 않게). */
export function parseFreshnessExempt(value) {
    return (value ?? '').split(',').map(v => v.trim()).flatMap(item => {
        const m = /^((?:RP\d{3}|PT-\d{4}))=([A-Z][A-Z0-9_]{2,40})(?:>((?:RP\d{3}|PT-\d{4})))?$/.exec(item);
        return m ? [{ source: m[1], reason: m[2], ...(m[3] ? { liftWhenCompleted: m[3] } : {}) }] : [];
    });
}
/** 환경 값 파서: «RP012=90:180:SONOGONG_API_STAGNANT» = 원천=정체 분:에스컬레이션 분:라벨. 형식이 틀린 항목은 무시한다(설정 오류가 감시를 넓히지 않게). */
export function parseFreshnessThresholds(value) {
    return (value ?? '').split(',').map(v => v.trim()).flatMap(item => {
        const m = /^((?:RP\d{3}|PT-\d{4}))=(\d{1,4})(?::(\d{1,4}))?(?::([A-Z][A-Z0-9_]{2,40}))?$/.exec(item);
        if (!m)
            return [];
        const max = Number(m[2]), esc = m[3] === undefined ? undefined : Number(m[3]);
        if (max < 10 || (esc !== undefined && esc < max))
            return [];
        return [{ source: m[1], maxAgeMinutes: max, ...(esc !== undefined ? { escalateAfterMinutes: esc } : {}), ...(m[4] ? { label: m[4] } : {}) }];
    });
}
export function assessFreshness(heartbeatLines, alertLines, options = {}) {
    const now = options.now ?? Date.now(), maxAgeMinutes = options.maxAgeMinutes ?? 120, expect = options.expect ?? [];
    const latest = new Map();
    for (const beat of parseLines(heartbeatLines))
        if (typeof beat.source === 'string')
            latest.set(beat.source, beat);
    const alerts = parseLines(alertLines).filter(a => iso(a.at) && now - Date.parse(a.at) <= maxAgeMinutes * 60_000);
    // only: 이번 회차가 실제로 읽는 원천만 판정한다(제외한 원천의 옛 heartbeat 가 영원히 UNHEALTHY 로 남는 것을 막는다).
    const scope = options.only ? [...options.only] : [...latest.keys()];
    const thresholds = new Map((options.sourceThresholds ?? []).map(t => [t.source, t]));
    const sources = [...new Set([...expect, ...scope])].sort().map(source => {
        const beat = latest.get(source), completeAt = iso(beat?.lastCompleteAt);
        const ageMinutes = completeAt === null ? null : Math.round((now - Date.parse(completeAt)) / 60_000);
        const error = typeof beat?.error === 'string' ? beat.error : null;
        const sourceMax = thresholds.get(source)?.maxAgeMinutes ?? maxAgeMinutes;
        const status = !beat ? 'MISSING' : beat.stopped === true ? 'STOPPED' : completeAt === null ? 'NEVER_COMPLETED' :
            ageMinutes > sourceMax ? 'STALE' : error ? 'ERROR' : 'FRESH';
        return { source, status, ageMinutes, lastCompleteAt: completeAt, lastAttemptAt: iso(beat?.lastAttemptAt), failures: num(beat?.failures),
            error, readCount: num(beat?.readCount), sourceCount: num(beat?.sourceCount),
            alerts: alerts.filter(a => a.source === source).map(a => String(a.reason)) };
    });
    const falsePositive = new Set(options.knownFalsePositive ?? []);
    const isFalsePositive = (s) => falsePositive.has(s.source) && s.status === 'STALE' && s.ageMinutes !== null && s.ageMinutes < 24 * 60;
    // 알려진 예외: 만료 조건(대체 원천의 첫 성공 완료)이 충족되면 풀린다.
    const lifted = (e) => {
        if (!e.liftWhenCompleted)
            return false;
        const b = latest.get(e.liftWhenCompleted);
        return !!b && iso(b.lastCompleteAt) !== null && (num(b.failures) ?? 0) === 0 && b.stopped !== true;
    };
    const exempt = new Map((options.exempt ?? []).filter(e => !lifted(e)).map(e => [e.source, e.reason]));
    const isExempt = (s) => exempt.has(s.source) && s.status !== 'FRESH';
    const unhealthy = sources.filter(s => s.status !== 'FRESH' && !isFalsePositive(s) && !isExempt(s));
    return { checkedAt: new Date(now).toISOString(), maxAgeMinutes, status: unhealthy.length ? 'UNHEALTHY' : 'HEALTHY',
        fresh: sources.length - unhealthy.length - sources.filter(isFalsePositive).length - sources.filter(isExempt).length,
        unhealthy: unhealthy.map(s => `${s.source}:${s.status}`),
        knownFalsePositive: sources.filter(isFalsePositive).map(s => `${s.source}:${s.ageMinutes}m`),
        exempt: sources.filter(isExempt).map(s => `${s.source}:${exempt.get(s.source)}:${s.status}${s.ageMinutes === null ? '' : `:${s.ageMinutes}m`}`),
        escalate: unhealthy.filter(s => s.ageMinutes !== null && s.ageMinutes >= (thresholds.get(s.source)?.escalateAfterMinutes ?? options.escalateAfterMinutes ?? 360))
            .map(s => `${s.source}:${s.status}:${s.ageMinutes}m`),
        // 원천별 임계값을 넘겨 «정체» 로 판정된 원천(라벨 있는 것만). 노출을 내리지 않는 경보 전용이다(공백 방지).
        stagnant: unhealthy.filter(s => s.status === 'STALE' && thresholds.get(s.source)?.label).map(s => `${s.source}:${thresholds.get(s.source).label}:${s.ageMinutes}m`),
        sources };
}
