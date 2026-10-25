import { describe, expect, it } from 'vitest';
import { buildPublicProductQuote } from '../src/api/public-product-feed.js';
import { sourceSpecFillFields } from '../src/infra/source-cycle-firestore.js';
// 제원 입구 매핑·시트 제원은 숫자를 문자열("7113")로 저장한다: 공개 피드가 던지지 않고 숫자로 내보내며, 값이 없으면 null(0 아님)이다. 값은 합성.
const snapshot = (extra) => ({
    schema: 'freepass-data.catalog-compat/v1',
    data: { products: { P1: { _key: 'P1', product_code: 'P1', publicProductKey: 'P1', listable: true, provider_company_code: 'RP012', partner_code: 'RP012', whitelabels: ['uniplan'],
                maker: '기아', model: '타스만', product_type: 'USED_SUBSCRIPTION', status_kind: '가용', policy_id: 'POLICY_PUBLIC',
                price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } }, ...extra } },
        policies: { POLICY_PUBLIC: { policy_name: 'PUBLIC_BASIC', insurance_included: true, annual_mileage: 20000 } }, partners: {}, users: {} },
    meta: { consumerId: 'erp-com', authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE', sourceProject: 'freepasserp5', observedAt: '2026-10-10T00:00:00.000Z',
        collectionCounts: { products: 1, policy: 1 }, depositEvidenceVersion: 'catalog-compat-deposit/1' },
});
const quote = (extra) => buildPublicProductQuote(snapshot(extra), 'P1', {}).product;
describe('공개 피드: 제원 숫자 문자열', () => {
    it('"7113"·"2497"·"2026"·"5" 는 숫자로 내보낸다', () => {
        const p = quote({ mileage: '7113', engine_cc: '2497', year: '2026', seats: '5', ext_color: '빨간색', int_color: '블랙' });
        expect(p.mileage).toBe(7113);
        expect(p.engine_cc).toBe(2497);
        expect(p.year).toBe(2026);
        expect(p.seats).toBe(5);
        expect(p.int_color).toBe('블랙');
    });
    it('값이 없으면 null(0 으로 쓰지 않는다), 숫자 자체(0 포함)는 그대로', () => {
        for (const blank of [undefined, null, '', '  '])
            expect(quote({ mileage: blank }).mileage ?? null, String(blank)).toBeNull();
        expect(quote({ mileage: 0 }).mileage).toBe(0);
    });
    it('단위·쉼표가 든 문자열은 종전처럼 오류(원문을 숫자로 추정하지 않는다)', () => {
        expect(() => quote({ mileage: '7,113km' })).toThrow('PUBLIC_NUMBER_INVALID:mileage');
    });
});
describe('제원 입구 매핑: 내장색', () => {
    it('빈 칸에만 채우고(기존 값 비접촉), 숫자 4자리 이상·20자 초과는 채우지 않는다', () => {
        expect(sourceSpecFillFields({ int_color: '블랙' }, {})).toEqual({ int_color: '블랙' });
        expect(sourceSpecFillFields({ int_color: '블랙' }, { int_color: '베이지' })).toEqual({});
        expect(sourceSpecFillFields({ int_color: '12345' }, {})).toEqual({});
        expect(sourceSpecFillFields({ int_color: 'ㄱ'.repeat(21) }, {})).toEqual({});
    });
});
