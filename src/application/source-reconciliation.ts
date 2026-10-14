/** 원천 ↔ ERP5 정합 보고(대표 2026-10-14: «대수가 같아도 같다고 판단하지 않는다 — 차량 키 집합을 비교한다»).
 * 판매 가능 정의: 원천 = 읽은 레코드 중 status.saleAvailable === true(원천별 상태 해석은 어댑터가 이미 끝냄),
 * ERP5 = 노출(listable) 문서. 키 = 차량번호, 번호 없는 월렌트는 UID(sourceProductKey).
 * 번호는 끝 4자리만 내보낸다. 읽기 전용 — 쓰기 0. */
import { sourceProductKey, termIdentity, type SourceProductRecord } from '../domain/source-engine.js';
import { stableDigest } from '../shared/stable-digest.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import type { CycleProduct } from '../ports/source-cycle.js';

/** 비교용 정규화: 차량 키·UID·원문(raw)·관측 시각은 빼고 «업무 값»만 본다(상태, 차명, 상품구분, 기간별 대여료·보증금(타입 값)·약정거리). 독립 검토 2026-10-14. */
const facts = (r: SourceProductRecord) => stableDigest({ status: { raw: String(r.status.raw ?? "").trim(), sale: r.status.saleAvailable },
  vehicle: String(r.vehicleText ?? "").replace(/\s+/g, ' ').trim(), group: r.raw?.product_group ?? null,
  terms: r.terms.map(t => [t.months, t.mileage ?? null, t.monthlyRent.state, t.monthlyRent.value ?? null, t.deposit.state, t.deposit.value ?? null]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1) });
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
  /** MISSING 중 계약 잠금(locked_by_contract·계약중) 문서 수 — 정책상 원천 값으로 내리지 않는 정당 보류(인도완료·취소를 추정하지 않는다). */
  missingLockedCount: number;
  /** 잠금 보류를 제외하고 NEW·MISSING·값 불일치가 모두 0 인지. matched 는 잠금도 차이로 센 엄격 판정이다. */
  matchedExceptLocked: boolean;
  /** 양쪽 판매 가능인데 값(가격·상태·구분)이 다른 차. */
  mismatchCount: number; mismatchLast4: string[];
  /** 일치 = 집합 비교가 0·0 이고 값 불일치도 0 일 때만 true(대수 일치만으로는 일치가 아니다). */
  matched: boolean; countEqual: boolean;
  /** 같은 번호로 문서가 둘 이상인 차량 수(충돌). 있으면 matched 는 false 다. */
  duplicateDocCount: number;
  /** 계약 잠금 문서라 원천 값과 달라도 정책상 잠금이 이기는 차량 수(값 불일치에서 제외). */
  lockOverrideCount: number;
  /** 등록 기준 지표(커맨드 센터 2026-10-14): 노출 제외로 편입된 차는 NEW 가 아니라 등록으로 센다. registeredMatched = 순수 NEW(문서 없음)가 0. */
  registeredCount: number; exposedCount: number; infoIncompleteCount: number; pureNewCount: number; registeredMatched: boolean;
  /** 보고 4번째 칸(커맨드 센터 2026-10-14): 원천이 판매 불가로 읽었지만 «1차로 가져와» 비노출 문서로 편입된 수. 판매 가능 대수 기준에는 들어가지 않는다. */
  notSellableEnrolledCount: number;
  /** 5칸 지표: 원천 출고가능(계약중 제외 판매 가능) / 출고가능 노출(잠금·계약중 제외 노출) / 계약중·잠금 표시 노출 / dispatchableGap = 앞 둘의 차(0 이면 «대수 = 원천 판매 가능»). */
  sourceDispatchableCount: number; dispatchableExposedCount: number; contractMarkedExposedCount: number; dispatchableGap: number;
  /** dispatchableGap 의 사유 분해(커맨드 센터 2026-10-14 «gap≠0 사유 코드»). 양수 = 원천 출고가능인데 출고가능 노출이 아닌 차, 음수 = 그 반대.
   * 합(양수 사유 − 음수 사유) = dispatchableGap 이 항상 성립한다(dispatchGapExplained). 0 인 사유는 싣지 않는다. */
  dispatchGapReasons: Partial<Record<DispatchGapReason, number>>; dispatchGapExplained: boolean;
};
/** SOURCE_ONLY_* 는 gap 을 늘리고(+) ERP_ONLY_* 는 줄인다(−). WITHDRAWN 은 비노출 사유(publication_withdrawal.reason)별로 나눈다. */
export type DispatchGapReason =
  | 'SOURCE_ONLY_NO_DOC'                 // 원천 출고가능, 문서 없음(다음 편입 대상·회차 상한)
  | 'SOURCE_ONLY_INFO_INCOMPLETE'        // 문서는 있으나 정보 부족 비노출(승격 대기)
  | 'SOURCE_ONLY_NOT_SELLABLE_STALE'     // 문서가 «원천 판매 불가» 비노출로 남음(이번 원천은 판매 가능 — 다음 회차 재노출 대상)
  | 'SOURCE_ONLY_WITHDRAWN_OTHER'        // 그 밖의 철회 표식으로 비노출
  | 'SOURCE_ONLY_NOT_LISTABLE'           // 철회 표식 없이 비노출
  | 'SOURCE_ONLY_LOCKED_EXPOSED'         // 노출이지만 계약 잠금 문서(계약중 표시 칸으로 감)
  | 'ERP_ONLY_NOT_IN_SOURCE'             // 출고가능 노출인데 원천 판매 가능 목록에 없음(하향 대상 — 완전 읽기에서만 하향)
  | 'ERP_ONLY_SOURCE_CONTRACT';          // 출고가능 노출인데 원천은 계약중(계약중 표시로 바뀌어야 함)

