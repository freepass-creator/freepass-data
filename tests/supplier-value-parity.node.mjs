import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_MAPS, compareSupplier, parseDate, createSupplierProductReader, PARITY_PRODUCT_FIELDS, parityProductPageQuery, _judgeForTest as judge } from '../scripts/supplier-value-parity-lib.mjs';

test('모든 비교 매퍼가 읽는 상품 필드를 mask가 포함하고 사진·비관련 원문은 전송하지 않음', () => {
  const reads = new Set();
  const record = new Proxy({}, { get: (_, key) => { reads.add(key); return undefined; } });
  for (const map of Object.values(FIELD_MAPS)) for (const field of map.fields) field.data(record);
  for (const field of [...reads, 'car_number', 'listable', 'provider_company_code', 'partner_code']) assert.ok(PARITY_PRODUCT_FIELDS.includes(field), `missing comparison field: ${field}`);
  const query = parityProductPageQuery('a+/=&token');
  assert.equal(query.get('pageToken'), 'a+/=&token');
  assert.equal(query.get('pageSize'), '300');
  assert.deepEqual(query.getAll('mask.fieldPaths'), PARITY_PRODUCT_FIELDS.map(f => f === '원문' ? '`원문`' : f));
  assert.ok(!query.getAll('mask.fieldPaths').includes('photo_original_refs'));
});

test('공급사 여러 개와 동시 호출도 실행당 products 전량 읽기는 한 번, 공급사 판정은 기존과 동일', async () => {
  let scans = 0;
  const products = [{ provider_company_code: 'A', partner_code: 'B' }, { partner_code: 'B' }, { provider_company_code: '', partner_code: 'B' }];
  const read = createSupplierProductReader(async () => { scans++; return products; });
  const [a, b, empty] = await Promise.all([read('A'), read('B'), read('C')]);
  assert.equal(scans, 1);
  assert.deepEqual(a, products.filter(f => (f.provider_company_code || f.partner_code) === 'A'));
  assert.deepEqual(b, products.filter(f => (f.provider_company_code || f.partner_code) === 'B'));
  assert.deepEqual(empty, []);
  await read('A'); assert.equal(scans, 1);
  const nextRun = createSupplierProductReader(async () => { scans++; return products; });
  await nextRun('A'); assert.equal(scans, 2);
});

test('불완전한 전체 읽기는 다음 공급사에서도 실패하며 추가 조회나 부분 성공 없음', async () => {
  let scans = 0;
  const read = createSupplierProductReader(async () => { scans++; throw new Error('FIRESTORE_READ_503'); });
  await assert.rejects(read('A'), /FIRESTORE_READ_503/);
  await assert.rejects(read('B'), /FIRESTORE_READ_503/);
  assert.equal(scans, 1);
});

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

test('빌린카 매핑에도 제조사·연료 검증이 연결되고, 복합 연료는 일반 연료군에 흡수되지 않는다(관문 2차 P1)', () => {
  for (const key of ['aica', 'billincar']) {
    const fm = FIELD_MAPS[key].fields;
    assert.equal(fm.find(f => f.field.startsWith('제조사')).vk, 'maker', key);
    assert.equal(fm.find(f => f.field.startsWith('연료')).vk, 'fuel', key);
  }
  const fuel = { kind: 'refined', vk: 'fuel' }, maker = { kind: 'refined', vk: 'maker' };
  assert.equal(judge(fuel, '가솔린', '가솔린하이브리드'), 'mismatch');
  assert.equal(judge(fuel, '가솔린하이브리드', '가솔린'), 'mismatch');
  assert.equal(judge(fuel, '하이브리드', '가솔린하이브리드'), 'normalized');
  assert.equal(judge(maker, '현대', '현대기아'), 'mismatch');
  assert.equal(judge(maker, '현대자동차', '현대'), 'normalized');
});
