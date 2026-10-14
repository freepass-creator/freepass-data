import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain ESM script without type declarations
import { cycleSummaryMarkdown } from '../scripts/ci/source-cycle-summary.mjs';

const yml = readFileSync(new URL('../.github/workflows/source-cycle-online.yml', import.meta.url), 'utf8');

test('online apply is off unless the sources switch names sources, and uses Firestore control + ADC sheets', () => {
  assert.match(yml, /FREEPASS_SOURCE_CYCLE_ONLINE_SOURCES/);
  assert.match(yml, /run=false[^\n]*\n[^\n]*switch is empty|switch is empty/);
  assert.match(yml, /SOURCE_CYCLE_CONTROL: firestore/);
  assert.match(yml, /SHEETS_TRANSPORT: adc/);
  assert.match(yml, /--unattended/);
  assert.doesNotMatch(yml, /--apply|SOURCE_CYCLE_APPROVED_DIGEST|SOURCE_CYCLE_TAKEOVER: '1'|ENROLL_CAP_ONCE|REPLACE_ONCE/);   // 한 회차 한정 상향·교체 철회는 B3Q 에서만
  assert.doesNotMatch(yml, /echo[^\n]*(secrets\.|_KEY)/);                    // 비밀값 출력 없음
  assert.doesNotMatch(yml.replace(/^#.*$/gm, ''), /SOURCE_CYCLE_TAKEOVER|SONOGONG/);   // 만료 잠금 인수 없음, 손오공은 B3Q 단독 경로
});

test('summary renders per-source rows and survives unreadable output', () => {
  const record = { exit: 0, reports: [{ source: 'RP012', stage: 'APPLY', status: 'APPLIED', summary: '원천 334 → 노출 330 (계획)', exposure: { before: 0, after: 330, sourceSellable: 334, gap: 4 } }] };
  const md = cycleSummaryMarkdown(JSON.stringify(record), [], null);
  assert.match(md, /\| RP012 \| APPLY \| APPLIED \|/);
  assert.match(md, /0→330 \| 334 \| 4 \|/);
  assert.match(cycleSummaryMarkdown('SOURCE_CYCLE_RUNTIME_HOLD', [], null), /결과를 읽지 못함/);
});
