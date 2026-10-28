import { describe, expect, it } from 'vitest';
import { buildPolicyLinkPlan, type PolicyLinkInput, type VehicleTerms } from '../src/domain/iancar-policy-link.js';

// 대표 2026-10-23 승인: 원천 초과 주행 요금(원/km) ↔ 가격표 월 차액 ↔ S 문서가 1:1 로 맞을 때만 S 에 연결한다. 정책 문서는 불변.
const terms = (over: Partial<VehicleTerms> = {}): VehicleTerms => ({ source: 'ONE_RATES', observedAt: '2026-10-23T00:00:00Z', minimumDriverAge: 26, maximumDriverAge: 65, minimumLicenseMonths: 12,
  ownDamageIncluded: true, ownDamageDeductible: 500000, ownDamageMinimumFaultPercent: 30, personalInjuryDeductible: 500000, propertyDamageDeductible: 500000, repairLimit: 5000000,
  age24Surcharge: 60000, perPanelRepair: 300000, excessMileageFeePerKm: 100, dailyLossOrLateReturnFeeByTerm: { '12_연20000km': 1 }, vatIncluded: true, ...over });
const price = (diffMan: number) => ({ '12_연20000km': { rent: 600000 }, '12_연30000km': { rent: 600000 + Math.round(diffMan * 10000) } });
const product = (id: string, over: Record<string, unknown> = {}) => ({ id, updateTimeMs: 1, data: { provider_company_code: 'RP031', listable: true, policy_code: null, price: price(5), ...over } });
const ok = (n: number) => ({ exists: true, updateTimeMs: n, dataDigest: 'd' + n });
const S_OK = { RP031_S01: ok(1), RP031_S02: ok(2), RP031_S03: ok(3), RP031_S04: ok(4) };
const input = (over: Partial<PolicyLinkInput> = {}): PolicyLinkInput => ({ policy: { exists: true, updateTimeMs: 1, data: {} }, sPolicies: S_OK, ...over } as PolicyLinkInput);

describe('이안카 S 연결 계획(S_FROM_NULL)', () => {
  it('원천 등급 100/200/300/500 → S01~S04, 가격표 월 차액이 받쳐 줄 때만, 정책 문서 변경 0', () => {
    const plan = buildPolicyLinkPlan(input({
      products: [product('a', { price: price(5) }), product('b', { price: price(9) }), product('c', { price: price(14) }), product('d', { price: price(23) })],
      vehicleTerms: { a: terms({ excessMileageFeePerKm: 100 }), b: terms({ excessMileageFeePerKm: 200 }), c: terms({ excessMileageFeePerKm: 300 }), d: terms({ excessMileageFeePerKm: 500 }) } }), { scope: 'S_FROM_NULL' });
    expect(plan.blockers).toEqual([]);
    expect(plan.productPatches.map(p => p.patch.policy_code)).toEqual(['RP031_S01', 'RP031_S02', 'RP031_S03', 'RP031_S04']);
    expect(plan.counts).toMatchObject({ toLink: 4, policyDocumentChanges: 0, policyFieldsChanged: 0, deletes: 0 });
    expect(plan.policyPatch).toEqual({});
    for (const p of plan.productPatches) expect(p.patch).toMatchObject({ policy_reference_state: 'LINKED' });
  });
  it('등급이 안 정해지거나 가격표가 어긋나거나 조건이 S 범위 밖이면 연결하지 않고 사유를 남긴다', () => {
    const plan = buildPolicyLinkPlan(input({
      products: [product('a'), product('b', { price: price(14) }), product('c'), product('d'), product('e', { price: undefined })],
      vehicleTerms: { a: terms({ excessMileageFeePerKm: 150 }), b: terms({ excessMileageFeePerKm: 100 }), c: terms({ ownDamageDeductible: 2000000 }), d: terms({ maximumDriverAge: 70 }), e: terms() } }), { scope: 'S_FROM_NULL' });
    expect(plan.productPatches).toEqual([]);
    expect(plan.withoutSourceTerms.map(h => h.reason)).toEqual(['FEE_NOT_MAPPED', 'PRICE_DIFF_CONFLICT', 'CONDITION_NOT_COVERED_BY_S', 'CONDITION_NOT_COVERED_BY_S', 'PRICE_DIFF_CONFLICT']);
  });
  it('이미 정책이 있는 상품·비노출·잠금은 대상이 아니고, S 문서가 없거나 원천 조회가 실패하면 계획을 막는다', () => {
    const base = { products: [product('a', { policy_code: 'RP031_S01' }), product('b', { listable: false }), product('c', { locked_by_contract: '계약원장' }), product('d')],
      vehicleTerms: { c: terms() } as Record<string, VehicleTerms> };
    const plan = buildPolicyLinkPlan(input(base), { scope: 'S_FROM_NULL' });
    expect(plan.counts.listableTargets).toBe(2);
    expect(plan.skipped.map(s => s.id)).toEqual(['c']);
    expect(plan.blockers).toEqual(expect.arrayContaining([expect.stringMatching(/^SOURCE_LOOKUP_FAILED/)]));
    expect(buildPolicyLinkPlan(input({ ...base, sPolicies: { RP031_S01: ok(1) } }), { scope: 'S_FROM_NULL' }).blockers.some(b => b.startsWith('S_POLICY_MISSING'))).toBe(true);
  });
});

