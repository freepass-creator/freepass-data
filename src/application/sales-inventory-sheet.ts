/** 영업자용 재고 시트 발행 «계획»(순수, 읽기 전용 — 시트 쓰기·공유 없음). 설계: docs/SALES-INVENTORY-SHEET-DESIGN-20261016.md (커맨드 센터 2026-10-16 승인).
 * 입력은 ERP5 공개 피드 출력(buildPublicProductFeed 의 결과 그대로)이다 — 시트용 별도 필터·재계산을 두지 않아 목록이 ERP5 와 어긋나지 않는다.
 * 출력: 버전 탭 이름·머리글·행(문자열)과 검증 리포트(건수·차량 키 대조·금지 필드·금지 문구·번호 중복·칸 허용 목록). 위반이 하나라도 있으면 ok=false,
 * 발행은 하지 않는다. 공급사명: 영업자용 채널은 ERP5 와 같게 «보인다»(ERP·개발 확인 2026-10-16: 일반·하허호·이안카 채널은 supplier 를 표시, 소비자용 audience=consumer 만 숨김).
 * 채널 간 차이는 audience 하나다 — 소비자용 문서는 audience='consumer' 로 공급사 칸을 뺀다. 수수료·원가·내부 메모·잠금·원문 차명은 피드에 없으며 여기서도 낼 수 없다. */

/** 피드 상품의 «사용하는 부분»만 구조적으로 선언한다(application 은 api 에 의존하지 않는다 — 호환은 시험이 지킨다). */
export type SalesFeedProduct = {
  publicProductKey: string; car_number: string | null;
  maker: string | null; model: string | null; sub_model: string | null; trim_name: string | null;
  fuel_type: string | null; year: number | null; mileage: number | null; ext_color: string | null;
  provider_name: string | null; product_type: string | null; vehicle_status: string | null;
  price: Record<string, { rent: number | null; deposit: number | null; depositState: string }>;
  image_url: string | null; photo_link: string | null;
};
export type SalesFeed = { contractVersion: string; count: number; products: SalesFeedProduct[] };

export const SALES_SHEET_TERMS = [12, 24, 36, 48, 60] as const;
export const SALES_SHEET_BASE_COLUMNS = ['차량번호', '제조사', '모델', '세부모델', '세부트림', '연료', '연식', '주행거리(km)', '외부색상', '상품 구분', '출고 상태'] as const;
const termColumns = SALES_SHEET_TERMS.flatMap(m => [`${m}개월 대여료`, `${m}개월 보증금`]);
export const SALES_SHEET_TAIL_COLUMNS = ['요금 조건 수', '사진 링크'] as const;
/** 칸 허용 목록: 머리글은 이 집합 안에서만 나온다(수수료·원가·메모·잠금·원문 류가 새 칸으로 들어올 수 없다). */
export const SALES_SHEET_ALLOWED_COLUMNS: ReadonlySet<string> = new Set([...SALES_SHEET_BASE_COLUMNS, ...termColumns, ...SALES_SHEET_TAIL_COLUMNS, '공급사']);
const NEEDS_CHECK = '확인 필요';
const REVIEW_NAME = '차량 정보 확인 중';

/** 영업자용(sales, 기본) = 공급사명 표시, 소비자용(consumer) = 숨김. */
export type SalesAudience = 'sales' | 'consumer';
export type SalesSheetOptions = { snapshotId: string; generatedAt: string; audience?: SalesAudience };
export type SalesSheetViolation = { code: string; detail: string };
export type SalesSheetPlan = {
  versionTab: string;
  header: string[];
  rows: string[][];
  validation: { ok: boolean; violations: SalesSheetViolation[] };
  summary: { snapshotId: string; generatedAt: string; feedCount: number; rowCount: number; byStatus: Record<string, number>; byProductType: Record<string, number>;
    nameReviewRows: number; priceMissingRows: number; photoRows: number; providerColumn: boolean };
};

