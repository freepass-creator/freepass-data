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
