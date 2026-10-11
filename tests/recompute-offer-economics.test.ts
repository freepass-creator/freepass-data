process.env.FREEPASS_SHEET_F04_ID = 'test-sheet-f04';
import { describe, expect, it, vi } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { offerEconomicsInputDigest, recomputeOfferEconomics, updateOfferPrice } from '../src/application/catalog.js';
import { KAKAO_COMMISSION_POLICY } from '../src/application/kakao-catalog-reference.js';
import { precomputeOfferEconomics, refreshOfferEconomicsForChangedInputs } from '../src/application/resolve-offer-commercial-terms.js';
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
    policyId: report.plan.policyId, actor, approvalRef: 'test:reviewed-plan' };
}

describe('offer economics recompute', () => {
  it('stores the confirmed one-month rent basis and recalculates 303 to 777 as 15 to 39 on both sides', async () => {
    const store=await fixture(),offer=(await store.listOffers())[0]!,product=(await store.getProduct(offer.productId))!;
    await store.seed({products:[{...product,commercialType:'USED_RENT'}]});
    offer.priceTerms=[{...offer.priceTerms[0]!,termKey:'m1',termMonths:1,monthlyRent:{amount:303,currency:'KRW'}}];
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'USED_RENT');
    for(const side of ['supplierBillingFee','channelPayoutFee'] as const) {
      expect(offer.internalEconomicsTerms[0]![side]).toMatchObject({amount:{amount:15},calculation:{kind:'RATE',base:'MONTHLY_RENT_X_TERM',rate:0.05}});
    }
    await store.seed({offers:[offer]});
    await updateOfferPrice(store,{commandId:'one-month-rent',idempotencyKey:'one-month-rent',offerId:offer.id,expectedRevision:offer.revision,
      termKey:'m1',monthlyRent:{amount:777,currency:'KRW'},reason:'confirmed rent change',actor});
    const saved=(await store.getOffer(offer.id))!;
    for(const side of ['supplierBillingFee','channelPayoutFee'] as const) expect(saved.internalEconomicsTerms![0]![side])
      .toMatchObject({amount:{amount:39},vatAmount:4,totalAmount:43,calculation:{kind:'RATE',base:'MONTHLY_RENT_X_TERM',rate:0.05}});
    expect(refreshOfferEconomicsForChangedInputs(saved,saved,false,'USED_RENT')).toEqual(saved.internalEconomicsTerms);
  });
  it('refuses legacy FIXED rent fees without original evidence and preserves the whole transaction', async () => {
    const store=await fixture(),offer=(await store.listOffers())[0]!,product=(await store.getProduct(offer.productId))!;
    await store.seed({products:[{...product,commercialType:'USED_RENT'}]});
    offer.priceTerms=[{...offer.priceTerms[0]!,termKey:'m1',termMonths:1,monthlyRent:{amount:303,currency:'KRW'}}];
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'USED_RENT');
    const fee=offer.internalEconomicsTerms[0]!.supplierBillingFee;
    fee.calculation={kind:'FIXED',amount:{amount:15,currency:'KRW'}};fee.sourceRefs=[];
    await store.seed({offers:[offer]});
    await expect(updateOfferPrice(store,{commandId:'legacy-unreviewed',idempotencyKey:'legacy-unreviewed',offerId:offer.id,expectedRevision:offer.revision,
      termKey:'m1',monthlyRent:{amount:777,currency:'KRW'},reason:'source change',actor})).rejects.toThrow('LEGACY_RENT_FEE_BASIS_REVIEW_REQUIRED');
    expect(await store.getOffer(offer.id)).toEqual(offer);expect(store.audits).toHaveLength(0);expect(store.outbox.size).toBe(0);
    fee.sourceRefs=[KAKAO_COMMISSION_POLICY.oneMonthBasic.sourceRef];
    expect(precomputeOfferEconomics(offer,'USED_RENT')[0]!.supplierBillingFee.calculation)
      .toEqual({kind:'RATE',base:'MONTHLY_RENT_X_TERM',rate:0.05});
    expect(fee.calculation.kind).toBe('FIXED');
  });
  it('does not change an apply plan scope through API options', async () => {
    const store=await fixture(), options=await prepare(store), tx=vi.spyOn(store,'transact');
    await expect(runOfferEconomicsRecompute(store,{...options,offerIds:[]})).rejects.toThrow('reviewed plan');
    await expect(runOfferEconomicsRecompute(store,{...options,productIds:[]})).rejects.toThrow('reviewed plan');
    expect(tx).not.toHaveBeenCalled();
  });
  it('refreshes all Billin periods linked to the changed 36-month reference rent', async () => {
    const store=await fixture(), original=(await store.listOffers())[0]!;
    const offer={...original,supplierId:'RP021',priceTerms:[36,60].map(months=>({...original.priceTerms[0]!,termKey:`m${months}`,termMonths:months,monthlyRent:{amount:800000,currency:'KRW' as const}}))};
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'USED_SUBSCRIPTION');
    const next=structuredClone(offer);next.priceTerms[0]!.monthlyRent.amount=900000;
    const refreshed=refreshOfferEconomicsForChangedInputs(offer,next,false,'USED_SUBSCRIPTION');
    expect(refreshed.map(term=>term.supplierBillingFee.amount!.amount)).toEqual([900000,900000]);
    expect(refreshed.map(term=>term.channelPayoutFee.amount!.amount)).toEqual([720000,720000]);
    const removed={...next,priceTerms:next.priceTerms.filter(term=>term.termMonths!==36)};
    expect(refreshOfferEconomicsForChangedInputs(offer,removed,false,'USED_SUBSCRIPTION')[0]!.supplierBillingFee)
      .toMatchObject({state:'UNKNOWN',amount:null});
    const ambiguous={...next,priceTerms:[...next.priceTerms,{...next.priceTerms[0]!,termKey:'m36-extra'}]};
    expect(refreshOfferEconomicsForChangedInputs(offer,ambiguous,false,'USED_SUBSCRIPTION').find(term=>term.termKey==='m60')!.supplierBillingFee)
      .toMatchObject({state:'UNKNOWN',amount:null});
  });
  it('scopes plans to changed offer/product IDs and rejects missing offers without writes', async () => {
    const store = await fixture(), original = (await store.listOffers())[0]!;
    await store.seed({ offers: [{ ...original, id: 'outside-scope', productId: 'outside-product' }] });
    vi.spyOn(store, 'listOffers').mockRejectedValueOnce(new Error('must use direct IDs'));
    const scoped = await planOfferEconomicsRecompute(store, 'memory-test', { offerIds: [original.id, original.id], productIds: [original.productId] });
    expect(scoped.plan.entries.map(entry => entry.offerId)).toEqual([original.id]);
    expect((await planOfferEconomicsRecompute(store, 'memory-test', { offerIds: [] })).offers).toBe(0);
    await expect(planOfferEconomicsRecompute(store, 'memory-test', { offerIds: ['missing'] })).rejects.toThrow('scoped offer not found');
    expect(store.audits).toHaveLength(0);
  });
  it('recalculates only affected rent periods and preserves vehicle-price fees through the existing writer', async () => {
    const store = await fixture(), offer = (await store.listOffers())[0]!;
    const product = (await store.getProduct(offer.productId))!;
    await store.seed({ products: [{ ...product, commercialType: 'USED_RENT' }] });
    offer.priceTerms = [24,36].map(months => ({...offer.priceTerms[0]!,termKey:`m${months}`,termMonths:months,monthlyRent:{amount:800000,currency:'KRW'}}));
    offer.internalEconomicsTerms = precomputeOfferEconomics(offer,'USED_RENT');
    offer.internalEconomicsTerms[0]!.channelPayoutFee = { state:'KNOWN',amount:{amount:300000,currency:'KRW'},
      calculation:{kind:'RATE',base:'VEHICLE_PRICE',rate:0.01},sourceRefs:['test:approved-existing-policy'],
      ruleId:'test:existing-vehicle-rate',policyId:'test:existing-policy',vatTreatment:'EXCLUDED',vatAmount:30000,totalAmount:330000 };
    await store.seed({offers:[offer]});
    await updateOfferPrice(store,{commandId:'changed-rent',idempotencyKey:'changed-rent',offerId:offer.id,
      expectedRevision:offer.revision,termKey:'m24',monthlyRent:{amount:900000,currency:'KRW'},reason:'source rent changed',actor});
    const saved = (await store.getOffer(offer.id))!;
    expect(saved.internalEconomicsTerms![0]!.channelPayoutFee).toEqual(offer.internalEconomicsTerms[0]!.channelPayoutFee);
    expect(saved.internalEconomicsTerms![0]!.supplierBillingFee.amount!.amount).not.toBe(offer.internalEconomicsTerms[0]!.supplierBillingFee.amount!.amount);
    expect(saved.internalEconomicsTerms![1]).toEqual(offer.internalEconomicsTerms[1]);
    expect(refreshOfferEconomicsForChangedInputs(offer,offer,false,'USED_RENT')).toEqual(offer.internalEconomicsTerms);
    expect(() => refreshOfferEconomicsForChangedInputs(offer,offer,undefined as any,'USED_RENT'))
      .toThrow('POLICY_CONTEXT_CHANGE_DECISION_REQUIRED');
    const repriced = refreshOfferEconomicsForChangedInputs(saved,saved,false,'USED_RENT',undefined,
      {before:{amount:30000000,currency:'KRW'},after:{amount:40000000,currency:'KRW'},sourceRef:'test:new-price-fact'});
    expect(repriced[0]!.channelPayoutFee).toMatchObject({amount:{amount:400000},vatAmount:40000,totalAmount:440000});
    expect(repriced[0]!.supplierBillingFee).toEqual(saved.internalEconomicsTerms![0]!.supplierBillingFee);
    const missing = refreshOfferEconomicsForChangedInputs(saved,saved,false,'USED_RENT',undefined,
      {before:{amount:30000000,currency:'KRW'},after:null,sourceRef:''});
    expect(missing[0]!.channelPayoutFee).toMatchObject({state:'UNKNOWN',amount:null,reasonCode:'VEHICLE_PRICE_EVIDENCE_REQUIRED'});
    const changedPeriod=structuredClone(saved);changedPeriod.priceTerms[0]!.termMonths=48;
    expect(refreshOfferEconomicsForChangedInputs(saved,changedPeriod,false,'USED_RENT')[0]!.channelPayoutFee)
      .toMatchObject({state:'UNKNOWN',amount:null,reasonCode:'VEHICLE_PRICE_POLICY_CONTEXT_REVIEW_REQUIRED'});
    expect(refreshOfferEconomicsForChangedInputs(saved,saved,true,'NEW_RENT')[0]!.channelPayoutFee.state).toBe('UNKNOWN');
    expect(offer.internalEconomicsTerms[0]!.channelPayoutFee.amount!.amount).toBe(300000);
    const plan=await planOfferEconomicsRecompute(store,'memory-test',{offerIds:[offer.id]});
    expect(plan.changedOffers).toBe(0);
  });
  it('rejects old or incomplete reviewed plans before a transaction', async () => {
    const store = await fixture(), original = await prepare(store), tx = vi.spyOn(store,'transact');
    for (const kind of ['v1','missing-result'] as const) {
      const options = structuredClone(original);
      if (kind === 'v1') (options.plan as any).schema = 'offer-economics-recompute/v1';
      else delete (options.plan.entries[0] as any).expectedEconomicsDigest;
      options.expectedPlanDigest = stableDigest(options.plan);
      await expect(runOfferEconomicsRecompute(store,options)).rejects.toThrow('HOLD');
    }
    expect(tx).not.toHaveBeenCalled(); expect(store.audits).toHaveLength(0);
  });
  it('rejects reviewed-result drift inside the transaction with zero mutations', async () => {
    const store = await fixture(), options = await prepare(store);
    // A changed calculator can preserve policy/input hashes; the approved result must still match.
    options.plan.entries[0]!.expectedEconomicsDigest = 'a'.repeat(64);
    options.expectedPlanDigest = stableDigest(options.plan);
    const before = await store.listOffers();
    const report = await runOfferEconomicsRecompute(store, options);
    expect(report).toMatchObject({status:'HOLD',changedOffers:0,readbackVerifiedOffers:0,
      results:[expect.objectContaining({reason:expect.stringContaining('REVIEWED_ECONOMICS_DRIFT')})]});
    expect(await store.listOffers()).toEqual(before);
    expect(store.audits).toHaveLength(0); expect(store.outbox.size).toBe(0);
  });
  it('keeps the approval reference with service execution in audit and history', async () => {
    const store = await fixture(), options = await prepare(store);
    expect(await runOfferEconomicsRecompute(store,options)).toMatchObject({status:'APPLIED',readbackVerifiedChangedOffers:1});
    expect(store.audits[0]!.reason).toContain(options.approvalRef);
    expect((await store.listRevisionHistory()).find(x => x.entityType === 'offer' && x.revision === 2)!.reason).toContain(options.approvalRef);
  });
  it('stops with HOLD if the committed economics cannot be verified by a fresh read', async () => {
    const store = await fixture(), options = await prepare(store);
    const getOffer = store.getOffer.bind(store);
    vi.spyOn(store, 'getOffer').mockImplementation(async id => {
      const offer = await getOffer(id);
      return offer && offer.revision > 1 ? { ...offer, internalEconomicsTerms: [] } : offer;
    });
    const report = await runOfferEconomicsRecompute(store, options);
    expect(report).toMatchObject({ status: 'HOLD', changedOffers: 1, readbackVerifiedOffers: 0, readbackVerifiedChangedOffers: 0 });
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
    for (const changed of [{ policyId: 'old' }, { expectedPlanDigest: 'bad' }, { target: 'other-project' }, { approvalRef: '' }]) {
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
      policyId: KAKAO_COMMISSION_POLICY.policyId, inputDigest: offerEconomicsInputDigest(offer, product, model),
      expectedEconomicsDigest: stableDigest(precomputeOfferEconomics(offer, product.commercialType, model.fuel)),
      approvalRef: 'test:reviewed-plan', actor, reason: 'test' };
    await recomputeOfferEconomics(store, input);
    await expect(recomputeOfferEconomics(store, { ...input, reason: 'different' })).rejects.toThrow('different request payload');
    expect(store.audits).toHaveLength(1);
    expect(stableDigest(store.audits[0]!.before)).toBe(stableDigest(offer));
  });
});
