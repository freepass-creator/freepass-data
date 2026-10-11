import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_MAPS, compareSupplier, parseDate } from '../scripts/supplier-value-parity-lib.mjs';

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
