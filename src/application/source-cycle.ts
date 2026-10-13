import { sourceProductKey, sourceSaleAvailable, validateSourceRecord, termIdentity, SOURCE_EXPIRY_SECONDS,
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
  // Preserve legacy monthly observations; SPEC3D typed monthly offers participate in the cycle.
  if (config.family === 'AICA') {
    const vehicle = (r: SourceProductRecord) => r.raw.product_group === 'MONTHLY_RENT' ||
      (r.raw.source_tab !== '월렌트' && r.raw.product_group !== 'MONTHLY');
    evidence = { ...evidence, records: evidence.records.filter(vehicle) };
    snapshot = { ...snapshot, products: snapshot.products.filter(p => vehicle(p.record)) };
  }
  const plan: CyclePlan = { schema: 'source-cycle/v1', config: { sourceId: config.sourceId, family: config.family,
    maxDowngradeRatio: config.maxDowngradeRatio, ...(config.downgradeFloor ? { downgradeFloor: config.downgradeFloor } : {}) }, plannedAt: now,
    evidence: structuredClone(evidence), entries: [], held: evidence.heldCount, blockers: [], sourceCount: 0,
    warnings: [], unassignedPlateCount: evidence.unassignedPlateCount ?? 0,
    exposedBefore: snapshot.products.filter(p => p.listable).length };
  if (snapshot.acceptedDrift?.length) plan.warnings.push(`DRIFT_ACCEPTED:${snapshot.acceptedDrift.length}:${stableDigest(snapshot.acceptedDrift).slice(0, 12)}`);
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
  const driftHeld = new Set(snapshot.driftHeld ?? []);
  if (driftHeld.size) plan.warnings.push(`DRIFT_HELD:${driftHeld.size}:${stableDigest([...driftHeld].sort()).slice(0, 12)}`);
  const withdraw = (before: CycleProduct, reason: string, observed?: SourceProductRecord) => {
    const after = structuredClone(before);
    if (observed) after.record = structuredClone(observed);
    after.record.status.saleAvailable = false;
    after.listable = false;
    after.publication_withdrawal ??= { reason, source: config.sourceId, observedAt: evidence.observedAt!, deleteAuthorized: false };
    after.publication_withdrawal_prior ??= { listable: before.listable, status: structuredClone(before.record.status) };
    return after;
  };
  let identityHolds = false, depositPreserved = 0;
  for (const r of evidence.records) {
    const key = sourceProductKey(r), before = mine.get(key) ?? null, errors = validateSourceRecord(r);
    if (r.sourceId !== config.sourceId || duplicates.has(key) ||
        errors.some(e => ['RECORD_SHAPE_INVALID', 'IDENTITY_REQUIRED', 'OBSERVATION_INVALID'].includes(e))) {
      identityHolds = true; plan.held++; continue;
    }
    const sale = sourceSaleAvailable(r, config.family, now);
    if (r.status.saleAvailable === true) plan.sourceCount++;
    if (before && locked(before)) { plan.held++; continue; }
    if (before && driftHeld.has(before.record.uid)) {
      // 이 문서를 원천 값으로 쓰면 외부에서 바뀐 가격을 덮는다 — 보정 허용(-AcceptDrift)이 있어야만 통과한다.
      if (!plan.blockers.includes('CATALOG_SOURCE_RECORD_DRIFT')) plan.blockers.push('CATALOG_SOURCE_RECORD_DRIFT');
      continue;
    }
    if (errors.includes('STATUS_UNKNOWN')) { plan.held++; continue; }
    if (errors.includes('TERMS_HOLD')) plan.held++;
    if (Date.parse(r.observedAt) > now || (before && Date.parse(r.observedAt) < Date.parse(before.record.observedAt))) {
      plan.held++; continue;
    }
    const next = structuredClone(r);
    if (errors.includes('TERMS_HOLD') && before) next.terms = structuredClone(before.record.terms);
    else if (before) {
      // 원천 보증금 UNKNOWN(빈칸·해석 불가)은 확인된 원천 값이 아니다 — 같은 개월의 기존 KNOWN/ZERO 보증금을 지우지 않는다
      // (저장소 불변식: unknown/null 은 마지막 정상값 보존. Codex 상의 2026-10-13). 대여료·ZERO·KNOWN 은 원천 값 그대로.
      for (const term of next.terms) {
        const prior = before.record.terms.find(p => termIdentity(p) === termIdentity(term)) ??
          // 기존 문서가 개월 키 하나(대표 항)만 가진 경우: 같은 개월의 유일한 항과만 짝짓는다
          (before.record.terms.filter(p => p.months === term.months).length === 1 ? before.record.terms.find(p => p.months === term.months) : undefined);
        if (term.deposit.state === 'UNKNOWN' && prior && (prior.deposit.state === 'KNOWN' || prior.deposit.state === 'ZERO')) {
          term.deposit = structuredClone(prior.deposit); depositPreserved++;
        }
      }
    }
    next.status.saleAvailable = sale;
    let after: CycleProduct = { ...(before ? structuredClone(before) : {}), record: next, listable: sale, locked_by_contract: false,
      publication_withdrawal: null, publication_withdrawal_prior: before?.publication_withdrawal_prior ?? null };
    if (!sale) {
      if (!before) { plan.held++; continue; }
      after = withdraw(before, r.status.saleAvailable === false ? 'SOURCE_NOT_SELLABLE' : 'SOURCE_VALIDATION_HOLD', next);
    }
    if (!before && Object.hasOwn(snapshot, 'enrollmentSupplier')) {
      if (!snapshot.enrollmentSupplier?.provider_name.trim()) {
        plan.held++;
        if (!plan.warnings.includes('SUPPLIER_NAME_REQUIRED')) plan.warnings.push('SUPPLIER_NAME_REQUIRED');
        continue;
      }
      after.supplierFields = structuredClone(snapshot.enrollmentSupplier);
    }
    // Vehicle master review stays attached; source facts/conditions may enroll without inventing a model.
    // 보정 허용으로 통과한 문서는 값이 원천과 같아도 한 번 다시 쓴다: 저장된 가격 digest 를 현재 값에 맞춰야 다음 회차부터
    // 보정 허용 없이 통과한다(안 쓰면 digest 가 낡은 채 남아 매 회차 DRIFT HOLD 가 반복된다 — 2026-10-13 RP013 실측).
    if (before && deepEqual(facts(before.record), facts(after.record)) && before.listable === after.listable &&
        deepEqual(before.publication_withdrawal, after.publication_withdrawal) &&
        !(snapshot.acceptedDrift ?? []).includes(before.record.uid)) continue;
    plan.entries.push({ kind: !before ? 'ENROLL' : before.listable && !after.listable ? 'DOWNGRADE' :
      !before.listable && after.listable ? 'REEXPOSE' : 'UPDATE', before: structuredClone(before), after });
  }
  // Missing/unidentified rows may hide any UID: never infer absence from a partial normalization.
  const absenceUnsafe = evidence.heldCount > 0 || identityHolds || plan.unassignedPlateCount > 0;
  if (absenceUnsafe) plan.warnings.push('ABSENCE_DOWNGRADE_SKIPPED');
  if (evidence.complete && !absenceUnsafe && fresh) {
    for (const before of snapshot.products) {
      if (!before.listable || seen.has(sourceProductKey(before.record)) || locked(before) || driftHeld.has(before.record.uid)) continue;
      if (Date.parse(before.record.observedAt) > at) { plan.held++; continue; }
      plan.entries.push({ kind: 'DOWNGRADE', before: structuredClone(before), after: withdraw(before, 'SOURCE_ABSENT') });
    }
  }
  if (depositPreserved > 0) plan.warnings.push(`DEPOSIT_PRESERVED:${depositPreserved}`);
  const downs = plan.entries.filter(e => e.kind === 'DOWNGRADE');
  const absentDown = downs.filter(e => e.after.publication_withdrawal?.reason === 'SOURCE_ABSENT').length;
  const explicitDown = downs.length - absentDown;
  const floor = config.downgradeFloor ?? 0;
  if (plan.exposedBefore) {
    // floor 0(기본·옛 동작): 합산 비율. floor>0(런타임 기본 3, Codex 상의): 사유별 분리 — 부재 추론(SOURCE_ABSENT)은 비율 AND 절대 개수 초과일 때만 차단,
    // 시트가 명시한 불가·계약중 등은 상태 열 오매핑 같은 대량 오작동 방지로 max(상한, 0.5) AND 절대 개수 초과일 때만 차단한다.
    const over = floor > 0
      ? (absentDown > floor && absentDown / plan.exposedBefore > config.maxDowngradeRatio) ||
        (explicitDown > floor && explicitDown / plan.exposedBefore > Math.max(config.maxDowngradeRatio, 0.5))
      : downs.length / plan.exposedBefore > config.maxDowngradeRatio;
    if (over) plan.blockers.push('DOWNGRADE_RATIO_EXCEEDED');
  }
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
