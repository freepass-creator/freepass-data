import { describe, expect, it } from 'vitest';
import { mapErp5Product, parseErp5PriceKey, resolveErp5Mileage, ERP5_DEFAULT_BASIC_DRIVER_AGE, type Erp5ProductInput } from '../src/adapters/erp5-product-mapping.js';

function fixture(): Erp5ProductInput {
  return {
    projectId: 'freepasserp5', collection: 'products', documentId: 'synthetic-document',
    sourceRevision: 'synthetic-revision', observedAt: '2026-09-21T10:00:00.000Z',
    data: {
      car_number: '000가0000', maker: '합성제조사', model: '합성모델', product_code: 'synthetic-product',
      provider_company_code: 'TEST_SUPPLIER', product_type: '중고렌트', vehicle_status: '출고가능',
      status_kind: '가용', listable: true,
      price: { '24_3만': { rent: '750,000', deposit: '3,000,000' } }
    }
  };
}

describe('ERP5 product mapping preparation', () => {
  it('pins ERP5 provenance and maps a complete explicit term without authorizing writes', () => {
    const result = mapErp5Product(fixture());
    expect(result.status).toBe('MAPPED_FOR_REVIEW');
    expect(result.sourceId).toBe('freepasserp5/firestore/products');
    expect(result.raw.sourceRevision).toBe('synthetic-revision');
    expect(result.canonicalWriteAuthorized).toBe(false);
    expect(result.candidate.sourceRecordId).toBe('synthetic-document');
    expect(result.candidate.priceTerms[0]).toEqual({
      termKey: 'source:24_3만', termMonths: 24, monthlyRent: { amount: 750000, currency: 'KRW' },
      deposit: { amount: 3000000, currency: 'KRW' }, depositState: 'KNOWN', mileageLimitKmPerYear: 30000
    });
    expect(result.fieldSources['priceTerms/source:24_3만']).toEqual(['/data/price/24_3만']);
  });

  it('preserves every original field and never mutates or shares the raw input', () => {
    const input = fixture();
    input.data.supplier_options = 'original optional value';
    input.data.extra_unknown = { original: ['keep', 0, null] };
    const before = structuredClone(input);
    const result = mapErp5Product(input);
    expect(input).toEqual(before);
    expect(result.raw).toEqual(before);
    result.raw.data.model = 'changed only in result';
    expect(input.data.model).toBe('합성모델');
  });

  it.each([
    { projectId: 'freepasserp3' }, { collection: 'catalog_products' }, { documentId: '' },
    { documentId: 'collection/doc' }, { sourceRevision: '' }, { observedAt: '2026-02-30T10:00:00.000Z' },
    { observedAt: '2026-09-21' }, { data: [] }
  ])('rejects invalid source identity/envelope: %j', patch => {
    expect(() => mapErp5Product({ ...fixture(), ...patch })).toThrow('INVALID_ERP5_PRODUCT_ENVELOPE');
  });

  it.each(['미확인', '75만원', '', null, true, [], {}, '1e6', '10.5', -1, 1.2, '1,00', ' 750000 ', '0x10'])('never coerces invalid money %j into a price', value => {
    const input = fixture();
    input.data.price = { '24_3만': { rent: value, deposit: 0 } };
    const result = mapErp5Product(input);
    expect(result.status).toBe('HOLD');
    expect(result.candidate.priceTerms).toEqual([]);
    expect(result.candidate.issues).toContain('INVALID_RENT');
  });

  it.each([0, '0'])('preserves raw zero %j but does not invent waiver evidence', zero => {
    const input = fixture();
    input.data.price = { '24_3만': { rent: zero, deposit: zero } };
    const result = mapErp5Product(input);
    expect(result.candidate.priceTerms[0]!.monthlyRent.amount).toBe(0);
    expect(result.candidate.priceTerms[0]!.depositState).toBe('UNKNOWN');
    expect(result.raw.data.price).toEqual(input.data.price);
  });

  it.each(['', null, '무보증', '미확인', '월요금×3'])('preserves unresolved deposit %j as UNKNOWN and HOLD', deposit => {
    const input = fixture();
    input.data.price = { '24_3만': { rent: 750000, deposit } };
    const result = mapErp5Product(input);
    expect(result.status).toBe('HOLD');
    expect(result.candidate.priceTerms[0]!.depositState).toBe('UNKNOWN');
    expect(result.candidate.priceTerms[0]!.deposit).toBeNull();
    expect(result.raw.data).toEqual(input.data);
  });

  it('keeps the deposit a deposit_note merely explains — the amount is already per term', () => {
    const input = fixture();
    input.data.provider_company_code = 'RP012';
    input.data.price = { '24_3만': { rent: 750000, deposit: 3000000 } };
    input.data.deposit_note = '연수 × 월대여료';
    const result = mapErp5Product(input);
    expect(result.candidate.priceTerms[0]!.depositState).toBe('KNOWN');
    expect(result.candidate.priceTerms[0]!.deposit).toEqual({ amount: 3000000, currency: 'KRW' });
    expect(result.candidate.issues).not.toContain('UNKNOWN_DEPOSIT');
    expect(result.candidate.issues).not.toContain('PRICING_SEMANTICS_REVIEW_REQUIRED:deposit_note');
    // 메모 자체는 원문에 그대로 남는다 — 쓰지 않는 것과 버리는 것은 다르다.
    expect(result.raw.data.deposit_note).toBe('연수 × 월대여료');
  });

  it.each(['offer_terms', 'adapter_pricing', 'rent_variants', 'rentVariants'])('does not flatten %s into a false zero deposit', field => {
    const input = fixture();
    input.data.price = { '24_3만': { rent: 750000, deposit: 0 } };
    input.data[field] = { preserved_rule_or_variant: 'synthetic' };
    const result = mapErp5Product(input);
    expect(result.status).toBe('HOLD');
    expect(result.candidate.priceTerms[0]!.depositState).toBe('UNKNOWN');
    expect(result.raw.data[field]).toEqual(input.data[field]);
    expect(result.candidate.issues).toContain(`PRICING_SEMANTICS_REVIEW_REQUIRED:${field}`);
  });

  it('retains unavailable registered vehicles independently from price and publication readiness', () => {
    const input = fixture();
    input.data.vehicle_status = '출고불가';
    input.data.status_kind = '불가';
    input.data.listable = false;
    input.data.price = {};
    const result = mapErp5Product(input);
    expect(result.status).toBe('HOLD');
    expect(result.raw.documentId).toBe(input.documentId);
    expect(result.inventory).toEqual({ vehicleStatusRaw: '출고불가', statusRaw: null, statusKindRaw: '불가', listableRaw: false });
    expect(result.candidate.vehicleStatusRaw).toBe('출고불가');
    expect(result.candidate.issues).not.toContain('INVENTORY_LISTABLE_CONFLICT');
  });

  it('detects status cache conflict without overwriting facts or inferring SOLD', () => {
    const input = fixture();
    input.data.vehicle_status = '출고불가';
    const result = mapErp5Product(input);
    expect(result.candidate.issues).toContain('INVENTORY_LISTABLE_CONFLICT');
    expect(result.candidate.issues).toContain('INVENTORY_STATUS_KIND_CONFLICT');
    expect(result.inventory.listableRaw).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SOLD');
  });

  it.each([
    ['SON_NO_KONG', '000하0000', '중고렌트', 'USED_RENT'],
    ['SON_NO_KONG', '000가0000', '오공구독', 'OGONG_SUBSCRIPTION'],
    ['TCAR_EXTERNAL', '000가0000', '픽업구독', 'PICKUP_SUBSCRIPTION']
  ])('keeps RP012 supplier and %s product axes separate', (bucket, plate, type, expected) => {
    const input = fixture();
    Object.assign(input.data, { provider_company_code: 'RP012', source_bucket: bucket, car_number: plate, product_type: type });
    const result = mapErp5Product(input);
    expect(result.candidate.providerCompanyCode).toBe('RP012');
    expect(result.candidate.commercialType).toBe(expected);
    expect(result.candidate.issues.filter(x => x.startsWith('SONOGONG'))).toEqual([]);
  });

  it('trusts product_type when no bucket exists, and still refuses to repair a conflict when one does', () => {
    const input = fixture();
    input.data.provider_company_code = 'RP012';
    // 원천에 source_bucket이 더는 없다. 없는 증거를 기다리면 RP012 전량이 멈춘다.
    expect(mapErp5Product(input).candidate.issues).not.toContain('SONOGONG_CLASSIFICATION_EVIDENCE_MISSING');
    input.data.source_bucket = 'TCAR_EXTERNAL';
    const result = mapErp5Product(input);
    expect(result.candidate.commercialType).toBe('USED_RENT');
    expect(result.candidate.issues).toContain('SONOGONG_CLASSIFICATION_CONFLICT');
  });

  it('recognizes explicit RP023 Oplus evidence but holds the missing canonical contract extension', () => {
    const input = fixture();
    Object.assign(input.data, { provider_company_code: 'RP023', product_type: '오플구독' });
    const result = mapErp5Product(input);
    expect(result.status).toBe('HOLD');
    expect(result.candidate.commercialType).toBe('OPLUS_SUBSCRIPTION');
    expect(result.candidate.issues).toContain('CATALOG_COMMERCIAL_TYPE_EXTENSION_REQUIRED');
    expect(result.candidate.issues).not.toContain('UNKNOWN_PRODUCT_TYPE');
    expect(result.candidate.issues).not.toContain('SUBSCRIPTION_SUPPLIER_REVIEW_REQUIRED');
  });

  it('does not accept an Oplus label from a supplier other than RP023', () => {
    const input = fixture();
    input.data.product_type = '오플구독';
    const result = mapErp5Product(input);
    expect(result.candidate.commercialType).toBe('OPLUS_SUBSCRIPTION');
    expect(result.candidate.issues).toContain('SUBSCRIPTION_SUPPLIER_REVIEW_REQUIRED');
  });

  it.each(['SONOGONG', 'sonogong', 'rp012'])('does not let alias %s bypass RP012 evidence checks', supplier => {
    const input = fixture();
    input.data.provider_company_code = supplier;
    const result = mapErp5Product(input);
    expect(result.status).toBe('HOLD');
    expect(result.candidate.issues).toContain('SUPPLIER_ALIAS_REVIEW_REQUIRED');
    expect(result.candidate.providerCompanyCode).toBe(supplier);
  });

  it.each(['UNKNOWN', '000가', '000가0000 extra', ''])('holds invalid plate %j without rewriting it', plate => {
    const input = fixture();
    input.data.car_number = plate;
    const result = mapErp5Product(input);
    expect(result.status).toBe('HOLD');
    expect(result.candidate.issues).toContain('INVALID_PLATE');
    expect(result.raw.data.car_number).toBe(plate);
  });

  it('does not collapse annual mileage variants or lose unsupported acquisition terms', () => {
    const input = fixture();
    input.data.price = {
      '24_2만': { rent: 700000, deposit: 0 }, '24_3만': { rent: 750000, deposit: 0 },
      '24_buy': { rent: 900000, deposit: 0 }
    };
    const result = mapErp5Product(input);
    expect(result.status).toBe('HOLD');
    expect(result.candidate.priceTerms.map(x => x.termKey)).toEqual(['source:24_2만', 'source:24_3만']);
    expect(result.candidate.issues).toContain('UNSUPPORTED_PRICE_KEY');
    expect(result.raw.data.price).toEqual(input.data.price);
  });

  it('falls back to the company default mileage but never passes it off as source truth', () => {
    const input = fixture();
    input.data.price = { '24': { rent: 750000, deposit: 0 } };
    input.data.partner_code = 'different-supplier';
    const result = mapErp5Product(input);
    expect(result.candidate.priceTerms[0]!.mileageLimitKmPerYear).toBe(30000);
    // 기본값으로 떨어졌다는 사실 자체가 증거로 남아야 한다.
    expect(result.candidate.issues).toContain('MILEAGE_FROM_COMPANY_DEFAULT');
    expect(result.candidate.issues).toContain('SUPPLIER_ALIAS_REVIEW_REQUIRED');
  });

  it('reads mileage from the policy when the price key does not carry one', () => {
    const input = fixture();
    input.data.price = { '24': { rent: 750000, deposit: 0 } };
    input.data.policy_code = 'P-1';
    input.data.provider_company_code = 'RP012';
    const result = mapErp5Product(input, {
      policies: [{ policyCode: 'P-1', companyId: 'RP012', annualMileageKm: 20000 }]
    });
    expect(result.candidate.priceTerms[0]!.mileageLimitKmPerYear).toBe(20000);
    expect(result.candidate.issues).not.toContain('MILEAGE_FROM_COMPANY_DEFAULT');
  });

  it('flags a policy code that resolves to another company rather than using it', () => {
    const input = fixture();
    input.data.policy_code = 'P-1';
    input.data.provider_company_code = 'RP012';
    const result = mapErp5Product(input, {
      policies: [{ policyCode: 'P-1', companyId: 'RP023', annualMileageKm: 20000 }]
    });
    expect(result.candidate.issues).toContain('POLICY_LINK_COMPANY_MISMATCH');
  });

  it('links to its own company when the same policy code exists for several companies', () => {
    const input = fixture();
    input.data.price = { '24': { rent: '750,000', deposit: '3,000,000' } };
    input.data.policy_code = 'P-1';
    input.data.provider_company_code = 'RP012';
    const result = mapErp5Product(input, {
      policies: [
        { policyCode: 'P-1', companyId: 'RP023', annualMileageKm: 20000 },
        { policyCode: 'P-1', companyId: 'RP012', annualMileageKm: 30000 },
      ]
    });
    expect(result.candidate.issues).not.toContain('POLICY_LINK_COMPANY_MISMATCH');
    expect(result.candidate.issues).not.toContain('POLICY_LINK_AMBIGUOUS');
    expect(result.candidate.priceTerms[0]!.mileageLimitKmPerYear).toBe(30000);
  });

  it('prefers its own company over a company-less policy with the same code, whatever the order', () => {
    const input = fixture();
    input.data.price = { '24': { rent: '750,000', deposit: '3,000,000' } };
    input.data.policy_code = 'P-1';
    input.data.provider_company_code = 'RP012';
    const result = mapErp5Product(input, {
      policies: [
        { policyCode: 'P-1', annualMileageKm: 20000 },
        { policyCode: 'P-1', companyId: 'RP012', annualMileageKm: 30000 },
      ]
    });
    expect(result.candidate.issues.filter(issue => issue.startsWith('POLICY_LINK_'))).toEqual([]);
    expect(result.candidate.priceTerms[0]!.mileageLimitKmPerYear).toBe(30000);
  });

  it('uses no policy mileage when the link is ambiguous', () => {
    const input = fixture();
    input.data.price = { '24': { rent: '750,000', deposit: '3,000,000' } };
    input.data.policy_code = 'P-1';
    input.data.provider_company_code = 'RP012';
    const result = mapErp5Product(input, {
      policies: [{ policyCode: 'P-1', annualMileageKm: 20000 }, { policyCode: 'P-1', annualMileageKm: 25000 }]
    });
    expect(result.candidate.issues).toContain('POLICY_LINK_AMBIGUOUS');
    expect(result.candidate.issues).toContain('MILEAGE_FROM_COMPANY_DEFAULT');
    expect([20000, 25000]).not.toContain(result.candidate.priceTerms[0]!.mileageLimitKmPerYear);
  });

  it('flags two policies with the same code for the same company as ambiguous', () => {
    const input = fixture();
    input.data.policy_code = 'P-1';
    input.data.provider_company_code = 'RP012';
    const result = mapErp5Product(input, {
      policies: [{ policyCode: 'P-1', companyId: 'RP012' }, { policyCode: 'P-1', companyId: 'RP012' }]
    });
    expect(result.candidate.issues).toContain('POLICY_LINK_AMBIGUOUS');
    expect(result.candidate.issues).not.toContain('POLICY_LINK_COMPANY_MISMATCH');
  });

  it('flags a policy code that resolves to nothing at all', () => {
    const input = fixture();
    input.data.policy_code = 'P-없음';
    const result = mapErp5Product(input, { policies: [{ policyCode: 'P-1', companyId: 'RP012' }] });
    expect(result.candidate.issues).toContain('POLICY_LINK_NOT_FOUND');
  });

  it('accepts a buyout term but marks it as a separate product', () => {
    const input = fixture();
    input.data.price = { '36_인수형': { rent: 750000, deposit: 0 } };
    const result = mapErp5Product(input);
    expect(result.candidate.priceTerms[0]!.termMonths).toBe(36);
    expect(result.candidate.issues).toContain('BUYOUT_PRODUCT_SEPARATION_REQUIRED');
    expect(result.candidate.issues).not.toContain('UNSUPPORTED_PRICE_KEY');
  });

  it.each(['fee', 'commission', 'fee_memo'])('preserves %s privately and does not infer ZERO from a partial public price', field => {
    const input = fixture();
    input.data.price = { '24_3만': { rent: 750000, deposit: 0, [field]: 'synthetic private pricing fact' } };
    const result = mapErp5Product(input);
    expect(result.status).toBe('HOLD');
    expect(result.candidate.issues).toContain('PRIVATE_PRICE_TERMS_REVIEW_REQUIRED');
    expect(result.candidate.priceTerms[0]!.depositState).toBe('UNKNOWN');
    expect(JSON.stringify(result.candidate)).not.toContain('synthetic private pricing fact');
    expect(result.raw.data).toEqual(input.data);
  });

  it('requires the missing Catalog commercial-type contract even with matching source evidence', () => {
    const input = fixture();
    Object.assign(input.data, { provider_company_code: 'RP012', source_bucket: 'SON_NO_KONG', product_type: '오공구독' });
    const result = mapErp5Product(input);
    expect(result.status).toBe('HOLD');
    expect(result.candidate.commercialType).toBe('OGONG_SUBSCRIPTION');
    expect(result.candidate.issues).toContain('CATALOG_COMMERCIAL_TYPE_EXTENSION_REQUIRED');
  });

  it.each(['Deleted', 'DELETED', ' deleted '])('retains deletion marker %j and requires review', status => {
    const input = fixture();
    input.data.status = status;
    const result = mapErp5Product(input);
    expect(result.candidate.issues).toContain('DELETION_MARKER_REVIEW_REQUIRED');
    expect(result.inventory.statusRaw).toBe(status);
  });

  it('can map unavailable facts for review while never authorizing their publication', () => {
    const input = fixture();
    Object.assign(input.data, { vehicle_status: '출고불가', status_kind: '불가', listable: false });
    const result = mapErp5Product(input);
    expect(result.status).toBe('MAPPED_FOR_REVIEW');
    expect(result.inventory.listableRaw).toBe(false);
    expect(result.canonicalWriteAuthorized).toBe(false);
  });

  it.each([{ currency: 'USD' }, { pricing_rules: 'synthetic extra rule' }])('holds unsupported monetary meaning %j', extra => {
    const input = fixture();
    Object.assign(input.data, extra);
    expect(mapErp5Product(input).status).toBe('HOLD');
  });

  it('fingerprints stable raw content rather than source labels or field insertion order', () => {
    const input = fixture();
    const result = mapErp5Product(input);
    input.data = Object.fromEntries(Object.entries(input.data).reverse());
    expect(mapErp5Product(input).candidate.sourceFingerprint).toBe(result.candidate.sourceFingerprint);
    input.data.options = 'new original option';
    expect(mapErp5Product(input).candidate.sourceFingerprint).not.toBe(result.candidate.sourceFingerprint);
  });

  it('rejects SDK objects and undefined rather than silently dropping raw fields', () => {
    expect(() => mapErp5Product({ ...fixture(), data: { price: undefined } })).toThrow();
    expect(() => mapErp5Product({ ...fixture(), data: { when: new Date() } })).toThrow();
  });
});

