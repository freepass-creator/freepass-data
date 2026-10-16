/** 5칸 지표 보고(순수): 회차 기록(heartbeats.jsonl)의 원천별 «마지막 줄»에서 reconciliation 을 읽어 한 줄 표로 만든다. 커맨드 센터 2026-10-14 보고 형식:
 * 원천 판매가능 / 데이터 상품 / 출고가능 노출 / 계약중·잠금 표시 / 판매불가 편입 (+ 정보 부족·순수 NEW·MISSING(잠금)·값 불일치·중복 문서·보류 사유).
 * 번호는 끝 4자리만(원본 줄에 이미 끝 4자리뿐), 네트워크·저장소 접근 없음. */
export type FiveColumnRow = {
  source: string; sellable: number | null; registered: number | null; dispatchableExposed: number | null; contractMarked: number | null; notSellableEnrolled: number | null;
  infoIncomplete: number | null; pureNew: number | null; missing: number | null; missingLocked: number | null; mismatch: number | null; duplicateDocs: number | null;
  dispatchableGap: number | null; sourceDispatchable: number | null; heldReasons: Record<string, number>; lastCompleteAt: string | null; failures: number | null;
  /** 일치 판정: 출고가능 격차 0 + 순수 NEW 0 + 잠금 외 MISSING 0 + 값 불일치 0 + 중복 문서 0. 지표가 없으면 null(추정 금지). */
  matched: boolean | null;
};
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function fiveColumnRows(heartbeatLines: readonly string[]): FiveColumnRow[] {
  const latest = new Map<string, Record<string, unknown>>();
  for (const line of heartbeatLines) {
    const t = line.trim();
    if (!t) continue;
    try { const v = JSON.parse(t); if (obj(v) && typeof v.source === 'string') latest.set(v.source, v); } catch { /* 손상 줄은 건너뛴다 */ }
  }
  return [...latest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([source, beat]): FiveColumnRow => {
    const r = obj(beat.reconciliation) ? beat.reconciliation : null;
    const missing = r ? num(r.missingCount) : null, locked = r ? num(r.missingLockedCount) : null;
    const gap = r ? num(r.dispatchableGap) : null;
    const matched = r === null ? null : gap === 0 && num(r.pureNewCount) === 0 && missing !== null && (missing - (locked ?? 0)) === 0 &&
      num(r.mismatchCount) === 0 && (num(r.duplicateDocCount) ?? 0) === 0;
    const held: Record<string, number> = {};
    if (obj(beat.heldReasons)) for (const [k, v] of Object.entries(beat.heldReasons)) if (typeof v === 'number') held[k] = v;
    return { source, sellable: r ? num(r.sourceSellable) : null, registered: r ? num(r.registeredCount) : null,
      dispatchableExposed: r ? num(r.dispatchableExposedCount) : null, contractMarked: r ? num(r.contractMarkedExposedCount) : null,
      notSellableEnrolled: r ? num(r.notSellableEnrolledCount) : null, infoIncomplete: r ? num(r.infoIncompleteCount) : null,
      pureNew: r ? num(r.pureNewCount) : null, missing, missingLocked: locked, mismatch: r ? num(r.mismatchCount) : null,
      duplicateDocs: r ? num(r.duplicateDocCount) : null, dispatchableGap: gap, sourceDispatchable: r ? num(r.sourceDispatchableCount) : null,
      heldReasons: held, lastCompleteAt: typeof beat.lastCompleteAt === 'string' ? beat.lastCompleteAt : null, failures: num(beat.failures), matched };
  });
}

/** 사람이 읽는 한 줄(원천별). 값이 없으면 «-» (추정하지 않는다). */
export function fiveColumnLine(row: FiveColumnRow): string {
  const f = (v: number | null) => v === null ? '-' : String(v);
  const status = row.matched === null ? '지표 없음' : row.matched ? '일치' : '격차';
  const held = Object.entries(row.heldReasons).map(([k, v]) => `${k}:${v}`).join(',');
  return `${row.source} · 원천 판매가능 ${f(row.sellable)}(출고가능 ${f(row.sourceDispatchable)}) · 상품 ${f(row.registered)} · 출고가능 노출 ${f(row.dispatchableExposed)} · `
    + `계약중·잠금 ${f(row.contractMarked)} · 판매불가 편입 ${f(row.notSellableEnrolled)} · 격차 ${f(row.dispatchableGap)} · 정보 부족 ${f(row.infoIncomplete)} · `
    + `순수 NEW ${f(row.pureNew)} · MISSING ${f(row.missing)}(잠금 ${f(row.missingLocked)}) · 값 불일치 ${f(row.mismatch)} · 중복 ${f(row.duplicateDocs)}`
    + `${held ? ` · 보류 ${held}` : ''} · ${status}`;
}

