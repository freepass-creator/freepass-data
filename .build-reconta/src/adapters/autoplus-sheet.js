/** 오토플러스(RP023) 공급사 시트 어댑터 — 대표 2026-10-14: 오토플러스 정본 = 구글시트, 홈페이지는 보조(교차 확인).
 * 시트 탭 구조(원본 «New 오토플러스 재고 리스트»): 상단 안내 문구 뒤에 머리글 행(No.·차량번호·차종·모델명·색상·연료·최초등록일·예상 주행거리·판매상태·
 * «12개월 2만km» 같은 요금 열…)이 있고 그 아래가 차량 행이다. 탭 이름·머리글 행 위치는 바뀔 수 있어 «차량번호»와 «판매상태» 머리글을 모두 가진 탭만 쓴다.
 * 판매상태: 판매중·할인판매·상품대기 = 출고가능, 계약중·상담중 등 계약 계열(CONTRACTED_STATUS_SYNONYMS) = 판매 가능이되 «계약중»(선점) 표시
 * (대표 2026-10-14 «계약중은 연동해서 계약중으로, 출고불가만 안 올린다»), 보류·판매완료 = 불가. 모르는 값은 보류(STATUS_UNKNOWN)다.
 * 보증금: 시트에 보증금 칸은 없다. 시트에 적힌 계산 규칙(대표 2026-10-14) = 월 대여료 × 2(국산) / × 3(수입)으로 항마다 계산하고,
 * 계산값임을 term.raw.deposit_rule 에 남긴다. 국산/수입을 가를 수 없으면 UNKNOWN(추측 금지, domain/autoplus-deposit-rule). */
import { MONTHLY_RENT_MIN, MONTHLY_RENT_MAX } from '../domain/source-rent-text.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import { isContractedStatus } from '../domain/erp5-inventory-status.js';
import { autoplusDepositRuleFor, autoplusRuleDeposit, classifyAutoplusVehicleOrigin } from '../domain/autoplus-deposit-rule.js';
import { fuelName } from './normalize-sonogong.js';
const SELLABLE = new Set(['판매중', '할인판매', '상품대기']); // 계약중 = 모든 원천에서 같게: 문서 유지 + «계약중» 표시 노출(선점), 출고가능 비교에서는 제외(커맨드 센터 2026-10-14)
const NOT_SELLABLE = new Set(['보류', '판매완료', '출고완료', '판매불가', '출고불가']); // 출고불가 = 대표 10-14 «출고불가만 안 올린다»(보류로 빠지면 회차 부재 하향 전체가 멈춘다)
const unknownAmount = { state: 'UNKNOWN', value: null };
const RENT_MIN = MONTHLY_RENT_MIN, RENT_MAX = MONTHLY_RENT_MAX; // 공용 월 대여료 타당 범위(공통 시트·아이카와 같은 값)
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const rentOf = (v) => {
    const t = clean(v).replace(/[,\s원]/g, '');
    if (t === '' || /^[-–—xX]$/.test(t))
        return null; // 빈칸·«-» = 제안 없음
    const n = Number(t);
    return Number.isSafeInteger(n) && n >= RENT_MIN && n <= RENT_MAX ? { state: 'KNOWN', value: n } : unknownAmount;
};
/** 시트 보증금 칸(있으면 규칙 계산보다 먼저, Codex #642 ②): 1원~1억 정수 = KNOWN, **명시 문구(«무보증»·«보증금없음»)만 ZERO**.
 * 숫자 0·문자열 «0»·빈칸·형식 밖 = «값 없음»(UNKNOWN) — 산출 근거 없는 0 은 확정 0원이 아니다(대표 정산 규칙 «0원 확정 금지»). */
