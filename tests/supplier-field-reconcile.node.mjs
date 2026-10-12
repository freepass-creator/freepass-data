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

test('쉼표 숫자는 날짜로 오해하지 않는다', () => {
  assert.equal(classifyField('1,300,000', '1300000'), 'FORMAT_ONLY');
  assert.equal(classifyField('2021-03-05', '2021.3.5'), 'FORMAT_ONLY');
});

test('날짜 자리수·배기량 반올림', () => {
  assert.equal(classifyField('21-05-14', '2021-05-14'), 'FORMAT_ONLY');
  assert.equal(classifyField('26-06', '26-6'), 'FORMAT_ONLY');
  assert.equal(classifyField('3,500', '3470', 'engine_cc'), 'NEAR_NUMERIC');
  assert.equal(classifyField('3,500', '2000', 'engine_cc'), 'VALUE_DIFF');
});

import { makeCauseClassifier, rawAnomaly } from '../scripts/supplier-field-reconcile-lib.mjs';
test('별칭·무보증은 일치로 본다', () => {
  assert.equal(classifyField('HEV', '하이브리드', 'fuel_type'), 'FORMAT_ONLY');
  assert.equal(classifyField('검정색', '블랙', 'ext_color'), 'FORMAT_ONLY');
  assert.equal(classifyField('무보증', '', 'price.48.deposit'), 'MATCH');
  assert.equal(classifyField('무보증', 2000000, 'price.48.deposit'), 'VALUE_DIFF');
});
test('원인 분류: 저장된 원문이 원천과 다르면 수집 지연, 같으면 정제 오류', () => {
  const c = makeCauseClassifier({ storedRaw: (d, f) => d.stored[f] });
  assert.equal(c({ type: 'VALUE_DIFF', field: 'mileage', raw: '100', data: '90', dataRec: { stored: { mileage: '90' } } }), 'COLLECTION_LAG');
  assert.equal(c({ type: 'VALUE_DIFF', field: 'model', raw: 'A', data: 'B', dataRec: { stored: { model: 'A' } } }), 'REFINEMENT_ERROR');
  assert.equal(c({ type: 'ONLY_IN_DATA' }), 'SOURCE_CHANGE');
  assert.equal(c({ type: 'MISSING_IN_DATA' }), 'COLLECTION_LAG');
  assert.equal(c({ type: 'VALUE_DIFF', field: 'mileage', raw: 'abc', data: '1', dataRec: { stored: {} } }), 'SOURCE_ANOMALY');
  assert.equal(rawAnomaly('price.36.rent', '0'), true);
});

import { dossierToProduct } from '../scripts/supplier-origin-verify.mjs';
test('ProductDossier/v1 → 대조용 상품 문서', () => {
  const doc = dossierToProduct({ schema: 'ProductDossier/v1', productId: '11가1111', status: 'OK', fields: [
    { path: 'product.maker', group: 'BASIC', normalizedValue: '기아', rawValue: '기아', rawRef: { supplierCode: 'RP004', rawPath: '원문.전체.제조사' }, source: 'REFINED', asOf: 't' },
    { path: 'priceRow[source:36].monthlyRent', group: 'PRICE_ROW', normalizedValue: 700000, source: 'REFINED', asOf: 't' },
    { path: 'priceRow[source:36].deposit', group: 'PRICE_ROW', normalizedValue: 1000000, source: 'REFINED', asOf: 't' }] });
  assert.equal(doc.maker, '기아'); assert.equal(doc.price['36'].rent, 700000); assert.equal(doc.provider_company_code, 'RP004'); assert.equal(doc.원문.전체['제조사'], '기아');
  assert.equal(dossierToProduct({ schema: 'x' }), null);
});
