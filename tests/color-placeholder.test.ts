import { describe, expect, it } from 'vitest';
import { validColorValue, SPEC_FORMAT_RULES } from '../src/domain/source-spec-validation.js';
import { refillableSpecValues } from '../src/domain/spec-refill.js';
import { sourceSpecFillFields, intColorOnlyFields, sheetSpecFields } from '../src/infra/source-cycle-firestore.js';

// 내부색상 검증기가 «-» 같은 자리표를 통과시키던 문제(2026-10-23 아이언 RP006: 내부색상 13대가 «-», 노출 문서 6건에 이미 «-» 가 채워짐) 보강. 값은 합성.
describe('색상 자리표 거르기', () => {
  it('실제 색상 이름은 통과', () => {
    for (const ok of ['검정', '화이트펄', '스노우화이트펄', '블랙/바닐라', '카멜브라운', '파랑(남색,곤색)', '흰색', 'Black', '미드나잇블랙', '그레이메탈릭']) expect(validColorValue(ok), ok).toBe(true);
  });
  it('대시·기호만·«없음» 류는 색상이 아니다', () => {
    for (const bad of ['-', '--', '—', '–', '_', '.', '?', '***', ' - ', '없음', '해당없음', '해당 없음', '미상', '미정', '미확인', '확인필요', '확인 필요', 'N/A', 'n/a', 'NA', 'null', 'None', 'unknown', '']) expect(validColorValue(bad), JSON.stringify(bad)).toBe(false);
    // 변형 자리표(2026-10-23 Codex 검토): 괄호·마침표·느낌표가 붙은 «값 없음»도 거른다
    for (const bad of ['(미정)', 'N.A.', '확인 필요!', '[없음]', '-미상-', '※ 확인필요']) expect(validColorValue(bad), JSON.stringify(bad)).toBe(false);
  });
  it('기호가 섞여도 글자가 있는 실제 색상은 통과', () => {
    for (const ok of ['검', '백', '블랙(펄)', '블랙/바닐라', '화이트-베이지', 'Black', 'Pearl White', '다크 그레이']) expect(validColorValue(ok), ok).toBe(true);
  });
  it('길이·숫자 규칙은 그대로', () => {
    expect(validColorValue('가'.repeat(21))).toBe(false);
    expect(validColorValue('가'.repeat(20))).toBe(true);
    expect(validColorValue('2026 블랙')).toBe(false);   // 숫자 4자리 이상
    expect(validColorValue('블랙 123')).toBe(true);
  });
  it('공용 규칙표(SPEC_FORMAT_RULES)가 같은 판정을 쓴다', () => {
    expect(SPEC_FORMAT_RULES.int_color!('-')).toBe(false);
    expect(SPEC_FORMAT_RULES.ext_color!('-')).toBe(false);
    expect(SPEC_FORMAT_RULES.int_color!('브라운')).toBe(true);
    expect(SPEC_FORMAT_RULES.ext_color!('검정')).toBe(true);
  });
  it('빈 칸 다시 채움: 자리표는 채우지 않고 실제 값만 채운다', () => {
    const out = refillableSpecValues({ ext_color: '-', int_color: '카멜브라운', fuel_type: '가솔린' }, ['ext_color', 'int_color']);
    expect(out).toEqual({ int_color: '카멜브라운' });
    expect(refillableSpecValues({ int_color: '-' }, ['int_color'])).toEqual({});
  });
  it('최초 제원 채움·내장색 보완: 자리표는 채우지 않는다', () => {
    expect(sourceSpecFillFields({ int_color: '-', ext_color: '검정' }, {})).toEqual({ ext_color: '검정' });
    expect(sourceSpecFillFields({ int_color: '블랙' }, {})).toEqual({ int_color: '블랙' });
    expect(intColorOnlyFields({ int_color: '-' }, {})).toEqual({ vehicle_int_color_source_checked: true });   // 표식만 남고 «-» 는 쓰지 않는다
    expect(intColorOnlyFields({ int_color: '블랙' }, {})).toEqual({ vehicle_int_color_source_checked: true, int_color: '블랙' });
  });
  it('새 문서의 시트 제원도 외부색상 자리표를 싣지 않는다', () => {
    expect(sheetSpecFields({ ext_color: '-', fuel_type: '가솔린' })).toEqual({ fuel_type: '가솔린' });
    expect(sheetSpecFields({ ext_color: '흰색' })).toEqual({ ext_color: '흰색' });
    // 자리표 거르기 외의 새 문서 경로는 종전과 같다: 20자를 넘는 값·숫자 4자리 값도 40자 이하면 그대로 싣는다
    expect(sheetSpecFields({ ext_color: '가'.repeat(25) })).toEqual({ ext_color: '가'.repeat(25) });
    expect(sheetSpecFields({ ext_color: '2026 블랙' })).toEqual({ ext_color: '2026 블랙' });
    expect(sheetSpecFields({ ext_color: '(미정)' })).toEqual({});
  });
});
