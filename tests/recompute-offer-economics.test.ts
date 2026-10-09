import { describe, expect, it, vi } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { offerEconomicsInputDigest, recomputeOfferEconomics } from '../src/application/catalog.js';
import { KAKAO_COMMISSION_POLICY } from '../src/application/kakao-catalog-reference.js';
import { precomputeOfferEconomics } from '../src/application/resolve-offer-commercial-terms.js';
import { planOfferEconomicsRecompute, runOfferEconomicsRecompute } from '../src/jobs/recompute-offer-economics.js';
import { stableDigest } from '../src/shared/stable-digest.js';
import { LEGACY_CATALOG_WRITER_OWNERSHIP } from '../src/domain/writer-ownership.js';

const actor = { id: 'service:freepass-data', kind: 'SERVICE' as const };
async function fixture() {
  const store = new MemoryDataStore();
  await seedDemoCatalog(store);
  await store.seed({ catalogWriterOwnership: structuredClone(LEGACY_CATALOG_WRITER_OWNERSHIP) });
  const offer = (await store.getOffer('offer_gv70_demo'))!;
  await store.seed({ offers: [{ ...offer, supplierId: 'RP013', internalEconomicsTerms: [] }] });
  return store;
}
async function prepare(store: MemoryDataStore) {
  const report = await planOfferEconomicsRecompute(store, 'memory-test');
  return { target: 'memory-test', apply: true, plan: report.plan, expectedPlanDigest: report.planDigest,
    policyId: report.plan.policyId, actor };
}

