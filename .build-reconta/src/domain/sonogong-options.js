/** 손오공 API 상세 옵션 투영(순수, 읽기 전용). 설계: docs/SONOGONG-OPTIONS-DESIGN-20261016.md (커맨드 센터 2026-10-15 박대표 승인).
 * detail.options = [{ category, name, amount }] 를 «기본(무상)»과 «유상 후보»로 나눈다. 유상 구분의 근거는 API category «선택옵션» 한 가지뿐이며
 * 이름으로 추정하지 않는다. 금액은 원 단위 양의 정수일 때만 KNOWN, 그 외(null·0·음수·비정수)는 UNKNOWN(금액 미확인)으로 두고 원문을 남긴다.
 * 표시 전용: 이 투영은 대여료·보증금·견적 계산에 쓰이지 않는다. 원문 정본은 source_raw 이며 여기서는 이름의 공백·전각 정리만 한다. */
export const PAID_OPTION_CATEGORY = '선택옵션';
/** 무상(기본 포함)으로 확정하는 API category 코드. 이 밖의 구분(누락·오염 포함)은 무상으로 확정하지 않고 UNKNOWN_CATEGORY 로 둔다. */
export const KNOWN_BASIC_CATEGORIES = new Set(['CONVENIENCE', 'INTERIOR', 'SAFETY', 'EXTERIOR', 'MULTIMEDIA']);
export const UNKNOWN_CATEGORY = 'UNKNOWN_CATEGORY';
const clean = (v) => (typeof v === 'string' ? v.normalize('NFKC').replace(/\s+/g, ' ').trim() : '');
const isPositiveWon = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export function projectSonogongOptions(options) {
    const result = { basic: [], paid: [], unclassified: [], notes: { unknownCategory: 0, inputCount: 0, droppedEmptyName: 0, duplicates: 0, amountOnNonPaid: 0, paidAmountUnknown: 0 } };
    if (!Array.isArray(options))
        return result;
    result.notes.inputCount = options.length;
    const seen = new Set();
    for (const entry of options) {
        const item = (entry && typeof entry === 'object' ? entry : {});
        const category = clean(item.category), name = clean(item.name);
        if (!name) {
            result.notes.droppedEmptyName++;
            continue;
        }
        const dedupeKey = `${category}\u0000${name}`;
        if (seen.has(dedupeKey)) {
            result.notes.duplicates++;
            continue;
        }
        seen.add(dedupeKey);
        const amount = item.amount;
        if (category === PAID_OPTION_CATEGORY) {
            const known = isPositiveWon(amount);
            if (!known)
                result.notes.paidAmountUnknown++;
            const raw = typeof amount === 'number' || typeof amount === 'string' ? amount : null;
            result.paid.push({ name, amount_krw: known ? amount : null, amount_state: known ? 'KNOWN' : 'UNKNOWN', amount_raw: raw });
        }
        else {
            if (amount !== null && amount !== undefined)
                result.notes.amountOnNonPaid++;
            const code = category.toUpperCase();
            if (KNOWN_BASIC_CATEGORIES.has(code))
                result.basic.push({ category: code, name });
            else {
                result.unclassified.push({ name });
                result.notes.unknownCategory++;
            }
        }
    }
    return result;
}
/** 여러 상품의 투영을 집계한다(이름·금액 값은 내지 않는다 — 건수와 분포만). */
export function summarizeOptionProjections(projections) {
    const byCategory = {};
    const summary = { unclassifiedTotal: 0, documents: projections.length, documentsWithOptions: 0, basicTotal: 0, paidTotal: 0, paidKnown: 0, paidUnknown: 0,
        documentsWithKnownPaid: 0, amountOnNonPaid: 0, droppedEmptyName: 0, duplicates: 0, byCategory };
    for (const p of projections) {
        if (p.basic.length || p.paid.length || p.unclassified.length)
            summary.documentsWithOptions++;
        summary.unclassifiedTotal += p.unclassified.length;
        summary.basicTotal += p.basic.length;
        summary.paidTotal += p.paid.length;
        const known = p.paid.filter(o => o.amount_state === 'KNOWN').length;
        summary.paidKnown += known;
        summary.paidUnknown += p.paid.length - known;
        if (known)
            summary.documentsWithKnownPaid++;
        summary.amountOnNonPaid += p.notes.amountOnNonPaid;
        summary.droppedEmptyName += p.notes.droppedEmptyName;
        summary.duplicates += p.notes.duplicates;
        for (const o of p.basic)
            byCategory[o.category] = (byCategory[o.category] ?? 0) + 1; // 알려진 코드만 키가 된다
        if (p.unclassified.length)
            byCategory[UNKNOWN_CATEGORY] = (byCategory[UNKNOWN_CATEGORY] ?? 0) + p.unclassified.length;
        if (p.paid.length)
            byCategory[PAID_OPTION_CATEGORY] = (byCategory[PAID_OPTION_CATEGORY] ?? 0) + p.paid.length;
    }
    return summary;
}
/** 문서·기록에 싣는 «분류 후, 크기 제한된» 옵션 꼴(Codex #674). 분류 전 원문 전체(미분류 이름·금액 포함)는 어디에도 저장하지 않는다.
 * 항목 수·이름 길이·직렬화 바이트를 넘으면 TOO_MANY(목록 없음)로 둔다. 판정은 압축 전에 한다(압축이 큰 배열을 digest 로 바꾸기 전). */
