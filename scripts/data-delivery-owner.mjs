import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// RETIRED historical adapter. Its CLI cannot execute; exports retain regression evidence.
export const DELIVERY_ENGINE_STATUS = 'RETIRED_PRE_ONE_DELIVERY_ENGINE';
export const ENGINE_REVISION = 'e6727ff04fcf98380701fa6360c36f313e0e321f';
export const LEGACY_REPOSITORY = 'freepass-creator/freepasserp4';
export const LEGACY_WORKFLOW = 'erp5-ssot-refresh.yml';
export const PRIVATE_EVIDENCE_BUCKET = 'freepasserp5-data-audit-evidence';
const supplierSpec = JSON.parse(readFileSync(new URL('../contracts/supplier-input-sheet-spec.v1.json', import.meta.url), 'utf8'));
// Shared-tab suppliers never run through the frozen individual-sheet adapters.
// RP031 belongs to the dedicated ONE API path, not this pre-ONE engine.
export const RETAINED_ENGINE_SOURCE_CODES = Object.freeze(['RP004', 'RP006', 'RP012', 'RP023', 'RP034']);
const sharedCodes = new Set(supplierSpec.supplierChannels.sharedInputSheet.map(channel => channel.code));
if (!RETAINED_ENGINE_SOURCE_CODES.length || RETAINED_ENGINE_SOURCE_CODES.some(code => sharedCodes.has(code) || code === 'RP031')) {
  throw new Error('LEGACY_SOURCE_ROUTING_CONFLICT');
}
export function assertCurrentSharedSheet(spreadsheetId) {
  const binding = supplierSpec.supplierManagement.sourceBinding;
  if (!spreadsheetId || !/^[a-f0-9]{64}$/.test(binding?.spreadsheetIdSha256 ?? '') ||
      binding.legacyInputEnabled !== false || binding.fallbackAllowed !== false || binding.summaryIsSource !== false ||
      createHash('sha256').update(spreadsheetId).digest('hex') !== binding.spreadsheetIdSha256) {
    throw new Error('SHARED_SHEET_SOURCE_BINDING_MISMATCH');
  }
}
// The frozen engine predates ONE API publication and its policy isolation.
// A successful downstream projection cannot authorize replaying old source rules.
export function assertCompatibleBackup(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.products)) throw new Error('INVALID_BEFORE_BACKUP');
  if (snapshot.products.some(product => product?.source === 'EANCAR_ONE_API' || product?.iancar_phase_one)) {
    throw new Error('FROZEN_ENGINE_PREDATES_ONE_API');
  }
}
export function privateBucketDecision(metadata) {
  return metadata?.name === PRIVATE_EVIDENCE_BUCKET && metadata.public_access_prevention === 'enforced' && metadata.uniform_bucket_level_access === true;
}
export const STAGES = [
  ['source-contract', 'npm', ['run', 'check:inventory-sources']],
  ['source-options', 'npm', ['run', 'check:sonokong-options']],
  ['source-collect', 'node', ['sonokong/scripts/손오공.mjs', '--조용']],
  ['source-option-audit', 'npm', ['run', 'audit:sonokong-tcar-options']],
  ['before-backup', 'npx', ['tsx', 'scripts/capture-sales-publish-snapshot.mts', '--erp5', '--out=tmp/data-delivery-before.json']],
  ['contract-lock', 'npx', ['tsx', '--require', './scripts/lib/server-only-shim.cjs', 'scripts/sync-vehicle-lock-from-ledger.mts', '--apply']],
  // Keep unknown/new-source coverage explicit. Never infer retirement from a
  // partial collection. New-atom import and retirement need their own review.
  ['atom-refresh', 'npx', ['tsx', 'scripts/ingest-all-suppliers.mts', '--apply', '--variable', `--only=${RETAINED_ENGINE_SOURCE_CODES.join(',')}`]],
  ['policy-reference', 'npx', ['tsx', 'scripts/reconcile-product-policy-references.mts', '--erp5', '--apply']],
  ['snapshot', 'npx', ['tsx', 'scripts/capture-sales-publish-snapshot.mts', '--erp5', '--out=tmp/data-delivery-snapshot.json']],
  ['public-projection-parity', 'npx', ['tsx', 'scripts/verify-whitelabel-publication.mts', '--snapshot=tmp/data-delivery-snapshot.json', '--write-receipt']],
  ['f01-deliver', 'npx', ['tsx', 'scripts/make-sample-sheet-google.mts', '--main', '--snapshot=tmp/data-delivery-snapshot.json']],
  ['f86-deliver', 'npx', ['tsx', '--require', './scripts/lib/server-only-shim.cjs', 'scripts/build-channel-supplier-sheet.mts', '--채널=하허호', '--apply', '--snapshot=tmp/data-delivery-snapshot.json']],
  ['f86-readback', 'npx', ['tsx', '--require', './scripts/lib/server-only-shim.cjs', 'scripts/audit-f86-vs-atom.mts', '--snapshot=tmp/data-delivery-snapshot.json', '--max-age-min=120']],
  ['sheet-field-readback', 'npx', ['tsx', '--require', './scripts/lib/server-only-shim.cjs', 'scripts/audit-sheet-vs-atom.mts', '--snapshot=tmp/data-delivery-snapshot.json']],
  ['sheet-photo-readback', 'npx', ['tsx', '--require', './scripts/lib/server-only-shim.cjs', 'scripts/check-plate-photo-link.mts']]
];

