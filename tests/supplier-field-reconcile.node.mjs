import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyField, normalize, reconcile } from '../scripts/supplier-field-reconcile-lib.mjs';

test('정규화: 쉼표·단위·날짜 구분자·공백', () => {
  assert.equal(normalize('1,234,000원'), '1234000');
  assert.equal(normalize('2021-03-05'), '20210305');
  assert.equal(normalize('2021.3.5'), '20210305');
  assert.equal(normalize('  쏘나타  DN8 '), '쏘나타dn8');
  assert.equal(normalize(['b', 'a']), 'a|b');
});

test('항목 분류', () => {
  assert.equal(classifyField('1000', '1000'), 'MATCH');
  assert.equal(classifyField('1,000원', 1000), 'FORMAT_ONLY');
  assert.equal(classifyField('1000', '2000'), 'VALUE_DIFF');
  assert.equal(classifyField('x', ''), 'EMPTY_IN_DATA');
  assert.equal(classifyField('', 'x'), 'EMPTY_IN_RAW');
  assert.equal(classifyField('', null), 'BOTH_EMPTY');
});

test('차량 단위 불일치와 마지막 4자리만 보고', () => {
  const raw = [{ car_number: '11가1111', price: '1,000' }, { car_number: '22나2222', price: '5' }, { car_number: '33다3333', price: '7' }];
  const data = [{ car_number: '11가1111', price: 1000 }, { car_number: '22나2222', price: 6 }, { car_number: '99라9999', price: 1 }];
  const r = reconcile(raw, data, { fields: ['price'] });
  assert.equal(r.commonVehicles, 2); assert.equal(r.types.MISSING_IN_DATA, 1); assert.equal(r.types.ONLY_IN_DATA, 1);
  assert.equal(r.types.FORMAT_ONLY, 1); assert.equal(r.types.VALUE_DIFF, 1);
  assert.equal(r.fieldMatchRate, 0.5); assert.equal(r.fieldExactRate, 0);
  assert.equal(r.samples.MISSING_IN_DATA[0].plate4, '3333');
  assert.ok(!JSON.stringify(r).includes('33다3333'));
});

test('중복 차량번호 표시', () => {
  const r = reconcile([{ car_number: '1', price: 1 }, { car_number: '1', price: 1 }], [], { fields: ['price'] });
  assert.equal(r.types.DUPLICATE_PLATE, 1);
});
