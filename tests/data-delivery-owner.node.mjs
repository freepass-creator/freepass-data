import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertCurrentSharedSheet, RETAINED_ENGINE_SOURCE_CODES, assertCompatibleBackup, ownershipDecision, privateBucketDecision, PRIVATE_EVIDENCE_BUCKET, runDelivery, STAGES, ENGINE_REVISION } from '../scripts/data-delivery-owner.mjs';

test('frozen adapters cannot collect retired individual sheets or the pre-ONE iancar source', () => {
  const spec = JSON.parse(readFileSync(new URL('../contracts/supplier-input-sheet-spec.v1.json', import.meta.url), 'utf8'));
  const retired = spec.supplierChannels.sharedInputSheet.map(channel => channel.code);
  assert.ok(RETAINED_ENGINE_SOURCE_CODES.length > 0);
  assert.ok(RETAINED_ENGINE_SOURCE_CODES.every(code => !retired.includes(code) && code !== 'RP031'));
  const args = STAGES.find(stage => stage[0] === 'atom-refresh')[2];
  assert.deepEqual(args.filter(arg => arg.startsWith('--only=')), [`--only=${RETAINED_ENGINE_SOURCE_CODES.join(',')}`]);
  assert.equal(spec.supplierManagement.sourceBinding.historicalEvidenceRetention, 'PRESERVE');
});

