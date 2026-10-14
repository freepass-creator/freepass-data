import { sourceProductKey, sourceSaleAvailable, validateSourceRecord, termIdentity, compactRecord, SOURCE_EXPIRY_SECONDS,
  type SourceProductRecord } from '../domain/source-engine.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import { stableDigest } from '../shared/stable-digest.js';
import { reconcileSource } from './source-reconciliation.js';

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
// 변경 판정은 압축 형태로 한다: 문서에는 압축 레코드만 저장하므로 저장된 값과 새 원천 값을 같은 기준으로 비교한다(원문이 바뀌면 digest 가 바뀐다).
const facts = (r: SourceProductRecord) => withoutObservationClocks(compactRecord(r));
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
    maxDowngradeRatio: config.maxDowngradeRatio, ...(config.downgradeFloor ? { downgradeFloor: config.downgradeFloor } : {}),
    ...(config.absenceReason ? { absenceReason: config.absenceReason } : {}) }, plannedAt: now,
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
    delete after.rewriteReasons;   // 읽기 경로가 계산하는 표시일 뿐 쓰기 결과(내려간 문서)에는 남지 않는다
    if (observed) after.record = structuredClone(observed);
    after.record.status.saleAvailable = false;
    after.listable = false;
    after.publication_withdrawal ??= { reason, source: config.sourceId, observedAt: evidence.observedAt!, deleteAuthorized: false };
    after.publication_withdrawal_prior ??= { listable: before.listable, status: structuredClone(before.record.status) };
    // 문서에는 압축 레코드(raw 는 digest)만 저장되고 되읽기도 그 형태로 돌아온다. 원문이 복원된 before.record 를 그대로 after 에 두면
    // 부재 하향 적용 뒤 되읽기가 항상 불일치해 APPLY_UNCERTAIN 이 된다(2026-10-14 RP004 하향 11건 중 1건만 적용·정지 실측).
    after.record = compactRecord(after.record);
    return after;
  };
  let identityHolds = false, depositPreserved = 0, uidBridged = 0;
  // 문서 ID 가 다른 같은 차량(옛 ID 체계로 만든 문서): 같은 공급사 안에서 차량번호가 같은 문서가 정확히 하나이고 어떤 원천 행과도 직접
  // 대응하지 않으면 그 문서를 갱신 대상으로 잇는다. 새 문서를 만들고 옛 문서를 내리면 문서에 붙은 사진·정책 등이 새 문서에 없어
  // 화면이 퇴보한다(2026-10-13 이안카: 옛 iancar_* ID 문서 21건 하향 + 번호판 ID 23건 편입 계획). 문서 ID 는 옮기지 않는다.
  const platePool = new Map<string, CycleProduct[]>();
  for (const p of snapshot.products) if (isAssignedPlate(p.record.plate)) {
    const k = plateIdentityKey(p.record.plate);
    (platePool.get(k) ?? platePool.set(k, []).get(k)!).push(p);
  }
  for (const original of evidence.records) {
    let r = original;
    let key = sourceProductKey(r), before = mine.get(key) ?? null;
    if (!before && !duplicates.has(key) && isAssignedPlate(r.plate)) {
      const candidates = (platePool.get(plateIdentityKey(r.plate)) ?? []).filter(p => !seen.has(sourceProductKey(p.record)));
      if (candidates.length === 1) {
        before = candidates[0]!; r = { ...r, uid: before.record.uid }; key = sourceProductKey(r);
        seen.add(key); uidBridged++;
      } else if (candidates.length > 1) {
        // 같은 번호의 옛 문서가 둘 이상이면 어느 문서가 이 차인지 알 수 없다: 새 문서를 만들고 옛 문서를 내리지 않고 보류한다
        // (보류는 부재 하향도 막아 두 문서 모두 그대로 남는다).
        identityHolds = true; plan.held++;
        if (!plan.warnings.includes('UID_BRIDGE_AMBIGUOUS')) plan.warnings.push('UID_BRIDGE_AMBIGUOUS');
        continue;
      }
    }
    const errors = validateSourceRecord(r);
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
    const next = compactRecord(r);   // 문서에 쓰이는 형태. 원천 원문 전체는 계획 evidence·백업에만 있고 문서에는 digest 로 남는다
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
      if (!before) { if (!errors.includes('TERMS_HOLD')) plan.held++; continue; }   // TERMS_HOLD 는 위에서 이미 센 행이다(이중 계수 방지, RP004 4524 실측)
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
        !(snapshot.acceptedDrift ?? []).includes(before.record.uid) && !(before.rewriteReasons?.length && after.listable)) continue;
    delete after.rewriteReasons;   // 읽기 경로가 계산하는 표시일 뿐 쓰기 결과의 일부가 아니다
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
      plan.entries.push({ kind: 'DOWNGRADE', before: structuredClone(before), after: withdraw(before, config.absenceReason ?? 'SOURCE_ABSENT') });
    }
  }
  if (depositPreserved > 0) plan.warnings.push(`DEPOSIT_PRESERVED:${depositPreserved}`);
  if (uidBridged > 0) plan.warnings.push(`UID_BRIDGED:${uidBridged}`);
  // 대표 지시 하향(DECISION_WITHDRAWN)은 추론이 아니라 결정이고 공급사 코드로 범위가 정해져 있어 비율 가드 대상이 아니다.
  const downs = plan.entries.filter(e => e.kind === 'DOWNGRADE' && e.after.publication_withdrawal?.reason !== 'DECISION_WITHDRAWN');
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
  // 신규 편입 회차 상한(독립 검토 BLOCK, 대표 2026-10-14): 한 회차에 min(100, max(30, 원천 판매가능의 25%))대까지만 넣고 나머지는 다음 회차로 이월한다.
  // 키 순서가 고정이라 같은 입력이면 같은 대수가 들어가고, 적용 재계획(replay)도 같은 결과다. 이월분은 보류가 아니라 대기라 held 에 세지 않는다.
  const enrollCap = Math.min(config.maxEnrollPerCycle ?? 100, Math.max(config.minEnrollPerCycle ?? 30, Math.floor(plan.sourceCount * 0.25)));
  const enrolls = plan.entries.filter(e => e.kind === 'ENROLL');
  if (enrolls.length > enrollCap) {
    const deferred = new Set(enrolls.slice(enrollCap).map(e => sourceProductKey(e.after.record)));
    plan.entries = plan.entries.filter(e => e.kind !== 'ENROLL' || !deferred.has(sourceProductKey(e.after.record)));
    plan.warnings.push(`ENROLL_CAP_DEFERRED:${deferred.size}:cap${enrollCap}`);
  }
  // 정합 보고는 계획 시점(적용 전) 원천 판매 가능 집합 ↔ ERP5 노출 집합의 차이다. 계획 digest 에는 넣지 않는다(보고 전용).
  return { plan, digest: stableDigest(plan), writes: 0 as const, reconciliation: reconcileSource(evidence.records, snapshot.products) };
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
  await commands.precheck?.(plan.entries.map(e => e.after));   // 크기 한도 등 거절될 쓰기는 백업·쓰기 전에 전체 계획을 막는다
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
