/** 이안카(ONE) 상품의 «기간만 있는 별칭 키»(예 "60")를 찾는다.
 * ONE 은 기간×약정 주행(월 2,000/3,000/4,000km, 연 20,000/30,000/40,000km) 24조건을 주고, Data 는 기존 소비처 호환을 위해
 * 이안카 기본 조건(대표 정책 10-12: 만 26세 이상·연 20,000km 기본, 1~5개월은 월 2,000km)에 해당하는 구간의 값을 복사한 별칭 키를
 * `price` 에 함께 둔다(`iancar_phase_one.priceAliases`: "60" → "60:20000:year"). «최저 구간 추정»이 아니라 대표가 정한 기본 조건 기준이다.
 * 이 별칭은 조건이 아니라 같은 조건의 복사본이라 «조건 목록»을 만드는 곳(참고 출력·정리값 조건)에서는 빼야 중복 행·빈 주행 칸이 생기지 않는다.
 * 안전: 별칭이 가리키는 원본 키가 있고 월 대여료·보증금이 같을 때만 별칭으로 본다(값이 다르면 별칭이 아니라 별개 조건으로 남긴다). */
import { SOURCE_ENGINE_WRITER } from './deposit-evidence.js';
import { representativeTerms } from './source-engine.js';
const isRec = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** 원천 엔진이 쓴 이안카 문서: 개월 키는 엔진 판매 가격 칸의 대표 항(representativeTerms)이 가리키는 옵션 키의 별칭이다.
 * 엔진 문서가 아니면 undefined(옛 iancar_phase_one.priceAliases 로 내려간다). */
function engineAliasTargets(product) {
    const mark = product.source_cycle_write, record = product.source_cycle_record;
    if (product.provider_company_code !== 'RP031' || !isRec(mark) || mark.by !== SOURCE_ENGINE_WRITER
        || !isRec(record) || !Array.isArray(record.terms))
        return undefined;
    const terms = record.terms.filter((t) => isRec(t) && Number.isSafeInteger(t.months) && (t.mileage === null || typeof t.mileage === 'string') && isRec(t.monthlyRent));
    const out = {};
    for (const t of representativeTerms(terms)) {
        const m = /^(\d+)km\/(month|year)$/.exec(t.mileage ?? '');
        if (m)
            out[String(t.months)] = `${t.months}_${m[2] === 'month' ? '월' : '연'}${m[1]}km`;
    }
    return out;
}
export function iancarPriceAliasKeys(product) {
    const result = new Set();
    const price = product?.price;
    const phase = product?.iancar_phase_one;
    const aliases = (product ? engineAliasTargets(product) : undefined) ?? (isRec(phase) ? phase.priceAliases : undefined);
    if (!isRec(price) || !isRec(aliases))
        return result;
    for (const [alias, target] of Object.entries(aliases)) {
        if (typeof target !== 'string' || alias === target)
            continue;
        // 별칭 값은 ONE 조건 키("60:20000:year" = 기간:주행:구분)이거나 price 키 자체일 수 있다.
        const parts = /^([0-9]+):([0-9]+):(year|month)$/.exec(target);
        const targetKey = parts ? `${parts[1]}_${parts[3] === 'year' ? '연' : '월'}${parts[2]}km` : target;
        const a = price[alias], t = price[targetKey];
        if (isRec(a) && isRec(t) && a.rent === t.rent && a.deposit === t.deposit)
            result.add(alias);
    }
    return result;
}
/** 별칭 키를 뺀 `price` 사본(별칭이 없으면 같은 객체). */
export function priceWithoutIancarAliases(product) {
    const price = product.price;
    if (!isRec(price))
        return {};
    const aliases = iancarPriceAliasKeys(product);
    return aliases.size ? Object.fromEntries(Object.entries(price).filter(([key]) => !aliases.has(key))) : price;
}
