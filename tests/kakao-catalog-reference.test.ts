import { describe, expect, it } from 'vitest';
import {
  KAKAO_COMMISSION_POLICY,
  buildKakaoCatalogReference,
  buildKakaoCatalogReferenceProduct,
  resolveReferenceDeposit,
  resolveExpectedGrossMargin,
  resolveSalesCommission,
  resolveSupplierBillingFee,
  resolveReferenceVehiclePhotos,
} from '../src/application/kakao-catalog-reference.js';

describe('Kakao catalog reference deposit facts', () => {
  it.each([
    [12, 900000, 1, 900000],
    [24, 900000, 2, 1800000],
    [60, 900000, 3, 2700000],
  ])('materializes contract-year deposit for %s months', (termMonths, monthlyRent, multiplier, depositAmount) => {
    expect(resolveReferenceDeposit({
      note: '월 대여료 × 약정연수 (최대 3개월)', termMonths, monthlyRent, sourceAmount: 0,
    })).toEqual({
      depositAmount,
      depositState: 'KNOWN',
      depositRule: { code: 'RENT_X_CONTRACT_YEARS_MAX3', multiplier, label: `대여료×${multiplier}` },
    });
  });

  it('does not mistake placeholder zero for zero deposit when a rule calculates an amount', () => {
    expect(resolveReferenceDeposit({
      note: '국산: 월 대여료×2', termMonths: 36, monthlyRent: 800000, sourceAmount: 0,
    })).toEqual({
      depositAmount: 1600000,
      depositState: 'KNOWN',
      depositRule: { code: 'RENT_X_2', multiplier: 2, label: '대여료×2' },
    });
  });

  it('uses the import threshold rule without parsing free-form variants', () => {
    expect(resolveReferenceDeposit({
      note: '수입: 12개월 대여료×3 · 18개월↑ ×6', termMonths: 12, monthlyRent: 1000000, sourceAmount: 0,
    }).depositRule?.multiplier).toBe(3);
    expect(resolveReferenceDeposit({
      note: '수입: 12개월 대여료×3 · 18개월↑ ×6', termMonths: 18, monthlyRent: 1000000, sourceAmount: 0,
    }).depositRule?.multiplier).toBe(6);
  });

  it('emits ZERO only for the explicit no-deposit rule', () => {
    expect(resolveReferenceDeposit({ supplierId: 'RP004', productType: '중고렌트', note: '무보증', termMonths: 60, monthlyRent: 800000, sourceAmount: 0 })).toEqual({
      depositAmount: 0,
      depositState: 'ZERO',
      depositRule: { code: 'ZERO_DEPOSIT', multiplier: 0, label: '무보증' },
    });
    expect(resolveReferenceDeposit({ note: '', termMonths: 60, monthlyRent: 800000, sourceAmount: 0 }).depositState).toBe('UNKNOWN');
    expect(resolveReferenceDeposit({ note: '새 규칙', termMonths: 60, monthlyRent: 800000, sourceAmount: 0 }).depositState).toBe('UNKNOWN');
  });

  it('uses a positive supplier amount only when no rule note exists', () => {
    expect(resolveReferenceDeposit({ note: '', termMonths: 36, monthlyRent: 800000, sourceAmount: '2,500,000' })).toMatchObject({
      depositAmount: 2500000,
      depositState: 'KNOWN',
      depositRule: { code: 'SOURCE_AMOUNT' },
    });
  });
});

