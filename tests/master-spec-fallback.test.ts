import { describe, expect, it } from 'vitest';
import { masterTrimSpecLookup, masterSpecFallback, masterSpecFillValues } from '../src/domain/spec-refill.js';
import { masterTrimFuelLookup } from '../src/domain/fuel-alias.js';
import { masterSpecsOf, sourceSpecRefillFields, sourceSpecFillFields } from '../src/infra/source-cycle-firestore.js';

// 마스터 제원 보완(대표 2026-10-22 «F01/ERP5 빈칸이 너무 많다»): 인승·구동방식·배기량. 값은 전부 합성.
const names = ['현대', '아반떼', '더 뉴 아반떼 CN7', '모던'] as const;
const row = (specs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ masterId: 'M1', names: [...names], aliases: [[], [], [], []], specs: { fuel: '가솔린', displacementCc: 1598, drive: '2WD', seats: 5, ...specs }, ...extra });
const id = { maker: '현대', model: '아반떼', sub_model: '더 뉴 아반떼 CN7', trim_name: '모던', master_id: 'M1' };

describe('masterTrimSpecLookup(순수): 트림 행이 하나로 모이는 칸만', () => {
  it('행이 하나면 인승·구동·배기량을 문자열로 준다', () => {
    expect(masterTrimSpecLookup([row({})])(id)).toEqual({ seats: '5', drive_type: '2WD', engine_cc: '1598' });
  });
  it('후보 행이 여러 개여서 값이 갈리면 그 칸은 보류(하나로 모이는 칸만)', () => {
    const look = masterTrimSpecLookup([row({}), row({ drive: 'AWD' }), row({ seats: 5, displacementCc: 1598 })]);
    expect(look(id)).toEqual({ seats: '5', engine_cc: '1598' });   // 구동이 2WD/AWD 로 갈림
  });
  it('어느 한 행이라도 값이 비거나 목록 밖이면 그 칸은 보류', () => {
    expect(masterTrimSpecLookup([row({}), row({ seats: null })])(id)).toEqual({ drive_type: '2WD', engine_cc: '1598' });
    expect(masterTrimSpecLookup([row({ drive: '전륜' })])(id)).toEqual({ seats: '5', engine_cc: '1598' });
  });
  it('vehicle_master_id 가 없거나 다른 마스터 행이면 아무것도 주지 않는다', () => {
    expect(masterTrimSpecLookup([row({})])({ ...id, master_id: '' })).toEqual({});
    expect(masterTrimSpecLookup([row({}, { masterId: 'M2' })])(id)).toEqual({});
  });
  it('전기·수소(문서 연료 또는 행 연료)는 배기량을 주지 않는다', () => {
    expect(masterTrimSpecLookup([row({ fuel: '전기', displacementCc: null })])(id)).toEqual({ seats: '5', drive_type: '2WD' });
    expect(masterTrimSpecLookup([row({ fuel: '전기' })])(id)).toEqual({ seats: '5', drive_type: '2WD' });   // 행에 배기량이 잘못 있어도
    expect(masterTrimSpecLookup([row({ fuel: null })])({ ...id, fuel_type: '수소' })).toEqual({ seats: '5', drive_type: '2WD' });
  });
  it('문서에 이미 있는 연료·구동·인승·연식과 정면으로 어긋나는 행은 빼고, 값이 없는 행은 후보로 남긴다', () => {
    const look = masterTrimSpecLookup([row({ drive: '2WD', seats: 5 }), row({ drive: 'AWD', seats: 7 })]);
    expect(look({ ...id, drive_type: 'AWD' })).toEqual({ seats: '7', drive_type: 'AWD', engine_cc: '1598' });
    expect(look({ ...id, seats: '5' })).toEqual({ seats: '5', drive_type: '2WD', engine_cc: '1598' });
    const fuel = masterTrimSpecLookup([row({ fuel: '가솔린', seats: 5 }), row({ fuel: null, seats: 7 })]);
    expect(fuel({ ...id, fuel_type: '가솔린' })).toEqual({ drive_type: '2WD', engine_cc: '1598' });   // 연료 모르는 행은 후보로 남아 인승 보류
    const dated = masterTrimSpecLookup([row({ seats: 5 }, { modelYearStart: 2020, modelYearEnd: 2022 }), row({ seats: 7 }, { modelYearStart: 2023, modelYearEnd: null })]);
    expect(dated({ ...id, year: '2024' }).seats).toBe('7');
    expect(dated(id).seats).toBeUndefined();
  });
  it('세부트림 별칭으로도 맞추고, 연료 조회는 기존과 같다(행 선택 공유 회귀)', () => {
    const aliased = [row({}, { names: ['현대', '아반떼', '더 뉴 아반떼 CN7', '모던 플러스'], aliases: [[], [], [], ['모던']] })];
    expect(masterTrimSpecLookup(aliased)(id)).toEqual({ seats: '5', drive_type: '2WD', engine_cc: '1598' });
    expect(masterTrimFuelLookup(aliased)(id)).toBe('가솔린');
  });
});

