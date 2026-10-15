import { describe, expect, it } from 'vitest';
import { conformanceLines, sonogongSpecConformance } from '../src/application/sonogong-spec-conformance.js';

// 값은 합성. 노출 손오공 문서만 센다(다른 공급사·비노출 제외), 번호는 끝 4자리로만 나온다.
const doc = (plate: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider_company_code: 'RP012', listable: true, car_number: plate, maker: '기아', model: '타스만', sub_model: '타스만 2.5T', trim_name: '', year: '2026',
  first_registration_date: '2026-03', fuel_type: '가솔린', engine_cc: '2497', seats: '5', ext_color: '빨간색', int_color: '블랙', mileage: '7113',
  price: { '36': { rent: 700000, deposit: 1000000 } }, product_type: '중고렌트', status_kind: '출고가능', api_options_state: 'PRESENT', image_urls: ['https://x/1.jpg'], ...extra });
const field = (r: ReturnType<typeof sonogongSpecConformance>, name: string) => r.fields.find(f => f.field === name)!;

describe('손오공 규격 일치 점검', () => {
  it('노출 손오공 문서만 대상으로 채움률·빈칸을 센다', () => {
    const r = sonogongSpecConformance([doc('802조3132'), doc('11가1111', { trim_name: '프레스티지' }), doc('22나2222', { listable: false }), doc('33다3333', { provider_company_code: 'RP031' })]);
    expect(r.population).toBe(2);
    expect(field(r, 'trim_name')).toMatchObject({ filled: 1, blank: 1 });
    expect(field(r, 'maker')).toMatchObject({ filled: 2, violations: 0 });
  });

  it('규격 위반: 연료 표기·배기량 단위·연식·최초등록·보증금 단위·밑줄 원문 형태를 세고 사례는 끝 4자리만 싣는다', () => {
    const bad = doc('802조3132', { fuel_type: 'GSL', engine_cc: '2.5', year: '26', first_registration_date: '2026-02-31', sub_model: '타스만_2.5T 가솔린 2WD',
      price: { '36': { rent: 700000, deposit: 100 } }, mileage: '7,113km' });
    const r = sonogongSpecConformance([bad, doc('11가1111')]);
    expect(field(r, 'fuel_type').violations).toBe(1);
    expect(field(r, 'engine_cc').violations).toBe(1);
    expect(field(r, 'year').violations).toBe(1);
    expect(field(r, 'first_registration_date').violations).toBe(1);
    expect(field(r, 'deposit').violations).toBe(1);
    expect(field(r, 'sub_model').violations).toBe(1);
    expect(field(r, 'mileage').violations).toBe(1);
    const example = field(r, 'fuel_type').examples[0]!;
    expect(example.l4).toBe('3132');
    expect(JSON.stringify(r)).not.toContain('802조');   // 전체 번호 없음
  });

  it('임시 표식 문서(세부모델=원문 차명)는 정제 대기 위반으로, 전기차 배기량은 의미 충돌로 센다', () => {
    const r = sonogongSpecConformance([
      doc('44라4444', { sub_model: '타스만 2.5T', car_name: '타스만 2.5T', vehicle_title_source: 'RAW_VEHICLE_TEXT' }),
      doc('55마5555', { fuel_type: '전기', engine_cc: '1600' })]);
    expect(field(r, 'sub_model').violations).toBe(1);
    expect(field(r, 'engine_cc').violations).toBe(1);
  });

  it('출력 줄에는 채움률·위반 건수·사례가 있고 값이 없는 칸은 빈칸으로 센다', () => {
    const lines = conformanceLines(sonogongSpecConformance([doc('66바6666', { int_color: '' })]));
    expect(lines[0]).toContain('노출 1대');
    expect(lines.find(l => l.startsWith('내장색'))).toContain('빈칸 1');
  });
});
