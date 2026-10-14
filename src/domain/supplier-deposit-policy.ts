/** 공급사 정책 정제 — 보증금(대표 2026-10-14 «원문을 먼저 가지고 오고 대수를 맞추고 가지고 온 것들을 정제를 하면 되잖아. 옵션, 정책 이런 것들 다
 * 그 회사에서 주는 곳을 보면 거기에 정책이 있다. 값이 숫자로 존재하거나 산출식으로 존재한다.»).
 * 원칙: ① 원문(공급사가 준 값)을 그대로 가져오고 ② 대수를 맞춘 뒤 ③ 공급사 «자기 정책»으로 정제한다. 공급사의 자리채움 0 은 «무보증»이 아니다.
 * 보증금은 공급사 정책이 정한 대로 «숫자(원문 금액)» 또는 «산출식(규칙 코드)»이고, 산출식 값은 계산값임을 규칙 코드로 남긴다(deposit_source=CALCULATED).
 * 이 표에 없는 공급사·상품 구분은 정제하지 않는다(기존 원문 금액 경로 그대로). 문서: docs/SUPPLIER-POLICY-REFINE-20261014.md */
import { AUTOPLUS_DEPOSIT_RULES, autoplusRuleDeposit, type AutoplusDepositRuleCode } from './autoplus-deposit-rule.js';
import type { SourceAmount, SourceTerm } from './source-engine.js';

/** 약정연수 배수(최대 3): 12개월 ×1, 24개월 ×2, 36개월 이상 ×3. 개월이 12의 배수인 양의 정수가 아니면 null.
 * 손오공 비고 문구 «월 대여료 × 약정연수 (최대 3개월)»의 해석(deposit-evidence resolveDepositByRuleNote)도 이 함수 하나를 쓴다. */
export function contractYearsMultiplierMax3(termMonths: unknown): number | null {
  if (!Number.isSafeInteger(termMonths) || (termMonths as number) <= 0 || (termMonths as number) % 12 !== 0) return null;
  return Math.min((termMonths as number) / 12, 3);
}

export type SupplierDepositRuleCode = AutoplusDepositRuleCode | 'RENT_X_CONTRACT_YEARS_MAX3';
type RuleDef = { provider: string; label: string; multiplier: (termMonths: unknown) => number | null };
const AUTOPLUS_MULTIPLIER = (code: AutoplusDepositRuleCode) => () => AUTOPLUS_DEPOSIT_RULES[code].multiplier;

/** 규칙 표(코드 → 공급사·배수). 규칙 코드는 그 공급사 문서에서만 근거가 된다. */
export const SUPPLIER_DEPOSIT_RULES: Readonly<Record<SupplierDepositRuleCode, RuleDef>> = Object.freeze({
  AUTOPLUS_RENT_X2_DOMESTIC: { provider: 'RP023', label: AUTOPLUS_DEPOSIT_RULES.AUTOPLUS_RENT_X2_DOMESTIC.label, multiplier: AUTOPLUS_MULTIPLIER('AUTOPLUS_RENT_X2_DOMESTIC') },
  AUTOPLUS_RENT_X3_IMPORT: { provider: 'RP023', label: AUTOPLUS_DEPOSIT_RULES.AUTOPLUS_RENT_X3_IMPORT.label, multiplier: AUTOPLUS_MULTIPLIER('AUTOPLUS_RENT_X3_IMPORT') },
  RENT_X_CONTRACT_YEARS_MAX3: { provider: 'RP012', label: '손오공 정책: 월 대여료×약정연수(최대 3개월)', multiplier: contractYearsMultiplierMax3 },
});

export const isSupplierDepositRuleCode = (v: unknown): v is SupplierDepositRuleCode =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(SUPPLIER_DEPOSIT_RULES, v);
/** 그 공급사의 규칙 코드일 때만 코드를 돌려준다(다른 공급사의 같은 표식은 근거가 아니다). */
export function supplierDepositRuleFor(provider: unknown, code: unknown): SupplierDepositRuleCode | null {
  return isSupplierDepositRuleCode(code) && typeof provider === 'string' && SUPPLIER_DEPOSIT_RULES[code].provider === provider.trim() ? code : null;
}
/** 규칙 계산값. 대여료가 양의 정수가 아니거나 개월이 규칙 밖이면 null(규칙에서 ZERO 는 나오지 않는다). */
export function computeSupplierRuleDeposit(code: SupplierDepositRuleCode, termMonths: unknown, monthlyRent: unknown): { amount: number; multiplier: number } | null {
  if (code === 'AUTOPLUS_RENT_X2_DOMESTIC' || code === 'AUTOPLUS_RENT_X3_IMPORT') {
    const amount = autoplusRuleDeposit(code, monthlyRent);
    return amount === null ? null : { amount, multiplier: AUTOPLUS_DEPOSIT_RULES[code].multiplier };
  }
  const multiplier = SUPPLIER_DEPOSIT_RULES[code].multiplier(termMonths);
  if (multiplier === null || !Number.isSafeInteger(monthlyRent) || (monthlyRent as number) <= 0) return null;
  const amount = (monthlyRent as number) * multiplier;
  return Number.isSafeInteger(amount) && amount > 0 ? { amount, multiplier } : null;
}

