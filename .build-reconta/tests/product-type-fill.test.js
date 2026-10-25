import { describe, expect, it } from 'vitest';
import { productTypeFromCell } from '../src/adapters/source-cycle-native.js';
import { nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
const record = (sourceId, raw) => ({ record: { sourceId, uid: 'U1', plate: '12가1234', vehicleText: '테스트', status: { raw: '출고가능', saleAvailable: true },
        terms: [], observedAt: '2026-10-14T00:00:00.000Z', raw, vehicleHold: [] }, listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null });
describe('상품 구분(product_type) 채움 — 원천 자기 칸·고정 정책만, 추정 없음', () => {
    it('reads the supplier column only when it exactly matches the central vocabulary', () => {
        expect(productTypeFromCell(['차량번호', '상품구분'], ['12가1234', ' 중고렌트 '], '상품구분')).toEqual({ product_type: '중고렌트' });
        expect(productTypeFromCell(['차량번호', '구분'], ['12가1234', '신차'], '구분')).toEqual({}); // 모호한 표기는 변환표에 없다(추정 안 함)
        expect(productTypeFromCell(['구분'], ['신차 렌트'], '구분')).toEqual({ product_type: '신차렌트' }); // 공백 변형
        expect(productTypeFromCell(['구분'], ['장기렌트'], '구분')).toEqual({ product_type: '재렌트' }); // 변환표(수수료 규칙과 같은 대응)
        expect(productTypeFromCell(['차량번호'], ['12가1234'], '상품구분')).toEqual({});
    });
    it('fills only an empty product_type and never overwrites an existing classification', () => {
        expect(nativeCycleFields(record('RP023', { product_type: '오플구독' }), {}).product_type).toBe('오플구독');
        expect(nativeCycleFields(record('RP023', { product_type: '오플구독' }), { product_type: '신차렌트' }).product_type).toBeUndefined();
        expect(nativeCycleFields(record('RP004', { product_type: '임의값' }), {}).product_type).toBeUndefined();
    });
    it('RP006(아이언 홈페이지) also fills only an empty product_type — the list condition never overwrites a stored one', () => {
        expect(nativeCycleFields(record('RP006', { product_type: '중고렌트' }), {}).product_type).toBe('중고렌트');
        expect(nativeCycleFields(record('RP006', { product_type: '중고렌트' }), { product_type: '재렌트' }).product_type).toBeUndefined();
        expect(nativeCycleFields(record('RP006', { product_type: '중고렌트' }), { product_type: ' ' }).product_type).toBe('중고렌트');
    });
});