export function ownershipDecision({ env, workflow, runs, oldWriterPolicy, oldWriterKeys }) {
  const blockers = [];
  if (env.GITHUB_REPOSITORY !== 'freepass-creator/freepass-data' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_ACTIONS !== 'true') blockers.push('NOT_DATA_MAIN_ACTIONS');
  if (env.FREEPASS_DATA_REFRESH_OWNER !== 'freepass-data') blockers.push('OWNER_NOT_ACTIVATED');
  if (env.GOOGLE_CLOUD_PROJECT !== 'freepasserp5') blockers.push('TARGET_MISMATCH');
  if (workflow?.path !== `.github/workflows/${LEGACY_WORKFLOW}` || !['disabled_manually', 'disabled_inactivity'].includes(workflow?.state)) blockers.push('LEGACY_WRITER_NOT_DISABLED');
  if (!Array.isArray(runs?.workflow_runs) || runs.workflow_runs.some(run => run.status !== 'completed')) blockers.push('LEGACY_WRITER_NOT_DRAINED');
  const completedTimes = (runs?.workflow_runs ?? []).map(run => Date.parse(run.updated_at || ''));
  if (!completedTimes.length || completedTimes.some(time => !Number.isFinite(time)) || Date.now() - Math.max(...completedTimes) < 65 * 60_000) blockers.push('LEGACY_RUN_DRAIN_WINDOW_NOT_ELAPSED');
  // Disabling cron alone is not a fence: another actor could re-enable it. Require
  // removal of the legacy writer's token-minting bindings before new writes.
  if (!oldWriterPolicy || typeof oldWriterPolicy.etag !== 'string' || (oldWriterPolicy.bindings !== undefined && !Array.isArray(oldWriterPolicy.bindings)) || (oldWriterPolicy.bindings ?? []).some(binding =>
    ['roles/iam.workloadIdentityUser', 'roles/iam.serviceAccountTokenCreator'].includes(binding.role) && binding.members?.length
  )) blockers.push('LEGACY_IDENTITY_NOT_FENCED');
  if (!Array.isArray(oldWriterKeys) || oldWriterKeys.length !== 0) blockers.push('LEGACY_USER_MANAGED_KEYS_NOT_FENCED');
  const fencedAt = Date.parse(env.FREEPASS_DATA_LEGACY_FENCED_AT || '');
  if (!Number.isFinite(fencedAt) || Date.now() - fencedAt < 65 * 60_000) blockers.push('LEGACY_TOKEN_DRAIN_WINDOW_NOT_ELAPSED');
  return { status: blockers.length ? 'HOLD' : 'READY', blockers };
}

