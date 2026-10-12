import { sourceProductKey, sourceSaleAvailable, validateSourceRecord, SOURCE_EXPIRY_SECONDS,
  type SourceProductRecord } from '../domain/source-engine.js';
import { stableDigest } from '../shared/stable-digest.js';

import type { CycleProduct, CycleSnapshot, CycleCommands, CycleConfig, CycleEvidence, CyclePlan } from '../ports/source-cycle.js';
export * from '../ports/source-cycle.js';

export const deepEqual = (a: unknown, b: unknown) => stableDigest(a) === stableDigest(b);
const locked = (p: CycleProduct) => p.locked_by_contract || p.record.status.raw === '계약중';
// Observation timestamps belong in RAW/heartbeat; unchanged business facts do not churn products.
const withoutObservationClocks = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutObservationClocks);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['observedAt', 'captured_at', 'synced_at'].includes(key))
    .map(([key, child]) => [key, withoutObservationClocks(child)]));
  return value;
};
const facts = (r: SourceProductRecord) => withoutObservationClocks(r);
export function planSourceCycle(config: CycleConfig, evidence: CycleEvidence, snapshot: CycleSnapshot, now: number) {
  if (!config.sourceId || !Object.hasOwn(SOURCE_EXPIRY_SECONDS, config.family) || !Number.isFinite(now) || !Number.isFinite(config.maxDowngradeRatio) ||
      config.maxDowngradeRatio <= 0 || config.maxDowngradeRatio > 1) throw new Error('CYCLE_CONFIG_INVALID');
  // Monthly model offers are observations, never vehicle identities or absence candidates.
  if (config.family === 'AICA') {
    const vehicle = (r: SourceProductRecord) => r.raw.source_tab !== '월렌트' && r.raw.product_group !== 'MONTHLY';
    evidence = { ...evidence, records: evidence.records.filter(vehicle) };
    snapshot = { ...snapshot, products: snapshot.products.filter(p => vehicle(p.record)) };
  }
  const plan: CyclePlan = { schema: 'source-cycle/v1', config: { sourceId: config.sourceId, family: config.family,
    maxDowngradeRatio: config.maxDowngradeRatio }, plannedAt: now,
    evidence: structuredClone(evidence), entries: [], held: evidence.heldCount, blockers: [], sourceCount: 0,
    warnings: [], unassignedPlateCount: evidence.unassignedPlateCount ?? 0,
    exposedBefore: snapshot.products.filter(p => p.listable).length };
  if (!snapshot.complete) plan.blockers.push('CATALOG_INCOMPLETE');
  if (!evidence.complete) plan.blockers.push('SOURCE_INCOMPLETE');
  if (snapshot.products.some(p => p.record.sourceId !== config.sourceId) ||
      new Set(snapshot.products.map(p => sourceProductKey(p.record))).size !== snapshot.products.length)
    plan.blockers.push('CATALOG_IDENTITY_INVALID');
  const at = Date.parse(evidence.observedAt ?? '');
  const fresh = Number.isFinite(at) && at <= now && now - at <= SOURCE_EXPIRY_SECONDS[config.family] * 1000;
  if (!fresh) plan.blockers.push('SOURCE_STALE');
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const r of evidence.records) {
    const key = sourceProductKey(r);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  const mine = new Map(snapshot.products.map(p => [sourceProductKey(p.record), p]));
  const withdraw = (before: CycleProduct, reason: string, observed?: SourceProductRecord) => {
    const after = structuredClone(before);
    if (observed) after.record = structuredClone(observed);
    after.record.status.saleAvailable = false;
    after.listable = false;
    after.publication_withdrawal ??= { reason, source: config.sourceId, observedAt: evidence.observedAt!, deleteAuthorized: false };
    after.publication_withdrawal_prior ??= { listable: before.listable, status: structuredClone(before.record.status) };
    return after;
  };
  let identityHolds = false;
  for (const r of evidence.records) {
    const key = sourceProductKey(r), before = mine.get(key) ?? null, errors = validateSourceRecord(r);
    if (r.sourceId !== config.sourceId || duplicates.has(key) ||
        errors.some(e => ['RECORD_SHAPE_INVALID', 'IDENTITY_REQUIRED', 'OBSERVATION_INVALID'].includes(e))) {
      identityHolds = true; plan.held++; continue;
    }
    const sale = sourceSaleAvailable(r, config.family, now);
    if (r.status.saleAvailable === true) plan.sourceCount++;
    if (before && locked(before)) { plan.held++; continue; }
    if (errors.includes('STATUS_UNKNOWN')) { plan.held++; continue; }
    if (errors.includes('TERMS_HOLD')) plan.held++;
    if (Date.parse(r.observedAt) > now || (before && Date.parse(r.observedAt) < Date.parse(before.record.observedAt))) {
      plan.held++; continue;
    }
    const next = structuredClone(r);
    if (errors.includes('TERMS_HOLD') && before) next.terms = structuredClone(before.record.terms);
    next.status.saleAvailable = sale;
    let after: CycleProduct = { ...(before ? structuredClone(before) : {}), record: next, listable: sale, locked_by_contract: false,
      publication_withdrawal: null, publication_withdrawal_prior: before?.publication_withdrawal_prior ?? null };
    if (!sale) {
      if (!before) { plan.held++; continue; }
      after = withdraw(before, r.status.saleAvailable === false ? 'SOURCE_NOT_SELLABLE' : 'SOURCE_VALIDATION_HOLD', next);
    }
    // Vehicle master review stays attached; source facts/conditions may enroll without inventing a model.
    if (before && deepEqual(facts(before.record), facts(after.record)) && before.listable === after.listable &&
        deepEqual(before.publication_withdrawal, after.publication_withdrawal)) continue;
    plan.entries.push({ kind: !before ? 'ENROLL' : before.listable && !after.listable ? 'DOWNGRADE' :
      !before.listable && after.listable ? 'REEXPOSE' : 'UPDATE', before: structuredClone(before), after });
  }
  // Missing/unidentified rows may hide any UID: never infer absence from a partial normalization.
  const absenceUnsafe = evidence.heldCount > 0 || identityHolds || plan.unassignedPlateCount > 0;
  if (absenceUnsafe) plan.warnings.push('ABSENCE_DOWNGRADE_SKIPPED');
  if (evidence.complete && !absenceUnsafe && fresh) {
    for (const before of snapshot.products) {
      if (!before.listable || seen.has(sourceProductKey(before.record)) || locked(before)) continue;
      if (Date.parse(before.record.observedAt) > at) { plan.held++; continue; }
      plan.entries.push({ kind: 'DOWNGRADE', before: structuredClone(before), after: withdraw(before, 'SOURCE_ABSENT') });
    }
  }
  const down = plan.entries.filter(e => e.kind === 'DOWNGRADE').length;
  if (plan.exposedBefore && down / plan.exposedBefore > config.maxDowngradeRatio) plan.blockers.push('DOWNGRADE_RATIO_EXCEEDED');
  plan.entries.sort((a, b) => Number(a.kind !== 'DOWNGRADE') - Number(b.kind !== 'DOWNGRADE') ||
    sourceProductKey(a.after.record).localeCompare(sourceProductKey(b.after.record)));
  return { plan, digest: stableDigest(plan), writes: 0 as const };
}

