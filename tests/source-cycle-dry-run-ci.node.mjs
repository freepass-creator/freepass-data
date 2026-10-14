import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dryRunEnv, parseSources, summarizeEngineOutput, WRITE_SWITCHES } from '../scripts/ci/source-cycle-dry-run.mjs';

test('child env never carries write, approval or takeover switches', () => {
  const base = Object.fromEntries(WRITE_SWITCHES.map(k => [k, '1']));
  const env = dryRunEnv({ ...base, PATH: '/bin' }, 'IRON', '/tmp/x');
  for (const key of WRITE_SWITCHES) assert.equal(env[key], undefined, key);
  assert.equal(env.SOURCE_CYCLE_SOURCES, 'IRON');
  assert.equal(env.SOURCE_CYCLE_PRIVATE_DIR, '/tmp/x');
  assert.equal(env.PATH, '/bin');
});

test('only online-readable sources are accepted; sheet sources read over ADC', () => {
  assert.deepEqual(parseSources('IANCAR, IRON,IRON,F05'), ['IANCAR', 'IRON', 'F05']);
  assert.throws(() => parseSources('SONOGONG'), /DRY_RUN_SOURCES_INVALID/);
  assert.equal(dryRunEnv({}, 'F05', '/tmp/x').SHEETS_TRANSPORT, 'adc');
  assert.throws(() => parseSources(''), /DRY_RUN_SOURCES_INVALID/);
});

test('engine output is summarized and any apply trace fails closed', () => {
  const ok = JSON.stringify([{ source: 'RP031', status: 'PLANNED', summary: '원천 10 → 노출 9 (계획), 되읽기 미실행 (DRY_RUN)', digest: 'd' }]);
  assert.deepEqual(summarizeEngineOutput('IANCAR', `log\n${ok}\n`, 0).map(r => r.status), ['PLANNED']);
  assert.throws(() => summarizeEngineOutput('IANCAR', JSON.stringify([{ source: 'RP031', status: 'APPLIED' }]), 0), /DRY_RUN_WROTE/);
  assert.throws(() => summarizeEngineOutput('IANCAR', JSON.stringify([{ source: 'RP031', status: 'X', summary: '되읽기 3/3' }]), 0), /DRY_RUN_WROTE/);
  assert.equal(summarizeEngineOutput('IRON', 'SOURCE_CYCLE_RUNTIME_HOLD', 1)[0].status, 'RUNTIME_HOLD');
});

test('workflow never passes apply or unattended flags', () => {
  const yml = readFileSync(new URL('../.github/workflows/source-cycle-dry-run.yml', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../scripts/ci/source-cycle-dry-run.mjs', import.meta.url), 'utf8');
  for (const text of [yml.replace(/^#.*$/gm, ''), script.replace(/^\/\/.*$/gm, '')]) {
    assert.doesNotMatch(text, /'--apply'|"--apply"|'--unattended'|"--unattended"/);
  }
  assert.match(yml, /FREEPASS_SOURCE_CYCLE_DRY_RUN_SCHEDULE/);
});
