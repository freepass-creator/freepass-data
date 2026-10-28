/** 최초등록일(first_registration_date) 표기 통일 계획 — 순수 함수(대표 2026-10-23 승인, PC1 커맨드).
 *  원칙: 원문(공급사 시트·원천 기록)은 그대로 두고 «정리값»만 통일한다. 날까지 있으면 YYYY-MM-DD, 월까지만이면 YYYY-MM(날을 지어내지 않음), 연만이면 YYYY.
 *  두 자리 연도는 연식과 뜻이 하나일 때(연식 ±1년)만 20YY 로 바꾼다. 미래 날짜는 어떤 표기든 보류한다.
 *  숫자가 있는 모르는 형식은 지우지 않고 보류하고, 숫자가 전혀 없는 문자열(열 어긋남)만 비운다.
 *  정밀도(day|month|year)는 first_registration_date_precision 에 따로 표시하고, 바꾼 문서는 first_registration_date_correction 에 이전 값을 남긴다. */
import { stableDigest } from '../shared/stable-digest.js';

export type FirstRegistrationPrecision = 'day' | 'month' | 'year';
export type FirstRegistrationVerdict =
  | { kind: 'KEEP'; to: string; precision: FirstRegistrationPrecision }
  | { kind: 'NORMALIZE'; to: string; precision: FirstRegistrationPrecision; rule: string }
  | { kind: 'CLEAR'; reason: string }
  | { kind: 'HOLD'; reason: string };

const pad = (n: number) => String(n).padStart(2, '0');
const validMonth = (m: number) => m >= 1 && m <= 12;
const validDay = (y: number, m: number, d: number) => { if (!validMonth(m)) return false; const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; };

export function judgeFirstRegistration(value: unknown, modelYear: unknown, nowMs: number): FirstRegistrationVerdict | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;   // 빈 칸은 이 계획의 대상이 아니다
  if (typeof value !== 'string') return { kind: 'HOLD', reason: 'NOT_A_STRING' };
  const raw = value.trim();
  const year = /^\d{4}$/.test(String(modelYear ?? '')) ? Number(modelYear) : null;
  const future = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d) > nowMs;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?$/.exec(raw)) || (m = /^(\d{4})\.\s?(\d{1,2})\.\s?(\d{1,2})\.?$/.exec(raw)) || (m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw))) {
    const y = +m[1]!;
    if (!validDay(y, +m[2]!, +m[3]!)) return { kind: 'HOLD', reason: 'INVALID_DATE' };
    if (future(y, +m[2]!, +m[3]!)) return { kind: 'HOLD', reason: 'FUTURE_DATE' };
    const to = `${y}-${pad(+m[2]!)}-${pad(+m[3]!)}`;
    return to === raw ? { kind: 'KEEP', to, precision: 'day' } : { kind: 'NORMALIZE', to, precision: 'day', rule: 'YYYY.M.D→YYYY-MM-DD' };
  }
  if ((m = /^(\d{4})[-./](\d{1,2})$/.exec(raw))) {
    if (!validMonth(+m[2]!)) return { kind: 'HOLD', reason: 'INVALID_MONTH' };
    if (future(+m[1]!, +m[2]!, 1)) return { kind: 'HOLD', reason: 'FUTURE_DATE' };
    const to = `${m[1]}-${pad(+m[2]!)}`;
    return to === raw ? { kind: 'KEEP', to, precision: 'month' } : { kind: 'NORMALIZE', to, precision: 'month', rule: 'YYYY-M→YYYY-MM' };
  }
  if (/^\d{4}$/.test(raw)) return Date.UTC(+raw, 0, 1) > nowMs ? { kind: 'HOLD', reason: 'FUTURE_DATE' } : { kind: 'KEEP', to: raw, precision: 'year' };
  if ((m = /^(\d{2})[-.](\d{1,2})[-.](\d{1,2})$/.exec(raw))) {
    const y = 2000 + +m[1]!;
    if (!validDay(y, +m[2]!, +m[3]!)) return { kind: 'HOLD', reason: 'INVALID_DATE' };
    if (year === null || Math.abs(y - year) > 1) return { kind: 'HOLD', reason: 'TWO_DIGIT_YEAR_CONFLICTS_MODEL_YEAR' };
    if (future(y, +m[2]!, +m[3]!)) return { kind: 'HOLD', reason: 'FUTURE_DATE' };
    return { kind: 'NORMALIZE', to: `${y}-${pad(+m[2]!)}-${pad(+m[3]!)}`, precision: 'day', rule: 'YY날짜→YYYY-MM-DD(연식 ±1)' };
  }
  if ((m = /^(\d{2})[-.](\d{1,2})$/.exec(raw))) {
    const y = 2000 + +m[1]!;
    if (!validMonth(+m[2]!)) return { kind: 'HOLD', reason: 'INVALID_MONTH' };
    if (year === null || Math.abs(y - year) > 1) return { kind: 'HOLD', reason: 'TWO_DIGIT_YEAR_CONFLICTS_MODEL_YEAR' };
    if (future(y, +m[2]!, 1)) return { kind: 'HOLD', reason: 'FUTURE_DATE' };
    return { kind: 'NORMALIZE', to: `${y}-${pad(+m[2]!)}`, precision: 'month', rule: 'YY-MM→YYYY-MM(연식 ±1)' };
  }
  return /\d/.test(raw) ? { kind: 'HOLD', reason: 'UNRECOGNIZED_FORMAT' } : { kind: 'CLEAR', reason: 'NOT_A_DATE_COLUMN_SHIFT' };
}

