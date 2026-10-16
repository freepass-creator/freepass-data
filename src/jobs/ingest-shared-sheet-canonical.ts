import { sourceFeeLineage } from '../application/kakao-catalog-reference.js';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSharedSheetBatch, sharedSheetRegisteredChannels, sharedSheetUnavailableChannels, SHARED_SHEET_SPEC_DIGEST, type SharedSheetCapture } from '../adapters/shared-sheet-source.js';
import { sharedSheetNormalizer, SHARED_SHEET_RULE_VERSION, SHARED_SHEET_COLOR_RULE_VERSION, sharedSheetStatusPolicy, type SharedSheetIdentityResolver } from '../adapters/normalize-shared-sheet.js';
import { assertVehicleIdentityInputs, verifiedMasterRecords, type VehicleIdentityInputs, type VehicleMasterSnapshot } from '../adapters/vehicle-identity-inputs.js';
import { chooseVehicleIdentity, indexVehicleMaster, VEHICLE_IDENTITY_RULE_VERSION } from '../domain/vehicle-identity-resolution.js';
import { ingestRawSourceBatch, prepareRawSourceBatch } from '../application/ingest-raw-source.js';
import { canonicalizeCatalogCandidate, type CanonicalizeCatalogCandidateInput } from '../application/canonicalize-catalog-candidate.js';
import { reviewSourceChange, applyReviewedSourceChange } from '../application/reviewed-source-change.js';
import { auditOfferEconomicsTerms, precomputeOfferEconomics } from '../application/resolve-offer-commercial-terms.js';
import { KAKAO_COMMISSION_POLICY } from '../application/kakao-catalog-reference.js';
import { decideSourceHead, type SourceRun, type SourceHead } from '../domain/source.js';
import type { ApplyReviewedSourceChangeInput } from '../domain/source-change.js';
import type { CatalogStore } from '../ports/catalog-store.js';
import type { SourceIngestionStore } from '../ports/source-store.js';
import { stableDigest } from '../shared/stable-digest.js';
import { plateIdentityKey } from '../domain/vehicle-plate.js';
import { newVehicleUid, type VehicleUidClock, type VehicleUidRandom } from '../domain/vehicle-uid.js';

const actor = { id: 'service:freepass-data', kind: 'SERVICE' } as const;
const opaque = (prefix: string, ...parts: string[]) => `${prefix}_${stableDigest(parts).slice(0, 24)}`;
export type VehicleAssetIdIssueStrategy = 'LEGACY_PLATE_HASH' | 'ULID';
export function issueVehicleAssetId(input: {
  strategy?: VehicleAssetIdIssueStrategy;
  plate: string;
  clock?: VehicleUidClock;
  random?: VehicleUidRandom;
}) {
  if (input.strategy === 'ULID') return newVehicleUid(input.clock, input.random);
  return opaque('va', 'plate', input.plate);
}
const states = () => ({ KNOWN: 0, ZERO: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 });
const group = () => ({ vehicles: 0, suppliedTerms: 0, economicsTerms: 0, heldVehicles: 0,
  supplierBillingFee: states(), channelPayoutFee: states() });
type Entry = { recordId: string; reasons: string[]; action: 'HOLD' | 'CREATE' | 'CHANGE' | 'NO_CHANGE';
  create?: CanonicalizeCatalogCandidateInput; change?: ApplyReviewedSourceChangeInput };
export type SharedSheetPlan = {
  schema: 'shared-sheet-canonical-plan/v1'; target: string; capture: SharedSheetCapture;
  ruleVersion: string; specDigest: string; policyDigest: string; ownershipDigest: string;
  previousHeadDigest: string; runId: string; entries: Entry[];
  /** Optional per-plate Data evidence; every chosen name still requires the same sealed active master. */
  identityInputs?: VehicleIdentityInputs; identityRuleVersion?: string;
  includeSupplierColors?: true;
  operationalRefresh?: true;
};
/** The existing private evidence prefix is selected by an immutable successful dry-run, never by a URL supplied by a caller. */
export function assertReviewedSharedSheetRun(input: {
  runId: string; attempt: string; generation: string; digest: string; sourcePin: string;
  executionPin: string; run: { id: number; run_attempt: number; head_sha: string; head_branch: string;
    event: string; status: string; conclusion: string; path: string; display_title: string };
}) {
  const r = input.run;
  if (![input.runId, input.attempt, input.generation].every(x => /^[1-9]\d*$/.test(x)) ||
      !/^[a-f0-9]{64}$/.test(input.digest) || !/^[a-f0-9]{40}$/.test(input.sourcePin) ||
      input.sourcePin !== input.executionPin || String(r.id) !== input.runId || String(r.run_attempt) !== input.attempt ||
      r.head_sha !== input.sourcePin || r.head_branch !== 'main' || r.event !== 'workflow_dispatch' ||
      r.status !== 'completed' || r.conclusion !== 'success' || r.path !== '.github/workflows/shared-sheet-daily.yml' ||
      r.display_title !== 'shared-sheet-daily dry-run') throw new Error('REVIEWED_SHARED_SHEET_RUN_NOT_PINNED');
}
export function assertReviewedPlanGeneration(expected: string, before: string, after: string) {
  if (!/^[1-9]\d*$/.test(expected) || expected !== before || expected !== after)
    throw new Error('REVIEWED_PLAN_GENERATION_CHANGED');
}
/** Capture observation times/digests are not supplier facts. Correction times and supplier provenance identities remain significant. */
export function assertLiveSharedSheetMatches(plan: SharedSheetPlan, live: SharedSheetCapture, now = Date.now()) {
  buildSharedSheetBatch(plan.capture); buildSharedSheetBatch(live);
  if (Date.parse(live.readTime) <= Date.parse(plan.capture.readTime)) throw new Error('LIVE_SHARED_SHEET_RECAPTURE_REQUIRED');
  if ([live.readTime, ...live.tabs.map(t => t.readTime)].some(at => Date.parse(at) > now || now - Date.parse(at) > 120_000))
    throw new Error('LIVE_SHARED_SHEET_CAPTURE_STALE');
  const semantic = (c: SharedSheetCapture) => ({ schema: c.schema, spreadsheetId: c.spreadsheetId, layoutVersion: c.layoutVersion, revision: c.revision ?? null,
    tabs: c.tabs.map(({ readTime: _, ...tab }) => tab),
    supplierEntered: (c.supplierEntered ?? []).map(r => r.source === 'ERP5_PRODUCTS_SOURCE_TEXT'
      ? (({ observedAt: _, ...fact }) => fact)(r) : r), corrections: c.corrections ?? [],
    master: c.vehicleMasterSnapshot ? (({ readAt: _, digest: __, ...body }) => body)(c.vehicleMasterSnapshot as VehicleMasterSnapshot) : null });
  if (stableDigest(semantic(plan.capture)) !== stableDigest(semantic(live)))
    throw new Error('LIVE_SHARED_SHEET_CHANGED_REPLAN_REQUIRED');
  const master = live.vehicleMasterSnapshot as VehicleMasterSnapshot | undefined;
  if (!master) throw new Error('CURRENT_VEHICLE_MASTER_REQUIRED_BEFORE_APPLY');
  verifiedMasterRecords(master, now);
}
/**
 * The sealed master snapshot must be fresh at the entry fence (CLI start). After that fence an apply may legitimately run for
 * many minutes (preflight, RAW load); judging the sealed snapshot against wall-clock time there turned a good run into
 * VEHICLE_MASTER_SNAPSHOT_STALE_OR_INCOMPLETE. In-flight checks evaluate it at its own capture time — completeness, immutable
 * IDs and digest are still verified — while freshness against the live master is the digest comparison with a fresh read.
 */
