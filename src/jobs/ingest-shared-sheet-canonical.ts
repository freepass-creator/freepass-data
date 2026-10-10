import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSharedSheetBatch, sharedSheetRegisteredChannels, sharedSheetUnavailableChannels, SHARED_SHEET_SPEC_DIGEST, type SharedSheetCapture } from '../adapters/shared-sheet-source.js';
import { sharedSheetNormalizer, SHARED_SHEET_RULE_VERSION, sharedSheetStatusPolicy, type SharedSheetIdentityResolver } from '../adapters/normalize-shared-sheet.js';
import { assertVehicleIdentityInputs, verifiedMasterRecords, type VehicleIdentityInputs, type VehicleMasterSnapshot } from '../adapters/vehicle-identity-inputs.js';
import { chooseVehicleIdentity, indexVehicleMaster, VEHICLE_IDENTITY_RULE_VERSION } from '../domain/vehicle-identity-resolution.js';
import { ingestRawSourceBatch, prepareRawSourceBatch } from '../application/ingest-raw-source.js';
import { canonicalizeCatalogCandidate, type CanonicalizeCatalogCandidateInput } from '../application/canonicalize-catalog-candidate.js';
import { reviewSourceChange, applyReviewedSourceChange } from '../application/reviewed-source-change.js';
import { precomputeOfferEconomics } from '../application/resolve-offer-commercial-terms.js';
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
};
export function identityResolver(inputs: VehicleIdentityInputs | undefined): SharedSheetIdentityResolver | undefined {
  if (!inputs) return undefined;
  assertVehicleIdentityInputs(inputs);
  const master = indexVehicleMaster(verifiedMasterRecords(inputs.master));
  const data = new Map(inputs.data.map(x => [x.plate, x.identity]));
  return row => chooseVehicleIdentity(master, { sheet: row.sheet, data: data.get(row.plate) ?? null, raw: row.raw,
    firstRegistration: row.firstRegistration, modelYear: row.modelYear });
}
function prepared(capture: SharedSheetCapture, identityInputs?: VehicleIdentityInputs) {
  const batch = buildSharedSheetBatch(capture);
  const p = prepareRawSourceBatch(batch);
  const snapshot = capture.vehicleMasterSnapshot as VehicleMasterSnapshot | undefined ?? identityInputs?.master;
  if (capture.vehicleMasterSnapshot && identityInputs &&
      stableDigest(capture.vehicleMasterSnapshot) !== stableDigest(identityInputs.master)) throw new Error('VEHICLE_MASTER_SNAPSHOT_MISMATCH');
  const master = snapshot ? { records: verifiedMasterRecords(snapshot), readAt: snapshot.readAt, snapshotDigest: snapshot.digest } : undefined;
  const normalize = sharedSheetNormalizer(identityResolver(identityInputs), master);
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
  identityInputs?: VehicleIdentityInputs) {
  const p = prepared(capture, identityInputs);
  const currentHead = await store.getSourceHead(p.sourceId);
  const ownership = await store.getCatalogWriterOwnership();
  const sourceEligible = currentHead?.runId === p.runId || decideSourceHead(p.batch.coverage, p.batch.observedAt, currentHead?.observedAt).acceptedAsHead;
  const plan: SharedSheetPlan = { schema: 'shared-sheet-canonical-plan/v1', target, capture: structuredClone(capture),
    ruleVersion: SHARED_SHEET_RULE_VERSION, specDigest: SHARED_SHEET_SPEC_DIGEST,
    policyDigest: stableDigest(KAKAO_COMMISSION_POLICY), ownershipDigest: stableDigest(ownership),
    previousHeadDigest: stableDigest(currentHead), runId: p.runId, entries: [],
    ...(identityInputs ? { identityInputs: structuredClone(identityInputs), identityRuleVersion: VEHICLE_IDENTITY_RULE_VERSION } : {}) };
  const suppliers: Record<string, ReturnType<typeof group>> = Object.fromEntries(sharedSheetRegisteredChannels.map(x => [x.code, group()]));
  const holdReasons: Record<string, number> = {};
  const unknownFeeReasons: Record<string, number> = {};
  const [assets, products, offers] = await Promise.all([store.listVehicleAssets(), store.listProducts(), store.listOffers()]);
  const prospective = overlay(store, p);
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
    const commandId = `shared:${stableDigest([p.runId, c.sourceRecordId, SHARED_SHEET_RULE_VERSION, plan.policyDigest])}`;
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
      } else if ((await store.getProduct(binding.productId))?.status !== productStatus ||
          (binding.vehicleAssetId && (await store.getVehicleAsset(binding.vehicleAssetId))?.status !== statusPolicy?.assetStatus)) {
        // Exposure/asset status changes are not part of the generic reviewed source change yet: hold instead of silently diverging.
        reasons.push('STATUS_CHANGE_REQUIRES_REVIEW');
      } else if (binding.sourceFingerprint === c.sourceFingerprint) {
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
          const review = await reviewSourceChange(prospective, bindingId, item.record.candidateId);
          if (review.blockedChangeIds.length) reasons.push(...review.diffs.filter(x => x.classification === 'BLOCKED').map(x => x.reasonCode));
          else {
            entry.action = 'CHANGE';
            entry.change = { ...base, bindingId, expectedBindingRevision: review.bindingRevision,
              expectedVehicleModelRevision: review.vehicleModelRevision, expectedProductRevision: review.productRevision,
              expectedOfferRevision: review.offerRevision, expectedVehicleAssetRevision: review.vehicleAssetRevision ?? null,
              approvedChangeIds: review.reviewableChangeIds, approvedIssues: [] };
          }
        } catch { reasons.push('SOURCE_CHANGE_REVIEW_FAILED'); }
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

