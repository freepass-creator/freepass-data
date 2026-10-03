import { describe, expect, it } from 'vitest';
import { precomputeOfferEconomics } from '../src/application/resolve-offer-commercial-terms.js';
import {
  KAKAO_COMMISSION_POLICY,
  KAKAO_COMMISSION_POLICY_2026_10_03,
  buildKakaoCatalogReference,
  buildKakaoCatalogReferenceProduct,
  resolveReferenceDeposit,
  resolveExpectedGrossMargin,
  resolveSalesCommission,
  resolveSupplierBillingFee,
  resolveReferenceVehiclePhotos,
} from '../src/application/kakao-catalog-reference.js';

describe('2026-10-04 confirmed commission policy', () => {
  const base = { supplierId: 'RP018', productType: '재렌트', fuel: '가솔린', termMonths: 24, monthlyRent: 1100000 };
  it.each(['RP018', 'RP033'])('%s splits included VAT without changing supplier identity', supplierId => {
    const input = { ...base, supplierId };
    const billing = resolveSupplierBillingFee(input);
    const payout = resolveSalesCommission(input);
    expect(billing).toMatchObject({ amount: 1000000, vatAmount: 100000, totalAmount: 1100000, vatTreatment: 'INCLUDED' });
    expect(payout).toMatchObject({ amount: 800000, vatAmount: 80000, totalAmount: 880000 });
    expect(resolveExpectedGrossMargin(billing, payout).amount).toBe(200000);
    expect(resolveSupplierBillingFee({ ...input, productType: '신차렌트' }).state).toBe('UNKNOWN');
    expect(resolveSupplierBillingFee({ ...input, productType: '신차렌트', newProductSubtype: 'NEW_PREDELIVERY', vehicleValue: 40000000 })).toMatchObject({ amount: 1400000, vatTreatment: 'EXCLUDED' });
    const offer = { id: 'test', supplierId, priceTerms: [{ termKey: '24', termMonths: 24, monthlyRent: { amount: 1100000, currency: 'KRW' as const }, depositState: 'UNKNOWN' as const }] };
    const row = precomputeOfferEconomics(offer, 'USED_RENT')[0]!;
    expect(row.supplierBillingFee).toMatchObject({ state: 'KNOWN', amount: { amount: 1000000 }, vatTreatment: 'INCLUDED', vatAmount: 100000, totalAmount: 1100000, policyId: 'sales-commission-2026-10-04' });
    expect(offer.supplierId).toBe(supplierId);
  });
  it.each([
    ['NEW_PREDELIVERY', 5, 1200000, 1000000],
    ['NEW_PREDELIVERY', 10, 1600000, 1200000],
    ['NEW_MATCHING', 5, 1200000, 1200000],
    ['NEW_MATCHING', 10, 1320000, 1320000],
  ] as const)('Pacific %s tier %s uses vehicle value', (newProductSubtype, depositTierPercent, billing, payout) => {
    const input = { ...base, supplierId: 'RP022', productType: '신차렌트', vehicleValue: 44000000, newProductSubtype, depositTierPercent };
    for (const [actual, total] of [[resolveSupplierBillingFee(input), billing * 11 / 10], [resolveSalesCommission(input), payout * 11 / 10]] as const) {
      expect(actual).toMatchObject({ state: 'CALCULATED', amount: Math.round(total / 1.1), vatAmount: total - Math.round(total / 1.1), totalAmount: total, vatTreatment: 'INCLUDED' });
    }
    const offer = { id: 'pacific', supplierId: 'RP022', priceTerms: [{ termKey: '24', termMonths: 24, monthlyRent: { amount: 1100000, currency: 'KRW' as const }, depositState: 'UNKNOWN' as const }] };
    expect(precomputeOfferEconomics(offer, 'NEW_RENT', '가솔린', { '24': input })[0]!.supplierBillingFee.amount?.amount).toBe(billing);
  });
  it('requires a contractual tier, never infers it from money', () => {
    const input = { ...base, supplierId: 'RP022', productType: '신차렌트', vehicleValue: 40000000, newProductSubtype: 'NEW_PREDELIVERY' as const, depositAmount: 2000000 };
    expect(resolveSupplierBillingFee(input)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'DEPOSIT_TIER_REQUIRED' });
    expect(resolveSalesCommission(input).reasonCode).toBe('DEPOSIT_TIER_REQUIRED');
  });
  it.each([[12, 100000], [24, 300000], [36, 500000], [48, 700000]])('Sonokong %s uses evidenced Q12 plus %s', (termMonths, addition) => {
    const input = { ...base, supplierId: 'RP012', productType: '오공구독', termMonths, subscriptionForm: 'BUYOUT' as const, q12Basis: { amount: 800000, sourceRef: 'verified:Q12' } };
    expect(resolveSupplierBillingFee(input).amount).toBe(800000 + addition);
    expect(resolveSalesCommission(input).amount).toBe(800000);
    const { q12Basis: _basis, ...withoutBasis } = input;
    expect(resolveSupplierBillingFee(withoutBasis)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'Q12_BASIS_REQUIRED' });
    expect(resolveSupplierBillingFee({ ...input, subscriptionForm: 'RETURN' }).state).toBe(termMonths === 12 ? 'CALCULATED' : 'UNKNOWN');
  });
  it('rounds fractional won (F04 practice) and rejects unsupported terms', () => {
    for (const r of [resolveSalesCommission({ ...base, monthlyRent: 1000001 }), resolveSupplierBillingFee({ ...base, supplierId: 'RP013', monthlyRent: 500001 })]) {
      expect(r.state).toBe('CALCULATED');
      expect(Number.isInteger(r.amount) && Number.isInteger(r.vatAmount)).toBe(true);
    }
    expect(resolveSalesCommission({ ...base, supplierId: 'RP013', termMonths: 18 }).reasonCode).toBe('TERM_NOT_IN_F04_COMMISSION_POLICY');
  });
  it('keeps confirmed Iron fees and excludes Mindcar', () => {
    const input = { ...base, supplierId: 'RP006', productType: '신차렌트', vehicleValue: 40000000, newProductSubtype: 'NEW_PREDELIVERY' as const };
    expect(resolveSupplierBillingFee(input).amount).toBe(1600000);
    expect(resolveSalesCommission(input).amount).toBe(1200000);
    expect(resolveSupplierBillingFee({ ...base, supplierId: 'RP034' })).toMatchObject({ state: 'NOT_APPLICABLE', amount: null });
    expect(resolveSalesCommission({ ...base, supplierId: 'RP034' }).state).toBe('NOT_APPLICABLE');
  });
  it('does not generalize unresolved subscription or individual exceptions', () => {
    for (const supplierId of ['RP013', 'RP021', 'PT-0026']) expect(resolveSalesCommission({ ...base, supplierId, productType: '중고구독' }).reasonCode).toBe('SUBSCRIPTION_RULE_SCOPE_UNCONFIRMED');
    expect(resolveSalesCommission({ ...base, supplierId: 'RP023', productType: '오플구독', individualException: true }).reasonCode).toBe('INDIVIDUAL_EXCEPTION_EVIDENCE_REQUIRED');
  });
});

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
      sourceRefs: ['F04:수수료표!A19:M19'],
      ruleId: 'STANDARD_RERENT_36_RENT_X_TERM',
      amount: 864000,
      vatTreatment: 'EXCLUDED',
      vatAmount: 86400,
      totalAmount: 950400,
      reasonCode: null,
    });
  });

  it('requires Q12 evidence without inventing an amount for 영업자 조율', () => {
    expect(resolveSalesCommission({ supplierId: 'RP012', productType: '오공구독', fuel: '디젤', termMonths: 36, monthlyRent: 800000 })).toEqual({
      state: 'UNKNOWN',
      sourceRefs: ['F04:수수료표!A12:M12', 'F04:수수료표!A173:M173', 'F04:수수료표!A191:M191'],
      ruleId: null,
      amount: null,
      vatTreatment: 'UNKNOWN',
      vatAmount: null,
      totalAmount: null,
      reasonCode: 'Q12_BASIS_REQUIRED',
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

  it('fails closed for unknown suppliers and rounds fractional won', () => {
    expect(resolveSalesCommission({ supplierId: 'UNKNOWN', productType: '중고렌트', fuel: '가솔린', termMonths: 36, monthlyRent: 800000 }).state).toBe('UNKNOWN');
    expect(resolveSalesCommission({ supplierId: 'RP013', productType: '중고렌트', fuel: '가솔린', termMonths: 60, monthlyRent: 800001 })).toMatchObject({
      state: 'CALCULATED', amount: 840001, vatAmount: 84000,
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
      const input = { supplierId: 'RP023', productType: '오플구독', fuel: '가솔린', termMonths, monthlyRent: 700000 };
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
    expect(supplierBillingFee).toMatchObject({ state: 'UNKNOWN', reasonCode: 'Q12_BASIS_REQUIRED' });
    expect(resolveExpectedGrossMargin(supplierBillingFee, channelPayoutFee)).toMatchObject({
      state: 'UNKNOWN', amount: null, reasonCode: 'BILLING_OR_PAYOUT_UNRESOLVED',
    });
    expect(resolveSupplierBillingFee({ supplierId: 'RP034', productType: '중고렌트', termMonths: 36, monthlyRent: 800000 })).toMatchObject({
      state: 'NOT_APPLICABLE', reasonCode: 'SUPPLIER_EXCLUDED_BY_DECISION',
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


describe('F04 2026-10-04 alignment regression', () => {
  const base = { supplierId: 'RP023', productType: '구독', fuel: '전기', termMonths: 60, monthlyRent: 200000 };
  const both = (input: Parameters<typeof resolveSalesCommission>[0]) => [resolveSupplierBillingFee(input), resolveSalesCommission(input)];
  const amounts = (input: Parameters<typeof resolveSalesCommission>[0]) => both(input).map(row => row.amount);
  const opaque = 'opaque:synthetic_contract_0001';
  const exception = { sourceRow: 160 as const, status: 'APPROVED' as const, contractRef: opaque, matchedContractRef: opaque, ledgerRow: 413 };
  it('preserves previous policy facts and versions the new authority', () => {
    expect(KAKAO_COMMISSION_POLICY_2026_10_03.policyId).toBe('sales-commission-2026-10-03');
    expect(KAKAO_COMMISSION_POLICY_2026_10_03.sonokongAdditions[60]).toBe(700000);
    expect(KAKAO_COMMISSION_POLICY.policyId).toBe('sales-commission-2026-10-04');
    expect(KAKAO_COMMISSION_POLICY.sourceRole).toBe('F04_GOOGLE_SHEET_SSOT');
  });
  it.each([12,24,36,48,60,84])('1: EV subscription overrides general at %s months', termMonths => {
    expect(amounts({ ...base, termMonths })).toEqual([1500000,1300000]);
    expect(amounts({ ...base, termMonths, fuel: '가솔린' })).toEqual([1000000,800000]);
    expect(both({ ...base, termMonths, fuel: '' }).every(r => r.reasonCode === 'FUEL_REQUIRED_FOR_SUPPLIER_RULE')).toBe(true);
    expect(both({ ...base, termMonths })[0]!.sourceRefs).toContain('F04:수수료표!A161:M161');
  });
  it.each(['픽업구독', '픽업 구독(롯데T카)'])('2: pickup %s uses vehicle value, never rent or Q12', productType => {
    const input = { ...base, supplierId: 'RP012', productType, vehicleValue: 30000000 };
    expect(amounts(input)).toEqual([1200000,900000]);
    expect(amounts({ ...input, monthlyRent: 900000, termMonths: 84 })).toEqual([1200000,900000]);
    expect(both({ ...input, vehicleValue: 0 }).every(r => r.reasonCode === 'VEHICLE_VALUE_REQUIRED')).toBe(true);
  });
  it.each(['RP021','PT-0026'])('3: billin %s only 60 months', supplierId => {
    expect(amounts({ ...base, supplierId })).toEqual([270000,210000]);
    for (const termMonths of [12,24,36,48,20,25,26,28,33,72,84]) expect(both({ ...base, supplierId, termMonths }).every(r => r.state === 'UNKNOWN')).toBe(true);
  });
  it.each(['구독','신차구독','견적출고'])('4: Aica EV excludes %s', productType => {
    expect(both({ ...base, supplierId: 'RP004', productType, vehicleValue: 40000000 }).every(r => r.state === 'UNKNOWN')).toBe(true);
  });
  it.each(['선출고','재렌트','장기렌트'])('4/5: Aica EV includes %s', productType => {
    expect(amounts({ ...base, supplierId: 'RP004', productType })).toEqual([1000000,800000]);
  });
  it('5: aliases follow explicit ERP feeKindOf forms; conflicting subtype fails closed', () => {
    expect(amounts({ ...base, supplierId: 'RP013', productType: '선출고', vehicleValue: 40000000 })).toEqual([1400000,1200000]);
    expect(amounts({ ...base, supplierId: 'RP013', productType: '장기렌트' })).toEqual([270000,210000]);
    expect(resolveSalesCommission({ ...base, supplierId: 'RP013', productType: '견적출고', vehicleValue: 40000000 }).reasonCode).toBe('MATCHING_AGREED_RATE_REQUIRED');
    expect(resolveSalesCommission({ ...base, productType: '선출고', newProductSubtype: 'NEW_MATCHING' }).reasonCode).toBe('CONFLICTING_NEW_PRODUCT_SUBTYPE');
  });
  it('6: complete catalog boundary passes vehicle, tier, subtype and evidenced Q12; missing stays unknown', () => {
    const product = { listable: true, product_type: '신차렌트', provider_company_code: 'RP022', fuel_type: '가솔린', price: { '24_2만': { rent: 200000 } } };
    const sourceBefore = structuredClone(product);
    const evidence = { vehicleValue: 44000000, depositTierPercent: 5 as const, newProductSubtype: 'NEW_PREDELIVERY' as const };
    const response = buildKakaoCatalogReference({ consumerId: 'kakao-ops', observedAt: '2026-10-04', products: { sample: product }, commissionEvidenceByProduct: { sample: { '24_2만': evidence } } });
    expect(response.data[0]!.offers[0]!.priceTerms[0]!.supplierBillingFee.amount).toBe(1200000);
    expect(buildKakaoCatalogReferenceProduct('sample', product)!.offers[0]!.priceTerms[0]!.supplierBillingFee.reasonCode).toBe('DEPOSIT_TIER_REQUIRED');
    const sonokong = { ...product, provider_company_code: 'RP012', product_type: '오공구독' };
    expect(buildKakaoCatalogReferenceProduct('s', sonokong, { '24_2만': { q12Basis: { amount: 800000, sourceRef: 'private:verified-q12' }, subscriptionForm: 'BUYOUT' } })!.offers[0]!.priceTerms[0]!.supplierBillingFee.amount).toBe(1100000);
    expect(buildKakaoCatalogReferenceProduct('s', sonokong)!.offers[0]!.priceTerms[0]!.supplierBillingFee.reasonCode).toBe('Q12_BASIS_REQUIRED');
    expect(product).toEqual(sourceBefore);
    expect(evidence).toEqual({ vehicleValue: 44000000, depositTierPercent: 5, newProductSubtype: 'NEW_PREDELIVERY' });
  });
  it('7: approved 413 uses latest row 160, independent of general 60-month conflict', () => {
    const input = { ...base, supplierId: 'RP012', individualException: true, individualExceptionEvidence: exception };
    const before = structuredClone(input);
    expect(amounts(input)).toEqual([862000,562000]);
    expect(both(input)[0]!.sourceRefs).toEqual(['F04:수수료표!A160:M160']);
    expect(input).toEqual(before);
    for (const changed of [{ matchedContractRef: 'opaque:another_contract_0001' }, { status: 'UNCONFIRMED' as const }, { ledgerRow: 414 }, { contractRef: 'plaintext' }]) {
      expect(both({ ...input, individualExceptionEvidence: { ...exception, ...changed } }).every(r => r.state === 'UNKNOWN')).toBe(true);
    }
    expect(both({ ...input, supplierId: 'RP023' }).every(r => r.state === 'UNKNOWN')).toBe(true);
    expect(both({ ...input, termMonths: 48 }).every(r => r.state === 'UNKNOWN')).toBe(true);
  });
  it.each([466,473,474,475])('7: Aica individual %s payout confirmed, billing unknown even with vehicle input', ledgerRow => {
    const input = { ...base, supplierId: 'RP004', productType: '선출고', vehicleValue: 40000000,
      individualExceptionEvidence: { ...exception, sourceRow: 163 as const, status: 'PAYOUT_CONFIRMED' as const, ledgerRow } };
    expect(resolveSalesCommission(input).amount).toBe(400000);
    expect(resolveSupplierBillingFee(input).reasonCode).toBe('INDIVIDUAL_BILLING_BASIS_UNCONFIRMED');
    expect(resolveSalesCommission({ ...input, productType: '구독' }).state).toBe('UNKNOWN');
  });
  it('8: mindcar stays not applicable, never zero', () => {
    expect(both({ ...base, supplierId: 'RP034' }).every(r => r.state === 'NOT_APPLICABLE' && r.amount === null)).toBe(true);
  });
  it.each([20,25,26,28,33,72,84])('unlisted term %s never interpolates a ladder', termMonths => {
    for (const supplierId of KAKAO_COMMISSION_POLICY.standardSupplierIds) expect(both({ ...base, supplierId, productType: '장기렌트', termMonths }).every(r => r.state === 'UNKNOWN')).toBe(true);
    for (const supplierId of ['RP012','RP014']) expect(both({ ...base, supplierId, termMonths }).every(r => r.state === 'UNKNOWN')).toBe(true);
  });
  it.each(['AMR','오토셀렉션','금탑','빌림','퍼스트','SK'])('unregistered %s remains unknown', supplierId => {
    expect(both({ ...base, supplierId }).every(r => r.reasonCode === 'SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE')).toBe(true);
  });
  it('unconfirmed scopes and general Sonokong 60 remain unknown; Star VAT-included rerent rounds like F04 R402/R420', () => {
    for (const productType of ['신차발주','구독']) expect(both({ ...base, supplierId: 'RP013', productType }).every(r => r.state === 'UNKNOWN')).toBe(true);
    for (const productType of ['신차렌트','재렌트']) expect(both({ ...base, supplierId: 'RP014', productType }).every(r => r.state === 'UNKNOWN')).toBe(true);
    const sonokong = { ...base, supplierId: 'RP012', subscriptionForm: 'BUYOUT' as const, q12Basis: { amount: 800000, sourceRef: 'private:verified-q12' } };
    expect(both(sonokong).every(r => r.reasonCode === 'SONOKONG_60_ADDITION_CONFLICT')).toBe(true);
    expect(both({ ...sonokong, termMonths: 24, subscriptionForm: 'RETURN' }).every(r => r.reasonCode === 'RETURN_SUBSCRIPTION_TERM_NOT_SUPPORTED')).toBe(true);
    // F04 R402 624,000 → 567,273, R420 560,000 → 509,091 (VAT 포함 ÷ 1.1, 원 단위 반올림)
    expect(resolveSupplierBillingFee({ ...base, supplierId: 'RP018', productType: '재렌트', monthlyRent: 624000 })).toMatchObject({ state: 'CALCULATED', amount: 567273, vatAmount: 56727, totalAmount: 624000 });
    expect(resolveSupplierBillingFee({ ...base, supplierId: 'RP018', productType: '재렌트', monthlyRent: 560000 })).toMatchObject({ state: 'CALCULATED', amount: 509091, vatAmount: 50909, totalAmount: 560000 });
    for (const termMonths of [12, 24, 36, 48]) for (const supplierId of ['RP021', 'PT-0026'])
      expect(both({ ...base, supplierId, productType: '구독', termMonths }).every(r => r.state === 'UNKNOWN' && r.reasonCode === 'SUBSCRIPTION_RULE_SCOPE_UNCONFIRMED')).toBe(true);
  });
});

describe('F04 source references and term scope (2026-10-04 review)', () => {
  const F04_REF = /^F04:수수료표!A[1-9][0-9]*:M[1-9][0-9]*$/;
  it('every Kakao commission sourceRef matches the reference schema pattern (no catalog/private refs leak in)', () => {
    const suppliers = ['RP004', 'RP006', 'RP008', 'RP010', 'RP012', 'RP013', 'RP014', 'RP018', 'RP021', 'RP022', 'RP023', 'RP031', 'RP033', 'RP034', 'PT-0026', 'XX-9999'];
    const products = ['신차렌트', '중고렌트', '재렌트', '장기렌트', '선출고', '견적출고', '중고구독', '신차구독', '오공구독', '픽업구독', '신차발주'];
    let checked = 0;
    for (const supplierId of suppliers) for (const productType of products) for (const termMonths of [1, 6, 12, 24, 36, 48, 60, 72])
      for (const r of [resolveSupplierBillingFee, resolveSalesCommission].map((f) => f({ supplierId, productType, fuel: '가솔린', termMonths, monthlyRent: 500000 }))) {
        expect(r.sourceRefs?.length).toBeGreaterThan(0);
        for (const ref of r.sourceRefs ?? []) expect(ref).toMatch(F04_REF);
        checked++;
      }
    expect(checked).toBe(16 * 11 * 8 * 2);
  });
  it('AutoPlus EV subscription is term-independent because F04 row 161 says 「기간 무관」', () => {
    for (const termMonths of [12, 24, 36, 48, 60]) {
      const input = { supplierId: 'RP023', productType: '구독', fuel: '전기', termMonths, monthlyRent: 300000 };
      expect(resolveSupplierBillingFee(input)).toMatchObject({ state: 'CALCULATED', amount: 1500000 });
      expect(resolveSalesCommission(input)).toMatchObject({ state: 'CALCULATED', amount: 1300000 });
      expect(resolveSalesCommission(input).sourceRefs).toContain('F04:수수료표!A161:M161');
    }
  });
});
