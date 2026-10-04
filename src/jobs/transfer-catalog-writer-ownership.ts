import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { transferCatalogWriterOwnership, rollbackCatalogWriterOwnership } from '../application/writer-ownership.js';
import { effectiveCatalogWriterOwnership, type CatalogWriterOwnership } from '../domain/writer-ownership.js';
import type { ActorRef } from '../domain/catalog.js';
import type { CatalogStore } from '../ports/catalog-store.js';
import { stableDigest } from '../shared/stable-digest.js';
import { parseLocalArgs, writePrivateArtifact } from './ingest-shared-sheet-canonical.js';

/** Catalog writer ownership transfer: dry-run plan → reviewed apply → read-back, with a reviewed rollback. */
const DATA_WRITER = { id: 'service:freepass-data', kind: 'SERVICE' as const };
const TARGET_WRITER = DATA_WRITER.id;

export type OwnershipPlan = {
  schema: 'catalog-writer-ownership-plan/v1';
  target: string;
  stored: boolean;
  before: CatalogWriterOwnership;
  beforeDigest: string;
  after: Pick<CatalogWriterOwnership, 'revision' | 'mode' | 'primaryWriterId' | 'allowedWriterIds' | 'previousWriterIds'>;
  rollback: Pick<CatalogWriterOwnership, 'mode' | 'primaryWriterId' | 'allowedWriterIds' | 'previousWriterIds'>;
  approvedBy: ActorRef;
  reason: string;
};

const summary = (o: CatalogWriterOwnership) => ({ revision: o.revision, mode: o.mode, primaryWriterId: o.primaryWriterId,
  allowedWriterIds: o.allowedWriterIds, previousWriterIds: o.previousWriterIds });

export async function planOwnershipTransfer(store: CatalogStore, target: string, approvedBy: ActorRef, reason: string) {
  const stored = await store.getCatalogWriterOwnership();
  const before = effectiveCatalogWriterOwnership(stored);
  const alreadyExclusive = before.mode === 'EXCLUSIVE' && before.primaryWriterId === TARGET_WRITER;
  const previousWriterIds = alreadyExclusive ? before.previousWriterIds : [...new Set([...before.previousWriterIds,
    ...before.allowedWriterIds.filter(id => id !== TARGET_WRITER),
    ...(before.primaryWriterId !== TARGET_WRITER ? [before.primaryWriterId] : [])])].sort();
  const plan: OwnershipPlan = {
    schema: 'catalog-writer-ownership-plan/v1', target, stored: Boolean(stored), before, beforeDigest: stableDigest(before),
    after: alreadyExclusive ? summary(before) : { revision: before.revision + 1, mode: 'EXCLUSIVE', primaryWriterId: TARGET_WRITER,
      allowedWriterIds: [TARGET_WRITER], previousWriterIds },
    rollback: { mode: before.mode, primaryWriterId: before.primaryWriterId, allowedWriterIds: before.allowedWriterIds, previousWriterIds: before.previousWriterIds },
    approvedBy, reason };
  return { plan, report: { mode: 'DRY_RUN', writes: 0, target, storedOwnershipDocument: plan.stored,
    current: summary(before), next: plan.after, rollbackRestores: plan.rollback,
    action: alreadyExclusive ? 'NO_CHANGE' : 'TRANSFER', planDigest: stableDigest(plan) } };
}

function assertPlan(plan: OwnershipPlan | undefined, digest: string | undefined, target: string): asserts plan is OwnershipPlan {
  if (!plan || plan.schema !== 'catalog-writer-ownership-plan/v1' || plan.target !== target || !digest || digest !== stableDigest(plan))
    throw new Error('OWNERSHIP_PLAN_REQUIRED_OR_CHANGED');
}

/** Read-only guard run before any audited write: the live ownership must still be the reviewed state. */
export async function preflightOwnership(store: CatalogStore, plan: OwnershipPlan | undefined, digest: string | undefined,
  target: string, kind: 'apply' | 'rollback') {
  assertPlan(plan, digest, target);
  const now = effectiveCatalogWriterOwnership(await store.getCatalogWriterOwnership());
  if (kind === 'apply' && stableDigest(now) !== plan.beforeDigest) throw new Error('OWNERSHIP_CHANGED_SINCE_PLAN');
  if (kind === 'rollback' && stableDigest(summary(now)) !== stableDigest(plan.after)) throw new Error('OWNERSHIP_NOT_IN_PLANNED_STATE');
  return now;
}

