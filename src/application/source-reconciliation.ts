/** 원천 ↔ ERP5 정합 보고(대표 2026-10-14: «대수가 같아도 같다고 판단하지 않는다 — 차량 키 집합을 비교한다»).
 * 판매 가능 정의: 원천 = 읽은 레코드 중 status.saleAvailable === true(원천별 상태 해석은 어댑터가 이미 끝냄),
 * ERP5 = 노출(listable) 문서. 키 = 차량번호, 번호 없는 월렌트는 UID(sourceProductKey).
 * 번호는 끝 4자리만 내보낸다. 읽기 전용 — 쓰기 0. */
import { sourceProductKey, compactRecord, type SourceProductRecord } from '../domain/source-engine.js';
import { stableDigest } from '../shared/stable-digest.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import type { CycleProduct } from '../ports/source-cycle.js';

const clocks = ['observedAt', 'captured_at', 'synced_at'];
const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => !clocks.includes(k)).map(([k, c]) => [k, strip(c)])) : v;
const facts = (r: SourceProductRecord) => stableDigest(strip(compactRecord(r)));
const last4 = (r: SourceProductRecord) => (r.plate ?? r.uid).replace(/\D/g, '').slice(-4) || 'NONE';
const LIST_LIMIT = 50;

export type SourceReconciliation = {
  /** 판매 가능 정의를 보고서에 명시한다. */
  definition: { source: 'saleAvailable===true'; erp: 'listable'; key: 'plate|uid' };
  sourceSellable: number; erpSellable: number; same: number;
  /** 원천에만 있는 판매 가능 차(ERP5 에 문서가 없거나 노출이 아님). 문서가 있고 비노출이면 newHasDoc 에 따로 센다. */
  newCount: number; newHasDoc: number; newLast4: string[];
  /** ERP5 에만 노출된 차(원천에 없거나 판매 불가). */
  missingCount: number; missingLast4: string[];
  /** 양쪽 판매 가능인데 값(가격·상태·구분)이 다른 차. */
  mismatchCount: number; mismatchLast4: string[];
  /** 일치 = 집합 비교가 0·0 이고 값 불일치도 0 일 때만 true(대수 일치만으로는 일치가 아니다). */
  matched: boolean; countEqual: boolean;
};

/** 차량 키: 번호가 있으면 번호(같은 차가 다른 UID 로 읽혀도 한 대), 없으면(번호 없는 월렌트) UID. 독립 검토: UID 키만 쓰면 UID 연결 대상이 NEW+MISSING 으로 나온다. */
const keyOf = (r: SourceProductRecord) => r.plate && isAssignedPlate(r.plate) ? `P:${plateIdentityKey(r.plate)}` : `U:${sourceProductKey(r)}`;

export function reconcileSource(records: readonly SourceProductRecord[], products: readonly CycleProduct[]): SourceReconciliation {
  const source = new Map<string, SourceProductRecord>();
  for (const r of records) if (r.status.saleAvailable === true) source.set(keyOf(r), r);
  const docs = new Map(products.map(p => [keyOf(p.record), p]));
  const erp = new Map([...docs].filter(([, p]) => p.listable));
  const sameKeys = [...source.keys()].filter(k => erp.has(k));
  const newKeys = [...source.keys()].filter(k => !erp.has(k)).sort();
  const missingKeys = [...erp.keys()].filter(k => !source.has(k)).sort();
  const mismatchKeys = sameKeys.filter(k => facts(source.get(k)!) !== facts(erp.get(k)!.record)).sort();
  const cut = (keys: string[], pick: (k: string) => SourceProductRecord) => keys.slice(0, LIST_LIMIT).map(k => last4(pick(k)));
  return {
    definition: { source: 'saleAvailable===true', erp: 'listable', key: 'plate|uid' },
    sourceSellable: source.size, erpSellable: erp.size, same: sameKeys.length,
    newCount: newKeys.length, newHasDoc: newKeys.filter(k => docs.has(k)).length, newLast4: cut(newKeys, k => source.get(k)!),
    missingCount: missingKeys.length, missingLast4: cut(missingKeys, k => erp.get(k)!.record),
    mismatchCount: mismatchKeys.length, mismatchLast4: cut(mismatchKeys, k => erp.get(k)!.record),
    matched: newKeys.length === 0 && missingKeys.length === 0 && mismatchKeys.length === 0,
    countEqual: source.size === erp.size,
  };
}
