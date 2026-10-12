/** 이안카 단발 적용 건수 관문 — 승인한 계획 건수 범위를 벗어나면 쓰기 전에 멈춘다(fail-closed).
 * 설정이 없거나 모양이 틀리거나 필수 항목이 빠지면 «통과»가 아니라 «중단»이다. */
export const IANCAR_SYNC_REQUIRED_KEYS = [
  'created', 'absenceHeld', 'withdrawalHoldsReleased', 'open', 'deletes', 'contractChanges', 'skippedCount',
] as const;

export type IancarSyncGateResult = { ok: true } | { ok: false; reasons: string[] };

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function checkIancarSyncExpect(raw: string | undefined, plan: Record<string, unknown>): IancarSyncGateResult {
  if (raw === undefined || !raw.trim()) return { ok: false, reasons: ['EXPECT_MISSING'] };
  let expect: unknown;
  try { expect = JSON.parse(raw); } catch { return { ok: false, reasons: ['EXPECT_NOT_JSON'] }; }
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