describe('masterSpecFallback(계획): 원천에 그 칸 원문이 있으면 원천 우선', () => {
  const planned = { seats: '5', drive_type: '2WD', engine_cc: '1598' };
  it('원천에 원문이 없는 칸만 남긴다', () => {
    expect(masterSpecFallback({ spec: {} }, planned)).toEqual(planned);
    expect(masterSpecFallback({ spec: { seats: '7' } }, planned)).toEqual({ drive_type: '2WD', engine_cc: '1598' });
    expect(masterSpecFallback({ spec: { engine_cc: 'abc', drivetrain: 'FF' } }, planned)).toEqual({ seats: '5' });   // 형식 틀린 원문도 «있음»
    expect(masterSpecFallback({ spec: { seats: '', engine_cc: null } }, planned)).toEqual(planned);              // 빈 값만 «없음»
    expect(masterSpecFallback({ spec: { seats: '5', engine_cc: '1598', drive_type: '2WD' } }, planned)).toBeNull();
  });
  it('형식 밖 마스터 값·빈 계획은 버린다', () => {
    expect(masterSpecFallback({}, { seats: '0', drive_type: 'FWD', engine_cc: '12' })).toBeNull();
    expect(masterSpecFallback({}, undefined)).toBeNull();
  });
});

describe('쓰기: 빈 칸만, 기존 값 보존, 원천 값 우선, 전기 배기량 제외', () => {
  const masterSpecs = { seats: '5', drive_type: '2WD', engine_cc: '1598' };
  it('masterSpecFillValues: 문서 칸이 비고 원천으로 채우지 않은 칸만', () => {
    expect(masterSpecFillValues({}, {}, masterSpecs)).toEqual(masterSpecs);
    expect(masterSpecFillValues({ seats: '7', drive_type: 'AWD' }, {}, masterSpecs)).toEqual({ engine_cc: '1598' });   // 기존 값 보존
    expect(masterSpecFillValues({}, { engine_cc: '1591' }, masterSpecs)).toEqual({ seats: '5', drive_type: '2WD' });   // 원천 값이 이긴다
    expect(masterSpecFillValues({ fuel_type: '전기' }, {}, masterSpecs)).toEqual({ seats: '5', drive_type: '2WD' });
    expect(masterSpecFillValues({}, { fuel_type: '수소' }, masterSpecs)).toEqual({ seats: '5', drive_type: '2WD' });
    expect(masterSpecFillValues({}, {}, null)).toEqual({});
  });
  it('sourceSpecRefillFields(확인 표식 문서): 원천 값 + 마스터 제원(빈 칸만)', () => {
    const doc = { vehicle_spec_source_checked: true, fuel_type: '가솔린', ext_color: '흰색', seats: '7' };
    expect(sourceSpecRefillFields({ engine_cc: '1591' }, doc, '', null, masterSpecs)).toEqual({ engine_cc: '1591', drive_type: '2WD' });
    expect(sourceSpecRefillFields({}, { ...doc, fuel_type: '전기' }, '', null, masterSpecs)).toEqual({ drive_type: '2WD' });
    expect(sourceSpecRefillFields({}, { ...doc, vehicle_spec_source_checked: undefined }, '', null, masterSpecs)).toEqual({});
  });
  it('sourceSpecFillFields(첫 채움 문서): 마스터 연료가 전기면 마스터 배기량도 쓰지 않는다', () => {
    expect(sourceSpecFillFields({}, {}, '', '전기', masterSpecs)).toEqual({ fuel_type: '전기', seats: '5', drive_type: '2WD' });
    expect(sourceSpecFillFields({ seats: '4' }, {}, '', null, masterSpecs)).toEqual({ seats: '4', drive_type: '2WD', engine_cc: '1598' });
  });
});

describe('masterSpecsOf(읽기 경로): 확정 정체성 + vehicle_master_id + 빈 칸', () => {
  const look = masterTrimSpecLookup([row({})]);
  const doc = { maker: '현대', model: '아반떼', sub_model: '더 뉴 아반떼 CN7', trim_name: '모던', vehicle_review_required: false, vehicle_master_id: 'M1', fuel_type: '가솔린' };
  it('빈 칸만 마스터 값으로, 채울 칸이 없으면 null', () => {
    expect(masterSpecsOf(doc, look)).toEqual({ seats: '5', drive_type: '2WD', engine_cc: '1598' });
    expect(masterSpecsOf({ ...doc, seats: '5' }, look)).toEqual({ drive_type: '2WD', engine_cc: '1598' });   // 값이 있는 칸은 고르지 않는다
    expect(masterSpecsOf({ ...doc, drive_type: 'AWD' }, look)).toBeNull();   // 문서 구동과 마스터 행이 정면으로 어긋나면 보류(기존 값도 그대로)
    expect(masterSpecsOf({ ...doc, seats: '5', drive_type: '2WD', engine_cc: '1598' }, look)).toBeNull();
  });
  it('마스터 연결·정체성 확정·조회기가 없으면 null, 전기 문서는 배기량을 고르지 않는다', () => {
    expect(masterSpecsOf({ ...doc, vehicle_master_id: '' }, look)).toBeNull();
    expect(masterSpecsOf({ ...doc, vehicle_review_required: true }, look)).toBeNull();
    expect(masterSpecsOf({ ...doc, trim_name: '' }, look)).toBeNull();
    expect(masterSpecsOf(doc, null)).toBeNull();
    expect(masterSpecsOf({ ...doc, fuel_type: '전기' }, masterTrimSpecLookup([row({ fuel: null })]))).toEqual({ seats: '5', drive_type: '2WD' });
  });
});
