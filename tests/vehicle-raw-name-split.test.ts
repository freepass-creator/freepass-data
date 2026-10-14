import { describe, expect, it } from 'vitest';
import { peelPowertrain, shortMakerName, splitRawVehicleName } from '../src/domain/vehicle-raw-name-split.js';
import { buildIdentityStatusTable, classifyIdentityRow } from '../src/application/vehicle-identity-status.js';
import { rowsFromCatalog } from '../src/jobs/report-vehicle-identity-status.js';

describe('공급사 원문 차명 결정적 분해', () => {
  it('4토큰: 제조사_모델_파워트레인_트림', () => {
    expect(splitRawVehicleName('기아_쏘렌토 하이브리드_1.6 HEV 2WD_프레스티지')).toEqual({
      structure: 'MAKER_MODEL_POWERTRAIN_TRIM', maker: '기아', modelText: '쏘렌토 하이브리드', powertrain: '1.6 HEV 2WD', trimCandidate: '프레스티지' });
    // 파워트레인 자리의 트림 낱말은 트림 후보로 간다, 인승은 파워트레인
    expect(splitRawVehicleName('기아_카니발_가솔린 7인승 하이리무진_노블레스')).toMatchObject({
      powertrain: '가솔린 7인승', trimCandidate: '하이리무진 노블레스' });
    expect(splitRawVehicleName('현대_아반떼_1.6 가솔린_렌터카 트렌디')).toMatchObject({ powertrain: '1.6 가솔린', trimCandidate: '렌터카 트렌디' });
  });
  it('3토큰: 제조사_모델_꼬리(파워트레인만 / 트림만 / 파워트레인 / 트림)', () => {
    expect(splitRawVehicleName('제네시스_G80 (RG3)_가솔린 2.5 터보 AWD')).toMatchObject({
      structure: 'MAKER_MODEL_TAIL', maker: '제네시스', modelText: 'G80 (RG3)', powertrain: '가솔린 2.5 터보 AWD', trimCandidate: null });
    expect(splitRawVehicleName('기아_K8 하이브리드_시그니처')).toMatchObject({ powertrain: null, trimCandidate: '시그니처' });
    expect(splitRawVehicleName('기아_스포티지_시그니처 그래비티 2WD')).toMatchObject({ powertrain: '2WD', trimCandidate: '시그니처 그래비티' });
    expect(splitRawVehicleName('기아_레이_1.0 가솔린 터보 / 스마트')).toMatchObject({ powertrain: '1.0 가솔린 터보', trimCandidate: '스마트' });
    // «A / B» 는 앞이 파워트레인(제원 후보), 뒤가 트림 후보다 — 앞 조각이 파워트레인 낱말이 아니어도 트림으로 넘기지 않는다(마스터가 최종 판정)
    expect(splitRawVehicleName('현대_아이오닉5_롱레인지 / 익스클루시브')).toMatchObject({ powertrain: '롱레인지', trimCandidate: '익스클루시브' });
    expect(splitRawVehicleName('기아_레이_THE NEW RAY 1.0 / 프레스티지').structure).toBe('MAKER_MODEL_TAIL');
  });
  it('어긋난 구조·구분자 없음은 쪼개지 않는다(지어내지 않음)', () => {
    expect(splitRawVehicleName('기아 디 올뉴니로EV 에어').structure).toBe('NO_DELIMITER');
    expect(splitRawVehicleName('기아_쏘렌토').structure).toBe('MISALIGNED');
    expect(splitRawVehicleName('기아__시그니처').structure).toBe('MISALIGNED');
    expect(splitRawVehicleName('a_b_c_d_e').structure).toBe('MISALIGNED');
    expect(splitRawVehicleName('기아_K8_K8 HEV').structure).toBe('MISALIGNED');           // 꼬리가 모델 반복
    expect(splitRawVehicleName('기아_쏘렌토_프레스티지_노블레스').structure).toBe('MISALIGNED');   // 파워트레인 자리에 파워트레인이 없음
    expect(splitRawVehicleName('기아_K8_K8 HEV').powertrain).toBeNull();
  });
  it('제조사 이름은 짧게(규칙 7), 모르는 제조사는 원문 그대로', () => {
    expect(shortMakerName('KG모빌리티(쌍용)')).toBe('KGM');
    expect(shortMakerName('쉐보레(대우)')).toBe('쉐보레');
    expect(shortMakerName('르노코리아')).toBe('르노');
    expect(shortMakerName('기아')).toBe('기아');
    expect(shortMakerName('BYD')).toBe('BYD');
  });
  it('가운데 낀 파워트레인 낱말은 떼지 않는다(앞뒤만)', () => {
    expect(peelPowertrain('1.6 HEV 프레스티지')).toEqual({ powertrain: '1.6 HEV', rest: '프레스티지' });
    expect(peelPowertrain('프레스티지 2WD')).toEqual({ powertrain: '2WD', rest: '프레스티지' });
    expect(peelPowertrain('노블레스 HEV 라이트')).toEqual({ powertrain: null, rest: '노블레스 HEV 라이트' });
    expect(peelPowertrain('2WD')).toEqual({ powertrain: '2WD', rest: null });
  });
});

