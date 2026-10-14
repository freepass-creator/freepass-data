import { describe, expect, it } from 'vitest';
import { readAutoplusSheet, autoplusSheetRowFloor } from '../src/adapters/autoplus-sheet.js';
import { sheetSpecFields } from '../src/infra/source-cycle-firestore.js';

const header = ['No.', '차량번호', '차종', '모델명', '색상', '연료', '최초등록일', '예상\n주행거리', '판매상태', '12개월\n2만km', '24개월\n2만km', '36개월\n3만km', '옵션'];
const car = (no: number, plate: string, status: string, rents: [string, string, string] = ['770,000', '730,000', '700,000']) =>
  [String(no), plate, '니로EV', '디 올뉴니로EV 에어', '검정', 'EV', '2023-06-13', '15,419', status, ...rents, ''];
const NOW = '2026-10-14T05:00:00.000Z';

describe('오토플러스 시트 어댑터', () => {
  it('머리글이 밀려 있어도 차량번호·판매상태가 있는 탭만 읽고, 판매 가능/불가를 구분한다', () => {
    const read = readAutoplusSheet([
      { title: '공지사항', values: [['안내'], ['차량번호는 여기 없음']] },
      { title: '판매차량리스트', values: [['2026. 10. 14'], ['안내문'], [], [], [], [], [], [], header,
        car(1, '05수4216', '할인판매'), car(2, '36너2705', '판매중'), car(3, '36너2780', '계약중'), car(4, '07어4389', '보류'), car(5, '01하1234', '상품대기')] },
    ], NOW);
    expect(read.complete).toBe(true);
    expect(read.tabsUsed).toEqual(['판매차량리스트']);
    expect(read.rowCount).toBe(5);
    const by = Object.fromEntries(read.records.map(r => [r.plate!.slice(-4), r]));
    expect(by['4216']!.status).toEqual({ raw: '출고가능', saleAvailable: true });
    expect(by['2705']!.status.saleAvailable).toBe(true);
    expect(by['1234']!.status.saleAvailable).toBe(true);
    // 계약중은 모든 원천에서 같게: 판매 가능(문서 유지·«계약중» 선점 표시 노출), 출고가능 비교에서는 raw «계약중» 으로 구분
    expect(by['2780']!.status).toEqual({ raw: '계약중', saleAvailable: true });
    expect(by['4389']!.status).toEqual({ raw: '보류', saleAvailable: false });
    expect(by['4216']!.terms.map(t => [t.months, t.mileage, t.monthlyRent.value])).toEqual([[12, '20000km/year', 770000], [24, '20000km/year', 730000], [36, '30000km/year', 700000]]);
    expect(by['4216']!.raw.spec).toMatchObject({ ext_color: '검정', fuel_type: 'EV', first_registration_date: '2023-06', year: '2023', mileage: '15419' });
    expect(by['4216']!.vehicleText).toBe('디 올뉴니로EV 에어');   // 모델명이 차종을 이미 포함하면 앞에 붙이지 않는다
  });
  it('모르는 판매상태·잘못된 번호는 보류하고, 중복 번호는 읽기를 불완전으로 둔다', () => {
    const held = readAutoplusSheet([{ title: 't', values: [header, car(1, '05수4216', '이상한상태'), car(2, 'ABC', '판매중'), car(3, '36너2705', '판매중'), car(4, '12가-3456', '판매중'), car(5, 'ABC1', '판매중')] }], NOW);
    expect(held.held.map(h => h.reason).sort()).toEqual(['PLATE_INVALID', 'PLATE_INVALID', 'PLATE_INVALID', 'STATUS_UNKNOWN']);
    expect(held.records.map(r => r.plate)).toEqual(['36너2705']);
    const dup = readAutoplusSheet([{ title: 't', values: [header, car(1, '05수4216', '판매중'), car(2, '05수4216', '판매중')] }], NOW);
    expect(dup.complete).toBe(false);
    expect(dup.incompleteReason).toBe('DUPLICATE_PLATES');
  });
  it('요금이 비면 항이 없고(제안 없음), 범위 밖 값은 항으로 만들지 않는다', () => {
    const read = readAutoplusSheet([{ title: 't', values: [header, car(1, '05수4216', '판매중', ['', '-', '5,000'])] }], NOW);
    expect(read.records[0]!.terms).toEqual([]);
  });
  it('탭을 못 찾으면 불완전이고 행 수 하한은 노출·직전 수의 80%', () => {
    const none = readAutoplusSheet([{ title: 'x', values: [['아무것도']] }], NOW);
    expect(none.complete).toBe(false);
    expect(none.incompleteReason).toBe('SHEET_TABS_NOT_FOUND');
    expect(autoplusSheetRowFloor(44, 0)).toBe(36);
    expect(autoplusSheetRowFloor(10, 48)).toBe(39);
    expect(autoplusSheetRowFloor(0, 0)).toBe(0);
  });
  it('새 문서에 싣는 시트 사실은 허용 키·짧은 문자열만 통과한다', () => {
    expect(sheetSpecFields({ ext_color: '검정', fuel_type: 'EV', year: '2023', secret: 'x', mileage: 'y'.repeat(41) })).toEqual({ ext_color: '검정', fuel_type: 'EV', year: '2023' });
    expect(sheetSpecFields(null)).toEqual({});
    expect(sheetSpecFields(['a'])).toEqual({});
  });
});
