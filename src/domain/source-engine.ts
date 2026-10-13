import { stableDigest } from '../shared/stable-digest.js';
import type { SourceRun } from './source.js';

export type SourceAmount = { state: 'KNOWN'; value: number } | { state: 'ZERO'; value: 0 } | { state: 'UNKNOWN'; value: null };
export type SourceTerm = {
  months: number; monthlyRent: SourceAmount; deposit: SourceAmount;
  mileage: string | null; raw: Record<string, unknown>;
};
export type SourceProductRecord = {
  sourceId: string; uid: string; plate: string | null; vehicleText: string;
  status: { raw: string; saleAvailable: boolean | null };
  terms: SourceTerm[]; observedAt: string; raw: Record<string, unknown>;
  vehicleHold: string[];
};
export type SourceRowHold = { row: number; reasons: string[] };
export type SourceRead<T> = {
  raw: T | null; complete: boolean; attemptedAt: string; observedAt: string | null;
  error: 'PARTIAL' | 'RATE_LIMITED' | 'AUTH_FAILED' | 'READ_FAILED' | 'SCHEMA_INVALID' | null;
  /** READ_FAILED 의 안전한 세부 코드(대문자·숫자·밑줄, 예: HTTP_503·TIMEOUT·내부 오류 코드). 응답 본문·원문 메시지는 담지 않는다. */
  detail?: string | null;
};
const READ_DETAIL = /^[A-Z][A-Z0-9_]{2,63}$/;
/** 읽기 예외를 분류 코드와 안전한 세부 코드로 나눈다. 429·401·403 은 기존 분류를 유지하고, 그 밖의 실패만 세부를 남긴다. */
export function classifyReadError(e: unknown): { error: 'RATE_LIMITED' | 'AUTH_FAILED' | 'READ_FAILED'; detail: string | null } {
  const text = e instanceof Error ? e.message : '';
  const status = typeof (e as { status?: unknown } | null)?.status === 'number' ? (e as { status: number }).status : null;
  if (status === 429 || /429/.test(text)) return { error: 'RATE_LIMITED', detail: null };
  if (status === 401 || status === 403 || /403|401/.test(text)) return { error: 'AUTH_FAILED', detail: null };
  const name = e instanceof Error ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return { error: 'READ_FAILED', detail: 'TIMEOUT' };
  if (status !== null && status >= 100 && status <= 599) return { error: 'READ_FAILED', detail: `HTTP_${status}` };
  return { error: 'READ_FAILED', detail: READ_DETAIL.test(text) ? text : null };
}
export interface SourceEngine<T> {
  read(): Promise<SourceRead<T>>;
  toRecords(read: SourceRead<T>): { records: SourceProductRecord[]; held: SourceRowHold[] };
}
export type SourceFamily = 'SHARED_SHEET' | 'AICA' | 'IANCAR' | 'OTHER';
export const SOURCE_EXPIRY_SECONDS: Readonly<Record<SourceFamily, number>> = Object.freeze({
  SHARED_SHEET: 600, AICA: 300, IANCAR: 3600, OTHER: 1800,
});
export function sourceSaleAvailable(record: SourceProductRecord, family: SourceFamily, now: number,
  ttl = SOURCE_EXPIRY_SECONDS[family]): boolean {
  if (validateSourceRecord(record).length) return false;
  const at = Date.parse(record.observedAt);
  return record.status.saleAvailable === true &&
    Number.isFinite(now) && Number.isFinite(at) && Number.isFinite(ttl) && ttl > 0 && now >= at && now - at <= ttl * 1000;
}
export const sourceProductKey = (r: Pick<SourceProductRecord, 'sourceId' | 'uid'>) => stableDigest([r.sourceId, r.uid]);
export function validSourceAmount(a: SourceAmount): boolean {
  return !!a && (a.state === 'UNKNOWN' ? a.value === null : a.state === 'ZERO' ? a.value === 0 :
    a.state === 'KNOWN' && Number.isSafeInteger(a.value) && a.value > 0);
}
/** 저장·비교용 압축 레코드. record.raw 와 term.raw 의 큰 값(객체·배열·긴 문자열)은 digest 로 바꾸고 짧은 스칼라만 남긴다.
 * 원천 원문 전체는 문서에 중복 보관하지 않는다(요금 원본이 term.raw·record.raw 에 이중으로 들어가 이안카 문서가 Firestore 1MiB 를
 * 넘은 사고 2026-10-13). 원문이 바뀌면 digest 가 바뀌므로 변경 감지는 그대로이고, 판매 사실(개월·금액·약정거리·상태)은 유지된다. 멱등. */
const SMALL_STRING = 256;
const rawDigestMark = (v: unknown): v is { __digest: string } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { __digest?: unknown }).__digest === 'string';
export function compactRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key] = value === null || typeof value === 'number' || typeof value === 'boolean' ||
      (typeof value === 'string' && value.length <= SMALL_STRING) || rawDigestMark(value)
      ? value : { __digest: stableDigest(value).slice(0, 32) };
  }
  return out;
}
export function compactRecord(record: SourceProductRecord): SourceProductRecord {
  return { ...structuredClone({ ...record, raw: {}, terms: [] }), raw: compactRaw(record.raw ?? {}),
    terms: (record.terms ?? []).map(t => ({ ...structuredClone({ ...t, raw: {} }), raw: compactRaw(t.raw ?? {}) })) };
}
/** 같은 개월에 약정거리 옵션이 여럿인 원천(이안카 ONE)은 (개월, 약정거리)가 항 식별자다. 원천 기록에는 전부 남기고,
 * 개월 키 하나만 갖는 판매 가격 칸에는 대표 항 하나(연 환산 약정거리가 가장 작은 기본 옵션)를 쓴다. 대여료 최저가 선택이 아니다. */
