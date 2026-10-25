import { describe, expect, it } from 'vitest';
import { explainEngineRefine } from '../src/jobs/explain-engine-refine.js';
const master = { id: 'm1', maker: '현대', model: '아반떼', sub_model: '더 뉴 아반떼 CN7', model_aliases: [], sub_model_aliases: ['아반떼 CN7'], yearFrom: 2020, yearTo: 2023,
    trims: [{ name: '모던', aliases: [] }, { name: '스마트', aliases: [] }] };
const product = (over) => ({ id: 'p', plate4: '9203', maker: '현대', model: '아반떼', sub_model: '', trim_name: '',
    rawName: '현대_더 뉴 아반떼 CN7_가솔린 1.6', year: '2022', listable: true, engineTemp: true, supplier: 'RP012', ...over });
describe('엔진 정제 진단(읽기 전용)', () => {
    it('끝 4자리와 공급사로 고른 문서의 엔진 정제기·계획서 결과를 나란히 낸다', () => {
        const rows = explainEngineRefine([product({ sub_model: '현대_더 뉴 아반떼 CN7_가솔린 1.6' }), product({ id: 'q', plate4: '1111' }), product({ id: 'r', supplier: 'RP031' })], [master], ['9203']);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ plate4: '9203', hasMakerModel: true, trimBlank: true, engine: { state: 'REFINED', sub_model: '더 뉴 아반떼 CN7', trim: null } });
        expect(rows[0].plan).toContain('MATCH');
    });
    it('엔진 정제기가 null 이면 NULL, 마스터에 없으면 계획서도 HOLD', () => {
        const rows = explainEngineRefine([product({ rawName: '기아_타스만_2.5T', sub_model: '기아_타스만_2.5T' })], [master], ['9203']);
        expect(rows[0].engine).toEqual({ state: 'NULL' });
        expect(rows[0].plan).toContain('HOLD');
    });
});
