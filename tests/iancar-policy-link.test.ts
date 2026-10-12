import { describe, expect, it } from 'vitest';
import { buildPolicyLinkPlan, extractVehicleTerms, iancarPolicyFields, IANCAR_COMMON_POLICY_CODE, type PolicyLinkInput, type VehicleTerms } from '../src/domain/iancar-policy-link.js';

const policy = (over: Record<string, unknown> = {}) => ({ exists: true, updateTimeMs: 1000, data: { basic_driver_age: '만 26세 이상', driver_age_upper_limit: '만 70세 이하', annual_mileage: '연 30,000km',
  license_period: '제한없음', injury_deductible: '50만원', property_deductible: '50만원', own_damage_min_deductible: '50만원', own_damage_max_deductible: '100만원',
  policy_default_pack: 'freepass-common-rent-2026-08-14-v1', created_by: 'codex:freepass-common-policy', ...over } });
const product = (id: string, over: Record<string, unknown> = {}, updateTimeMs = 2000) => ({ id, updateTimeMs, data: { provider_company_code: 'RP031', listable: true, policy_code: null, policy_code_source_original: 'RP031_S01', policy_reference_state: 'DEFERRED', ...over } });
const terms = (over: Partial<VehicleTerms> = {}): VehicleTerms => ({ source: 'ONE_RATES', observedAt: '2026-10-12T00:00:00Z', minimumDriverAge: 26, maximumDriverAge: 65, minimumLicenseMonths: 12,
  ownDamageIncluded: true, ownDamageDeductible: 500000, ownDamageMinimumFaultPercent: 30, personalInjuryDeductible: 500000, propertyDamageDeductible: 500000, repairLimit: 5000000,
  age24Surcharge: 60000, perPanelRepair: 300000, excessMileageFeePerKm: 100, dailyLossOrLateReturnFeeByTerm: { '1_월2000km': 130000 }, vatIncluded: true, ...over });
const input = (over: Partial<PolicyLinkInput> = {}): PolicyLinkInput => ({ policy: policy(), products: [product('a'), product('b', { policy_code_source_original: 'RP031_S03' }), product('c', { listable: false })],
  vehicleTerms: { a: terms(), b: terms({ ownDamageDeductible: 1000000, repairLimit: 8000000, excessMileageFeePerKm: 300, age24Surcharge: '불가', perPanelRepair: 500000 }) }, ...over });

const row = (over: Record<string, unknown> = {}, period = 12) => ({ rental_period: period, mileage_period: 'year', contracted_mileage: 20000, monthly_rate: 1, deposit: 1, excess_mileage_fee: 100, vat_included: true,
  insurance: { minimum_driver_age: 26, maximum_driver_age: 65, minimum_license_months: 12, own_damage_included_in_rental: true, deductible_minimum_own_fault_percent: 30, personal_injury_deductible: 500000,
    property_damage_deductible: 500000, own_damage_deductible: 500000, repair_limit: 5000000, age_24_surcharge: 60000, monthly_premium: null },
  additional_charges: { per_panel_repair: 300000, daily_loss_or_late_return_fee: 130000 }, ...over });