/** 대표가 보는 «한 줄 판정»(대표 2026-10-14 «검증이 너무 어렵다»): ✅ 일치 / ⚠ 차이 N대와 이유 / ❌ 회차 정지·연속 차이.
 * 이유는 회차 기록의 gap 사유 코드(dispatchGapReasons, #619)를 우리말로 바꾼 것이다 — 추정하지 않고, 기록에 없으면 «사유 기록 없음». */
export const SOURCE_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  RP012: '손오공', RP031: '이안카', RP023: '오토플러스', RP004: '아이카', RP006: '아이언',
});
export const GAP_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  SOURCE_ONLY_NO_DOC: '편입 대기', SOURCE_ONLY_INFO_INCOMPLETE: '정보 부족(가격·상태)', SOURCE_ONLY_NOT_SELLABLE_STALE: '재노출 대기',
  SOURCE_ONLY_WITHDRAWN_OTHER: '기타 비노출', SOURCE_ONLY_NOT_LISTABLE: '비노출', SOURCE_ONLY_LOCKED_EXPOSED: '정산 잠금(계약중 표시)',
  ERP_ONLY_NOT_IN_SOURCE: '원천에 없음(하향 대기)', ERP_ONLY_SOURCE_CONTRACT: '원천은 계약중',
});
/** 같은 원천이 이 회차 수 이상 연속으로 차이면 ❌(사람 확인). */
export const VERDICT_PERSIST_CYCLES = 3;
export type VerdictRow = { source: string; mark: '✅' | '⚠' | '❌'; line: string };

export function verdictRows(heartbeatLines: readonly string[]): VerdictRow[] {
  const bySource = new Map<string, Record<string, unknown>[]>();
  for (const line of heartbeatLines) {
    const t = line.trim();
    if (!t) continue;
    try { const v = JSON.parse(t); if (obj(v) && typeof v.source === 'string') (bySource.get(v.source) ?? bySource.set(v.source, []).get(v.source)!).push(v); } catch { /* 손상 줄은 건너뛴다 */ }
  }
  return [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([source, beats]): VerdictRow => {
    const name = SOURCE_DISPLAY_NAMES[source] ? `${SOURCE_DISPLAY_NAMES[source]}(${source})` : source;
    const last = beats[beats.length - 1]!;
    const r = obj(last.reconciliation) ? last.reconciliation : null;
    if (last.stopped === true) return { source, mark: '❌', line: `${name} ❌ 회차 정지(연속 실패 ${num(last.failures) ?? '-'}) — ${typeof last.error === 'string' ? last.error : '원인 기록 없음'}` };
    if (!r || num(r.dispatchableGap) === null) return { source, mark: '⚠', line: `${name} ⚠ 지표 없음 — 이번 회차 대조 기록이 없다${typeof last.error === 'string' ? ` (${last.error})` : ''}` };
    const src = num(r.sourceDispatchableCount), exposed = num(r.dispatchableExposedCount), contracted = num(r.contractMarkedExposedCount) ?? 0;
    const gap = num(r.dispatchableGap)!;
    const reasons = obj(r.dispatchGapReasons) ? Object.entries(r.dispatchGapReasons).filter(([, n]) => typeof n === 'number' && n > 0) : [];
    const why = reasons.length ? reasons.map(([k, n]) => `${GAP_REASON_LABELS[k] ?? k} ${n}`).join(', ') : '사유 기록 없음';
    const contract = contracted ? ` · 계약중 ${contracted}` : '';
    if (gap === 0 && reasons.length === 0) return { source, mark: '✅', line: `${name} ✅ 원천 출고가능 ${src} = 노출 ${exposed}${contract}` };
    // 연속 차이: 마지막 회차부터 거꾸로 차이(gap≠0 또는 사유 있음)인 회차 수
    let streak = 0;
    for (const b of [...beats].reverse()) {
      const rr = obj(b.reconciliation) ? b.reconciliation : null;
      const differs = rr && (num(rr.dispatchableGap) !== 0 || (obj(rr.dispatchGapReasons) && Object.values(rr.dispatchGapReasons).some(n => typeof n === 'number' && n > 0)));
      if (!differs) break;
      streak++;
    }
    const mark = streak >= VERDICT_PERSIST_CYCLES ? '❌' : '⚠';
    return { source, mark, line: `${name} ${mark} 원천 출고가능 ${src} / 노출 ${exposed}${contract} — ${why}${mark === '❌' ? ` (${streak}회 연속)` : ''}` };
  });
}
