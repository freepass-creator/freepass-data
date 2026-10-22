/** 공급사 기본 정책 연결 규칙 — 정책이 «비어 있는» 노출 상품에만, 공급사 정책 정본의 «단일 근거» 코드로 연결한다(대표 2026-10-22 «정책이랑 이런 거 미확인으로 두면 어쩌냐»).
 * 원칙: ① 차 줄 값 우선 — 이미 policy_code 가 있으면 절대 바꾸지 않는다 ② 정책이 단일하게 정해지는 공급사만 표에 둔다(같은 공급사의 정책이 둘 이상으로 갈리거나
 * 차종·기간에 따라 달라지면 표에 넣지 않는다 — 보험·계약 조건을 잘못 붙이면 고객 견적이 틀어진다) ③ 근거는 표의 basis 한 줄로 남긴다.
 * 이안카(RP031)는 전용 승인 작업(iancar-policy-link, 차량별 iancar_policy_terms 보존)이 있어 이 표에 넣지 않는다. */
export type SupplierPolicyLinkRule = { provider: string; code: string; basis: string };

export const SUPPLIER_POLICY_LINK_RULES: readonly SupplierPolicyLinkRule[] = Object.freeze([
  { provider: 'RP004', code: 'RP004_P01',
    basis: '아이카: 정책이 연결된 노출 상품 44대가 전부 RP004_P01 이다(RP004_P02 사용 0, 국산·수입 구분 없음). 2026-10-22 프리패스 데이터 직접 확인.' },
]);

/** 정책이 비어 있을 때만 그 공급사 기본 정책 코드를 돌려준다. 이미 값이 있거나(공백 제외) 표에 없는 공급사면 null. */
export function policyLinkCodeFor(provider: unknown, currentPolicyCode: unknown): string | null {
  if (typeof currentPolicyCode === 'string' && currentPolicyCode.trim()) return null;
  if (currentPolicyCode !== null && currentPolicyCode !== undefined && typeof currentPolicyCode !== 'string') return null;   // 모르는 모양은 건드리지 않는다
  if (typeof provider !== 'string') return null;
  return SUPPLIER_POLICY_LINK_RULES.find(r => r.provider === provider.trim())?.code ?? null;
}

/** 문서에 남기는 연결 근거 문구(policy_code_linked_reason). */
export const policyLinkReason = (code: string): string => {
  const rule = SUPPLIER_POLICY_LINK_RULES.find(r => r.code === code);
  return rule ? `엔진 공급사 기본 정책 연결 규칙 — ${rule.basis}` : '';
};
