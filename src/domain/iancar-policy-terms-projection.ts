/** 이안카 차량별 보험·추가요금 조건(`iancar_policy_terms`)의 단일 상품 호환 응답 투영·검증.
 * 공개 범위: 고객·영업자에게 안내하는 대여 조건(연령·면허·자차 면책금·수리 한도·초과 주행 요금·휴차료)만. 수수료·원가·정산·내부 메모는 이 필드에 없다.
 * 모양이 정확히 이 키 집합·자료형이 아니면 응답을 내보내지 않는다(알 수 없는 키·중첩·긴 문자열 거부). */
type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value);

const INT_KEYS = ['minimumDriverAge', 'maximumDriverAge', 'minimumLicenseMonths', 'ownDamageDeductible', 'ownDamageMinimumFaultPercent',
  'personalInjuryDeductible', 'propertyDamageDeductible', 'repairLimit', 'perPanelRepair', 'excessMileageFeePerKm'] as const;
export const IANCAR_POLICY_TERMS_KEYS = Object.freeze(['source', 'observedAt', ...INT_KEYS, 'ownDamageIncluded', 'vatIncluded', 'age24Surcharge', 'dailyLossOrLateReturnFeeByTerm'] as const);

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const feeKey = (key: string) => key.length > 0 && key.length <= 40 && /^[0-9]{1,3}_(월|연)[0-9]{1,6}km$/.test(key);

/** 검증 통과한 사본을 돌려준다. 모양이 맞지 않으면 undefined(null 은 «없음» 으로 그대로 통과). */
export function projectIancarPolicyTerms(value: unknown): Rec | null | undefined {
  if (value === null) return null;
  if (!isRec(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== IANCAR_POLICY_TERMS_KEYS.length || keys.some(k => !(IANCAR_POLICY_TERMS_KEYS as readonly string[]).includes(k))) return undefined;
  if (value.source !== 'ONE_RATES' || typeof value.observedAt !== 'string' || value.observedAt.length > 40 || !Number.isFinite(Date.parse(value.observedAt))) return undefined;
  if (!INT_KEYS.every(k => isInt(value[k])) || typeof value.ownDamageIncluded !== 'boolean' || typeof value.vatIncluded !== 'boolean') return undefined;
  const surcharge = value.age24Surcharge;
  if (!(surcharge === null || isInt(surcharge) || (typeof surcharge === 'string' && surcharge.length > 0 && surcharge.length <= 20))) return undefined;
  const fees = value.dailyLossOrLateReturnFeeByTerm;
  if (!isRec(fees) || Object.keys(fees).length > 200 || Object.entries(fees).some(([k, v]) => !feeKey(k) || !isInt(v))) return undefined;
  return { ...value, dailyLossOrLateReturnFeeByTerm: { ...fees } };
}
