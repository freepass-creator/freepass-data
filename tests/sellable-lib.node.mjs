import test from 'node:test';
import assert from 'node:assert/strict';
import { f05RowSellable, hiddenRowsByTab } from '../scripts/sellable-lib.mjs';

test('출고불가 외 전부 판매 가능, 숨긴 줄은 출고가능이어도 판매 불가', () => {
  assert.equal(f05RowSellable({ status: '출고가능' }), true);
  assert.equal(f05RowSellable({ status: '상품화중' }), true);
  assert.equal(f05RowSellable({ status: '' }), true);
  assert.equal(f05RowSellable({ status: '출고불가' }), false);
  assert.equal(f05RowSellable({ status: '출고가능', hidden: true }), false); // 시험 사례: 출고가능 + 숨김 → 판매 불가
});

test('rowMetadata 의 hiddenByUser·hiddenByFilter 줄 번호(1부터)', () => {
  const m = hiddenRowsByTab({ sheets: [{ properties: { title: '스타' }, data: [{ startRow: 0, rowMetadata: [{}, { hiddenByUser: true }, {}, { hiddenByFilter: true }, { hiddenByUser: false }] }] },
    { properties: { title: 'KH' }, data: [{ rowMetadata: [] }] }] });
  assert.deepEqual([...m.get('스타')].sort(), [2, 4]);
  assert.equal(m.get('KH').size, 0);
});

import { assertPlanComplete } from '../scripts/sellable-lib.mjs';
test('fail-closed: 읽기 불완전(blockers)이 있으면 계획 생성을 중단한다', () => {
  assert.doesNotThrow(() => assertPlanComplete([]));
  const origError = console.error; console.error = () => {};
  try { assert.throws(() => assertPlanComplete(['HIDDEN_ROW_METADATA_READ_FAILED']), /PLAN_BLOCKED/); } finally { console.error = origError; }
});

import { assertPrivateOutputPath, maskPlates } from '../scripts/sellable-lib.mjs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('차량번호는 끝 4자리만, 증거 파일은 저장소 밖에만', () => {
  assert.equal(maskPlates('차 123가4567 와 98 나 1234'), '차 …4567 와 …1234');
  assert.equal(maskPlates({ a: { b: '12가3456' } }).includes('12가3456'), false);
  const repoFile = join(fileURLToPath(new URL('..', import.meta.url)), 'evidence.json');
  assert.throws(() => assertPrivateOutputPath(repoFile), /OUTPUT_PATH_INSIDE_REPOSITORY/);
  assert.doesNotThrow(() => assertPrivateOutputPath(join(tmpdir(), 'evidence.json')));
  assert.doesNotThrow(() => assertPrivateOutputPath(undefined));
});