describe('Kakao sales commission facts', () => {
  it('calculates verified standard re-rent commission and VAT in won', () => {
    expect(resolveSalesCommission({ supplierId: 'RP013', productType: '중고렌트', fuel: '가솔린', termMonths: 36, monthlyRent: 800000 })).toEqual({
      state: 'CALCULATED',
      ruleId: 'STANDARD_RERENT_36_RENT_X_TERM',
      amount: 864000,
      vatTreatment: 'EXCLUDED',
      vatAmount: 86400,
      totalAmount: 950400,
      reasonCode: null,
    });
  });

  it('returns coordination without an amount for rows marked 영업자 조율', () => {
    expect(resolveSalesCommission({ supplierId: 'RP012', productType: '오공구독', fuel: '디젤', termMonths: 36, monthlyRent: 800000 })).toEqual({
      state: 'COORDINATION_REQUIRED',
      ruleId: 'SONOKONG_SUBSCRIPTION_12_MONTH_RENT_100_PERCENT',
      amount: null,
      vatTreatment: 'EXCLUDED',
      vatAmount: null,
      totalAmount: null,
      reasonCode: 'SALES_COORDINATION_REQUIRED',
    });
  });

  it('applies exact exception supplier IDs before the standard policy', () => {
    expect(resolveSalesCommission({ supplierId: 'RP023', productType: '오플구독', fuel: '가솔린', termMonths: 24, monthlyRent: 700000 })).toMatchObject({
      state: 'CALCULATED', ruleId: 'AUTOPLUS_SUBSCRIPTION_FIXED', amount: 800000, totalAmount: 880000,
    });
    expect(resolveSalesCommission({ supplierId: 'RP004', productType: '중고렌트', fuel: '전기', termMonths: 6, monthlyRent: 700000 })).toMatchObject({
      state: 'CALCULATED', ruleId: 'IANCAR_EV_FIXED', amount: 800000,
    });
  });

  it('fails closed for unknown suppliers and unspecified won rounding', () => {
    expect(resolveSalesCommission({ supplierId: 'UNKNOWN', productType: '중고렌트', fuel: '가솔린', termMonths: 36, monthlyRent: 800000 }).state).toBe('UNKNOWN');
    expect(resolveSalesCommission({ supplierId: 'RP013', productType: '중고렌트', fuel: '가솔린', termMonths: 60, monthlyRent: 800001 })).toMatchObject({
      state: 'UNKNOWN', reasonCode: 'ROUNDING_RULE_UNSPECIFIED', amount: null,
    });
  });
});

