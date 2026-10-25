/** 원천 ↔ ERP5 정합 보고(대표 2026-10-14: «대수가 같아도 같다고 판단하지 않는다 — 차량 키 집합을 비교한다»).
 * 판매 가능 정의: 원천 = 읽은 레코드 중 status.saleAvailable === true(원천별 상태 해석은 어댑터가 이미 끝냄),
 * ERP5 = 노출(listable) 문서. 키 = 차량번호, 번호 없는 월렌트는 UID(sourceProductKey).
 * 번호는 끝 4자리만 내보낸다. 읽기 전용 — 쓰기 0. */
import { sourceProductKey, termIdentity } from '../domain/source-engine.js';
import { stableDigest } from '../shared/stable-digest.js';
import { preservedDepositOf } from '../domain/supplier-deposit-policy.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
/** 비교용 정규화: 차량 키·UID·원문(raw)·관측 시각은 빼고 «업무 값»만 본다(상태, 차명, 상품구분, 기간별 대여료·보증금(타입 값)·약정거리). 독립 검토 2026-10-14. */
const facts = (r) => stableDigest({ status: { raw: String(r.status.raw ?? "").trim(), sale: r.status.saleAvailable },
    vehicle: String(r.vehicleText ?? "").replace(/\s+/g, ' ').trim(), group: r.raw?.product_group ?? null,
    terms: r.terms.map(t => [t.months, t.mileage ?? null, t.monthlyRent.state, t.monthlyRent.value ?? null, t.deposit.state, t.deposit.value ?? null]).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1) });
const last4 = (r) => (r.plate ?? r.uid).replace(/\D/g, '').slice(-4) || 'NONE';
const LIST_LIMIT = 50;
/** 계획 단계와 같은 규칙: 원천 보증금이 UNKNOWN 이면 문서의 KNOWN/ZERO 보증금을 보존한다 — 이 경우는 값 불일치가 아니다
 * (B3Q 실측 2026-10-14: RP018 9·RP013 2 가 DEPOSIT_PRESERVED 건수와 같았다). */
const withPreservedDeposit = (source, doc) => {
    const terms = source.terms.map(term => {
        if (term.deposit.state !== 'UNKNOWN')
            return term;
        const same = doc.terms.filter(p => termIdentity(p) === termIdentity(term));
        const prior = same[0] ?? (doc.terms.filter(p => p.months === term.months).length === 1 ? doc.terms.find(p => p.months === term.months) : undefined);
        const kept = prior ? preservedDepositOf(source.sourceId, prior) : null; // 계획 단계와 같은 함수(자리채움 0 공급사의 옛 ZERO 는 보존 안 함)
        return kept ? { ...term, deposit: kept.deposit } : term;
    });
    return { ...source, terms };
};
const isLocked = (p) => p.locked_by_contract === true || p.record.status.raw === '계약중';
/** 차량 키: 번호가 있으면 번호(같은 차가 다른 UID 로 읽혀도 한 대), 없으면(번호 없는 월렌트) UID. 독립 검토: UID 키만 쓰면 UID 연결 대상이 NEW+MISSING 으로 나온다. */
const keyOf = (r) => r.plate && isAssignedPlate(r.plate) ? `P:${plateIdentityKey(r.plate)}` : `U:${sourceProductKey(r)}`;
function dispatchGapReasons(source, docs) {
    const reasons = {};
    const add = (reason) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
    const contract = (r) => r.status.raw.trim() === '계약중';
    for (const [key, r] of source) {
        if (contract(r))
            continue;
        const doc = docs.get(key);
        if (!doc)
            add('SOURCE_ONLY_NO_DOC');
        else if (doc.listable) {
            if (isLocked(doc))
                add('SOURCE_ONLY_LOCKED_EXPOSED');
        }
        else {
            const reason = doc.publication_withdrawal?.reason;
            add(reason === 'INFO_INCOMPLETE' ? 'SOURCE_ONLY_INFO_INCOMPLETE' : reason === 'SOURCE_NOT_SELLABLE' ? 'SOURCE_ONLY_NOT_SELLABLE_STALE'
                : reason ? 'SOURCE_ONLY_WITHDRAWN_OTHER' : 'SOURCE_ONLY_NOT_LISTABLE');
        }
    }
    for (const [key, doc] of docs) {
        if (!doc.listable || isLocked(doc))
            continue;
        const r = source.get(key);
        if (!r)
            add('ERP_ONLY_NOT_IN_SOURCE');
        else if (contract(r))
            add('ERP_ONLY_SOURCE_CONTRACT');
    }
    return reasons;
}
const gapFromReasons = (reasons) => Object.entries(reasons).reduce((sum, [k, n]) => sum + (k.startsWith('ERP_ONLY_') ? -n : n), 0);
export function reconcileSource(records, products) {
    const source = new Map();
    for (const r of records)
        if (r.status.saleAvailable === true)
            source.set(keyOf(r), r);
    // 같은 번호의 문서가 둘 이상이면 배열 순서와 무관하게 고른다: 노출 문서 우선, 그다음 UID 사전순. 중복은 충돌로 따로 센다(독립 검토 2026-10-14).
    const groups = new Map();
    for (const p of products)
        (groups.get(keyOf(p.record)) ?? groups.set(keyOf(p.record), []).get(keyOf(p.record))).push(p);
    const duplicateKeys = [...groups].filter(([, g]) => g.length > 1).map(([k]) => k).sort();
    const docs = new Map([...groups].map(([k, g]) => [k, [...g].sort((a, b) => Number(b.listable) - Number(a.listable) ||
            (a.record.uid < b.record.uid ? -1 : a.record.uid > b.record.uid ? 1 : 0))[0]]));
    const erp = new Map([...docs].filter(([, p]) => p.listable));
    const sameKeys = [...source.keys()].filter(k => erp.has(k));
    const newKeys = [...source.keys()].filter(k => !erp.has(k)).sort();
    const missingKeys = [...erp.keys()].filter(k => !source.has(k)).sort();
    const differing = sameKeys.filter(k => facts(withPreservedDeposit(source.get(k), erp.get(k).record)) !== facts(erp.get(k).record)).sort();
    // 계약 잠금(장부)이 원천 «게시»보다 우선하는 정책(B3Q RP023 5087 실측): 잠금 문서의 차이는 값 불일치가 아니라 «잠금 우선»으로 따로 센다.
    const mismatchKeys = differing.filter(k => !isLocked(erp.get(k)));
    const lockOverrideKeys = differing.filter(k => isLocked(erp.get(k)));
    const cut = (keys, pick) => keys.slice(0, LIST_LIMIT).map(k => last4(pick(k)));
    return {
        definition: { source: 'saleAvailable===true', erp: 'listable', key: 'plate|uid' },
        sourceSellable: source.size, erpSellable: erp.size, same: sameKeys.length,
        newCount: newKeys.length, newHasDoc: newKeys.filter(k => docs.has(k)).length, newLast4: cut(newKeys, k => source.get(k)),
        missingCount: missingKeys.length, missingLast4: cut(missingKeys, k => erp.get(k).record),
        missingLockedCount: missingKeys.filter(k => isLocked(erp.get(k))).length,
        matchedExceptLocked: newKeys.length === 0 && mismatchKeys.length === 0 && missingKeys.every(k => isLocked(erp.get(k))),
        mismatchCount: mismatchKeys.length, mismatchLast4: cut(mismatchKeys, k => erp.get(k).record),
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