const STATUS_LABEL: Record<string, string> = { AVAILABLE: '출고가능', CONTRACTING: '계약중', CONSULT_REQUIRED: '출고협의', UNAVAILABLE: '출고불가', UNKNOWN: NEEDS_CHECK };
const FORBIDDEN_FIELD = /vin|fee|commission|payout|billing|margin|partner_memo|sales_notes|memo|source|raw|audit|lock|원문|수수료|원가|정산/i;
const FORBIDDEN_TEXT_COMPACT = /(수수료|청구|지급|마진|원가|정산|commission|payout|billing|margin)/;
const FORBIDDEN_TEXT_WORD = /(^|[^a-z])f[\s\p{P}\p{S}_]*e[\s\p{P}\p{S}_]*e[\s\p{P}\p{S}_]*s?(?![a-z])/u;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180e\\u200b-\\u200f\\u2028-\\u202f\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff]', 'g');
/** 금지 문구 검사 전 정규화: NFKC·소문자·제로폭/제어 문자 제거. 공백·구두점을 모두 지운 꼴과 단어 경계 꼴을 둘 다 본다(«수 수 료»·«f e e» 우회 방지). */
const hasForbiddenText = (cell: string): boolean => {
  const base = cell.normalize('NFKC').toLowerCase().replace(INVISIBLE, '');
  const compact = base.replace(/[\s\p{P}\p{S}_]+/gu, '');
  const isUrl = /^https?:\/\//.test(base);   // 사진 주소 경로에 coffee 같은 낱말이 있어도 막지 않는다
  return FORBIDDEN_TEXT_COMPACT.test(compact) || (!isUrl && FORBIDDEN_TEXT_WORD.test(base));
};
/** 요약·셀에 나가는 상품 구분은 대문자 코드 꼴만 통과(원문 차명·번호 등이 새지 않게). */
const productTypeLabel = (v: unknown) => { const t = text(v); return /^[A-Z][A-Z0-9_]{1,39}$/.test(t) ? t : (t ? '기타' : ''); };
const won = (v: number | null) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : '');

/** 버전 탭 이름: 재고_YYYYMMDD_HHmm (한국 시각). generatedAt 이 시각이 아니면 던진다(발행 근거 없음). */
export function salesVersionTabName(generatedAt: string): string {
  const ms = Date.parse(generatedAt);
  if (!Number.isFinite(ms)) throw new Error('SALES_SHEET_GENERATED_AT_INVALID');
  const kst = new Date(ms + 9 * 3_600_000).toISOString();   // UTC 필드를 KST 값으로 읽는다
  return `재고_${kst.slice(0, 10).replace(/-/g, '')}_${kst.slice(11, 16).replace(':', '')}`;
}

