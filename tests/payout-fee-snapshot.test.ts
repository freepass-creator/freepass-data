import { describe, expect, it } from 'vitest';
import { planPayoutFeeSnapshots, type PayoutFeeEvidence, type PayoutFeeSnapshotDocument } from '../src/application/payout-fee-snapshot.js';
import { applyPayoutFeeSnapshotPlan } from '../src/jobs/snapshot-payout-fees.js';
import type { PayoutFeeSnapshotStore } from '../src/ports/payout-fee-snapshot-store.js';

const product = (supplierId: string, overrides: Record<string, unknown> = {}) => ({
  provider_company_code: supplierId,
  product_type: '재렌트',
  fuel_type: '가솔린',
  listable: true,
  car_number: `TEST-${supplierId}`,
  price: { '36': { rent: 600000, deposit: 1000000 } },
  ...overrides,
});

const plan = (products: Record<string, Record<string, unknown>>, evidence: PayoutFeeEvidence[] = []) =>
  planPayoutFeeSnapshots({ snapshotDate: '2026-10-28', products, policies: {}, evidence });

describe('영업자 지급수수료 박제 계획', () => {
  it('공급사별 KNOWN/UNKNOWN을 집계하고 증거 없음은 UNKNOWN으로 둔다', () => {
    const result = plan({ known: product('RP013'), unknown: product('XX-9999') });
    expect(result.supplierCounts.RP013).toMatchObject({ KNOWN: 1, UNKNOWN: 0 });
    expect(result.supplierCounts['XX-9999']).toMatchObject({ KNOWN: 0, UNKNOWN: 1 });
    expect(result.documents.find(row => row.productId === 'unknown')!.terms[0]).toMatchObject({ state: 'UNKNOWN', amount: null });
  });

  it('confidence가 high가 아닌 차량가액·신차 subtype 증거를 무시한다', () => {
    const products = { newCar: product('RP006', { product_type: '신차렌트' }) };
    const low = plan(products, [{ productId: 'newCar', confidence: 'low', vehicleValue: 40000000,
      newProductSubtype: 'NEW_PREDELIVERY', priceSource: '가짜 가격표', evidenceUrl: 'https://example.invalid/evidence' }]);
    expect(low.documents[0]!.terms[0]).toMatchObject({ state: 'UNKNOWN', amount: null });
    expect(low.documents[0]!.terms[0]!.evidenceRefs).toEqual([]);
    const high = plan(products, [{ productId: 'newCar', confidence: 'high', vehicleValue: 40000000,
      newProductSubtype: 'NEW_PREDELIVERY', priceSource: '가짜 가격표', evidenceUrl: 'https://example.invalid/evidence' }]);
    expect(high.documents[0]!.terms[0]).toMatchObject({ state: 'KNOWN', amount: 1200000 });
  });

  it('뮤카 PREPAID와 과거 계약 INSTALLMENT 지급 규칙 차이를 기존 엔진에서 받는다', () => {
    const products = { mew: product('RP035', { product_type: '구독', price: { '12': { rent: 600000, deposit: 1000000 } } }) };
    const common = { productId: 'mew', confidence: 'high' as const, extraDeposit: 2000000 };
    const prepaid = plan(products, [{ ...common, depositPayment: 'PREPAID' }]);
    const installment = plan(products, [{ ...common, depositPayment: 'INSTALLMENT', contractDate: '2026-10-04' }]);
    expect(prepaid.documents[0]!.terms[0]).toMatchObject({ state: 'KNOWN', ruleId: 'MEWCAR_GA_PREPAID_12_PAYOUT', amount: 1200000 });
    expect(installment.documents[0]!.terms[0]).toMatchObject({ state: 'KNOWN', ruleId: 'MEWCAR_GA_INSTALLMENT_12_PAYOUT', amount: 1000000 });
  });

  it('입력 순서와 재계획에 무관하게 digest가 안정적이며 청구·마진을 출력하지 않는다', () => {
    const products = { b: product('XX-9999'), a: product('RP013') };
    const first = plan(products), second = plan({ a: products.a, b: products.b });
    expect(first.planDigest).toBe(second.planDigest);
    expect(JSON.stringify(first)).not.toMatch(/supplierBillingFee|expectedGrossMargin|margin/i);
  });

  it('같은 날은 동일 digest 문서를 보존하고 충돌은 거부한다', async () => {
    const planned = plan({ one: product('RP013') });
    const documents = new Map<string, PayoutFeeSnapshotDocument>();
    const store: PayoutFeeSnapshotStore = {
      readInputs: async () => ({ products: {}, policies: {} }),
      readDocument: async id => documents.get(id) ?? null,
      createDocument: async (id, document) => { if (documents.has(id)) throw new Error('exists'); documents.set(id, structuredClone(document)); },
    };
    await expect(applyPayoutFeeSnapshotPlan(store, planned)).resolves.toMatchObject({ created: 1, unchanged: 0 });
    await expect(applyPayoutFeeSnapshotPlan(store, planned)).resolves.toMatchObject({ created: 0, unchanged: 1 });
    documents.set('2026-10-28__one', { ...documents.get('2026-10-28__one')!, contentDigest: 'conflict' });
    await expect(applyPayoutFeeSnapshotPlan(store, planned)).rejects.toThrow('PAYOUT_SNAPSHOT_EXISTING_DOCUMENT_CONFLICT');
  });
});
