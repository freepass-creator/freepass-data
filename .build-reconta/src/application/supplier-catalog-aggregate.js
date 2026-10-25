const isRec = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' ? v.trim() : '';
const first = (r, keys) => { for (const k of keys) {
    const t = text(r[k]);
    if (t)
        return t;
} return ''; };
/** 응답 JSON 에서 차량 배열을 꺼낸다: {products:[...]} | {vehicles:[...]} | [...] | {data:{...}}. */
export function catalogItems(json) {
    const pick = (v) => Array.isArray(v) ? v : isRec(v) ? ['products', 'vehicles', 'items', 'data']
        .map(k => v[k]).map(x => Array.isArray(x) ? x : isRec(x) ? pick(x) : null).find(x => x !== null) ?? null : null;
    return (pick(json) ?? []).filter(isRec);
}
const DISPATCHABLE = new Set(['출고가능', '즉시출고', '가용']);
const hasPhoto = (r) => {
    const urls = r.image_urls ?? r.images;
    if (Array.isArray(urls) && urls.some(u => typeof u === 'string' ? !!u.trim() : isRec(u) && !!first(u, ['url', 'src'])))
        return true;
    return !!first(r, ['image_url', 'imageUrl', 'thumbnail', 'photo_url']);
};
/** summary-v1 압축 가격 행 [key, months, rent, deposit, stateIndex, annualMileage, mileageIndex, maturityIndex] 의 보증금 상태 어휘(ERP5 catalog-summary.js 와 같은 순서). */
const SUMMARY_DEPOSIT_STATES = ['KNOWN', 'ZERO', 'UNKNOWN', 'NOT_APPLICABLE'];
const priceRows = (r) => {
    if (Array.isArray(r.rates))
        return r.rates.flatMap((row) => isRec(row) ? [row]
            : Array.isArray(row) && row.length === 8 ? [{ months: row[1], rent: row[2], deposit: row[3], depositState: SUMMARY_DEPOSIT_STATES[row[4]] ?? '' }] : []);
    return isRec(r.price) ? Object.values(r.price).filter(isRec) : [];
};
const rentOf = (row) => { const v = row.rent ?? row.monthlyRent; return typeof v === 'number' && Number.isFinite(v) ? v : 0; };
/** 보증금 칸이 «아는 값이 아님»: basis 'value'(기본, 커맨드 센터 정의) = 보증금 값이 null/빈칸, 'state' = depositState 가 UNKNOWN 이거나(상태가 없으면 값이 null). */
const depositUnknown = (row, basis) => {
    const blank = row.deposit === null || row.deposit === undefined || row.deposit === '';
    if (basis === 'value')
        return blank;
    const state = text(row.depositState);
    if (state === 'UNKNOWN')
        return true;
    if (['KNOWN', 'ZERO', 'NOT_APPLICABLE'].includes(state))
        return false;
    return blank;
};
/** depositMode: 'all'(기본, 커맨드 센터 21:50 정의) = 보증금이 아는 값인 가격 행이 하나도 없는 차량, 'any' = 하나라도 모르는 행이 있는 차량.
 * depositBasis: 'value'(기본) = 보증금 값이 비어 있으면 모름, 'state' = depositState 로 판정. */
export function aggregateCatalog(json, options = {}) {
    const depositMode = options.depositMode ?? 'all', basis = options.depositBasis ?? 'value';
    const by = new Map();
    let skipped = 0;
    for (const item of catalogItems(json)) {
        const supplier = first(item, ['provider_name', 'supplier', 'providerName', 'supplier_name']);
        if (!supplier) {
            skipped++;
            continue;
        }
        const row = by.get(supplier) ?? { supplier, exposed: 0, dispatchable: 0, contracted: 0, noPhoto: 0, noProductType: 0, noPriceRow: 0, depositUnknown: 0, otherStatus: 0 };
        by.set(supplier, row);
        row.exposed++;
        const status = first(item, ['vehicle_status', 'dispatchLabel', 'status']);
        // 출고가능 = 노출 − 계약중(커맨드 센터 21:50 표 정의). 표시 상태가 출고가능·즉시출고가 아닌 차량(출고협의 등)은 otherStatus 로 따로 알린다.
        if (status.includes('계약중'))
            row.contracted++;
        else {
            row.dispatchable++;
            if (!DISPATCHABLE.has(status))
                row.otherStatus++;
        }
        if (!hasPhoto(item))
            row.noPhoto++;
        if (!first(item, ['product_type', 'productType']))
            row.noProductType++;
        const priced = priceRows(item).filter(p => rentOf(p) > 0);
        if (!priced.length)
            row.noPriceRow++;
        else if (depositMode === 'all' ? priced.every(p => depositUnknown(p, basis)) : priced.some(p => depositUnknown(p, basis)))
            row.depositUnknown++;
    }
    const rows = [...by.values()].sort((a, b) => b.exposed - a.exposed || a.supplier.localeCompare(b.supplier, 'ko'));
    const total = rows.reduce((t, r) => ({ exposed: t.exposed + r.exposed, dispatchable: t.dispatchable + r.dispatchable, contracted: t.contracted + r.contracted,
        noPhoto: t.noPhoto + r.noPhoto, noProductType: t.noProductType + r.noProductType, noPriceRow: t.noPriceRow + r.noPriceRow,
        depositUnknown: t.depositUnknown + r.depositUnknown, otherStatus: t.otherStatus + r.otherStatus }), { exposed: 0, dispatchable: 0, contracted: 0, noPhoto: 0, noProductType: 0, noPriceRow: 0, depositUnknown: 0, otherStatus: 0 });
    return { rows, total, depositMode, skipped };
}
/** 커맨드 센터 «공급사-catalog-집계» 와 같은 마크다운 표(합계·기타 상태·공급사 미상 주석은 표 아래 줄). */
export function catalogAggregateMarkdown(aggregate, generatedAt) {
    const line = (r) => `|${r.supplier}|${r.exposed}|${r.dispatchable}|${r.contracted}|${r.noPhoto}|${r.noProductType}|${r.noPriceRow}|${r.depositUnknown}|`;
    const out = [`# 공급사별 배포 catalog 집계 — ${generatedAt}`,
        `(/api/catalog, 노출 기준. 보증금미상 = ${aggregate.depositMode === 'all' ? '보증금이 아는 값인 가격 행이 하나도 없는' : '보증금을 모르는 가격 행이 있는'} 차량)`, '',
        '|공급사|노출|출고가능|계약중|사진없음|구분없음|가격행없음|보증금미상|', '|-|-|-|-|-|-|-|-|',
        ...aggregate.rows.map(line), line({ supplier: '합계', ...aggregate.total })];
    if (aggregate.total.otherStatus)
        out.push('', `※ 출고가능 칸(= 노출 − 계약중) 중 표시 상태가 출고가능·즉시출고가 아닌 차량 ${aggregate.total.otherStatus}건: ` +
            aggregate.rows.filter(r => r.otherStatus).map(r => `${r.supplier} ${r.otherStatus}`).join(', '));
    if (aggregate.skipped)
        out.push('', `※ 공급사 이름이 없어 제외 ${aggregate.skipped}건`);
    return out.join('\n') + '\n';
}
