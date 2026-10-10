import { describe, expect, it } from 'vitest';
import { assessDepositEvidence, auditDepositEvidence, depositFromYearsRuleNote, depositStatusLabel, resolveDepositByRuleNote } from '../src/domain/deposit-evidence.js';
import { buildKakaoCatalogReferenceProduct, resolveReferenceDeposit } from '../src/application/kakao-catalog-reference.js';
import { withCompatibilityDepositEvidence } from '../src/infra/erp5-compat-catalog-reader.js';

describe('deposit evidence never promotes a placeholder to waiver', () => {
  it('compatibility derives per-rate state without changing storage or unrelated fields', () => {
    const product = { provider_company_code: 'RP004', product_type: '중고렌트', model: 'synthetic',
      price: { '12': { rent: 500000, deposit: '미확인', depositState: 'ZERO' }, '24': { rent: 400000, deposit: '1,000,000' } } };
    const before = structuredClone(product);
    const result = withCompatibilityDepositEvidence(product);
    expect(result.price).toMatchObject({ '12': { rent: 500000, deposit: null, depositState: 'UNKNOWN', depositStatusLabel: '미확인' },
      '24': { rent: 400000, deposit: 1000000, depositState: 'KNOWN' } });
    expect(product).toEqual(before); expect(result.model).toBe('synthetic');
    const zero = { ...product, deposit_note: '무보증', price: { '12': { rent: 500000, deposit: 0 } } };
    expect(withCompatibilityDepositEvidence(zero).price).toMatchObject({ '12': { deposit: 0, depositState: 'ZERO' } });
    expect(withCompatibilityDepositEvidence({ ...zero, provider_company_code: 'RP012' }).price)
      .toMatchObject({ '12': { deposit: null, depositState: 'UNKNOWN' } });
    expect(withCompatibilityDepositEvidence({ ...zero, price: { '12': { rent: 500000, deposit: null } } }).price)
      .toMatchObject({ '12': { deposit: null, depositState: 'UNKNOWN' } });
  });
  it.each([undefined, null, ''])('requires an observed amount even when waiver flags exist: %j', sourceAmount => {
    expect(assessDepositEvidence({ supplierId: 'RP004', productType: '중고렌트', note: '무보증', depositFree: true, sourceAmount }))
      .toMatchObject({ state: 'UNKNOWN', amount: null, reason: 'MISSING_DEPOSIT_AMOUNT' });
  });
  it('labels all unresolved evidence as requiring confirmation', () => {
    expect(depositStatusLabel('UNKNOWN', null)).toBe('미확인');
    expect(depositStatusLabel('UNKNOWN', '')).toBe('미확인');
    expect(depositStatusLabel('UNKNOWN', 0)).toBe('미확인');
    expect(depositStatusLabel('UNKNOWN', null, '대여료×2')).toBe('미확인');
    expect(depositStatusLabel('ZERO', 0, '무보증')).toBe('무보증');
  });
  it.each(['1,500,000원', '150만', '1500000.5', -500000, true, {}, ' 0 '])('holds malformed nonempty amount %j even with an explicit waiver', sourceAmount => {
    expect(assessDepositEvidence({ supplierId: 'RP004', productType: '중고렌트', note: '무보증', sourceAmount }).state).toBe('UNKNOWN');
  });
  it('requires source identity to allow an explicit waiver and normalizes only policy guard comparisons', () => {
    expect(assessDepositEvidence({ note: '무보증', sourceAmount: 0 }).state).toBe('UNKNOWN');
    expect(assessDepositEvidence({ supplierId: ' RP012 ', productType: '중고구독', note: '무보증', sourceAmount: 0 }).state).toBe('UNKNOWN');
    expect(assessDepositEvidence({ supplierId: 'RP004', productType: '픽업 구독', note: '무보증', sourceAmount: 0 }).state).toBe('UNKNOWN');
  });
  it('does not silently override positive amounts with a formula; used rental preserves its ERP amount', () => {
    const facts = { supplierId: 'RP023', productType: '오플구독', note: '국산: 월 대여료×2', sourceAmount: 3000000, monthlyRent: 500000, termMonths: 24 };
    expect(resolveReferenceDeposit(facts).depositState).toBe('UNKNOWN');
    expect(assessDepositEvidence(facts).state).toBe('UNKNOWN');
    expect(resolveReferenceDeposit({ ...facts, supplierId: 'RP012', productType: '중고렌트' })).toMatchObject({ depositState: 'KNOWN', depositAmount: 3000000 });
    expect(resolveReferenceDeposit({ ...facts, supplierId: 'RP012', productType: '중고렌트', note: '월 대여료 × 약정연수 (최대 3개월)', sourceAmount: 0 }).depositState).toBe('UNKNOWN');
    expect(resolveReferenceDeposit({ ...facts, note: '국산: 월 대여료×2', sourceAmount: '150만' }).depositState).toBe('UNKNOWN');
    expect(resolveReferenceDeposit({ ...facts, note: '월 대여료 × 약정연수 (최대 3개월)', sourceAmount: 0, termMonths: 6 }).depositState).toBe('UNKNOWN');
  });
  it('does not ignore malformed positive sibling evidence under a product waiver', () => {
    const product = buildKakaoCatalogReferenceProduct('P2', { listable: true, provider_company_code: 'RP004', product_type: '중고렌트', deposit_note: '무보증',
      price: { '12': { rent: 500000, deposit: 0 }, '24': { rent: 400000, deposit: '150만' } } });
    expect(product!.offers[0]!.priceTerms.every(row => row.depositState === 'UNKNOWN' && row.depositStatusLabel === '미확인')).toBe(true);
    const rentlessSibling = buildKakaoCatalogReferenceProduct('P3', { listable: true, provider_company_code: 'RP004', product_type: '중고렌트', deposit_note: '무보증',
      price: { '12': { rent: 500000, deposit: 0 }, '24': { deposit: 1000000 } } });
    expect(rentlessSibling!.offers[0]!.priceTerms[0]).toMatchObject({ depositState: 'UNKNOWN', depositStatusLabel: '미확인' });
  });
  it.each(['중고렌트', '재렌트', '오공구독', '픽업구독'])('prohibits zero for Sonogong %s, even with a contradictory explicit flag', productType => {
    for (const note of ['', '무보증', '월 대여료 × 약정연수 (최대 3개월)']) {
      expect(assessDepositEvidence({ supplierId: 'RP012', productType, note, depositFree: true, sourceAmount: 0 }).state).toBe('UNKNOWN');
      expect(resolveReferenceDeposit({ supplierId: 'RP012', productType, note: '무보증', sourceAmount: 0, termMonths: 12, monthlyRent: 900000 }).depositState).toBe('UNKNOWN');
    }
  });
  it.each([0, '0', null, undefined, '', true, -1, '미확인'])('does not infer ZERO from %j without an explicit waiver', sourceAmount => {
    expect(assessDepositEvidence({ sourceAmount }).state).toBe('UNKNOWN');
  });
  it('preserves a legitimate explicit waiver but holds contradictory positive evidence', () => {
    const identity = { supplierId: 'RP004', productType: '중고렌트' };
    expect(assessDepositEvidence({ ...identity, note: '무보증', sourceAmount: 0 }).state).toBe('ZERO');
    for (const patch of [{ note: '무보증', sourceAmount: 1000000 },
      { note: '무보증', sourceAmount: 0, hasPositivePaidDeposit: true },
      { note: '국산: 월 대여료×2', depositFree: true, sourceAmount: 0 },
      { note: '무보증', depositFree: false, sourceAmount: 0 }]) {
      expect(assessDepositEvidence({ ...identity, ...patch })).toMatchObject({ state: 'UNKNOWN', reason: 'CONFLICTING_ZERO_DEPOSIT_EVIDENCE' });
    }
  });
  it('does not erase a known positive source amount for a nonzero product', () => {
    expect(assessDepositEvidence({ supplierId: 'RP012', productType: '중고렌트', sourceAmount: '1,500,000' })).toMatchObject({ state: 'KNOWN', amount: 1500000 });
  });
  it('holds a whole-product waiver conflicting with any paid term', () => {
    const result = buildKakaoCatalogReferenceProduct('P1', { listable: true, provider_company_code: 'RP004', product_type: '중고렌트',
      deposit_note: '무보증', price: { '12': { rent: 800000, deposit: 0 }, '24': { rent: 700000, deposit: 1400000 } } });
    expect(result!.offers[0]!.priceTerms.every(row => row.depositState === 'UNKNOWN')).toBe(true);
  });
  it('audits inactive records too, preserving originals and term identity', () => {
    const products = { A: { listable: true, provider_company_code: 'RP012', product_type: '픽업구독', price: { '12': { rent: 900000, deposit: 0 } } },
      B: { listable: false, provider_company_code: 'RP004', product_type: '중고렌트', deposit_note: '무보증', price: { '24': { rent: 500000, deposit: 0 } } },
      C: { price: { '12': { rent: 600000, deposit: 1200000 }, '24': { rent: 0, deposit: 0 } } } };
    const before = structuredClone(products);
    expect(auditDepositEvidence(products)).toMatchObject({ productCount: 3, paidTermCount: 3, counts: { KNOWN: 1, ZERO: 1, UNKNOWN: 1 }, writeAuthorized: false });
    expect(products).toEqual(before);
  });

  it('derives the RP012 subscription deposit from the supplier note rule (1 / 2 / 3 months of rent, capped at 3), never from a zero placeholder', () => {
    const note = '월 대여료 × 약정연수 (최대 3개월)';
    expect(depositFromYearsRuleNote(note, 12, 1000000)).toEqual({ amount: 1000000, multiplier: 1 });
    expect(depositFromYearsRuleNote(note, 24, 994000)).toEqual({ amount: 1988000, multiplier: 2 });
    for (const months of [36, 48, 60]) expect(depositFromYearsRuleNote(note, months, 800000)).toEqual({ amount: 2400000, multiplier: 3 });
    expect(depositFromYearsRuleNote(note, 18, 1000000)).toBeNull();
    expect(depositFromYearsRuleNote(note, 24, 0)).toBeNull();
    expect(depositFromYearsRuleNote('대여료×2', 24, 1000000)).toBeNull();
    expect(depositFromYearsRuleNote(undefined, 24, 1000000)).toBeNull();
    // the placeholder 0 itself stays UNKNOWN in the evidence layer (derivation is a separate, explicit step)
    expect(assessDepositEvidence({ supplierId: 'RP012', productType: '픽업구독', note, sourceAmount: 0 }).state).toBe('UNKNOWN');
  });

  it.each(['픽업구독', '오공구독'])('compatibility derives RP012 %s deposits from the shared supplier years rule note', productType => {
    const product = { provider_company_code: 'RP012', product_type: productType, deposit_note: '월 대여료 × 약정연수 (최대 3개월)',
      price: Object.fromEntries([12, 24, 36, 48, 60].map(months => [String(months), { rent: 100000, deposit: 0 }])) };
    const result = withCompatibilityDepositEvidence(product).price as Record<string, Record<string, unknown>>;
    expect([12, 24, 36, 48, 60].map(months => [months, result[String(months)]!.deposit, result[String(months)]!.depositState, result[String(months)]!.depositEvidenceReason]))
      .toEqual([
        [12, 100000, 'KNOWN', 'SUPPLIER_RULE_NOTE:RENT_X_CONTRACT_YEARS_MAX3'],
        [24, 200000, 'KNOWN', 'SUPPLIER_RULE_NOTE:RENT_X_CONTRACT_YEARS_MAX3'],
        [36, 300000, 'KNOWN', 'SUPPLIER_RULE_NOTE:RENT_X_CONTRACT_YEARS_MAX3'],
        [48, 300000, 'KNOWN', 'SUPPLIER_RULE_NOTE:RENT_X_CONTRACT_YEARS_MAX3'],
        [60, 300000, 'KNOWN', 'SUPPLIER_RULE_NOTE:RENT_X_CONTRACT_YEARS_MAX3'],
      ]);
  });

  it.each(['중고렌트 ', ' 중고렌트', '재렌트'])('keeps RP012 used-rent whitespace variants out of rule derivation: %s', productType => {
    const row = (withCompatibilityDepositEvidence({ provider_company_code: ' RP012 ', product_type: productType, deposit_note: '국산: 월 대여료×2',
      price: { '24': { rent: 800000, deposit: 0 } } }).price as Record<string, Record<string, unknown>>)['24']!;
    expect(row).toMatchObject({ deposit: null, depositState: 'UNKNOWN', depositEvidenceReason: 'ZERO_DEPOSIT_FORBIDDEN_BY_PRODUCT_POLICY' });
  });

  it('keeps the compatibility guide paths unchanged for non-RP012 rules, missing evidence, waivers, and Iancar', () => {
    const rent = 123456;
    const compat = (withCompatibilityDepositEvidence({ provider_company_code: 'RP023', product_type: '오플구독', deposit_note: '국산: 월 대여료×2',
      price: { '24': { rent, deposit: 0 } } }).price as Record<string, Record<string, unknown>>)['24']!;
    const reference = resolveReferenceDeposit({ supplierId: 'RP023', productType: '오플구독', note: '국산: 월 대여료×2', termMonths: 24, monthlyRent: rent, sourceAmount: 0 });
    const rule = resolveDepositByRuleNote({ note: '국산: 월 대여료×2', termMonths: 24, monthlyRent: rent });
    expect(rule).toMatchObject({ state: 'KNOWN', multiplier: 2 });
    expect(compat).toMatchObject({ deposit: reference.depositAmount, depositState: reference.depositState });
    expect(compat.depositEvidenceReason).toBe(`SUPPLIER_RULE_NOTE:${reference.depositRule!.code}`);

    const zero = withCompatibilityDepositEvidence({ provider_company_code: 'RP004', product_type: '중고렌트', deposit_note: '무보증',
      price: { '12': { rent: 100000, deposit: 0 } } }).price as Record<string, Record<string, unknown>>;
    expect(zero['12']).toMatchObject({ deposit: 0, depositState: 'ZERO', depositEvidenceReason: 'EXPLICIT_ZERO_DEPOSIT' });
    const iancar = withCompatibilityDepositEvidence({ provider_company_code: 'RP031', product_type: '중고렌트', deposit_note: '국산: 월 대여료×2',
      price: { '12': { rent: 100000, deposit: 0 } } }).price as Record<string, Record<string, unknown>>;
    expect(iancar['12']).toMatchObject({ deposit: null, depositState: 'UNKNOWN', depositEvidenceReason: 'IANCAR_PUBLISHED_DEPOSIT_EVIDENCE_UNVERIFIED' });
  });
});
