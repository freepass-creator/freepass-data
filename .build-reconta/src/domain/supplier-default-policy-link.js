export const SUPPLIER_POLICY_LINK_RULES = Object.freeze([
    { provider: 'RP004', code: 'RP004_P01',
        basis: '아이카: 정책이 연결된 노출 상품 44대가 전부 RP004_P01 이다(RP004_P02 사용 0, 국산·수입 구분 없음). 2026-10-22 프리패스 데이터 직접 확인.' },
]);
/** 정책이 비어 있을 때만 그 공급사 기본 정책 코드를 돌려준다. 이미 값이 있거나(공백 제외) 표에 없는 공급사면 null. */
export function policyLinkCodeFor(provider, currentPolicyCode) {
    if (typeof currentPolicyCode === 'string' && currentPolicyCode.trim())
        return null;
    if (currentPolicyCode !== null && currentPolicyCode !== undefined && typeof currentPolicyCode !== 'string')
        return null; // 모르는 모양은 건드리지 않는다
    if (typeof provider !== 'string')
        return null;
    return SUPPLIER_POLICY_LINK_RULES.find(r => r.provider === provider.trim())?.code ?? null;
}
/** 문서에 남기는 연결 근거 문구(policy_code_linked_reason). */
export const policyLinkReason = (code) => {
    const rule = SUPPLIER_POLICY_LINK_RULES.find(r => r.code === code);
    return rule ? `엔진 공급사 기본 정책 연결 규칙 — ${rule.basis}` : '';
};