/** 계획 단계와 같은 규칙: 원천 보증금이 UNKNOWN 이면 문서의 KNOWN/ZERO 보증금을 보존한다 — 이 경우는 값 불일치가 아니다
 * (B3Q 실측 2026-10-14: RP018 9·RP013 2 가 DEPOSIT_PRESERVED 건수와 같았다). */
const withPreservedDeposit = (source: SourceProductRecord, doc: SourceProductRecord): SourceProductRecord => {
  const terms = source.terms.map(term => {
    if (term.deposit.state !== 'UNKNOWN') return term;
    const same = doc.terms.filter(p => termIdentity(p) === termIdentity(term));
    const prior = same[0] ?? (doc.terms.filter(p => p.months === term.months).length === 1 ? doc.terms.find(p => p.months === term.months) : undefined);
    return prior && (prior.deposit.state === 'KNOWN' || prior.deposit.state === 'ZERO') ? { ...term, deposit: structuredClone(prior.deposit) } : term;
  });
  return { ...source, terms };
};

const isLocked = (p: CycleProduct) => p.locked_by_contract === true || p.record.status.raw === '계약중';

/** 차량 키: 번호가 있으면 번호(같은 차가 다른 UID 로 읽혀도 한 대), 없으면(번호 없는 월렌트) UID. 독립 검토: UID 키만 쓰면 UID 연결 대상이 NEW+MISSING 으로 나온다. */
const keyOf = (r: SourceProductRecord) => r.plate && isAssignedPlate(r.plate) ? `P:${plateIdentityKey(r.plate)}` : `U:${sourceProductKey(r)}`;

function dispatchGapReasons(source: Map<string, SourceProductRecord>, docs: Map<string, CycleProduct>) {
  const reasons: Partial<Record<DispatchGapReason, number>> = {};
  const add = (reason: DispatchGapReason) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  const contract = (r: SourceProductRecord) => r.status.raw.trim() === '계약중';
  for (const [key, r] of source) {
    if (contract(r)) continue;
    const doc = docs.get(key);
    if (!doc) add('SOURCE_ONLY_NO_DOC');
    else if (doc.listable) { if (isLocked(doc)) add('SOURCE_ONLY_LOCKED_EXPOSED'); }
    else {
      const reason = doc.publication_withdrawal?.reason;
      add(reason === 'INFO_INCOMPLETE' ? 'SOURCE_ONLY_INFO_INCOMPLETE' : reason === 'SOURCE_NOT_SELLABLE' ? 'SOURCE_ONLY_NOT_SELLABLE_STALE'
        : reason ? 'SOURCE_ONLY_WITHDRAWN_OTHER' : 'SOURCE_ONLY_NOT_LISTABLE');
    }
  }
  for (const [key, doc] of docs) {
    if (!doc.listable || isLocked(doc)) continue;
    const r = source.get(key);
    if (!r) add('ERP_ONLY_NOT_IN_SOURCE');
    else if (contract(r)) add('ERP_ONLY_SOURCE_CONTRACT');
  }
  return reasons;
}
const gapFromReasons = (reasons: Partial<Record<DispatchGapReason, number>>) =>
  Object.entries(reasons).reduce((sum, [k, n]) => sum + (k.startsWith('ERP_ONLY_') ? -n! : n!), 0);

