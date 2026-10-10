process.env.FREEPASS_SHEET_F04_ID = 'test-sheet-f04';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { precomputeOfferEconomics, readStoredTermFees } from '../src/application/resolve-offer-commercial-terms.js';
import { withCompatibilityDepositEvidence } from '../src/infra/erp5-compat-catalog-reader.js';
import {
  KAKAO_COMMISSION_POLICY,
  KAKAO_COMMISSION_POLICY_2026_10_03,
  KAKAO_COMMISSION_POLICY_2026_10_04,
  buildKakaoCatalogReference,
  buildInternalAiReference,
  filterReferenceZeroDeposit,
  resolveReferencePolicyContext,
  buildKakaoCatalogReferenceProduct,
  resolveReferenceDeposit,
  resolveExpectedGrossMargin,
  resolveSalesCommission,
  resolveSupplierBillingFee,
  resolveReferenceVehiclePhotos,
} from '../src/application/kakao-catalog-reference.js';

describe('shared reference policy context', () => {
  it('keeps legacy DTO compatibility while rejecting contradictory displacement states', () => {
    const schema = JSON.parse(readFileSync(new URL('../contracts/kakao-catalog-reference-v1.schema.json', import.meta.url), 'utf8'));
    const validate = new Ajv2020({ strict: false }).compile({ $defs: schema.$defs, ...schema.$defs.product.properties.vehicle });
    const legacy = buildKakaoCatalogReferenceProduct('synthetic', { listable: true, provider_company_code: 'RP013', price: { '36': { rent: 500000 } } })!.vehicle;
    const { engineCc, engineCcState, ...oldVehicle } = legacy;
    expect(validate(oldVehicle)).toBe(true);
    expect(validate({ ...oldVehicle, engineCc: 0, engineCcState: 'KNOWN' })).toBe(true);
    expect(validate({ ...oldVehicle, engineCc: null, engineCcState: 'HOLD' })).toBe(true);
    expect(validate({ ...oldVehicle, engineCc: null, engineCcState: 'KNOWN' })).toBe(false);
    expect(validate({ ...oldVehicle, engineCc: 1998, engineCcState: 'HOLD' })).toBe(false);
    expect(validate({ ...oldVehicle, engineCc: 1998 })).toBe(false);
  });
  it.each([
    [1998, 1998], ['1998', 1998], ['1,998', 1998], [0, 0], ['0', 0],
    [undefined, null], [null, null], ['', null], ['unknown', null], ['1998cc', null], [-1, null],
  ])('preserves source engine_cc %s without inventing displacement or changing source identities', (raw, expected) => {
    const product = { listable: true, provider_company_code: 'RP013', product_type: '중고렌트',
      fuel_type: '가솔린', drive_type: 'AWD', engine_cc: raw, vehicle_uid: 'existing-immutable-uid',
      price: { '36_2만': { rent: 500000, deposit: 1000000 }, '48_2만': { rent: 450000, deposit: null } } };
    const source = { consumerId: 'kakao-ops', observedAt: '2026-10-10T00:00:00Z', products: { synthetic: product } };
    const original = structuredClone(source);
    const reference = buildKakaoCatalogReference(source);
    const row = reference.data[0]!;
    expect(row.vehicle).toMatchObject({ engineCc: expected, engineCcState: expected === null ? 'HOLD' : 'KNOWN', fuel: '가솔린', drive: 'AWD' });
    expect(row.vehicleMasterReference).toMatchObject({ state: 'HOLD', masterId: null, trimId: null });
    expect(row.sourceProductId).toBe('synthetic');
    expect(row.offers[0]!.supplierId).toBe('RP013');
    expect(row.offers[0]!.priceTerms.map(term => term.termKey)).toEqual(['source:36_2만', 'source:48_2만']);
    expect(buildInternalAiReference({ ...source, consumerId: 'internal-ai-test' }).data).toEqual(reference.data);
    expect(source).toEqual(original);
    const missingSpecs = buildKakaoCatalogReference({ ...source, products: { synthetic: { ...product, fuel_type: '', drive_type: '' } } });
    expect(missingSpecs.data[0]!.vehicle).toMatchObject({ fuel: null, drive: null });
  });
  it('attaches only native pairs from the provided sealed snapshot, preserving source and period identities', () => {
    const observedAt = new Date().toISOString();
    const body = { readAt: observedAt, masters: [{ id: 'native-master', data: { maker: '현대', model: '쏘나타', sub_model: '쏘나타 DN8', sub_model_aliases: ['소나타 DN8'] } }],
      trims: [{ id: 'native-trim', data: { master_id: 'native-master', maker: '현대', model: '쏘나타', sub_model: '쏘나타 DN8', trim: '스마트' } }] };
    const seal = (value: typeof body) => ({ source: 'freepasserp5/vehicle_master+vehicle_trim_master' as const, complete: true as const, ...value,
      digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
    const product = { listable: true, provider_company_code: 'RP013', product_type: '중고렌트', maker: '현대', model: '쏘나타', sub_model: '소나타 DN8', trim_name: '스마트',
      deposit_note: '무보증', price: { '36_2만': { rent: 500000, deposit: 0 } } };
    const source = { consumerId: 'kakao-ops', products: { synthetic: product }, observedAt };
    const original = structuredClone(source);
    const plain = buildKakaoCatalogReference(source);
    const master = seal(body);
    const linked = buildKakaoCatalogReference({ ...source, vehicleMasterSnapshot: master });
    expect(linked.data[0]!.vehicleMasterReference).toEqual({ state: 'KNOWN', authority: 'FREEPASS_DATA_VEHICLE_MASTER', identityKind: 'FIRESTORE_DOCUMENT_ID',
      masterId: 'native-master', trimId: 'native-trim', snapshotDigest: master.digest, readAt: observedAt, reasonCode: null });
    expect(linked.data[0]!.sourceProductId).toBe(plain.data[0]!.sourceProductId);
    expect(linked.data[0]!.vehicleModelId).toBe(plain.data[0]!.vehicleModelId);
    expect(linked.data[0]!.offers).toEqual(plain.data[0]!.offers);
    expect(source).toEqual(original);
    expect(buildInternalAiReference({ ...source, consumerId: 'internal-ai-test', vehicleMasterSnapshot: master }).data).toEqual(linked.data);
    const unknownInputs = [
      { ...source },
      { ...source, vehicleMasterReadState: 'UNAVAILABLE' as const, vehicleMasterSnapshot: null },
      { ...source, vehicleMasterReadState: 'UNAVAILABLE' as const, vehicleMasterSnapshot: master },
      { ...source, vehicleMasterSnapshot: { ...master, digest: 'tampered' } },
      { ...source, observedAt: new Date(Date.parse(observedAt) + 300001).toISOString(), vehicleMasterSnapshot: master },
      { ...source, vehicleMasterSnapshot: seal({ ...body, trims: [...body.trims, { ...body.trims[0]!, id: 'ambiguous-trim' }] }) },
      { ...source, products: { synthetic: { ...product, trim_name: 'unconfirmed' } }, vehicleMasterSnapshot: master },
    ];
    for (const input of unknownInputs) {
      const result = buildKakaoCatalogReference(input);
      expect(result.data[0]!.vehicleMasterReference).toMatchObject({ state: 'HOLD', masterId: null, trimId: null });
      expect(result.data[0]!.vehicleMasterReference.reasonCode).toBeTruthy();
      expect(result.data[0]!.offers).toEqual(plain.data[0]!.offers);
    }
  });
  it('preserves approved Iancar zero per mileage term, rejects stale or mismatched published evidence', () => {
    const now = '2026-10-09T00:00:00Z';
    const terms = [
      { key: '24:20000:year', compatibilityPriceKey: '24_연20000km', termMonths: 24, contractedMileage: { km: 20000, period: 'year' }, monthlyRent: { amount: 500000, currency: 'KRW' }, deposit: { amount: 0, currency: 'KRW' }, depositState: 'ZERO', vatIncluded: true },
      { key: '24:30000:year', compatibilityPriceKey: '24_연30000km', termMonths: 24, contractedMileage: { km: 30000, period: 'year' }, monthlyRent: { amount: 600000, currency: 'KRW' }, deposit: { amount: 1000000, currency: 'KRW' }, depositState: 'KNOWN', vatIncluded: true },
      { key: '48:1000:month', compatibilityPriceKey: '48_월1000km', termMonths: 48, contractedMileage: { km: 1000, period: 'month' }, monthlyRent: { amount: 700000, currency: 'KRW' }, deposit: { amount: 0, currency: 'KRW' }, depositState: 'ZERO', vatIncluded: true },
    ];
    const product = { listable: true, provider_company_code: 'RP031', product_type: '중고렌트', source: 'EANCAR_ONE_API', source_schema: 'iancar-one-phase-one-product/1',
      iancar_one_vehicle_id: 'synthetic', car_number: '000가0000', _direct_ingest_at: Date.parse(now), deposit_note: '기간·주행거리별 보증금 상이: 상품 요금 조건 확인',
      price: { '24': { rent: 500000, deposit: 0 }, '24_연20000km': { rent: 500000, deposit: 0 }, '24_연30000km': { rent: 600000, deposit: 1000000 }, '48_월1000km': { rent: 700000, deposit: 0 } },
      iancar_phase_one: { stage: 'PHASE_ONE', publicationPlane: 'ERP5_COMPATIBILITY_BRIDGE', sourceVehicleId: 'synthetic', sourceSyncedAt: now, sourceDigest: 'a'.repeat(64), ratesDigest: 'b'.repeat(64), terms, priceAliases: { '24': '24:20000:year' } } };
    const input = { consumerId: 'kakao-ops', observedAt: now, products: { synthetic: product } };
    const reference = buildKakaoCatalogReference(input);
    expect(reference.data[0]!.offers[0]!.priceTerms.map(t => t.depositState)).toEqual(['ZERO', 'ZERO', 'KNOWN', 'ZERO']);
    expect(reference.data[0]!.offers[0]!.priceTerms[3]).toMatchObject({ contractedMileage: { km: 1000, period: 'month' }, mileageLimitKmPerYear: null });
    expect(filterReferenceZeroDeposit(reference, { depositState: 'ZERO', termMonths: '24' }).data).toHaveLength(1);
    expect(filterReferenceZeroDeposit(reference, { depositState: 'ZERO', depositScope: 'ALL_TERMS' }).data).toEqual([]);
    expect(buildInternalAiReference({ ...input, consumerId: 'internal-ai-test' }).data).toEqual(reference.data);
    const stale = buildKakaoCatalogReference({ ...input, observedAt: '2026-10-09T00:15:01Z' });
    expect(stale.data[0]!.offers[0]!.priceTerms.map(t => t.depositState)).toEqual(['UNKNOWN', 'UNKNOWN', 'KNOWN', 'UNKNOWN']);
    expect(stale.data[0]!.offers[0]!.priceTerms[2]).toMatchObject({ depositAmount: 1000000,
      depositEvidence: { reasonCode: 'SOURCE_AMOUNT', publicationEvidenceReason: 'IANCAR_PUBLISHED_DEPOSIT_EVIDENCE_STALE', publicationDecision: 'HOLD' } });
    const staleCompat = withCompatibilityDepositEvidence(product, '2026-10-09T00:15:01Z').price as Record<string, Record<string, unknown>>;
    expect(staleCompat['24_연30000km']).toMatchObject({ deposit: null, depositState: 'UNKNOWN' });
    expect(staleCompat['24_연30000km']).not.toHaveProperty('depositPublicationDecision');
    expect(staleCompat['24']).toMatchObject({ deposit: null, depositState: 'UNKNOWN' });
    expect(buildKakaoCatalogReference({ ...input, observedAt: '2026-10-08T23:58:59Z' }).data[0]!.offers[0]!.priceTerms[2]!.depositState).toBe('UNKNOWN');
    expect(filterReferenceZeroDeposit(stale, { depositState: 'ZERO' }).data).toEqual([]);
    const mismatch = structuredClone(product); mismatch.price['24'].deposit = 1;
    expect(buildKakaoCatalogReferenceProduct('synthetic', mismatch, {}, {}, now)!.offers[0]!.priceTerms[0]!.depositState).toBe('UNKNOWN');
    expect(buildKakaoCatalogReferenceProduct('synthetic', mismatch, {}, {}, '2026-10-09T00:15:01Z')!.offers[0]!.priceTerms[0]!.depositState).toBe('UNKNOWN');
    const ambiguous = structuredClone(product); ambiguous.iancar_phase_one.priceAliases['24'] = '24:30000:year'; ambiguous.price['24'].deposit = 1000000;
    expect(buildKakaoCatalogReferenceProduct('synthetic', ambiguous, {}, {}, '2026-10-09T00:15:01Z')!.offers[0]!.priceTerms[0]!.depositState).toBe('UNKNOWN');
    const deleted = { ...product, _deleted: true };
    expect(buildKakaoCatalogReferenceProduct('synthetic', deleted, {}, {}, '2026-10-09T00:15:01Z')!.offers[0]!.priceTerms[2]!.depositState).toBe('UNKNOWN');
    expect(resolveReferenceDeposit({ supplierId: 'RP012', productType: '중고렌트', note: '무보증', depositFree: true, sourceAmount: 0, termMonths: 24, monthlyRent: 500000 }).depositState).toBe('UNKNOWN');
  });
  it('searches confirmed zero without treating placeholders or mixed periods as all-free', () => {
    const base = { listable: true, provider_company_code: 'RP013', product_type: '중고렌트' };
    const sourceWaiver = { 원문: { 전체: { 장기보증: '무보증' } } };
    const reference = buildKakaoCatalogReference({ consumerId: 'kakao-ops', observedAt: '2026-10-09T00:00:00Z', products: {
      free: { ...base, ...sourceWaiver, deposit_note: '무보증', price: { '24': { rent: 600000, deposit: 0 }, '36': { rent: 500000, deposit: 0 } } },
      unknown: { ...base, price: { '36': { rent: 500000, deposit: 0 } } },
      conflict: { ...base, deposit_note: '무보증', price: { '36': { rent: 500000, deposit: 100000 } } },
    } });
    const free = filterReferenceZeroDeposit(reference, { depositState: 'ZERO', termMonths: '36', depositScope: 'ALL_TERMS' });
    expect(free.data.map(p => p.sourceProductId)).toEqual(['free']);
    expect(free.data[0]!.offers[0]!.priceTerms).toHaveLength(2);
    expect(free.data[0]!.offers[0]!.priceTerms[0]!.depositEvidence).toMatchObject({ sourceAmount: 0, sourceNote: '무보증', reasonCode: 'ZERO_DEPOSIT' });
    expect(free.meta).toMatchObject({ projectedCount: 1, depositFilter: { state: 'ZERO', termMonths: 36, scope: 'ALL_TERMS' } });
    expect(filterReferenceZeroDeposit(reference, { depositState: 'ZERO', termMonths: '48' }).data).toEqual([]);
    const mixed = structuredClone(reference);
    mixed.data.find(p => p.sourceProductId === 'free')!.offers[0]!.priceTerms[0]!.depositState = 'KNOWN';
    mixed.data.find(p => p.sourceProductId === 'free')!.offers[0]!.priceTerms[0]!.depositAmount = 100000;
    mixed.data.find(p => p.sourceProductId === 'free')!.offers[0]!.priceTerms[0]!.deposit = { amount: 100000, currency: 'KRW' };
    expect(filterReferenceZeroDeposit(mixed, { depositState: 'ZERO', termMonths: '36' }).data).toHaveLength(1);
    expect(filterReferenceZeroDeposit(mixed, { depositState: 'ZERO', termMonths: '36', depositScope: 'ALL_TERMS' }).data).toEqual([]);
    mixed.data.find(p => p.sourceProductId === 'free')!.offers[0]!.priceTerms[0]!.depositState = 'UNKNOWN';
    expect(filterReferenceZeroDeposit(mixed, { depositState: 'ZERO', termMonths: '36', depositScope: 'ALL_TERMS' }).data).toEqual([]);
    mixed.data.find(p => p.sourceProductId === 'free')!.offers[0]!.priceTerms = [];
    expect(filterReferenceZeroDeposit(mixed, { depositState: 'ZERO', depositScope: 'ALL_TERMS' }).data).toEqual([]);
    for (const query of [{ depositState: 'PAID' }, { termMonths: ['36'] }, { depositState: 'ZERO', termMonths: '0' }, { depositState: 'ZERO', termMonths: '36.0' }, { depositState: 'ZERO', depositScope: 'all' }, { depositState: 'ZERO', depositScope: ['ALL_TERMS'] }, { depositState: 'ZERO', depositScope: { toString: () => 'ALL_TERMS' } }]) {
      expect(() => filterReferenceZeroDeposit(reference, query)).toThrow('REFERENCE_DEPOSIT_FILTER_INVALID');
    }
    expect(filterReferenceZeroDeposit(reference, {})).toBe(reference);
  });
  it('applies the user-assigned basic ladder to the eight suppliers without inventing short terms', () => {
    for (const supplierId of KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.basicSupplierIds) {
      const input = { supplierId, productType: '구독', termMonths: 36, monthlyRent: 800000 };
      expect(resolveSupplierBillingFee(input).amount).toBe(1080000);
      expect(resolveSalesCommission(input).amount).toBe(864000);
      expect(resolveSupplierBillingFee({ ...input, termMonths: 1 }).state).toBe('UNKNOWN');
    }
    expect(KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.policyKind).toBe('BASIC');
    expect(KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.billinProposal.state).toBe('CONFIRMED');
    expect(resolveSupplierBillingFee({ supplierId: 'RP021', productType: '구독', termMonths: 36, monthlyRent: 800000 }).amount).toBe(800000);
  });
  const product = { listable: true, provider_company_code: 'RP013', product_type: '중고렌트',
    policy_code: 'POL1', price: { '24': { rent: 600000, deposit: 0 } } };
  const policy = { policy_code: 'POL1', provider_company_code: 'RP013', annual_mileage: 20000,
    insurance_included: false, basic_driver_age: 26, secret: 'private', customer_name: 'private' };
  it('keeps a no-plate product and its terms with the same facts for Kakao and internal AI', () => {
    const source = { consumerId: 'kakao-ops', products: { supplierProduct1: product },
      policies: { POL1: policy }, observedAt: '2026-10-09T00:00:00.000Z' };
    const kakao = buildKakaoCatalogReference(source);
    const ai = buildInternalAiReference({ ...source, consumerId: 'internal-ai-ops' });
    expect(ai.data).toEqual(kakao.data);
    expect(kakao.data[0]!.vehicle.plateNumber).toBeNull();
    expect(kakao.data[0]!.sourceProductId).toBe('supplierProduct1');
    const offer = kakao.data[0]!.offers[0]!;
    expect(offer.priceTerms).toHaveLength(1);
    expect(offer.policyContext).toMatchObject({ state: 'REFERENCE', reasonCode: null });
    expect(offer.policyContext.facts).toContainEqual({ key: 'insurance_included', label: '보험 포함 여부',
      value: false, sourceRef: 'policy/POL1/insurance_included' });
    expect(JSON.stringify(offer.policyContext)).not.toContain('private');
  });
  it('never chooses one of conflicting links or another supplier policy', () => {
    expect(resolveReferencePolicyContext(product, {})).toMatchObject({ state: 'UNKNOWN', reasonCode: 'POLICY_NOT_FOUND' });
    expect(resolveReferencePolicyContext(product, { POL1: policy, other: policy })).toMatchObject({
      state: 'UNKNOWN', facts: [], reasonCode: 'POLICY_LINK_AMBIGUOUS' });
    expect(resolveReferencePolicyContext(product, { POL1: { ...policy, provider_company_code: 'RP023' } })).toMatchObject({
      state: 'UNKNOWN', facts: [], reasonCode: 'POLICY_SUPPLIER_MISMATCH' });
    expect(resolveReferencePolicyContext({ ...product, policy_code: '' })).toMatchObject({ reasonCode: 'POLICY_LINK_MISSING' });
  });
  it('empty or invalid recognized fields are not interpreted as an approved policy', () => {
    expect(resolveReferencePolicyContext(product, { POL1: { annual_mileage: { arbitrary: true } } })).toMatchObject({
      state: 'UNKNOWN', facts: [], reasonCode: 'POLICY_FACTS_MISSING' });
  });
  it('preserves native policy name/code and reuses supplier-scoped policy selection without approving name-only facts', () => {
    const named = { ...policy, policy_name: '공급사 기본 조건' };
    expect(resolveReferencePolicyContext(product, { native: named, other: { ...named, provider_company_code: 'RP023' } }))
      .toMatchObject({ state: 'REFERENCE', policyCode: 'POL1', policyName: '공급사 기본 조건', sourceRef: 'policy/native',
        policyNameSourceRef: 'policy/native/policy_name', policyCodeSourceRef: 'policy/native/policy_code' });
    expect(resolveReferencePolicyContext(product, { native: { policy_code: 'POL1', policy_name: '조건 확인 중', provider_company_code: 'RP013' } }))
      .toMatchObject({ state: 'UNKNOWN', policyName: '조건 확인 중', facts: [], reasonCode: 'POLICY_FACTS_MISSING' });
    expect(resolveReferencePolicyContext(product, { native: named, duplicate: named }))
      .toMatchObject({ policyName: null, policyCode: null, reasonCode: 'POLICY_LINK_AMBIGUOUS' });
  });
});

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
    expect(row.supplierBillingFee).toMatchObject({ state: 'KNOWN', amount: { amount: 1000000 }, vatTreatment: 'INCLUDED', vatAmount: 100000, totalAmount: 1100000, policyId: 'sales-commission-2026-10-09' });
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
    for (const supplierId of ['RP021', 'PT-0026']) expect(resolveSalesCommission({ ...base, supplierId, productType: '중고구독', termMonths: 24 }).reasonCode).toBe('BILLIN_36_MONTH_RENT_REQUIRED');
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
    const note = '수입: 12개월 대여료×3 · 18개월↑ ×6';
    expect([6, 12, 15, 17, 18, 24, 36].map(termMonths => {
      const result = resolveReferenceDeposit({ note, termMonths, monthlyRent: 1000000, sourceAmount: 0 });
      return [termMonths, result.depositState, result.depositAmount, result.depositRule?.multiplier ?? null];
    })).toEqual([
      [6, 'UNKNOWN', null, null],
      [12, 'KNOWN', 3000000, 3],
      [15, 'UNKNOWN', null, null],
      [17, 'UNKNOWN', null, null],
      [18, 'KNOWN', 6000000, 6],
      [24, 'KNOWN', 6000000, 6],
      [36, 'KNOWN', 6000000, 6],
    ]);
  });

  it('emits ZERO only for the explicit no-deposit rule', () => {
    const basis = { field: '원문.전체.장기보증', text: '무보증' } as const;
    expect(resolveReferenceDeposit({ supplierId: 'RP004', productType: '중고렌트', note: '무보증', depositSourceWaiverBasis: basis, termMonths: 60, monthlyRent: 800000, sourceAmount: 0 })).toEqual({
      depositAmount: 0,
      depositState: 'ZERO',
      depositRule: { code: 'ZERO_DEPOSIT', multiplier: 0, label: '무보증', depositEvidenceBasis: basis },
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
    provider_company_code: 'RP013', provider_name: '웰릭스모빌리티', car_number: '000가0000',
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
  // 합성 개별 합의(비공개 목록에서 오는 형태). 금액은 시험용 가짜 값이다.
  const agreement = { agreementId: 'private:synthetic-01', sourceRow: 160 as const, status: 'APPROVED' as const, contractRef: opaque, matchedContractRef: opaque, billing: 777000, payout: 444000 };
  it('preserves previous policy facts and versions the new authority', () => {
    expect(KAKAO_COMMISSION_POLICY_2026_10_03.policyId).toBe('sales-commission-2026-10-03');
    expect(KAKAO_COMMISSION_POLICY_2026_10_03.sonokongAdditions[60]).toBe(700000);
    expect(KAKAO_COMMISSION_POLICY_2026_10_04.policyId).toBe('sales-commission-2026-10-04');
    expect(KAKAO_COMMISSION_POLICY_2026_10_04.sonokongAdditions).not.toHaveProperty('60');
    // 2026-10-05 AI 상황실 결정: 손오공 60개월 +60만(F04 14행, 근거는 비공개 인수인계), 원 미만 반올림.
    expect(KAKAO_COMMISSION_POLICY.policyId).toBe('sales-commission-2026-10-09');
    expect(KAKAO_COMMISSION_POLICY.sonokongAdditions[60]).toBe(600000);
    expect(KAKAO_COMMISSION_POLICY.sonokong60Evidence).toEqual({ sourceRows: [14], evidence: 'private:ai-ops/정산-수수료규칙-20261005', decidedBy: 'AI 상황실 2026-10-05' });
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
  it.each(['RP021','PT-0026'])('billin %s uses the 36-month rent at 100/80 percent', supplierId => {
    expect(amounts({ ...base, supplierId, termMonths: 36, monthlyRent: 500000 })).toEqual([500000,400000]);
    for (const termMonths of [12,24,48,60]) {
      expect(both({ ...base, supplierId, termMonths }).every(r => r.reasonCode === 'BILLIN_36_MONTH_RENT_REQUIRED')).toBe(true);
      expect(amounts({ ...base, supplierId, termMonths, monthlyRent: 900000, billin36MonthlyRent: 500000 })).toEqual([500000,400000]);
    }
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
  it('7: an approved private individual agreement pays exactly its amounts (same input → same amount), with row 160 provenance', () => {
    const input = { ...base, supplierId: 'RP012', individualException: true, individualAgreement: agreement };
    const before = structuredClone(input);
    expect(amounts(input)).toEqual([777000, 444000]);
    expect(amounts(structuredClone(input))).toEqual(amounts(input));
    expect(both(input).map(r => r.ruleId)).toEqual(['INDIVIDUAL_AGREEMENT_BILLING', 'INDIVIDUAL_AGREEMENT_PAYOUT']);
    expect(both(input)[0]!.sourceRefs).toEqual(['F04:수수료표!A160:M160']);
    expect(input).toEqual(before);
    for (const changed of [{ matchedContractRef: 'opaque:another_contract_0001' }, { status: 'UNCONFIRMED' as const }, { contractRef: 'plaintext' }, { agreementId: 'plain-id' }, { sourceRow: 999 as never }]) {
      expect(both({ ...input, individualAgreement: { ...agreement, ...changed } }).every(r => r.state === 'UNKNOWN')).toBe(true);
    }
    expect(both({ ...input, individualAgreement: { ...agreement, billing: null } }).map(r => r.state)).toEqual(['UNKNOWN', 'CALCULATED']);
    expect(both({ ...input, individualAgreement: { ...agreement, payout: -1 } })[1]!.reasonCode).toBe('INDIVIDUAL_AGREEMENT_AMOUNT_INVALID');
  });
  it('7: legacy individual exception evidence fails closed instead of falling through to the general rule', () => {
    const legacyOnly = { ...base, supplierId: 'RP012', individualExceptionEvidence: { sourceRow: 160, privateRef: 'legacy-private-ref' } };
    expect(both(legacyOnly)).toEqual([
      expect.objectContaining({ state: 'UNKNOWN', amount: null, reasonCode: 'LEGACY_INDIVIDUAL_EXCEPTION_INPUT' }),
      expect.objectContaining({ state: 'UNKNOWN', amount: null, reasonCode: 'LEGACY_INDIVIDUAL_EXCEPTION_INPUT' }),
    ]);
    expect(amounts({ ...base, supplierId: 'RP012', individualAgreement: agreement })).toEqual([777000, 444000]);
  });
  it.each([null, false, 'opaque:bad-shape', []])('7: invalid individualAgreement %p fails closed instead of falling through', individualAgreement => {
    expect(both({ ...base, supplierId: 'RP012', individualAgreement } as never)).toEqual([
      expect.objectContaining({ state: 'UNKNOWN', amount: null, reasonCode: 'INDIVIDUAL_AGREEMENT_INVALID' }),
      expect.objectContaining({ state: 'UNKNOWN', amount: null, reasonCode: 'INDIVIDUAL_AGREEMENT_INVALID' }),
    ]);
  });
  it('7: RP034 with only legacy individual exception evidence stays unknown before exclusion', () => {
    const legacyOnly = { ...base, supplierId: 'RP034', individualExceptionEvidence: { sourceRow: 160, privateRef: 'legacy-private-ref' } };
    expect(both(legacyOnly)).toEqual([
      expect.objectContaining({ state: 'UNKNOWN', amount: null, reasonCode: 'LEGACY_INDIVIDUAL_EXCEPTION_INPUT' }),
      expect.objectContaining({ state: 'UNKNOWN', amount: null, reasonCode: 'LEGACY_INDIVIDUAL_EXCEPTION_INPUT' }),
    ]);
  });
  it('7: a payout-confirmed agreement pays only the payout; billing stays unknown even with vehicle input', () => {
    const input = { ...base, supplierId: 'RP004', productType: '선출고', vehicleValue: 40000000,
      individualAgreement: { ...agreement, sourceRow: 163 as const, status: 'PAYOUT_CONFIRMED' as const, billing: 999000, payout: 333000 } };
    expect(resolveSalesCommission(input)).toMatchObject({ state: 'CALCULATED', amount: 333000, ruleId: 'INDIVIDUAL_AGREEMENT_PAYOUT' });
    expect(resolveSupplierBillingFee(input).reasonCode).toBe('INDIVIDUAL_BILLING_BASIS_UNCONFIRMED');
    expect(resolveSalesCommission(input).sourceRefs).toEqual(['F04:수수료표!A163:M163']);
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
  it('unconfirmed scopes stay unknown; Sonokong 60 = Q12 + 600,000 billing / Q12 payout; Star VAT-included rerent rounds to the won', () => {
    expect(both({ ...base, supplierId: 'RP013', productType: '신차발주' }).every(r => r.state === 'UNKNOWN')).toBe(true);
    for (const productType of ['신차렌트','재렌트']) expect(both({ ...base, supplierId: 'RP014', productType }).every(r => r.state === 'UNKNOWN')).toBe(true);
    const sonokong = { ...base, supplierId: 'RP012', subscriptionForm: 'BUYOUT' as const, q12Basis: { amount: 800000, sourceRef: 'private:verified-q12' } };
    expect(both(sonokong).map(r => [r.state, r.ruleId, r.amount])).toEqual([['CALCULATED', 'SONOKONG_SUBSCRIPTION_60_BILLING', 1400000], ['CALCULATED', 'SONOKONG_SUBSCRIPTION_60_PAYOUT', 800000]]);
    // 합성 예: Q12 1,000,000 → 청구 1,600,000 · 지급 1,000,000.
    expect(both({ ...sonokong, q12Basis: { amount: 1000000, sourceRef: 'private:verified-q12' } }).map(r => r.amount)).toEqual([1600000, 1000000]);
    expect(both({ ...sonokong, termMonths: 24, subscriptionForm: 'RETURN' }).every(r => r.reasonCode === 'RETURN_SUBSCRIPTION_TERM_NOT_SUPPORTED')).toBe(true);
    // 합성 예: VAT 포함 금액 ÷ 1.1, 원 단위 반올림(…5 이상 올림·미만 버림).
    expect(resolveSupplierBillingFee({ ...base, supplierId: 'RP018', productType: '재렌트', monthlyRent: 612000 })).toMatchObject({ state: 'CALCULATED', amount: 556364, vatAmount: 55636, totalAmount: 612000 });
    expect(resolveSupplierBillingFee({ ...base, supplierId: 'RP018', productType: '재렌트', monthlyRent: 570000 })).toMatchObject({ state: 'CALCULATED', amount: 518182, vatAmount: 51818, totalAmount: 570000 });
    for (const termMonths of [12, 24, 48]) for (const supplierId of ['RP021', 'PT-0026'])
      expect(both({ ...base, supplierId, productType: '구독', termMonths }).every(r => r.state === 'UNKNOWN' && r.reasonCode === 'BILLIN_36_MONTH_RENT_REQUIRED')).toBe(true);
  });
});

describe('F04 source references and term scope (2026-10-04 review)', () => {
  const F04_REF = /^(F04:수수료표!A[1-9][0-9]*:M[1-9][0-9]*|USER:2026-10-09:BILLIN_LC_36_MONTH_RENT_100_80)$/;
  it('every Kakao commission sourceRef matches the reference schema pattern (no catalog/private refs leak in)', () => {
    const suppliers = ['RP004', 'RP006', 'RP008', 'RP010', 'RP012', 'RP013', 'RP014', 'RP018', 'RP021', 'RP022', 'RP023', 'RP031', 'RP033', 'RP034', 'PT-0026', 'XX-9999'];
    const products = ['신차렌트', '중고렌트', '재렌트', '장기렌트', '선출고', '견적출고', '중고구독', '신차구독', '오공구독', '픽업구독', '신차발주'];
    let checked = 0;
    for (const supplierId of suppliers) for (const productType of products) for (const termMonths of [1, 6, 12, 24, 36, 48, 60, 72])
      for (const r of [resolveSupplierBillingFee, resolveSalesCommission].map((f) => f({ supplierId, productType, fuel: '가솔린', termMonths, monthlyRent: 500000 }))) {
        if (r.state === 'CALCULATED') {
          expect(r.sourceRefs?.length).toBeGreaterThan(0);
          for (const ref of r.sourceRefs ?? []) expect(ref).toMatch(F04_REF);
        } else {
          // UNKNOWN·NOT_APPLICABLE·협의는 근거 행 없이 사유 코드만
          expect(r.sourceRefs).toBeUndefined();
        }
        checked++;
      }
    expect(checked).toBe(16 * 11 * 8 * 2);
  });
  it('unregistered suppliers and Mindcar carry no F04 row reference', () => {
    for (const supplierId of ['XX-9999', 'RP034']) for (const f of [resolveSupplierBillingFee, resolveSalesCommission]) {
      const r = f({ supplierId, productType: '중고렌트', fuel: '가솔린', termMonths: 36, monthlyRent: 500000 });
      expect(r.state).not.toBe('CALCULATED');
      expect(r.sourceRefs).toBeUndefined();
    }
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

describe('뮤카 RP035 구독 — F04 169·170행(DEC-2026-10-04-01 8번)', () => {
  const base = { supplierId: 'RP035', productType: '구독', termMonths: 24, monthlyRent: 700000, vehicleValue: 40000000 };
  it('청구(프리패스 몫) = 차량 기준가 × 1%, 전 기간; 기준가 없으면 모름', () => {
    for (const termMonths of [12, 24, 36, 48]) expect(resolveSupplierBillingFee({ ...base, termMonths })).toMatchObject({ state: 'CALCULATED', ruleId: 'MEWCAR_FREEPASS_SHARE_BILLING', amount: 400000, vatTreatment: 'EXCLUDED' });
    { const { vehicleValue: _omit, ...noBase } = base; expect(resolveSupplierBillingFee(noBase)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'MEWCAR_BASE_PRICE_REQUIRED' }); }
  });
  it('지급(영업 GA) = 선납/분납 × 기간 정액 + min(추가보증금 × 10%, 40만)', () => {
    const pay = (over: object) => resolveSalesCommission({ ...base, ...over });
    expect(pay({ termMonths: 12, depositPayment: 'PREPAID', extraDeposit: 0 })).toMatchObject({ ruleId: 'MEWCAR_GA_PREPAID_12_PAYOUT', amount: 1000000 });
    expect(pay({ termMonths: 48, depositPayment: 'PREPAID', extraDeposit: 1000000 })).toMatchObject({ amount: 1300000 });
    // 분납은 효력일(2026-10-05) 전 계약만 옛 정액으로 계산한다.
    expect(pay({ termMonths: 12, depositPayment: 'INSTALLMENT', extraDeposit: 2000000, contractDate: '2026-10-04' })).toMatchObject({ ruleId: 'MEWCAR_GA_INSTALLMENT_12_PAYOUT', amount: 1000000 });
    expect(pay({ termMonths: 36, depositPayment: 'INSTALLMENT', extraDeposit: 9000000, contractDate: '2026-09-30' })).toMatchObject({ amount: 1400000 }); // 가산 상한 40만
  });
  it('선납/분납·추가보증금을 모르면 계산하지 않고(0 으로 두지 않음), 기간 밖·구독 아님도 모름', () => {
    expect(resolveSalesCommission({ ...base, extraDeposit: 0 })).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: 'MEWCAR_DEPOSIT_PAYMENT_REQUIRED' });
    expect(resolveSalesCommission({ ...base, depositPayment: 'PREPAID' })).toMatchObject({ state: 'UNKNOWN', reasonCode: 'MEWCAR_EXTRA_DEPOSIT_REQUIRED' });
    expect(resolveSalesCommission({ ...base, termMonths: 60, depositPayment: 'PREPAID', extraDeposit: 0 })).toMatchObject({ state: 'UNKNOWN', reasonCode: 'MEWCAR_TERM_NOT_IN_POLICY' });
    expect(resolveSupplierBillingFee({ ...base, productType: '재렌트' })).toMatchObject({ state: 'UNKNOWN', reasonCode: 'MEWCAR_SUBSCRIPTION_ONLY' });
  });
  it('2026-10-05 이후 신규 분납 계약은 계산하지 않고 «확인 필요»로 멈춘다(계약일 모르면 멈춤, 선납·청구는 그대로)', () => {
    const pay = (over: object) => resolveSalesCommission({ ...base, ...over });
    for (const contractDate of ['2026-10-05', '2026-10-06', '2027-01-01']) {
      expect(pay({ depositPayment: 'INSTALLMENT', extraDeposit: 0, contractDate })).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: 'MEWCAR_INSTALLMENT_ABOLISHED_CONFIRM_REQUIRED' });
    }
    // 달력에 없는 날은 Date.parse 보정으로 통과하면 안 된다(옛 정액을 내지 않는다).
    for (const contractDate of ['2026-02-29', '2026-04-31', '2026-09-31', '2026-02-30', '2026-00-10', '2026-10-00']) {
      expect(pay({ depositPayment: 'INSTALLMENT', extraDeposit: 0, contractDate })).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: 'MEWCAR_CONTRACT_DATE_REQUIRED' });
    }
    // 실제 있는 날(윤일 포함)은 통과
    expect(pay({ depositPayment: 'INSTALLMENT', extraDeposit: 0, contractDate: '2024-02-29' })).toMatchObject({ state: 'CALCULATED', ruleId: 'MEWCAR_GA_INSTALLMENT_24_PAYOUT' });
    for (const contractDate of [undefined, '', '2026-10-5', '2026-13-01', 'x']) {
      expect(pay({ depositPayment: 'INSTALLMENT', extraDeposit: 0, contractDate })).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: 'MEWCAR_CONTRACT_DATE_REQUIRED' });
    }
    // 선납 정액·추가보증금 10%(40만 한도)·프리패스 1% 는 계약일과 무관하게 그대로
    expect(pay({ depositPayment: 'PREPAID', extraDeposit: 0, contractDate: '2026-10-06' })).toMatchObject({ ruleId: 'MEWCAR_GA_PREPAID_24_PAYOUT', amount: 1200000 });
    expect(pay({ depositPayment: 'PREPAID', extraDeposit: 9000000, contractDate: '2026-10-06' })).toMatchObject({ amount: 1600000 });
    expect(resolveSupplierBillingFee({ ...base, contractDate: '2026-10-06' })).toMatchObject({ state: 'CALCULATED', amount: 400000 });
  });
  it('개별 예외 표시가 있으면 일반 정액을 내지 않는다', () => {
    const r = resolveSalesCommission({ ...base, depositPayment: 'PREPAID', extraDeposit: 0, individualException: true });
    expect(r).toMatchObject({ state: 'UNKNOWN', amount: null, reasonCode: 'INDIVIDUAL_EXCEPTION_EVIDENCE_REQUIRED' });
  });
  it('별도 재원이라 청구 − 지급 마진을 만들지 않고, 근거 행은 169·170', () => {
    const b = resolveSupplierBillingFee(base), p = resolveSalesCommission({ ...base, depositPayment: 'PREPAID', extraDeposit: 0 });
    expect(resolveExpectedGrossMargin(b, p)).toMatchObject({ state: 'NOT_APPLICABLE', amount: null, reasonCode: 'SEPARATE_FUNDING_NO_MARGIN' });
    expect(resolveExpectedGrossMargin(b, resolveSalesCommission(base))).toMatchObject({ state: 'NOT_APPLICABLE' });
    expect(b.sourceRefs).toEqual(['F04:수수료표!A169:M169', 'F04:수수료표!A170:M170']);
  });
});

describe('정책을 올려도 이미 저장된 기간별 수수료는 조용히 바뀌지 않는다', () => {
  it('reading stored economics keeps the old policy ID and amount; only an explicit recompute produces the new policy', () => {
    // 합성 상품: 일반 재렌트 24개월(정책 10-04·10-05 모두 같은 규칙) — 저장 당시 정책 ID 만 옛 것으로 둔다.
    const offer: any = { id: 'synthetic', supplierId: 'RP013', priceTerms: [{ termKey: '24', termMonths: 24, monthlyRent: { amount: 1000000, currency: 'KRW' }, depositState: 'UNKNOWN' }] };
    const stored = precomputeOfferEconomics(offer, 'USED_RENT');
    for (const side of ['supplierBillingFee', 'channelPayoutFee'] as const) stored[0]![side] = { ...stored[0]![side], policyId: KAKAO_COMMISSION_POLICY_2026_10_04.policyId };
    offer.internalEconomicsTerms = stored;
    const read = readStoredTermFees(offer, offer.priceTerms[0]);
    expect(read.supplierBillingFee).toMatchObject({ state: 'KNOWN', policyId: 'sales-commission-2026-10-04', amount: { amount: 1140000 } });
    expect(read.channelPayoutFee).toMatchObject({ state: 'KNOWN', policyId: 'sales-commission-2026-10-04', amount: { amount: 960000 } });
    // 새 정책 값은 명시적 재계산 때만.
    expect(precomputeOfferEconomics(offer, 'USED_RENT')[0]!.supplierBillingFee.policyId).toBe('sales-commission-2026-10-09');
    expect(offer.internalEconomicsTerms[0].supplierBillingFee.policyId).toBe('sales-commission-2026-10-04');
  });
});


describe('general reference query', () => {
  it('keeps all products by default and intersects every term condition on one term', () => {
    const ref = buildKakaoCatalogReference({consumerId:'kakao-ops',observedAt:new Date().toISOString(),products:{a:{listable:true,provider_company_code:'RP013',maker:'Maker',model:'Model',price:{'36':{rent:500000,deposit:1000000},'48':{rent:400000,deposit:null}}}}});
    const apply = (q: Record<string,unknown>) => filterReferenceZeroDeposit(ref,q);
    expect(apply({})).toBe(ref);
    for (const q of [{supplierId:'RP013'},{maker:'Maker'},{model:'Model'},{commercialType:ref.data[0]!.commercialType!},{termMonths:'36'},{monthlyRentMin:'500000'},{depositState:'KNOWN'},{depositState:'UNKNOWN'},{depositMin:'1000000'}]) expect(apply(q).data).toHaveLength(1);
    expect(apply({supplierId:'RP013',maker:'Maker',termMonths:'36',monthlyRentMin:'500000',depositMin:'1000000',depositState:'KNOWN'}).data[0]!.offers).toEqual(ref.data[0]!.offers);
    expect(apply({termMonths:'48',monthlyRentMin:'500000'}).data).toEqual([]);
    expect(apply({depositState:'UNKNOWN',depositMax:'0'}).data).toEqual([]);
    expect(apply({depositState:'ZERO'}).data).toEqual([]);
    expect(apply({supplierId:'absent'}).data).toEqual([]);
    const t = ref.data[0]!.offers[0]!.priceTerms[0]!;
    t.contractedMileage={km:1000,period:'month'};
    expect(apply({termMonths:'36',mileageKm:'1000',mileagePeriod:'month'}).data).toHaveLength(1);
    expect(apply({termMonths:'36',mileageKm:'1000',mileagePeriod:'year'}).data).toEqual([]);
    for(const q of [{limit:'1'},{cursor:'x'},{unknown:'x'},{model:['Model']},{monthlyRentMin:'-1'},{depositMin:'10',depositMax:'1'},{mileageKm:'1000'},{mileagePeriod:'week'},{maker:' '}]) expect(()=>apply(q)).toThrow('REFERENCE_DEPOSIT_FILTER_INVALID');
  });
});

describe('complete reference product ID lookup', () => {
  const makeReference = () => buildKakaoCatalogReference({ consumerId: 'kakao-ops', observedAt: '2026-10-11T00:00:00Z', products: {
    a: { listable: true, provider_company_code: 'RP013', provider_name: 'Synthetic Supplier', car_number: '123가4567',
      price: { '36': { rent: 500000, deposit: 1000000 }, '48': { rent: 400000, deposit: null } } },
    b: { listable: true, provider_company_code: 'RP012', provider_name: 'Other Supplier', car_number: '123나4567',
      price: { '36': { rent: 600000, deposit: null } } },
  } });
  it('matches the whole returned ID, preserves sibling offers/terms and never changes the input', () => {
    const ref = makeReference(), target = ref.data[0]!;
    target.offers.push({ ...structuredClone(target.offers[0]!), offerId: 'sibling-offer', supplierId: 'RP012', supplierName: 'Other Supplier' });
    const unchanged = structuredClone(ref);
    const result = filterReferenceZeroDeposit(ref, { productId: target.productId, supplierId: 'RP013', supplierName: 'Synthetic Supplier', plateNumber: '123가4567', termMonths: '36', monthlyRentMin: '500000' });
    expect(result.data).toEqual([target]);
    expect(result.meta).toMatchObject({ projectedCount: 1, queryResolution: { state: 'MATCHED', reasonCode: null } });
    expect(ref).toEqual(unchanged);
    for (const productId of ['a', 'RP013', '123가4567', 'reference_', 'reference_missing']) {
      const empty = filterReferenceZeroDeposit(ref, { productId });
      expect(empty.data).toEqual([]);
      expect(empty.meta).toMatchObject({ queryResolution: { state: 'NO_MATCH', reasonCode: null } });
    }
    for (const productId of ['', ' ', ' reference_a', 'reference_a ', ['reference_a'], 1])
      expect(() => filterReferenceZeroDeposit(ref, { productId })).toThrow('REFERENCE_DEPOSIT_FILTER_INVALID');
  });
  it('keeps duplicate IDs on HOLD even when a supplier filter narrows the result', () => {
    const ref = makeReference();
    ref.data[1]!.productId = ref.data[0]!.productId;
    const result = filterReferenceZeroDeposit(ref, { productId: ref.data[0]!.productId });
    expect(result.data).toHaveLength(2);
    expect(result.meta).toMatchObject({ queryResolution: { state: 'HOLD', reasonCode: 'PRODUCT_ID_MULTIPLE_PRODUCTS', matchedProductCount: 2 } });
    const narrowed = filterReferenceZeroDeposit(ref, { productId: ref.data[0]!.productId, supplierId: 'RP013' });
    expect(narrowed.data).toHaveLength(1);
    expect(narrowed.meta).toMatchObject({ queryResolution: { state: 'HOLD', reasonCode: 'PRODUCT_ID_MULTIPLE_PRODUCTS' } });
  });
  it('holds conflicting plate/supplier identity without substituting another product; term misses stay NO_MATCH', () => {
    const ref = makeReference(), productId = ref.data[0]!.productId;
    for (const query of [{ productId, plateNumber: '123나4567' }, { productId, supplierId: 'RP012' }, { productId, supplierName: 'Other Supplier' }]) {
      const result = filterReferenceZeroDeposit(ref, query);
      expect(result.data).toEqual([]);
      expect(result.meta).toMatchObject({ queryResolution: { state: 'HOLD', reasonCode: 'PRODUCT_ID_IDENTITY_CONFLICT', matchedProductCount: 0 } });
    }
    const miss = filterReferenceZeroDeposit(ref, { productId, plateNumber: '123가4567', termMonths: '60' });
    expect(miss.data).toEqual([]);
    expect(miss.meta).toMatchObject({ queryResolution: { state: 'NO_MATCH', reasonCode: null } });
  });
});

describe('supplier and plate exact lookup', () => {
  it('normalizes lookup only, keeps every term and returns ambiguous candidates with HOLD', () => {
    const name='경진 렌트',plate='000가0000';
    const base={listable:true,provider_company_code:'RP013',provider_name:name,car_number:plate,price:{'36':{rent:500000,deposit:1000000},'48':{rent:400000,deposit:null}}};
    const ref=buildKakaoCatalogReference({consumerId:'kakao-ops',observedAt:new Date().toISOString(),products:{a:base,b:{...base,car_number:'000나0000'}}});
    const apply=(q:Record<string,unknown>)=>filterReferenceZeroDeposit(ref,q);
    expect(apply({supplierName:' 경진렌트 '}).data).toHaveLength(2);
    const result=apply({plateNumber:' 000 가-0000 '});
    expect(result.data).toHaveLength(1);expect(result.data[0]!.offers).toEqual(ref.data[0]!.offers);
    expect(result.data[0]!.vehicle.plateNumber).toBe(plate);
    expect(apply({supplierName:'unknown'}).data).toEqual([]);
    expect(apply({plateNumber:'000하0000'}).data).toEqual([]);
    for(const q of [{plateNumber:'3456'},{plateNumber:'new'},{plateNumber:[plate]},{supplierName:['a']}])expect(()=>apply(q)).toThrow('REFERENCE_DEPOSIT_FILTER_INVALID');
    const duplicate=buildKakaoCatalogReference({consumerId:'kakao-ops',observedAt:new Date().toISOString(),products:{a:base,b:{...base,provider_company_code:'RP020'}}});
    const matched=filterReferenceZeroDeposit(duplicate,{plateNumber:plate});expect(matched.data).toHaveLength(2);
    expect((matched.meta as typeof matched.meta & {queryResolution:unknown}).queryResolution).toMatchObject({state:'HOLD',reasonCode:'PLATE_MULTIPLE_PRODUCTS'});
    const supplier=filterReferenceZeroDeposit(duplicate,{supplierName:name});expect(supplier.data).toHaveLength(2);
    expect((supplier.meta as typeof supplier.meta & {queryResolution:unknown}).queryResolution).toMatchObject({state:'HOLD',reasonCode:'SUPPLIER_NAME_MULTIPLE_CODES'});
    expect(filterReferenceZeroDeposit(duplicate,{supplierName:name,supplierId:'RP013'}).data).toHaveLength(1);
    const narrowed=filterReferenceZeroDeposit(duplicate,{plateNumber:plate,supplierId:'RP013'});
    expect((narrowed.meta as typeof narrowed.meta & {queryResolution:unknown}).queryResolution).toMatchObject({state:'MATCHED',matchedProductCount:1});
    const empty=filterReferenceZeroDeposit(duplicate,{plateNumber:plate,termMonths:'24'});
    expect((empty.meta as typeof empty.meta & {queryResolution:unknown}).queryResolution).toMatchObject({state:'NO_MATCH',reasonCode:null,matchedProductCount:0});
    duplicate.data[1]!.offers[0]!.priceTerms=duplicate.data[1]!.offers[0]!.priceTerms.filter(t=>t.termMonths!==36);
    const byTerm=filterReferenceZeroDeposit(duplicate,{supplierName:name,termMonths:'36'});
    expect((byTerm.meta as typeof byTerm.meta & {queryResolution:unknown}).queryResolution).toMatchObject({state:'MATCHED',matchedProductCount:1});

  });
});

it('keeps all 24 explicit mileage keys independently of supplier codes and phase-one metadata',()=>{
  const keys=[...[1,3,5].flatMap(m=>[2000,3000,4000].map(k=>`${m}_월${k}km`)),...[12,24,36,48,60].flatMap(m=>[20000,30000,40000].map(k=>`${m}_연${k}km`))];
  const price=Object.fromEntries(keys.map(k=>[k,{rent:500000,deposit:1000000}]));
  const product=buildKakaoCatalogReferenceProduct('synthetic',{listable:true,provider_company_code:'FUTURE_IMMUTABLE_ID',price})!;
  const terms=product.offers[0]!.priceTerms;expect(terms).toHaveLength(24);
  expect(new Set(terms.map(t=>t.termKey))).toEqual(new Set(keys.map(k=>'source:'+k)));
  for(const t of terms){expect(t.monthlyRent.amount).toBe(500000);expect(t.contractedMileage).toBeDefined();if(t.contractedMileage!.period==='month')expect(t.mileageLimitKmPerYear).toBeNull();else expect(t.mileageLimitKmPerYear).toBe(t.contractedMileage!.km);}
});

it('never borrows a Billin36 monthly basis from a different mileage or period',()=>{
  const make=(key:string)=>buildKakaoCatalogReferenceProduct('synthetic',{listable:true,provider_company_code:'RP021',product_type:'구독',price:{[key]:{rent:400000,deposit:1000000},'24_월1500km':{rent:500000,deposit:1000000}}})!.offers[0]!.priceTerms.find(t=>t.termMonths===24)!;
  for(const key of ['36_월3000km','36_연1500km'])expect(make(key).supplierBillingFee).toMatchObject({state:'UNKNOWN',reasonCode:'BILLIN_36_MONTH_RENT_REQUIRED'});
  const same=make('36_월1500km');expect(same.supplierBillingFee).toMatchObject({state:'CALCULATED',amount:400000});expect(same.channelPayoutFee.amount).toBe(320000);
});

it('F04 source identity is lazy, required when recorded, and follows the configured ID', async () => {
  const { KAKAO_COMMISSION_POLICY } = await import('../src/application/kakao-catalog-reference.js');
  const previous = process.env.FREEPASS_SHEET_F04_ID;
  try {
    delete process.env.FREEPASS_SHEET_F04_ID;
    expect(KAKAO_COMMISSION_POLICY.policyId).toBeTruthy();
    expect(() => JSON.stringify(KAKAO_COMMISSION_POLICY)).toThrow('MISSING_SHEET_ID_ENV: FREEPASS_SHEET_F04_ID');
    process.env.FREEPASS_SHEET_F04_ID = '  test-configured-f04  ';
    expect(KAKAO_COMMISSION_POLICY.sourceFiles[0].id).toBe('test-configured-f04');
  } finally {
    if (previous === undefined) delete process.env.FREEPASS_SHEET_F04_ID;
    else process.env.FREEPASS_SHEET_F04_ID = previous;
  }
});

describe('collected reference scope preserves non-sellable and missing source conditions', () => {
  const base = { provider_company_code: 'TEMP_A', provider_name: '같은공급사', maker: 'fixture', car_number: '123가4567', status_kind: '불가', engine_cc: 1998 };
  const input = { consumerId: 'kakao-ops', observedAt: '2026-10-10T00:00:00Z', products: {
    sold: { ...base, listable: true, price: { '36': { rent: 500000, deposit: null } } },
    blocked: { ...base, listable: false, customer_name: 'private-customer', password: 'private-secret', price: { '12': { rent: 400000, deposit: 1000000, customer: 'private-customer' }, '36': { rent: null, deposit: null, token: 'private-secret' }, 'bad-key': { rent: 'unknown' } } },
    missing: { ...base, listable: false, price: null },
    unknownSupplier: { ...base, provider_company_code: '', listable: null, price: { '24_3만': { rent: null, deposit: 0 } } },
  } };
  it('retains every source ID and original row evidence with no fabricated zero or offer', () => {
    const original = structuredClone(input);
    expect(buildKakaoCatalogReference(input).data.map(p => p.sourceProductId)).toEqual(['sold']);
    const r = buildKakaoCatalogReference({ ...input, sourceScope: 'COLLECTED' });
    expect(r.data).toHaveLength(4); expect(input).toEqual(original);
    expect(JSON.stringify(r)).not.toContain('private-customer');
    expect(JSON.stringify(r)).not.toContain('private-secret');
    const blocked = r.data.find(p => p.sourceProductId === 'blocked')!;
    expect(blocked.sourceRecord).toMatchObject({ listable: false, status: '불가', conditionState: 'HOLD', reasonCode: 'SOURCE_PRICE_CONDITIONS_PARTIAL', publicationDecision: 'HOLD' });
    expect(blocked.sourceRecord!.priceConditions).toHaveLength(3);
    expect(blocked.sourceRecord!.priceConditions.find(t => t.sourceKey === '36')).toMatchObject({ termMonths: 36, monthlyRentSourceValue: null, depositSourceValue: null, state: 'HOLD' });
    expect(blocked.sourceRecord!.priceConditions.find(t => t.sourceKey === 'bad-key')!.termMonths).toBeNull();
    const missing = r.data.find(p => p.sourceProductId === 'missing')!;
    expect(missing.offers[0]!.priceTerms).toEqual([]);
    expect(missing.sourceRecord).toMatchObject({ reasonCode: 'SOURCE_PRICE_CONDITIONS_MISSING', priceConditions: [] });
    expect(r.data.find(p => p.sourceProductId === 'unknownSupplier')!.offers).toEqual([]);
    expect(r.data.find(p => p.sourceProductId === 'unknownSupplier')!.sourceRecord!.priceConditions[0]).toMatchObject({
      termMonths: 24, contractedMileage: { km: 30000, period: 'year' }, depositSourceValue: 0, depositAmount: null, depositState: 'UNKNOWN',
      monthlyRentAmount: null, monthlyRentState: 'UNKNOWN', supplierBillingFee: { state: 'UNKNOWN', amount: null }, channelPayoutFee: { state: 'UNKNOWN', amount: null },
    });
    expect(blocked.vehicle).toMatchObject({ engineCc: 1998, engineCcState: 'KNOWN' });
    expect(r.meta).toMatchObject({ sourceScope: 'COLLECTED', authority: 'REFERENCE_ONLY', publicationDecision: 'HOLD' });
  });
  it('finds price-less vehicles and ambiguous plates; period-only lookup retains missing rent evidence', () => {
    const r = buildKakaoCatalogReference({ ...input, sourceScope: 'COLLECTED' });
    const exact = filterReferenceZeroDeposit(r, { sourceScope: 'COLLECTED', plateNumber: '123가4567', supplierName: '같은공급사' });
    expect(exact.data).toHaveLength(4);
    expect(exact.meta).toMatchObject({ queryResolution: { state: 'HOLD', reasonCode: 'PLATE_MULTIPLE_PRODUCTS' } });
    const period = filterReferenceZeroDeposit(r, { sourceScope: 'COLLECTED', termMonths: '36' });
    expect(period.data.map(p => p.sourceProductId)).toEqual(['blocked', 'sold']);
    expect(filterReferenceZeroDeposit(r, { sourceScope: 'COLLECTED', termMonths: '36', monthlyRentMax: '450000' }).data).toEqual([]);
    expect(filterReferenceZeroDeposit(r, { sourceScope: 'COLLECTED', depositState: 'ZERO' }).data).toEqual([]);
  });
  it('requires collected metadata and missing-condition reason without loosening default nonempty offers', () => {
    const schema = JSON.parse(readFileSync(new URL('../contracts/kakao-catalog-reference-v1.schema.json', import.meta.url), 'utf8'));
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
    const r = buildKakaoCatalogReference({ ...input, sourceScope: 'COLLECTED' });
    expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
    const bad = structuredClone(r); delete bad.meta.sourceScope;
    expect(validate(bad)).toBe(false);
    const unknown = structuredClone(r); unknown.data.find(p => p.sourceProductId === 'missing')!.sourceRecord!.reasonCode = null;
    expect(validate(unknown)).toBe(false);
    const normal = buildKakaoCatalogReference(input); normal.data[0]!.offers[0]!.priceTerms = [];
    expect(validate(normal)).toBe(false);
  });
});
