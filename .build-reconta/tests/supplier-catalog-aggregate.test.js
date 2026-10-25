import { describe, expect, it } from 'vitest';
import { aggregateCatalog, catalogAggregateMarkdown, catalogItems } from '../src/application/supplier-catalog-aggregate.js';
const raw = (plate, over = {}) => ({ car_number: plate, provider_name: '손오공', vehicle_status: '출고가능', product_type: '중고렌트',
    image_url: '/api/img?p=1', image_urls: ['/api/img?p=1'], price: { '36': { rent: 500000, deposit: 1000000, depositState: 'KNOWN' } }, ...over });
describe('공급사별 catalog 집계(읽기 전용, 번호·키 미출력)', () => {
    const catalog = { products: [
            raw('12가1111'),
            raw('12가1112', { vehicle_status: '계약중' }),
            raw('12가1113', { image_url: '', image_urls: [], product_type: '' }),
            raw('34나2221', { provider_name: '이안카', price: { '36': { rent: 400000, deposit: null, depositState: 'UNKNOWN' }, '48': { rent: 390000, deposit: 500000, depositState: 'KNOWN' } } }),
            raw('34나2222', { provider_name: '이안카', price: {} }),
            raw('34나2223', { provider_name: '이안카', vehicle_status: '상품화중' }),
            raw('56다3331', { provider_name: undefined }),
        ] };
    it('counts exposed / dispatchable / contracted / no photo / no type / no price row / deposit unknown per supplier, ordered by exposure', () => {
        const a = aggregateCatalog(catalog);
        expect(a.rows.map(r => [r.supplier, r.exposed, r.dispatchable, r.contracted, r.noPhoto, r.noProductType, r.noPriceRow, r.depositUnknown, r.otherStatus])).toEqual([
            ['손오공', 3, 2, 1, 1, 1, 0, 0, 0],
            ['이안카', 3, 3, 0, 0, 0, 1, 0, 1], // 출고가능 = 노출 − 계약중 (상품화중 표시 1건은 otherStatus 로 따로 알림)
        ]);
        expect(a.skipped).toBe(1); // 공급사 이름 없음은 제외하고 알림
        expect(a.total.exposed).toBe(6);
    });
    it('default deposit unknown = no price row has a known deposit value; any/state options are explicit', () => {
        const find = (a) => a.rows.find(r => r.supplier === '이안카').depositUnknown;
        expect(find(aggregateCatalog(catalog))).toBe(0); // 한 행(48개월)은 보증금 값이 있다
        expect(find(aggregateCatalog(catalog, { depositMode: 'any' }))).toBe(1);
        const allBlank = { products: [raw('1', { provider_name: 'A', price: { '36': { rent: 1, deposit: null }, '48': { rent: 1, deposit: '' } } }),
                raw('2', { provider_name: 'A', price: { '36': { rent: 1, deposit: 0, depositState: 'ZERO' } } }),
                raw('3', { provider_name: 'A', price: { '36': { rent: 1, deposit: null, depositState: 'NOT_APPLICABLE' } } })] };
        expect(aggregateCatalog(allBlank).rows[0].depositUnknown).toBe(2); // 값 기준: null/빈칸 2대(NOT_APPLICABLE 라도 값이 비면 미상)
        expect(aggregateCatalog(allBlank, { depositBasis: 'state' }).rows[0].depositUnknown).toBe(1); // 상태 기준: NOT_APPLICABLE 은 제외
    });
    it('accepts the normalized vehicles shape too (supplier·dispatchLabel·rates·imageUrl·productType)', () => {
        const normalized = { vehicles: [
                { supplier: '아이언', dispatchLabel: '출고가능', productType: '신차렌트', imageUrl: 'https://x/y.jpg', rates: [{ rent: 700000, deposit: 0, depositState: 'ZERO' }] },
                { supplier: '아이언', dispatchLabel: '계약중', productType: '', imageUrl: null, rates: [{ rent: 700000, deposit: null, depositState: 'UNKNOWN' }] },
            ] };
        expect(aggregateCatalog(normalized).rows).toEqual([{ supplier: '아이언', exposed: 2, dispatchable: 1, contracted: 1, noPhoto: 1, noProductType: 1,
                noPriceRow: 0, depositUnknown: 1, otherStatus: 0 }]);
        expect(catalogItems([{ a: 1 }, 'x'])).toHaveLength(1);
        expect(catalogItems({ data: { products: [{ provider_name: 'x' }] } })).toHaveLength(1);
    });
    it('decodes the deployed summary-v1 response: compact price rows [key,months,rent,deposit,stateIndex,…]', () => {
        const summary = { format: 'summary-v1', dict: { mileage: [], maturity: [[null, null]] }, vehicles: [
                { id: 'a', supplier: '이안카', productType: '중고렌트', imageUrl: 'https://x/1.jpg', dispatchLabel: '출고가능', rates: [[0, 36, 500000, null, 2, null, -1, 0], [0, 48, 480000, 1000000, 0, null, -1, 0]] }, // 한 행은 보증금 값 있음
                { id: 'b', supplier: '이안카', dispatchLabel: '계약중', photoPending: true, rates: [[0, 36, 500000, null, 2, null, -1, 0]] }, // 전부 미상
                { id: 'c', supplier: '이안카', imageUrl: 'https://x/3.jpg', dispatchLabel: '출고가능', rates: [] },
            ] };
        const r = aggregateCatalog(summary).rows[0];
        expect([r.exposed, r.dispatchable, r.contracted, r.noPhoto, r.noProductType, r.noPriceRow, r.depositUnknown]).toEqual([3, 2, 1, 1, 2, 1, 1]);
    });
    it('prints the same table header as the handoff and never any plate number or key', () => {
        const markdown = catalogAggregateMarkdown(aggregateCatalog(catalog), '2026-10-14T13:00:00.000Z');
        expect(markdown).toContain('|공급사|노출|출고가능|계약중|사진없음|구분없음|가격행없음|보증금미상|');
        expect(markdown).toContain('|손오공|3|2|1|1|1|0|0|');
        expect(markdown).toContain('표시 상태가 출고가능·즉시출고가 아닌 차량 1건: 이안카 1');
        expect(markdown).not.toMatch(/\d{2,3}[가-힣]\d{4}/);
        expect(markdown).not.toContain('/api/img');
    });
    it('unrecognized or empty input yields no rows instead of throwing', () => {
        expect(aggregateCatalog({}).rows).toEqual([]);
        expect(aggregateCatalog(null).rows).toEqual([]);
    });
});
