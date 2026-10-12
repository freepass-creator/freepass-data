import { stableDigest } from '../shared/stable-digest.js';
import { sourceProductKey, sourceSaleAvailable, validateSourceRecord, type SourceFamily, type SourceProductRecord } from '../domain/source-engine.js';

/** An adapter must use CatalogStore transactions and its existing writer/receipt/audit fences.
 * This is a command boundary, not permission to implement another persistence repository.
 */
export interface SourceRecordCommands {
  read(sourceId: string, uid: string): Promise<SourceProductRecord | null>;
  backup(key: string, before: SourceProductRecord | null): Promise<void>;
  readBackup(key: string): Promise<SourceProductRecord | null>;
  compareAndApply(beforeDigest: string, after: SourceProductRecord, commandKey: string): Promise<void>;
}
export type SourceEnginePlan = {
  schema: 'source-engine-plan/v1'; family: SourceFamily; plannedAt: number;
  entries: Array<{ before: SourceProductRecord | null; observed: SourceProductRecord; after: SourceProductRecord; reasons: string[] }>;
  held: Array<{ key: string; reasons: string[] }>;
};
export async function planSourceRecords(reader: Pick<SourceRecordCommands, 'read'>, records: readonly SourceProductRecord[],
  family: SourceFamily, now: number) {
  const plan: SourceEnginePlan = { schema: 'source-engine-plan/v1', family, plannedAt: now, entries: [], held: [] };
  if (!Number.isFinite(now)) throw new Error('SOURCE_ENGINE_TIME_INVALID');
  const counts = new Map<string, number>();
  for (const r of records) counts.set(sourceProductKey(r), (counts.get(sourceProductKey(r)) ?? 0) + 1);
  for (const record of records) {
    const r = structuredClone(record), key = sourceProductKey(r), reasons = validateSourceRecord(r);
    if (Date.parse(r.observedAt) > now) reasons.push('OBSERVATION_INVALID');
    if (counts.get(key)! > 1) reasons.push('DUPLICATE_UID');
    if (reasons.some(x => ['RECORD_SHAPE_INVALID', 'IDENTITY_REQUIRED', 'OBSERVATION_INVALID', 'DUPLICATE_UID'].includes(x))) {
      plan.held.push({ key, reasons }); continue;
    }
    const before = await reader.read(r.sourceId, r.uid);
    if (before && (sourceProductKey(before) !== key || Date.parse(before.observedAt) >= Date.parse(r.observedAt))) {
      plan.held.push({ key, reasons: ['STALE_OR_MISMATCHED_RECORD'] }); continue;
    }
    if (!before && r.vehicleHold.length) {
      plan.held.push({ key, reasons: ['NEW_VEHICLE_REVIEW_REQUIRED'] }); continue;
    }
    // Conditions are one atomic bundle. A HOLD preserves old terms but disables quote/sale eligibility.
    const after = structuredClone(r);
    if (reasons.includes('TERMS_HOLD') && before) after.terms = structuredClone(before.terms);
    after.status.saleAvailable = sourceSaleAvailable(r, family, now) && !reasons.length;
    if (r.vehicleHold.length) reasons.push('VEHICLE_REVIEW_REQUIRED');
    plan.entries.push({ before: structuredClone(before), observed: r, after, reasons });
  }
  // Explicit stops go first. Missing rows never generate updates, even on a complete read.
  plan.entries.sort((a, b) => Number(a.after.status.saleAvailable !== false) - Number(b.after.status.saleAvailable !== false));
  return { plan, report: { mode: 'DRY_RUN', writes: 0, planned: plan.entries.length, held: plan.held.length,
    planDigest: stableDigest(plan) } };
}
export async function applySourceRecords(commands: SourceRecordCommands, input: SourceEnginePlan,
  options: { apply?: boolean; digest?: string; approval?: string; now: number }) {
  const plan = structuredClone(input), digest = stableDigest(plan);
  if (!options.apply) return { mode: 'DRY_RUN', writes: 0, planDigest: digest };
  if (plan.schema !== 'source-engine-plan/v1' || options.digest !== digest || options.approval !== digest)
    throw new Error('SOURCE_ENGINE_APPROVED_DIGEST_REQUIRED');
  if (!Number.isFinite(options.now) || options.now < plan.plannedAt) throw new Error('SOURCE_ENGINE_TIME_INVALID');
  // Recompute to reject forged after values, duplicate UID, stale evidence and expired reactivation.
  const recomputed = await planSourceRecords(commands, plan.entries.map(e => e.observed), plan.family, plan.plannedAt);
  if (recomputed.plan.entries.length !== plan.entries.length || plan.entries.some((e, i) =>
    stableDigest(e) !== stableDigest(recomputed.plan.entries[i]) ||
    (e.after.status.saleAvailable === true && !sourceSaleAvailable(e.after, plan.family, options.now))))
    throw new Error('SOURCE_ENGINE_REPLAN_REQUIRED');
  // All original documents must have a durable, verified backup before the first mutation.
  for (const e of plan.entries) {
    const backupKey = `${digest}:${sourceProductKey(e.after)}`;
    await commands.backup(backupKey, e.before);
    if (stableDigest(await commands.readBackup(backupKey)) !== stableDigest(e.before)) throw new Error('SOURCE_ENGINE_BACKUP_MISMATCH');
  }
  let writes = 0;
  const failed: string[] = [];
  for (const e of plan.entries) {
    const key = sourceProductKey(e.after);
    try {
      await commands.compareAndApply(stableDigest(e.before), e.after, `${digest}:${key}`);
      writes++;
      if (stableDigest(await commands.read(e.after.sourceId, e.after.uid)) !== stableDigest(e.after)) failed.push(key);
    } catch { failed.push(key); }
  }
  return { mode: 'APPLY', status: failed.length ? 'PARTIAL_HOLD' : 'APPLIED', writes, failed, planDigest: digest };
}