const DEPOSIT_MAX = 100_000_000;
const EXPLICIT_NO_DEPOSIT = new Set(['무보증', '보증금없음']);
const sourceDepositOf = (v) => {
    const t = clean(v).replace(/[,\s원]/g, '');
    if (t === '')
        return unknownAmount;
    if (EXPLICIT_NO_DEPOSIT.has(t))
        return { state: 'ZERO', value: 0 };
    const n = Number(t);
    if (!Number.isSafeInteger(n) || n <= 0 || n > DEPOSIT_MAX)
        return unknownAmount;
    return { state: 'KNOWN', value: n };
};
/** 머리글 행을 찾는다: «차량번호»와 «판매상태» 가 같은 행에 있어야 한다(앞 30행 안). */
const headerRow = (values) => values.slice(0, 30).findIndex(r => {
    const cells = r.map(clean);
    return cells.includes('차량번호') && cells.includes('판매상태');
});
export function readAutoplusSheet(tabs, observedAt) {
    const records = [], held = [], seen = new Set(), duplicates = new Set();
    const tabsUsed = [];
    let rowCount = 0;
    for (const tab of tabs) {
        const hi = headerRow(tab.values);
        if (hi < 0)
            continue;
        const headers = tab.values[hi].map(clean);
        const iPlate = headers.indexOf('차량번호'), iStatus = headers.indexOf('판매상태');
        const iKind = headers.indexOf('차종'), iModel = headers.indexOf('모델명'), iColor = headers.indexOf('색상'), iFuel = headers.indexOf('연료');
        // 제조사 열(있으면): 국산/수입 판정 근거로만 쓴다.
        const iMaker = headers.findIndex(h => ['제조사', '브랜드', '메이커'].includes(h.replace(/\s+/g, '')));
        const iDeposit = headers.findIndex(h => h.replace(/\s+/g, '') === '보증금');
        const iFirst = headers.indexOf('최초등록일'), iMileage = headers.findIndex(h => h.replace(/\s+/g, '') === '예상주행거리');
        // 요금 열: «<개월>개월 <1|2|3>만km» (줄바꿈·공백 차이는 무시)
        const rateColumns = headers.map((h, index) => {
            const m = /^(\d{1,2})\s*개월\s*(\d)\s*만\s*km$/.exec(h.replace(/\s+/g, ' '));
            return m ? { index, months: Number(m[1]), km: Number(m[2]) * 10000 } : null;
        }).filter((x) => !!x);
        if (!rateColumns.length)
            continue;
        tabsUsed.push(tab.title);
        for (let i = hi + 1; i < tab.values.length; i++) {
            const row = tab.values[i];
            const plateRaw = clean(row[iPlate]).replace(/\s+/g, '');
            if (!plateRaw)
                continue;
            rowCount++;
            // 번호 형식은 엄격히: 숫자 2~3자리 + 한글 한 글자 + 숫자 4자리만(구두점·영문이 섞인 표기는 별도 차량으로 편입하지 않고 보류한다).
            if (!/^\d{2,3}[가-힣]\d{4}$/.test(plateRaw) || !isAssignedPlate(plateRaw)) {
                held.push({ tab: tab.title, row: i + 1, reason: 'PLATE_INVALID' });
                continue;
            }
            const plate = plateIdentityKey(plateRaw);
            if (seen.has(plate)) {
                duplicates.add(plate);
                continue;
            }
            seen.add(plate);
            const status = clean(row[iStatus]);
            const contracted = isContractedStatus(status);
            const sellable = SELLABLE.has(status) || contracted;
            if (!sellable && !NOT_SELLABLE.has(status)) {
                held.push({ tab: tab.title, row: i + 1, reason: 'STATUS_UNKNOWN' });
                continue;
            }
            const kind = iKind >= 0 ? clean(row[iKind]) : '', model = iModel >= 0 ? clean(row[iModel]) : '';
            const maker = iMaker >= 0 ? clean(row[iMaker]) : '';
            const origin = classifyAutoplusVehicleOrigin(maker, kind, model);
            const rule = origin.origin === 'UNKNOWN' ? null : autoplusDepositRuleFor(origin.origin);
            const terms = [];
            for (const col of rateColumns) {
                const rent = rentOf(row[col.index]);
                if (!rent || rent.state !== 'KNOWN')
                    continue;
                // 1순위 = 시트 보증금 칸(공급사가 적은 금액): 양수 KNOWN, «무보증»·«보증금없음» 만 ZERO. 칸이 없거나 값이 없을 때만 규칙으로 계산한다(Codex #642 ②).
                const sourceDeposit = iDeposit >= 0 ? sourceDepositOf(row[iDeposit]) : unknownAmount;
                if (sourceDeposit.state !== 'UNKNOWN') {
                    terms.push({ months: col.months, monthlyRent: rent, deposit: sourceDeposit, mileage: `${col.km}km/year`, raw: { deposit_source: 'SHEET_DEPOSIT_COLUMN' } });
                    continue;
                }
                const amount = rule ? autoplusRuleDeposit(rule, rent.value) : null;
                // 계산값(공급사가 적은 금액 아님, Codex #642 ①): raw.deposit_rule 만 남긴다 — 엔진 기록은 이를 deposit_source=CALCULATED 로 쓰고(calculatedDepositFields),
                // 소비처는 CALCULATED_RULE 로 구분한다. 시트 원문에 보증금 문구가 없으므로 «확정 문구»(deposit_confirmation)는 두지 않는다(공급사 확인 금액으로 보이면 안 된다). 규칙을 못 정하면 UNKNOWN(엔진이 기존 KNOWN 을 보존한다). ZERO 는 규칙에서 나오지 않는다.
                terms.push(amount !== null && rule
                    ? { months: col.months, monthlyRent: rent, deposit: { state: 'KNOWN', value: amount }, mileage: `${col.km}km/year`,
                        raw: { deposit_rule: rule } }
                    : { months: col.months, monthlyRent: rent, deposit: unknownAmount, mileage: `${col.km}km/year`, raw: {} });
            }
            const vehicleText = model && kind && !model.includes(kind) ? `${kind} ${model}` : (model || kind);
            const first = iFirst >= 0 ? clean(row[iFirst]) : '';
            const firstYm = /^(\d{4})[-./](\d{1,2})/.exec(first);
            const mileage = iMileage >= 0 ? clean(row[iMileage]).replace(/[^\d]/g, '') : '';
            const spec = {};
            if (iColor >= 0 && clean(row[iColor]))
                spec.ext_color = clean(row[iColor]);
            const sourceFuel = iFuel >= 0 ? clean(row[iFuel]) : '';
            const fuel = fuelName(sourceFuel);
            if (fuel)
                spec.fuel_type = fuel;
            if (firstYm) {
                spec.first_registration_date = `${firstYm[1]}-${firstYm[2].padStart(2, '0')}`;
                spec.year = firstYm[1];
            }
            if (mileage)
                spec.mileage = mileage;
            records.push({ sourceId: 'RP023', uid: plate, plate, vehicleText,
                // 표시 상태는 «출고가능»(판매 가능) 또는 시트 상태 그대로(계약중 등) — 판매 가능 판정은 saleAvailable 하나가 정한다.
                status: { raw: contracted ? '계약중' : sellable ? '출고가능' : status, saleAvailable: sellable }, terms, observedAt,
                raw: { source: 'autoplus-sheet', source_tab: tab.title, source_row: i + 1, sheet_status: status, vehicle_origin: origin.origin, product_group: 'LONG_TERM', product_type: '오플구독', ...(sourceFuel ? { source_fuel_text: sourceFuel } : {}), ...(Object.keys(spec).length ? { spec } : {}) },
                vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] });
        }
    }
    const clean_ = tabsUsed.length > 0 && duplicates.size === 0 && records.length > 0;
    const incompleteReason = !tabsUsed.length ? 'SHEET_TABS_NOT_FOUND' : duplicates.size ? 'DUPLICATE_PLATES' : !records.length ? 'SHEET_EMPTY' : undefined;
    return { observedAt, complete: clean_, ...(incompleteReason ? { incompleteReason } : {}), tabsUsed, rowCount, records, held, duplicatePlates: [...duplicates] };
}
/** 시트 행 수 하한: 직전 정상 회차 행 수의 80%, 잠금 제외 노출 문서 수의 80% 중 큰 값(부분 읽기 방어). 둘 다 0 이면 0. */
export const autoplusSheetRowFloor = (unlockedExposed, previousRows) => Math.max(Math.ceil(unlockedExposed * 0.8), Math.ceil(previousRows * 0.8));
