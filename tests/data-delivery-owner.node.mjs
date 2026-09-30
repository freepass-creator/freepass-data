import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ownershipDecision, privateBucketDecision, PRIVATE_EVIDENCE_BUCKET, runDelivery, STAGES, ENGINE_REVISION } from '../scripts/data-delivery-owner.mjs';

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
test('one snapshot feeds both sheets, web/tenant/Admin are never declared verified', async () => {
  const r = runner(); const receipt = await runDelivery(r.options);
  assert.equal(r.calls.length, STAGES.length);
  assert.equal(receipt.status, 'SUCCEEDED');
  assert.equal(receipt.engineRevision, ENGINE_REVISION);
  assert.equal(receipt.authority, 'LEGACY_VERIFIED_BRIDGE');
  assert.equal(receipt.canonicalCutoverVerified, false);
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
test('shadow engine calls cannot write an ops receipt and legacy history uses a scoped credential', () => {
  const source = readFileSync(new URL('../scripts/data-delivery-owner.mjs', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/data-owned-refresh.yml', import.meta.url), 'utf8');
  const call = source.split('\n').find(line => line.includes("command('npx'") && line.includes('verify-whitelabel-publication.mts') && line.includes('data-delivery-shadow'));
  assert.ok(call); assert.ok(!call.includes('--write-receipt'));
  assert.ok(workflow.includes('secrets.FREEPASS_DATA_LEGACY_ACTIONS_READ_TOKEN'));
  assert.ok(!workflow.includes('GH_TOKEN: ${{ github.token }}'));
  assert.ok(workflow.includes('npm --prefix engine ci --ignore-scripts'));
  assert.ok(workflow.indexOf('npm --prefix engine ci --ignore-scripts') < workflow.indexOf('google-github-actions/auth@'));
});
test('failed durable checkpoint prevents its engine effect', async () => {
  const r = runner({ persistReceipt: async () => { throw new Error('evidence transport unavailable'); } });
  await assert.rejects(runDelivery(r.options));
  assert.equal(r.calls.length, 0);
});