export function assertSharedSheetPlan(plan: SharedSheetPlan | undefined, digest: string | undefined, target: string): asserts plan is SharedSheetPlan {
  if (!plan || !digest || plan.schema !== 'shared-sheet-canonical-plan/v1' || plan.target !== target ||
      plan.ruleVersion !== SHARED_SHEET_RULE_VERSION || plan.specDigest !== SHARED_SHEET_SPEC_DIGEST ||
      plan.policyDigest !== stableDigest(KAKAO_COMMISSION_POLICY) || digest !== stableDigest(plan) || !Array.isArray(plan.entries)) {
    throw new Error('SHARED_SHEET_PLAN_REQUIRED_OR_CHANGED');
  }
  if (plan.identityInputs !== undefined || plan.identityRuleVersion !== undefined) {
    assertVehicleIdentityInputs(plan.identityInputs);
    if (plan.identityRuleVersion !== VEHICLE_IDENTITY_RULE_VERSION) throw new Error('SHARED_SHEET_PLAN_REQUIRED_OR_CHANGED');
  }
  if (prepared(plan.capture, plan.identityInputs).runId !== plan.runId) throw new Error('SHARED_SHEET_PLAN_CAPTURE_MISMATCH');
}
/** Read-only apply guard. The CLI runs it before opening the audited write, so a rejected apply writes nothing (not even an audit event). */
export async function preflightSharedSheetApply(store: CatalogStore, plan: SharedSheetPlan | undefined, digest: string | undefined, target: string): Promise<void> {
  assertSharedSheetPlan(plan, digest, target);
  const ownership = await store.getCatalogWriterOwnership();
  if (!ownership || ownership.mode !== 'EXCLUSIVE' || ownership.primaryWriterId !== actor.id || stableDigest(ownership) !== plan.ownershipDigest)
    throw new Error('SHARED_SHEET_EXCLUSIVE_WRITER_REQUIRED');
}
export async function runSharedSheetCanonical(store: CatalogStore, source: SourceIngestionStore, options: {
  target: string; capture?: SharedSheetCapture; apply?: boolean; plan?: SharedSheetPlan; expectedPlanDigest?: string;
  identityInputs?: VehicleIdentityInputs; currentVehicleMasterSnapshot?: VehicleMasterSnapshot;
}) {
  if (!options.apply) {
    if (!options.capture) throw new Error('SHARED_SHEET_CAPTURE_REQUIRED');
    return planSharedSheetCanonical(store, options.capture, options.target, options.identityInputs);
  }
  const plan = options.plan;
  assertSharedSheetPlan(plan, options.expectedPlanDigest, options.target);
  if (options.target === 'freepasserp5') {
    const current = options.currentVehicleMasterSnapshot;
    if (!current) throw new Error('CURRENT_VEHICLE_MASTER_REQUIRED_BEFORE_APPLY');
    verifiedMasterRecords(current);
    const planned = plan.capture.vehicleMasterSnapshot as VehicleMasterSnapshot | undefined ?? plan.identityInputs?.master;
    if (!planned || stableDigest({ masters: current.masters, trims: current.trims }) !==
        stableDigest({ masters: planned.masters, trims: planned.trims })) throw new Error('VEHICLE_MASTER_CHANGED_REPLAN_REQUIRED');
  }
  await preflightSharedSheetApply(store, plan, options.expectedPlanDigest, options.target);
  const p = prepared(plan.capture, plan.identityInputs);
  const head = await store.getSourceHead(p.sourceId);
  if (head?.runId !== p.runId && stableDigest(head) !== plan.previousHeadDigest) throw new Error('SHARED_SHEET_HEAD_CHANGED');
  // Reconstruct the automatic decision, including all expected revisions, before any write.
  const fresh = await planSharedSheetCanonical(store, plan.capture, plan.target, plan.identityInputs);
  if (fresh.plan.entries.length !== plan.entries.length) throw new Error('SHARED_SHEET_PLAN_ENTRIES_CHANGED');
  const replay = new Set<string>();
  for (let i = 0; i < plan.entries.length; i++) {
    const entry = plan.entries[i]!;
    const receipt = entry.create ? await store.getCanonicalizationReceipt(entry.create.idempotencyKey)
      : entry.change ? await store.getReviewedSourceChangeReceipt(entry.change.idempotencyKey) : null;
    if (receipt) {
      // The command itself rechecks its requestDigest before returning its receipt.
      replay.add(entry.recordId);
    } else if (stableDigest(entry) !== stableDigest(fresh.plan.entries[i])) throw new Error('SHARED_SHEET_PLAN_STALE');
  }
  const run = await ingestRawSourceBatch(source, p.batch, new Date().toISOString(), p.normalize);
  if (run.headStatus !== 'CURRENT' || run.candidateCount !== p.normalized.length) throw new Error('SHARED_SHEET_INTAKE_NOT_READY');
  let committed = 0, noChange = 0, held = 0;
  for (const entry of plan.entries) {
    if (entry.action === 'HOLD') { held++; continue; }
    if (entry.action === 'NO_CHANGE') { noChange++; continue; }
    try {
      if (entry.create) await canonicalizeCatalogCandidate(store, entry.create);
      else if (entry.change) await applyReviewedSourceChange(store, entry.change);
      else throw new Error('INVALID_SHARED_SHEET_ACTION');
      if (replay.has(entry.recordId)) noChange++; else committed++;
    } catch {
      // No thrown provider text or raw identifiers in stdout/public CI.
      return { report: { mode: 'APPLY', status: 'HOLD', committed, noChange, held,
        remaining: plan.entries.length - committed - noChange - held, reason: 'CANONICAL_COMMAND_REJECTED' } };
    }
  }
  let suppliedTerms = 0, storedTerms = 0, heldTerms = 0, readbackMismatches = 0;
  for (const item of p.normalized) {
    const entry = plan.entries.find(x => x.recordId === item.record.sourceRecordId)!;
    if (entry.action === 'HOLD') { heldTerms += item.suppliedTerms; continue; }
    suppliedTerms += item.suppliedTerms;
    const c = item.record.candidate;
    const binding = await store.getSourceBinding(opaque('bind', p.sourceId, c.sourceRecordId));
    const offer = binding ? await store.getOffer(binding.offerId) : null;
    const asset = binding?.vehicleAssetId ? await store.getVehicleAsset(binding.vehicleAssetId) : null;
    const expected = precomputeOfferEconomics({ id: opaque('off', p.sourceId, c.sourceRecordId),
      supplierId: c.providerCompanyCode!, priceTerms: c.priceTerms }, c.commercialType, c.fuelType);
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
  const a = parseLocalArgs(args, ['--memory', '--firestore', '--apply'], ['--capture', '--plan', '--plan-out', '--expected-plan-digest', '--identity-inputs']);
  const apply = a.has('--apply');
  if (apply && (!a.has('--plan') || !a.has('--expected-plan-digest'))) throw new Error('APPLY_REQUIRES_PLAN_AND_DIGEST');
  if (apply && (a.has('--capture') || a.has('--plan-out'))) throw new Error('APPLY_USES_REVIEWED_PLAN_ONLY');
  if (!apply && (a.has('--plan') || a.has('--expected-plan-digest'))) throw new Error('PLAN_FLAGS_REQUIRE_APPLY');
  if (!apply && !a.has('--capture')) throw new Error('CAPTURE_REQUIRED');
  if (apply && a.has('--identity-inputs')) throw new Error('APPLY_USES_REVIEWED_PLAN_ONLY');
  const identityInputs = a.has('--identity-inputs') ? JSON.parse(await readFile(a.get('--identity-inputs')!, 'utf8')) as VehicleIdentityInputs : undefined;
  if (identityInputs) assertVehicleIdentityInputs(identityInputs);
  const { resolveTargetProject } = await import('../infra/firebase-target.js');
  const target = a.has('--memory') ? 'memory' : resolveTargetProject();
  const plan = a.has('--plan') ? JSON.parse(await readFile(a.get('--plan')!, 'utf8')) as SharedSheetPlan : undefined;
  const capture = a.has('--capture') ? JSON.parse(await readFile(a.get('--capture')!, 'utf8')) as SharedSheetCapture : undefined;
  if (apply) assertSharedSheetPlan(plan, a.get('--expected-plan-digest'), target);
  else buildSharedSheetBatch(capture);
  const options = { target, apply, ...(capture ? { capture } : {}), ...(plan ? { plan } : {}), ...(identityInputs ? { identityInputs } : {}),
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
    result = await withSharedSheetCatalogAccess(apply, stableDigest(plan ?? capture),
      (store, source) => runSharedSheetCanonical(store, source, { ...options,
        ...(apply ? { currentVehicleMasterSnapshot: currentVehicleMasterSnapshot! } : {}) }),
      apply ? store => preflightSharedSheetApply(store, plan, options.expectedPlanDigest, target) : undefined);
  }
  if ('plan' in result && a.has('--plan-out')) await writePrivateArtifact(a.get('--plan-out')!, result.plan);
  console.log(JSON.stringify(result.report, null, 2));
  if ('status' in result.report && result.report.status !== 'APPLIED') process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('SHARED_SHEET_JOB_HOLD'); process.exitCode = 1; });
}
