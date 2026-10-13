import { describe, it, expect } from 'vitest';
import { APPROVED_REASON, buildApprovedPlan, parseArgs, planDigest, ratioGuard, selectEligible, withdrawalPatch } from '../scripts/exposure-apply.mjs';

const REF = '대표 10-13 GHD 채팅: 에스에이=출고불가';
const doc = (id, fields, updateTime = 't1') => ({ id, updateTime, fields });

describe('parseArgs — 승인 옵션 있음/없음', () => {
  it('승인 옵션 없이 --plan/--supplier 없으면 오류', () => {
    expect(parseArgs([]).error).toMatch(/필수/);
    expect(parseArgs(['--plan', 'p.json']).error).toMatch(/필수/);
  });
  it('기존 --plan 경로는 그대로(기본 비율 50%·15분)', () => {
    const a = parseArgs(['--plan', 'p.json', '--supplier', 'RP004']);
    expect(a.error).toBeUndefined(); expect(a.supplier).toBe('RP004'); expect(a.maxRatio).toBe(0.5); expect(a.maxAgeMin).toBe(15); expect(a.approvedSupplier).toBeUndefined();
  });
  it('승인 옵션은 --approval-ref 가 필수, 코드 형식 검사, --plan 과 같이 못 쓴다', () => {
    expect(parseArgs(['--approved-unsellable-supplier', 'PT-0023']).error).toMatch(/approval-ref/);
    expect(parseArgs(['--approved-unsellable-supplier', 'PT-0023', '--approval-ref', '   ']).error).toMatch(/approval-ref/);
    expect(parseArgs(['--approved-unsellable-supplier', 'pt23', '--approval-ref', REF]).error).toMatch(/형식/);
    expect(parseArgs(['--approved-unsellable-supplier', 'PT-0023', '--approval-ref', REF, '--plan', 'p.json']).error).toMatch(/--plan/);
    expect(parseArgs(['--approved-unsellable-supplier', 'PT-0023', '--approval-ref', REF, '--supplier', 'RP004']).error).toMatch(/다르다/);
    const a = parseArgs(['--approved-unsellable-supplier', 'PT-0023', '--approval-ref', REF, '--apply']);
    expect(a.error).toBeUndefined(); expect(a.supplier).toBe('PT-0023'); expect(a.apply).toBe(true); expect(a.approvalRef).toBe(REF);
  });
});

describe('buildApprovedPlan — 승인 공급사의 판매 중 문서만, 기존 계획 형식·digest', () => {
  const docs = [
    doc('a1', { car_number: '12가 1111', provider_company_code: 'PT-0023', listable: true, status: '판매중' }, 'u1'),
    doc('a2', { car_number: '12가 2222', partner_code: 'PT-0023', listable: true, status: '판매중', _pin_state: 'pinned' }, 'u2'),
    doc('a3', { car_number: '12가 3333', provider_company_code: 'PT-0023', listable: false, status: '출고불가' }),
    doc('b1', { car_number: '12가 4444', provider_company_code: 'RP004', listable: true, status: '판매중' }),
  ];
  it('다른 공급사·판매 아님은 들어오지 않고, 승인 근거는 digest 안(plans)에 결박', () => {
    const plan = buildApprovedPlan(docs, 'PT-0023', REF, { project: 'freepasserp5', readAt: '2026-10-13T00:00:00.000Z' });
    expect(plan.schema).toBe('exposure-plan/v1'); expect(plan.mode).toBe('DRY_RUN'); expect(plan.writes).toBe(0);
    const p = plan.plans['PT-0023'];
    expect(p.downgrade.map(x => x.id)).toEqual(['a1', 'a2']);
    expect(p.downgrade[0]).toMatchObject({ l4: '1111', reason: APPROVED_REASON, pinned: false, updateTime: 'u1' });
    expect(p.downgrade[1].pinned).toBe(true);
    expect(p.enroll).toEqual([]); expect(p.reexpose).toEqual([]);
    expect(p.approval).toMatchObject({ kind: APPROVED_REASON, supplier: 'PT-0023', project: 'freepasserp5', ref: REF, allowFullDowngrade: true });
    expect(plan.plans.RP004).toBeUndefined();
    expect(plan.digest).toBe(planDigest(plan.plans));
    const tampered = structuredClone(plan.plans); tampered['PT-0023'].approval.ref = '다른 근거';
    expect(planDigest(tampered)).not.toBe(plan.digest);
  });
});