describe('차종 정체성 4칸 현황표', () => {
  const rows = [
    { supplier: '손오공', manufacturer: '', model: '', subModel: '기아_쏘렌토 하이브리드_1.6 HEV 2WD_프레스티지', trim: '' },
    { supplier: '손오공', manufacturer: '', model: '', subModel: '기아_K8 하이브리드_시그니처', trim: '' },
    { supplier: '손오공', manufacturer: '', model: '', subModel: '기아_K8_K8 HEV', trim: '' },
    { supplier: '손오공', manufacturer: '기아', model: 'EV3', subModel: 'EV3', trim: '어스' },
    { supplier: '오토플러스', manufacturer: '', model: '', subModel: '기아 디 올뉴니로EV 에어', trim: '' },
    { supplier: '오토플러스', manufacturer: '제네시스', model: 'G80', subModel: 'G80 RG3', trim: '' },
    { supplier: '스타', manufacturer: '', model: '', subModel: '', trim: '' },
    { supplier: '아이언', manufacturer: '현대', model: '아반떼', subModel: '', trim: '' },
  ];
  it('분류', () => {
    expect(rows.map(classifyIdentityRow)).toEqual(['SPLIT_4_TOKENS', 'SPLIT_3_TOKENS', 'RAW_MISALIGNED', 'FILLED_4', 'RAW_NO_DELIMITER', 'FILLED_NO_TRIM', 'EMPTY', 'PARTIAL']);
  });
  it('공급사별 대수 표 — 긴 세부모델(22자 초과)·모델=세부모델도 센다', () => {
    const table = buildIdentityStatusTable([...rows, { supplier: '아이언', manufacturer: '현대', model: '아반떼', subModel: '아반떼', trim: '' }]);
    expect(table.total).toBe(9);
    expect(table.suppliers['손오공']).toMatchObject({ total: 4, longSubModel: 1 });
    expect(table.suppliers['손오공']!.counts).toMatchObject({ SPLIT_4_TOKENS: 1, SPLIT_3_TOKENS: 1, RAW_MISALIGNED: 1, FILLED_4: 1 });
    expect(table.suppliers['아이언']!.modelEqualsSubModel).toBe(1);
    expect(Object.values(table.totals).reduce((a, b) => a + b, 0)).toBe(9);
  });
  it('입력 변환: summary-v1 vehicles 또는 배열만 받는다, 전체 번호는 출력에 없다', () => {
    expect(rowsFromCatalog({ vehicles: [{ supplier: '손오공', subModel: 'x', plate: '123가4567' }] })).toEqual([
      { supplier: '손오공', manufacturer: '', model: '', subModel: 'x', trim: '' }]);
    expect(() => rowsFromCatalog({ nope: 1 })).toThrow('IDENTITY_STATUS_INPUT_INVALID');
  });
});
