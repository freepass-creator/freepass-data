/** 공통 시트(F05형)의 차량 사실 칸 후보 → 프리패스 데이터 «기존 칸»에 빈 칸만 채우는 순수 로직(대표 2026-10-23 설계안 승인, 설계안 docs: 비고 F01 칸).
 *  재사용 칸(ERP5 가 이미 읽는 칸): 구동방식 → drive_type(공개 화면), 원산지 → origin(F01). 검증을 통과한 값만 원천 기록에 «후보»(raw.sheet_facts)로 싣고,
 *  쓰기는 문서의 해당 칸이 «비어 있을 때만». 이미 다른 값이 있으면 쓰지 않고 충돌로 센다. 원문(raw.cells)은 그대로 보존된다. */
export const SHEET_FACT_KEYS = ['drive_type', 'origin', 'options', 'consumer_price', 'vehicle_class'];
/** 차량가격(consumer_price, 대표 2026-10-23 승인): 정수 원, 5,000,000~300,000,000. 세금 포함 여부는 단정하지 않고 시트 원문 값 그대로. */
export const CONSUMER_PRICE_MIN = 5_000_000, CONSUMER_PRICE_MAX = 300_000_000;
const DRIVE_VALUES = new Set(['2WD', '4WD', 'AWD', 'FWD', 'RWD']);
const ORIGIN_VALUES = new Set(['국산', '수입']);
/** 옵션은 공개 화면에 그대로 보인다(대표 2026-10-23 설계안·Codex): 무정보 값과 연락처·URL·보증금·수수료·내부 메모 문구는 후보에서 뺀다. 길이 상한 1,000자. */
const OPTIONS_MAX = 1000;
const OPTIONS_NO_INFO = new Set(['', '-', '기본', '없음', '해당없음', 'X', 'N/A', 'NA']);
// 전화번호는 하이픈뿐 아니라 공백·점 구분(010 1234 5678, 010.1234.5678)도 거른다(2026-10-23 Codex 검토: 공백 구분 연락처가 통과했다). 연락처·전화번호 낱말도 거른다.
const OPTIONS_PUBLIC_UNSAFE = /(\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{4})|(https?:\/\/)|(www\.)|@|보증금|수수료|내부|문의|카톡|카카오|계좌|입금|견적|프로모션|연락처|전화번호/i;
const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').normalize('NFKC').replace(/\s+/g, ' ').trim();
/** 차종(vehicle_class, 2026-10-23 손실 칸 조사): 문서의 vehicle_class 는 «크기» 또는 «크기 차체»(예: 중형, 중형 SUV)다. F01 작성기(ERP5공통양식.mjs 차급)가 이 꼴을 크기·차체로 나눠 차종크기·차종구분 칸에 쓴다.
 *  어휘는 그 차급 규칙과 같다. 시트의 «차종크기»·«차종구분» 두 칸에서 만든다. 이 후보 규칙은 «크기» 또는 «크기 차체» 꼴만 만든다(F01 분할기가 그 꼴만 받는다; ERP5 공개 화면은 단독 차체도 받지만
 *  여기서는 만들지 않는다). 그래서 차체(세단·SUV…)만 있고 크기가 없는 행은 후보를 만들지 않는다. */
