import { describe, expect, it } from 'vitest';
import { iancarPriceAliasKeys, priceWithoutIancarAliases } from '../src/domain/iancar-price-alias.js';
import { buildKakaoCatalogReferenceProduct } from '../src/application/kakao-catalog-reference.js';
// ONE 원문 구조: 기간 8종 × 주행 3종 = 24조건. 보증금은 기간별로 주행 구간과 무관.
const periods = [1, 3, 5, 12, 24, 36, 48, 60];
const deposit = { 1: 200000, 3: 200000, 5: 400000, 12: 700000, 24: 700000, 36: 1000000, 48: 1000000, 60: 1000000 };
const rentBase = { 1: 500000, 3: 488000, 5: 475000, 12: 463000, 24: 450000, 36: 438000, 48: 425000, 60: 413000 };
const tiers = (months) => (months < 12 ? [2000, 3000, 4000].map(km => `월${km}km`) : [20000, 30000, 40000].map(km => `연${km}km`));
const build = () => {
    const price = {};
    const priceAliases = {};
    for (const months of periods) {
        tiers(months).forEach((suffix, index) => { price[`${months}_${suffix}`] = { rent: rentBase[months] + index * 41000, deposit: deposit[months] }; });
        // 실제 문서와 같은 형식: 별칭 값은 ONE 조건 키(기간:주행:구분)
        priceAliases[String(months)] = months < 12 ? `${months}:2000:month` : `${months}:20000:year`;
        price[String(months)] = { ...price[`${months}_${tiers(months)[0]}`] }; // 호환용 별칭 키 = 이안카 기본 조건(연 2만km, 1~5개월 월 2,000km) 구간 복사
    }
    return { listable: true, provider_company_code: 'RP031', price, iancar_phase_one: { priceAliases } };
};
describe('이안카 가격 별칭 키 — 조건 목록에서 제외', () => {
    it('원천 24조건 + 별칭 8개(32키)에서 별칭만 찾는다', () => {
        const product = build();
        expect(Object.keys(product.price)).toHaveLength(32);
        expect([...iancarPriceAliasKeys(product)].sort()).toEqual(periods.map(String).sort());
        const trimmed = priceWithoutIancarAliases(product);
        expect(Object.keys(trimmed)).toHaveLength(24);
        for (const months of periods)
            expect(Object.keys(trimmed).filter(key => key.startsWith(`${months}_`))).toHaveLength(3);
    });
    it('별칭 값이 원본 키와 다르면(별개 조건) 지우지 않는다', () => {
        const product = build();
        product.price['60'] = { rent: 999999, deposit: 1000000 };
        expect(iancarPriceAliasKeys(product).has('60')).toBe(false);
        expect(Object.keys(priceWithoutIancarAliases(product))).toHaveLength(25);
    });
    it('이안카가 아니거나 별칭 정보가 없으면 그대로(같은 객체)', () => {
        const plain = { listable: true, provider_company_code: 'RP013', price: { '36': { rent: 500000 }, '36_연20000km': { rent: 500000 } } };
        expect(priceWithoutIancarAliases(plain)).toBe(plain.price);
        expect(iancarPriceAliasKeys({ price: {}, iancar_phase_one: {} }).size).toBe(0);
    });
    it('카톡 참고 출력: 6087 60개월은 4행이 아니라 3행(주행 3종), 보증금 불변, 차량당 24조건', () => {
        const product = build();
        const reference = buildKakaoCatalogReferenceProduct('synthetic', product);
        const terms = reference.offers[0].priceTerms;
        expect(terms).toHaveLength(24);
        const sixty = terms.filter(term => term.termMonths === 60);
        expect(sixty).toHaveLength(3);
        expect(sixty.map(term => term.monthlyRent.amount).sort()).toEqual([413000, 454000, 495000]);
        // 별칭 행이 없다: 조건 키는 전부 기간_주행 형태이고, 별칭 정보 없이 만든 결과와 보증금 값·상태가 같다(별칭 제거가 보증금을 바꾸지 않음).
        expect(terms.every(term => /^source:[0-9]+_(월|연)[0-9]+km$/.test(term.termKey))).toBe(true);
        const withoutAliasInfo = buildKakaoCatalogReferenceProduct('synthetic', { ...product, price: priceWithoutIancarAliases(product), iancar_phase_one: { priceAliases: {} } }).offers[0].priceTerms;
        expect(terms.map(term => [term.termKey, term.depositAmount, term.depositState])).toEqual(withoutAliasInfo.map(term => [term.termKey, term.depositAmount, term.depositState]));
        expect(sixty.every(term => term.mileageLimitKmPerYear !== undefined && term.mileageLimitKmPerYear !== null)).toBe(true);
    });
});