type Rec = Record<string, unknown>;
export type FirstRegistrationInput = { products: { id: string; updateTimeMs: number; data: Rec }[]; nowMs: number };

/** 노출 문서만 대상. 계약 잠금·삭제 문서는 건너뛴다. 패치에는 시각을 넣지 않는다(적용 때 한 번 붙여 digest 가 흔들리지 않게). */
export function buildFirstRegistrationPlan(input: FirstRegistrationInput) {
  const patches: { id: string; updateTimeMs: number; patch: Rec; verdict: string }[] = [];
  const held: { id: string; reason: string }[] = [], skipped: { id: string; reason: string }[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  for (const p of input.products) {
    const d = p.data;
    if (d.listable !== true) continue;
    const v = judgeFirstRegistration(d.first_registration_date, d.year, input.nowMs);
    if (!v) continue;
    if (d.locked_by_contract || d._deleted || d.deletedAt) { skipped.push({ id: p.id, reason: 'LOCKED_OR_DELETED' }); bump(`SKIPPED:${v.kind}`); continue; }
    if (v.kind === 'HOLD') { held.push({ id: p.id, reason: v.reason }); bump(`HOLD:${v.reason}`); continue; }
    if (v.kind === 'KEEP') {
      bump(`KEEP:${v.precision}`);
      if (d.first_registration_date_precision !== v.precision) patches.push({ id: p.id, updateTimeMs: p.updateTimeMs, patch: { first_registration_date_precision: v.precision }, verdict: 'TAG' });
      continue;
    }
    if (v.kind === 'NORMALIZE') {
      bump(`NORMALIZE:${v.precision}`);
      patches.push({ id: p.id, updateTimeMs: p.updateTimeMs, verdict: 'NORMALIZE', patch: { first_registration_date: v.to, first_registration_date_precision: v.precision,
        first_registration_date_correction: { before: d.first_registration_date, reason: 'FORMAT_NORMALIZED', rule: v.rule } } });
      continue;
    }
    bump('CLEAR');
    patches.push({ id: p.id, updateTimeMs: p.updateTimeMs, verdict: 'CLEAR', patch: { first_registration_date: null, first_registration_date_precision: null,
      first_registration_date_correction: { before: d.first_registration_date, reason: v.reason, refill: 'FROM_SOURCE_BY_ENGINE_SPEC_FILL' } } });
  }
  return {
    schema: 'first-registration-normalize-plan/1' as const, counts, held, skipped,
    summary: { toWrite: patches.length, tag: patches.filter(p => p.verdict === 'TAG').length, normalize: patches.filter(p => p.verdict === 'NORMALIZE').length, clear: patches.filter(p => p.verdict === 'CLEAR').length, held: held.length, skipped: skipped.length, deletes: 0 },
    patches, planDigest: stableDigest({ patches: patches.map(p => ({ id: p.id, updateTimeMs: p.updateTimeMs, patch: p.patch })), held }),
  };
}