describe('원천 요금 행 → 차량 조건', () => {
  it('보험·추가요금이 행마다 같으면(휴차료만 행별) 차량 조건으로 뽑고 휴차료는 기간별로 보존', () => {
    const r = extractVehicleTerms([row({}, 12), row({ additional_charges: { per_panel_repair: 300000, daily_loss_or_late_return_fee: 150000 } }, 24)], '2026-10-12T00:00:00Z');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.terms).toMatchObject({ minimumDriverAge: 26, maximumDriverAge: 65, minimumLicenseMonths: 12, ownDamageDeductible: 500000, repairLimit: 5000000, excessMileageFeePerKm: 100, age24Surcharge: 60000 });
      expect(r.terms.dailyLossOrLateReturnFeeByTerm).toEqual({ '12_연20000km': 130000, '24_연20000km': 150000 });
    }
  });
  it('행마다 보험·초과 주행 요금이 다르거나 필드가 비정상이면 추정하지 않고 오류', () => {
    expect(extractVehicleTerms([row({}, 12), row({ excess_mileage_fee: 200 }, 24)], 't')).toEqual({ ok: false, reason: 'ROWS_INCONSISTENT' });
    expect(extractVehicleTerms([], 't')).toEqual({ ok: false, reason: 'RATES_EMPTY_OR_INVALID' });
    expect(extractVehicleTerms([row({ insurance: { minimum_driver_age: 26 } })], 't')).toMatchObject({ ok: false });
    expect(extractVehicleTerms([row({ additional_charges: { per_panel_repair: 1, daily_loss_or_late_return_fee: 'x' } })], 't')).toEqual({ ok: false, reason: 'DAILY_LOSS_FEE_INVALID' });
  });
});

