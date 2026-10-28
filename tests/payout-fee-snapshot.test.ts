import { describe, expect, it } from 'vitest';
import { planPayoutFeeSnapshots, type PayoutFeeEvidence, type PayoutFeeSnapshotDocument } from '../src/application/payout-fee-snapshot.js';
import { applyPayoutFeeSnapshotPlan, parsePayoutFeeEvidence, runPayoutFeeSnapshotJob } from '../src/jobs/snapshot-payout-fees.js';
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

const inferredPlan = (products: Record<string, Record<string, unknown>>, options: {
  inferProductTypeByMileage?: boolean; stockNewAsPredelivery?: boolean; evidence?: PayoutFeeEvidence[];
} = {}) => planPayoutFeeSnapshots({ snapshotDate: '2026-10-28', products, policies: {}, ...options });

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

  it('신차 가격 배열의 높음·중간만 파싱하고 NEW_RENT 일치 차량에만 subtype을 적용한다', () => {
    const evidence = parsePayoutFeeEvidence([
      { plate: 'TEST-RP006', '가격원': 40000000, '확신도': '중간', '근거URL': 'https://example.invalid/a', carName: '테스트', '연식': 2026 },
      { plate: 'LOW', '가격원': 30000000, '확신도': '낮음', '근거URL': 'https://example.invalid/b', carName: '테스트', '연식': 2026 },
    ]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ plate: 'TEST-RP006', confidence: 'medium', vehicleValue: 40000000, newProductSubtype: 'NEW_PREDELIVERY' });
    const result = plan({ newCar: product('RP006', { product_type: '신차렌트' }) }, evidence);
    expect(result.documents[0]!.terms[0]).toMatchObject({ state: 'KNOWN', amount: 1200000 });
    expect(result.evidenceAppliedCounts).toEqual({ vehicleValue: 1, subtype: 1, mewcar: 0 });
    expect(plan({ used: product('RP006') }, evidence).evidenceAppliedCounts.subtype).toBe(0);
  });

  it('비정형 기간 적용 건수를 공급사별로 집계하고 digest가 안정적이다', () => {
    const products = { iron: product('RP006', { price: { '31': { rent: 600000, deposit: 1000000 } } }) };
    const first = plan(products), second = plan(products);
    expect(first.nonstandardTermRuleCounts).toEqual({ RP006: 1 });
    expect(first.documents[0]!.terms[0]!.evidenceRefs).toEqual(expect.arrayContaining(['ledger:59c7c3ba', 'NONSTANDARD_TERM_NEAREST_SHORTER_STANDARD(31→24)']));
    expect(first.planDigest).toBe(second.planDigest);
  });

  it('계획 출력은 역마진 차단 건수를 공급사별로만 집계한다', () => {
    const products = { mew: product('RP035', { product_type: '구독', price: { '12': { rent: 600000, deposit: 1000000 } } }) };
    const result = plan(products, [{ productId: 'mew', confidence: 'high', vehicleValue: 1000000,
      depositPayment: 'PREPAID', extraDeposit: 0 }]);
    expect(result.payoutExceedsBillingCounts).toEqual({ RP035: 1 });
    expect(JSON.stringify(result.payoutExceedsBillingCounts)).not.toContain('mew');
  });

  it('뮤카 선납 0원 추가보증금은 명시 옵션일 때만 기본 증거로 쓴다', async () => {
    const products = { mew: product('RP035', { product_type: '구독', price: { '60': { rent: 600000, deposit: 1000000 } } }) };
    const store: PayoutFeeSnapshotStore = { readInputs: async () => ({ products, policies: {} }), readDocument: async () => null, createDocument: async () => {} };
    const access = { read: async <T>(_spec: unknown, run: () => Promise<T>) => run(), write: async <T>(_spec: unknown, run: () => Promise<T>) => run() };
    const off = await runPayoutFeeSnapshotJob({ store, access, argv: ['--snapshot-date', '2026-10-28'] });
    const on = await runPayoutFeeSnapshotJob({ store, access, argv: ['--snapshot-date', '2026-10-28', '--mewcar-prepaid-default'] });
    expect(off).toMatchObject({ evidenceAppliedCounts: { mewcar: 0 } });
    expect(on).toMatchObject({ evidenceAppliedCounts: { mewcar: 1 } });
    expect(on.planDigest).not.toBe(off.planDigest);
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

  it('추정 옵션을 끄면 생략한 기존 계획과 digest가 동일하다', () => {
    const products = { iancar: product('RP031', { product_type: '', mileage: '1,001 km' }) };
    const baseline = inferredPlan(products);
    const explicitlyOff = inferredPlan(products, { inferProductTypeByMileage: false, stockNewAsPredelivery: false });
    expect(explicitlyOff.planDigest).toBe(baseline.planDigest);
    expect(explicitlyOff.documents).toEqual(baseline.documents);
    expect(explicitlyOff.inferredCounts).toEqual({});
  });

  it('빈 상품유형만 주행거리 1,000 경계로 추정하고 기존 상품유형은 덮지 않는다', () => {
    const result = inferredPlan({
      boundaryNew: product('RP031', { product_type: '', mileage: '1,000' }),
      boundaryUsed: product('RP031', { product_type: '', mileage: '1,001km' }),
      explicitNew: product('RP031', { product_type: '신차렌트', mileage: '9,999' }),
    }, { inferProductTypeByMileage: true });
    const byId = Object.fromEntries(result.documents.map(document => [document.productId, document.terms[0]!]));
    expect(byId.boundaryNew!.evidenceRefs).toContain('INFERRED_PRODUCT_TYPE_BY_MILEAGE');
    expect(byId.boundaryUsed!.evidenceRefs).toContain('INFERRED_PRODUCT_TYPE_BY_MILEAGE');
    expect(byId.explicitNew!.evidenceRefs).not.toContain('INFERRED_PRODUCT_TYPE_BY_MILEAGE');
    expect(byId.boundaryNew!.reasonCode).toBe('NEW_PRODUCT_SUBTYPE_REQUIRED');
    expect(byId.boundaryUsed!.reasonCode).not.toBe('PRODUCT_TYPE_REQUIRED');
    expect(result.inferredCounts.RP031).toEqual({ productType: 2, subtype: 0 });
  });

  it('주행거리가 없거나 해석 불가하면 상품유형을 추정하지 않는다', () => {
    const result = inferredPlan({
      missing: product('RP031', { product_type: '', mileage: undefined }),
      invalid: product('RP031', { product_type: '', mileage: '알 수 없음' }),
    }, { inferProductTypeByMileage: true });
    expect(result.documents.flatMap(document => document.terms).every(term => term.reasonCode === 'PRODUCT_TYPE_REQUIRED')).toBe(true);
    expect(result.documents.flatMap(document => document.terms).every(term => !term.evidenceRefs.includes('INFERRED_PRODUCT_TYPE_BY_MILEAGE'))).toBe(true);
    expect(result.inferredCounts).toEqual({});
  });

  it('선출고 추정은 차량번호 있는 신차만 쓰고 명시 subtype 증거를 우선한다', () => {
    const products = {
      stock: product('RP031', { product_type: '신차렌트' }),
      noPlate: product('RP031', { product_type: '신차렌트', car_number: '' }),
      explicit: product('RP031', { product_type: '신차렌트' }),
    };
    const result = inferredPlan(products, { stockNewAsPredelivery: true, evidence: [
      { productId: 'explicit', confidence: 'high', newProductSubtype: 'NEW_MATCHING' },
    ] });
    const byId = Object.fromEntries(result.documents.map(document => [document.productId, document.terms[0]!]));
    expect(byId.stock!.evidenceRefs).toContain('INFERRED_SUBTYPE_STOCK_NEW_PREDELIVERY');
    expect(byId.noPlate!.evidenceRefs).not.toContain('INFERRED_SUBTYPE_STOCK_NEW_PREDELIVERY');
    expect(byId.noPlate!.reasonCode).toBe('NEW_PRODUCT_SUBTYPE_REQUIRED');
    expect(byId.explicit!.evidenceRefs).not.toContain('INFERRED_SUBTYPE_STOCK_NEW_PREDELIVERY');
    expect(result.inferredCounts.RP031).toEqual({ productType: 0, subtype: 1 });
  });

  it('job의 두 명시 플래그가 계획 출력 inferredCounts에 연결된다', async () => {
    const products = { stock: product('RP031', { product_type: '', mileage: '1,000' }) };
    const store: PayoutFeeSnapshotStore = { readInputs: async () => ({ products, policies: {} }), readDocument: async () => null, createDocument: async () => {} };
    const access = { read: async <T>(_spec: unknown, run: () => Promise<T>) => run(), write: async <T>(_spec: unknown, run: () => Promise<T>) => run() };
    const result = await runPayoutFeeSnapshotJob({ store, access, argv: [
      '--snapshot-date', '2026-10-28', '--infer-product-type-by-mileage', '--stock-new-as-predelivery',
    ] });
    expect(result).toMatchObject({ status: 'PLANNED', inferredCounts: { RP031: { productType: 1, subtype: 1 } } });
  });

  it('이안카 12개월 미만은 추정 옵션으로 풀지 않고 UNKNOWN을 유지한다', () => {
    const result = inferredPlan({ short: product('RP031', {
      product_type: '', mileage: '1,001', price: { '1': { rent: 600000, deposit: 1000000 } },
    }) }, { inferProductTypeByMileage: true, stockNewAsPredelivery: true });
    expect(result.documents[0]!.terms[0]).toMatchObject({ state: 'UNKNOWN', reasonCode: 'IANCAR_SHORT_TERM_BASIS_REQUIRED' });
    expect(result.documents[0]!.terms[0]!.evidenceRefs).toContain('INFERRED_PRODUCT_TYPE_BY_MILEAGE');
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

  // 대표 10-28 «아이카 무보증 50만 전액»: 가격 보증금 0 + 엔진 원천 기록(aica-sheet 장기보증 «무보증»)이면 무보증으로 읽는다.
  const aicaDepositFree = (overrides: Record<string, unknown> = {}) => {
    const at = '2026-10-28T00:30:05.860Z';
    return product('RP004', {
      car_number: '109호0001', status: '출고가능', price: { '48': { rent: 510000, deposit: 0, mileage: '3만km' } },
      source_cycle_write: { by: 'source-engine', at },
      source_cycle_record: { sourceId: 'RP004', uid: '109호0001', plate: '109호0001', observedAt: at,
        status: { raw: '출고가능', saleAvailable: true }, raw: { source: 'aica-sheet', source_tab: '장기특별이벤트' },
        terms: [{ months: 48, mileage: '3만km', monthlyRent: { state: 'KNOWN', value: 510000 }, deposit: { state: 'ZERO', value: 0 },
          raw: { rent: 510000, deposit: '무보증' } }] },
      ...overrides,
    });
  };

  it('아이카 원천 기록이 «무보증»이면 지급 50만(=청구)이고 사다리로 계산하지 않는다', () => {
    const term = plan({ aica: aicaDepositFree() }).documents[0]!.terms[0]!;
    expect(term).toMatchObject({ state: 'KNOWN', amount: 500000, ruleId: 'IANCAR_DEPOSIT_FREE_PAYOUT_EQUALS_BILLING_FIXED' });
    expect(term.computedFrom.deposit?.state).toBe('ZERO');
  });

  it('아이카 원문 장기보증이 금액이거나 엔진 기록이 무보증이 아니면 무보증으로 단정하지 않는다', () => {
    const conflicting = aicaDepositFree({ 원문: { 전체: { 장기보증: '500,000' } } });
    expect(plan({ aica: conflicting }).documents[0]!.terms[0]!.computedFrom.deposit?.state).not.toBe('ZERO');
    const paid: Record<string, unknown> = aicaDepositFree();
    (paid.source_cycle_record as { terms: { raw: Record<string, unknown> }[] }).terms[0]!.raw.deposit = 1000000;
    const term = plan({ aica: paid }).documents[0]!.terms[0]!;
    expect(term.computedFrom.deposit?.state).toBe('UNKNOWN');
    expect(term.ruleId).not.toBe('IANCAR_DEPOSIT_FREE_PAYOUT_EQUALS_BILLING_FIXED');
  });

  it('오토플러스 «오플구독»은 F04 구독 정액(일반 80만·전기 130만)으로 지급하고 청구를 넘지 않는다', () => {
    const result = plan({
      gas: product('RP023', { product_type: '오플구독', price: { '12': { rent: 700000, deposit: 1400000 } } }),
      ev: product('RP023', { product_type: '오플구독', fuel_type: '전기', price: { '24': { rent: 700000, deposit: 1400000 } } }),
      noFuel: product('RP023', { product_type: '오플구독', fuel_type: '', price: { '12': { rent: 700000, deposit: 1400000 } } }),
    });
    const term = (id: string) => result.documents.find(row => row.productId === id)!.terms[0]!;
    expect(term('gas')).toMatchObject({ state: 'KNOWN', amount: 800000, ruleId: 'AUTOPLUS_SUBSCRIPTION_FIXED' });
    expect(term('ev')).toMatchObject({ state: 'KNOWN', amount: 1300000, ruleId: 'AUTOPLUS_EV_SUBSCRIPTION_PAYOUT' });
    expect(term('noFuel')).toMatchObject({ state: 'UNKNOWN', reasonCode: 'FUEL_REQUIRED_FOR_SUPPLIER_RULE' });
    expect(result.payoutExceedsBillingCounts).toEqual({});
  });

  it('오플구독 전기 구독(130만)은 연료가 정확히 «전기»일 때만 — «가솔린+전기»·하이브리드는 일반 구독 80만', () => {
    const sub = (fuel: string) => product('RP023', { product_type: '오플구독', fuel_type: fuel, price: { '24': { rent: 700000, deposit: 1400000 } } });
    const result = plan({ mixed: sub('가솔린+전기'), hybrid: sub('하이브리드'), ev: sub(' 전기 ') });
    const term = (id: string) => result.documents.find(row => row.productId === id)!.terms[0]!;
    expect(term('mixed')).toMatchObject({ state: 'KNOWN', amount: 800000, ruleId: 'AUTOPLUS_SUBSCRIPTION_FIXED' });
    expect(term('hybrid')).toMatchObject({ state: 'KNOWN', amount: 800000, ruleId: 'AUTOPLUS_SUBSCRIPTION_FIXED' });
    expect(term('ev')).toMatchObject({ state: 'KNOWN', amount: 1300000, ruleId: 'AUTOPLUS_EV_SUBSCRIPTION_PAYOUT' });
  });

  it('«오플구독»이 RP023 이 아닌 공급사에 붙으면 중고구독 규칙으로 계산하지 않는다', () => {
    const term = plan({ other: product('RP013', { product_type: '오플구독', price: { '12': { rent: 700000, deposit: 1400000 } } }) })
      .documents[0]!.terms[0]!;
    expect(term).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: 'PRODUCT_TYPE_REQUIRED' });
  });
});
