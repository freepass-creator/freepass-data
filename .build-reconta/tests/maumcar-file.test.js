import { describe, expect, it } from 'vitest';
import { convertMaumcarWorkbook, excelSerialDate } from '../src/adapters/maumcar-file.js';
// 합성 데이터(실제 공급사 파일 아님) — B3Q 미리보기로 확인된 «모양»: 한 시트 안에 표 2개((가) 번호 없는 선출고 예정 / (나) 번호 있는 출고 가능 목록),
// 열이 줄마다 어긋나는 머리글 없는 Sheet2, 구분 줄·주석 줄, 요금 칸 «보증금/월렌탈료(만원)», 출고여부에 «즉시»·날짜 일련번호.
const sheet1 = { name: 'Sheet1', rows: [
        ['마춤카 신차 렌터카 선출고 및 출고가능 차량 리스트'],
        [],
        [],
        ['NO', '차량명', '연료', '외부색상', '내부색상', '기타 옵션', '', '차량가액', '보증금', '60개월', '48개월', '36개월', '대여가능일', '비고'],
        ['1', '카니발 하이브리드 노블레스', '하이브리드', '화이트', '토프', '드라이브와이즈', '', '4609', '0.1', '91', '95', '105', '즉시'],
        ['2', '테슬라 Y', '전기', '그레이', '', '', '', '4999'],
        ['* 약정거리 1년 2만k / 수수료 5p'],
        [],
        ['마춤카 중고 렌터카 차량 출고 가능 리스트(無 심사)'],
        ['NO', '차량명', '연료', '년식', '색상', '옵션', '현주행거리', '신차가격', '6개월', '12개월', '24개월', '36개월', '차량번호', '출고여부'],
        ['SUV / RV'],
        ['1', '그랜저 GN7 2.5 프리미엄', '가솔린', '2023', '블랙', '파노라마', '12,345', '4000', '50/98', '93/93', '90/90', '88/88', '12가3456', '즉시(마음카)'],
        ['2', '카니발 프레스티지 9인승', '디젤', '2023', '화이트', '', '40000', '4300', '-', '100/80', '', '0/75', '34나5678', '46310'],
        ['3', '아반떼 CN7 스마트', 'LPG', '2022', '그레이', '', '', '', '', '70', 'x', '60/60', '56다7890', '즉시'],
        ['4', '쏘나타 DN8', '가솔린', '2021', '', '', '', '', '', '80/80', '', '', '', '즉시'],
        ['5', '모닝', '가솔린', '2020', '', '', '', '', '', '30/40', '', '', '78라1234', '즉시'],
        ['6', '레이', '가솔린', '2020', '', '', '', '', '', '30/40', '', '', '78라 1234', '즉시'],
        [],
        ['* 보험 별도'],
    ] };
const sheet2 = { name: '재고(차량번호 있음)', rows: [
        ['5', '카니발 프레스티지 9인승', '디젤', '2023', '화이트', '파워슬라이딩', '67200', '3713', '90/90', '86/86', '83/83', '80/80', '34나5678', '9/9(마음카)'],
        ['6', '아반떼 CN7 스마트', 'LPG', '2023', '그레이', '', '', '', '', '', '', '', '56다7890', '2026-09-22'],
    ] };
