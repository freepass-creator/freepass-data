import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, productPhotoPath } from '../scripts/iancar-photo-gate-measure.mjs';

test('200 응답 수와 실패 번호(끝 4자리) 집계', () => {
  const s = summarize([
    { last4: '1111', manifest: 200, first: 200 }, { last4: '2222', manifest: 200, first: 404 },
    { last4: '3333', manifest: 404, first: 404 }, { last4: '4444', manifest: 200, first: 200 },
  ]);
  assert.equal(s.total, 4); assert.equal(s.both200, 2); assert.equal(s.manifest200, 3); assert.equal(s.first200, 2);
  assert.deepEqual(s.failedLast4, ['2222', '3333']);
  assert.deepEqual(s.byStatusPair, { '200/200': 2, '200/404': 1, '404/404': 1 });
});
test('빈 입력', () => assert.equal(summarize([]).total, 0));

test('사진 경로는 상품 ID 만 인코딩하고 / 를 보존한다', () => {
  assert.equal(productPhotoPath('iancar_abc'), 'iancar_abc/photos');
  assert.equal(productPhotoPath('iancar_abc', 0), 'iancar_abc/photos/0');
  assert.equal(productPhotoPath('a/b c', 2), 'a%2Fb%20c/photos/2');
  assert.ok(!productPhotoPath('x', 1).includes('%2F'));
});