describe('offer economics recompute', () => {
  it('stops with HOLD if the committed economics cannot be verified by a fresh read', async () => {
    const store = await fixture(), options = await prepare(store);
    const getOffer = store.getOffer.bind(store);
    vi.spyOn(store, 'getOffer').mockImplementation(async id => {
      const offer = await getOffer(id);
      return offer && offer.revision > 1 ? { ...offer, internalEconomicsTerms: [] } : offer;
    });
    const report = await runOfferEconomicsRecompute(store, options);
    expect(report).toMatchObject({ status: 'HOLD', changedOffers: 1, readbackVerifiedOffers: 0 });
    if (report.mode !== 'APPLY') throw new Error('Expected apply');
    expect(report.results[0]!.reason).toBe('PERSISTENCE_READBACK_MISMATCH');
    expect(store.audits).toHaveLength(1);
  });
  it('dry-run performs zero transactions, audits, revisions, receipts and outbox writes', async () => {
    const store = await fixture();
    const offers = await store.listOffers(), history = await store.listRevisionHistory();
    const transaction = vi.spyOn(store, 'transact');
    const report = await runOfferEconomicsRecompute(store, { target: 'memory-test' });
    expect(report).toMatchObject({ mode: 'DRY_RUN', writes: 0, changedOffers: 1 });
    expect(transaction).not.toHaveBeenCalled();
    expect(await store.listOffers()).toEqual(offers);
    expect(await store.listRevisionHistory()).toEqual(history);
    expect(store.audits).toHaveLength(0); expect(store.outbox.size).toBe(0);
  });

  it('applies only changed offers; replay and a fresh second plan write zero', async () => {
    const store = await fixture(), original = (await store.listOffers())[0]!;
    const product = (await store.getProduct(original.productId))!;
    const model = (await store.getVehicleModel(product.vehicleModelId))!;
    const unchanged = { ...original, id: 'already-current' };
    unchanged.internalEconomicsTerms = precomputeOfferEconomics(unchanged, product.commercialType, model.fuel);
    await store.seed({ offers: [unchanged] });
    const options = await prepare(store);
    expect(await runOfferEconomicsRecompute(store, options)).toMatchObject({ status: 'APPLIED', changedOffers: 1 });
    expect(await runOfferEconomicsRecompute(store, options)).toMatchObject({ status: 'APPLIED', changedOffers: 0 });
    expect(await runOfferEconomicsRecompute(store, await prepare(store))).toMatchObject({ changedOffers: 0 });
    expect((await store.getOffer(unchanged.id))!.revision).toBe(1);
    expect(store.audits).toHaveLength(1); expect(store.outbox.size).toBe(1);
    expect(store.audits[0]).toMatchObject({ action: 'RECOMPUTE_OFFER_ECONOMICS', before: original,
      authorityRuleId: 'catalog.offer.internal-economics.recompute.v1', revisionBefore: 1, revisionAfter: 2 });
    expect(store.audits[0]!.action).not.toBe('OFFER_PRICE_UPDATED');
    expect((await store.listEntityHistory('offer', original.id)).at(-1)!.snapshot)
      .toEqual(await store.getOffer(original.id));
    expect((await store.getOffer(original.id))!.priceTerms).toEqual(original.priceTerms);
  });

  it('stale expectedRevision is HOLD with zero mutation', async () => {
    const store = await fixture(), options = await prepare(store);
    const offer = (await store.listOffers())[0]!;
    await store.seed({ offers: [{ ...offer, revision: offer.revision + 1 }] });
    expect(await runOfferEconomicsRecompute(store, options)).toMatchObject({ status: 'HOLD', changedOffers: 0 });
    expect(store.audits).toHaveLength(0); expect(store.outbox.size).toBe(0);
  });

  it('Product/Model drift after planning fails closed', async () => {
    const store = await fixture(), options = await prepare(store);
    const model = (await store.listVehicleModels())[0]!;
    await store.seed({ vehicleModels: [{ ...model, revision: model.revision + 1, fuel: '전기' }] });
    expect(await runOfferEconomicsRecompute(store, options)).toMatchObject({ status: 'HOLD', changedOffers: 0,
      results: [expect.objectContaining({ reason: expect.stringContaining('INPUT_DRIFT') })] });
  });

  it('missing writer ownership fails closed', async () => {
    const store = await fixture(), options = await prepare(store);
    await store.seed({ catalogWriterOwnership: null });
    expect(await runOfferEconomicsRecompute(store, options)).toMatchObject({ status: 'HOLD', changedOffers: 0 });
    expect(store.audits).toHaveLength(0);
  });

  it('missing product meaning stays UNKNOWN with no policy sourceRefs', async () => {
    const store = await fixture(), offer = (await store.listOffers())[0]!;
    await store.seed({ offers: [{ ...offer, productId: 'missing-product' }] });
    expect(await runOfferEconomicsRecompute(store, await prepare(store))).toMatchObject({ changedOffers: 1 });
    const terms = (await store.getOffer(offer.id))!.internalEconomicsTerms!;
    for (const term of terms) for (const side of ['supplierBillingFee', 'channelPayoutFee'] as const) {
      expect(term[side]).toMatchObject({ state: 'UNKNOWN', amount: null, sourceRefs: [], reasonCode: 'PRODUCT_TYPE_REQUIRED' });
    }
  });

  it('an unauthorized writer cannot apply even a no-op', async () => {
    const store = await fixture();
    await runOfferEconomicsRecompute(store, await prepare(store));
    const options = await prepare(store);
    const result = await runOfferEconomicsRecompute(store, { ...options, writer: { id: 'service:other', kind: 'SERVICE' } });
    expect(result).toMatchObject({ status: 'HOLD', changedOffers: 0 });
    expect(store.audits).toHaveLength(1);
  });

  it('transaction failure rolls back the Offer, before-image, history and outbox', async () => {
    const store = await fixture(), options = await prepare(store);
    const original = await store.listOffers(), history = await store.listRevisionHistory();
    const transact = store.transact.bind(store);
    vi.spyOn(store, 'transact').mockImplementation(fn => transact(tx => fn({ ...tx,
      appendOutbox: async () => { throw new Error('injected outbox failure'); } })));
    expect(await runOfferEconomicsRecompute(store, options)).toMatchObject({ status: 'HOLD', changedOffers: 0 });
    expect(await store.listOffers()).toEqual(original);
    expect(await store.listRevisionHistory()).toEqual(history);
    expect(store.audits).toHaveLength(0); expect(store.outbox.size).toBe(0);
  });

  it('stops on conflict and reports prior commits and remaining work', async () => {
    const store = await fixture(), original = (await store.listOffers())[0]!;
    await store.seed({ offers: [{ ...original, id: 'a-first' }, { ...original, id: 'z-last' }] });
    const options = await prepare(store);
    await store.seed({ offers: [{ ...original, revision: 2 }] });
    expect(await runOfferEconomicsRecompute(store, options)).toMatchObject({ status: 'HOLD',
      changedOffers: 1, processedOffers: 2, remainingOffers: 1 });
    expect((await store.getOffer('z-last'))!.revision).toBe(1);
    expect(store.audits).toHaveLength(1);
  });

  it('rejects wrong policy, modified plan, target or missing apply pins', async () => {
    const store = await fixture(), options = await prepare(store);
    for (const changed of [{ policyId: 'old' }, { expectedPlanDigest: 'bad' }, { target: 'other-project' }]) {
      await expect(runOfferEconomicsRecompute(store, { ...options, ...changed })).rejects.toThrow('HOLD');
    }
    await expect(runOfferEconomicsRecompute(store, { target: 'memory-test', apply: true })).rejects.toThrow('HOLD');
    expect(store.audits).toHaveLength(0);
  });

  it('detects amount/state/policy/evidence/reason changes and counts each term once', async () => {
    const store = await fixture(), offer = (await store.listOffers())[0]!;
    const product = (await store.getProduct(offer.productId))!, model = (await store.getVehicleModel(product.vehicleModelId))!;
    const economics = precomputeOfferEconomics(offer, product.commercialType, model.fuel);
    for (const term of economics) for (const side of ['supplierBillingFee', 'channelPayoutFee'] as const) {
      term[side] = { state: 'UNKNOWN', amount: null, sourceRefs: ['old'], policyId: 'old', reasonCode: 'OLD' };
    }
    await store.seed({ offers: [{ ...offer, internalEconomicsTerms: economics }] });
    const report = await planOfferEconomicsRecompute(store, 'memory-test');
    expect(report.suppliers.RP013).toMatchObject({ offers: 1, terms: offer.priceTerms.length,
      changedTerms: { any: 1, amount: 1, state: 1, policyId: 1, evidence: 1, reasonCode: 1 },
      supplierBillingFee: { before: { UNKNOWN: 1 }, after: { KNOWN: 1 } } });
    expect(report.unknownReasons.some(row => row.reason === 'before:supplierBillingFee:OLD')).toBe(true);
  });

  it.each(['policyId', 'sourceRefs', 'reasonCode'] as const)('persists %s-only differences', async field => {
    const store = await fixture(), offer = (await store.listOffers())[0]!;
    const product = (await store.getProduct(offer.productId))!, model = (await store.getVehicleModel(product.vehicleModelId))!;
    const terms = precomputeOfferEconomics(offer, product.commercialType, model.fuel);
    if (field === 'sourceRefs') terms[0]!.supplierBillingFee.sourceRefs = ['old'];
    else terms[0]!.supplierBillingFee[field] = 'old';
    await store.seed({ offers: [{ ...offer, internalEconomicsTerms: terms }] });
    expect(await runOfferEconomicsRecompute(store, await prepare(store))).toMatchObject({ changedOffers: 1 });
  });

  it('command rejects idempotency reuse with a different payload', async () => {
    const store = await fixture(), offer = (await store.listOffers())[0]!;
    const product = (await store.getProduct(offer.productId))!, model = (await store.getVehicleModel(product.vehicleModelId))!;
    const input = { commandId: 'command', idempotencyKey: 'idempotency', offerId: offer.id, expectedRevision: 1,
      policyId: KAKAO_COMMISSION_POLICY.policyId, inputDigest: offerEconomicsInputDigest(offer, product, model), actor, reason: 'test' };
    await recomputeOfferEconomics(store, input);
    await expect(recomputeOfferEconomics(store, { ...input, reason: 'different' })).rejects.toThrow('different request payload');
    expect(store.audits).toHaveLength(1);
    expect(stableDigest(store.audits[0]!.before)).toBe(stableDigest(offer));
  });
});