export const VEHICLE_SIZE_WORDS = ['경형', '소형', '준중형', '중형', '준대형', '대형'];
export const VEHICLE_BODY_WORDS = ['세단', 'SUV', 'MPV', '해치백', '픽업', '쿠페', '왜건', '밴'];
function validVehicleClass(t) {
    const p = t.split(' ');
    if (p.length === 1)
        return VEHICLE_SIZE_WORDS.includes(p[0]) ? t : null;
    return p.length === 2 && VEHICLE_SIZE_WORDS.includes(p[0]) && VEHICLE_BODY_WORDS.includes(p[1]) ? t : null;
}
/** 시트 크기 칸·차체 칸 → 문서 vehicle_class 후보. 둘 다 유효하면 «크기 차체», 크기만 유효하고 차체 칸이 비었으면 «크기». 한쪽이 값이 있는데 어휘 밖이면(오타 «준준형» 등) 추측하지 않고 후보 없음. */
export function composeVehicleClass(sizeCell, bodyCell) {
    const size = text(sizeCell), body = text(bodyCell);
    if (!size || !VEHICLE_SIZE_WORDS.includes(size))
        return null;
    if (!body)
        return size;
    return VEHICLE_BODY_WORDS.includes(body) ? `${size} ${body}` : null;
}
/** 키별 검증: 통과한 정규 값 또는 null. */
export function validSheetFact(key, value) {
    const t = text(value);
    if (!t)
        return null;
    if (key === 'consumer_price') {
        const digits = t.replace(/[,\s원]/g, '');
        if (!/^\d{1,12}$/.test(digits))
            return null;
        const n = Number(digits);
        return n >= CONSUMER_PRICE_MIN && n <= CONSUMER_PRICE_MAX ? n : null;
    }
    if (key === 'drive_type') {
        const u = t.toUpperCase();
        return DRIVE_VALUES.has(u) ? u : null;
    }
    if (key === 'options')
        return typeof value === 'string' && t.length <= OPTIONS_MAX && !OPTIONS_NO_INFO.has(t.toUpperCase()) && !OPTIONS_PUBLIC_UNSAFE.test(t) ? t : null;
    if (key === 'vehicle_class')
        return validVehicleClass(t);
    return ORIGIN_VALUES.has(t) ? t : null;
}
/** 헤더 이름(앞에 있는 것이 우선). 아이카 시트는 «옵션»·«소비자가격» 이라는 이름을 쓴다(공통 시트는 «옵션 원문»·«차량가격»). 차종(vehicle_class)은 두 칸이라 따로 읽는다. */
const SHEET_HEADERS = {
    drive_type: ['구동방식'], origin: ['원산지'], options: ['옵션 원문', '옵션'], consumer_price: ['차량가격', '소비자가격']
};
const headerAt = (headers, names) => {
    for (const name of names) {
        const at = headers.findIndex(h => text(h) === name);
        if (at >= 0)
            return at;
    }
    return -1;
};
/** 헤더 «이름»으로 읽는다(열 위치가 아니다). 검증을 통과한 칸만 담고, 하나도 없으면 undefined. */
export function sheetFactsOf(headers, cells) {
    if (!Array.isArray(headers) || !Array.isArray(cells))
        return undefined;
    const out = {};
    for (const key of SHEET_FACT_KEYS) {
        if (key === 'vehicle_class') {
            const size = headerAt(headers, ['차종크기']);
            if (size < 0)
                continue;
            const body = headerAt(headers, ['차종구분']);
            const v = composeVehicleClass(cells[size], body < 0 ? '' : cells[body]);
            if (v)
                out[key] = v;
            continue;
        }
        const at = headerAt(headers, SHEET_HEADERS[key]);
        if (at < 0)
            continue;
        const v = validSheetFact(key, cells[at]);
        if (v)
            out[key] = v;
    }
    return Object.keys(out).length ? out : undefined;
}
/** 저장된/전달된 raw.sheet_facts 재검증(모양이 틀리거나 값이 검증을 못 통과하면 그 칸은 버린다). */
export function validSheetFacts(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        return undefined;
    const out = {};
    for (const key of SHEET_FACT_KEYS) {
        const x = validSheetFact(key, v[key]);
        if (x)
            out[key] = x;
    }
    return Object.keys(out).length ? out : undefined;
}
/** 문서의 «빈 칸» 정의: 없음·null·빈 문자열(공백만)만. 0·false·[]·다른 값은 빈 칸이 아니다. */
export const isBlankFact = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
/** 문서 현재 값 상태(읽기 경로): 켜진 칸마다 «값 문자열 또는 null(비어 있음)». */
export function sheetFactState(doc, enabled) {
    const out = {};
    // 비문자 값(false·[]·{}·숫자)도 «값 있음»으로 센다(빈 칸이 아니므로 덮지 않고 충돌로 본다).
    for (const key of enabled) {
        // 손오공 API 옵션을 관리하는 문서(api_options_state 있음)는 시트 옵션 대상이 아니다(대표 10-19: 유상 옵션만 표시).
        if (key === 'options' && !isBlankFact(doc.api_options_state))
            continue;
        const v = doc[key];
        out[key] = isBlankFact(v) ? null : (typeof v === 'string' ? text(v) || '(공백 정규화 후 빈 값)' : typeof v === 'number' && Number.isFinite(v) ? String(v) : '(문자열이 아닌 값)');
    }
    return out;
}
/** 계획 판정: 상태와 후보로 채울 칸·충돌 칸. */
export function sheetFactPlan(state, facts, enabled) {
    const fill = [], conflicts = [];
    if (!state || !facts)
        return { fill, conflicts };
    for (const key of enabled) {
        const candidate = facts[key];
        if (!candidate || !(key in state))
            continue;
        if (state[key] === null)
            fill.push(key);
        else if (state[key] !== String(candidate))
            conflicts.push(key);
    }
    return { fill, conflicts };
}
/** 쓰기 칸: 켜진 칸 중 문서가 지금도 비어 있고 후보가 검증을 통과한 칸만(쓰기 시점에 다시 확인). */
export function sheetFactFields(rawFacts, original, enabled, planned) {
    const facts = validSheetFacts(rawFacts);
    const out = {};
    if (!facts)
        return out;
    // planned(계획이 고른 칸)가 있으면 그 칸만 쓴다 — 계획 밖 채움을 막는다.
    for (const key of enabled)
        if (facts[key] && isBlankFact(original[key]) && (!planned || planned.includes(key)))
            out[key] = facts[key];
    return out;
}
