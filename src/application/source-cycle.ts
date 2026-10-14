import { sourceProductKey, sourceSaleAvailable, validateSourceRecord, termIdentity, compactRecord, comparableRecord, SOURCE_EXPIRY_SECONDS,
  type SourceProductRecord } from '../domain/source-engine.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import { stableDigest } from '../shared/stable-digest.js';
import { reconcileSource } from './source-reconciliation.js';

import type { CycleProduct, CycleSnapshot, CycleCommands, CycleConfig, CycleEvidence, CyclePlan } from '../ports/source-cycle.js';
export * from '../ports/source-cycle.js';

export const deepEqual = (a: unknown, b: unknown) => stableDigest(a) === stableDigest(b);
// 계약 잠금 = 저장소가 판정한 locked_by_contract(계약 원장·ERP 가 건 잠금, 엔진이 쓴 계약중 상태는 제외 — infra envelope). 원천 원문이 계약중이라는 이유만으로는
// 잠그지 않는다: 계약중 노출 정책에서 그 문서는 엔진이 계속 갱신(출고가능 복귀·철회)해야 한다.
const locked = (p: CycleProduct) => p.locked_by_contract;
// Observation timestamps belong in RAW/heartbeat; unchanged business facts do not churn products.
const withoutObservationClocks = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutObservationClocks);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['observedAt', 'captured_at', 'synced_at'].includes(key))
    .map(([key, child]) => [key, withoutObservationClocks(child)]));
  return value;
};
// 변경 판정은 압축 형태로 한다: 문서에는 압축 레코드만 저장하므로 저장된 값과 새 원천 값을 같은 기준으로 비교한다(원문이 바뀌면 digest 가 바뀐다).
// spec 은 문서에 실제 값으로 남지만(새 문서 사실 칸), 비교는 digest 로 한다 — 옛 문서(digest 저장)와 값이 같으면 변경 없음.
const facts = (r: SourceProductRecord) => withoutObservationClocks(comparableRecord(r));
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
    ...(config.absenceReason ? { absenceReason: config.absenceReason } : {}),
    ...(config.enrollCapOnce ? { enrollCapOnce: config.enrollCapOnce } : {}) }, plannedAt: now,
    evidence: structuredClone(evidence), entries: [], held: evidence.heldCount, blockers: [], sourceCount: 0,
    warnings: [], unassignedPlateCount: evidence.unassignedPlateCount ?? 0,
    exposedBefore: snapshot.products.filter(p => p.listable).length };
  // 계획 단계 보류의 사유 코드별 건수(보고 전용, plan digest 에 넣지 않는다). RP021 보류 3건이 코드 없이 세어져 원인을 못 가리던 문제(B3Q 2026-10-14).
  const heldBy: Record<string, number> = {};
  const hold = (code: string) => { plan.held++; heldBy[code] = (heldBy[code] ?? 0) + 1; };
  let infoIncomplete = 0, notSellableEnrolled = 0, statusUnknownExposed = 0;
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
  const foreignUids = new Set(snapshot.foreignUids ?? []);
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
  // 번호 없이 지문 키(FP-…)로 만든 문서: 같은 행에 번호가 생기면 새 문서를 만들지 않고 같은 문서에 번호를 채운다(대표 10-14 «번호가 배정되면 그걸 업데이트»).
  // 짝은 행 지문(raw.row_fingerprint)이고, 같은 지문의 번호 없는 문서가 정확히 하나일 때만 잇는다(둘 이상이면 어느 쪽인지 모르므로 보류).
  const fingerprintPool = new Map<string, CycleProduct[]>();
  for (const p of snapshot.products) {
    const fp = p.record.raw?.row_fingerprint;
    if (typeof fp === 'string' && fp && !isAssignedPlate(p.record.plate)) (fingerprintPool.get(fp) ?? fingerprintPool.set(fp, []).get(fp)!).push(p);
  }
  for (const original of evidence.records) {
    let r = original;
    let key = sourceProductKey(r), before = mine.get(key) ?? null;
    if (!before && !duplicates.has(key) && isAssignedPlate(r.plate)) {
      let candidates = (platePool.get(plateIdentityKey(r.plate)) ?? []).filter(p => !seen.has(sourceProductKey(p.record)));
      const fp = r.raw?.row_fingerprint;
      if (!candidates.length && typeof fp === 'string' && fp) {
        candidates = (fingerprintPool.get(fp) ?? []).filter(p => !seen.has(sourceProductKey(p.record)));
      }
      if (candidates.length === 1) {
        before = candidates[0]!; r = { ...r, uid: before.record.uid }; key = sourceProductKey(r);
        seen.add(key); uidBridged++;
      } else if (candidates.length > 1) {
        // 같은 번호의 옛 문서가 둘 이상이면 어느 문서가 이 차인지 알 수 없다: 새 문서를 만들고 옛 문서를 내리지 않고 보류한다
        // (보류는 부재 하향도 막아 두 문서 모두 그대로 남는다).
        identityHolds = true; hold('UID_BRIDGE_AMBIGUOUS');
        if (!plan.warnings.includes('UID_BRIDGE_AMBIGUOUS')) plan.warnings.push('UID_BRIDGE_AMBIGUOUS');
        continue;
      }
    }
    const errors = validateSourceRecord(r);
    if (r.sourceId !== config.sourceId || duplicates.has(key) ||
        errors.some(e => ['RECORD_SHAPE_INVALID', 'IDENTITY_REQUIRED', 'OBSERVATION_INVALID'].includes(e))) {
      identityHolds = true; hold('IDENTITY_OR_DUPLICATE'); continue;
    }
    const sale = sourceSaleAvailable(r, config.family, now);
    if (r.status.saleAvailable === true) plan.sourceCount++;
    // 같은 번호(문서 ID)를 다른 공급사 문서가 이미 쓰고 있다: 편입하면 문서 ID 충돌(CAS_CONFLICT → APPLY_UNCERTAIN)로 공급사 회차 전체가 멈춘다.
    // 그 행만 보류하고 나머지는 진행한다(어느 공급사 차인지는 사람이 판단 — 남의 문서를 덮어쓰지 않는다).
    if (!before && foreignUids.has(r.uid)) {
      hold('PLATE_OWNED_BY_OTHER_SUPPLIER');
      if (!plan.warnings.includes('PLATE_OWNED_BY_OTHER_SUPPLIER')) plan.warnings.push('PLATE_OWNED_BY_OTHER_SUPPLIER');
      continue;
    }
    if (before && locked(before)) { hold('CONTRACT_LOCKED'); continue; }
    if (before && driftHeld.has(before.record.uid)) {
      // 이 문서를 원천 값으로 쓰면 외부에서 바뀐 가격을 덮는다 — 보정 허용(-AcceptDrift)이 있어야만 통과한다.
      if (!plan.blockers.includes('CATALOG_SOURCE_RECORD_DRIFT')) plan.blockers.push('CATALOG_SOURCE_RECORD_DRIFT');
      continue;
    }
    // 1차는 무조건 가져온다(대표 2026-10-14): 새 차(문서 없음)는 상태를 몰라도 식별자만 있으면 편입한다(노출 제외). 이미 문서가 있는 차는 이전처럼 보류 —
    // 상태를 모르는 값으로 기존 노출을 바꾸지 않는다.
    // 노출 중인 문서가 모르는 상태값(예: 취소·진행중)으로 보류되면 노출이 그대로 남는다 — 조용히 두지 않고 회차 경고로 센다.
    if (errors.includes('STATUS_UNKNOWN') && before) { hold('STATUS_UNKNOWN'); if (before.listable) statusUnknownExposed++; continue; }
    if (errors.includes('TERMS_HOLD')) hold('TERMS_HOLD');
    if (Date.parse(r.observedAt) > now || (before && Date.parse(r.observedAt) < Date.parse(before.record.observedAt))) {
      hold('OBSERVATION_ORDER'); continue;
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
      if (!before) {
        // 대표 2026-10-14 «사진·가격이 없어도 번호라도 가져와 숫자를 맞춘다»: 원천이 판매 가능으로 읽은 새 차가 «가격·기간(TERMS)만» 비어 있으면
        // 편입하되 노출하지 않는다(listable=false, 사유 INFO_INCOMPLETE). 가격이 채워지면 다음 회차에 REEXPOSE 로 노출된다. 식별자(번호/UID)·상태·신선도는 그대로 필요하다.
        // «1차 무조건 갖고 온다»(대표 2026-10-14): 식별자(번호/UID)가 있고 읽기가 신선하면 판매 불가·상태 불명·가격 없음이어도 새 차는 편입한다.
        // 전부 노출 제외(listable=false)라 판매 화면에는 영향이 없고, 사유 코드로 구분한다: 판매 불가 SOURCE_NOT_SELLABLE, 그 밖(가격·기간·상태 정보 부족) INFO_INCOMPLETE.
        // 신선하지 않은 읽기는 SOURCE_STALE 이 회차 전체를 막으므로 여기까지 오지 않는다.
        const reason = r.status.saleAvailable === false ? 'SOURCE_NOT_SELLABLE' : 'INFO_INCOMPLETE';
        after = withdraw({ record: next, listable: false, locked_by_contract: false, publication_withdrawal: null,
          publication_withdrawal_prior: null } as CycleProduct, reason, next);
        if (reason === 'INFO_INCOMPLETE') infoIncomplete++; else notSellableEnrolled++;
      } else after = withdraw(before, r.status.saleAvailable === false ? 'SOURCE_NOT_SELLABLE' : 'SOURCE_VALIDATION_HOLD', next);
    }
    if (!before && Object.hasOwn(snapshot, 'enrollmentSupplier')) {
      if (!snapshot.enrollmentSupplier?.provider_name.trim()) {
        hold('SUPPLIER_NAME_REQUIRED');
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
  const absenceUnsafe = evidence.heldCount - (evidence.benignHeldCount ?? 0) > 0 || identityHolds || plan.unassignedPlateCount > 0;
  if (absenceUnsafe) plan.warnings.push('ABSENCE_DOWNGRADE_SKIPPED');
  if (evidence.complete && !absenceUnsafe && fresh) {
    for (const before of snapshot.products) {
      // 계약 잠금 문서는 부재 하향에서 보호된다. 단 «API 교체 철회»(REPLACED_BY_API, 대표 «API 연동 아닌 건 다 내려라»)는 한 번만(표식) 허용된 결정이라
      // 잠금 문서도 «노출만» 내린다(하드 삭제 아님, 정산 원장·잠금 기록은 건드리지 않는다 — withdraw 는 listable·사유만 바꾼다).
      const lockProtected = locked(before) && config.absenceReason !== 'REPLACED_BY_API';
      if (!before.listable || seen.has(sourceProductKey(before.record)) || lockProtected || driftHeld.has(before.record.uid)) continue;
      if (Date.parse(before.record.observedAt) > at) { hold('OBSERVATION_FUTURE'); continue; }
      plan.entries.push({ kind: 'DOWNGRADE', before: structuredClone(before), after: withdraw(before, config.absenceReason ?? 'SOURCE_ABSENT') });
    }
  }
  if (infoIncomplete > 0) plan.warnings.push(`ENROLLED_INFO_INCOMPLETE:${infoIncomplete}`);
  if (notSellableEnrolled > 0) plan.warnings.push(`ENROLLED_NOT_SELLABLE:${notSellableEnrolled}`);
  if (depositPreserved > 0) plan.warnings.push(`DEPOSIT_PRESERVED:${depositPreserved}`);
  if (statusUnknownExposed > 0) plan.warnings.push(`STATUS_UNKNOWN_EXPOSED:${statusUnknownExposed}`);
  if (uidBridged > 0) plan.warnings.push(`UID_BRIDGED:${uidBridged}`);
  // 대표 지시 하향(DECISION_WITHDRAWN)은 추론이 아니라 결정이고 공급사 코드로 범위가 정해져 있어 비율 가드 대상이 아니다.
  // API 교체 철회(REPLACED_BY_API, 대표 «손오공 기존 거 지우고 API 로»)도 비율 가드 대상이 아니다: 한 번만(표식) 허용된 결정이며 완전 읽기에서만 계획된다.
  const downs = plan.entries.filter(e => e.kind === 'DOWNGRADE' && !['DECISION_WITHDRAWN', 'REPLACED_BY_API'].includes(e.after.publication_withdrawal?.reason ?? ''));
  // NOT_IN_API = 손오공 API 모드의 일반 부재 하향 라벨(SOURCE_ABSENT 와 같은 추론이므로 같은 비율 가드를 받는다).
  const isAbsent = (e: { after: { publication_withdrawal?: { reason?: string } | null } }) => ['SOURCE_ABSENT', 'NOT_IN_API'].includes(e.after.publication_withdrawal?.reason ?? '');
  const absentDown = downs.filter(isAbsent).length;
  const explicitDown = downs.length - absentDown;
  const floor = config.downgradeFloor ?? 0;
  if (plan.exposedBefore) {
    // floor 0(기본·옛 동작): 합산 비율로 회차 전체를 막는다(호환).
    // floor>0(런타임 기본 3): 대표 2026-10-14 «걸림돌 해제» — 회차 전체를 멈추지 않고 «허용분까지만 적용, 나머지는 다음 회차로 이월»한다.
    //   부재 추론(SOURCE_ABSENT) 허용분 = max(절대 하한, 노출의 상한 비율), 원천이 명시한 불가·계약중 등 = max(절대 하한, 노출의 max(상한,0.5)).
    //   이월분은 노출 유지(키 순서 고정이라 같은 입력이면 같은 대수), 경고 DOWNGRADE_DEFERRED 로 남아 사람이 대량 오작동을 알아챈다.
    if (floor > 0) {
      const absentAllow = Math.max(floor, Math.floor(plan.exposedBefore * config.maxDowngradeRatio));
      const explicitAllow = Math.max(floor, Math.floor(plan.exposedBefore * Math.max(config.maxDowngradeRatio, 0.5)));
      const dropKeys = new Set<string>();
      const keyed = (list: typeof downs) => [...list].sort((a, b) => sourceProductKey(a.after.record).localeCompare(sourceProductKey(b.after.record)));
      const absentList = keyed(downs.filter(isAbsent));
      const explicitList = keyed(downs.filter(e => !isAbsent(e)));
      absentList.slice(absentAllow).forEach(e => dropKeys.add(sourceProductKey(e.after.record)));
      explicitList.slice(explicitAllow).forEach(e => dropKeys.add(sourceProductKey(e.after.record)));
      if (dropKeys.size) {
        plan.entries = plan.entries.filter(e => e.kind !== 'DOWNGRADE' || !dropKeys.has(sourceProductKey(e.after.record)));
        plan.warnings.push(`DOWNGRADE_DEFERRED:${dropKeys.size}`);
      }
    } else if (downs.length / plan.exposedBefore > config.maxDowngradeRatio) plan.blockers.push('DOWNGRADE_RATIO_EXCEEDED');
  }
  plan.entries.sort((a, b) => Number(a.kind !== 'DOWNGRADE') - Number(b.kind !== 'DOWNGRADE') ||
    sourceProductKey(a.after.record).localeCompare(sourceProductKey(b.after.record)));
  // 신규 편입 회차 상한(독립 검토 BLOCK, 대표 2026-10-14): 한 회차에 min(100, max(30, 원천 판매가능의 25%))대까지만 넣고 나머지는 다음 회차로 이월한다.
  // 키 순서가 고정이라 같은 입력이면 같은 대수가 들어가고, 적용 재계획(replay)도 같은 결과다. 이월분은 보류가 아니라 대기라 held 에 세지 않는다.
  // 대표 2026-10-14: 상한은 원천 판매 가능 대수의 100%(오매핑 폭주 방지용), 초과분은 다음 회차로 이월한다. 승인 단계는 두지 않는다.
  // 커맨드 센터 확정 2026-10-14: 회차당 max(100, 기존 노출 문서 수의 50%) — «원천 100% = 사실상 무제한» 안은 반려(오매핑 폭주 방어가 안 된다). 초과분은 이월.
  // 설정은 상한을 «줄이기만» 할 수 있다(독립 검토 2026-10-14): 확정 상한과 설정값 중 작은 쪽. minEnrollPerCycle 은 더 이상 상한을 올리지 못한다.
  // 한 번만 상향(대표 2026-10-14 손오공 최초 편입 201대+): enrollCapOnce 는 운영 변수(SOURCE_CYCLE_SONOGONG_ENROLL_CAP_ONCE)가 «이번 한 회차에 한해» 켠다 —
  // 회차 직후 러너가 표식 파일을 남겨 다음 회차부터 자동 원복한다. 절대 상한 1000, plan.config 에 기록되어 적용 재계획(replay)과 같은 결과가 된다.
  const confirmedCap = Math.min(Math.max(100, Math.ceil(plan.exposedBefore * 0.5)), config.maxEnrollPerCycle ?? Number.POSITIVE_INFINITY);
  const enrollCap = config.enrollCapOnce && Number.isSafeInteger(config.enrollCapOnce) && config.enrollCapOnce > confirmedCap
    ? Math.min(config.enrollCapOnce, 1000) : confirmedCap;
  const enrolls = plan.entries.filter(e => e.kind === 'ENROLL');
  if (enrolls.length > enrollCap) {
    const deferred = new Set(enrolls.slice(enrollCap).map(e => sourceProductKey(e.after.record)));
    plan.entries = plan.entries.filter(e => e.kind !== 'ENROLL' || !deferred.has(sourceProductKey(e.after.record)));
    plan.warnings.push(`ENROLL_CAP_DEFERRED:${deferred.size}:cap${enrollCap}`);
  }
  // 엔진 정체성 정제(대표 2026-10-15): 보류 문서 중 이번 마스터로 하나로 특정돼 다시 쓰는 수, 그리고 쓰기가 있는 계획에는 대조에 쓴 마스터 digest 를 남긴다 —
  // 승인 계획을 나중에 적용할 때 마스터가 바뀌었으면 재계획(replay)이 달라져 CYCLE_REPLAN_REQUIRED 로 멈춘다(계획에 없던 이름을 쓰지 않는다).
  const identityRefine = plan.entries.filter(e => e.before?.rewriteReasons?.includes('VEHICLE_IDENTITY')).length;
  if (identityRefine > 0) plan.warnings.push(`VEHICLE_IDENTITY_REFINE:${identityRefine}`);
  if (snapshot.identityMasterDigest && plan.entries.length) plan.warnings.push(`IDENTITY_MASTER:${snapshot.identityMasterDigest.slice(0, 12)}`);
  // 정합 보고는 계획 시점(적용 전) 원천 판매 가능 집합 ↔ ERP5 노출 집합의 차이다. 계획 digest 에는 넣지 않는다(보고 전용).
  return { plan, digest: stableDigest(plan), writes: 0 as const, heldReasons: heldBy, reconciliation: reconcileSource(evidence.records, snapshot.products) };
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
  // 불확실 진단(값 없음): 어느 단계에서, 어느 최상위 필드가 달랐는지 코드만 남긴다. 값·번호·원문은 싣지 않는다.
  let uncertainDetail = '';
  for (const e of plan.entries) {
    const key = sourceProductKey(e.after.record);
    let stage = 'WRITE';
    try {
      await commands.compareAndApply(stableDigest(e.before), e.after, `${digest}:${key}`);
      writes++; stage = 'READ';
      const reread = await commands.read(e.after.record.sourceId, e.after.record.uid);
      if (!deepEqual(reread, e.after)) {
        const a = e.after as unknown as Record<string, unknown>, b = (reread ?? {}) as unknown as Record<string, unknown>;
        const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => !deepEqual(a[k], b[k])).map(k => k.replace(/[^A-Za-z0-9_]/g, '')).sort();
        uncertainDetail = `READBACK_MISMATCH:${e.kind}:${fields.join('+') || 'NONE'}`; uncertain.push(key); break;
      }
      verified++;
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{3,60}$/.test(error.message) ? error.message : 'ERROR';
      uncertainDetail = `${stage}_FAILED:${e.kind}:${code}`; uncertain.push(key); break;
    } // May have committed: never auto-rollback or retry blindly.
  }
  return { status: uncertain.length ? 'APPLY_UNCERTAIN' : 'APPLIED', writes, verified, uncertain, digest, ...(uncertainDetail ? { uncertainDetail } : {}) };
}
