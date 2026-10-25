import { describe, expect, it } from 'vitest';
import { sheetFactsOf, validSheetFacts, sheetFactPlan, sheetFactState, sheetFactFields, composeVehicleClass, SHEET_FACT_KEYS } from '../src/domain/sheet-facts.js';
// 2026-10-23 손실 칸 조사 (b): 시트 «차종크기»·«차종구분» → 문서 vehicle_class 후보(크기 또는 «크기 차체»). 쓰기는 기존 SHEET_FACT 경로(기본 꺼짐, 빈 칸에만). 값은 합성.
describe('차종(vehicle_class) 후보: 시트 «차종크기»·«차종구분» 두 칸', () => {
    it('크기+차체가 모두 어휘 안이면 «크기 차체», 크기만 있고 차체가 비면 «크기»', () => {
        expect(composeVehicleClass('중형', '세단')).toBe('중형 세단');
        expect(composeVehicleClass('준대형', 'SUV')).toBe('준대형 SUV');
        expect(composeVehicleClass(' 소형 ', ' MPV ')).toBe('소형 MPV');
        expect(composeVehicleClass('대형', '')).toBe('대형');
        expect(composeVehicleClass('대형', undefined)).toBe('대형');
    });
    it('차체만 있거나 어휘 밖(오타 «준준형», 상품구분·모델명)이면 후보 없음 — 추측하지 않는다', () => {
        expect(composeVehicleClass('', '세단')).toBeNull();
        expect(composeVehicleClass('준준형', '세단')).toBeNull();
        expect(composeVehicleClass('중형', '세단형')).toBeNull();
        expect(composeVehicleClass('중고렌트', '')).toBeNull();
        expect(composeVehicleClass('아르카나', 'SUV')).toBeNull();
        expect(composeVehicleClass(null, null)).toBeNull();
    });
    it('헤더 이름으로 읽는다: 차종크기 칸이 없으면 후보 없음, 차종구분 칸만 없으면 크기만', () => {
        expect(sheetFactsOf(['차종크기', '차종구분', '원산지'], ['중형', 'SUV', '국산'])).toEqual({ origin: '국산', vehicle_class: '중형 SUV' });
        expect(sheetFactsOf(['차종구분'], ['세단'])).toBeUndefined();
        expect(sheetFactsOf(['차종크기'], ['소형'])).toEqual({ vehicle_class: '소형' });
        expect(sheetFactsOf(['차종크기', '차종구분'], ['준준형', '세단'])).toBeUndefined();
    });
    it('저장된 후보 재검증·계획·쓰기: 빈 칸만 채우고, 크기만 있는 기존 값은 충돌로 세며 덮지 않는다', () => {
        expect(SHEET_FACT_KEYS).toContain('vehicle_class');
        expect(validSheetFacts({ vehicle_class: '중형 세단', origin: '??' })).toEqual({ vehicle_class: '중형 세단' });
        expect(validSheetFacts({ vehicle_class: '중고렌트' })).toBeUndefined();
        const enabled = ['vehicle_class'];
        expect(sheetFactPlan(sheetFactState({ vehicle_class: '' }, enabled), { vehicle_class: '중형 세단' }, enabled)).toEqual({ fill: ['vehicle_class'], conflicts: [] });
        expect(sheetFactPlan(sheetFactState({ vehicle_class: '중형' }, enabled), { vehicle_class: '중형 세단' }, enabled)).toEqual({ fill: [], conflicts: ['vehicle_class'] });
        expect(sheetFactPlan(sheetFactState({ vehicle_class: '중형 세단' }, enabled), { vehicle_class: '중형 세단' }, enabled)).toEqual({ fill: [], conflicts: [] });
        expect(sheetFactFields({ vehicle_class: '중형 세단' }, { vehicle_class: '' }, enabled)).toEqual({ vehicle_class: '중형 세단' });
        expect(sheetFactFields({ vehicle_class: '중형 세단' }, { vehicle_class: '중형' }, enabled)).toEqual({});
    });
});