const sealedNow = (master: VehicleMasterSnapshot, inFlight: boolean) => inFlight ? Date.parse(master.readAt) : Date.now();
export function identityResolver(inputs: VehicleIdentityInputs | undefined, inFlight = false): SharedSheetIdentityResolver | undefined {
  if (!inputs) return undefined;
  assertVehicleIdentityInputs(inputs);
  const master = indexVehicleMaster(verifiedMasterRecords(inputs.master, sealedNow(inputs.master, inFlight)));
  const data = new Map(inputs.data.map(x => [x.plate, x.identity]));
  return row => chooseVehicleIdentity(master, { sheet: row.sheet, data: data.get(row.plate) ?? null, raw: row.raw,
    firstRegistration: row.firstRegistration, modelYear: row.modelYear, ...(row.specs ? { specs: row.specs } : {}) });
}
function prepared(capture: SharedSheetCapture, identityInputs?: VehicleIdentityInputs, includeSupplierColors = false, inFlight = false) {
  const batch = buildSharedSheetBatch(capture);
  const p = prepareRawSourceBatch(batch);
  const snapshot = capture.vehicleMasterSnapshot as VehicleMasterSnapshot | undefined ?? identityInputs?.master;
  if (capture.vehicleMasterSnapshot && identityInputs &&
      stableDigest(capture.vehicleMasterSnapshot) !== stableDigest(identityInputs.master)) throw new Error('VEHICLE_MASTER_SNAPSHOT_MISMATCH');
  const master = snapshot ? { records: verifiedMasterRecords(snapshot, sealedNow(snapshot, inFlight)), readAt: snapshot.readAt, snapshotDigest: snapshot.digest } : undefined;
  const normalizeBase = sharedSheetNormalizer(identityResolver(identityInputs, inFlight), master, { includeSupplierColors });
  const normalize: typeof normalizeBase = raw => {
    const normalized = normalizeBase(raw);
    return {...normalized,lineage:[...normalized.lineage,...sourceFeeLineage(raw,normalized.record)]};
  };
  const normalized = p.rawRecords.map(r => normalize(r));
  const checkpoint = { sourceId: p.sourceId, observedAt: batch.observedAt, sourceRevision: batch.sourceRevision!, checksum: p.sourceChecksum };
  const run: SourceRun = { runId: p.runId, sourceId: p.sourceId, status: 'COMPLETED', startedAt: batch.observedAt,
    completedAt: batch.observedAt, observedAt: batch.observedAt, checkpoint, coverage: batch.coverage, headStatus: 'CURRENT',
    rawCount: p.rawRecords.length, candidateCount: normalized.length,
    lineageCount: normalized.reduce((n, x) => n + x.lineage.length, 0), warningCount: normalized.filter(x => x.record.status !== 'VALID').length };
  const head: SourceHead = { sourceId: p.sourceId, runId: p.runId, observedAt: batch.observedAt, acceptedAt: batch.observedAt, checkpoint, coverage: batch.coverage };
  return { ...p, batch, normalized, run, head, normalize };
}
function overlay(store: CatalogStore, p: ReturnType<typeof prepared>): CatalogStore {
  // Read-only prospective evidence. No transaction or SourceIngestionStore write in planning.
  const overrides = {
    getCandidate: async (id: string) => p.normalized.find(x => x.record.candidateId === id)?.record ?? store.getCandidate(id),
    getSourceRun: async (id: string) => id === p.runId ? p.run : store.getSourceRun(id),
    getSourceHead: async (id: string) => id === p.sourceId ? p.head : store.getSourceHead(id),
  };
  return new Proxy(store, { get(target, key) {
    if (key in overrides) return overrides[key as keyof typeof overrides];
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
export async function planSharedSheetCanonical(store: CatalogStore, capture: SharedSheetCapture, target: string,
  identityInputs?: VehicleIdentityInputs, includeSupplierColors = false, operationalRefresh = false, inFlight = false) {
  const p = prepared(capture, identityInputs, includeSupplierColors, inFlight);
  const currentHead = await store.getSourceHead(p.sourceId);
  // A completed source run is immutable. New normalization must use a newly captured run.
  if (includeSupplierColors && currentHead?.runId === p.runId) {
    for (const item of p.normalized) {
      if (!await store.getCandidate(item.record.candidateId)) throw new Error('SUPPLIER_COLOR_REFINEMENT_REQUIRES_NEW_SOURCE_RUN');
    }
  }
  const ownership = await store.getCatalogWriterOwnership();
  const sourceEligible = currentHead?.runId === p.runId || decideSourceHead(p.batch.coverage, p.batch.observedAt, currentHead?.observedAt).acceptedAsHead;
  const plan: SharedSheetPlan = { schema: 'shared-sheet-canonical-plan/v1', target, capture: structuredClone(capture),
    ruleVersion: includeSupplierColors ? SHARED_SHEET_COLOR_RULE_VERSION : SHARED_SHEET_RULE_VERSION, specDigest: SHARED_SHEET_SPEC_DIGEST,
    policyDigest: stableDigest(KAKAO_COMMISSION_POLICY), ownershipDigest: stableDigest(ownership),
    previousHeadDigest: stableDigest(currentHead), runId: p.runId, entries: [],
    ...(includeSupplierColors ? { includeSupplierColors: true as const } : {}),
    ...(operationalRefresh ? { operationalRefresh: true as const } : {}),
    ...(identityInputs ? { identityInputs: structuredClone(identityInputs), identityRuleVersion: VEHICLE_IDENTITY_RULE_VERSION } : {}) };
  const suppliers: Record<string, ReturnType<typeof group>> = Object.fromEntries(sharedSheetRegisteredChannels.map(x => [x.code, group()]));
  const holdReasons: Record<string, number> = {};
  const unknownFeeReasons: Record<string, number> = {};
  const [assets, products, offers] = await Promise.all([store.listVehicleAssets(), store.listProducts(), store.listOffers()]);
  const prospective = overlay(store, p);
  // A shared source run can bind hundreds of rows. Read its candidate set once per plan,
  // never once per vehicle; this cache is local to this immutable planning invocation.
  const priorRuns = new Map<string, Awaited<ReturnType<CatalogStore['listCandidatesByRun']>>>();
  for (const item of p.normalized) {
    const c = item.record.candidate;
    const supplier = c.providerCompanyCode ?? 'UNRESOLVED';
    const g = suppliers[supplier] ??= group();
    g.vehicles++; g.suppliedTerms += item.suppliedTerms;
    const economics = precomputeOfferEconomics({ id: opaque('off', p.sourceId, c.sourceRecordId), supplierId: supplier, priceTerms: c.priceTerms }, c.commercialType, c.fuelType);
    g.economicsTerms += economics.length;
    for (const term of economics) {
      g.supplierBillingFee[term.supplierBillingFee.state]++;
      g.channelPayoutFee[term.channelPayoutFee.state]++;
      for (const side of ['supplierBillingFee', 'channelPayoutFee'] as const) if (term[side].state === 'UNKNOWN') {
        const reason = `${side}:${term[side].reasonCode ?? 'UNSPECIFIED'}`;
        unknownFeeReasons[reason] = (unknownFeeReasons[reason] ?? 0) + 1;
      }
    }
    const reasons = [...c.issues];
    if (!sourceEligible) reasons.push('SOURCE_HEAD_NOT_CURRENT');
    const statusPolicy = sharedSheetStatusPolicy(c.vehicleFacts?.fields.supplierStatus?.value);
    if (!statusPolicy) reasons.push('ASSET_STATUS_MISSING');
    const productStatus = statusPolicy?.exposure === 'VISIBLE' ? 'ACTIVE' as const : 'HOLD' as const;
    const entry: Entry = { recordId: c.sourceRecordId, action: 'HOLD', reasons };
    const bindingId = opaque('bind', p.sourceId, c.sourceRecordId);
    const binding = await store.getSourceBinding(bindingId);
    const commandId = `shared:${stableDigest([p.runId, c.sourceRecordId, plan.ruleVersion, plan.policyDigest])}`;
    const base = { commandId, idempotencyKey: commandId, candidateId: item.record.candidateId,
      expectedHeadRunId: p.runId, expectedOwnershipDigest: plan.ownershipDigest,
      actor, reason: `shared-sheet-auto-review/1:${p.sourceChecksum}` };
    if (!reasons.length) {
      if (!binding) {
        const matchingAssets = new Set(assets.filter(x => plateIdentityKey(x.plateNumber) === c.carNumber).map(x => x.id));
        const matchingProducts = new Set(products.filter(x => x.vehicleAssetId && matchingAssets.has(x.vehicleAssetId)).map(x => x.id));
        if (offers.some(x => x.supplierId === supplier && matchingProducts.has(x.productId))) reasons.push('EXISTING_IDENTITY_REQUIRES_SOURCE_LINK');
        // One plate = one canonical vehicle: an existing asset with this plate (any supplier, with or without offers)
        // is never duplicated by a new CREATE; linking it needs review.
        else if (matchingAssets.size) reasons.push('EXISTING_ASSET_REQUIRES_REVIEW');
        entry.action = 'CREATE';
        entry.create = { ...base, decision: { supplierId: supplier,
          vehicleModel: { action: 'CREATE', id: opaque('vm', p.sourceId, c.sourceRecordId) },
          // Asset identity = plate («차량번호 하나 = 정본 한 줄»): a second CREATE for the same plate, from any source or a
          // concurrent run, meets the existing-asset conflict inside the canonicalize transaction instead of a new va_*.
          vehicleAsset: { action: 'CREATE', id: issueVehicleAssetId({ plate: c.carNumber! }), status: statusPolicy?.assetStatus ?? 'AVAILABLE' },
          productStatus, approvedIssues: [] } };
        if (await store.getVehicleModel(entry.create.decision.vehicleModel.id) ||
            await store.getVehicleAsset(entry.create.decision.vehicleAsset!.id) ||
            await store.getOffer(opaque('off', p.sourceId, c.sourceRecordId)) ||
            await store.getProduct(opaque('prd', p.sourceId, c.sourceRecordId))) reasons.push('UNBOUND_IDENTITY_COLLISION');
      } else if (!operationalRefresh && ((await store.getProduct(binding.productId))?.status !== productStatus ||
          (binding.vehicleAssetId && (await store.getVehicleAsset(binding.vehicleAssetId))?.status !== statusPolicy?.assetStatus))) {
        // Exposure/asset status changes are not part of the generic reviewed source change yet: hold instead of silently diverging.
        reasons.push('STATUS_CHANGE_REQUIRES_REVIEW');
      } else if (!operationalRefresh && binding.sourceFingerprint === c.sourceFingerprint) {
        entry.action = 'NO_CHANGE';
        const current = await store.getOffer(binding.offerId);
        if (!current || stableDigest(current.internalEconomicsTerms ?? []) !== stableDigest(economics)) reasons.push('ECONOMICS_RECOMPUTE_REQUIRED');
        const asset = binding.vehicleAssetId ? await store.getVehicleAsset(binding.vehicleAssetId) : null;
        if (!asset || stableDigest(asset.sourceVehicleFacts ?? null) !== stableDigest(c.vehicleFacts)) reasons.push('CANONICAL_FACTS_REVIEW_REQUIRED');
      }
      else {
        try {
          // Generic refresh preserves absent optional fields. This sheet cannot silently retain stale facts.
          const model = await store.getVehicleModel(binding.vehicleModelId);
          const asset = binding.vehicleAssetId ? await store.getVehicleAsset(binding.vehicleAssetId) : null;
          if ((c.fuelType === undefined && model?.fuel != null) || (c.driveType === undefined && model?.drive != null) ||
              (c.seats === undefined && model?.seats != null) || (c.mileageKm === undefined && asset?.odometerKm != null))
            reasons.push('MISSING_PREVIOUSLY_KNOWN_FACT_REQUIRES_REVIEW');
          if (operationalRefresh && !priorRuns.has(binding.sourceRunId)) {
            try { priorRuns.set(binding.sourceRunId, await store.listCandidatesByRun(binding.sourceRunId)); }
            catch { throw new Error('OPERATIONAL_PREVIOUS_CANDIDATES_READ_FAILED'); }
          }
          const previous = operationalRefresh ? priorRuns.get(binding.sourceRunId)!
            .filter(x => x.sourceId === binding.sourceId && x.sourceRecordId === binding.sourceRecordId &&
              x.sourceFingerprint === binding.sourceFingerprint && x.status === 'VALID') : [];
          if (operationalRefresh && previous.length !== 1) throw new Error('OPERATIONAL_PREVIOUS_CANDIDATE_NOT_UNIQUE');
          const fence = operationalRefresh ? { previousCandidateId: previous[0]!.candidateId,
            maxObservationAgeSeconds: OPERATIONAL_REFRESH_MAX_OBSERVATION_AGE_SECONDS } : undefined;
          const review = await reviewSourceChange(prospective, bindingId, item.record.candidateId, fence);
          if (review.blockedChangeIds.length) reasons.push(...review.diffs.filter(x => x.classification === 'BLOCKED').map(x => x.reasonCode));
          else {
            entry.action = 'CHANGE';
            entry.change = { ...base, bindingId, expectedBindingRevision: review.bindingRevision,
              expectedVehicleModelRevision: review.vehicleModelRevision, expectedProductRevision: review.productRevision,
              expectedOfferRevision: review.offerRevision, expectedVehicleAssetRevision: review.vehicleAssetRevision ?? null,
              approvedChangeIds: review.reviewableChangeIds, approvedIssues: [],
              ...(fence ? { operationalRefresh: fence } : {}) };
          }
        } catch (error) {
          // Keep useful bounded reason codes, never provider messages or raw identifiers.
          const code = error instanceof Error ? error.message : '';
          reasons.push(['OPERATIONAL_PREVIOUS_CANDIDATE_NOT_UNIQUE', 'OPERATIONAL_PREVIOUS_CANDIDATES_READ_FAILED'].includes(code)
            ? code : 'SOURCE_CHANGE_REVIEW_FAILED');
        }
      }
    }
    if (reasons.length) {
      entry.action = 'HOLD'; delete entry.create; delete entry.change;
      entry.reasons = [...new Set(reasons)]; g.heldVehicles++;
      for (const reason of entry.reasons) holdReasons[reason] = (holdReasons[reason] ?? 0) + 1;
    }
    plan.entries.push(entry);
  }
  const suppliedTerms = Object.values(suppliers).reduce((n, g) => n + g.suppliedTerms, 0);
  const economicsTerms = Object.values(suppliers).reduce((n, g) => n + g.economicsTerms, 0);
  return { plan, report: { mode: 'DRY_RUN', writes: 0, vehicles: plan.entries.length, suppliers, holdReasons,
    sourceCoverage: p.batch.coverage,
    unavailableSuppliers: sharedSheetUnavailableChannels.map(x => ({ code: x.code, tab: x.tab, status: 'HOLD', retirementAuthorized: false })),
    heldVehicles: plan.entries.filter(x => x.action === 'HOLD').length,
    unknownFeeReasons,
    reconciliation: { stage: 'PRECOMPUTE_PREVIEW', suppliedTerms, economicsTerms, equal: suppliedTerms === economicsTerms },
    writerReady: ownership?.mode === 'EXCLUSIVE' && ownership.primaryWriterId === actor.id,
    planDigest: stableDigest(plan) } };
}

export function assertSharedSheetPlan(plan: SharedSheetPlan | undefined, digest: string | undefined, target: string, inFlight = false): asserts plan is SharedSheetPlan {
  if (!plan || !digest || plan.schema !== 'shared-sheet-canonical-plan/v1' || plan.target !== target ||
      (plan.includeSupplierColors !== undefined && plan.includeSupplierColors !== true) ||
      (plan.operationalRefresh !== undefined && plan.operationalRefresh !== true) ||
      plan.ruleVersion !== (plan.includeSupplierColors ? SHARED_SHEET_COLOR_RULE_VERSION : SHARED_SHEET_RULE_VERSION) || plan.specDigest !== SHARED_SHEET_SPEC_DIGEST ||
      plan.policyDigest !== stableDigest(KAKAO_COMMISSION_POLICY) || digest !== stableDigest(plan) || !Array.isArray(plan.entries)) {
    throw new Error('SHARED_SHEET_PLAN_REQUIRED_OR_CHANGED');
  }
  if (plan.identityInputs !== undefined || plan.identityRuleVersion !== undefined) {
    assertVehicleIdentityInputs(plan.identityInputs);
    if (plan.identityRuleVersion !== VEHICLE_IDENTITY_RULE_VERSION) throw new Error('SHARED_SHEET_PLAN_REQUIRED_OR_CHANGED');
  }
  if (prepared(plan.capture, plan.identityInputs, plan.includeSupplierColors, inFlight).runId !== plan.runId) throw new Error('SHARED_SHEET_PLAN_CAPTURE_MISMATCH');
}
/** Read-only apply guard. The CLI runs it before opening the audited write, so a rejected apply writes nothing (not even an audit event). */
export async function preflightSharedSheetApply(store: CatalogStore, plan: SharedSheetPlan | undefined, digest: string | undefined, target: string): Promise<Set<string>> {
  assertSharedSheetPlan(plan, digest, target, true);
  const ownership = await store.getCatalogWriterOwnership();
  if (!ownership || ownership.mode !== 'EXCLUSIVE' || ownership.primaryWriterId !== actor.id || stableDigest(ownership) !== plan.ownershipDigest)
    throw new Error('SHARED_SHEET_EXCLUSIVE_WRITER_REQUIRED');
  const p = prepared(plan.capture, plan.identityInputs, plan.includeSupplierColors, true);
  const head = await store.getSourceHead(p.sourceId);
  if (head?.runId !== p.runId && stableDigest(head) !== plan.previousHeadDigest) throw new Error('SHARED_SHEET_HEAD_CHANGED');
  if (head?.runId === p.runId && (head.sourceId !== p.sourceId || head.observedAt !== p.head.observedAt ||
      stableDigest(head.checkpoint) !== stableDigest(p.head.checkpoint) || stableDigest(head.coverage) !== stableDigest(p.head.coverage)))
    throw new Error('SHARED_SHEET_REPLAY_HEAD_EVIDENCE_CHANGED');
  const fresh = await planSharedSheetCanonical(store, plan.capture, plan.target, plan.identityInputs, plan.includeSupplierColors, plan.operationalRefresh, true);
  if (fresh.plan.entries.length !== plan.entries.length) throw new Error('SHARED_SHEET_PLAN_ENTRIES_CHANGED');
  const replay = new Set<string>();
  for (let i = 0; i < plan.entries.length; i++) {
    const entry = plan.entries[i]!;
    const receipt = entry.create ? await store.getCanonicalizationReceipt(entry.create.idempotencyKey)
      : entry.change ? await store.getReviewedSourceChangeReceipt(entry.change.idempotencyKey) : null;
    if (receipt) replay.add(entry.recordId);
    else if (stableDigest(entry) !== stableDigest(fresh.plan.entries[i])) throw new Error('SHARED_SHEET_PLAN_STALE');
  }
  return replay;
}
/** Public-log-safe failure label: a fixed UPPER_SNAKE code thrown by our own code, else the error class name. Never free text. */
/** 마스터 스냅샷 검사(scripts/supplier-input-sheet.mjs vehicleMasterSnapshotRows)가 `HOLD: <고정 문구>` 로 던지는 것들 — 고정 코드로 옮긴다.
 * 문구는 우리 코드의 고정 문자열뿐이라 식별자·값이 섞이지 않는다. 목록에 없는 HOLD 는 아래에서 UNCODED_Error 로 남는다. */
const MASTER_HOLD_CODES: ReadonlyArray<readonly [string, string]> = [
  ['HOLD: Active Data vehicle master snapshot required', 'VEHICLE_MASTER_SNAPSHOT_STALE_OR_INCOMPLETE'],
  ['HOLD: Complete master and trim documents required', 'VEHICLE_MASTER_DOCUMENTS_INCOMPLETE'],
  ['HOLD: Vehicle master snapshot digest mismatch', 'VEHICLE_MASTER_SNAPSHOT_DIGEST_MISMATCH'],
  ['HOLD: Unique immutable master IDs required', 'VEHICLE_MASTER_IDS_NOT_UNIQUE'],
  ['HOLD: Unique immutable trim IDs required', 'VEHICLE_TRIM_IDS_NOT_UNIQUE']];
/**
 * 명령 거절의 «종류»만 닫힌 어휘로 노출한다 — 메시지 본문·식별자·값은 절대 싣지 않는다.
 * 우리 코드의 UPPER_SNAKE 코드가 아닌 일반 Error(저장소·트랜잭션 계층)가 던져질 때 원인 범주를 판정하기 위한 것.
 */
const COMMAND_FAILURE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/already exists|already_exists|duplicate/i, 'ALREADY_EXISTS'],
  [/not found|not_found|missing|does not exist/i, 'NOT_FOUND'],
  [/revision|version|stale|changed|conflict|precondition|expected/i, 'REVISION_OR_PRECONDITION'],
  [/abort|contention|transaction|too much|retry/i, 'TRANSACTION_ABORTED'],
  [/lock|ownership|writer|exclusive|permission|denied|unauthenticated/i, 'OWNERSHIP_OR_PERMISSION'],
  [/size|limit|exceed|too large|bytes/i, 'SIZE_OR_LIMIT'],
  [/invalid|illegal|malformed|schema|unsupported|must|required/i, 'INVALID_INPUT'],
  [/deadline|timeout|unavailable|econn|network/i, 'TRANSPORT'],
];
export function commandFailureDetail(error: unknown, kind: 'CREATE' | 'CHANGE' | 'UNKNOWN') {
  const message = error instanceof Error ? error.message : '';
  const cls = error instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(error.name) ? error.name : 'NonError';
  const rawCode = (error as { code?: unknown } | null)?.code;
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(rawCode) ? rawCode
    : typeof rawCode === 'number' && Number.isInteger(rawCode) ? String(rawCode) : null;
  const category = COMMAND_FAILURE_PATTERNS.find(([rx]) => rx.test(message))?.[1] ?? 'UNCLASSIFIED';
  return { commandKind: kind, errorClass: cls, errorCode: code, category };
}
export function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^[A-Z][A-Z0-9_]{2,80}$/.test(message)) return message;
  const known = MASTER_HOLD_CODES.find(([text]) => message === text);
  if (known) return known[1];
  return error instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(error.name) ? `UNCODED_${error.name}` : 'UNCODED';
}
/** 예약 적용 울타리: 명령 시각 − 원천 관측 시각(계획 캡처 readTime)의 상한.
 * 900초였을 때 예약 적용이 10-11 22:15Z 부터 전부 거절됐다 — 적용 단계 자체(사전 재계획·RAW 적재·listOffers)가 15~20분 걸려
 * 첫 명령 시점에 이미 상한을 넘겼기 때문. 신선도는 적용 직전 라이브 재캡처 대조(assertLiveSharedSheetMatches, 2분)가 보장하므로
 * 이 울타리는 «터무니없이 오래된 계획» 만 막는 2차 안전선으로 두고 적용 단계 소요를 넉넉히 덮는 값으로 둔다. */