describe('Kakao billing, payout and margin facts', () => {
  it('matches the F04 billing/payout ladder for every supplier code that uses the standard re-rent policy', () => {
    const supplierIds = [
      ...KAKAO_COMMISSION_POLICY.standardSupplierIds,
      ...KAKAO_COMMISSION_POLICY.exceptionSupplierIds.sonokong,
      ...KAKAO_COMMISSION_POLICY.exceptionSupplierIds.iancar,
      ...KAKAO_COMMISSION_POLICY.exceptionSupplierIds.iron,
      ...KAKAO_COMMISSION_POLICY.exceptionSupplierIds.pacific,
    ];
    const expected = new Map([
      [12, [600000, 500000]],
      [24, [912000, 768000]],
      [36, [1080000, 864000]],
      [48, [1248000, 960000]],
      [60, [1080000, 840000]],
    ]);
    for (const supplierId of new Set(supplierIds)) {
      for (const [termMonths, [billing, payout]] of expected) {
        const input = { supplierId, productType: '중고렌트', termMonths, monthlyRent: 800000, fuel: '가솔린' };
        expect(resolveSupplierBillingFee(input), `${supplierId}/${termMonths}/billing`).toMatchObject({ state: 'CALCULATED', amount: billing });
        expect(resolveSalesCommission(input), `${supplierId}/${termMonths}/payout`).toMatchObject({ state: 'CALCULATED', amount: payout });
      }
    }
  });

  it.each([
    [12, 600000, 500000, 100000],
    [24, 912000, 768000, 144000],
    [36, 1080000, 864000, 216000],
    [48, 1248000, 960000, 288000],
    [60, 1080000, 840000, 240000],
  ])('calculates both sides and margin from the standard F04 ladder for %s months', (termMonths, billing, payout, margin) => {
    const input = { supplierId: 'RP013', productType: '중고렌트', termMonths, monthlyRent: 800000 };
    const supplierBillingFee = resolveSupplierBillingFee(input);
    const channelPayoutFee = resolveSalesCommission({ ...input, fuel: '가솔린' });
    expect(supplierBillingFee).toMatchObject({ state: 'CALCULATED', amount: billing });
    expect(channelPayoutFee).toMatchObject({ state: 'CALCULATED', amount: payout });
    expect(resolveExpectedGrossMargin(supplierBillingFee, channelPayoutFee)).toMatchObject({ state: 'CALCULATED', amount: margin });
  });

  it('calculates the confirmed Oplus fixed billing, payout and pre-VAT margin for every period', () => {
    for (const termMonths of [12, 24, 36, 48, 60]) {
      const input = { supplierId: 'RP023', productType: '오플구독', termMonths, monthlyRent: 700000 };
      const supplierBillingFee = resolveSupplierBillingFee(input);
      const channelPayoutFee = resolveSalesCommission({ ...input, fuel: '가솔린' });
      expect(supplierBillingFee).toMatchObject({
        state: 'CALCULATED', ruleId: 'AUTOPLUS_SUBSCRIPTION_BILLING_FIXED', amount: 1000000,
        vatAmount: 100000, totalAmount: 1100000,
      });
      expect(channelPayoutFee).toMatchObject({ state: 'CALCULATED', amount: 800000 });
      expect(resolveExpectedGrossMargin(supplierBillingFee, channelPayoutFee)).toEqual({
        state: 'CALCULATED', amount: 200000, currency: 'KRW',
        basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: null,
      });
    }
  });

  it('applies the switch subscription and Iancar fixed exceptions on both sides', () => {
    const switchInput = { supplierId: 'RP014', productType: '중고구독', termMonths: 36, monthlyRent: 800000 };
    expect(resolveSupplierBillingFee(switchInput)).toMatchObject({ state: 'CALCULATED', amount: 1080000 });
    expect(resolveSalesCommission({ ...switchInput, fuel: '가솔린' })).toMatchObject({ state: 'CALCULATED', amount: 864000 });

    const iancarInput = { supplierId: 'RP004', productType: '중고렌트', termMonths: 6, monthlyRent: 700000, fuel: '가솔린' };
    expect(resolveSupplierBillingFee(iancarInput)).toMatchObject({ state: 'CALCULATED', amount: 400000 });
    expect(resolveSalesCommission(iancarInput)).toMatchObject({ state: 'CALCULATED', amount: 300000 });
  });

  it('does not invent margin for human-decided or absent F04 rules', () => {
    const supplierBillingFee = resolveSupplierBillingFee({ supplierId: 'RP012', productType: '오공구독', termMonths: 36, monthlyRent: 800000 });
    const channelPayoutFee = resolveSalesCommission({ supplierId: 'RP012', productType: '오공구독', fuel: '가솔린', termMonths: 36, monthlyRent: 800000 });
    expect(supplierBillingFee).toMatchObject({ state: 'COORDINATION_REQUIRED' });
    expect(resolveExpectedGrossMargin(supplierBillingFee, channelPayoutFee)).toMatchObject({
      state: 'UNKNOWN', amount: null, reasonCode: 'BILLING_OR_PAYOUT_UNRESOLVED',
    });
    expect(resolveSupplierBillingFee({ supplierId: 'RP034', productType: '중고렌트', termMonths: 36, monthlyRent: 800000 })).toMatchObject({
      state: 'UNKNOWN', reasonCode: 'SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE',
    });
  });
});

