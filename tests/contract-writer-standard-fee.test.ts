import { describe, expect, it } from 'vitest';
import {
  buildKakaoCatalogReferenceProduct, explicitNewProductSubtypeFromSource, getSupplierCommissionPolicy, KAKAO_COMMISSION_POLICY,
  resolveExpectedGrossMargin, resolveSalesCommission, resolveSupplierBillingFee,
} from '../src/application/kakao-catalog-reference.js';
import { precomputeOfferEconomics } from '../src/application/resolve-offer-commercial-terms.js';

// 대표 10-28 «우리가 계약서 써주는 업체는 우리 표준 수수료 적용하면 돼 심플하게» — 기본 회사 8곳은 공급사별 특칙 없이 표준표.
const basic = KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.basicSupplierIds;
const ledger = KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.contractWriterStandard.sourceRef;

describe('기본 회사 표준 수수료표(대표 10-28)', () => {
  it('지급은 표준표 그대로: 1개월 5%·12개월 50만·24 4%·36 3%·48 2.5%·60 1.75%·신차 선출고 차량가격 3%', () => {
    for (const supplierId of basic) {
      const pay = (termMonths: number) => resolveSalesCommission({ supplierId, productType: '중고렌트', termMonths, monthlyRent: 1000000 }).amount;
      expect([1, 12, 24, 36, 48, 60].map(pay)).toEqual([50000, 500000, 960000, 1080000, 1200000, 1050000]);
      expect(resolveSalesCommission({ supplierId, productType: '신차렌트', termMonths: 48, monthlyRent: 700000, vehicleValue: 40000000 }))
        .toMatchObject({ state: 'CALCULATED', amount: 1200000 });
    }
  });

  it('출고 방식이 적히지 않은 신차렌트는 선출고로 읽고, 견적출고 명시는 그대로 합의 요율 필요', () => {
    for (const supplierId of basic) {
      expect(getSupplierCommissionPolicy(supplierId)!.newRentDefaultSubtype).toBe('NEW_PREDELIVERY');
      expect(explicitNewProductSubtypeFromSource({ product_type: '신차렌트', provider_company_code: supplierId })).toBe('NEW_PREDELIVERY');
      expect(resolveSalesCommission({ supplierId, productType: '신차렌트', newProductSubtype: 'NEW_MATCHING', termMonths: 48, monthlyRent: 700000, vehicleValue: 40000000 }))
        .toMatchObject({ state: 'UNKNOWN', reasonCode: 'MATCHING_AGREED_RATE_REQUIRED' });
    }
    for (const supplierId of basic) for (const fee of [resolveSalesCommission, resolveSupplierBillingFee])
      expect(fee({ supplierId, productType: '신차렌트', termMonths: 48, monthlyRent: 700000, vehicleValue: 40000000 }).sourceRefs).toContain(ledger);
    // 원천 투영 경로(기본값이 이미 채워져 넘어옴)에서도 같은 근거 표시가 붙는다.
    const projected = buildKakaoCatalogReferenceProduct('synthetic', { listable: true, provider_company_code: 'RP013', product_type: '신차렌트',
      car_number: '12가3456', price: { '48': { rent: 700000 } } }, { '48': { vehicleValue: 40000000 } })!.offers[0]!.priceTerms[0]!;
    expect(projected.supplierBillingFee).toMatchObject({ state: 'CALCULATED', amount: 1400000 });
    expect(projected.supplierBillingFee.sourceRefs).toContain(ledger);
    expect(resolveSalesCommission({ supplierId: 'RP008', productType: '신차렌트', newProductSubtype: 'NEW_PREDELIVERY', termMonths: 48, monthlyRent: 700000, vehicleValue: 40000000 }).sourceRefs).not.toContain(ledger);
  });

  it('차량가격이 없으면 그대로 UNKNOWN(VEHICLE_VALUE_REQUIRED) — 가격을 만들지 않는다', () => {
    for (const supplierId of basic) for (const fee of [resolveSalesCommission, resolveSupplierBillingFee])
      expect(fee({ supplierId, productType: '신차렌트', termMonths: 36, monthlyRent: 700000 })).toMatchObject({ state: 'UNKNOWN', reasonCode: 'VEHICLE_VALUE_REQUIRED' });
  });

  it('표에 없는 2~11개월은 그대로 UNKNOWN, 웰릭스 발주도 그대로', () => {
    for (const supplierId of basic) for (const fee of [resolveSalesCommission, resolveSupplierBillingFee])
      expect(fee({ supplierId, productType: '중고렌트', termMonths: 6, monthlyRent: 700000 })).toMatchObject({ state: 'UNKNOWN', reasonCode: 'TERM_NOT_IN_F04_COMMISSION_POLICY' });
    expect(resolveSalesCommission({ supplierId: 'RP013', productType: '발주', termMonths: 36, monthlyRent: 700000 })).toMatchObject({ reasonCode: 'WELRIX_ORDER_RULE_UNCONFIRMED' });
  });

  it('비정형 기간은 청구도 지급처럼 가까운 짧은 표준 기간 — 청구 ≥ 지급 유지', () => {
    for (const supplierId of basic) for (const productType of ['중고렌트', '중고구독']) {
      const input = { supplierId, productType, termMonths: 31, monthlyRent: 1000000 };
      const billing = resolveSupplierBillingFee(input), payout = resolveSalesCommission(input);
      expect(billing).toMatchObject({ state: 'CALCULATED', amount: 1472500, note: 'NONSTANDARD_TERM_NEAREST_SHORTER_STANDARD(31→24)' });
      expect(billing.sourceRefs).toContain(ledger);
      expect(payout).toMatchObject({ state: 'CALCULATED', amount: 1240000 });
      expect(resolveExpectedGrossMargin(billing, payout).amount).toBe(232500);
    }
  });

  it('역마진 가드(지급 ≤ 청구)는 그대로 — 기본 회사의 모든 표준 기간에서 지급이 청구를 넘지 않는다', () => {
    for (const supplierId of basic) {
      const offer = { id: `std:${supplierId}`, supplierId, priceTerms: [1, 12, 19, 24, 31, 36, 48, 60].map(termMonths => ({
        termKey: `t${termMonths}`, termMonths, monthlyRent: { amount: 300000, currency: 'KRW' as const }, depositState: 'UNKNOWN' as const })) };
      for (const row of precomputeOfferEconomics(offer as never, 'USED_RENT')) {
        expect(row.channelPayoutFee.reasonCode, `${supplierId} ${row.termKey}`).not.toBe('PAYOUT_EXCEEDS_BILLING');
        expect(row.channelPayoutFee.amount!.amount).toBeLessThanOrEqual(row.supplierBillingFee.amount!.amount);
      }
    }
  });

  it('기본 회사가 아닌 공급사의 특칙·UNKNOWN 은 바뀌지 않는다', () => {
    expect(getSupplierCommissionPolicy('RP008')!.newRentDefaultSubtype).toBeNull();
    expect(resolveSalesCommission({ supplierId: 'RP008', productType: '신차렌트', termMonths: 48, monthlyRent: 700000, vehicleValue: 40000000 }))
      .toMatchObject({ state: 'UNKNOWN', reasonCode: 'NEW_PRODUCT_SUBTYPE_REQUIRED' });
    expect(resolveSupplierBillingFee({ supplierId: 'RP017', productType: '중고렌트', termMonths: 31, monthlyRent: 1000000 }))
      .toMatchObject({ state: 'UNKNOWN', reasonCode: 'TERM_NOT_IN_F04_COMMISSION_POLICY' });
    expect(getSupplierCommissionPolicy('RP008')).not.toHaveProperty('contractWriterStandard');
  });
});
