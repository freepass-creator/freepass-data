import { describe, expect, it } from 'vitest';
import { buildPolicyLinkPlan, iancarPolicyFields, IANCAR_COMMON_POLICY_CODE, type PolicyLinkInput } from '../src/domain/iancar-policy-link.js';

const policy = (over: Record<string, unknown> = {}) => ({ exists: true, updateTimeMs: 1000, data: { basic_driver_age: '만 26세 이상', driver_age_upper_limit: '만 70세 이하', annual_mileage: '연 30,000km',
  policy_default_pack: 'freepass-common-rent-2026-08-14-v1', created_by: 'codex:freepass-common-policy', ...over } });
const product = (id: string, over: Record<string, unknown> = {}, updateTimeMs = 2000) => ({ id, updateTimeMs, data: { provider_company_code: 'RP031', listable: true, policy_code: null, policy_code_source_original: 'RP031_S01', policy_reference_state: 'DEFERRED', ...over } });
const input = (over: Partial<PolicyLinkInput> = {}): PolicyLinkInput => ({ policy: policy(), products: [product('a'), product('b', { policy_code_source_original: 'RP031_S03' }), product('c', { listable: false })], ageUpper: 'KEEP', ...over });

describe('이안카 정책 연결 계획', () => {
  it('노출 이안카만 공통 정책에 연결하고 연결 전 값은 보존 칸에 둔다(삭제 0)', () => {
    const plan = buildPolicyLinkPlan(input());
    expect(plan.blockers).toEqual([]);
    expect(plan.counts).toMatchObject({ listableTargets: 2, toLink: 2, alreadyLinked: 0, skipped: 0, deletes: 0 });
    expect(plan.productPatches.map(p => p.id)).toEqual(['a', 'b']);                       // 비노출 c 는 건드리지 않음
    for (const row of plan.productPatches) expect(row.patch).toMatchObject({ policy_code: IANCAR_COMMON_POLICY_CODE, policy_reference_state: 'LINKED' });
    expect('policy_code_source_original' in plan.productPatches[0]!.patch).toBe(false);   // 이미 보존 칸이 있으면 덮지 않는다
  });
  it('보존 칸이 없으면 연결 전 policy_code 를 남기고, 이미 연결된 상품은 계획에서 빠진다', () => {
    const plan = buildPolicyLinkPlan(input({ products: [
      { id: 'x', updateTimeMs: 1, data: { provider_company_code: 'RP031', listable: true, policy_code: 'RP031_S02' } },
      product('y', { policy_code: IANCAR_COMMON_POLICY_CODE, policy_reference_state: 'LINKED' }),
    ] }));
    expect(plan.productPatches).toHaveLength(1);
    expect(plan.productPatches[0]!.patch.policy_code_source_original).toBe('RP031_S02');
    expect(plan.counts).toMatchObject({ toLink: 1, alreadyLinked: 1 });
  });
  it('공통 정책 주행을 연 20,000km 로 맞추고, 연령 상한은 선택에 따라(기본은 유지)', () => {
    expect(buildPolicyLinkPlan(input()).policyPatch).toEqual({ annual_mileage: '연 20,000km' });
    expect(buildPolicyLinkPlan(input({ ageUpper: 'ONE_65' })).policyPatch).toEqual({ annual_mileage: '연 20,000km', driver_age_upper_limit: '만 65세 이하' });
    expect(buildPolicyLinkPlan(input({ policy: policy({ annual_mileage: '연 20,000km' }) })).policyPatch).toEqual({});
  });
  it('근거를 나란히 보여 준다: 공통 정책(자동 생성 팩, 원문 출처 없음)과 ONE 보험 표본', () => {
    const plan = buildPolicyLinkPlan(input({ sourceInsurance: { sampled: 12, minimumDriverAge: [26], maximumDriverAge: [65], observedAt: '2026-10-12T00:00:00Z' } }));
    expect(plan.evidence.commonPolicy).toMatchObject({ driverAgeUpperLimit: '만 70세 이하', createdBy: 'codex:freepass-common-policy' });
    expect(plan.evidence.commonPolicy.provenanceNote).toContain('원문 출처는 문서에 없음');
    expect(plan.evidence.source).toMatchObject({ minimumDriverAge: [26], maximumDriverAge: [65] });
  });
  it('공통 정책이 없거나 기본 연령이 만 26세 이상이 아니면 계획을 막는다', () => {
    expect(buildPolicyLinkPlan(input({ policy: { exists: false, updateTimeMs: null, data: {} } })).blockers).toContain('COMMON_POLICY_MISSING');
    expect(buildPolicyLinkPlan(input({ policy: policy({ basic_driver_age: '만 21세 이상' }) })).blockers).toContain('BASIC_DRIVER_AGE_NOT_26');
  });
  it('계약 잠금·삭제 상품은 건너뛰고 digest 는 입력이 같으면 같고 문서 revision 이 바뀌면 달라진다', () => {
    const locked = buildPolicyLinkPlan(input({ products: [product('l', { locked_by_contract: true }), product('m', { _deleted: true }), product('ok')] }));
    expect(locked.skipped.map(s => s.id)).toEqual(['l', 'm']);
    expect(locked.productPatches.map(p => p.id)).toEqual(['ok']);
    expect(buildPolicyLinkPlan(input()).planDigest).toBe(buildPolicyLinkPlan(input()).planDigest);
    expect(buildPolicyLinkPlan(input({ products: [product('a', {}, 2000), product('b')] })).planDigest)
      .not.toBe(buildPolicyLinkPlan(input({ products: [product('a', {}, 2001), product('b')] })).planDigest);
    expect(buildPolicyLinkPlan(input()).planDigest).not.toBe(buildPolicyLinkPlan(input({ ageUpper: 'ONE_65' })).planDigest);
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
