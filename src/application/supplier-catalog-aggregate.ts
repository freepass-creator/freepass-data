/** 배포 catalog(/api/catalog 응답) 공급사별 집계 — 순수·읽기 전용. 공급사-catalog-집계(커맨드 센터 2026-10-14) 표와 같은 열:
 * 노출 | 출고가능 | 계약중 | 사진없음 | 구분없음 | 가격행없음 | 보증금미상.
 * 입력은 저장된 응답 JSON 이다(네트워크 없음). 원본 products(provider_name·vehicle_status·price·image_url·product_type)와
 * 정규화 vehicles(supplier·dispatchLabel·rates·imageUrl·productType) 둘 다 받는다. 출력에는 차량번호·키·원문이 없다(공급사 이름과 건수만). */
export type CatalogAggregateRow = { supplier: string; exposed: number; dispatchable: number; contracted: number; noPhoto: number;
  noProductType: number; noPriceRow: number; depositUnknown: number; otherStatus: number };
export type CatalogAggregate = { rows: CatalogAggregateRow[]; total: Omit<CatalogAggregateRow, 'supplier'>; depositMode: 'any' | 'all'; skipped: number };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const first = (r: Rec, keys: readonly string[]): string => { for (const k of keys) { const t = text(r[k]); if (t) return t; } return ''; };

/** 응답 JSON 에서 차량 배열을 꺼낸다: {products:[...]} | {vehicles:[...]} | [...] | {data:{...}}. */
export function catalogItems(json: unknown): Rec[] {
  const pick = (v: unknown): unknown[] | null => Array.isArray(v) ? v : isRec(v) ? (['products', 'vehicles', 'items', 'data'] as const)
    .map(k => v[k]).map(x => Array.isArray(x) ? x : isRec(x) ? pick(x) : null).find(x => x !== null) ?? null : null;
  return (pick(json) ?? []).filter(isRec);
}

const DISPATCHABLE = new Set(['출고가능', '즉시출고', '가용']);
const hasPhoto = (r: Rec): boolean => {
  const urls = r.image_urls ?? r.images;
  if (Array.isArray(urls) && urls.some(u => typeof u === 'string' ? !!u.trim() : isRec(u) && !!first(u, ['url', 'src']))) return true;
  return !!first(r, ['image_url', 'imageUrl', 'thumbnail', 'photo_url']);
};
const priceRows = (r: Rec): Rec[] => {
  if (Array.isArray(r.rates)) return r.rates.filter(isRec);
  return isRec(r.price) ? Object.values(r.price).filter(isRec) : [];
};
const rentOf = (row: Rec): number => { const v = row.rent ?? row.monthlyRent; return typeof v === 'number' && Number.isFinite(v) ? v : 0; };
const depositUnknown = (row: Rec): boolean => {
  const state = text(row.depositState);
  if (state === 'UNKNOWN') return true;
  if (['KNOWN', 'ZERO', 'NOT_APPLICABLE'].includes(state)) return false;
  return row.deposit === null || row.deposit === undefined || row.deposit === '';
};

/** depositMode: 'any' = 가격 행 중 하나라도 보증금 미상인 차량, 'all' = 가격 행이 전부 미상인 차량. */
export function aggregateCatalog(json: unknown, options: { depositMode?: 'any' | 'all' } = {}): CatalogAggregate {
  const depositMode = options.depositMode ?? 'any';
  const by = new Map<string, CatalogAggregateRow>();
  let skipped = 0;
  for (const item of catalogItems(json)) {
    const supplier = first(item, ['provider_name', 'supplier', 'providerName', 'supplier_name']);
    if (!supplier) { skipped++; continue; }
    const row = by.get(supplier) ?? { supplier, exposed: 0, dispatchable: 0, contracted: 0, noPhoto: 0, noProductType: 0, noPriceRow: 0, depositUnknown: 0, otherStatus: 0 };
    by.set(supplier, row);
    row.exposed++;
    const status = first(item, ['vehicle_status', 'dispatchLabel', 'status']);
    if (status.includes('계약중')) row.contracted++;
    else if (DISPATCHABLE.has(status)) row.dispatchable++;
    else row.otherStatus++;
    if (!hasPhoto(item)) row.noPhoto++;
    if (!first(item, ['product_type', 'productType'])) row.noProductType++;
    const priced = priceRows(item).filter(p => rentOf(p) > 0);
    if (!priced.length) row.noPriceRow++;
    else if (depositMode === 'all' ? priced.every(depositUnknown) : priced.some(depositUnknown)) row.depositUnknown++;
  }
  const rows = [...by.values()].sort((a, b) => b.exposed - a.exposed || a.supplier.localeCompare(b.supplier, 'ko'));
  const total = rows.reduce((t, r) => ({ exposed: t.exposed + r.exposed, dispatchable: t.dispatchable + r.dispatchable, contracted: t.contracted + r.contracted,
    noPhoto: t.noPhoto + r.noPhoto, noProductType: t.noProductType + r.noProductType, noPriceRow: t.noPriceRow + r.noPriceRow,
    depositUnknown: t.depositUnknown + r.depositUnknown, otherStatus: t.otherStatus + r.otherStatus }),
    { exposed: 0, dispatchable: 0, contracted: 0, noPhoto: 0, noProductType: 0, noPriceRow: 0, depositUnknown: 0, otherStatus: 0 });
  return { rows, total, depositMode, skipped };
}

/** 커맨드 센터 «공급사-catalog-집계» 와 같은 마크다운 표(합계·기타 상태·공급사 미상 주석은 표 아래 줄). */
export function catalogAggregateMarkdown(aggregate: CatalogAggregate, generatedAt: string): string {
  const line = (r: Omit<CatalogAggregateRow, 'otherStatus'> & { supplier: string }) =>
    `|${r.supplier}|${r.exposed}|${r.dispatchable}|${r.contracted}|${r.noPhoto}|${r.noProductType}|${r.noPriceRow}|${r.depositUnknown}|`;
  const out = [`# 공급사별 배포 catalog 집계 — ${generatedAt}`,
    `(/api/catalog, 노출 기준. 보증금미상 = 가격 행 중 ${aggregate.depositMode === 'all' ? '전부' : '하나라도'} 보증금 미확인인 차량)`, '',
    '|공급사|노출|출고가능|계약중|사진없음|구분없음|가격행없음|보증금미상|', '|-|-|-|-|-|-|-|-|',
    ...aggregate.rows.map(line), line({ supplier: '합계', ...aggregate.total })];
  if (aggregate.total.otherStatus) out.push('', `※ 출고가능·계약중이 아닌 상태 ${aggregate.total.otherStatus}건: ` +
    aggregate.rows.filter(r => r.otherStatus).map(r => `${r.supplier} ${r.otherStatus}`).join(', '));
  if (aggregate.skipped) out.push('', `※ 공급사 이름이 없어 제외 ${aggregate.skipped}건`);
  return out.join('\n') + '\n';
}