export const OPERATIONAL_REFRESH_MAX_OBSERVATION_AGE_SECONDS = 3600;
/** Reviewed-command verdicts that hold one vehicle without stopping the apply run. */
const PER_ENTRY_REJECTION_CODES: ReadonlySet<string> = new Set(
  ['REVIEWED_SOURCE_CHANGE_REJECTED', 'REVIEWED_SOURCE_CHANGE_CONFLICT', 'REVIEWED_SOURCE_CHANGE_BLOCKED',
    'REVIEWED_SOURCE_CHANGE_APPROVAL_MISMATCH']);
export async function runSharedSheetCanonical(store: CatalogStore, source: SourceIngestionStore, options: {
  target: string; capture?: SharedSheetCapture; apply?: boolean; plan?: SharedSheetPlan; expectedPlanDigest?: string;
  identityInputs?: VehicleIdentityInputs; currentVehicleMasterSnapshot?: VehicleMasterSnapshot; includeSupplierColors?: boolean;
  operationalRefresh?: boolean;
}) {
  if (!options.apply) {
    if (!options.capture) throw new Error('SHARED_SHEET_CAPTURE_REQUIRED');
    return planSharedSheetCanonical(store, options.capture, options.target, options.identityInputs, options.includeSupplierColors, options.operationalRefresh);
  }
  const plan = options.plan;
  assertSharedSheetPlan(plan, options.expectedPlanDigest, options.target, true);
  if (options.target === 'freepasserp5') {
    const current = options.currentVehicleMasterSnapshot;
    if (!current) throw new Error('CURRENT_VEHICLE_MASTER_REQUIRED_BEFORE_APPLY');
    verifiedMasterRecords(current);
    const planned = plan.capture.vehicleMasterSnapshot as VehicleMasterSnapshot | undefined ?? plan.identityInputs?.master;
    if (!planned || stableDigest({ masters: current.masters, trims: current.trims }) !==
        stableDigest({ masters: planned.masters, trims: planned.trims })) throw new Error('VEHICLE_MASTER_CHANGED_REPLAN_REQUIRED');
  }
  const replay = await preflightSharedSheetApply(store, plan, options.expectedPlanDigest, options.target);
  const p = prepared(plan.capture, plan.identityInputs, plan.includeSupplierColors, true);
  // Immutable pre-write economics oracle for confirmed vehicle-price fees. A rent capture
  // is not a vehicle-price fact and must not recalculate or invent that basis.
  const beforeOffers = plan.operationalRefresh ? new Map((await store.listOffers()).map(x => [x.id, structuredClone(x)])) : null;
  const run = await ingestRawSourceBatch(source, p.batch, new Date().toISOString(), p.normalize);
  if (run.headStatus !== 'CURRENT' || run.candidateCount !== p.normalized.length) throw new Error('SHARED_SHEET_INTAKE_NOT_READY');
  let committed = 0, noChange = 0, held = 0;
  let commandKind: 'CREATE' | 'CHANGE' | 'UNKNOWN' = 'UNKNOWN';
  const rejected = new Set<string>(), rejectedByCode: Record<string, number> = {};
  for (const entry of plan.entries) {
    if (entry.action === 'HOLD') { held++; continue; }
    if (entry.action === 'NO_CHANGE') { noChange++; continue; }
    try {
      let businessNoChange = false;
      commandKind = entry.create ? 'CREATE' : entry.change ? 'CHANGE' : 'UNKNOWN';
      if (entry.create) await canonicalizeCatalogCandidate(store, entry.create);
      else if (entry.change) businessNoChange = (await applyReviewedSourceChange(store, entry.change)).status === 'NO_CHANGE';
      else throw new Error('INVALID_SHARED_SHEET_ACTION');
      if (replay.has(entry.recordId) || businessNoChange) noChange++; else committed++;
    } catch (error) {
      // A reviewed-command rejection is a per-vehicle verdict made before any write of that command (each command is its own
      // transaction): hold that vehicle with a fixed code and keep applying the rest. Anything else (transport, storage,
      // invariant breaches) still stops the whole run.
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && PER_ENTRY_REJECTION_CODES.has(code)) {
        held++; rejected.add(entry.recordId);
        const key = `${commandKind}:${code}`; rejectedByCode[key] = (rejectedByCode[key] ?? 0) + 1;
        continue;
      }
      // No thrown provider text or raw identifiers in stdout/public CI: only a fixed UPPER_SNAKE code or the error class name.
      return { report: { mode: 'APPLY', status: 'HOLD', committed, noChange, held,
        remaining: plan.entries.length - committed - noChange - held, reason: 'CANONICAL_COMMAND_REJECTED',
        reasonCode: safeErrorCode(error), failure: commandFailureDetail(error, commandKind) } };
    }
  }
  let suppliedTerms = 0, storedTerms = 0, heldTerms = 0, readbackMismatches = 0;
  for (const item of p.normalized) {
    const entry = plan.entries.find(x => x.recordId === item.record.sourceRecordId)!;
    if (entry.action === 'HOLD' || rejected.has(entry.recordId)) { heldTerms += item.suppliedTerms; continue; }
    suppliedTerms += item.suppliedTerms;
    const c = item.record.candidate;
    const binding = await store.getSourceBinding(opaque('bind', p.sourceId, c.sourceRecordId));
    const offer = binding ? await store.getOffer(binding.offerId) : null;
    const asset = binding?.vehicleAssetId ? await store.getVehicleAsset(binding.vehicleAssetId) : null;
    const expected = precomputeOfferEconomics({ id: opaque('off', p.sourceId, c.sourceRecordId),
      supplierId: c.providerCompanyCode!, priceTerms: c.priceTerms }, c.commercialType, c.fuelType);
    const before = offer ? beforeOffers?.get(offer.id) : undefined;
    const refreshReceipt = entry.change?.operationalRefresh
      ? await store.getReviewedSourceChangeReceipt(entry.change.idempotencyKey) : null;
    if (before && offer && refreshReceipt?.sourceRunId === p.runId &&
        refreshReceipt.offerId === offer.id && refreshReceipt.offerRevision === offer.revision &&
        refreshReceipt.commandId === entry.change?.commandId &&
        !auditOfferEconomicsTerms(before).invalidFacts.length &&
        !auditOfferEconomicsTerms(offer).invalidFacts.length) {
      for (const term of expected) for (const side of ['supplierBillingFee', 'channelPayoutFee'] as const) {
        const previous = before.internalEconomicsTerms?.find(x => x.termKey === term.termKey)?.[side];
        // The operational refresh owns status and changed rent only. A term whose rent did not change keeps its stored
        // economics exactly (a later fee-policy version is applied by the separate economics recompute, not by this run),
        // so the readback must compare it with the pre-run value, never with a fresh recompute under a newer policy.
        // The apply step recomputes a dependent fee from the rent of the fee's reference term (referenceRentBasis.termKey),
        // not from its own term, so «unchanged» must be judged on that same term or a changed reference rent would be mistaken
        // for an unchanged one (reviewed-source-change.ts basisKey).
        const basisKey = previous?.referenceRentBasis?.termKey ?? term.termKey;
        const rentBefore = before.priceTerms.find(x => x.termKey === basisKey)?.monthlyRent;
        const rentNow = c.priceTerms.find(x => x.termKey === basisKey)?.monthlyRent;
        const rentUnchanged = rentBefore !== undefined && rentNow !== undefined && stableDigest(rentBefore) === stableDigest(rentNow);
        if (previous && (rentUnchanged || previous.state === 'UNKNOWN' || previous.state === 'NOT_APPLICABLE' ||
            (previous.calculation?.kind === 'RATE' && previous.calculation.base === 'VEHICLE_PRICE')))
          term[side] = structuredClone(previous);
      }
    }
    storedTerms += offer?.internalEconomicsTerms?.length ?? 0;
    const policy = sharedSheetStatusPolicy(c.vehicleFacts?.fields.supplierStatus?.value);
    const product = binding ? await store.getProduct(binding.productId) : null;
    if (!asset || !policy || asset.status !== policy.assetStatus ||
        product?.status !== (policy.exposure === 'VISIBLE' ? 'ACTIVE' : 'HOLD') ||
        stableDigest(asset.sourceVehicleFacts ?? null) !== stableDigest(c.vehicleFacts) ||
        !offer || stableDigest(offer.priceTerms) !== stableDigest(c.priceTerms) ||
        stableDigest(offer.internalEconomicsTerms ?? []) !== stableDigest(expected)) readbackMismatches++;
  }
  return { report: { mode: 'APPLY', status: readbackMismatches ? 'HOLD' : held ? 'PARTIAL_HOLD' : 'APPLIED',
    committed, noChange, held, remaining: 0,
    ...(Object.keys(rejectedByCode).length ? { rejectedByCode } : {}),
    reconciliation: { stage: 'CANONICAL_READBACK', suppliedTerms, storedTerms, heldTerms, readbackMismatches,
      equal: suppliedTerms === storedTerms && readbackMismatches === 0 } } };
}

