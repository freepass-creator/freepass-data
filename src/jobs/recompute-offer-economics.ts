import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRuntimeStores } from '../bootstrap.js';
import { resolveTargetProject } from '../infra/firebase-target.js';
import { offerEconomicsInputDigest, recomputeOfferEconomics, assertOfferFeeSubsetEvidence, type OfferFeeSubsetEvidence } from '../application/catalog.js';
import { selectOfferFeeEconomics } from '../application/resolve-offer-commercial-terms.js';
import { KAKAO_COMMISSION_POLICY } from '../application/kakao-catalog-reference.js';
import type { ActorRef, Offer } from '../domain/catalog.js';
import type { ExecutionWriterRef } from '../domain/writer-ownership.js';
import type { CatalogStore } from '../ports/catalog-store.js';
import { stableDigest } from '../shared/stable-digest.js';

const sides = ['supplierBillingFee', 'channelPayoutFee'] as const;
const states = () => ({ KNOWN: 0, ZERO: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 });
const counts = () => ({ before: states(), after: states() });
const supplierCounts = () => ({ offers: 0, terms: 0, supplierBillingFee: counts(), channelPayoutFee: counts(),
  changedTerms: { any: 0, amount: 0, state: 0, policyId: 0, evidence: 0, reasonCode: 0 } });

export type EconomicsRecomputePlan = {
  schema: 'offer-economics-recompute/v2'; policyId: string; policyDigest: string; target: string;
  entries: Array<{ offerId: string; expectedRevision: number; inputDigest: string; expectedEconomicsDigest: string; before: Offer;
    feeSubset?: {termKeys:string[]; evidence?:OfferFeeSubsetEvidence} }>;
};

/** Pure reads: no transaction, gateway audit, projection, receipt or file writes. */
export type EconomicsRecomputeScope = { offerIds?: readonly string[]; productIds?: readonly string[];
  feeSubsetsByOffer?: Readonly<Record<string,{termKeys:string[];evidence?:OfferFeeSubsetEvidence}>> };
export async function planOfferEconomicsRecompute(store: CatalogStore, target: string, scope: EconomicsRecomputeScope = {}) {
  const plan: EconomicsRecomputePlan = { schema: 'offer-economics-recompute/v2', target,
    policyId: KAKAO_COMMISSION_POLICY.policyId, policyDigest: stableDigest(KAKAO_COMMISSION_POLICY), entries: [] };
  const suppliers: Record<string, ReturnType<typeof supplierCounts>> = {};
  const unknown = new Map<string, number>();
  let changedOffers = 0;
  const applyBlockers:Array<{offerId:string;reason:string}>=[];
  const selectedIds=scope.offerIds ?? (scope.feeSubsetsByOffer ? Object.keys(scope.feeSubsetsByOffer):undefined);
  const offers = selectedIds ? await Promise.all([...new Set(selectedIds)].map(async id => {
    const offer = await store.getOffer(id);
    if (!offer) throw new Error('HOLD: scoped offer not found');
    return offer;
  })) : await store.listOffers();
  for (const offer of offers.filter(offer => !scope.productIds || scope.productIds.includes(offer.productId)).sort((a, b) => a.id.localeCompare(b.id))) {
    const product = await store.getProduct(offer.productId);
    const model = product ? await store.getVehicleModel(product.vehicleModelId) : null;
    const subset=scope.feeSubsetsByOffer?.[offer.id];
    if (scope.feeSubsetsByOffer && !subset) throw new Error('FEE_SUBSET_OFFER_SCOPE_MISMATCH');
    const after = selectOfferFeeEconomics(offer, product?.commercialType, model?.fuel,subset?.termKeys);
    if (subset) try { await assertOfferFeeSubsetEvidence(store,offer,subset.evidence); }
      catch(error) { applyBlockers.push({offerId:offer.id,reason:error instanceof Error?error.message:'FEE_SUBSET_EVIDENCE_INVALID'}); }
    const before = offer.internalEconomicsTerms ?? [];
    plan.entries.push({ offerId: offer.id, expectedRevision: offer.revision,
      inputDigest: offerEconomicsInputDigest(offer, product, model), expectedEconomicsDigest: stableDigest(after), before: structuredClone(offer),
      ...(subset?{feeSubset:structuredClone(subset)}:{}) });
    const group = suppliers[offer.supplierId] ??= supplierCounts();
    group.offers++;
    const oldTerms = new Map(before.map(term => [term.termKey, term]));
    const newTerms = new Map(after.map(term => [term.termKey, term]));
    // Union includes stale stored terms that will be removed. Absence is UNKNOWN, never ZERO.
    for (const key of new Set([...oldTerms.keys(), ...newTerms.keys()])) {
      group.terms++;
      const oldTerm = oldTerms.get(key), newTerm = newTerms.get(key);
      const flags = { amount: false, state: false, policyId: false, evidence: false, reasonCode: false };
      for (const side of sides) {
        const oldFee = oldTerm?.[side], newFee = newTerm?.[side];
        group[side].before[oldFee?.state ?? 'UNKNOWN']++;
        group[side].after[newFee?.state ?? 'UNKNOWN']++;
        for (const [phase, fee] of [['before', oldFee], ['after', newFee]] as const) {
          if (!fee || fee.state === 'UNKNOWN') {
            const reason = `${phase}:${side}:${fee?.reasonCode ?? (fee ? 'UNSPECIFIED' : 'NOT_STORED')}`;
            unknown.set(reason, (unknown.get(reason) ?? 0) + 1);
          }
        }
        flags.amount ||= stableDigest(oldFee?.amount ?? null) !== stableDigest(newFee?.amount ?? null);
        flags.state ||= oldFee?.state !== newFee?.state;
        flags.policyId ||= oldFee?.policyId !== newFee?.policyId;
        flags.evidence ||= stableDigest(oldFee?.sourceRefs ?? []) !== stableDigest(newFee?.sourceRefs ?? []);
        flags.reasonCode ||= oldFee?.reasonCode !== newFee?.reasonCode;
      }
      if (stableDigest(oldTerm ?? null) !== stableDigest(newTerm ?? null)) group.changedTerms.any++;
      for (const field of Object.keys(flags) as Array<keyof typeof flags>) if (flags[field]) group.changedTerms[field]++;
    }
    if (stableDigest(before) !== stableDigest(after)) changedOffers++;
  }
  return { mode: 'DRY_RUN' as const, status: 'PLANNED' as const, writes: 0, offers: plan.entries.length,
    changedOffers, subsetEvidenceVerified:!!scope.feeSubsetsByOffer && applyBlockers.length===0,applyBlockers, suppliers, unknownReasons: [...unknown].map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    planDigest: stableDigest(plan), plan };
}

