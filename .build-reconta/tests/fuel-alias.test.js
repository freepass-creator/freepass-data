import { describe, expect, it } from 'vitest';
import { canonicalFuel, uniqueMasterFuel, masterTrimFuelLookup } from '../src/domain/fuel-alias.js';
import { SPEC_FUEL_VALUES } from '../src/domain/source-spec-validation.js';
import { refillableSpecValues, masterFuelFallback } from '../src/domain/spec-refill.js';
describe('연료 별칭 표(대표 2026-10-19)', () => {
    it('원천 표기를 제원 연료 목록 이름으로만 바꾼다', () => {
        const cases = [['가솔린+전기', '하이브리드'], ['휘발유', '가솔린'], ['경유', '디젤'], ['전기차', '전기'], ['전기(EV)', '전기'], ['EV', '전기'],
            ['HEV', '하이브리드'], ['PHEV', '플러그인 하이브리드'], ['플러그인하이브리드', '플러그인 하이브리드'], ['바이퓨얼', '가솔린+LPG'], ['lpg', 'LPG'], [' 가솔린 ', '가솔린']];
        for (const [raw, want] of cases)
            expect(canonicalFuel(raw), raw).toBe(want);
        // 손오공 API 영문 코드(2026-10-23 RP012 한 대): 대소문자 무시, 차명과 어긋나면 그대로 보류
        expect(canonicalFuel('GASOLINE')).toBe('가솔린');
        expect(canonicalFuel('gasoline')).toBe('가솔린');
        expect(canonicalFuel('GASOLINE', '현대_싼타페_1.6 HEV AWD')).toBeNull();
        expect(canonicalFuel('GASOLINE', '메르세데스-벤츠 E250 아방가르드')).toBe('가솔린');
        expect(canonicalFuel('GASOLINE', '기아 니로 플러그인 하이브리드')).toBeNull(); // PHEV 차명과 어긋나면 보류
        expect(canonicalFuel('ＧＡＳＯＬＩＮＥ')).toBe('가솔린'); // 전각도 NFKC 로 같다
        expect(canonicalFuel(' Gasoline ')).toBe('가솔린');
        for (const v of SPEC_FUEL_VALUES)
            expect(canonicalFuel(v)).toBe(v);
        for (const bad of ['GSL', '', '가솔린/디젤', '수소+전기', null, 3])
            expect(canonicalFuel(bad)).toBeNull();
    });
    it('차명과 정면으로 어긋나면 보류한다', () => {
        expect(canonicalFuel('휘발유', '현대_싼타페_1.6 HEV AWD')).toBeNull();
        expect(canonicalFuel('가솔린+전기', '기아 니로 플러그인 하이브리드')).toBeNull();
        expect(canonicalFuel('가솔린+전기', '현대 투싼 하이브리드 1.6')).toBe('하이브리드');
        expect(canonicalFuel('가솔린', 'Chevrolet Trax')).toBe('가솔린'); // 글자 조각 hev 는 무시
    });
    it('마스터 연료는 하나로 모일 때만', () => {
        expect(uniqueMasterFuel(['하이브리드', '하이브리드'])).toBe('하이브리드');
        expect(uniqueMasterFuel(['하이브리드', '가솔린'])).toBeNull();
        expect(uniqueMasterFuel(['하이브리드', null])).toBeNull();
        expect(uniqueMasterFuel([])).toBeNull();
        const look = masterTrimFuelLookup([
            { names: ['기아', '쏘렌토', '더 뉴 쏘렌토 MQ4', '프레스티지'], specs: { fuel: '가솔린', displacementCc: 2497 } },
            { names: ['기아', '쏘렌토', '더 뉴 쏘렌토 MQ4', '프레스티지'], specs: { fuel: '디젤', displacementCc: 2151 } },
            { names: ['현대', '아반떼', '더 뉴 아반떼 하이브리드 CN7', '모던'], aliases: [[], [], [], ['모던', '모던 플러스']], specs: { fuel: '하이브리드', displacementCc: 1580 } },
        ]);
        const base = { maker: '기아', model: '쏘렌토', sub_model: '더 뉴 쏘렌토 MQ4', trim_name: '프레스티지' };
        expect(look(base)).toBeNull();
        expect(look({ ...base, engine_cc: '2151' })).toBe('디젤');
        expect(look({ maker: '현대', model: '아반떼', sub_model: '더 뉴 아반떼 하이브리드 CN7', trim_name: '모던 플러스' })).toBe('하이브리드');
        expect(look({ maker: '현대', model: '아반떼', sub_model: '없는 세부모델', trim_name: '모던' })).toBeNull();
        // Codex 검토: 차의 연식·배기량과 맞는 행이 없으면 보류(어긋나는 마스터로 채우지 않음)
        const dated = masterTrimFuelLookup([{ names: ['기아', '쏘렌토', '쏘렌토 MQ4', '노블레스'], specs: { fuel: '디젤', displacementCc: 2151 }, modelYearStart: 2020, modelYearEnd: 2022 }]);
        const sorento = { maker: '기아', model: '쏘렌토', sub_model: '쏘렌토 MQ4', trim_name: '노블레스' };
        expect(dated({ ...sorento, year: '2025' })).toBeNull();
        expect(dated({ ...sorento, engine_cc: '1598' })).toBeNull();
        expect(dated({ ...sorento, year: '2021', engine_cc: '2151' })).toBe('디젤');
    });
    it('다시 채움 값: 빈 칸 목록 안에서 형식 맞는 값만, 전기 차 배기량은 뺀다', () => {
        expect(refillableSpecValues({ fuel_type: '전기차', engine_cc: '0', ext_color: '흰색' }, ['fuel_type', 'engine_cc'])).toEqual({ fuel_type: '전기' });
        expect(refillableSpecValues({ fuel_type: '가솔린', ext_color: '흰색' }, ['ext_color'])).toEqual({ ext_color: '흰색' });
        expect(refillableSpecValues({ engine_cc: '1598' }, ['engine_cc'], '', '전기')).toEqual({});
        expect(refillableSpecValues(null, ['fuel_type'])).toEqual({});
    });
    it('마스터 보완은 원천 연료 원문이 아예 없을 때만, 차명과 어긋나지 않을 때만(Codex 검토)', () => {
        expect(masterFuelFallback({ spec: {} }, '하이브리드', '아반떼 하이브리드')).toBe('하이브리드');
        expect(masterFuelFallback({ spec: { fuel_type: 'GSL' } }, '하이브리드')).toBeNull(); // 해석 못 한 원천도 «있음»
        expect(masterFuelFallback({ list: { fuel: '휘발유' } }, '하이브리드')).toBeNull(); // 손오공 목록 원문
        expect(masterFuelFallback({ source_fuel_text: 'EV' }, '전기')).toBeNull(); // 오토플러스 원문 표기
        expect(masterFuelFallback({}, '하이브리드', '니로 플러그인 하이브리드')).toBeNull(); // 차명 어긋남
        expect(masterFuelFallback({}, undefined)).toBeNull();
        expect(masterFuelFallback({ spec: { fuel_type: 1 } }, 'LPG')).toBeNull(); // 형식 틀린 원천 값도 «있음»
        expect(masterFuelFallback({ list: { fuel: 1 } }, 'LPG')).toBeNull();
        expect(masterFuelFallback({ spec: { fuel_type: '' }, list: { fuel: null } }, 'LPG')).toBe('LPG');
    });
});
