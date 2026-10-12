/** 이안카 단발 적용 건수 관문 — 승인한 계획 건수 범위를 벗어나면 쓰기 전에 멈춘다(fail-closed).
 * 설정이 없거나 모양이 틀리거나 필수 항목이 빠지면 «통과»가 아니라 «중단»이다. */
export const IANCAR_SYNC_REQUIRED_KEYS = [
  'created', 'absenceHeld', 'withdrawalHoldsReleased', 'open', 'deletes', 'contractChanges', 'policyDocumentChanges', 'skippedCount',
] as const;

export type IancarSyncGateResult = { ok: true } | { ok: false; reasons: string[] };

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function checkIancarSyncExpect(raw: string | undefined, plan: Record<string, unknown>): IancarSyncGateResult {
  if (raw === undefined || !raw.trim()) return { ok: false, reasons: ['EXPECT_MISSING'] };
  let expect: unknown;
  try { expect = JSON.parse(raw); } catch { return { ok: false, reasons: ['EXPECT_NOT_JSON'] }; }
  // JSON.parse 는 중복 키를 마지막 값으로 덮어 승인 범위가 넓어질 수 있다(예: deletes [0,0] 뒤에 deletes [0,1]).
  // 이 설정 모양(값은 숫자 배열)에서는 문자열 바로 뒤에 ':' 가 오는 것이 전부 키이므로, 같은 키(이스케이프 해석 후)가 두 번 나오면 중단한다.
  const seen = new Set<string>();
  for (const match of raw.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
    let key: string;
    try { key = JSON.parse(`"${match[1]}"`) as string; } catch { return { ok: false, reasons: ['EXPECT_NOT_JSON'] }; }
    if (seen.has(key)) return { ok: false, reasons: [`DUPLICATE_KEY:${key}`] };
    seen.add(key);
  }
  if (!expect || typeof expect !== 'object' || Array.isArray(expect)) return { ok: false, reasons: ['EXPECT_NOT_OBJECT'] };
  const record = expect as Record<string, unknown>;
  const reasons: string[] = [];
  for (const key of Object.keys(record)) if (!(IANCAR_SYNC_REQUIRED_KEYS as readonly string[]).includes(key)) reasons.push(`EXPECT_UNKNOWN_KEY:${key}`);
  for (const key of IANCAR_SYNC_REQUIRED_KEYS) {
    const range = record[key];
    if (!Array.isArray(range) || range.length !== 2 || !isCount(range[0]) || !isCount(range[1]) || range[0] > range[1]) {
      reasons.push(`EXPECT_RANGE_INVALID:${key}`); continue;
    }
    const value = plan[key];
    if (!isCount(value)) { reasons.push(`PLAN_VALUE_INVALID:${key}`); continue; }
    if (value < range[0] || value > range[1]) reasons.push(`OUT_OF_RANGE:${key}=${value}`);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