describe('Kakao typed REFERENCE_ONLY projection', () => {
  const product = {
    listable: true,
    maker: '기아', model: '쏘렌토', trim_name: '시그니처', product_type: '중고렌트',
    provider_company_code: 'RP013', provider_name: '웰릭스모빌리티', car_number: '12가3456',
    fuel_type: '디젤', ext_color: '스노우 화이트 펄', vehicle_status: '출고가능',
    deposit_note: '국산: 월 대여료×2', year: 2026, mileage: 12000,
    price: { '36_3만': { rent: 800000, deposit: 0 } },
  };

  it('preserves supplier photo order and queries without exposing document images', () => {
    const first = 'https://photos.example.test/front.jpg?token=source-token';
    const second = 'https://photos.example.test/interior.jpg';
    expect(resolveReferenceVehiclePhotos({
      image_urls: [first, second, first], photos: JSON.stringify([second], null, 2),
      image_url: 'https://user:password@photos.example.test/private.jpg',
      photo: 'javascript:alert(1)', doc_images: ['https://photos.example.test/registration.jpg'],
      photo_link: 'https://drive.google.com/drive/folders/example',
    })).toEqual({ state: 'URLS_PRESENT', imageUrls: [first, second], representativeUrl: first,
      sourceLinkCount: 1, rejectedCount: 2, accessVerification: 'NOT_CHECKED' });
    expect(buildKakaoCatalogReferenceProduct('photo-product', { ...product, image_urls: [first, second] }))
      .toMatchObject({ vehiclePhotos: { imageUrls: [first, second], representativeUrl: first } });
  });

  it('distinguishes a folder link from directly supplied images and missing evidence', () => {
    expect(resolveReferenceVehiclePhotos({ photo_link: 'https://drive.google.com/drive/folders/example' }))
      .toMatchObject({ state: 'LINK_ONLY', imageUrls: [], representativeUrl: null });
    expect(resolveReferenceVehiclePhotos({ image_urls: '[broken', doc_images: ['https://photos.example.test/document.jpg'] }))
      .toMatchObject({ state: 'UNUSABLE', imageUrls: [], representativeUrl: null, rejectedCount: 1 });
    expect(resolveReferenceVehiclePhotos({ doc_images: ['https://photos.example.test/document.jpg'] }))
      .toMatchObject({ state: 'NOT_PROVIDED', imageUrls: [], representativeUrl: null, rejectedCount: 0 });
  });

  it('adds exterior color, computed deposit and commission to each period', () => {
    expect(buildKakaoCatalogReferenceProduct('doc-1', product)).toMatchObject({
      vehicle: { exteriorColor: '스노우 화이트 펄' },
      offers: [{
        supplierId: 'RP013',
        priceTerms: [{
          termMonths: 36,
          depositAmount: 1600000,
          depositState: 'KNOWN',
          deposit: { amount: 1600000, currency: 'KRW' },
          salesCommission: { state: 'CALCULATED', amount: 864000 },
        }],
      }],
    });
  });

  it('exposes Oplus billing, payout and expected gross margin without depending on the term', () => {
    expect(buildKakaoCatalogReferenceProduct('oplus-1', {
      ...product,
      product_type: '오플구독', provider_company_code: 'RP023', provider_name: '오토플러스',
      price: { '24_2만': { rent: 700000, deposit: 0 }, '36_2만': { rent: 650000, deposit: 0 } },
    })).toMatchObject({
      offers: [{ priceTerms: [
        {
          termMonths: 24,
          supplierBillingFee: { amount: 1000000 },
          channelPayoutFee: { amount: 800000 },
          expectedGrossMargin: { state: 'CALCULATED', amount: 200000 },
        },
        {
          termMonths: 36,
          supplierBillingFee: { amount: 1000000 },
          channelPayoutFee: { amount: 800000 },
          expectedGrossMargin: { state: 'CALCULATED', amount: 200000 },
        },
      ] }],
    });
  });

  it('excludes non-listable source rows and marks the whole response REFERENCE_ONLY/HOLD', () => {
    const response = buildKakaoCatalogReference({
      consumerId: 'kakao-ops',
      observedAt: '2026-09-28T00:00:00.000Z',
      products: { good: product, hidden: { ...product, listable: false } },
    });
    expect(response.data).toHaveLength(1);
    expect(response.meta).toMatchObject({
      authority: 'REFERENCE_ONLY', publicationDecision: 'HOLD', sourceCount: 2, projectedCount: 1,
    });
    expect(response.commissionPolicy.sourceFiles).toHaveLength(1);
    expect(response.commissionPolicy.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