export function reconcileSource(records: readonly SourceProductRecord[], products: readonly CycleProduct[]): SourceReconciliation {
  const source = new Map<string, SourceProductRecord>();
  for (const r of records) if (r.status.saleAvailable === true) source.set(keyOf(r), r);
  // 같은 번호의 문서가 둘 이상이면 배열 순서와 무관하게 고른다: 노출 문서 우선, 그다음 UID 사전순. 중복은 충돌로 따로 센다(독립 검토 2026-10-14).
  const groups = new Map<string, CycleProduct[]>();
  for (const p of products) (groups.get(keyOf(p.record)) ?? groups.set(keyOf(p.record), []).get(keyOf(p.record))!).push(p);
  const duplicateKeys = [...groups].filter(([, g]) => g.length > 1).map(([k]) => k).sort();
  const docs = new Map([...groups].map(([k, g]) => [k, [...g].sort((a, b) => Number(b.listable) - Number(a.listable) ||
    (a.record.uid < b.record.uid ? -1 : a.record.uid > b.record.uid ? 1 : 0))[0]!]));
  const erp = new Map([...docs].filter(([, p]) => p.listable));
  const sameKeys = [...source.keys()].filter(k => erp.has(k));
  const newKeys = [...source.keys()].filter(k => !erp.has(k)).sort();
  const missingKeys = [...erp.keys()].filter(k => !source.has(k)).sort();
  const differing = sameKeys.filter(k => facts(withPreservedDeposit(source.get(k)!, erp.get(k)!.record)) !== facts(erp.get(k)!.record)).sort();
  // 계약 잠금(장부)이 원천 «게시»보다 우선하는 정책(B3Q RP023 5087 실측): 잠금 문서의 차이는 값 불일치가 아니라 «잠금 우선»으로 따로 센다.
  const mismatchKeys = differing.filter(k => !isLocked(erp.get(k)!));
  const lockOverrideKeys = differing.filter(k => isLocked(erp.get(k)!));
  const cut = (keys: string[], pick: (k: string) => SourceProductRecord) => keys.slice(0, LIST_LIMIT).map(k => last4(pick(k)));
  return {
    definition: { source: 'saleAvailable===true', erp: 'listable', key: 'plate|uid' },
    sourceSellable: source.size, erpSellable: erp.size, same: sameKeys.length,
    newCount: newKeys.length, newHasDoc: newKeys.filter(k => docs.has(k)).length, newLast4: cut(newKeys, k => source.get(k)!),
    missingCount: missingKeys.length, missingLast4: cut(missingKeys, k => erp.get(k)!.record),
    missingLockedCount: missingKeys.filter(k => isLocked(erp.get(k)!)).length,
    matchedExceptLocked: newKeys.length === 0 && mismatchKeys.length === 0 && missingKeys.every(k => isLocked(erp.get(k)!)),
    mismatchCount: mismatchKeys.length, mismatchLast4: cut(mismatchKeys, k => erp.get(k)!.record),
    duplicateDocCount: duplicateKeys.length,
    lockOverrideCount: lockOverrideKeys.length,
    matched: newKeys.length === 0 && missingKeys.length === 0 && mismatchKeys.length === 0 && duplicateKeys.length === 0,
    // 대표 보고 형식 «등록 N·노출 N·정보 부족 N»: 등록 = 원천 판매 가능 중 문서가 있는 차, 노출 = 그중 노출 중, 정보 부족 = 번호만 편입한 비노출.
    registeredCount: [...source.keys()].filter(k => docs.has(k)).length,
    exposedCount: sameKeys.length,
    infoIncompleteCount: [...source.keys()].filter(k => docs.get(k)?.publication_withdrawal?.reason === 'INFO_INCOMPLETE').length,
    notSellableEnrolledCount: [...docs.values()].filter(p => !p.listable && p.publication_withdrawal?.reason === 'SOURCE_NOT_SELLABLE').length,
    pureNewCount: newKeys.filter(k => !docs.has(k)).length,
    registeredMatched: newKeys.every(k => docs.has(k)),
    countEqual: source.size === erp.size,
    // 5칸 지표(대표 기준 «대수 = 원천 판매 가능», 커맨드 센터 2026-10-14): 계약중·잠금 표시 노출은 별도 칸으로 빼고 «출고가능 노출»과 «원천 출고가능»을 비교한다.
    sourceDispatchableCount: [...source.values()].filter(r => r.status.raw.trim() !== '계약중').length,
    dispatchableExposedCount: [...erp.values()].filter(p => !isLocked(p)).length,
    contractMarkedExposedCount: [...erp.values()].filter(p => isLocked(p)).length,
    dispatchableGap: [...source.values()].filter(r => r.status.raw.trim() !== '계약중').length - [...erp.values()].filter(p => !isLocked(p)).length,
    ...(() => {
      const reasons = dispatchGapReasons(source, docs);
      const gap = [...source.values()].filter(r => r.status.raw.trim() !== '계약중').length - [...erp.values()].filter(p => !isLocked(p)).length;
      return { dispatchGapReasons: reasons, dispatchGapExplained: gapFromReasons(reasons) === gap };
    })(),
  };
}
