import { describe, expect, it, vi } from 'vitest';
import { getSupplierCommissionPolicy, listSupplierCommissionPolicies, KAKAO_COMMISSION_POLICY,
  resolveSalesCommission, explicitNewProductSubtypeFromSource } from '../src/application/kakao-catalog-reference.js';
import { precomputeOfferEconomics } from '../src/application/resolve-offer-commercial-terms.js';
import { planOfferEconomicsRecompute, runOfferEconomicsRecompute } from '../src/jobs/recompute-offer-economics.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { LEGACY_CATALOG_WRITER_OWNERSHIP } from '../src/domain/writer-ownership.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { stableDigest } from '../src/shared/stable-digest.js';

process.env.FREEPASS_SHEET_F04_ID = 'test-sheet-f04';
const actor = { id: 'service:freepass-data', kind: 'SERVICE' as const };
async function fixture() {
  const store = new MemoryDataStore(); await seedDemoCatalog(store);
  const original = (await store.listOffers())[0]!, product = (await store.getProduct(original.productId))!;
  const offers = ['supplier-a-1', 'supplier-a-2', 'supplier-b-1'].map((id, index) => {
    const offer = { ...original, id, supplierId: index < 2 ? 'RP013' : 'RP031',
      priceTerms: [12,24,36,48,60].map(termMonths => ({ ...original.priceTerms[0]!,
        termKey: `m${termMonths}`, termMonths, monthlyRent: { amount: 800000, currency: 'KRW' as const } })) };
    offer.internalEconomicsTerms = precomputeOfferEconomics(offer, 'USED_RENT'); return offer;
  });
  await store.seed({ products: [{ ...product, commercialType: 'USED_RENT' }], offers,
    catalogWriterOwnership: structuredClone(LEGACY_CATALOG_WRITER_OWNERSHIP) });
  return { store, offers };
}