describe('이안카 정책 연결 계획', () => {
  it('노출 이안카만 공통 정책에 연결하고 연결 전 값은 보존, 차량별 조건을 상품 문서에 붙인다(삭제 0)', () => {
    const plan = buildPolicyLinkPlan(input());
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toMatchObject({ listableTargets: 2, toLink: 2, termsFromSource: 2, withoutSourceTerms: 0, skipped: 0, deletes: 0 });
    expect(plan.productPatches.map(p => p.id)).toEqual(['a', 'b']);                       // 비노출 c 는 건드리지 않음
    for (const patch of plan.productPatches) expect(patch.patch).toMatchObject({ policy_code: IANCAR_COMMON_POLICY_CODE, policy_reference_state: 'LINKED' });
    expect('policy_code_source_original' in plan.productPatches[0]!.patch).toBe(false);
    expect((plan.productPatches[1]!.patch.iancar_policy_terms as VehicleTerms).ownDamageDeductible).toBe(1000000);   // 차량별 값 보존
  });
  it('모든 차량이 같은 값이면 공통 정책에 원천 값을 반영(연령 상한 65·면허 1년·연 2만km), 차량마다 다르면 공통에 넣지 않고 분포만 기록', () => {
    const plan = buildPolicyLinkPlan(input());
    expect(plan.policyPatch).toMatchObject({ annual_mileage: '연 20,000km', driver_age_upper_limit: '만 65세 이하', license_period: '1년 이상' });
    expect('basic_driver_age' in plan.policyPatch).toBe(false);                            // 이미 만 26세 이상
    expect('injury_deductible' in plan.policyPatch).toBe(false);                           // 이미 50만원
    const varies = (plan.policyPatch.iancar_source_terms as any).variesAcrossVehicles;
    expect(Object.keys(varies).sort()).toEqual(['age24Surcharge', 'excessMileageFeePerKm', 'ownDamageDeductible', 'perPanelRepair', 'repairLimit']);
    expect((plan.policyPatch.iancar_source_terms as any)).toMatchObject({ vehiclesRead: 2, observedAt: '2026-10-12T00:00:00Z' });
    expect(plan.policyPatch.own_damage_min_deductible).toBeUndefined();                    // 50~100만원 범위가 이미 같음
  });
  it('보험 차이가 있으면 공통 정책 자차 면책 범위를 최소~최대로만 둔다', () => {
    const plan = buildPolicyLinkPlan(input({ policy: policy({ own_damage_min_deductible: '30만원', own_damage_max_deductible: '50만원' }) }));
    expect(plan.policyPatch).toMatchObject({ own_damage_min_deductible: '50만원', own_damage_max_deductible: '100만원' });
  });
  it('원천에 없는 차량(사라진 차)도 연결하되 차량 조건은 붙이지 않고 사유를 표시', () => {
    const plan = buildPolicyLinkPlan(input({ vehicleTerms: { a: terms() }, vehicleTermsErrors: { b: 'NOT_IN_SOURCE' } }));
    expect(plan.counts).toMatchObject({ toLink: 2, termsFromSource: 1, withoutSourceTerms: 1 });
    expect(plan.withoutSourceTerms).toEqual([{ id: 'b', reason: 'NOT_IN_SOURCE' }]);
    expect('iancar_policy_terms' in plan.productPatches[1]!.patch).toBe(false);
  });
  it('원천 조회가 401·429·형식 오류로 실패하면(404 아님) 계획을 막고, 전부 못 읽어도 막는다(fail-closed)', () => {
    for (const reason of ['IANCAR_ONE_API_HTTP_401', 'IANCAR_ONE_API_HTTP_429', 'ROWS_INCONSISTENT']) {
      const partial = buildPolicyLinkPlan(input({ vehicleTerms: { a: terms() }, vehicleTermsErrors: { b: reason } }));
      expect(partial.blockers).toContain('SOURCE_LOOKUP_FAILED(1)');
    }
    const none = buildPolicyLinkPlan(input({ vehicleTerms: {}, vehicleTermsErrors: { a: 'IANCAR_ONE_API_HTTP_401', b: 'IANCAR_ONE_API_HTTP_401' } }));
    expect(none.blockers).toEqual(expect.arrayContaining(['SOURCE_LOOKUP_FAILED(2)', 'NO_SOURCE_TERMS_READ']));
    expect(buildPolicyLinkPlan(input({ vehicleTerms: {}, vehicleTermsErrors: {} })).blockers).toContain('NO_SOURCE_TERMS_READ');
  });
  it('정책 문서 변경 건수를 계획에 싣고(변경 있으면 1, 없으면 0), 허용 목록 밖 칸이 바뀌면 막는다', () => {
    expect(buildPolicyLinkPlan(input()).counts.policyDocumentChanges).toBe(1);
    const settled = buildPolicyLinkPlan(input());
    const same = buildPolicyLinkPlan(input({ policy: policy({ ...settled.policyPatch }) }));
    expect(same.counts.policyDocumentChanges).toBe(0);
    expect(settled.blockers).not.toContain('POLICY_PATCH_FIELD_NOT_ALLOWED');
  });
  it('공통 필수 조건(연령 상한·면허 기간 등)이 차량마다 다르면 연결을 막는다(기존 공통 값이 남은 채 전 차량 연결 금지)', () => {
    const plan = buildPolicyLinkPlan(input({ vehicleTerms: { a: terms({ maximumDriverAge: 65, minimumLicenseMonths: 12 }), b: terms({ maximumDriverAge: 60, minimumLicenseMonths: 24 }) } }));
    expect(plan.blockers).toEqual(expect.arrayContaining(['COMMON_CONDITION_VARIES(maximumDriverAge)', 'COMMON_CONDITION_VARIES(minimumLicenseMonths)']));
    expect(buildPolicyLinkPlan(input()).blockers).toEqual([]);   // 차량별로 달라도 되는 값(면책금·수리 한도 등)만 다르면 막지 않는다
  });
  it('조회하지 않은 노출 차량(오류 기록 없음)·차량 ID 누락은 404(NOT_IN_SOURCE)로 취급하지 않고 막는다', () => {
    const missing = buildPolicyLinkPlan(input({ vehicleTerms: { a: terms() }, vehicleTermsErrors: {} }));
    expect(missing.blockers).toContain('SOURCE_LOOKUP_FAILED(1)');
    expect(missing.withoutSourceTerms).toEqual([{ id: 'b', reason: 'NOT_LOOKED_UP' }]);
    expect(buildPolicyLinkPlan(input({ vehicleTerms: { a: terms() }, vehicleTermsErrors: { b: 'ID_MISSING' } })).blockers).toContain('SOURCE_LOOKUP_FAILED(1)');
  });
  it('이미 연결·조건이 같은 상품은 계획에서 빠지고, 보존 칸이 없으면 연결 전 policy_code 를 남긴다', () => {
    const same = terms();
    const plan = buildPolicyLinkPlan(input({ products: [
      { id: 'x', updateTimeMs: 1, data: { provider_company_code: 'RP031', listable: true, policy_code: 'RP031_S02' } },
      product('y', { policy_code: IANCAR_COMMON_POLICY_CODE, policy_reference_state: 'LINKED', iancar_policy_terms: same }),
    ], vehicleTerms: { x: terms(), y: same } }));
    expect(plan.productPatches).toHaveLength(1);
    expect(plan.productPatches[0]!.patch.policy_code_source_original).toBe('RP031_S02');
    expect(plan.counts).toMatchObject({ toLink: 1 });
  });
  it('원천 최소 연령이 만 26세가 아니면(대표 정책과 다름) 계획을 막고, 공통 정책이 없어도 막는다', () => {
    expect(buildPolicyLinkPlan(input({ vehicleTerms: { a: terms({ minimumDriverAge: 21 }), b: terms({ minimumDriverAge: 21 }) } })).blockers).toContain('SOURCE_MINIMUM_AGE_NOT_26');
    expect(buildPolicyLinkPlan(input({ policy: { exists: false, updateTimeMs: null, data: {} } })).blockers).toContain('COMMON_POLICY_MISSING');
  });
  it('계약 잠금·삭제 상품은 건너뛰고 digest 는 입력이 같으면 같고 문서 revision 이 바뀌면 달라진다', () => {
    const locked = buildPolicyLinkPlan(input({ products: [product('l', { locked_by_contract: true }), product('m', { _deleted: true }), product('ok')], vehicleTerms: { ok: terms() } }));
    expect(locked.skipped.map(s => s.id)).toEqual(['l', 'm']);
    expect(locked.productPatches.map(p => p.id)).toEqual(['ok']);
    expect(buildPolicyLinkPlan(input()).planDigest).toBe(buildPolicyLinkPlan(input()).planDigest);
    expect(buildPolicyLinkPlan(input({ products: [product('a', {}, 2001), product('b')] })).planDigest).not.toBe(buildPolicyLinkPlan(input({ products: [product('a', {}, 2000), product('b')] })).planDigest);
    expect(buildPolicyLinkPlan(input({ vehicleTerms: { a: terms({ maximumDriverAge: 70 }), b: terms({ maximumDriverAge: 70 }) } })).planDigest).not.toBe(buildPolicyLinkPlan(input()).planDigest);
  });
});