/** Private plans/query results may contain RAW and fees. Never save inside the checkout or overwrite evidence. */
export async function writePrivateArtifact(path: string, value: unknown) {
  if (!isAbsolute(path) || /^[/\\]{2}/.test(path)) throw new Error('PRIVATE_OUTPUT_MUST_BE_LOCAL_ABSOLUTE');
  const dir = await realpath(dirname(resolve(path)));
  // Anchor on this module's repository, not process.cwd(), and refuse any other git checkout too.
  const inside = (root: string) => { const r = relative(root, dir); return !r.startsWith('..') && !isAbsolute(r); };
  if (inside(await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')))) throw new Error('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT');
  for (let d = dir; ; d = dirname(d)) {
    if (await stat(resolve(d, '.git')).then(() => true, () => false)) throw new Error('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT');
    if (dirname(d) === d) break;
  }
  await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
}
export function parseLocalArgs(args: string[], flags: string[], values: string[]) {
  const parsed = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (parsed.has(arg) || (!flags.includes(arg) && !values.includes(arg))) throw new Error('INVALID_ARGUMENT');
    if (flags.includes(arg)) parsed.set(arg, 'true');
    else { const v = args[++i]; if (!v || v.startsWith('--')) throw new Error('MISSING_ARGUMENT'); parsed.set(arg, v); }
  }
  if (parsed.has('--memory') === parsed.has('--firestore')) throw new Error('SELECT_MEMORY_OR_FIRESTORE');
  return parsed;
}
export async function main(args = process.argv.slice(2)) {
  const a = parseLocalArgs(args, ['--memory', '--firestore', '--apply', '--include-supplier-colors', '--operational-refresh'], ['--capture', '--plan', '--plan-out', '--expected-plan-digest', '--identity-inputs', '--live-capture']);
  const apply = a.has('--apply');
  if (apply && (!a.has('--plan') || !a.has('--expected-plan-digest'))) throw new Error('APPLY_REQUIRES_PLAN_AND_DIGEST');
  if (apply && a.has('--firestore') && !a.has('--live-capture')) throw new Error('APPLY_REQUIRES_LIVE_SOURCE_RECAPTURE');
  if (!apply && a.has('--live-capture')) throw new Error('LIVE_CAPTURE_REQUIRES_APPLY');
  if (apply && (a.has('--capture') || a.has('--plan-out'))) throw new Error('APPLY_USES_REVIEWED_PLAN_ONLY');
  if (!apply && (a.has('--plan') || a.has('--expected-plan-digest'))) throw new Error('PLAN_FLAGS_REQUIRE_APPLY');
  if (!apply && !a.has('--capture')) throw new Error('CAPTURE_REQUIRED');
  if (apply && (a.has('--identity-inputs') || a.has('--include-supplier-colors') || a.has('--operational-refresh'))) throw new Error('APPLY_USES_REVIEWED_PLAN_ONLY');
  const identityInputs = a.has('--identity-inputs') ? JSON.parse(await readFile(a.get('--identity-inputs')!, 'utf8')) as VehicleIdentityInputs : undefined;
  if (identityInputs) assertVehicleIdentityInputs(identityInputs);
  const { resolveTargetProject } = await import('../infra/firebase-target.js');
  const target = a.has('--memory') ? 'memory' : resolveTargetProject();
  const plan = a.has('--plan') ? JSON.parse(await readFile(a.get('--plan')!, 'utf8')) as SharedSheetPlan : undefined;
  const capture = a.has('--capture') ? JSON.parse(await readFile(a.get('--capture')!, 'utf8')) as SharedSheetCapture : undefined;
  if (apply) assertSharedSheetPlan(plan, a.get('--expected-plan-digest'), target);
  else buildSharedSheetBatch(capture);
  // Before opening even the audited write runtime. Never replace the approved capture or its observation time.
  if (apply && a.has('--live-capture')) assertLiveSharedSheetMatches(plan!, JSON.parse(await readFile(a.get('--live-capture')!, 'utf8')));
  const options = { target, apply, ...(capture ? { capture } : {}), ...(plan ? { plan } : {}), ...(identityInputs ? { identityInputs } : {}),
    ...(a.has('--include-supplier-colors') ? { includeSupplierColors: true } : {}),
    ...(a.has('--operational-refresh') ? { operationalRefresh: true } : {}),
    ...(a.has('--expected-plan-digest') ? { expectedPlanDigest: a.get('--expected-plan-digest')! } : {}) };
  let result: Awaited<ReturnType<typeof runSharedSheetCanonical>>;
  if (a.has('--memory')) {
    const { MemoryDataStore } = await import('../infra/memory-store.js');
    const { MemorySourceStore } = await import('../infra/source-memory-store.js');
    if (apply) throw new Error('MEMORY_CLI_IS_OFFLINE_PLAN_ONLY');
    result = await runSharedSheetCanonical(new MemoryDataStore(), new MemorySourceStore(), options);
  } else {
    const { withSharedSheetCatalogAccess, captureVehicleMasterSnapshotReadOnly } = await import('./data-access-runtime.js');
    const currentVehicleMasterSnapshot = apply ? await captureVehicleMasterSnapshotReadOnly() : undefined;
    if (apply) {
      if (!currentVehicleMasterSnapshot) throw new Error('CURRENT_VEHICLE_MASTER_REQUIRED_BEFORE_APPLY');
      verifiedMasterRecords(currentVehicleMasterSnapshot);
      const planned = plan!.capture.vehicleMasterSnapshot as VehicleMasterSnapshot | undefined ?? plan!.identityInputs?.master;
      if (!planned || stableDigest({ masters: currentVehicleMasterSnapshot.masters, trims: currentVehicleMasterSnapshot.trims }) !==
          stableDigest({ masters: planned.masters, trims: planned.trims })) throw new Error('VEHICLE_MASTER_CHANGED_REPLAN_REQUIRED');
    }
    result = await withSharedSheetCatalogAccess(apply, stableDigest(plan ?? capture),
      (store, source) => runSharedSheetCanonical(store, source, { ...options,
        ...(apply ? { currentVehicleMasterSnapshot: currentVehicleMasterSnapshot! } : {}) }),
      apply ? async store => { await preflightSharedSheetApply(store, plan, options.expectedPlanDigest, target); } : undefined);
  }
  if ('plan' in result && a.has('--plan-out')) await writePrivateArtifact(a.get('--plan-out')!, result.plan);
  console.log(JSON.stringify(result.report, null, 2));
  if ('status' in result.report && result.report.status !== 'APPLIED') process.exitCode = 2;
}
export async function runSharedSheetCli(args = process.argv.slice(2)) {
  await main(args).catch(error => {
    // CI redirects stdout to apply.json and reads it even after a nonzero exit.
    // A business/system HOLD must never produce an empty JSON artifact.
    console.log(JSON.stringify({ mode: args.includes('--apply') ? 'APPLY' : 'DRY_RUN',
      status: 'HOLD', reason: 'SHARED_SHEET_JOB_HOLD' }));
    // main 의 안전 오류 코드(safeErrorCode)를 그대로 남긴다 — 원문 메시지·비밀은 싣지 않는다.
    console.error(`SHARED_SHEET_JOB_HOLD ${safeErrorCode(error)}`); process.exitCode = 1;
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSharedSheetCli();
}
