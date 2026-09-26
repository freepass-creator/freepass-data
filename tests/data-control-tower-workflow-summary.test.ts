import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/erp5-continuous-audit.yml', import.meta.url), 'utf8');
const section = workflow.split('      - name: Build FreePass Data control tower\n')[1]?.split('\n      - name:')[0];
assert.ok(section, 'Control Tower workflow step must exist');
const runBlock = section.split('        run: |\n')[1];
assert.ok(runBlock, 'Control Tower must have a literal Bash run block');
const command = runBlock.split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');

function fixture() {
  return {
    contractVersion: 'freepass-data-control-tower-v1',
    schemaVersion: '1.0.0',
    axes: {
      sourceObservation: { status: 'OBSERVED', partners: 64, readTime: '2026-09-26T11:45:42.437Z' },
      auditFreshness: { status: 'BLOCKED', reason: 'ERP5_AUDIT_MAX_GAP_MINUTES_NOT_CONFIGURED' },
      publication: { decision: 'HOLD' },
      consumerHealth: { status: 'BLOCKED' },
      consumerReadiness: { status: 'BLOCKED' },
      sheetHealth: { status: 'BLOCKED' },
      estimateMasterReadiness: {
        contractVersion: 'estimate-master-readiness-v1',
        projectionId: 'estimate-newcar-master',
        status: 'BLOCKED',
      },
    },
    operatorSummary: {
      readyTransitionCount: 0,
      consumerBlockedCount: 0,
      estimateCanonicalTrimCount: 0,
      estimateActiveTrimCount: 0,
      estimateHoldTrimCount: 0,
    },
    attention: ['CANONICAL_TRIMS_NOT_AVAILABLE', 'SHEET_EVIDENCE_MAX_AGE_MINUTES_NOT_CONFIGURED'],
  };
}

function execute(report: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'control-tower-summary-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const input = join(dir, 'fixture.json');
    const summary = join(dir, 'summary.md');
    writeFileSync(input, JSON.stringify(report));
    writeFileSync(summary, 'previous summary\n');
    // Only stub the upstream builder; execute the actual workflow Bash and jq.
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\ncat "$CONTROL_TOWER_TEST_FIXTURE"\n', { mode: 0o755 });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, CONTROL_TOWER_TEST_FIXTURE: input, GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    return { status: result.status, stderr: result.stderr, summary: readFileSync(summary, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Control Tower renders actual HOLD reasons, freshness and numeric zeros without jq errors', () => {
  const result = execute(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.summary.startsWith('previous summary\n## FreePass Data Control Tower\n'));
  for (const line of [
    'Source read: 2026-09-26T11:45:42.437Z',
    'Audit freshness: BLOCKED / ERP5_AUDIT_MAX_GAP_MINUTES_NOT_CONFIGURED',
    'Publication: HOLD',
    'Consumer health: BLOCKED',
    'Consumer readiness: BLOCKED',
    'Sheet health: BLOCKED',
    'Estimate master: BLOCKED',
    'Estimate canonical trims: 0',
    'Estimate ACTIVE trims: 0',
    'Estimate HOLD trims: 0',
    'Ready transitions: 0',
    'Blocked consumers: 0',
    'Attention: CANONICAL_TRIMS_NOT_AVAILABLE, SHEET_EVIDENCE_MAX_AGE_MINUTES_NOT_CONFIGURED',
  ]) assert.ok(result.summary.split('\n').includes(line), `Missing exact summary line: ${line}`);
});

test('Control Tower renders empty attention and unknown historical counters without inventing zeros', () => {
  const report = fixture();
  const result = execute({ ...report, attention: [], operatorSummary: {
    ...report.operatorSummary,
    consumerBlockedCount: null,
    estimateCanonicalTrimCount: null,
    estimateActiveTrimCount: null,
    estimateHoldTrimCount: null,
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  for (const line of ['Blocked consumers: unknown', 'Estimate canonical trims: unknown',
    'Estimate ACTIVE trims: unknown', 'Estimate HOLD trims: unknown', 'Attention: none']) {
    assert.ok(result.summary.split('\n').includes(line), `Missing exact summary line: ${line}`);
  }
});

test('Control Tower propagates jq rendering failure and does not append a partial success summary', () => {
  const result = execute({ ...fixture(), attention: [{ invalid: 'not a string' }] });
  assert.notEqual(result.status, 0, 'A rendering error must not be hidden by echo');
  assert.match(result.stderr, /jq: error/);
  assert.equal(result.summary, 'previous summary\n');
});

test('Control Tower preserves the existing schema gate before publishing a summary', () => {
  const result = execute({ ...fixture(), contractVersion: 'invalid-contract' });
  assert.notEqual(result.status, 0);
  assert.equal(result.summary, 'previous summary\n');
});
