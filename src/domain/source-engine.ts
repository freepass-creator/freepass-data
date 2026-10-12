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
};
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
    !validSourceAmount(t.monthlyRent) || !validSourceAmount(t.deposit) || t.monthlyRent.state === 'UNKNOWN' || t.deposit.state === 'UNKNOWN' ||
    typeof t.mileage !== 'string' || !t.mileage.trim() || !t.raw || typeof t.raw !== 'object' || Array.isArray(t.raw)) ||
    new Set(r.terms.map(t => t.months)).size !== r.terms.length) reasons.push('TERMS_HOLD');
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