describe('one shared commission policy per supplier', () => {
  it('uses one unique assignment per registered supplier, with existing exception families', () => {
    const policies = listSupplierCommissionPolicies();
    expect(new Set(policies.map(p => p.supplierId)).size).toBe(policies.length);
    expect(getSupplierCommissionPolicy('RP013')).toMatchObject({ basicSubscription: true, standardLadder: true });
    expect(getSupplierCommissionPolicy('RP021')).toMatchObject({ billinSubscription: true });
    expect(getSupplierCommissionPolicy('RP034')).toMatchObject({ group: 'EXCLUDED' });
    expect(getSupplierCommissionPolicy('unknown')).toBeNull();
    expect(policies.every(p => /^[a-f0-9]{64}$/.test(p.digest))).toBe(true);
  });

  it('uses the same approved supplier default in source and Canonical engines, with explicit overrides first', () => {
    expect(explicitNewProductSubtypeFromSource({ product_type: '신차렌트', provider_company_code: 'RP020' }))
      .toBe('NEW_PREDELIVERY');
    expect(resolveSalesCommission({ supplierId: 'RP020', productType: '신차렌트', termMonths: 48,
      monthlyRent: 700000, vehicleValue: 40000000 })).toMatchObject({ state: 'CALCULATED', amount: 1200000 });
    expect(resolveSalesCommission({ supplierId: 'RP020', productType: '신차렌트', newProductSubtype: 'NEW_MATCHING',
      termMonths: 48, monthlyRent: 700000, vehicleValue: 40000000 })).toMatchObject({ state: 'UNKNOWN', reasonCode: 'MATCHING_AGREED_RATE_REQUIRED' });
    expect(resolveSalesCommission({ supplierId: 'RP031', productType: '신차렌트', termMonths: 48,
      monthlyRent: 700000, vehicleValue: 40000000 })).toMatchObject({ state: 'UNKNOWN', reasonCode: 'NEW_PRODUCT_SUBTYPE_REQUIRED' });
  });

  it('applies one policy edit to every selected supplier offer and period, preserving other suppliers and prices', async () => {
    const { store, offers } = await fixture();
    const other = structuredClone(offers[2]!);
    const rule = KAKAO_COMMISSION_POLICY.rules.find(r => r.id === 'STANDARD_RERENT_24_RENT_X_TERM_X_4_PERCENT')! as unknown as { rateBasisPoints: number };
    const old = rule.rateBasisPoints;
    try {
      rule.rateBasisPoints = 410;
      const report = await planOfferEconomicsRecompute(store, 'memory-test', { supplierIds: ['RP013'], onlyChanged: true });
      expect(report.plan.entries.map(e => e.offerId)).toEqual(['supplier-a-1','supplier-a-2']);
      expect(report.suppliers.RP013?.terms).toBe(10);
      expect(report.supplierPolicies).toHaveLength(1);
      const result = await runOfferEconomicsRecompute(store, { target: 'memory-test', apply: true,
        plan: report.plan, expectedPlanDigest: report.planDigest, policyId: report.plan.policyId,
        actor, approvalRef: 'test:supplier-policy-edit' });
      expect(result).toMatchObject({ status: 'APPLIED', changedOffers: 2, readbackVerifiedOffers: 2 });
      for (const offer of offers.slice(0,2)) {
        const saved = (await store.getOffer(offer.id))!;
        expect(saved.priceTerms).toEqual(offer.priceTerms);
        expect(saved.internalEconomicsTerms?.find(t => t.termKey === 'm24')?.channelPayoutFee.amount?.amount).toBe(787200);
        expect(saved.internalEconomicsTerms?.every(t => t.channelPayoutFee.supplierPolicyDigest === getSupplierCommissionPolicy('RP013')!.digest)).toBe(true);
      }
      expect(await store.getOffer(other.id)).toEqual(other);
      const repeat = await planOfferEconomicsRecompute(store, 'memory-test', { supplierIds: ['RP013'], onlyChanged: true });
      expect(repeat.plan.entries).toEqual([]);
    } finally { rule.rateBasisPoints = old; }
  });

  it('rejects empty, duplicate and unregistered supplier scopes before reading or writing', async () => {
    const { store } = await fixture(), read = vi.spyOn(store, 'listOffers');
    for (const supplierIds of [[], ['RP013','RP013'], ['RP999'], [' RP013']])
      await expect(planOfferEconomicsRecompute(store,'memory-test',{ supplierIds })).rejects.toThrow('SUPPLIER_POLICY_SCOPE_INVALID');
    expect(read).not.toHaveBeenCalled();
  });

  it('reads supplier fixed exceptions from the same policy table without a second amount in the engine', () => {
    const rule = KAKAO_COMMISSION_POLICY.rules.find(r => r.id === 'IANCAR_RERENT_6_MONTH_FIXED')! as unknown as { fixedAmount: number };
    const old = rule.fixedAmount;
    try {
      rule.fixedAmount = 310000;
      expect(resolveSalesCommission({ supplierId: 'RP004', productType: '중고렌트', fuel: '가솔린',
        termMonths: 6, monthlyRent: 800000 })).toMatchObject({ state: 'CALCULATED', amount: 310000 });
    } finally { rule.fixedAmount = old; }
  });

  it('freezes supplier scope in the reviewed plan and rejects later policy drift', async () => {
    const { store } = await fixture();
    const report = await planOfferEconomicsRecompute(store,'memory-test',{ supplierIds: ['RP013'] });
    const options = { target: 'memory-test', apply: true, plan: report.plan, expectedPlanDigest: report.planDigest,
      policyId: report.plan.policyId, actor, approvalRef: 'test:scope' };
    await expect(runOfferEconomicsRecompute(store,{ ...options, supplierIds: ['RP031'] })).rejects.toThrow('reviewed plan');
    const tampered = structuredClone(report.plan); tampered.supplierIds = ['RP031'];
    await expect(runOfferEconomicsRecompute(store,{ ...options, plan: tampered, expectedPlanDigest: stableDigest(tampered) })).rejects.toThrow('reviewed plan');
    expect(store.audits).toHaveLength(0);
  });
});