export async function applySourceCycle(commands: CycleCommands, input: CyclePlan,
  options: { apply?: boolean; digest?: string; approval?: string; now: number }) {
  const plan = structuredClone(input), digest = stableDigest(plan);
  if (!options.apply) return { status: 'DRY_RUN', writes: 0, verified: 0, uncertain: [] as string[], digest };
  if (options.digest !== digest || options.approval !== digest) throw new Error('CYCLE_APPROVED_DIGEST_REQUIRED');
  if (plan.blockers.length || options.now < plan.plannedAt || !Number.isFinite(options.now)) throw new Error('CYCLE_BLOCKED');
  const snapshot = await commands.list(plan.config.sourceId);
  const replay = planSourceCycle(plan.config, plan.evidence, snapshot, plan.plannedAt);
  if (!deepEqual(replay.plan, plan) || planSourceCycle(plan.config, plan.evidence, snapshot, options.now).plan.blockers.length ||
      plan.entries.some(e => e.after.listable && !sourceSaleAvailable(e.after.record, plan.config.family, options.now)))
    throw new Error('CYCLE_REPLAN_REQUIRED');
  for (const e of plan.entries) {
    const key = `${digest}:${sourceProductKey(e.after.record)}`;
    await commands.backup(key, e.before);
    if (!deepEqual(await commands.readBackup(key), e.before)) throw new Error('CYCLE_BACKUP_MISMATCH');
  }
  let writes = 0, verified = 0;
  const uncertain: string[] = [];
  for (const e of plan.entries) {
    const key = sourceProductKey(e.after.record);
    try {
      await commands.compareAndApply(stableDigest(e.before), e.after, `${digest}:${key}`);
      writes++;
      if (!deepEqual(await commands.read(e.after.record.sourceId, e.after.record.uid), e.after)) { uncertain.push(key); break; }
      verified++;
    } catch { uncertain.push(key); break; } // May have committed: never auto-rollback or retry blindly.
  }
  return { status: uncertain.length ? 'APPLY_UNCERTAIN' : 'APPLIED', writes, verified, uncertain, digest };
}
