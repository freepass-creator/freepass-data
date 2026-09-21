import { describe, expect, it } from 'vitest';
import { mapErp5Product, type Erp5ProductInput } from '../src/adapters/erp5-product-mapping.js';

function fixture(): Erp5ProductInput {
  return {
    projectId: 'freepasserp5', collection: 'products', documentId: 'synthetic-document',
    sourceRevision: 'synthetic-revision', observedAt: '2026-09-21T10:00:00.000Z',
    data: {
      car_number: '12가3456', maker: '합성제조사', model: '합성모델', product_code: 'synthetic-product',
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

  it.each([0, '0'])('preserves explicit numeric zero %j without guessing missing values', zero => {
    const input = fixture();
    input.data.price = { '24_3만': { rent: zero, deposit: zero } };
    const result = mapErp5Product(input);
    expect(result.candidate.priceTerms[0]!.monthlyRent.amount).toBe(0);
    expect(result.candidate.priceTerms[0]!.depositState).toBe('ZERO');
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

  it.each(['deposit_note', 'offer_terms', 'adapter_pricing', 'rent_variants', 'rentVariants'])('does not flatten %s into a false zero deposit', field => {
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
    ['SON_NO_KONG', '12하3456', '중고렌트', 'USED_RENT'],
    ['SON_NO_KONG', '12가3456', '오공구독', 'OGONG_SUBSCRIPTION'],
    ['TCAR_EXTERNAL', '12가3456', '픽업구독', 'PICKUP_SUBSCRIPTION']
  ])('keeps RP012 supplier and %s product axes separate', (bucket, plate, type, expected) => {
    const input = fixture();
    Object.assign(input.data, { provider_company_code: 'RP012', source_bucket: bucket, car_number: plate, product_type: type });
    const result = mapErp5Product(input);
    expect(result.candidate.providerCompanyCode).toBe('RP012');
    expect(result.candidate.commercialType).toBe(expected);
    expect(result.candidate.issues.filter(x => x.startsWith('SONOGONG'))).toEqual([]);
  });

  it('does not invent a Sonogong bucket or silently repair a commercial type conflict', () => {
    const input = fixture();
    input.data.provider_company_code = 'RP012';
    expect(mapErp5Product(input).candidate.issues).toContain('SONOGONG_CLASSIFICATION_EVIDENCE_MISSING');
    input.data.source_bucket = 'TCAR_EXTERNAL';
    const result = mapErp5Product(input);
    expect(result.candidate.commercialType).toBe('USED_RENT');
    expect(result.candidate.issues).toContain('SONOGONG_CLASSIFICATION_CONFLICT');
  });

  it.each(['SONOGONG', 'sonogong', 'rp012'])('does not let alias %s bypass RP012 evidence checks', supplier => {
    const input = fixture();
    input.data.provider_company_code = supplier;
    const result = mapErp5Product(input);
    expect(result.status).toBe('HOLD');
    expect(result.candidate.issues).toContain('SUPPLIER_ALIAS_REVIEW_REQUIRED');
    expect(result.candidate.providerCompanyCode).toBe(supplier);
  });

  it.each(['UNKNOWN', '12가', '12가3456 extra', ''])('holds invalid plate %j without rewriting it', plate => {
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

  it('does not guess missing annual mileage, policy links or supplier aliases', () => {
    const input = fixture();
    input.data.price = { '24': { rent: 750000, deposit: 0 } };
    input.data.policy_code = 'synthetic-policy';
    input.data.partner_code = 'different-supplier';
    const result = mapErp5Product(input);
    expect(result.candidate.issues).toEqual(expect.arrayContaining([
      'UNKNOWN_MILEAGE_LIMIT', 'POLICY_LINK_REVIEW_REQUIRED', 'SUPPLIER_ALIAS_REVIEW_REQUIRED'
    ]));
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
