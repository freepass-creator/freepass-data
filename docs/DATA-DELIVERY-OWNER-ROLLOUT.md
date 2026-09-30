# Data-owned source collection and delivery

Status: CODED / TESTED preparation. NOT DEPLOYED / NOT CUTOVER VERIFIED.

## Purpose and existing assets

The approved distribution map must have an executor, not just an observer.
`data-owned-refresh.yml` and `scripts/data-delivery-owner.mjs` compose the frozen
production engine with Data-owned admission, stage sequencing and attempt evidence.
Academy READY on base `f77e581`; reuse decision COMPOSE_OR_EXTEND.
No replacement source store, CatalogStore, pricing engine or settlement ledger is created.

The bridge intentionally continues to operate the legacy ERP5 atom shape. It does
not populate reviewed Canonical entities or activate a Release. Existing Data target
resolution/store contracts remain the path for future Canonical migration; the frozen
external engine is explicitly a transitional adapter, not a second central Firebase initializer.

## Implemented execution

1. Verify exact Data main, project and immutable engine HEAD; reject tracked modifications.
2. Require the old refresh workflow disabled, all attempts drained, old inventory
   identity token-minting bindings removed and a 65-minute expiry window elapsed.
3. Collect sources and run the existing source contract and option guards.
4. Capture current atoms/policies/partners; create-only private backup and byte readback
   must succeed before contract-lock/product/policy mutation.
5. Update **existing** variable atoms and policy references. Automatic `--retire` is
   removed. New inventory import and full supplier policy-content synchronization are
   NOT implemented by this ownership slice and must not be advertised as complete.
6. Freeze one snapshot. Verify its byte SHA before each downstream stage, publish
   F01/F86 and require the existing field/photo audits.
7. Preserve private snapshots and redacted per-stage receipt. Failure stops later
   stages, retains PARTIAL/HOLD and never triggers an automatic rollback/replay.

Every registry consumer remains visible. Sheet engine readback is a transport-level
fact; ERP.com, white-label tenants, Admin, Sales, Estimate and Kakao runtime adoption
remain NOT_VERIFIED. A grouped white-label registry entry is **not** tenant-by-tenant
coverage. These attempt receipts are not forged Canonical SheetDeliveryReceipt objects.

## Admission and activation — separate operations

No activation is performed by this code PR. Default owner is absent; scheduled jobs
are skipped, not a freshness PASS. `workflow_dispatch` defaults to read-only shadow.
GitHub cron is best effort, not a guaranteed hourly SLA. A production recovery
watchdog must move to this same executor after rollout; the existing audit watchdog
does not refresh business data.

Before activation the operator must confirm the exact account/project/workflow and:

- Configure environment `data-production-delivery` with reviewer protection.
- Bind a dedicated WIF provider to numeric repository owner, exact repository,
  main ref and this workflow path. Exclude fork/PR tokens.
- Use `github-data-inventory-writer@freepasserp5.iam.gserviceaccount.com`;
  do not broaden the existing read-runtime or auditor identities.
- Restrict the private evidence bucket (no allUsers/allAuthenticatedUsers, enforced
  public-access prevention), with create-only run objects and readback permission.
  Reuse verified `freepasserp5-data-audit-evidence`, not a new bucket. Admission
  reads its metadata and requires exact name, enforced public-access prevention and
  uniform bucket access before any capture/backup. Observation on 2026-09-30 confirmed
  these settings; permissions for the new delivery identity are still unconfigured.
- Register `FREEPASS_DATA_REFRESH_WIF_PROVIDER`,
  `FREEPASS_DATA_REFRESH_SERVICE_ACCOUNT`, `FREEPASS_DATA_REFRESH_EVIDENCE_BUCKET`,
  plus supplier secrets through secure transport. Never extract GitHub secrets to logs.
- Grant the minimum read of the old writer SA IAM policy required by preflight.
- Run shadow N times; compare exact snapshots/transform outputs and supplier coverage,
  not merely collection counts. Current shadow checks only engine-to-DB public
  projection parity; it does not establish complete source or Sheet/consumer parity.
- Capture and verify full private workbook backups, old IAM policy and rollback
  procedure. Product snapshot backup alone is not a Google workbook backup.
- Freeze old refresh and recovery dispatch, drain runs, remove old writer token-mint
  authority. Check every other writer using that identity before removal; settlement
  ingestion and unrelated workflows are not silently retired by this slice.
- Prove the old identity cannot mint a token (negative control). Record removal's
  audit evidence and `FREEPASS_DATA_LEGACY_FENCED_AT`, wait at least 65 minutes.
  The variable is an operator evidence binding, not cryptographic proof of removal time.
- Verify the old SA has no user-managed keys (also checked by admission); inventory
  other credentials, Scheduler/Tasks/PubSub queues and manual entrypoints separately.
  Expiry delay alone is not proof those execution paths are fenced.
- Only then set `FREEPASS_DATA_REFRESH_OWNER=freepass-data` and dispatch execute.

IAM fencing, not repository concurrency or a workflow display name, prevents the
old engine from racing. The old engine's name gate is preserved solely as an adapter
compatibility detail; Data's independent admission is the boundary. Ambient ADC on
the Data subprocess is intentional for the authorized **same ERP5 target**. Clearing
it would break the migration; target/IAM scope must instead be verified.

## Recovery and completion

On a partial attempt stop Data admission first, drain and expire its tokens, inspect
which writes completed, then reconcile current values against the private before
snapshot. Do not blindly restore over newer Admin/manual changes. Restore only the
reviewed diff with expected-value/revision checks. Restore old writer binding and
workflow only after Data is fenced; never leave both runnable. Retain both policy
backups and stage receipts. A successful shadow is not a rollback drill.

Completion requires actual Data scheduled + recovery runs, full source coverage,
private backup/readback, F01/F86 presentation and value evidence, and each consumer's
authenticated version/tenant/field readback. Canonical ACTIVE promotion is a separate
reviewed migration. Bank payments and Admin workflow meaning are outside this slice.
Shadow parity explicitly excludes retirement/stale-residual detection and mutation
idempotency. Consumer readbacks are collected in a separate authorized read-only
path, not blocked behind successful mutation stages. Backup names include both run
and attempt; a retry gets a new before snapshot and never treats alreadyExists as
success. Backup is not a cross-writer transaction; concurrent Admin/manual changes
still require expected-value comparison during recovery.

Claude's independent design review raised destructive retirement, stale credentials,
cross-repository races and recovery gaps. Retirement was removed, backup/readback,
token-drain admission and explicit rollout/recovery gates added. The recommendation
to clear all subprocess ADC was not adopted: it conflicts with the intended Data-owned
write into the verified ERP5 target. Production gates above remain mandatory.

next_start_here: provision and read back the narrowly scoped identities/environment,
then run shadow and collect the missing field/source/consumer evidence before any
owner switch. Keep ERP4 last-known-good active until those gates are met.
