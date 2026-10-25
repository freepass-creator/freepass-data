const isRec = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const INT_KEYS = ['minimumDriverAge', 'maximumDriverAge', 'minimumLicenseMonths', 'ownDamageDeductible', 'ownDamageMinimumFaultPercent',
    'personalInjuryDeductible', 'propertyDamageDeductible', 'repairLimit', 'perPanelRepair', 'excessMileageFeePerKm'];
export const IANCAR_POLICY_TERMS_KEYS = Object.freeze(['source', 'observedAt', ...INT_KEYS, 'ownDamageIncluded', 'vatIncluded', 'age24Surcharge', 'dailyLossOrLateReturnFeeByTerm']);
const isInt = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const feeKey = (key) => key.length > 0 && key.length <= 40 && /^[0-9]{1,3}_(월|연)[0-9]{1,6}km$/.test(key);
/** 검증 통과한 사본을 돌려준다. 모양이 맞지 않으면 undefined(null 은 «없음» 으로 그대로 통과). */
export function projectIancarPolicyTerms(value) {
    if (value === null)
        return null;
    if (!isRec(value))
        return undefined;
    const keys = Object.keys(value);
    if (keys.length !== IANCAR_POLICY_TERMS_KEYS.length || keys.some(k => !IANCAR_POLICY_TERMS_KEYS.includes(k)))
        return undefined;
    if (value.source !== 'ONE_RATES' || typeof value.observedAt !== 'string' || value.observedAt.length > 40 || !Number.isFinite(Date.parse(value.observedAt)))
        return undefined;
    if (!INT_KEYS.every(k => isInt(value[k])) || typeof value.ownDamageIncluded !== 'boolean' || typeof value.vatIncluded !== 'boolean')
        return undefined;
    const surcharge = value.age24Surcharge;
    if (!(surcharge === null || isInt(surcharge) || (typeof surcharge === 'string' && surcharge.length > 0 && surcharge.length <= 20)))
        return undefined;
    const fees = value.dailyLossOrLateReturnFeeByTerm;
    if (!isRec(fees) || Object.keys(fees).length > 200 || Object.entries(fees).some(([k, v]) => !feeKey(k) || !isInt(v)))
        return undefined;
    return { ...value, dailyLossOrLateReturnFeeByTerm: { ...fees } };
}
