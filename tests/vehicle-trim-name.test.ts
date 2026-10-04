import { describe, expect, it } from 'vitest';
import { trimDisplayName } from '../src/domain/vehicle-trim-name.js';

const name = (value: string, origin: '국산' | '수입' = '국산') => trimDisplayName(value, origin).name;
const sub = (value: string) => trimDisplayName(value, '국산', { isSubGrade: true }).name;

describe('F03 세부트림 = 엔카 등급 이름에서 파워트레인 부분을 통째로 버린 것 (모델 → 세부모델 → 파워트레인 → 세부트림, 2026-10-04)', () => {
  it('세부등급이 있으면 그 글자 그대로', () => {
    for (const value of ['프레스티지', 'GT-Line', 'TCe 인스파이어', '플래티넘Ⅰ', '마스터즈 Ⅱ']) expect(sub(value)).toBe(value);
  });

  it('세부등급이 없으면 등급 이름에서 파워트레인(배기량·엔진·연료·구동)을 버린다', () => {
    expect(name('1.4 VVT 스타일')).toBe('스타일');
    expect(name('M16 GDI 프리미어')).toBe('프리미어');
    expect(name('위트 디젤 1.6 VGT 스마트')).toBe('위트 스마트');
    expect(name('1.8 TCe 인스파이어')).toBe('인스파이어');
    expect(name('1.5 dCi LE')).toBe('LE');
    expect(name('퀘스트 2.0 LPe 밴')).toBe('퀘스트 밴');
    expect(name('LPLI 2.0 LPe 택시렌터카')).toBe('택시렌터카');
    expect(name('1.2 LT')).toBe('LT');
    expect(name('HEV 9인승 노블레스')).toBe('노블레스');
    expect(name('터보 인스퍼레이션')).toBe('인스퍼레이션');
    expect(name('SS 6.2 V8')).toBe('SS');
    expect(name('2.2 CRDi 프레스티지')).toBe('프레스티지');
    expect(name('1.6T-GDi')).toBe('기본형');
    expect(name('2.0T-GDi 프리미엄')).toBe('프리미엄');
    expect(name('2.2D 럭셔리')).toBe('럭셔리');
    expect(name('3.3 T AWD 구조변경 (바이퓨얼)')).toBe('구조변경');
    expect(name('하이리무진 구조변경(LPG)')).toBe('하이리무진 구조변경');
    expect(name('트렌디(렌터카)')).toBe('트렌디(렌터카)');
    expect(name('1.4 TSI 프리미엄', '수입')).toBe('프리미엄');
    expect(name('3.3 리미티드 4WD', '수입')).toBe('리미티드');
    expect(name('롱 레인지 AWD', '수입')).toBe('롱 레인지');
    expect(name('2.0 에코부스트 2WD', '수입')).toBe('기본형');
    // 르노 GTe·GDe·E-TECH, LPG 배기량 L3.5, 전기 EV, 미니 ALL4, F03 에 잘려 남은 ECH·Ce
    expect(name('1.6 GTe LE Plus')).toBe('LE Plus');
    expect(name('2.0 GDe LE')).toBe('LE');
    expect(name('1.6 E-TECH 인스파이어 e-시프터')).toBe('인스파이어 e-시프터');
    expect(name('1.5 E-TECH 에스프리 알핀 1955 2WD')).toBe('에스프리 알핀 1955');
    expect(name('L3.5 캠핑카')).toBe('캠핑카');
    expect(name('EV LT 디럭스')).toBe('LT 디럭스');
    expect(name('EV')).toBe('기본형');
    expect(name('ECH 아이코닉')).toBe('아이코닉');
    expect(name('Ce RE 시그니처')).toBe('RE 시그니처');
    expect(name('ALL4 클래식', '수입')).toBe('클래식');
    expect(name('ALL4', '수입')).toBe('기본형');
    expect(trimDisplayName('ALL4 JCW', '수입').modelDesignation).toBe(false);
    // 옵션 이름 속 「터보 패키지」는 파워트레인이 아니다
    expect(name('3.3 GT 마스터즈 터보 패키지')).toBe('GT 마스터즈 터보 패키지');
    expect(name('3.3 GT AWD 마스터즈 터보 패키지')).toBe('GT 마스터즈 터보 패키지');
    // 반례: 예외는 「터보 패키지」 한 묶음뿐
    expect(name('AWD 패키지')).toBe('패키지');
    expect(name('2.0 디젤 패키지')).toBe('패키지');
    expect(name('1.6 터보 프레스티지')).toBe('프레스티지');
    expect(name('터보 인스퍼레이션')).toBe('인스퍼레이션');
  });

  it('인승은 제원 칸이라 뗀다 — 엔카가 인승으로 등급을 나눠도 세부트림은 하나 (대표 2026-10-04)', () => {
    expect(sub('9인승 노블레스')).toBe('노블레스');
    expect(name('디젤 7인승 노블레스')).toBe('노블레스');
    expect(name('가솔린 9인승 하이리무진 (특장업체)')).toBe('하이리무진 (특장업체)');
    expect(name('11인승 어린이 보호차')).toBe('어린이 보호차');
    expect(name('가솔린 5인승 휠체어 리프트')).toBe('휠체어 리프트');
    expect(trimDisplayName('HEV 7인승 X Line', '국산').removed).toEqual(['HEV', '7인승']);
    expect(sub('9인승')).toBe('기본형');
  });

  it('제조사 공식 표기 낱말은 엔카 대신 그 표기 — X Line → X-Line (기준 한 장 2절 6번)', () => {
    expect(sub('시그니처 X Line')).toBe('시그니처 X-Line');
    expect(name('HEV 9인승 X Line')).toBe('X-Line');
    expect(name('xDrive20i X Line', '수입')).toBe('xDrive20i X-Line');
    expect(sub('X-Line')).toBe('X-Line');
    expect(sub('X Liner')).toBe('X Liner');
  });

  it('파워트레인뿐이면 기본형', () => {
    for (const value of ['1.5', '가솔린 3.5 터보 2WD', '가솔린 3.5 터보 e-S/C AWD', '2.5T 가솔린 AWD', 'V6', 'VGT', '3.6 2WD']) expect(name(value)).toBe('기본형');
    expect(name('2.5 2WD', '수입')).toBe('기본형');
    expect(name('RWD', '수입')).toBe('기본형');
  });

  it('모델 번호가 곧 등급인 수입차는 그대로', () => {
    for (const trim of ['520d xDrive M 스포츠', 'S350 d 4MATIC', 'C300 4MATIC 아방가르드', 'AMG E53e 4MATIC+', 'M135i xDrive', 'xDrive20i M 스포츠', 'B5 프로 AWD', '40 TDI 콰트로 프리미엄']) {
      expect(trimDisplayName(trim, '수입')).toEqual({ name: trim, removed: [], undecided: [], modelDesignation: true });
    }
    expect(trimDisplayName('2.0 LPI 프레스티지', '국산').modelDesignation).toBe(false);
  });
});