type RecomputeOptions = {
  target: string; apply?: boolean; plan?: EconomicsRecomputePlan; expectedPlanDigest?: string;
  policyId?: string; actor?: ActorRef; approvalRef?: string; writer?: ExecutionWriterRef;
  offerIds?: readonly string[]; productIds?: readonly string[];
  feeSubsetsByOffer?:NonNullable<EconomicsRecomputeScope['feeSubsetsByOffer']>;
};

function assertApplyPlan(options: RecomputeOptions): EconomicsRecomputePlan {
  const plan = options.plan;
  if (options.offerIds !== undefined || options.productIds !== undefined || options.feeSubsetsByOffer!==undefined || !plan || plan.schema !== 'offer-economics-recompute/v2' || plan.target !== options.target ||
      options.policyId !== KAKAO_COMMISSION_POLICY.policyId || plan.policyId !== options.policyId ||
      plan.policyDigest !== stableDigest(KAKAO_COMMISSION_POLICY) || !options.actor || typeof options.approvalRef !== 'string' || !options.approvalRef.trim() || options.approvalRef.length > 512 || /[\r\n]/.test(options.approvalRef) ||
      options.expectedPlanDigest !== stableDigest(plan) || !Array.isArray(plan.entries) ||
      new Set(plan.entries.map(entry => entry.offerId)).size !== plan.entries.length ||
      plan.entries.some(entry => entry.before?.id !== entry.offerId || entry.before.revision !== entry.expectedRevision || !/^[a-f0-9]{64}$/.test(entry.expectedEconomicsDigest) ||
        (entry.feeSubset && (!entry.feeSubset.evidence || !Array.isArray(entry.feeSubset.termKeys) || !entry.feeSubset.termKeys.length || new Set(entry.feeSubset.termKeys).size!==entry.feeSubset.termKeys.length)))) {
    throw new Error('HOLD: apply requires the reviewed plan digest, target, policy and actor');
  }
  return plan;
}