/** 공급사·상품 구분별 보증금 정책. SOURCE_AMOUNT = 공급사가 준 양의 금액을 그대로(0·빈칸은 UNKNOWN), RULE = 산출식.
 * zeroIsPlaceholder: 그 공급사의 숫자 0 은 자리채움(무보증 아님) — 엔진이 이전 회차의 ZERO 를 «보존»하지도 않는다. */
export type SupplierDepositPolicy =
  | { provider: string; bucket: string; deposit: 'SOURCE_AMOUNT'; policySource: string }
  | { provider: string; bucket: string; deposit: 'RULE'; rules: readonly SupplierDepositRuleCode[]; policySource: string };
export const SUPPLIER_DEPOSIT_POLICIES: readonly SupplierDepositPolicy[] = Object.freeze([
  { provider: 'RP012', bucket: 'rent', deposit: 'SOURCE_AMOUNT', policySource: '손오공 파트너 API 상세 prices.RENT_RETURN.deposit(ERP 원값)' },
  { provider: 'RP012', bucket: 'sub', deposit: 'RULE', rules: ['RENT_X_CONTRACT_YEARS_MAX3'], policySource: '손오공 구독 정책 «월 대여료 × 약정연수 (최대 3개월)»' },
  { provider: 'RP012', bucket: 'pick', deposit: 'RULE', rules: ['RENT_X_CONTRACT_YEARS_MAX3'], policySource: '손오공 구독 정책 «월 대여료 × 약정연수 (최대 3개월)»' },
  { provider: 'RP023', bucket: '오플구독', deposit: 'RULE', rules: ['AUTOPLUS_RENT_X2_DOMESTIC', 'AUTOPLUS_RENT_X3_IMPORT'], policySource: '오토플러스 구글 시트 계산 규칙(국산×2 / 수입×3)' },
]);
export function supplierDepositPolicy(provider: string, bucket: string): SupplierDepositPolicy | null {
  return SUPPLIER_DEPOSIT_POLICIES.find(p => p.provider === provider && p.bucket === bucket) ?? null;
}
/** 정책 정제 대상 공급사(엔진이 규칙 표식 칸을 관리한다). */
export const hasSupplierDepositPolicy = (provider: string): boolean => SUPPLIER_DEPOSIT_POLICIES.some(p => p.provider === provider);
const PLACEHOLDER_ZERO_PROVIDERS: ReadonlySet<string> = new Set(['RP012']);
/** 숫자 0 이 자리채움인 공급사(손오공: «RP012 and pickup products cannot be promoted to zero deposit», READ-RUNTIME). */
export const isPlaceholderZeroProvider = (provider: string): boolean => PLACEHOLDER_ZERO_PROVIDERS.has(provider);

/** 엔진 보존 규칙(원천 보증금 UNKNOWN → 같은 항의 이전 값 보존, 저장소 불변식 «unknown 은 마지막 정상값을 지우지 않는다»)에 정책 정제를 더한 것:
 * 이전 KNOWN 은 그대로(계산값이었으면 규칙 코드도 함께 넘긴다 — 표식과 금액이 항마다 짝이 맞게), 이전 ZERO 는 자리채움 0 공급사(RP012)면 보존하지 않는다
 * (잘못 매핑된 옛 «무보증»을 되살리지 않는다). 보존할 것이 없으면 null. */
export function preservedDepositOf(provider: string, prior: Pick<SourceTerm, 'deposit' | 'raw'>): { deposit: SourceAmount; depositRule: SupplierDepositRuleCode | null } | null {
  if (prior.deposit.state === 'KNOWN') return { deposit: { ...prior.deposit }, depositRule: supplierDepositRuleFor(provider, prior.raw?.deposit_rule) };
  if (prior.deposit.state === 'ZERO' && !isPlaceholderZeroProvider(provider)) return { deposit: { ...prior.deposit }, depositRule: null };
  return null;
}
