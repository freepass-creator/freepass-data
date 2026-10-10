import { describe, expect, it } from 'vitest';
import { assessDepositEvidence, auditDepositEvidence, depositEvidenceInputFromProduct, depositFromYearsRuleNote, depositStatusLabel, resolveDepositByRuleNote, resolveDepositWithRuleNote } from '../src/domain/deposit-evidence.js';
import { buildKakaoCatalogReferenceProduct, resolveReferenceDeposit } from '../src/application/kakao-catalog-reference.js';
import { withCompatibilityDepositEvidence } from '../src/infra/erp5-compat-catalog-reader.js';
import { mapErp5Product } from '../src/adapters/erp5-product-mapping.js';

describe('deposit evidence never promotes a placeholder to waiver', () => {
  const waiverBasis = { field: '원문.전체.장기보증', text: '무보증' } as const;
  const sourceWaiver = { 원문: { 전체: { 장기보증: '무보증' } } };

  it('compatibility derives per-rate state without changing storage or unrelated fields', () => {
    const product = { provider_company_code: 'RP004', product_type: '중고렌트', model: 'synthetic',
      price: { '12': { rent: 500000, deposit: '미확인', depositState: 'ZERO' }, '24': { rent: 400000, deposit: '1,000,000' } } };
    const before = structuredClone(product);
    const result = withCompatibilityDepositEvidence(product);
    expect(result.price).toMatchObject({ '12': { rent: 500000, deposit: null, depositState: 'UNKNOWN', depositStatusLabel: '미확인' },
      '24': { rent: 400000, deposit: 1000000, depositState: 'KNOWN' } });
    expect(product).toEqual(before); expect(result.model).toBe('synthetic');
    const zero = { ...product, ...sourceWaiver, deposit_note: '무보증', price: { '12': { rent: 500000, deposit: 0 } } };
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
  it('keeps positive source amounts as KNOWN even with a rule note and only records rule differences', () => {
    const facts = { supplierId: 'RP023', productType: '오플구독', note: '국산: 월 대여료×2', sourceAmount: 3000000, monthlyRent: 500000, termMonths: 24 };
    expect(resolveReferenceDeposit(facts)).toMatchObject({
      depositState: 'KNOWN',
      depositAmount: 3000000,
      depositRule: { code: 'SOURCE_AMOUNT' },
      depositRuleDifference: { ruleAmount: 1000000, ruleCode: 'RENT_X_2', differs: true },
    });
    expect(assessDepositEvidence(facts)).toMatchObject({ state: 'KNOWN', amount: 3000000, reason: 'SOURCE_AMOUNT' });
    expect(resolveDepositWithRuleNote({ ...facts, sourceAmount: 1000000 })).not.toHaveProperty('depositRuleDifference');
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
    expect(assessDepositEvidence({ ...identity, note: '무보증', depositSourceWaiverBasis: waiverBasis, sourceAmount: 0 }))
      .toMatchObject({ state: 'ZERO', basis: waiverBasis });
    for (const patch of [{ note: '무보증', depositSourceWaiverBasis: waiverBasis, sourceAmount: 1000000 },
      { note: '무보증', depositSourceWaiverBasis: waiverBasis, sourceAmount: 0, hasPositivePaidDeposit: true },
      { note: '무보증', depositSourceWaiverBasis: waiverBasis, depositFree: false, sourceAmount: 0 }]) {
      expect(assessDepositEvidence({ ...identity, ...patch })).toMatchObject({ state: 'UNKNOWN', reason: 'CONFLICTING_ZERO_DEPOSIT_EVIDENCE' });
    }
  });
  it('accepts only supplier-text waiver or verified supplier confirmation as ZERO', () => {
    const identity = { supplierId: 'RP004', productType: '중고렌트', sourceAmount: 0 };
    expect(assessDepositEvidence({ ...identity, note: '무보증', depositSourceWaiverBasis: waiverBasis }))
      .toMatchObject({ state: 'ZERO', amount: 0, reason: 'EXPLICIT_ZERO_DEPOSIT', basis: waiverBasis });
    expect(assessDepositEvidence({ ...identity, note: '무보증' }))
      .toMatchObject({ state: 'ZERO', amount: 0, reason: 'EXPLICIT_ZERO_DEPOSIT', basis: { field: 'deposit_note', text: '무보증' } });
    expect(assessDepositEvidence({ ...identity, note: '무보증', depositSourceWaiverBasis: { field: '원문.전체.장기보증', text: '무보증 가능' } }))
      .toMatchObject({ state: 'ZERO', amount: 0, reason: 'EXPLICIT_ZERO_DEPOSIT', basis: { field: 'deposit_note', text: '무보증' } });
    expect(assessDepositEvidence({ ...identity, depositFree: true }))
      .toMatchObject({ state: 'UNKNOWN', amount: null, reason: 'DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE' });
    expect(assessDepositEvidence({ ...identity, depositFree: '예' }))
      .toMatchObject({ state: 'UNKNOWN', amount: null, reason: 'DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE' });
    expect(assessDepositEvidence({ ...identity, depositFreeConfirmation: { source: '공급사 카톡 답변', at: '2026-10-10T12:00:00+09:00', text: '무보증' } }))
      .toMatchObject({ state: 'ZERO', amount: 0, reason: 'EXPLICIT_ZERO_DEPOSIT',
        basis: { field: 'deposit_free_confirmation', text: '무보증', source: '공급사 카톡 답변', at: '2026-10-10T12:00:00+09:00' } });
    expect(assessDepositEvidence({ ...identity, depositFreeConfirmation: { source: '공급사 답변', at: '2026-10-10T12:00:00+09:00', text: '가능' } }))
      .toMatchObject({ state: 'UNKNOWN', reason: 'DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE' });
    expect(assessDepositEvidence({ ...identity, depositFreeConfirmation: { source: '', at: '2026-10-10T12:00:00+09:00', text: '무보증' } }))
      .toMatchObject({ state: 'UNKNOWN', reason: 'DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE' });
    expect(assessDepositEvidence({ ...identity, depositFreeConfirmation: { source: '공급사 답변', at: '2026-10-10 12:00:00', text: '무보증' } }))
      .toMatchObject({ state: 'UNKNOWN', reason: 'DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE' });
    expect(assessDepositEvidence({ ...identity, sourceAmount: '0원' }))
      .toMatchObject({ state: 'UNKNOWN', reason: 'INVALID_DEPOSIT_AMOUNT' });
    expect(assessDepositEvidence({ ...identity, sourceAmount: '' }))
      .toMatchObject({ state: 'UNKNOWN', reason: 'MISSING_DEPOSIT_AMOUNT' });
    expect(assessDepositEvidence({ ...identity, sourceAmount: 0 }))
      .toMatchObject({ state: 'UNKNOWN', reason: 'DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE' });
  });
  it('accepts exact product waiver from either deposit_note or raw warranty text, but not partial text', () => {
    const identity = { supplierId: 'RP004', productType: '중고렌트', sourceAmount: 0 };
    expect(assessDepositEvidence({ ...identity, note: '무보증' }))
      .toMatchObject({ state: 'ZERO', basis: { field: 'deposit_note', text: '무보증' } });
    expect(assessDepositEvidence({ ...identity, depositSourceWaiverBasis: { field: '원문.전체.장기보증', text: '무보증' } }))
      .toMatchObject({ state: 'ZERO', basis: { field: '원문.전체.장기보증', text: '무보증' } });
    expect(assessDepositEvidence({ ...identity, note: '무보증 가능' }))
      .toMatchObject({ state: 'UNKNOWN', reason: 'DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE' });
  });
  it('uses only the warranty cell that matches the price term period', () => {
    const base = { provider_company_code: 'RP004', product_type: '중고렌트' };
    const longFreeShortPaid = { ...base, deposit_note: '무보증', 원문: { 전체: { 단기보증: '1,000,000', 장기보증: '무보증' } } };
    const shortFreeLongPaid = { ...base, deposit_note: '무보증', 원문: { 전체: { 단기보증: '무보증', 장기보증: '별도 확인' } } };
    expect(resolveReferenceDeposit({ ...depositEvidenceInputFromProduct(longFreeShortPaid, 0, { termMonths: 12 }), termMonths: 12, monthlyRent: 500000 }))
      .toMatchObject({ depositState: 'UNKNOWN', depositAmount: null });
    expect(resolveReferenceDeposit({ ...depositEvidenceInputFromProduct(longFreeShortPaid, 0, { termMonths: 24 }), termMonths: 24, monthlyRent: 500000 }))
      .toMatchObject({ depositState: 'ZERO', depositAmount: 0, depositRule: { depositEvidenceBasis: { field: '원문.전체.장기보증' } } });
    expect(resolveReferenceDeposit({ ...depositEvidenceInputFromProduct(shortFreeLongPaid, 0, { termMonths: 12 }), termMonths: 12, monthlyRent: 500000 }))
      .toMatchObject({ depositState: 'ZERO', depositAmount: 0, depositRule: { depositEvidenceBasis: { field: '원문.전체.단기보증' } } });
    expect(resolveReferenceDeposit({ ...depositEvidenceInputFromProduct(shortFreeLongPaid, 0, { termMonths: 24 }), termMonths: 24, monthlyRent: 500000 }))
      .toMatchObject({ depositState: 'UNKNOWN', depositAmount: null });
  });
  it('accepts deposit_note when the matching period source cell is absent, but rejects matching-cell conflict and negative flags', () => {
    const identity = { supplierId: 'RP004', productType: '중고렌트', sourceAmount: 0 };
    const confirmation = { source: '공급사 답변', at: '2026-10-10T12:00:00+09:00', text: '무보증' };
    expect(assessDepositEvidence({ ...identity, note: '무보증' }))
      .toMatchObject({ state: 'ZERO', basis: { field: 'deposit_note', text: '무보증' } });
    expect(assessDepositEvidence({ ...identity, note: '무보증', depositSourceWaiverText: '1,000,000' }))
      .toMatchObject({ state: 'UNKNOWN', reason: 'CONFLICTING_ZERO_DEPOSIT_EVIDENCE' });
    for (const depositSourceWaiverText of ['1,000,000', '1000000', '100만']) {
      expect(assessDepositEvidence({ ...identity, depositFreeConfirmation: confirmation, depositSourceWaiverText }))
        .toMatchObject({ state: 'UNKNOWN', reason: 'CONFLICTING_ZERO_DEPOSIT_EVIDENCE' });
    }
    expect(assessDepositEvidence({ ...identity, depositFreeConfirmation: confirmation }))
      .toMatchObject({ state: 'ZERO', basis: { field: 'deposit_free_confirmation', text: '무보증' } });
    expect(assessDepositEvidence({ ...identity, depositFreeConfirmation: confirmation, depositSourceWaiverText: '무보증' }))
      .toMatchObject({ state: 'ZERO', basis: { field: 'deposit_free_confirmation', text: '무보증' } });
    for (const depositFree of [false, '아니오', '아님', '불가']) {
      expect(assessDepositEvidence({ ...identity, depositFree, depositSourceWaiverBasis: waiverBasis }))
        .toMatchObject({ state: 'UNKNOWN', reason: 'CONFLICTING_ZERO_DEPOSIT_EVIDENCE' });
      expect(assessDepositEvidence({ ...identity, depositFree, depositFreeConfirmation: confirmation }))
        .toMatchObject({ state: 'UNKNOWN', reason: 'CONFLICTING_ZERO_DEPOSIT_EVIDENCE' });
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
      B: { listable: false, provider_company_code: 'RP004', product_type: '중고렌트', ...sourceWaiver, deposit_note: '무보증', price: { '24': { rent: 500000, deposit: 0 } } },
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

  it('keeps uncovered import terms UNKNOWN instead of applying the 12-month multiplier broadly', () => {
    const note = '수입: 12개월 대여료×3 · 18개월↑ ×6';
    expect([6, 12, 15, 17, 18, 24, 36].map(termMonths => {
      const rule = resolveDepositByRuleNote({ note, termMonths, monthlyRent: 1000000 });
      return rule.state === 'KNOWN' ? [termMonths, rule.multiplier, rule.amount] : [termMonths, rule.state, rule.reason];
    })).toEqual([
      [6, 'UNKNOWN', 'TERM_NOT_COVERED_BY_RULE'],
      [12, 3, 3000000],
      [15, 'UNKNOWN', 'TERM_NOT_COVERED_BY_RULE'],
      [17, 'UNKNOWN', 'TERM_NOT_COVERED_BY_RULE'],
      [18, 6, 6000000],
      [24, 6, 6000000],
      [36, 6, 6000000],
    ]);
  });

  it('reports rule differences only when positive source amount differs from computable rule notes', () => {
    const cases = [
      { note: '국산: 월 대여료×2', termMonths: 24, monthlyRent: 700000, sourceAmount: 1500000, ruleAmount: 1400000, ruleCode: 'RENT_X_2' },
      { note: '수입: 12개월 대여료×3 · 18개월↑ ×6', termMonths: 18, monthlyRent: 500000, sourceAmount: 2500000, ruleAmount: 3000000, ruleCode: 'IMPORT_12_X3_18_PLUS_X6' },
      { note: '월 대여료 × 약정연수 (최대 3개월)', termMonths: 36, monthlyRent: 800000, sourceAmount: 2300000, ruleAmount: 2400000, ruleCode: 'RENT_X_CONTRACT_YEARS_MAX3' },
    ] as const;
    for (const c of cases) {
      const input = { supplierId: 'RP012', productType: '오공구독', ...c };
      expect(resolveReferenceDeposit(input)).toMatchObject({
        depositState: 'KNOWN',
        depositAmount: c.sourceAmount,
        depositRule: { code: 'SOURCE_AMOUNT' },
        depositRuleDifference: { ruleAmount: c.ruleAmount, ruleCode: c.ruleCode, differs: true },
      });
    }
    expect(resolveReferenceDeposit({ supplierId: 'RP012', productType: '오공구독', note: '국산: 월 대여료×2',
      termMonths: 24, monthlyRent: 700000, sourceAmount: 1400000 })).not.toHaveProperty('depositRuleDifference');
  });

  it('keeps compatibility response, guide, and mapper aligned for positive source amount with a rule note', () => {
    const source = { provider_company_code: 'RP012', product_type: '오공구독', deposit_note: '국산: 월 대여료×2',
      price: { '24': { rent: 700000, deposit: 1500000 } } };
    const reference = resolveReferenceDeposit({ supplierId: 'RP012', productType: '오공구독', note: '국산: 월 대여료×2',
      termMonths: 24, monthlyRent: 700000, sourceAmount: 1500000 });
    const compat = (withCompatibilityDepositEvidence(source).price as Record<string, Record<string, unknown>>)['24']!;
    const mapped = mapErp5Product({ projectId: 'freepasserp5', collection: 'products', documentId: 'positive-rule-note',
      sourceRevision: 'r', observedAt: '2026-10-10T00:00:00.000Z',
      data: { car_number: '000가0000', maker: '제조사', model: '모델', vehicle_status: '출고가능',
        status_kind: '가용', listable: true, ...source } });
    expect(reference).toMatchObject({ depositState: 'KNOWN', depositAmount: 1500000,
      depositRuleDifference: { ruleAmount: 1400000, ruleCode: 'RENT_X_2', differs: true } });
    expect(compat).toMatchObject({ depositState: 'KNOWN', deposit: 1500000,
      depositRuleDifference: { ruleAmount: 1400000, ruleCode: 'RENT_X_2', differs: true } });
    // Catalog 후보(표준 가격행)에는 진단 필드를 싣지 않는다 — 금액만 같고 규칙 차이는 호환 응답·안내에만 남는다.
    expect(mapped.candidate.priceTerms[0]).toMatchObject({ depositState: 'KNOWN', deposit: { amount: 1500000, currency: 'KRW' } });
    expect(mapped.candidate.priceTerms[0]).not.toHaveProperty('depositRuleDifference');
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

    const zero = withCompatibilityDepositEvidence({ provider_company_code: 'RP004', product_type: '중고렌트', ...sourceWaiver, deposit_note: '무보증',
      price: { '12': { rent: 100000, deposit: 0 } } }).price as Record<string, Record<string, unknown>>;
    expect(zero['12']).toMatchObject({ deposit: 0, depositState: 'ZERO', depositEvidenceReason: 'EXPLICIT_ZERO_DEPOSIT',
      depositEvidenceBasis: { field: 'deposit_note', text: '무보증' } });
    const iancar = withCompatibilityDepositEvidence({ provider_company_code: 'RP031', product_type: '중고렌트', deposit_note: '국산: 월 대여료×2',
      price: { '12': { rent: 100000, deposit: 0 } } }).price as Record<string, Record<string, unknown>>;
    expect(iancar['12']).toMatchObject({ deposit: null, depositState: 'UNKNOWN', depositEvidenceReason: 'IANCAR_PUBLISHED_DEPOSIT_EVIDENCE_UNVERIFIED' });
  });

  it('keeps guide and compatibility equivalent, while mapper only shares the narrow RP012 subscription years-rule scope', () => {
    const cases = [
      { productType: '픽업구독', note: '월 대여료 × 약정연수 (최대 3개월)', termMonths: 12, sourceAmount: 0, state: 'KNOWN', amount: 100000 },
      { productType: '오공구독', note: '국산: 월 대여료×2', termMonths: 24, sourceAmount: '0', state: 'KNOWN', amount: 200000 },
      { productType: '오공구독', note: '수입: 12개월 대여료×3 · 18개월↑ ×6', termMonths: 15, sourceAmount: 0, state: 'UNKNOWN', amount: null },
      { productType: '중고렌트', note: '국산: 월 대여료×2', termMonths: 24, sourceAmount: 0, state: 'UNKNOWN', amount: null },
      { productType: '픽업구독', note: '무보증', termMonths: 12, sourceAmount: 0, state: 'UNKNOWN', amount: null },
      { productType: '픽업구독', note: '', termMonths: 12, sourceAmount: 500000, state: 'KNOWN', amount: 500000 },
      { productType: '오공구독', note: '', termMonths: 12, sourceAmount: 0, state: 'UNKNOWN', amount: null },
    ] as const;
    for (const c of cases) {
      const reference = resolveReferenceDeposit({ supplierId: 'RP012', productType: c.productType, note: c.note,
        termMonths: c.termMonths, monthlyRent: 100000, sourceAmount: c.sourceAmount });
      const compat = (withCompatibilityDepositEvidence({ provider_company_code: 'RP012', product_type: c.productType, deposit_note: c.note,
        price: { [String(c.termMonths)]: { rent: 100000, deposit: c.sourceAmount } } }).price as Record<string, Record<string, unknown>>)[String(c.termMonths)]!;
      const mapped = mapErp5Product({ projectId: 'freepasserp5', collection: 'products', documentId: `p-${c.termMonths}-${c.productType}`,
        sourceRevision: 'r', observedAt: '2026-10-10T00:00:00.000Z',
        data: { car_number: '000가0000', maker: '제조사', model: '모델', provider_company_code: 'RP012',
          product_type: c.productType, vehicle_status: '출고가능', status_kind: '가용', listable: true,
          deposit_note: c.note, price: { [String(c.termMonths)]: { rent: 100000, deposit: c.sourceAmount } } } });
      const term = mapped.candidate.priceTerms[0]!;
      expect([reference.depositState, reference.depositAmount]).toEqual([c.state, c.amount]);
      expect([compat.depositState, compat.deposit]).toEqual([c.state, c.amount]);
      const mapperExpected = c.note.includes('2') && c.sourceAmount === '0' ? ['UNKNOWN', null] : [c.state, c.amount];
      expect([term.depositState, term.deposit?.amount ?? null]).toEqual(mapperExpected);
    }
  });

  it('keeps compatibility response, guide, and mapper aligned for verified deposit-free confirmation', () => {
    const confirmation = { source: '공급사 확인 답변', at: '2026-10-10T12:00:00+09:00', text: '무보증' };
    const reference = resolveReferenceDeposit({
      supplierId: 'RP004', productType: '중고렌트', note: '', termMonths: 24, monthlyRent: 500000,
      sourceAmount: 0, depositFree: true, depositFreeConfirmation: confirmation,
    });
    const compat = (withCompatibilityDepositEvidence({ provider_company_code: 'RP004', product_type: '중고렌트',
      deposit_free: true, deposit_free_confirmation: confirmation, price: { '24': { rent: 500000, deposit: 0 } } })
      .price as Record<string, Record<string, unknown>>)['24']!;
    const mapped = mapErp5Product({ projectId: 'freepasserp5', collection: 'products', documentId: 'verified-free',
      sourceRevision: 'r', observedAt: '2026-10-10T00:00:00.000Z',
      data: { car_number: '000가0000', maker: '제조사', model: '모델', provider_company_code: 'RP004',
        product_type: '중고렌트', vehicle_status: '출고가능', status_kind: '가용', listable: true,
        deposit_free: true, deposit_free_confirmation: confirmation, price: { '24': { rent: 500000, deposit: 0 } } } });
    expect([reference.depositState, reference.depositAmount]).toEqual(['ZERO', 0]);
    expect([compat.depositState, compat.deposit, compat.depositEvidenceReason]).toEqual(['ZERO', 0, 'EXPLICIT_ZERO_DEPOSIT']);
    expect([mapped.candidate.priceTerms[0]!.depositState, mapped.candidate.priceTerms[0]!.deposit?.amount ?? null]).toEqual(['ZERO', 0]);

    const unverified = withCompatibilityDepositEvidence({ provider_company_code: 'RP004', product_type: '중고렌트',
      deposit_free: true, price: { '24': { rent: 500000, deposit: 0 } } }).price as Record<string, Record<string, unknown>>;
    expect(unverified['24']).toMatchObject({ depositState: 'UNKNOWN', deposit: null, depositEvidenceReason: 'DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE' });
  });

  it('keeps reference and compatibility equivalent across all forms, with mapper UNKNOWN outside its intentional narrow scope', () => {
    const productTypes = ['픽업구독', '오공구독', '오플구독', '중고렌트', '재렌트', '신차렌트'];
    const notes = ['월 대여료 × 약정연수 (최대 3개월)', '국산: 월 대여료×2', '수입: 12개월 대여료×3 · 18개월↑ ×6', ''];
    const terms = [6, 12, 15, 17, 18, 24, 36];
    const sourceAmounts: unknown[] = [0, '0', undefined, null, '', 500000];
    const rents: unknown[] = [100000, '100000'];
    const stateAmount = (state: unknown, amount: unknown) => [state, amount ?? null];
    for (const productType of productTypes) for (const note of notes) for (const termMonths of terms) {
      for (const sourceAmount of sourceAmounts) for (const rent of rents) {
        const priceKey = String(termMonths);
        const sourceRow = sourceAmount === undefined ? { rent } : { rent, deposit: sourceAmount };
        const base = { supplierId: 'RP012', productType, note, termMonths, monthlyRent: 100000, sourceAmount };
        const reference = resolveReferenceDeposit(base);
        const compat = (withCompatibilityDepositEvidence({ provider_company_code: 'RP012', product_type: productType,
          deposit_note: note, price: { [priceKey]: sourceRow } }).price as Record<string, Record<string, unknown>>)[priceKey]!;
        const mapped = mapErp5Product({ projectId: 'freepasserp5', collection: 'products',
          documentId: `p-${productType}-${note || 'none'}-${termMonths}-${String(sourceAmount)}-${String(rent)}`.replace(/[^\w.-]/g, '_'),
          sourceRevision: 'r', observedAt: '2026-10-10T00:00:00.000Z',
          data: { car_number: '000가0000', maker: '제조사', model: '모델', provider_company_code: 'RP012',
            product_type: productType, vehicle_status: '출고가능', status_kind: '가용', listable: true,
            deposit_note: note, price: { [priceKey]: sourceRow } } });
        const term = mapped.candidate.priceTerms[0]!;
        expect(stateAmount(compat.depositState, compat.deposit), `${productType}/${note}/${termMonths}/${String(sourceAmount)}/${String(rent)}`)
          .toEqual(stateAmount(reference.depositState, reference.depositAmount));
        const mapperInScope = !/렌트|신차/.test(productType) && note === notes[0] && (sourceAmount === 0 || sourceAmount === '0');
        const mapperExpected = mapperInScope || sourceAmount === 500000
          ? stateAmount(reference.depositState, reference.depositAmount)
          : ['UNKNOWN', null];
        // Mapper intentionally remains UNKNOWN outside RP012 subscription exact-zero years-rule scope.
        expect(stateAmount(term.depositState, term.deposit?.amount), `${productType}/${note}/${termMonths}/${String(sourceAmount)}/${String(rent)}`)
          .toEqual(mapperExpected);
        expect(compat.rent).toBe(rent);
      }
    }
  });
});
