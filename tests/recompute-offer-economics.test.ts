process.env.FREEPASS_SHEET_F04_ID = 'test-sheet-f04';
import { describe, expect, it, vi } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { assertOfferFeeSubsetEvidence, offerEconomicsInputDigest, recomputeOfferEconomics, updateOfferPrice } from '../src/application/catalog.js';
import { KAKAO_COMMISSION_POLICY } from '../src/application/kakao-catalog-reference.js';
import { selectOfferFeeEconomics, precomputeOfferEconomics, refreshOfferEconomicsForChangedInputs } from '../src/application/resolve-offer-commercial-terms.js';
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
  it('applies a reviewed subset with current evidence and blocks source drift atomically', async () => {
    const store=await fixture(),offer=(await store.listOffers())[0]!, now=new Date().toISOString();
    const product=(await store.getProduct(offer.productId))!;
    await store.seed({products:[{...product,commercialType:'USED_RENT'}]});
    offer.priceTerms=[{...offer.priceTerms[0]!,termKey:'m1',termMonths:1},{...offer.priceTerms[0]!,termKey:'m24',termMonths:24}];
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'USED_RENT');
    offer.internalEconomicsTerms[0]!.supplierBillingFee={...offer.internalEconomicsTerms[0]!.supplierBillingFee,state:'UNKNOWN',amount:null};
    const binding={...offer,bindingId:'subset-binding',sourceId:'subset-source',sourceRecordId:'record',sourceFingerprint:'fingerprint',sourceRunId:'subset-run',sourceObservedAt:now,sourceSupplierCode:offer.supplierId,vehicleModelId:product.vehicleModelId,productId:offer.productId,offerId:offer.id};
    const coverage={mode:'FULL' as const,completeness:'COMPLETE' as const}, checkpoint={sourceId:binding.sourceId,observedAt:now,checksum:'checksum'};
    const policy={...offer,id:KAKAO_COMMISSION_POLICY.policyId,kind:'OTHER' as const,version:'test',effectiveFrom:now,facts:structuredClone(KAKAO_COMMISSION_POLICY)};
    await store.seed({offers:[offer],policies:[policy],sourceBindings:[binding],
      sourceDefinitions:[{sourceId:binding.sourceId,kind:'MANUAL',displayName:'test',authorityScope:[],enabled:true,health:'HEALTHY',expectedFreshnessSeconds:600}],
      sourceHeads:[{sourceId:binding.sourceId,runId:binding.sourceRunId,observedAt:now,acceptedAt:now,coverage,checkpoint}],
      sourceRuns:[{sourceId:binding.sourceId,runId:binding.sourceRunId,status:'COMPLETED',startedAt:now,observedAt:now,coverage,checkpoint,headStatus:'CURRENT',rawCount:1,candidateCount:1,warningCount:0}]});
    const evidence={bindingId:binding.bindingId,bindingDigest:stableDigest(binding),runId:binding.sourceRunId,checkpointDigest:stableDigest(checkpoint),policyDigest:stableDigest(KAKAO_COMMISSION_POLICY)};
    const report=await planOfferEconomicsRecompute(store,'memory-test',{feeSubsetsByOffer:{[offer.id]:{termKeys:['m1'],evidence}}});
    expect(report.subsetEvidenceVerified).toBe(true);
    const options={target:'memory-test',apply:true,plan:report.plan,expectedPlanDigest:report.planDigest,policyId:report.plan.policyId,actor,approvalRef:'subset-review'};
    const currentRun=(await store.getSourceRun(binding.sourceRunId))!;
    for (const changedRun of [{...currentRun,coverage:{...coverage,completeness:'INCOMPLETE' as const}},
      {...currentRun,checkpoint:{...checkpoint,checksum:'different-checksum'}}]) {
      await store.seed({sourceRuns:[changedRun]});
      expect((await runOfferEconomicsRecompute(store,options)).status).toBe('HOLD');
      expect(await store.getOffer(offer.id)).toEqual(offer);expect(store.audits).toHaveLength(0);
    }
    await store.seed({sourceRuns:[currentRun]});
    await store.seed({sourceRuns:[{...currentRun,checkpoint:null}],sourceHeads:[{
      sourceId:binding.sourceId,runId:binding.sourceRunId,observedAt:now,acceptedAt:now,coverage,checkpoint:null as never}]});
    await expect(assertOfferFeeSubsetEvidence(store,offer,{...evidence,checkpointDigest:stableDigest(null)},now))
      .rejects.toThrow('FEE_SUBSET_SOURCE_NOT_CURRENT');
    await store.seed({sourceRuns:[currentRun],sourceHeads:[{
      sourceId:binding.sourceId,runId:binding.sourceRunId,observedAt:now,acceptedAt:now,coverage,checkpoint}]});
    await store.seed({sourceHeads:[{sourceId:binding.sourceId,runId:'different-run',observedAt:now,acceptedAt:now,coverage,checkpoint}]});
    const blocked=await runOfferEconomicsRecompute(store,options);
    expect(blocked.status).toBe('HOLD');expect(await store.getOffer(offer.id)).toEqual(offer);expect(store.audits).toHaveLength(0);
    await store.seed({sourceHeads:[{sourceId:binding.sourceId,runId:binding.sourceRunId,observedAt:now,acceptedAt:now,coverage,checkpoint}]});
    const result=await runOfferEconomicsRecompute(store,options);
    expect(result.status).toBe('APPLIED');
    const saved=(await store.getOffer(offer.id))!;
    expect(saved.internalEconomicsTerms![1]).toEqual(offer.internalEconomicsTerms[1]);
    expect(saved.priceTerms).toEqual(offer.priceTerms);
    expect(saved.internalEconomicsTerms![0]!.supplierBillingFee.state).toBe('KNOWN');
  });
  it('subset preserves unselected rows and selected non-fee fields', async () => {
    const store=await fixture(),offer=(await store.listOffers())[0]!;
    offer.priceTerms=[{...offer.priceTerms[0]!,termKey:'m1',termMonths:1},{...offer.priceTerms[0]!,termKey:'m24',termMonths:24}];
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'USED_RENT');
    const before=structuredClone(offer), after=selectOfferFeeEconomics(offer,'USED_RENT',null,['m1']);
    expect(after[1]).toEqual(before.internalEconomicsTerms![1]);
    const {supplierBillingFee:a,channelPayoutFee:b,...rest}=after[0]!;
    const {supplierBillingFee:c,channelPayoutFee:d,...old}=before.internalEconomicsTerms![0]!;
    expect(rest).toEqual(old); expect(offer).toEqual(before);
    expect(a).toEqual(c);expect(b).toEqual(d);
    expect(()=>selectOfferFeeEconomics(offer,'USED_RENT',null,['m1','m1'])).toThrow('KEYS_REQUIRED');
    expect(()=>selectOfferFeeEconomics(offer,'USED_RENT',null,['missing'])).toThrow('STORED_ROW_REQUIRED');
    offer.internalEconomicsTerms[0]!.termMonths=2;
    expect(()=>selectOfferFeeEconomics(offer,'USED_RENT',null,['m1'])).toThrow('PRICE_EVIDENCE_DRIFT');
  });
  it('subset without source evidence remains blocked and never writes', async () => {
    const store=await fixture(),offer=(await store.listOffers())[0]!;
    offer.priceTerms=[{...offer.priceTerms[0]!,termKey:'m1',termMonths:1}];
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'USED_RENT');
    await store.seed({offers:[offer]});
    const report=await planOfferEconomicsRecompute(store,'memory-test',{feeSubsetsByOffer:{[offer.id]:{termKeys:['m1']}}});
    expect(report.subsetEvidenceVerified).toBe(false);
    expect(report.applyBlockers).toEqual([{offerId:offer.id,reason:'FEE_SUBSET_SOURCE_POLICY_EVIDENCE_REQUIRED'}]);
    await expect(runOfferEconomicsRecompute(store,{target:'memory-test',apply:true,plan:report.plan,expectedPlanDigest:report.planDigest,policyId:report.plan.policyId,actor,approvalRef:'review'})).rejects.toThrow('HOLD');
    expect(await store.getOffer(offer.id)).toEqual(offer);expect(store.audits).toHaveLength(0);
  });
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
    expect(typeof KAKAO_COMMISSION_POLICY.oneMonthBasic.sourceRef).toBe('string');
    await store.seed({offers:[JSON.parse(JSON.stringify(offer))]});
    const roundtrip=(await store.getOffer(offer.id))!;
    expect(roundtrip).not.toBe(offer);
    await updateOfferPrice(store,{commandId:'legacy-with-evidence',idempotencyKey:'legacy-with-evidence',offerId:offer.id,expectedRevision:roundtrip.revision,
      termKey:'m1',monthlyRent:{amount:777,currency:'KRW'},reason:'original policy evidence verified',actor});
    expect((await store.getOffer(offer.id))!.internalEconomicsTerms![0]!.supplierBillingFee)
      .toMatchObject({amount:{amount:39},calculation:{kind:'RATE',rate:0.05}});
    expect(roundtrip.internalEconomicsTerms![0]!.supplierBillingFee.calculation!.kind).toBe('FIXED');
  });
  it('refreshes legacy Billin fees without referenceRentBasis when the 36-month reference rent changes', async () => {
    const store=await fixture(), original=(await store.listOffers())[0]!;
    const offer={...original,supplierId:'RP021',priceTerms:[36,60].map(months=>({...original.priceTerms[0]!,termKey:`m${months}`,termMonths:months,monthlyRent:{amount:800000,currency:'KRW' as const}}))};
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'USED_SUBSCRIPTION');
    for (const term of offer.internalEconomicsTerms) for (const side of ['supplierBillingFee','channelPayoutFee'] as const) delete (term[side] as { referenceRentBasis?: unknown }).referenceRentBasis;
    const next=structuredClone(offer);next.priceTerms[0]!.monthlyRent.amount=900000;
    const refreshed=refreshOfferEconomicsForChangedInputs(offer,next,false,'USED_SUBSCRIPTION');
    expect(refreshed.map(term=>term.supplierBillingFee.amount!.amount)).toEqual([900000,900000]);
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
    const addedReference={...offer,priceTerms:[...offer.priceTerms,{...offer.priceTerms[0]!,termKey:'m36-extra',monthlyRent:{amount:900000,currency:'KRW' as const}}]};
    expect(refreshOfferEconomicsForChangedInputs(offer,addedReference,false,'USED_SUBSCRIPTION').find(term=>term.termKey==='m60')!.supplierBillingFee)
      .toMatchObject({state:'UNKNOWN',amount:null,reasonCode:'BILLIN_36_MONTH_RENT_REQUIRED'});
  });
  it('refreshes Sonokong subscription fees when the referenced 12-month Q12 rent changes', async () => {
    const store=await fixture(), original=(await store.listOffers())[0]!;
    const offer={...original,supplierId:'RP012',priceTerms:[
      {...original.priceTerms[0]!,termKey:'12_인수형',termMonths:12,monthlyRent:{amount:800000,currency:'KRW' as const}},
      {...original.priceTerms[0]!,termKey:'24_인수형',termMonths:24,monthlyRent:{amount:700000,currency:'KRW' as const}},
    ]};
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'OGONG_SUBSCRIPTION');
    expect(offer.internalEconomicsTerms[1]!.supplierBillingFee).toMatchObject({
      amount:{amount:900000},referenceRentBasis:{termKey:'12_인수형',termMonths:12,monthlyRent:{amount:800000,currency:'KRW'},multiplier:1}
    });
    expect(offer.internalEconomicsTerms[1]!.channelPayoutFee).toMatchObject({
      amount:{amount:800000},referenceRentBasis:{termKey:'12_인수형',termMonths:12}
    });
    const unchanged=structuredClone(offer);
    unchanged.priceTerms[1]!.monthlyRent.amount=750000;
    expect(refreshOfferEconomicsForChangedInputs(offer,unchanged,false,'OGONG_SUBSCRIPTION')[1]!.supplierBillingFee)
      .toEqual(offer.internalEconomicsTerms[1]!.supplierBillingFee);
    const changed=structuredClone(offer);
    changed.priceTerms[0]!.monthlyRent.amount=900000;
    const refreshed=refreshOfferEconomicsForChangedInputs(offer,changed,false,'OGONG_SUBSCRIPTION');
    expect(refreshed[1]!.supplierBillingFee).toMatchObject({
      amount:{amount:1000000},referenceRentBasis:{termKey:'12_인수형',termMonths:12,monthlyRent:{amount:900000,currency:'KRW'}}
    });
    expect(refreshed[1]!.channelPayoutFee).toMatchObject({
      amount:{amount:900000},referenceRentBasis:{termKey:'12_인수형',termMonths:12,monthlyRent:{amount:900000,currency:'KRW'}}
    });
    const ambiguous=structuredClone(offer);
    ambiguous.priceTerms.push({...ambiguous.priceTerms[0]!,monthlyRent:{amount:900000,currency:'KRW'}});
    expect(refreshOfferEconomicsForChangedInputs(offer,ambiguous,false,'OGONG_SUBSCRIPTION')[1]!.supplierBillingFee)
      .toMatchObject({state:'UNKNOWN',amount:null,reasonCode:'OGONG_12M_BASE_MISSING'});
  });
  it('refreshes Sonokong fees when an explicit BUYOUT reference row with an opaque key changes', async () => {
    const store=await fixture(), original=(await store.listOffers())[0]!;
    const offer={...original,supplierId:'RP012',priceTerms:[
      {...original.priceTerms[0]!,termKey:'q12',termMonths:12,monthlyRent:{amount:800000,currency:'KRW' as const}},
      {...original.priceTerms[0]!,termKey:'q24',termMonths:24,monthlyRent:{amount:700000,currency:'KRW' as const}},
    ]};
    const evidence={q12:{subscriptionForm:'BUYOUT' as const},q24:{subscriptionForm:'BUYOUT' as const}};
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'OGONG_SUBSCRIPTION',null,evidence);
    expect(offer.internalEconomicsTerms[1]!.supplierBillingFee).toMatchObject({
      amount:{amount:900000},referenceRentBasis:{termKey:'q12',termMonths:12,monthlyRent:{amount:800000,currency:'KRW'},multiplier:1}
    });
    expect(offer.internalEconomicsTerms[1]!.channelPayoutFee).toMatchObject({
      amount:{amount:800000},referenceRentBasis:{termKey:'q12',termMonths:12,monthlyRent:{amount:800000,currency:'KRW'},multiplier:1}
    });
    const changed=structuredClone(offer);
    changed.priceTerms[0]!.monthlyRent.amount=900000;
    const refreshed=refreshOfferEconomicsForChangedInputs(offer,changed,false,'OGONG_SUBSCRIPTION',null,undefined,evidence);
    expect(refreshed[1]!.supplierBillingFee).toMatchObject({
      amount:{amount:1000000},referenceRentBasis:{termKey:'q12',termMonths:12,monthlyRent:{amount:900000,currency:'KRW'}}
    });
    expect(refreshed[1]!.channelPayoutFee).toMatchObject({
      amount:{amount:900000},referenceRentBasis:{termKey:'q12',termMonths:12,monthlyRent:{amount:900000,currency:'KRW'}}
    });
    const removed={...structuredClone(offer),priceTerms:offer.priceTerms.filter(term=>term.termKey!=='q12')};
    expect(refreshOfferEconomicsForChangedInputs(offer,removed,false,'OGONG_SUBSCRIPTION',null,undefined,evidence)[0]!.supplierBillingFee)
      .toMatchObject({state:'UNKNOWN',amount:null,reasonCode:'OGONG_12M_BASE_MISSING'});
  });
  it('does not preserve a stored Sonokong Q12 fee when its basis row changed but the target settlement now conflicts', async () => {
    const store=await fixture(), original=(await store.listOffers())[0]!;
    const offer={...original,supplierId:'RP012',priceTerms:[
      {...original.priceTerms[0]!,termKey:'12_인수형',termMonths:12,monthlyRent:{amount:800000,currency:'KRW' as const}},
      {...original.priceTerms[0]!,termKey:'24_인수형',termMonths:24,monthlyRent:{amount:700000,currency:'KRW' as const}},
    ]};
    const evidence={ '12_인수형':{subscriptionForm:'BUYOUT' as const}, '24_인수형':{subscriptionForm:'BUYOUT' as const} };
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'OGONG_SUBSCRIPTION',null,evidence);
    expect(offer.internalEconomicsTerms[1]!.supplierBillingFee)
      .toMatchObject({state:'KNOWN',amount:{amount:900000},referenceRentBasis:{termKey:'12_인수형',termMonths:12}});

    const conflictEvidence={...evidence,'24_인수형':{subscriptionForm:'RETURN' as const}};
    const changed=structuredClone(offer);
    changed.priceTerms[0]!.monthlyRent.amount=900000;
    const changedResult=refreshOfferEconomicsForChangedInputs(offer,changed,false,'OGONG_SUBSCRIPTION',null,undefined,conflictEvidence)[1]!.supplierBillingFee;
    expect(changedResult).toMatchObject({state:'UNKNOWN',amount:null,reasonCode:'SUBSCRIPTION_FORM_CONFLICT'});
    expect(changedResult).not.toEqual(offer.internalEconomicsTerms[1]!.supplierBillingFee);

    const removed={...structuredClone(offer),priceTerms:offer.priceTerms.filter(term=>term.termKey!=='12_인수형')};
    const removedResult=refreshOfferEconomicsForChangedInputs(offer,removed,false,'OGONG_SUBSCRIPTION',null,undefined,conflictEvidence)[0]!.supplierBillingFee;
    expect(removedResult).toMatchObject({state:'UNKNOWN',amount:null,reasonCode:'SUBSCRIPTION_FORM_CONFLICT'});
    expect(removedResult).not.toEqual(offer.internalEconomicsTerms[1]!.supplierBillingFee);
  });
  it('preserves Sonokong buyout fees when an unrelated return Q12 row changes', async () => {
    const store=await fixture(), original=(await store.listOffers())[0]!;
    const offer={...original,supplierId:'RP012',priceTerms:[
      {...original.priceTerms[0]!,termKey:'12_인수형',termMonths:12,monthlyRent:{amount:800000,currency:'KRW' as const}},
      {...original.priceTerms[0]!,termKey:'24_인수형',termMonths:24,monthlyRent:{amount:700000,currency:'KRW' as const}},
    ]};
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'OGONG_SUBSCRIPTION');
    expect(offer.internalEconomicsTerms[1]!.supplierBillingFee).toMatchObject({
      state:'KNOWN',amount:{amount:900000},referenceRentBasis:{termKey:'12_인수형',termMonths:12}
    });
    const next={...structuredClone(offer),priceTerms:[
      ...structuredClone(offer.priceTerms),
      {...original.priceTerms[0]!,termKey:'12',termMonths:12,monthlyRent:{amount:900000,currency:'KRW' as const}},
    ]};
    const refreshed=refreshOfferEconomicsForChangedInputs(offer,next,false,'OGONG_SUBSCRIPTION');
    expect(refreshed.find(term=>term.termKey==='24_인수형')!.supplierBillingFee)
      .toEqual(offer.internalEconomicsTerms[1]!.supplierBillingFee);
    expect(refreshed.find(term=>term.termKey==='24_인수형')!.channelPayoutFee)
      .toEqual(offer.internalEconomicsTerms[1]!.channelPayoutFee);
  });
  it('stores Sonokong pickup and rerent 12-month fixed fees without losing approximate notes', async () => {
    const store=await fixture(), original=(await store.listOffers())[0]!;
    const product=(await store.getProduct(original.productId))!;
    const pickup={...original,supplierId:'RP012',priceTerms:[
      {...original.priceTerms[0]!,termKey:'m12-pickup',termMonths:12,monthlyRent:{amount:600000,currency:'KRW' as const}},
    ]};
    pickup.internalEconomicsTerms=precomputeOfferEconomics(pickup,'PICKUP_SUBSCRIPTION');
    const pickupTerm=pickup.internalEconomicsTerms[0]!;
    expect(pickupTerm.supplierBillingFee).toMatchObject({
      state:'KNOWN',amount:{amount:600000},calculation:{kind:'FIXED',amount:{amount:600000,currency:'KRW'}},
      approximate:true,note:'SONOKONG_PICKUP_TERM_PROXY_RERENT',reasonCode:'SONOKONG_PICKUP_TERM_PROXY_RERENT',
    });
    expect(pickupTerm.channelPayoutFee).toMatchObject({
      state:'KNOWN',amount:{amount:500000},calculation:{kind:'FIXED',amount:{amount:500000,currency:'KRW'}},
      approximate:true,note:'SONOKONG_PICKUP_TERM_PROXY_RERENT',reasonCode:'SONOKONG_PICKUP_TERM_PROXY_RERENT',
    });
    await store.seed({products:[{...product,commercialType:'PICKUP_SUBSCRIPTION'}],offers:[{...pickup,internalEconomicsTerms:[]}]});
    expect(await runOfferEconomicsRecompute(store,await prepare(store))).toMatchObject({status:'APPLIED',changedOffers:1});
    const savedPickup=(await store.getOffer(pickup.id))!.internalEconomicsTerms![0]!;
    expect(savedPickup.supplierBillingFee).toMatchObject({state:'KNOWN',amount:{amount:600000},calculation:{kind:'FIXED'},approximate:true});
    expect(savedPickup.channelPayoutFee).toMatchObject({state:'KNOWN',amount:{amount:500000},calculation:{kind:'FIXED'},approximate:true});
    expect(store.audits).toHaveLength(1);
    const rerentStore=await fixture(), rerentOriginal=(await rerentStore.listOffers())[0]!, rerentProduct=(await rerentStore.getProduct(rerentOriginal.productId))!;
    const rerent={...original,supplierId:'RP012',priceTerms:[
      {...original.priceTerms[0]!,termKey:'m12-rerent',termMonths:12,monthlyRent:{amount:600000,currency:'KRW' as const}},
    ]};
    rerent.internalEconomicsTerms=precomputeOfferEconomics(rerent,'USED_RENT');
    const rerentTerm=rerent.internalEconomicsTerms[0]!;
    expect(rerentTerm.supplierBillingFee).toMatchObject({
      state:'KNOWN',amount:{amount:600000},calculation:{kind:'FIXED',amount:{amount:600000,currency:'KRW'}},
      reasonCode:null,
    });
    expect(rerentTerm.channelPayoutFee).toMatchObject({
      state:'KNOWN',amount:{amount:500000},calculation:{kind:'FIXED',amount:{amount:500000,currency:'KRW'}},
      reasonCode:null,
    });
    expect(rerentTerm.channelPayoutFee).not.toHaveProperty('approximate');
    await rerentStore.seed({products:[{...rerentProduct,commercialType:'USED_RENT'}],
      offers:[{...rerent,productId:rerentOriginal.productId,internalEconomicsTerms:[]}]});
    expect(await runOfferEconomicsRecompute(rerentStore,await prepare(rerentStore))).toMatchObject({status:'APPLIED',changedOffers:1});
    const savedRerent=(await rerentStore.getOffer(rerent.id))!.internalEconomicsTerms![0]!;
    expect(savedRerent.supplierBillingFee).toMatchObject({state:'KNOWN',amount:{amount:600000},calculation:{kind:'FIXED'}});
    expect(savedRerent.channelPayoutFee).toMatchObject({state:'KNOWN',amount:{amount:500000},calculation:{kind:'FIXED'},reasonCode:null});
    expect(savedRerent.channelPayoutFee).not.toHaveProperty('approximate');
    expect(rerentStore.audits).toHaveLength(1);
  });
  it('replaces deprecated RP012 pickup vehicle-price fees but preserves other suppliers vehicle-price fees', async () => {
    const store=await fixture(), original=(await store.listOffers())[0]!;
    const staleVehiclePriceFee = (amount: number) => ({
      state:'KNOWN' as const, amount:{amount,currency:'KRW' as const},
      calculation:{kind:'RATE' as const,base:'VEHICLE_PRICE' as const,rate:amount / 30000000},
      sourceRefs:['test:deprecated-vehicle-price-rule'],
      ruleId:'SONOKONG_PICKUP_12_BILLING_VEHICLE_PRICE',policyId:'test:old-policy',
      vatTreatment:'EXCLUDED' as const,vatAmount:Math.round(amount * 0.1),totalAmount:amount + Math.round(amount * 0.1),
    });
    const pickup={...original,supplierId:'RP012',priceTerms:[
      {...original.priceTerms[0]!,termKey:'m12-pickup',termMonths:12,monthlyRent:{amount:600000,currency:'KRW' as const}},
    ]};
    pickup.internalEconomicsTerms=[{
      termKey:'m12-pickup',termMonths:12,monthlyRent:structuredClone(pickup.priceTerms[0]!.monthlyRent),
      depositCalculation:{state:'UNKNOWN' as const,amount:null,calculation:null,sourceRefs:[],reasonCode:'DEPOSIT_EVIDENCE_REQUIRED'},
      supplierBillingFee:staleVehiclePriceFee(1200000),
      channelPayoutFee:{...staleVehiclePriceFee(900000),ruleId:'SONOKONG_PICKUP_12_PAYOUT_VEHICLE_PRICE'},
    }];
    const recomputed=precomputeOfferEconomics(pickup,'PICKUP_SUBSCRIPTION');
    expect(recomputed[0]!.supplierBillingFee).toMatchObject({
      state:'KNOWN',amount:{amount:600000},calculation:{kind:'FIXED',amount:{amount:600000,currency:'KRW'}},
      approximate:true,note:'SONOKONG_PICKUP_TERM_PROXY_RERENT',
    });
    expect(recomputed[0]!.channelPayoutFee).toMatchObject({
      state:'KNOWN',amount:{amount:500000},calculation:{kind:'FIXED',amount:{amount:500000,currency:'KRW'}},
      approximate:true,note:'SONOKONG_PICKUP_TERM_PROXY_RERENT',
    });
    expect(refreshOfferEconomicsForChangedInputs(pickup,pickup,false,'PICKUP_SUBSCRIPTION')).toEqual(recomputed);

    const otherSupplier={...pickup,supplierId:'RP013'};
    otherSupplier.internalEconomicsTerms=[structuredClone(pickup.internalEconomicsTerms[0]!)];
    expect(precomputeOfferEconomics(otherSupplier,'USED_RENT')[0]!.channelPayoutFee)
      .toEqual(otherSupplier.internalEconomicsTerms[0]!.channelPayoutFee);
    expect(refreshOfferEconomicsForChangedInputs(otherSupplier,otherSupplier,false,'USED_RENT')[0]!.channelPayoutFee)
      .toEqual(otherSupplier.internalEconomicsTerms[0]!.channelPayoutFee);
  });
  it('recomputes reference-required unknown fees when a matching basis row is added', async () => {
    const store=await fixture(), original=(await store.listOffers())[0]!;
    const offer={...original,supplierId:'RP012',priceTerms:[
      {...original.priceTerms[0]!,termKey:'24_인수형',termMonths:24,monthlyRent:{amount:700000,currency:'KRW' as const}},
    ]};
    offer.internalEconomicsTerms=precomputeOfferEconomics(offer,'OGONG_SUBSCRIPTION');
    expect(offer.internalEconomicsTerms[0]!.supplierBillingFee)
      .toMatchObject({state:'UNKNOWN',amount:null,reasonCode:'OGONG_12M_BASE_MISSING'});
    const unchanged=structuredClone(offer);
    expect(refreshOfferEconomicsForChangedInputs(offer,unchanged,false,'OGONG_SUBSCRIPTION')[0]!.supplierBillingFee)
      .toEqual(offer.internalEconomicsTerms[0]!.supplierBillingFee);
    const added={...offer,priceTerms:[
      {...original.priceTerms[0]!,termKey:'12_인수형',termMonths:12,monthlyRent:{amount:800000,currency:'KRW' as const}},
      ...offer.priceTerms,
    ]};
    const refreshed=refreshOfferEconomicsForChangedInputs(offer,added,false,'OGONG_SUBSCRIPTION');
    expect(refreshed.find(term=>term.termKey==='24_인수형')!.supplierBillingFee)
      .toMatchObject({state:'KNOWN',amount:{amount:900000},referenceRentBasis:{termKey:'12_인수형',termMonths:12}});
    expect(refreshed.find(term=>term.termKey==='24_인수형')!.channelPayoutFee)
      .toMatchObject({state:'KNOWN',amount:{amount:800000},referenceRentBasis:{termKey:'12_인수형',termMonths:12}});
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