export const OPTIONS_MAX_ITEMS = 300, OPTION_NAME_MAX = 120, OPTIONS_MAX_BYTES = 32_768, OPTION_AMOUNT_RAW_STRING_MAX = 40;
const tooMany = () => ({ state: 'TOO_MANY', basic: [], paid: [], unclassified_count: 0 });
const withinBounds = (b) => b.basic.length + b.paid.length <= OPTIONS_MAX_ITEMS &&
    [...b.basic.map(o => o.name), ...b.paid.map(o => o.name)].every(n => n.length > 0 && n.length <= OPTION_NAME_MAX) &&
    Buffer.byteLength(JSON.stringify({ b: b.basic, p: b.paid }), 'utf8') <= OPTIONS_MAX_BYTES;
/** 상세 options 원문 → 제한된 분류 꼴. 배열이 아니면 null(모르는 값). */
export function boundedOptions(options) {
    if (!Array.isArray(options))
        return null;
    if (options.length > OPTIONS_MAX_ITEMS)
        return tooMany();
    const p = projectSonogongOptions(options);
    const paid = p.paid.map(o => ({ ...o, amount_raw: typeof o.amount_raw === 'string' && o.amount_raw.length > OPTION_AMOUNT_RAW_STRING_MAX ? null : o.amount_raw }));
    const result = { state: p.basic.length + paid.length ? 'PRESENT' : 'NONE', basic: p.basic, paid, unclassified_count: p.unclassified.length };
    return withinBounds(result) ? result : tooMany();
}
/** 저장된 제한 꼴(raw.api_options)을 다시 읽을 때의 검증: 모양이 맞고 제한 안일 때만 통과(아니면 null). */
export function asBoundedOptions(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        return null;
    const o = v;
    if (o.state !== 'PRESENT' && o.state !== 'NONE' && o.state !== 'TOO_MANY')
        return null;
    if (!Array.isArray(o.basic) || !Array.isArray(o.paid) || o.basic.length + o.paid.length > OPTIONS_MAX_ITEMS)
        return null;
    const str = (x) => typeof x === 'string' && x.length > 0 && x.length <= OPTION_NAME_MAX;
    const basic = [], paid = [];
    for (const x of o.basic) {
        const e = x;
        if (!e || !str(e.name) || typeof e.category !== 'string' || e.category.length > 40)
            return null;
        basic.push({ category: e.category, name: e.name });
    }
    for (const x of o.paid) {
        const e = x;
        if (!e || !str(e.name) || (e.amount_state !== 'KNOWN' && e.amount_state !== 'UNKNOWN'))
            return null;
        const krw = typeof e.amount_krw === 'number' && Number.isSafeInteger(e.amount_krw) && e.amount_krw > 0 ? e.amount_krw : null;
        if ((e.amount_state === 'KNOWN') !== (krw !== null))
            return null;
        const raw = typeof e.amount_raw === 'number' ? e.amount_raw : typeof e.amount_raw === 'string' && e.amount_raw.length <= OPTION_AMOUNT_RAW_STRING_MAX ? e.amount_raw : null;
        paid.push({ name: e.name, amount_krw: krw, amount_state: e.amount_state, amount_raw: raw });
    }
    const count = typeof o.unclassified_count === 'number' && Number.isSafeInteger(o.unclassified_count) && o.unclassified_count >= 0 ? o.unclassified_count : 0;
    const result = { state: o.state, basic, paid, unclassified_count: count };
    return withinBounds(result) ? result : null;
}