const input = { observedAt: '2026-10-15T09:30:00.000Z', fileSha256: 'a'.repeat(64) };
describe('마음카 XLSX 변환', () => {
    const out = convertMaumcarWorkbook([sheet1, sheet2], input);
    const by = Object.fromEntries(out.records.map(r => [r.plate.slice(-4), r]));
    it('번호 있는 표만 상품 후보로 읽고, 번호 없는 선출고 예정과 머리글 없는 시트는 보고 전용이다', () => {
        expect(out.records.map(r => r.plate.slice(-4)).sort()).toEqual(['1234', '3456', '7890']);
        expect(out.reportOnly.preReleaseRows).toBe(2);
        expect(out.reportOnly.convertedSheets).toEqual(['Sheet1']);
        expect(out.reportOnly.headerlessSheets).toEqual([{ sheet: '재고(차량번호 있음)', rows: 2 }]);
    });
    it('요금 칸 «a/b» = 보증금/월렌탈료(만원 → 원), 제안 없음(-·빈칸)은 건너뛰고, 단일 숫자는 뜻을 몰라 쓰지 않는다', () => {
        expect(by['3456'].terms.map(t => [t.months, t.deposit.state, t.deposit.value, t.monthlyRent.value])).toEqual([
            [6, 'KNOWN', 500_000, 980_000], [12, 'KNOWN', 930_000, 930_000], [24, 'KNOWN', 900_000, 900_000], [36, 'KNOWN', 880_000, 880_000]
        ]);
        // 6개월 칸 «50/98»: 보증금 50만·월 98만(단기 할증으로 월료가 더 높다) — 값 그대로
        expect(by['7890'].terms.map(t => [t.months, t.monthlyRent.value])).toEqual([[36, 600_000]]); // 12개월 «70» 단일 숫자·24개월 «x» 는 제외
        expect(out.notes).toContain('RENT_CELL_SINGLE_NUMBER_NOT_USED:1');
    });
    it('보증금 0 은 확정 0원이 아니라 UNKNOWN(산출 근거 없음), 출고여부는 «즉시»만 출고가능이고 날짜·그 밖은 보류', () => {
        const reasons = out.held.map(h => [h.row, h.reason]);
        expect(reasons).toContainEqual([13, 'STATUS_UNKNOWN']); // 34나5678: 출고여부 = 엑셀 일련번호 날짜
        expect(out.notes).toContain('AVAILABLE_FROM_DATE_HELD:1');
        const zero = convertMaumcarWorkbook([{ name: 'S', rows: [['NO', '차량명', '차량번호', '36개월', '출고여부'], ['1', '레이', '12가3456', '0/75', '즉시']] }], input);
        expect(zero.records[0].terms[0]).toMatchObject({ months: 36, deposit: { state: 'UNKNOWN', value: null }, monthlyRent: { state: 'KNOWN', value: 750_000 } });
        expect(zero.notes).toContain('DEPOSIT_ZERO_UNCONFIRMED:1');
    });
    it('번호 없음·형식 오류·중복 번호는 보류하고 구분 줄·주석은 건너뛴다, 같은 번호의 공백 표기는 같은 차', () => {
        const reasons = out.held.map(h => h.reason);
        expect(reasons).toContain('PLATE_MISSING'); // 쏘나타 DN8: 번호 칸 빔
        expect(reasons).toContain('DUPLICATE_PLATE'); // 78라 1234 = 78라1234
        expect(out.duplicatePlates).toHaveLength(1);
        expect(out.notes.some(n => n.startsWith('SEPARATOR_OR_NOTE_ROWS:'))).toBe(true);
        expect(convertMaumcarWorkbook([{ name: 'S', rows: [['NO', '차량명', '차량번호', '출고여부'], ['1', '레이', '***5355', '즉시']] }], input).held[0].reason).toBe('PLATE_INVALID');
    });
    it('레코드: 중고렌트·수수료 확인 필요·원본 해시·원문 보존, 요금 외 칸은 사양으로', () => {
        const r = by['3456'];
        expect(r).toMatchObject({ sourceId: 'RP034', vehicleText: '그랜저 GN7 2.5 프리미엄', status: { raw: '출고가능', saleAvailable: true },
            vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] });
        expect(r.raw).toMatchObject({ source: 'maumcar-file', source_file_sha256: 'a'.repeat(64), product_type: '중고렌트', fee_state: 'FEE_UNCONFIRMED',
            provider_status: '즉시(마음카)', options_text: '파노라마', new_car_price_manwon: '4000',
            spec: { year: '2023', fuel_type: '가솔린', ext_color: '블랙', mileage: '12345' } });
    });
    it('Codex #670 ①: 출고여부는 «즉시»(·«즉시(마음카)») 정확 일치만 출고가능 — «즉시 출고불가» 등은 보류', () => {
        const rows = (status) => convertMaumcarWorkbook([{ name: 'S', rows: [['NO', '차량명', '차량번호', '36개월', '출고여부'], ['1', '레이', '12가3456', '30/40', status]] }], input);
        for (const ok of ['즉시', '즉시(마음카)', '즉시 (마음카)'])
            expect(rows(ok).records, ok).toHaveLength(1);
        for (const bad of ['즉시 출고불가', '즉시마감', '즉시 불가', '즉시 / 9월', '46310']) {
            const r = rows(bad);
            expect(r.records, bad).toHaveLength(0);
            expect(r.held[0].reason).toBe('STATUS_UNKNOWN');
        }
    });
    it('Codex #670 ④: 차량명이 빈 줄도 번호 중복 검사를 받는다(같은 번호의 중복이 차명 누락에 가려지지 않음)', () => {
        const r = convertMaumcarWorkbook([{ name: 'S', rows: [['NO', '차량명', '차량번호', '36개월', '출고여부'],
                    ['1', '레이', '12가3456', '30/40', '즉시'], ['2', '', '12가3456', '30/40', '즉시'], ['3', '', '34나5678', '30/40', '즉시']] }], input);
        expect(r.duplicatePlates).toHaveLength(1);
        expect(r.held.map(h => [h.row, h.reason])).toEqual([[3, 'DUPLICATE_PLATE'], [4, 'VEHICLE_NAME_MISSING']]);
        expect(r.records).toHaveLength(1);
    });
    it('엑셀 일련번호 날짜(1900 체계)', () => {
        expect(excelSerialDate('46023')).toBe('2026-01-01');
        expect(excelSerialDate('46310')).toBe('2026-10-15');
        expect(excelSerialDate('46311')).toBe('2026-10-16');
        expect(excelSerialDate('100')).toBeNull();
        expect(excelSerialDate('즉시')).toBeNull();
    });
});