export function planSalesInventorySheet(feed: SalesFeed, options: SalesSheetOptions): SalesSheetPlan {
  if (!options.snapshotId.trim()) throw new Error('SALES_SHEET_SNAPSHOT_ID_REQUIRED');
  const providerColumn = (options.audience ?? 'sales') === 'sales';
  const header = [...SALES_SHEET_BASE_COLUMNS, ...termColumns, ...SALES_SHEET_TAIL_COLUMNS, ...(providerColumn ? ['공급사'] : [])];
  const violations: SalesSheetViolation[] = [];
  const rows: string[][] = [];
  const summary: SalesSheetPlan['summary'] = { snapshotId: options.snapshotId, generatedAt: options.generatedAt, feedCount: feed.products.length, rowCount: 0,
    byStatus: {}, byProductType: {}, nameReviewRows: 0, priceMissingRows: 0, photoRows: 0, providerColumn };
  const seenPlates = new Set<string>(), seenKeys = new Set<string>();
  if (feed.count !== feed.products.length) violations.push({ code: 'FEED_COUNT_MISMATCH', detail: `${feed.count}/${feed.products.length}` });
  for (const column of header) if (!SALES_SHEET_ALLOWED_COLUMNS.has(column)) violations.push({ code: 'COLUMN_NOT_ALLOWED', detail: column });
  // 위반 detail 에는 값·필드명·키를 싣지 않는다(번호·개인정보가 들어 있을 수 있음) — 행 순번만.
  for (const [index, p] of feed.products.entries()) {
    const where = `row#${index}`;
    const key = text(p.publicProductKey);
    if (!key) { violations.push({ code: 'PRODUCT_KEY_MISSING', detail: where }); continue; }
    if (seenKeys.has(key)) violations.push({ code: 'PRODUCT_KEY_DUPLICATE', detail: where });
    seenKeys.add(key);
    if (Object.keys(p).some(field => FORBIDDEN_FIELD.test(field))) violations.push({ code: 'FORBIDDEN_FIELD_IN_FEED', detail: where });
    const plate = text(p.car_number);
    if (plate) {
      if (seenPlates.has(plate)) violations.push({ code: 'PLATE_DUPLICATE', detail: plate.slice(-4) });
      seenPlates.add(plate);
    }
    const names = [text(p.maker), text(p.model), text(p.sub_model)];
    const nameReview = names.every(n => !n);
    if (nameReview) summary.nameReviewRows++;
    const status = STATUS_LABEL[text(p.vehicle_status)] ?? NEEDS_CHECK;
    const photo = text(p.photo_link) || text(p.image_url);
    if (photo) summary.photoRows++;
    const terms = SALES_SHEET_TERMS.flatMap(months => {
      const row = p.price?.[String(months)];
      return [won(row?.rent ?? null), row && (row.depositState === 'KNOWN' || row.depositState === 'ZERO') ? won(row.deposit) : NEEDS_CHECK];
    });
    if (terms.every(t => t === '' || t === NEEDS_CHECK)) summary.priceMissingRows++;
    const cells = [
      plate || NEEDS_CHECK, names[0] || (nameReview ? REVIEW_NAME : ''), names[1] || '', names[2] || '', text(p.trim_name),
      text(p.fuel_type), p.year === null || p.year === undefined ? '' : String(p.year), p.mileage === null || p.mileage === undefined ? '' : String(p.mileage), text(p.ext_color),
      productTypeLabel(p.product_type), status, ...terms, String(Object.keys(p.price ?? {}).length), photo,
      ...(providerColumn ? [text(p.provider_name)] : []),
    ];
    for (const cell of cells) if (hasForbiddenText(cell)) { violations.push({ code: 'FORBIDDEN_TEXT_IN_CELL', detail: where }); break; }
    summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;
    const type = productTypeLabel(p.product_type) || NEEDS_CHECK;
    summary.byProductType[type] = (summary.byProductType[type] ?? 0) + 1;
    rows.push(cells);
  }
  summary.rowCount = rows.length;
  if (rows.length !== feed.products.length) violations.push({ code: 'ROW_COUNT_MISMATCH', detail: `${rows.length}/${feed.products.length}` });
  return { versionTab: salesVersionTabName(options.generatedAt), header, rows, validation: { ok: violations.length === 0, violations }, summary };
}

/** 계획의 차량 키 집합을 독립으로 다시 읽은 피드와 대조한다(발행 직전 «ERP5 와 같다» 확인). 차이는 키 끝 4자리만 낸다. */
export function compareSalesPlanWithFeed(plan: SalesSheetPlan, fresh: SalesFeed, plateOf: (p: SalesFeedProduct) => string = p => text(p.car_number)) {
  const planPlates = new Set(plan.rows.map(r => r[0]!).filter(v => v && v !== NEEDS_CHECK));
  const freshPlates = new Set(fresh.products.map(plateOf).filter(Boolean));
  const missingInSheet = [...freshPlates].filter(p => !planPlates.has(p)), extraInSheet = [...planPlates].filter(p => !freshPlates.has(p));
  return { equal: !missingInSheet.length && !extraInSheet.length && plan.rows.length === fresh.products.length,
    planCount: plan.rows.length, freshCount: fresh.products.length,
    missingInSheet: missingInSheet.map(p => p.slice(-4)), extraInSheet: extraInSheet.map(p => p.slice(-4)) };
}