export async function runDelivery({ execute, assertOwnership, readSnapshot, sealBackup, persistReceipt, consumers, execution = {}, now = () => new Date().toISOString() }) {
  const receipt = {
    version: 'freepass-data-refresh-attempt/1', owner: 'freepass-data',
    authority: 'LEGACY_VERIFIED_BRIDGE', canonicalCutoverVerified: false,
    engineRevision: ENGINE_REVISION, execution, startedAt: now(), completedAt: null,
    status: 'HOLD', failureCode: null, stages: [], snapshot: null,
    verification: {
      supplierSourceParity: 'NOT_VERIFIED',
      newInventory: 'NOT_IMPLEMENTED_BY_THIS_BRIDGE',
      policyBodyParity: 'NOT_VERIFIED',
      sheetProjectionParity: 'NOT_VERIFIED'
    },
    // Registry rows are coverage, never proof that a consumer used this attempt.
    consumers: consumers.map(consumer => ({ consumerId: consumer.consumerId, status: 'NOT_VERIFIED' }))
  };
  try {
    for (const [id, command, args] of STAGES) {
      await assertOwnership();
      if (receipt.snapshot) {
        const currentHash = createHash('sha256').update(await readSnapshot()).digest('hex');
        if (currentHash !== receipt.snapshot.sha256) throw new Error('SNAPSHOT_CHANGED_BETWEEN_DELIVERIES');
      }
      const stage = { id, startedAt: now(), completedAt: null, status: 'RUNNING' };
      receipt.stages.push(stage);
      await persistReceipt(receipt);
      try {
        await execute(command, args);
        if (id === 'before-backup') {
          if (!sealBackup) throw new Error('PRIVATE_BACKUP_REQUIRED');
          receipt.beforeBackup = await sealBackup();
        }
        if (id === 'snapshot') {
          const bytes = await readSnapshot();
          const snapshot = JSON.parse(bytes.toString());
          if (!snapshot.snapshotId || !Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error('INVALID_ENGINE_SNAPSHOT');
          receipt.snapshot = { snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, sha256: createHash('sha256').update(bytes).digest('hex') };
        }
        stage.status = 'SUCCEEDED';
      } catch (error) {
        stage.status = 'FAILED';
        stage.failureCode = ['PROCESS_TIMEOUT', 'PROCESS_SPAWN_FAILED', 'ADAPTER_EXIT_NONZERO'].includes(error.code) ? error.code : 'STAGE_VERIFICATION_FAILED';
        stage.exitCode = Number.isInteger(error.executionExitCode) ? error.executionExitCode : null;
        throw error;
      } finally { stage.completedAt = now(); }
    }
    for (const consumer of receipt.consumers) {
      if (['google-sheets-f01', 'google-sheets-f86'].includes(consumer.consumerId)) consumer.status = 'ENGINE_READBACK_VERIFIED';
    }
    receipt.verification.sheetProjectionParity = 'ENGINE_READBACK_VERIFIED';
    receipt.status = 'SUCCEEDED';
  } catch {
    // Do not include supplier output, customer values or credentials in public receipts.
    receipt.status = receipt.stages.some(stage => stage.status === 'SUCCEEDED') ? 'PARTIAL' : 'HOLD';
    receipt.failureCode = receipt.stages.at(-1)?.status === 'FAILED' ? 'ADAPTER_STAGE_FAILED' : 'ADMISSION_OR_SNAPSHOT_GUARD_FAILED';
  } finally {
    receipt.completedAt = now();
    await persistReceipt(receipt);
  }
  return receipt;
}


if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Fail before credentials, engine checkout, backup or any external command.
  console.error(DELIVERY_ENGINE_STATUS);
  process.exitCode = 2;
}