describe('주행거리 사슬', () => {
  const 정책 = (policyCode: string, companyId: string, annualMileageKm?: number) =>
    (annualMileageKm === undefined ? { policyCode, companyId } : { policyCode, companyId, annualMileageKm });

  it('가격 키에 적혀 있으면 그것이 우선이다', () => {
    const r = resolveErp5Mileage(20000, 'P-1', 'RP012', [정책('P-1', 'RP012', 30000)]);
    expect(r).toEqual({ km: 20000, source: 'PRICE_KEY' });
  });

  it('키에 없으면 그 차의 정책을 읽는다', () => {
    const r = resolveErp5Mileage(undefined, 'P-1', 'RP012', [정책('P-1', 'RP012', 20000)]);
    expect(r).toEqual({ km: 20000, source: 'POLICY_CODE' });
  });

  it('코드가 맞아도 회사가 다르면 그 정책을 쓰지 않는다', () => {
    const r = resolveErp5Mileage(undefined, 'P-1', 'RP012', [정책('P-1', 'RP023', 20000)]);
    expect(r.source).toBe('DEFAULT');
  });

  it('정책 코드가 없고 회사 정책이 하나뿐이면 그것을 쓴다', () => {
    const r = resolveErp5Mileage(undefined, undefined, 'RP032', [
      정책('P-9', 'RP032', 25000), 정책('P-1', 'RP012', 20000)
    ]);
    expect(r).toEqual({ km: 25000, source: 'COMPANY_SOLE_POLICY' });
  });

  it('회사 정책이 둘 이상이면 고르지 않는다 — 추측하지 않는다', () => {
    const r = resolveErp5Mileage(undefined, undefined, 'RP012', [
      정책('P-1', 'RP012', 20000), 정책('P-2', 'RP012', 30000)
    ]);
    expect(r.source).toBe('DEFAULT');
  });

  it('아무것도 없으면 3만km가 기본이다', () => {
    expect(resolveErp5Mileage(undefined, undefined, undefined, [])).toEqual({ km: 30000, source: 'DEFAULT' });
    expect(ERP5_DEFAULT_BASIC_DRIVER_AGE).toBe(26);
  });
});

