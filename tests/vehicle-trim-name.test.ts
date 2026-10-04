import { describe, expect, it } from 'vitest';
import { trimDisplayName } from '../src/domain/vehicle-trim-name.js';

const name = (value: string, origin: '국산' | '수입' = '국산') => trimDisplayName(value, origin).name;

describe('F03 세부트림 display name (Encar end level minus powertrain, 2026-10-04)', () => {
  it('drops displacement, fuel, engine and drive markers and keeps the grade', () => {
    expect(name('1.2 LT')).toBe('LT');
    expect(name('1.8 TCe 인스파이어')).toBe('TCe 인스파이어');
    expect(name('가솔린 1.6 터보 2WD')).toBe('터보');
    expect(name('SS 6.2 V8')).toBe('SS V8');
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

  it('keeps engine-type names like TSI/TDI (GDi·T-GDi·CRDi·MPi·VVT·V6), drops only displacement·fuel·drive', () => {
    expect(name('3.3 GDI 구조변경 (LPG)')).toBe('GDI 구조변경');
    expect(name('3.3 T-GDI 구조변경 (LPG)')).toBe('T-GDI 구조변경');
    expect(name('2.2 CRDi 프레스티지')).toBe('CRDi 프레스티지');
    expect(name('1.4 VVT 모던')).toBe('VVT 모던');
    expect(name('2.5 V6')).toBe('V6');
    expect(name('1.6 MPi 스마트')).toBe('MPi 스마트');
    expect(name('HEV 9인승 노블레스')).toBe('9인승 노블레스');
    expect(name('프리미엄 RWD', '수입')).toBe('프리미엄');
  });

  it('keeps engine names and drops LPG fuel labels (decided 2026-10-04)', () => {
    expect(trimDisplayName('위트 디젤 1.6 VGT 스마트', '국산')).toEqual({ name: '위트 VGT 스마트', removed: ['디젤', '1.6'], undecided: [], modelDesignation: false });
    expect(name('dCi RE')).toBe('dCi RE');
    expect(name('터보 인스퍼레이션')).toBe('터보 인스퍼레이션');
    expect(name('1.4 TSI 프레스티지', '수입')).toBe('TSI 프레스티지');
    expect(name('2.0 에코부스트 2WD', '수입')).toBe('에코부스트');
    expect(name('퀘스트 2.0 LPe 밴')).toBe('퀘스트 밴');
    expect(name('LPLI 2.0 LPe 택시렌터카')).toBe('택시렌터카');
    expect(name('LPe RE')).toBe('RE');
  });
});
