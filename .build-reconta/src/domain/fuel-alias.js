/** 연료 별칭 표(대표 2026-10-19 «연료가 빠지면 안 되는데 빠진 곳이 있다»): 원천 연료 표기를 차종 기준 한 장의 제원 연료 목록(SPEC_FUEL_VALUES)
 * 이름으로만 바꾼다. 표준 목록은 새로 만들지 않는다 — source-spec-validation 의 SPEC_FUEL_VALUES 가 정본이다.
 * 표에 없는 표기는 null(채우지 않음, 추정 금지). 차명이 연료와 정면으로 어긋나면(예: «1.6 HEV» 인데 연료 «휘발유») 원문으로 하나로 정해지지 않으므로 null. */
import { SPEC_FUEL_VALUES } from './source-spec-validation.js';
/** 비교 키: 전각·공백·대소문자 차이만 무시한다. */
const fuelKey = (v) => v.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
/** 별칭 → 표준 이름. 표준 이름 자신(공백만 다른 «플러그인하이브리드» 포함)도 키로 들어간다. */
export const FUEL_ALIASES = Object.freeze({
    휘발유: '가솔린',
    // 손오공 API 에 영문 코드 «GASOLINE» 이 한 대(2026-10-23 RP012 6331) 들어와 FUEL_UNRESOLVED 로 연료가 비었다. 비교 키가 대소문자를 무시하므로 «gasoline» 도 같다.
    GASOLINE: '가솔린',
    경유: '디젤',
    HEV: '하이브리드',
    // 손오공 API «가솔린+전기» 는 하이브리드 표기다(2026-10-19 판매 중 73대 전부 차명에 «하이브리드/HEV», 마스터 확정 10대 모두 vehicle_trim_master.fuel=하이브리드).
    // 차명에 «플러그인/PHEV» 가 있으면 아래 어긋남 검사가 보류시킨다.
    '가솔린+전기': '하이브리드',
    '휘발유+전기': '하이브리드',
    가솔린하이브리드: '하이브리드',
    PHEV: '플러그인 하이브리드',
    EV: '전기',
    전기차: '전기',
    '전기(EV)': '전기',
    FCEV: '수소',
    수소전기: '수소',
    // vehicle_trim_master 의 «바이퓨얼»(가솔린·LPG 겸용) = 표준 «가솔린+LPG».
    바이퓨얼: '가솔린+LPG',
});
const TABLE = new Map([
    ...[...SPEC_FUEL_VALUES].map(v => [fuelKey(v), v]),
    ...Object.entries(FUEL_ALIASES).map(([alias, canonical]) => [fuelKey(alias), canonical]),
]);
// 영문 줄임말은 낱말로만(«Chevrolet» 의 hev 같은 글자 조각은 무시).
const PHEV_WORD = /플러그인|(?<![A-Za-z])PHEV(?![A-Za-z])/i;
const HYBRID_WORD = /하이브리드|hybrid|(?<![A-Za-z])HEV(?![A-Za-z])/i;
/** 원천 연료 표기 → 표준 연료 이름(없으면 null). vehicleText(원천 차명)가 있으면 정면 어긋남을 막는다:
 * 차명에 플러그인/PHEV 가 있는데 플러그인 하이브리드가 아니면 보류, 차명에 하이브리드/HEV 가 있는데 가솔린·디젤·LPG 이면 보류. */
export function canonicalFuel(value, vehicleText) {
    if (typeof value !== 'string' || !value.trim() || value.length > 40)
        return null;
    const fuel = TABLE.get(fuelKey(value.trim())) ?? null;
    if (!fuel)
        return null;
    const name = typeof vehicleText === 'string' ? vehicleText : '';
    if (name) {
        if (PHEV_WORD.test(name) && fuel !== '플러그인 하이브리드')
            return null;
        if (!PHEV_WORD.test(name) && HYBRID_WORD.test(name) && (fuel === '가솔린' || fuel === '디젤' || fuel === 'LPG'))
            return null;
    }
    return fuel;
}
/** 세부트림이 정해진 차의 마스터 연료(대표 2026-10-19 요령 «마스터» 열): vehicle_trim_master 행들의 연료가 표준 이름으로 «하나로» 모일 때만 그 값.
 * 행이 없거나, 연료가 비거나 표준 밖인 행이 하나라도 있거나, 둘 이상으로 갈리면 null(추정하지 않음). */
export function uniqueMasterFuel(fuels) {
    if (!fuels.length)
        return null;
    const seen = new Set();
    for (const f of fuels) {
        const c = canonicalFuel(f);
        if (!c)
            return null;
        seen.add(c);
    }
    return seen.size === 1 ? [...seen][0] : null;
}
const nameKey = (v) => (typeof v === 'string' ? v.normalize('NFKC').replace(/\s+/g, ' ').trim() : '');
/** 확정된 정체성(제조사·모델·세부모델·세부트림/별칭)에 맞는 마스터 행 조회 함수(순수). 연식·배기량이 있으면 그것과 어긋나는 행을 뺀다(행에 그 값이 없으면 남긴다).
 * 마스터 연료(masterTrimFuelLookup)와 마스터 제원(spec-refill masterTrimSpecLookup)이 같은 행 선택을 쓴다. */
export function masterTrimRowsLookup(records) {
    const byKey = new Map();
    for (const r of records) {
        const [maker, model, sub, trim] = [0, 1, 2, 3].map(i => nameKey(r.names[i]));
        if (!maker || !model || !sub || !trim)
            continue;
        const trims = new Set([trim, ...((r.aliases?.[3] ?? []).map(nameKey).filter(Boolean))]);
        for (const t of trims) {
            const k = [maker, model, sub, t].join('|');
            (byKey.get(k) ?? byKey.set(k, []).get(k)).push(r);
        }
    }
    return (identity) => {
        let rows = byKey.get([identity.maker, identity.model, identity.sub_model, identity.trim_name].map(nameKey).join('|')) ?? [];
        rows = [...new Set(rows)];
        const year = /^(19|20)\d{2}$/.test(String(identity.year ?? '').trim()) ? Number(String(identity.year).trim()) : null;
        // 차의 연식·배기량과 맞지 않는 행은 뺀다(행에 그 값이 없으면 남긴다). 남는 행이 없으면 보류(Codex 검토: 어긋나는 마스터로 채우지 않음).
        if (year !== null)
            rows = rows.filter(r => (r.modelYearStart == null || r.modelYearStart <= year) && (r.modelYearEnd == null || r.modelYearEnd >= year));
        const cc = /^\d{3,5}$/.test(String(identity.engine_cc ?? '').trim()) ? Number(String(identity.engine_cc).trim()) : null;
        if (cc !== null)
            rows = rows.filter(r => r.specs?.displacementCc == null || r.specs.displacementCc === cc);
        return rows;
    };
}
/** 검증된 차종 마스터 기록(verifiedMasterRecords — vehicle_trim_master.fuel 포함)으로 «확정된 정체성 → 마스터 연료» 조회 함수를 만든다(순수).
 * 제조사·모델·세부모델은 정식 이름, 세부트림은 정식 이름 또는 등록 별칭으로 맞춘다. 연식·배기량이 있으면 그것과 어긋나는 행을 빼고(남는 행이 없으면 null),
 * 남은 행의 연료가 표준 이름으로 하나일 때만 값(uniqueMasterFuel). */
export function masterTrimFuelLookup(records) {
    const rowsOf = masterTrimRowsLookup(records);
    return (identity) => uniqueMasterFuel(rowsOf(identity).map(r => r.specs?.fuel ?? null));
}