describe('가격 키 읽기', () => {
  it('기간만 있는 키', () => {
    expect(parseErp5PriceKey('36')).toEqual({ months: 36, settlement: 'RETURN' });
  });
  it('주행거리가 붙은 키', () => {
    expect(parseErp5PriceKey('24_2만')).toEqual({ months: 24, mileageKm: 20000, settlement: 'RETURN' });
    expect(parseErp5PriceKey('12_3만')).toEqual({ months: 12, mileageKm: 30000, settlement: 'RETURN' });
  });
  it('인수형은 별도 상품이므로 정산 방식으로 갈라 둔다', () => {
    expect(parseErp5PriceKey('36_인수형')).toEqual({ months: 36, settlement: 'BUYOUT' });
    expect(parseErp5PriceKey('12_인수형')).toEqual({ months: 12, settlement: 'BUYOUT' });
  });
  it('모르는 꼴은 지어내지 않는다', () => {
    for (const bad of ['', '0', '월정액', '36_', '_2만', '36_2', 'abc', '36_0만']) {
      expect(parseErp5PriceKey(bad)).toBeUndefined();
    }
  });

  it('derives RP012 subscription deposits from the supplier rule note when the stored deposit is the 0 placeholder (read-time only)', () => {
    const input = fixture();
    Object.assign(input.data, {
      provider_company_code: 'RP012', product_type: '픽업구독', deposit_note: '월 대여료 × 약정연수 (최대 3개월)',
      price: { '12': { rent: 1262000, deposit: 0 }, '24': { rent: 994000, deposit: 0 }, '48': { rent: 809000, deposit: 0 } },
    });
    const result = mapErp5Product(input);
    const byKey = Object.fromEntries(result.candidate.priceTerms.map(t => [t.termMonths, t]));
    expect(byKey[12]).toMatchObject({ deposit: { amount: 1262000 }, depositState: 'KNOWN' });
    expect(byKey[24]).toMatchObject({ deposit: { amount: 1988000 }, depositState: 'KNOWN' });
    expect(byKey[48]).toMatchObject({ deposit: { amount: 2427000 }, depositState: 'KNOWN' });
    expect(result.candidate.issues).not.toContain('UNKNOWN_DEPOSIT');
    // 원문 보증금이 «정확히 0» 이 아니면(칸 없음·null·빈 문자열) 계산하지 않는다 — 누락은 UNKNOWN 유지
    for (const deposit of [undefined, null, '', ' ', 'x']) {
      const missing = fixture();
      Object.assign(missing.data, { provider_company_code: 'RP012', product_type: '픽업구독', deposit_note: '월 대여료 × 약정연수 (최대 3개월)',
        price: { '24': deposit === undefined ? { rent: 1000000 } : { rent: 1000000, deposit } } });
      const expected = deposit === ' ' || deposit === 'x'
        ? { deposit: null, depositState: 'UNKNOWN' }
        : { deposit: { amount: 2000000 }, depositState: 'KNOWN' };
      expect(mapErp5Product(missing).candidate.priceTerms[0]).toMatchObject(expected);
    }
    // 글자 '0' 도 자리표시자 0 으로 본다
    const stringZero = fixture();
    Object.assign(stringZero.data, { provider_company_code: 'RP012', product_type: '픽업구독', deposit_note: '월 대여료 × 약정연수 (최대 3개월)', price: { '24': { rent: 1000000, deposit: '0' } } });
    expect(mapErp5Product(stringZero).candidate.priceTerms[0]).toMatchObject({ deposit: { amount: 2000000 }, depositState: 'KNOWN' });
    // without the rule note the placeholder stays unresolved
    delete (input.data as Record<string, unknown>).deposit_note;
    expect(mapErp5Product(input).candidate.priceTerms[0]).toMatchObject({ deposit: null, depositState: 'UNKNOWN' });
  });

  it('uses the same supplier rule derivation as the reference and compatibility paths', () => {
    const domestic = fixture();
    Object.assign(domestic.data, {
      provider_company_code: 'RP012', product_type: '픽업구독', deposit_note: '국산: 월 대여료×2',
      price: { '24': { rent: 1000000, deposit: 0 } },
    });
    expect(mapErp5Product(domestic).candidate.priceTerms[0]).toMatchObject({ deposit: { amount: 2000000 }, depositState: 'KNOWN' });

    const years = fixture();
    Object.assign(years.data, {
      provider_company_code: 'RP012', product_type: '픽업구독', deposit_note: '월 대여료 × 약정연수 (최대 3개월)',
      price: { '24': { rent: 1000000, deposit: 0 } },
    });
    expect(mapErp5Product(years).candidate.priceTerms[0]).toMatchObject({ deposit: { amount: 2000000 }, depositState: 'KNOWN' });
  });
});