export async function runOwnershipCommand(store: CatalogStore, kind: 'apply' | 'rollback', plan: OwnershipPlan | undefined,
  digest: string | undefined, target: string, now = new Date().toISOString()) {
  const current = await preflightOwnership(store, plan, digest, target, kind);
  assertPlan(plan, digest, target);
  const key = `${kind}:${digest}`;
  const receipt = kind === 'apply'
    ? await transferCatalogWriterOwnership(store, { commandId: `cmd-ownership-${key}`, idempotencyKey: `idem-ownership-${key}`,
      expectedRevision: current.revision, toWriterId: TARGET_WRITER, actor: plan.approvedBy, writer: DATA_WRITER, reason: plan.reason }, now)
    : await rollbackCatalogWriterOwnership(store, { commandId: `cmd-ownership-${key}`, idempotencyKey: `idem-ownership-${key}`,
      expectedRevision: current.revision, restore: plan.rollback, actor: plan.approvedBy, writer: DATA_WRITER,
      reason: `rollback: ${plan.reason}` }, now);
  const after = effectiveCatalogWriterOwnership(await store.getCatalogWriterOwnership());
  const expected = kind === 'apply' ? plan.after : plan.rollback;
  const { revision: _r, ...shape } = summary(after);
  const { revision: _e, ...want } = { revision: 0, ...expected };
  const readbackOk = stableDigest({ ...shape, allowedWriterIds: [...shape.allowedWriterIds].sort(), previousWriterIds: [...shape.previousWriterIds].sort() })
    === stableDigest({ ...want, allowedWriterIds: [...want.allowedWriterIds].sort(), previousWriterIds: [...want.previousWriterIds].sort() });
  return { mode: kind === 'apply' ? 'APPLY' : 'ROLLBACK', status: readbackOk ? receipt.status : 'HOLD',
    receipt: { status: receipt.status, previousRevision: receipt.previousRevision, revision: receipt.revision },
    readback: summary(after), readbackOk };
}

export async function main(args = process.argv.slice(2)) {
  const a = parseLocalArgs(args, ['--memory', '--firestore', '--apply', '--rollback'],
    ['--plan', '--plan-out', '--expected-plan-digest', '--approved-by', '--reason']);
  const kind = a.has('--apply') ? 'apply' : a.has('--rollback') ? 'rollback' : undefined;
  if (a.has('--apply') && a.has('--rollback')) throw new Error('APPLY_OR_ROLLBACK');
  if (kind && (!a.has('--plan') || !a.has('--expected-plan-digest'))) throw new Error('REVIEWED_PLAN_AND_DIGEST_REQUIRED');
  if (!kind && (!a.has('--approved-by') || !a.has('--reason'))) throw new Error('APPROVED_BY_AND_REASON_REQUIRED');
  const { resolveTargetProject } = await import('../infra/firebase-target.js');
  const target = a.has('--memory') ? 'memory' : resolveTargetProject();
  const plan = a.has('--plan') ? JSON.parse(await readFile(a.get('--plan')!, 'utf8')) as OwnershipPlan : undefined;
  if (kind) assertPlan(plan, a.get('--expected-plan-digest'), target);
  const digest = a.get('--expected-plan-digest');
  const approvedBy: ActorRef = { id: `user:${a.get('--approved-by') ?? ''}`, kind: 'USER' };
  type Result = Awaited<ReturnType<typeof planOwnershipTransfer>> | Awaited<ReturnType<typeof runOwnershipCommand>>;
  const run = (store: CatalogStore): Promise<Result> => kind ? runOwnershipCommand(store, kind, plan, digest, target)
    : planOwnershipTransfer(store, target, approvedBy, a.get('--reason')!);
  let result: Result;
  if (a.has('--memory')) {
    const { MemoryDataStore } = await import('../infra/memory-store.js');
    result = await run(new MemoryDataStore());
  } else {
    const { withCatalogOwnershipAccess } = await import('./data-access-runtime.js');
    result = await withCatalogOwnershipAccess(Boolean(kind), stableDigest(plan ?? { target, approvedBy }), run,
      kind ? store => preflightOwnership(store, plan, digest, target, kind).then(() => undefined) : undefined);
  }
  if ('plan' in result && a.has('--plan-out')) await writePrivateArtifact(a.get('--plan-out')!, result.plan);
  const report = 'plan' in result ? result.report : result;
  console.log(JSON.stringify(report, null, 2));
  if ('readbackOk' in report && !report.readbackOk) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`OWNERSHIP_JOB_HOLD ${e instanceof Error ? e.message : ''}`.trim()); process.exitCode = 1; });
}
