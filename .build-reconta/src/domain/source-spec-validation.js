export const SPEC_FUEL_VALUES = new Set(['가솔린', '디젤', 'LPG', '하이브리드', '플러그인 하이브리드', '전기', '수소', '가솔린+LPG']);
const ELECTRIC = new Set(['전기', '수소']);
const calendar = (v) => {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v);
    if (!m)
        return false;
    const y = Number(m[1]), mo = Number(m[2]);
    if (y < 1950 || y > 2100 || mo < 1 || mo > 12)
        return false;
    if (m[3] === undefined)
        return true;
    const d = Number(m[3]), leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
};
/** 색상 칸의 자리표 값(대시·«없음»·«확인필요» 등)은 색상이 아니다. 2026-10-23: 아이언(RP006) 원천이 내부색상에 «-» 를 주는 차가 13대이고 이미 노출 문서 6건에 «-» 가 채워져 있었다.
 * 구두점·기호만인 값과 흔한 «값 없음» 표기를 거른다. 실제 색상 이름(검정·화이트펄 등)은 건드리지 않는다. */
const COLOR_PLACEHOLDER_WORD = /^(?:없음|해당\s*없음|미상|미정|미확인|확인\s*필요|n\.?\/?a\.?|null|none|unknown|nan)$/iu;
/** 자리표인가: 앞뒤 기호·공백을 걷어 낸 뒤 비었거나(-, --, ?, ***) «값 없음» 낱말이면(없음, (미정), N.A., 확인 필요!). 실제 색상 이름은 건드리지 않는다. */
export const colorPlaceholder = (v) => {
    const core = v.normalize('NFKC').replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
    return core === '' || COLOR_PLACEHOLDER_WORD.test(core);
};
export const validColorValue = (v) => {
    const t = v.normalize('NFKC').trim();
    return t.length >= 1 && t.length <= 20 && !/\d{4,}/.test(t) && !colorPlaceholder(t);
};
/** 칸별 값 형식(문자열 값 기준). 허용 값 밖이면 그 칸만 보류. */
export const SPEC_FORMAT_RULES = {
    fuel_type: v => SPEC_FUEL_VALUES.has(v),
    year: v => /^(19|20)\d{2}$/.test(v),
    manufacture_year_month: v => /^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(v),
    first_registration_date: calendar,
    engine_cc: v => /^\d{3,5}$/.test(v) && Number(v) >= 50,
    mileage: v => /^\d{1,7}$/.test(v),
    seats: v => /^\d{1,2}$/.test(v) && Number(v) >= 1,
    ext_color: validColorValue,
    int_color: validColorValue,
};
export const DEPOSIT_MIN_POSITIVE_KRW = 10_000;
export const DEPOSIT_MAX_KRW = 100_000_000;
/** 위반 칸을 뺀 «복사본» 레코드와 위반 목록. 위반이 없으면 같은 객체를 돌려준다. */
export function validateSourceSpec(record) {
    const violations = [];
    const rawSpec = record.raw?.spec;
    let spec = null;
    if (rawSpec && typeof rawSpec === 'object' && !Array.isArray(rawSpec)) {
        const kept = {};
        for (const [key, value] of Object.entries(rawSpec)) {
            const rule = SPEC_FORMAT_RULES[key];
            if (typeof value !== 'string') {
                violations.push({ field: key, reason: 'NOT_STRING' });
                continue;
            }
            if (rule && !rule(value.trim())) {
                violations.push({ field: key, reason: 'FORMAT' });
                continue;
            }
            kept[key] = value;
        }
        if (ELECTRIC.has(kept.fuel_type ?? '') && kept.engine_cc !== undefined) {
            violations.push({ field: 'engine_cc', reason: 'ELECTRIC_WITH_CC' });
            delete kept.engine_cc;
        }
        spec = kept;
    }
    let terms = null;
    record.terms.forEach((term, index) => {
        const amount = term.deposit;
        if (amount.state !== 'KNOWN')
            return;
        const bad = !Number.isInteger(amount.value) || amount.value > DEPOSIT_MAX_KRW || (amount.value > 0 && amount.value < DEPOSIT_MIN_POSITIVE_KRW);
        if (!bad)
            return;
        violations.push({ field: 'deposit', reason: 'KRW_UNIT_OR_RANGE' });
        terms ??= record.terms.map(t => ({ ...t, raw: { ...t.raw } }));
        // 위반 보증금은 값을 비우고(UNKNOWN) 원천 값은 이 항의 raw 에만 남긴다(고쳐 쓰지 않음).
        const unknown = { state: 'UNKNOWN', value: null };
        terms[index] = { ...terms[index], deposit: unknown, raw: { ...terms[index].raw, deposit_rejected: amount.value } };
    });
    if (!violations.length)
        return { record, violations };
    return { record: { ...record, terms: terms ?? record.terms, raw: { ...record.raw, ...(spec ? { spec } : {}) } }, violations };
}