describe('explicit monthly and yearly price keys', () => {
  const keys=[...[1,3,5].flatMap(m=>[2000,3000,4000].map(k=>`${m}_월${k}km`)),...[12,24,36,48,60].flatMap(m=>[20000,30000,40000].map(k=>`${m}_연${k}km`))];
  it.each(keys)('parses actual key %s without annualizing monthly mileage', key => {
    const parsed=parseErp5PriceKey(key)!;expect(parsed).toBeDefined();expect(parsed.months).toBe(Number(key.split('_')[0]));
    expect(parsed.contractedMileage!.period).toBe(key.includes('월')?'month':'year');
    expect(parsed.contractedMileage!.km).toBe(Number(key.split('_')[1]!.slice(1,-2)));
    expect(parsed.mileageKm).toBe(key.includes('월')?undefined:parsed.contractedMileage!.km);
  });
  it('keeps monthly RAW under HOLD where canonical V1 cannot represent it',()=>{
    const input=fixture();input.data.price={'1_월2000km':{rent:500000,deposit:1000000}};
    const result=mapErp5Product(input);expect(result.status).toBe('HOLD');expect(result.raw.data.price).toEqual(input.data.price);
    expect(result.candidate.priceTerms).toEqual([]);
  });
  it.each(['72_연20000km','0_월2000km','1_월0km','1_월-1km','1_월2000.5km','12_연20000','9007199254740992_연20000km'])('rejects malformed explicit key %s',key=>expect(parseErp5PriceKey(key)).toBeUndefined());
});