describe('동기화가 연결된 정책을 다시 비우지 않는다(iancarPolicyFields)', () => {
  it('LINKED 이고 policy_code 가 있으면 그대로 유지', () => {
    expect(iancarPolicyFields({ policy_code: IANCAR_COMMON_POLICY_CODE, policy_reference_state: 'LINKED', policy_code_source_original: 'RP031_S01' }))
      .toEqual({ policy_code: IANCAR_COMMON_POLICY_CODE, policy_code_source_original: 'RP031_S01', policy_reference_state: 'LINKED' });
  });
  it('연결 전(또는 LINKED 인데 policy_code 가 비어 있음)은 기존대로 DEFERRED·원래 값 보존', () => {
    expect(iancarPolicyFields({ policy_code: 'RP031_S02' })).toEqual({ policy_code: null, policy_code_source_original: 'RP031_S02', policy_reference_state: 'DEFERRED' });
    expect(iancarPolicyFields({ policy_code_source_original: 'RP031_S03' })).toEqual({ policy_code: null, policy_code_source_original: 'RP031_S03', policy_reference_state: 'DEFERRED' });
    expect(iancarPolicyFields({ policy_reference_state: 'LINKED', policy_code: '  ' })).toMatchObject({ policy_code: null, policy_reference_state: 'DEFERRED' });
    expect(iancarPolicyFields({})).toEqual({ policy_code: null, policy_code_source_original: null, policy_reference_state: 'DEFERRED' });
  });
});