test('daily collection rejects missing and obsolete spreadsheet addresses before authentication', () => {
  for (const id of [undefined, '', 'obsolete-sheet', 'synthetic_spreadsheet_id_0001']) {
    assert.throws(() => assertCurrentSharedSheet(id), /SHARED_SHEET_SOURCE_BINDING_MISMATCH/);
  }
  const workflow = readFileSync(new URL('../.github/workflows/shared-sheet-daily.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('assertCurrentSharedSheet(process.env.SHARED_SHEET_ID)') < workflow.indexOf('uses: google-github-actions/auth@v2'));
});

test('frozen engine cannot replay pre-ONE rules over API-owned inventory', () => {
  assert.doesNotThrow(() => assertCompatibleBackup({ products: [] }));
  assert.throws(() => assertCompatibleBackup({}), /INVALID_BEFORE_BACKUP/);
  for (const product of [{ source: 'EANCAR_ONE_API' }, { iancar_phase_one: { stage: 'PHASE_ONE' } }]) {
    assert.throws(() => assertCompatibleBackup({ products: [product] }), /FROZEN_ENGINE_PREDATES_ONE_API/);
  }
});

const evidence = () => ({
  env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'freepass-creator/freepass-data', GITHUB_REF: 'refs/heads/main', GOOGLE_CLOUD_PROJECT: 'freepasserp5', FREEPASS_DATA_REFRESH_OWNER: 'freepass-data', FREEPASS_DATA_LEGACY_FENCED_AT: new Date(Date.now() - 66 * 60_000).toISOString() },
  workflow: { path: '.github/workflows/erp5-ssot-refresh.yml', state: 'disabled_manually' },
  runs: { workflow_runs: [{ status: 'completed', updated_at: new Date(Date.now() - 66 * 60_000).toISOString() }] }, oldWriterPolicy: { etag: 'test-etag', bindings: [] }, oldWriterKeys: []
});
test('source backup cannot target a public or unrelated bucket', () => {
  const metadata = { name: PRIVATE_EVIDENCE_BUCKET, public_access_prevention: 'enforced', uniform_bucket_level_access: true };
  assert.equal(privateBucketDecision(metadata), true);
  assert.equal(privateBucketDecision({ ...metadata, public_access_prevention: 'inherited' }), false);
  assert.equal(privateBucketDecision({ ...metadata, name: 'another-tenant' }), false);
  assert.equal(privateBucketDecision(null), false);
});
test('owner activation requires disabled, drained and identity-fenced old writer', () => {
  assert.equal(ownershipDecision(evidence()).status, 'READY');
  for (const mutate of [
    e => { e.env.FREEPASS_DATA_REFRESH_OWNER = ''; },
    e => { e.env.GITHUB_REF = 'refs/heads/feature'; },
    e => { e.env.GOOGLE_CLOUD_PROJECT = 'freepasserp3'; },
    e => { e.env.FREEPASS_DATA_LEGACY_FENCED_AT = new Date().toISOString(); },
    e => { e.workflow.state = 'active'; },
    e => { e.workflow.path = 'wrong.yml'; },
    e => { e.runs.workflow_runs.push({ status: 'queued' }); },
    e => { e.runs = {}; },
    e => { e.runs.workflow_runs[0].updated_at = new Date().toISOString(); },
    e => { e.oldWriterPolicy = null; },
    e => { e.oldWriterKeys = [{ name: 'user-key' }]; },
    e => { e.oldWriterPolicy.bindings.push({ role: 'roles/iam.workloadIdentityUser', members: ['legacy'] }); }
  ]) { const e = evidence(); mutate(e); assert.equal(ownershipDecision(e).status, 'HOLD'); }
});
test('official empty IAM policy with omitted bindings is accepted, missing etag is not', () => {
  const e = evidence(); delete e.oldWriterPolicy.bindings;
  assert.equal(ownershipDecision(e).status, 'READY');
  delete e.oldWriterPolicy.etag;
  assert.equal(ownershipDecision(e).status, 'HOLD');
});
function runner(overrides = {}) {
  const calls = [], persisted = [];
  return {
    calls, persisted,
    options: {
      consumers: [{ consumerId: 'google-sheets-f01' }, { consumerId: 'google-sheets-f86' }, { consumerId: 'erp-com-public-catalog' }, { consumerId: 'erp-whitelabel-catalogs' }, { consumerId: 'freepass-admin-catalog' }],
      assertOwnership: async () => {},
      execute: async (command, args) => calls.push({ command, args }),
      readSnapshot: async () => Buffer.from(JSON.stringify({ snapshotId: 'one-snapshot', capturedAt: '2026-09-30T00:00:00Z' })),
      persistReceipt: async receipt => persisted.push(structuredClone(receipt)),
      sealBackup: async () => ({ uri: 'private-before', verified: true }),
      ...overrides
    }
  };
}
test('ONE API ownership blocks the bridge before lock, product, policy or Sheet writes', async () => {
  const r = runner({ sealBackup: async () => {
    assertCompatibleBackup({ products: [{ source: 'EANCAR_ONE_API' }] });
  } });
  const receipt = await runDelivery(r.options);
  assert.equal(receipt.status, 'PARTIAL');
  assert.equal(receipt.stages.at(-1).id, 'before-backup');
  assert.equal(r.calls.length, 5);
  assert.ok(r.calls.every(call => !call.args.includes('--apply') && !call.args.includes('--main')));
  assert.ok(receipt.consumers.every(consumer => consumer.status === 'NOT_VERIFIED'));
});
test('one snapshot feeds both sheets, web/tenant/Admin are never declared verified', async () => {
  const r = runner(); const receipt = await runDelivery(r.options);
  assert.equal(r.calls.length, STAGES.length);
  assert.equal(receipt.status, 'SUCCEEDED');
  assert.equal(receipt.engineRevision, ENGINE_REVISION);
  assert.equal(receipt.authority, 'LEGACY_VERIFIED_BRIDGE');
  assert.equal(receipt.canonicalCutoverVerified, false);
  assert.equal(receipt.verification.supplierSourceParity, 'NOT_VERIFIED');
  assert.equal(receipt.verification.newInventory, 'NOT_IMPLEMENTED_BY_THIS_BRIDGE');
  assert.equal(receipt.verification.policyBodyParity, 'NOT_VERIFIED');
  assert.equal(receipt.verification.sheetProjectionParity, 'ENGINE_READBACK_VERIFIED');
  assert.match(receipt.snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.consumers.slice(2).map(c => c.status), ['NOT_VERIFIED', 'NOT_VERIFIED', 'NOT_VERIFIED']);
  for (const call of r.calls.filter(c => c.args.some(a => a.startsWith('--snapshot=')))) assert.ok(call.args.includes('--snapshot=tmp/data-delivery-snapshot.json'));
});
test('failure closes downstream delivery and preserves PARTIAL receipt', async () => {
  let count = 0;
  const r = runner({ execute: async () => { if (++count === 11) throw new Error('secret supplier output'); } });
  const receipt = await runDelivery(r.options);
  assert.equal(receipt.status, 'PARTIAL');
  assert.equal(receipt.stages.length, 11);
  assert.equal(receipt.stages.at(-1).status, 'FAILED');
  assert.ok(receipt.consumers.every(c => c.status === 'NOT_VERIFIED'));
  assert.equal(receipt.verification.sheetProjectionParity, 'NOT_VERIFIED');
  assert.ok(!JSON.stringify(receipt).includes('secret supplier'));
  assert.equal(r.persisted.at(-1).status, 'PARTIAL');
});
test('ownership is rechecked before every effect; ambiguous owner stops immediately', async () => {
  let guards = 0;
  const r = runner({ assertOwnership: async () => { if (++guards === 3) throw new Error('owner changed'); } });
  const receipt = await runDelivery(r.options);
  assert.equal(r.calls.length, 2); assert.equal(receipt.status, 'PARTIAL');
});
test('missing ownership and invalid snapshot cannot publish', async () => {
  const held = runner({ assertOwnership: async () => { throw new Error('not ready'); } });
  assert.equal((await runDelivery(held.options)).status, 'HOLD');
  assert.equal(held.calls.length, 0);
  const invalid = runner({ readSnapshot: async () => Buffer.from('{}') });
  assert.equal((await runDelivery(invalid.options)).status, 'PARTIAL');
  assert.equal(invalid.calls.length, 9);
});
test('snapshot mutation between consumers closes the remaining delivery', async () => {
  let reads = 0;
  const r = runner({ readSnapshot: async () => Buffer.from(JSON.stringify({ snapshotId: ++reads > 2 ? 'mutated' : 'one', capturedAt: '2026-09-30T00:00:00Z' })) });
  const receipt = await runDelivery(r.options);
  assert.equal(receipt.status, 'PARTIAL');
  assert.equal(receipt.stages.length, 10);
  assert.ok(receipt.consumers.every(c => c.status === 'NOT_VERIFIED'));
});
test('backup failure blocks all atom mutations and retirement is never automatic', async () => {
  const r = runner({ sealBackup: async () => { throw new Error('backup failed'); } });
  const receipt = await runDelivery(r.options);
  assert.equal(receipt.stages.at(-1).id, 'before-backup');
  assert.equal(receipt.status, 'PARTIAL');
  assert.ok(!STAGES.some(([, , args]) => args.includes('--retire')));
});
test('retired bridge has no schedule, credentials, external checkout or data execution', () => {
  const workflow = readFileSync(new URL('../.github/workflows/data-owned-refresh.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('RETIRED_PRE_ONE_DELIVERY_ENGINE'));
  for (const forbidden of ['schedule:', 'cron:', 'secrets.', 'id-token:', 'google-github-actions/auth', 'repository: freepass-creator/freepasserp4', '--execute']) assert.ok(!workflow.includes(forbidden), forbidden);
  for (const mode of ['--execute', '--shadow', '--preflight']) {
    const result = spawnSync(process.execPath, ['scripts/data-delivery-owner.mjs', mode], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /RETIRED_PRE_ONE_DELIVERY_ENGINE/);
    assert.ok(!result.stderr.includes('ENGINE_PIN_MISMATCH'));
  }
});
test('failed durable checkpoint prevents its engine effect', async () => {
  const r = runner({ persistReceipt: async () => { throw new Error('evidence transport unavailable'); } });
  await assert.rejects(runDelivery(r.options));
  assert.equal(r.calls.length, 0);
});

test('prewrite authorization repeats the identical gate and checks current main before any writes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/shared-sheet-daily.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const first = workflow.split('- name: Daily schedule and manual apply gate')[1].split('- uses: actions/checkout')[0].split('        run: |\n')[1].trim();
  const second = workflow.split('- name: Revalidate authorization immediately before writes')[1].split('- name: Apply to FreePass Data')[0].split('        run: |\n')[1].trim();
  const mainCheck = '          current_main="$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq \'.sha\')"\n          test "$current_main" = "$GITHUB_SHA" || { echo \'CURRENT_MAIN_CHANGED\'; exit 1; }\n';
  assert.ok(second.includes(mainCheck));
  assert.equal(second.replace(mainCheck, ''), first);
  assert.ok(workflow.includes("steps.recheck.outputs.run == 'true' && env.APPLY == 'true'"));
  assert.ok(workflow.indexOf('Seal private source and plan') < workflow.indexOf('Revalidate authorization immediately'));
});

test('approved audit completion patch binds exact main run and keeps expiry and once-only gates', () => {
  const workflow = readFileSync(new URL('../.github/workflows/shared-sheet-daily.yml', import.meta.url), 'utf8');
  const match = workflow.match(/--argjson id "\$TRIGGER_AUDIT_RUN_ID" '\r?\n([\s\S]*?)\r?\n\s*' <<<"\$trigger"/);
  assert.ok(match, 'exact trigger predicate must exist');
  const predicate = match[1];
  const accepted = {id:42,repository:{full_name:'owner/data'},head_repository:{full_name:'owner/data'},
    path:'.github/workflows/erp5-continuous-audit.yml',head_branch:'main',head_sha:'exact',status:'completed',conclusion:'success'};
  const judge = value => spawnSync('jq', ['-e','--arg','repo','owner/data','--arg','sha','exact','--argjson','id','42',predicate],
    {input:JSON.stringify(value),encoding:'utf8'});
  assert.equal(judge(accepted).status,0);
  for (const changed of [{id:43},{repository:{full_name:'other/data'}},{head_repository:{full_name:'fork/data'}},
    {path:'.github/workflows/other.yml'},{head_branch:'other'},{head_sha:'old'},
    {status:'in_progress'},{conclusion:'failure'},{conclusion:'skipped'}]) assert.notEqual(judge({...accepted,...changed}).status,0);
  const latestPredicate = workflow.match(/--argjson id "\$TRIGGER_AUDIT_RUN_ID" '([^']+)' <<<"\$latest"/)[1];
  const latest = rows => {
    const sorted = spawnSync('jq',['-s','sort_by(.completed_at) | last // {}'],{input:rows.map(x=>JSON.stringify(x)).join('\n'),encoding:'utf8'});
    assert.equal(sorted.status,0);
    return spawnSync('jq',['-e','--argjson','id','42',latestPredicate],{input:sorted.stdout,encoding:'utf8'}).status;
  };
  const guard={auditRunId:42,conclusion:'success',completed_at:'2026-10-09T01:58:00Z'};
  assert.equal(latest([guard]),0);
  assert.notEqual(latest([]),0);
  assert.notEqual(latest([guard,{auditRunId:43,conclusion:'failure',completed_at:'2026-10-09T01:59:00Z'}]),0);
  assert.equal(latest([guard,{auditRunId:41,conclusion:'failure',completed_at:'2026-10-09T01:57:00Z'}]),0);
  assert.match(workflow,/AUDIT_TRIGGER_SUPERSEDED_OR_GUARD_MISSING/);
  assert.match(workflow,/\[ "\$age" -gt 10800 \]/);
  assert.match(workflow,/\[ "\$age" -lt 0 \]/);
  assert.match(workflow,/\[ "\$applied" -gt 0 \]/);
  assert.match(workflow,/filter=all/);
  assert.match(workflow,/group: freepass-data-production-delivery/);
  assert.match(workflow,/cancel-in-progress: false/);
  assert.match(workflow,/if \[ "\$DAILY" != 'on' \]/);
  assert.match(workflow,/actions: read/);
  assert.ok(!workflow.includes('actions: write'));
  assert.ok(workflow.indexOf('Seal private source and plan before Canonical writes') < workflow.indexOf('- name: Apply to FreePass Data'));
  const seal = workflow.split('- name: Seal private source and plan before Canonical writes')[1].split('- name: Apply to FreePass Data')[0];
  assert.match(seal,/--if-generation-match=0/);
  assert.match(seal,/cmp "\$T\/\$f" "\$T\/\$f.preapply-readback"/);
  assert.match(seal,/set -euo pipefail/);
});