const annualKm = (mileage: string | null): number => {
  const m = /^(\d+)\s*km(?:\/(month|year))?$/.exec((mileage ?? '').trim());
  return m ? Number(m[1]) * (m[2] === 'month' ? 12 : 1) : Number.POSITIVE_INFINITY;
};
export const termIdentity = (t: Pick<SourceTerm, 'months' | 'mileage'>) => `${t.months}|${t.mileage ?? ''}`;
export function representativeTerms<T extends Pick<SourceTerm, 'months' | 'mileage' | 'monthlyRent'>>(terms: readonly T[]): T[] {
  const best = new Map<number, T>();
  for (const t of terms) {
    const cur = best.get(t.months);
    if (!cur) { best.set(t.months, t); continue; }
    const a = annualKm(t.mileage), b = annualKm(cur.mileage);
    if (a < b || (a === b && (t.monthlyRent.value ?? Infinity) < (cur.monthlyRent.value ?? Infinity))) best.set(t.months, t);
  }
  return [...best.values()];
}
/** 판매 가격 칸(`price` 맵). 개월 키 하나에는 대표 항, 같은 개월에 약정거리 옵션이 여럿이면 소비처(ERP5 화면·공개 카탈로그)가 읽는
 * 옵션 키 `{개월}_월{N}km`(월 단위)·`{개월}_연{N}km`(연 단위)도 원천 값으로 함께 쓴다. 옵션 값은 {rent, deposit} 둘이다.
 * 단일 항 원천(공통시트 등)은 옵션 키를 만들지 않아 기존 모양 그대로다. */
export function salePriceMap(terms: readonly SourceTerm[], includeMileage = true): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const t of representativeTerms(terms)) out[String(t.months)] =
    { rent: t.monthlyRent.value, deposit: t.deposit.value, ...(includeMileage ? { mileage: t.mileage } : {}) };
  const perMonth = new Map<number, SourceTerm[]>();
  for (const t of terms) (perMonth.get(t.months) ?? perMonth.set(t.months, []).get(t.months)!).push(t);
  for (const [months, options] of perMonth) {
    if (options.length < 2) continue;
    for (const t of options) {
      const m = /^(\d+)km\/(month|year)$/.exec(t.mileage ?? '');
      if (m) out[`${months}_${m[2] === 'month' ? '월' : '연'}${m[1]}km`] = { rent: t.monthlyRent.value, deposit: t.deposit.value };
    }
  }
  return out;
}
/** Errors are scoped: an invalid term must not obstruct an explicit stop for a known UID. */
export function validateSourceRecord(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['RECORD_SHAPE_INVALID'];
  const r = input as SourceProductRecord;
  const reasons: string[] = [];
  if ((r.plate !== null && (typeof r.plate !== 'string' || !r.plate.trim())) || typeof r.vehicleText !== 'string' ||
    !Array.isArray(r.vehicleHold) || r.vehicleHold.some(x => typeof x !== 'string') ||
    !r.raw || typeof r.raw !== 'object' || Array.isArray(r.raw)) reasons.push('RECORD_SHAPE_INVALID');
  if (typeof r.sourceId !== 'string' || !r.sourceId.trim() || typeof r.uid !== 'string' || !r.uid.trim()) reasons.push('IDENTITY_REQUIRED');
  if (typeof r.observedAt !== 'string' || !Number.isFinite(Date.parse(r.observedAt))) reasons.push('OBSERVATION_INVALID');
  if (!r.status || typeof r.status.raw !== 'string' || !r.status.raw.trim() || ![true, false, null].includes(r.status.saleAvailable) || r.status.saleAvailable === null) reasons.push('STATUS_UNKNOWN');
  if (!Array.isArray(r.terms) || !r.terms.length || r.terms.some(t => !t || !Number.isSafeInteger(t.months) || t.months <= 0 ||
    !validSourceAmount(t.monthlyRent) || !validSourceAmount(t.deposit) || t.monthlyRent.state === 'UNKNOWN' ||
    (t.mileage !== null && typeof t.mileage !== 'string') || !t.raw || typeof t.raw !== 'object' || Array.isArray(t.raw)) ||
    new Set(r.terms.map(termIdentity)).size !== r.terms.length) reasons.push('TERMS_HOLD');
  return reasons;
}
export type SourceHeartbeat = { lastCompleteAt: string | null; lastAttemptAt: string | null; readCount: number; heldCount: number; error: string | null };
/** Read projection of existing source_runs, including failed attempts; no extra collection or head policy. */
export function sourceHeartbeat(sourceId: string, runs: readonly SourceRun[]): SourceHeartbeat {
  const own = runs.filter(r => r.sourceId === sourceId && Number.isFinite(Date.parse(r.startedAt)))
    .slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.runId.localeCompare(b.runId));
  const latest = own[0];
  const complete = own.filter(r => r.status === 'COMPLETED' && r.coverage.completeness === 'COMPLETE' &&
    r.observedAt && Number.isFinite(Date.parse(r.observedAt)))
    .sort((a, b) => Date.parse(b.observedAt!) - Date.parse(a.observedAt!))[0];
  return { lastCompleteAt: complete?.observedAt ?? null, lastAttemptAt: latest?.startedAt ?? null,
    readCount: latest?.rawCount ?? 0, heldCount: latest?.warningCount ?? 0,
    error: latest?.status === 'FAILED' ? 'READ_FAILED' : latest?.coverage.completeness !== 'COMPLETE' && latest ? 'INCOMPLETE' : null };
}