export async function runOfferEconomicsRecompute(store: CatalogStore, options: RecomputeOptions) {
  if (!options.apply) return planOfferEconomicsRecompute(store, options.target, options);
  const plan = assertApplyPlan(options);
  const results: Array<{ offerId: string; status: string; changed: boolean; revision?: number; reason?: string }> = [];
  let readbackVerifiedOffers = 0, readbackVerifiedChangedOffers = 0;
  for (const entry of plan.entries) {
    try {
      const identity = stableDigest({ policyId: plan.policyId, policyDigest: plan.policyDigest,
        offerId: entry.offerId, inputDigest: entry.inputDigest, expectedEconomicsDigest: entry.expectedEconomicsDigest, approvalRef: options.approvalRef,
        ...(entry.feeSubset?{feeSubset:entry.feeSubset}:{}) });
      const result = await recomputeOfferEconomics(store, {
        commandId: `recompute:${identity}`, idempotencyKey: `recompute:${identity}`,
        offerId: entry.offerId, expectedRevision: entry.expectedRevision, inputDigest: entry.inputDigest,
        policyId: plan.policyId, expectedEconomicsDigest: entry.expectedEconomicsDigest, approvalRef: options.approvalRef!, actor: options.actor!, ...(options.writer ? { writer: options.writer } : {}),
        ...(entry.feeSubset?{feeSubset:entry.feeSubset}:{}),
        reason: `Reviewed economics plan ${options.expectedPlanDigest}`
      });
      results.push({ offerId: entry.offerId, ...result });
      // A commit acknowledgement alone is not persistence verification.
      const stored = await store.getOffer(entry.offerId);
      if (!stored || stored.revision !== result.revision ||
          stableDigest(stored.priceTerms) !== stableDigest(entry.before.priceTerms) ||
          stableDigest(stored.internalEconomicsTerms ?? []) !== entry.expectedEconomicsDigest) {
        results[results.length - 1] = { ...results[results.length - 1]!, status: 'HOLD', reason: 'PERSISTENCE_READBACK_MISMATCH' };
        break;
      }
      readbackVerifiedOffers++;
      if (result.changed) readbackVerifiedChangedOffers++;
    } catch (error) {
      results.push({ offerId: entry.offerId, status: 'HOLD', changed: false,
        reason: error instanceof Error ? error.message : String(error) });
      // Partial commits are explicit; stop on the first conflict. Never refresh revisions and retry.
      break;
    }
  }
  return { mode: 'APPLY' as const, status: results.some(row => row.status === 'HOLD') ? 'HOLD' : 'APPLIED',
    changedOffers: results.filter(row => row.changed).length, processedOffers: results.length,
    readbackVerifiedOffers, readbackVerifiedChangedOffers,
    remainingOffers: plan.entries.length - results.length, planDigest: options.expectedPlanDigest, results };
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--memory', '--firestore', '--apply', '--plan', '--policy-id', '--expected-plan-digest', '--approval-ref', '--offer-ids', '--product-ids', '--fee-subsets']);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!allowed.has(arg) || values.has(arg)) throw new Error(`Unknown/duplicate argument: ${arg}`);
    if (['--plan', '--policy-id', '--expected-plan-digest', '--approval-ref', '--offer-ids', '--product-ids', '--fee-subsets'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
      values.set(arg, value);
    } else values.set(arg, 'true');
  }
  if (values.has('--memory') === values.has('--firestore')) throw new Error('Select exactly one: --memory or --firestore');
  const apply = values.has('--apply');
  if (apply && (values.has('--offer-ids') || values.has('--product-ids') || values.has('--fee-subsets'))) throw new Error('HOLD: apply scope comes only from the reviewed plan');
  if (apply && (!values.has('--plan') || !values.has('--policy-id') || !values.has('--expected-plan-digest') || !values.has('--approval-ref'))) {
    throw new Error('HOLD: --apply needs --plan, --policy-id, --expected-plan-digest and --approval-ref');
  }
  const target = values.has('--memory') ? 'memory-demo' : resolveTargetProject();
  const planFile = values.get('--plan');
  const plan = planFile ? JSON.parse(await readFile(planFile, 'utf8')) as EconomicsRecomputePlan : undefined;
  const subsets = values.has('--fee-subsets') ? JSON.parse(await readFile(values.get('--fee-subsets')!, 'utf8')) as NonNullable<EconomicsRecomputeScope['feeSubsetsByOffer']> : undefined;
  const options: RecomputeOptions = { target, apply,
    ...(subsets ? {feeSubsetsByOffer: subsets} : {}),
    ...(values.has('--offer-ids') ? { offerIds: values.get('--offer-ids')!.split(',').map(id => id.trim()).filter(Boolean) } : {}),
    ...(values.has('--product-ids') ? { productIds: values.get('--product-ids')!.split(',').map(id => id.trim()).filter(Boolean) } : {}),
    ...(plan ? { plan } : {}), ...(values.has('--policy-id') ? { policyId: values.get('--policy-id')! } : {}),
    ...(values.has('--expected-plan-digest') ? { expectedPlanDigest: values.get('--expected-plan-digest')! } : {}),
    ...(values.has('--approval-ref') ? { approvalRef: values.get('--approval-ref')! } : {}),
    actor: { id: 'service:freepass-data', kind: 'SERVICE' } };
  // Validate the complete apply contract before credentials or Firebase initialization.
  if (apply) assertApplyPlan(options);
  // Reuse bootstrap -> createFirestoreDataStore -> getTargetFirebaseApp. No second app path.
  process.env.FREEPASS_DATA_DRIVER = values.has('--memory') ? 'memory' : 'firestore';
  const { catalog } = await createRuntimeStores();
  const report = await runOfferEconomicsRecompute(catalog, options);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'HOLD') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
