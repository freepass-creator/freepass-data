import { describe, expect, it } from 'vitest';
import { trimDisplayName } from '../src/domain/vehicle-trim-name.js';

const name = (value: string, origin: '국산' | '수입' = '국산') => trimDisplayName(value, origin).name;

describe('F03 세부트림 display name (Encar end level minus powertrain, 2026-10-04)', () => {
  it('drops displacement, fuel, engine and drive markers and keeps the grade', () => {
    expect(name('1.2 LT')).toBe('LT');
    expect(name('1.8 TCe 인스파이어')).toBe('TCe 인스파이어');
    expect(name('가솔린 1.6 터보 2WD')).toBe('터보');
    expect(name('SS 6.2 V8')).toBe('SS');
    expect(name('HEV 9인승 노블레스')).toBe('9인승 노블레스');
    expect(name('3.3 리미티드 4WD', '수입')).toBe('리미티드');
    expect(name('롱 레인지 AWD', '수입')).toBe('롱 레인지');
    expect(name('2.5 2WD 하이브리드 XLE', '수입')).toBe('XLE');
    expect(name('3.5 구조변경 (바이퓨얼)')).toBe('구조변경');
    expect(name('하이리무진 구조변경(LPG)')).toBe('하이리무진 구조변경');
    expect(name('트렌디(렌터카)')).toBe('트렌디(렌터카)');  });

  it('leaves non-powertrain trims letter for letter (no Unicode folding)', () => {
    for (const trim of ['플래티넘Ⅰ', '마스터즈 Ⅱ', '시그니처 X Line', '9인승 노블레스']) expect(name(trim)).toBe(trim);
  });

  it('becomes 기본형 when nothing but powertrain is left', () => {
    expect(name('1.5')).toBe('기본형');
    expect(name('2.5 2WD', '수입')).toBe('기본형');
    expect(name('RWD', '수입')).toBe('기본형');
  });

  it('keeps import trims whose first word is the model designation untouched', () => {
    for (const trim of ['520d xDrive M 스포츠', 'S350 d 4MATIC', 'C300 4MATIC 아방가르드', 'AMG E53e 4MATIC+', 'M135i xDrive', 'xDrive20i M 스포츠', 'B5 프로 AWD']) {
      expect(trimDisplayName(trim, '수입')).toEqual({ name: trim, removed: [], undecided: [], modelDesignation: true });
    }
    expect(trimDisplayName('2.0 LPI 프레스티지', '국산').modelDesignation).toBe(false);
  });

  it('keeps undecided engine words and reports them', () => {
    expect(trimDisplayName('위트 디젤 1.6 VGT 스마트', '국산')).toEqual({ name: '위트 VGT 스마트', removed: ['디젤', '1.6'], undecided: ['VGT'], modelDesignation: false });
    expect(trimDisplayName('dCi RE', '국산').undecided).toEqual(['dCi']);
  });
});