describe('이안카 S 재연결(S_RELINK)', () => {
  it('S01 에 묶였지만 원천 등급이 다른 차만 올바른 S 로 옮기고 이전 코드를 사유에 남긴다, 이미 맞는 차는 건드리지 않는다', () => {
    const plan = buildPolicyLinkPlan(input({
      products: [product('a', { policy_code: 'RP031_S01', policy_reference_state: 'LINKED', price: price(5) }),
        product('b', { policy_code: 'RP031_S01', policy_reference_state: 'LINKED', price: price(14) }),
        product('c', { policy_code: 'FP-RP031-RENT', price: price(14) })],
      vehicleTerms: { a: terms({ excessMileageFeePerKm: 100 }), b: terms({ excessMileageFeePerKm: 300 }), c: terms({ excessMileageFeePerKm: 300 }) } }), { scope: 'S_RELINK' });
    expect(plan.counts.listableTargets).toBe(2);   // FP 상품은 대상 밖
    expect(plan.productPatches.map(p => [p.id, p.patch.policy_code])).toEqual([['b', 'RP031_S03']]);
    expect(String(plan.productPatches[0]!.patch.policy_code_linked_reason)).toContain('이전 RP031_S01');
    expect((plan.evidence as { alreadyCorrect?: number }).alreadyCorrect).toBe(1);
  });
});

describe('이안카 S 연결 — Codex 반례', () => {
  it('가격표 차액 범위는 원 단위로 엄격하다(S01 에 3.5만·6.5만원은 연결 안 됨), 잘못된 가격(NaN·0)도 통과하지 못한다', () => {
    const run = (p: unknown) => buildPolicyLinkPlan(input({ products: [product('a', { price: p })], vehicleTerms: { a: terms({ excessMileageFeePerKm: 100 }) } }), { scope: 'S_FROM_NULL' });
    expect(run(price(4.6)).productPatches.length).toBe(1);
    expect(run(price(3.5)).productPatches.length).toBe(0);
    expect(run(price(6.4999)).productPatches.length).toBe(0);
    expect(run({ '12_연20000km': { rent: Number.NaN }, '12_연30000km': { rent: 650000 } }).productPatches.length).toBe(0);
    expect(run({ '12_연20000km': { rent: 0 }, '12_연30000km': { rent: 50000 } }).productPatches.length).toBe(0);
  });
  it('계획 digest 는 보류·건너뜀·S 정책 문서 revision 이 바뀌면 달라진다(패치가 같아도)', () => {
    const base = { products: [product('a'), product('b', { price: price(14) })], vehicleTerms: { a: terms(), b: terms({ excessMileageFeePerKm: 100 }) } };
    const d1 = buildPolicyLinkPlan(input(base), { scope: 'S_FROM_NULL' }).planDigest;
    expect(buildPolicyLinkPlan(input({ ...base, vehicleTerms: { a: terms(), b: terms({ excessMileageFeePerKm: 150 }) } }), { scope: 'S_FROM_NULL' }).planDigest).not.toBe(d1);   // 보류 사유만 바뀜
    expect(buildPolicyLinkPlan(input({ ...base, sPolicies: { ...S_OK, RP031_S02: { exists: true, updateTimeMs: 99, dataDigest: 'changed' } } }), { scope: 'S_FROM_NULL' }).planDigest).not.toBe(d1);
  });
});
