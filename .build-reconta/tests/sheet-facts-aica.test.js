import { describe, expect, it } from 'vitest';
import { sheetFactsOf } from '../src/domain/sheet-facts.js';
import { aicaNativeCapture } from '../src/adapters/source-cycle-native.js';
import { AICA_SCOPES } from '../src/adapters/source-cycle-plugins.js';
import { nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
// 2026-10-23 손실 칸 조사 (c)(d): 아이카 시트의 «소비자가격»(→ consumer_price)·«옵션»(→ options)을 기존 SHEET_FACT 경로로. 헤더 별칭 + 아이카 행의 raw.sheet_facts. 값은 합성.
const time = '2026-10-23T00:00:00.000Z';
describe('헤더 별칭: 아이카 시트의 «옵션»·«소비자가격»', () => {
    it('공통 시트 이름이 우선이고, 없을 때만 아이카 이름을 쓴다', () => {
        expect(sheetFactsOf(['옵션', '소비자가격'], ['선루프, 내비게이션', 26981849])).toEqual({ options: '선루프, 내비게이션', consumer_price: 26981849 });
        expect(sheetFactsOf(['옵션 원문', '옵션'], ['원문 옵션', '다른 옵션'])).toEqual({ options: '원문 옵션' });
        expect(sheetFactsOf(['차량가격', '소비자가격'], ['30,000,000', '10,000,000'])).toEqual({ consumer_price: 30000000 });
    });
    it('검증 규칙은 그대로: 범위 밖 가격·무정보·연락처 옵션은 후보에서 뺀다', () => {
        expect(sheetFactsOf(['소비자가격'], [1500000])).toBeUndefined(); // 500만원 미만
        expect(sheetFactsOf(['소비자가격'], [''])).toBeUndefined();
        expect(sheetFactsOf(['옵션'], ['기본'])).toBeUndefined();
        expect(sheetFactsOf(['옵션'], ['보증금 문의 010-1234-5678'])).toBeUndefined();
        // 공백·점으로 구분한 연락처와 연락처 낱말도 거른다(2026-10-23 Codex 검토)
        expect(sheetFactsOf(['옵션'], ['담당 홍길동 010 1234 5678'])).toBeUndefined();
        expect(sheetFactsOf(['옵션'], ['담당 010.1234.5678'])).toBeUndefined();
        expect(sheetFactsOf(['옵션'], ['연락처는 담당자에게'])).toBeUndefined();
        expect(sheetFactsOf(['옵션'], ['12.3인치 클러스터, 19인치 휠, 컨비니언스'])).toEqual({ options: '12.3인치 클러스터, 19인치 휠, 컨비니언스' });
    });
    it('앞선 이름의 헤더가 있으면 값이 비었거나 무효여도 다음 별칭으로 넘어가지 않는다(다른 칸으로 대체되는 위험을 막는다)', () => {
        expect(sheetFactsOf(['옵션 원문', '옵션'], ['', '선루프'])).toBeUndefined();
        expect(sheetFactsOf(['차량가격', '소비자가격'], ['1,500,000', '30,000,000'])).toBeUndefined();
        expect(sheetFactsOf(['옵션', '옵션 원문'], ['별칭 옵션', '원문 옵션'])).toEqual({ options: '원문 옵션' }); // 우선순위는 열 위치가 아니라 이름 순서
    });
});
describe('아이카 행 → raw.sheet_facts (옵션·소비자가격)', () => {
    const headers = ['배차상태', '구분', '차량번호', '차급', '차종분류', '트림', '연료', '외장', '내장', 'Km', '월렌트', '장기보증',
        '36개월', '48개월', '60개월', '옵션', '최초등록', '소비자가격', '제조사', '배기량', '연주행', '대인', '대물', '자차', '자손'];
    const row = (o = {}) => headers.map(h => ({ 배차상태: '배차문의', 구분: '재렌트', 차량번호: '00가2001', 차급: '합성급',
        차종분류: '합성모델', 트림: '합성트림', 연료: '가솔린', 외장: '흰색', 내장: '검정', Km: 12345, 월렌트: '', 장기보증: '무보증',
        '36개월': '500,000', '48개월': '', '60개월': '', 옵션: '', 최초등록: '2023-05-12', 소비자가격: '', 제조사: '합성제조사', 배기량: 1598,
        연주행: '2만km', 대인: '', 대물: '', 자차: '', 자손: '', ...o }[h]));
    const capture = (o) => {
        const tables = AICA_SCOPES.map((title, i) => ({ title, values: title === '월렌트' ? [['차종', '1개월']] : [headers, ...(i === 0 ? [row(o)] : [])] }));
        const meta = { sheets: tables.map(t => ({ properties: { title: t.title, hidden: false, gridProperties: { rowCount: t.values.length } },
                data: [{ startRow: 0, rowMetadata: t.values.map(() => ({ hiddenByUser: false, hiddenByFilter: false })) }] })) };
        return aicaNativeCapture(tables, time, meta).rows[0].record;
    };
    it('옵션 글과 소비자가격(숫자 칸)이 검증을 통과하면 후보로 싣는다', () => {
        const r = capture({ 옵션: '기본형-드라이브와이즈,내비게이션', 소비자가격: 31054781 });
        expect(r.raw.sheet_facts).toEqual({ options: '기본형-드라이브와이즈,내비게이션', consumer_price: 31054781 });
    });
    it('값이 없거나 검증을 못 통과하면 후보를 싣지 않는다', () => {
        expect(capture({}).raw).not.toHaveProperty('sheet_facts');
        expect(capture({ 옵션: '기본', 소비자가격: 1500000 }).raw).not.toHaveProperty('sheet_facts');
        expect(capture({ 옵션: '문의 카톡', 소비자가격: '미정' }).raw).not.toHaveProperty('sheet_facts');
    });
    it('쓰기: 켠 공급사·칸만, 문서 칸이 비어 있을 때만 — 기본은 꺼짐', () => {
        const r = capture({ 옵션: '선루프', 소비자가격: 25000000 });
        const p = { record: r, listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null, sheetFactFill: ['options', 'consumer_price'] };
        const off = nativeCycleFields(p, { car_number: r.plate, options: '', consumer_price: undefined }, {});
        expect(off).not.toHaveProperty('options');
        expect(off).not.toHaveProperty('consumer_price');
        const on = nativeCycleFields(p, { car_number: r.plate, options: '', consumer_price: undefined }, { sheetFactSources: new Set(['RP004']), sheetFactKeys: ['options', 'consumer_price'] });
        expect(on).toMatchObject({ options: '선루프', consumer_price: 25000000 });
        const kept = nativeCycleFields(p, { car_number: r.plate, options: '기존 옵션', consumer_price: 30000000 }, { sheetFactSources: new Set(['RP004']), sheetFactKeys: ['options', 'consumer_price'] });
        expect(kept).not.toHaveProperty('options');
        expect(kept).not.toHaveProperty('consumer_price');
    });
});
