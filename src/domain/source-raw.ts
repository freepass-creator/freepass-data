/** 원천 원문 계층(source_raw) 순수 규칙. 대표 2026-10-14: «프리패스 데이터에는 일단 원문을 다 끌고 와서 모은다 — 막히는 거 없이».
 * 저장은 판정·마스터·가격·상태·잠금 게이트에 걸리지 않는다. 개인정보 마스킹만 저장 전에 한다. */
import { stableDigest } from '../shared/stable-digest.js';
import type { SourceProductRecord } from './source-engine.js';

const PHONE = /(?:\+?82[-.\s]?)?0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}/g;
const LONG_DIGITS = /\d{9,}/g;                   // 주민번호·계좌·카드·전화(하이픈 없음) 모양. 금액(예: 1,000,000)·차량번호(4자리)는 해당 없음.
const RRN = /\d{6}[-\s]?[1-4]\d{6}/g;
const MAX_STRING = 4000;
const MAX_DEPTH = 6;

/** 값 안의 개인정보 모양(전화·주민번호·긴 숫자열)을 «***» 로 바꾼다. 문자열은 4000자로 자른다. 객체·배열은 재귀(깊이 6). */
export function maskPersonal(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    const clipped = value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
    return clipped.replace(RRN, '***').replace(PHONE, '***').replace(LONG_DIGITS, '***');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 400).map(v => maskPersonal(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 400).map(([k, v]) => [k, maskPersonal(v, depth + 1)]));
  }
  return null;
}

export type RawEntry = {
  key: string; kind: 'RECORD' | 'HELD'; sourceId: string; plate: string | null; uid: string | null; vehicleText: string;
  statusRaw: string | null; saleAvailable: boolean | null; terms: Array<{ months: number; rent: number | null; depositState: string; mileage: string | null }>;
  raw: unknown; heldReasons: string[]; rawDigest: string;
};

/** 레코드 키: «원천__차량번호», 번호가 없으면 «원천__UID», 그것도 없으면 «원천__행해시». */
export const rawKeyOf = (sourceId: string, record: Pick<SourceProductRecord, 'plate' | 'uid' | 'raw'>): string => {
  const id = (record.plate && record.plate.trim()) || (record.uid && record.uid.trim()) ||
    'row-' + stableDigest([record.raw?.source_tab ?? null, record.raw?.source_row ?? null, record.raw?.headers ?? null]).slice(0, 16);
  return `${sourceId}__${id}`;
};

export function rawEntryOfRecord(sourceId: string, r: SourceProductRecord): RawEntry {
  const raw = maskPersonal(r.raw);
  const terms = r.terms.map(t => ({ months: t.months, rent: t.monthlyRent.state === 'KNOWN' || t.monthlyRent.state === 'ZERO' ? t.monthlyRent.value : null,
    depositState: t.deposit.state, mileage: t.mileage }));
  const base = { vehicleText: String(maskPersonal(r.vehicleText) ?? ''), statusRaw: r.status.raw ?? null, saleAvailable: r.status.saleAvailable, terms, raw };
  return { key: rawKeyOf(sourceId, r), kind: 'RECORD', sourceId, plate: r.plate ?? null, uid: r.uid || null, ...base, heldReasons: [],
    rawDigest: stableDigest(base).slice(0, 32) };
}

/** 번호·UID 를 못 만든 보류 행도 «행 번호 + 사유» 로 남긴다(행 내용은 원천 어댑터가 레코드로 만들지 못한 것이라 사유만). */
export function rawEntryOfHeld(sourceId: string, held: { row: number; reasons: string[] }): RawEntry {
  const reasons = held.reasons.map(r => String(maskPersonal(r)).slice(0, 120)).slice(0, 12);
  const key = `${sourceId}__held-${held.row}-${stableDigest([sourceId, held.row, reasons]).slice(0, 8)}`;
  return { key, kind: 'HELD', sourceId, plate: null, uid: null, vehicleText: '', statusRaw: null, saleAvailable: null, terms: [], raw: { row: held.row },
    heldReasons: reasons, rawDigest: stableDigest({ row: held.row, reasons }).slice(0, 32) };
}
