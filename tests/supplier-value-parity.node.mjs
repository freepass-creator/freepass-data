import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_MAPS, compareSupplier, parseDate, _judgeForTest as judge } from '../scripts/supplier-value-parity-lib.mjs';

test('날짜는 형식이 달라도 같은 날이면 일치', () => {
  assert.deepEqual(parseDate('23-6-5'), { y: 2023, m: 6, d: 5 });
  assert.equal(compareSupplier({ map: { plate: 'p', fields: [FIELD_MAPS.aica.fields.find(f => f.kind === 'date')] }, samples: 1,
    sourceRows: [{ cells: { p: '11가1111', 최초등록: '23-6-5' } }], products: [{ car_number: '11가1111', first_registration_date: '2023-06-05' }] }).fields[0].match, 1);
});

test('원문 보존 항목은 정제 차이를 허용하지 않고, 정제 항목은 정제 차이로 센다', () => {
  const r = compareSupplier({ map: FIELD_MAPS.aica, samples: 1,
    sourceRows: [{ cells: { 차량번호: '11가1111', 트림: 'A B', 제조사: '르노(삼성)' } }],
    products: [{ car_number: '11가1111', 원문: { 차명: 'A C' }, maker: '르노코리아', listable: true }] });
  assert.equal(r.fields.find(f => f.field.startsWith('차명')).mismatch, 1);
  assert.equal(r.fields.find(f => f.field.startsWith('제조사')).normalized, 1);
});

test('원본에서 사라진 판매 중 차량을 센다, 번호는 끝 4자리만', () => {
  const r = compareSupplier({ map: FIELD_MAPS.aica, samples: 1, sourceRows: [{ cells: { 차량번호: '22나2222' } }],
    products: [{ car_number: '33다3333', listable: true }] });
  assert.equal(r.onlyDataListable, 1);
  assert.deepEqual(r.onlySource, ['2222']);
});

test('정제 항목은 검증된 변환만 normalized — 다른 제조사·다른 연료는 mismatch(관문 P1)', () => {
  const maker = { kind: 'refined', vk: 'maker' }, fuel = { kind: 'refined', vk: 'fuel' };
  assert.equal(judge(maker, '현대', '기아'), 'mismatch');
  assert.equal(judge(maker, '현대자동차', '현대'), 'normalized');
  assert.equal(judge(fuel, '디젤', '가솔린'), 'mismatch');
  assert.equal(judge(fuel, '경유', '디젤'), 'normalized');
  assert.equal(judge(fuel, '하이브리드', '가솔린'), 'mismatch');
});

test('원문 보존 항목은 글자 그대로만 match, 공백 차이는 형식 차이로 따로 센다(exactRate 제외)', () => {
  const raw = { kind: 'raw' };
  assert.equal(judge(raw, 'AB', 'AB'), 'match');
  assert.equal(judge(raw, 'AB', 'A B'), 'normalized');
  assert.equal(judge(raw, 'AB', 'AC'), 'mismatch');
});