describe('selectEligible — 잠금·고정·다른 공급사 보호', () => {
  const store = {
    a1: doc('a1', { provider_company_code: 'PT-0023', listable: true, status: '판매중' }, 'u1'),
    a2: doc('a2', { provider_company_code: 'PT-0023', listable: true, status: '판매중', _pin_state: 'pinned' }, 'u2'),
    a3: doc('a3', { provider_company_code: 'PT-0023', listable: true, status: '계약중' }),
    a4: doc('a4', { provider_company_code: 'PT-0023', listable: true, locked_by_contract: true }),
    a5: doc('a5', { provider_company_code: 'PT-0023', listable: true, publication_withdrawal: { reason: 'X' } }),
    a6: doc('a6', { provider_company_code: 'PT-0023', listable: false }),
    a7: doc('a7', { provider_company_code: 'PT-0023', listable: true }, 'u7-new'),
    b1: doc('b1', { provider_company_code: 'RP004', listable: true }),
  };
  const getDoc = async id => store[id] ?? null;
  const items = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'b1', 'zz', 'a1'].map(id => ({ id, reason: APPROVED_REASON, updateTime: id === 'a7' ? 'u7-old' : undefined }));
  it('승인 하향: 고정·계획 뒤 변경까지 건너뛰고 다른 공급사는 절대 포함하지 않는다', async () => {
    const { eligible, skipped } = await selectEligible(items, 'PT-0023', getDoc, { protectPinned: true });
    expect(eligible.map(e => e.item.id)).toEqual(['a1']);
    expect(Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v.length])))
      .toEqual({ 고정: 1, 계약잠금: 2, 이미보류표식: 1, 이미판매아님: 1, 계획후변경: 1, 공급사불일치: 1, 문서없음: 1, 중복: 1 });
  });
  it('기존 --plan 경로: 고정 문서는 전처럼 대상(뜻 불변), 잠금은 보호', async () => {
    const { eligible } = await selectEligible(items, 'PT-0023', getDoc);
    expect(eligible.map(e => e.item.id)).toEqual(['a1', 'a2', 'a7']);
  });
});

describe('ratioGuard — 승인 공급사만 100%, 그 밖은 50% 유지', () => {
  const approval = { kind: APPROVED_REASON, supplier: 'PT-0023', allowFullDowngrade: true };
  it('승인 없음: 100% 는 막힘(기존 가드)', () => {
    const g = ratioGuard({ eligibleCount: 10, listableNow: 10, maxRatio: 0.5, supplier: 'PT-0023' });
    expect(g.blocked).toBe(true); expect(g.limit).toBe(0.5); expect(g.approved).toBe(false);
    expect(ratioGuard({ eligibleCount: 5, listableNow: 10, maxRatio: 0.5, supplier: 'RP004' }).blocked).toBe(true);
    expect(ratioGuard({ eligibleCount: 4, listableNow: 10, maxRatio: 0.5, supplier: 'RP004' }).blocked).toBe(false);
  });
  it('승인 공급사: 100% 허용, 다른 공급사에 그 승인을 갖다 대면 여전히 막힘', () => {
    const g = ratioGuard({ eligibleCount: 10, listableNow: 10, maxRatio: 0.5, supplier: 'PT-0023', approval });
    expect(g.blocked).toBe(false); expect(g.approved).toBe(true); expect(g.limit).toBe(1);
    expect(ratioGuard({ eligibleCount: 10, listableNow: 10, maxRatio: 0.5, supplier: 'RP004', approval }).blocked).toBe(true);
    expect(ratioGuard({ eligibleCount: 10, listableNow: 10, maxRatio: 0.5, supplier: 'PT-0023', approval: { ...approval, allowFullDowngrade: false } }).blocked).toBe(true);
  });
  it('분모 0·NaN 은 막힘', () => {
    expect(ratioGuard({ eligibleCount: 3, listableNow: 0, maxRatio: 0.5, supplier: 'PT-0023', approval }).blocked).toBe(true);
    expect(ratioGuard({ eligibleCount: 1, listableNow: 10, maxRatio: NaN, supplier: 'RP004' }).blocked).toBe(true);
    expect(ratioGuard({ eligibleCount: 0, listableNow: 0, maxRatio: 0.5, supplier: 'RP004' }).blocked).toBe(false);
  });
});

describe('withdrawalPatch — 승인 근거 기록, 이전 값 보존, 삭제 없음', () => {
  it('approvalRef 가 publication_withdrawal 에 들어가고 가격 칸은 건드리지 않는다', () => {
    const p = withdrawalPatch({ listable: true, status: '판매중', price: { m: 1 } }, { reason: APPROVED_REASON, supplier: 'PT-0023', digest: 'f'.repeat(64), readAt: 'r', approvalRef: REF });
    expect(p).toMatchObject({ listable: false, status: '출고불가', vehicle_status: '출고불가', status_kind: '불가' });
    expect(p.publication_withdrawal).toMatchObject({ reason: APPROVED_REASON, source: 'PT-0023', planDigest: 'f'.repeat(16), deleteAuthorized: false, approvalRef: REF });
    expect(p.publication_withdrawal_prior).toEqual({ listable: true, status: '판매중', vehicle_status: null, status_kind: null });
    expect(Object.keys(p)).not.toContain('price');
    expect(withdrawalPatch({}, { reason: 'SOURCE_ABSENT', supplier: 'RP004', digest: 'a'.repeat(64), readAt: 'r' }).publication_withdrawal).not.toHaveProperty('approvalRef');
  });
});
