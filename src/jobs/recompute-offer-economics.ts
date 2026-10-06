import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRuntimeStores } from '../bootstrap.js';
import { resolveTargetProject } from '../infra/firebase-target.js';
import { offerEconomicsInputDigest, recomputeOfferEconomics } from '../application/catalog.js';
import { precomputeOfferEconomics } from '../application/resolve-offer-commercial-terms.js';
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
  schema: 'offer-economics-recompute/v1'; policyId: string; policyDigest: string; target: string;
  entries: Array<{ offerId: string; expectedRevision: number; inputDigest: string; before: Offer }>;
};

/** Pure reads: no transaction, gateway audit, projection, receipt or file writes. */
export async function planOfferEconomicsRecompute(store: CatalogStore, target: string) {
  const plan: EconomicsRecomputePlan = { schema: 'offer-economics-recompute/v1', target,
    policyId: KAKAO_COMMISSION_POLICY.policyId, policyDigest: stableDigest(KAKAO_COMMISSION_POLICY), entries: [] };
  const suppliers: Record<string, ReturnType<typeof supplierCounts>> = {};
  const unknown = new Map<string, number>();
  let changedOffers = 0;
  for (const offer of (await store.listOffers()).sort((a, b) => a.id.localeCompare(b.id))) {
    const product = await store.getProduct(offer.productId);
    const model = product ? await store.getVehicleModel(product.vehicleModelId) : null;
    const after = precomputeOfferEconomics(offer, product?.commercialType, model?.fuel);
    const before = offer.internalEconomicsTerms ?? [];
    plan.entries.push({ offerId: offer.id, expectedRevision: offer.revision,
      inputDigest: offerEconomicsInputDigest(offer, product, model), before: structuredClone(offer) });
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
    changedOffers, suppliers, unknownReasons: [...unknown].map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    planDigest: stableDigest(plan), plan };
}

type RecomputeOptions = {
  target: string; apply?: boolean; plan?: EconomicsRecomputePlan; expectedPlanDigest?: string;
  policyId?: string; actor?: ActorRef; writer?: ExecutionWriterRef;
};

function assertApplyPlan(options: RecomputeOptions): EconomicsRecomputePlan {
  const plan = options.plan;
  if (!plan || plan.schema !== 'offer-economics-recompute/v1' || plan.target !== options.target ||
      options.policyId !== KAKAO_COMMISSION_POLICY.policyId || plan.policyId !== options.policyId ||
      plan.policyDigest !== stableDigest(KAKAO_COMMISSION_POLICY) || !options.actor ||
      options.expectedPlanDigest !== stableDigest(plan) || !Array.isArray(plan.entries) ||
      new Set(plan.entries.map(entry => entry.offerId)).size !== plan.entries.length ||
      plan.entries.some(entry => entry.before?.id !== entry.offerId || entry.before.revision !== entry.expectedRevision)) {
    throw new Error('HOLD: apply requires the reviewed plan digest, target, policy and actor');
  }
  return plan;
}

export async function runOfferEconomicsRecompute(store: CatalogStore, options: RecomputeOptions) {
  if (!options.apply) return planOfferEconomicsRecompute(store, options.target);
  const plan = assertApplyPlan(options);
  const results: Array<{ offerId: string; status: string; changed: boolean; revision?: number; reason?: string }> = [];
  for (const entry of plan.entries) {
    try {
      const identity = stableDigest({ policyId: plan.policyId, policyDigest: plan.policyDigest,
        offerId: entry.offerId, inputDigest: entry.inputDigest });
      const result = await recomputeOfferEconomics(store, {
        commandId: `recompute:${identity}`, idempotencyKey: `recompute:${identity}`,
        offerId: entry.offerId, expectedRevision: entry.expectedRevision, inputDigest: entry.inputDigest,
        policyId: plan.policyId, actor: options.actor!, ...(options.writer ? { writer: options.writer } : {}),
        reason: `Approved economics plan ${options.expectedPlanDigest}`
      });
      results.push({ offerId: entry.offerId, ...result });
    } catch (error) {
      results.push({ offerId: entry.offerId, status: 'HOLD', changed: false,
        reason: error instanceof Error ? error.message : String(error) });
      // Partial commits are explicit; stop on the first conflict. Never refresh revisions and retry.
      break;
    }
  }
  return { mode: 'APPLY' as const, status: results.some(row => row.status === 'HOLD') ? 'HOLD' : 'APPLIED',
    changedOffers: results.filter(row => row.changed).length, processedOffers: results.length,
    remainingOffers: plan.entries.length - results.length, planDigest: options.expectedPlanDigest, results };
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--memory', '--firestore', '--apply', '--plan', '--policy-id', '--expected-plan-digest']);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!allowed.has(arg) || values.has(arg)) throw new Error(`Unknown/duplicate argument: ${arg}`);
    if (['--plan', '--policy-id', '--expected-plan-digest'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
      values.set(arg, value);
    } else values.set(arg, 'true');
  }
  if (values.has('--memory') === values.has('--firestore')) throw new Error('Select exactly one: --memory or --firestore');
  const apply = values.has('--apply');
  if (apply && (!values.has('--plan') || !values.has('--policy-id') || !values.has('--expected-plan-digest'))) {
    throw new Error('HOLD: --apply needs --plan, --policy-id and --expected-plan-digest');
  }
  const target = values.has('--memory') ? 'memory-demo' : resolveTargetProject();
  const planFile = values.get('--plan');
  const plan = planFile ? JSON.parse(await readFile(planFile, 'utf8')) as EconomicsRecomputePlan : undefined;
  const options: RecomputeOptions = { target, apply,
    ...(plan ? { plan } : {}), ...(values.has('--policy-id') ? { policyId: values.get('--policy-id')! } : {}),
    ...(values.has('--expected-plan-digest') ? { expectedPlanDigest: values.get('--expected-plan-digest')! } : {}),
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
