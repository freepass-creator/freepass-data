/** 아이언렌트카(RP006) 홈페이지 상세 기준 어댑터 — 커맨드 센터 2026-10-14: «사이트맵·목록 상세 전수, 판매완료 라벨 제외, 번호 키, 사진 갤러리».
 * 구조는 ERP4 수집기(lib/server/ironrentcar-source.ts)가 검증한 것과 같다: 목록 `/vehicles?condition=new|used`(더보기 페이지네이션, article 의
 * `rental-product-card--sold` = 판매완료) → 상세 `/vehicles/{id}`(제목·dt/dd 사실·기간별 요금 행·보증금 블록·배지·갤러리).
 * 안전: 허용 호스트 고정(ironrentcar.com), 직렬·간격·재시도 0, 읽기 GET 만, HTML 응답 아님·번호 형식 오류·목록 순환은 실패.
 * 이 모듈을 import 하는 것만으로 접속하지 않는다(fetch 주입). 번호 전체·원문은 로그·오류에 남기지 않는다. */
import type { SourceAmount, SourceProductRecord, SourceTerm } from '../domain/source-engine.js';
import { isNoPriceText, isPlausibleMonthlyRent } from '../domain/source-rent-text.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import { isContractedStatus } from '../domain/erp5-inventory-status.js';
import { canonicalFuel } from '../domain/fuel-alias.js';

export const IRON_HOMEPAGE_POLICY = Object.freeze({ host: 'ironrentcar.com', baseUrl: 'https://ironrentcar.com', maxPages: 10, minIntervalMs: 500, timeoutMs: 20_000 });
/** 차량 사진 원본 호스트(공개 버킷, scripts/ops/photo-cache-iron.mjs 와 같은 값). 이 호스트·이 경로만 사진으로 받는다(https 만). */
export const IRON_PHOTO_POLICY = Object.freeze({ host: 'cbtbscasurhavjvjfvpv.supabase.co', pathPrefix: '/storage/v1/object/public/vehicle-product-images/' });
export type IronCondition = 'new' | 'used';
export type IronListing = { id: string; url: string; condition: IronCondition; sold: boolean };

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, m => ENTITIES[m] ?? m).replace(/\s+/g, ' ').trim();
/** 할인 전 정가(취소선 <del>/<s>/<strike>)는 지운다 — 앞에 있는 정가를 실제 요금으로 읽지 않는다. */
const withoutStruck = (html: string) => html.replace(/<(del|s|strike)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
/** 금액 해석: 숫자가 없으면 null(모름), «0원»·«0만원» 은 0. */
const wonOrNull = (value: string): number | null => {
  const t = text(withoutStruck(value)).normalize('NFKC');
  if (/[~∼〜%−]|\d\s*[-–—]\s*\d|\([^)]*\d[^)]*원[^)]*\)/.test(t)
    || /이상|이하|부터|미만|초과|내외|가량|정도|최소|최대|약\s*\d|원\s*대/.test(t)) return null;
  const matches = [...t.matchAll(/(-?[\d][\d,.]*)\s*(천만|억|만|천)?\s*원/g)];
  if (matches.length !== 1) return null;
  const hit = matches[0]!;
  if (/[\d.,+-]/.test(t[(hit.index ?? 0) - 1] ?? '') || /\d/.test(t.replace(hit[0], ''))) return null;
  const [, number, unit] = matches[0]!;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(number!)) return null;
  // Decimal scaling is exact; fractional won has no authorized rounding rule.
  const [whole, fraction = ''] = number!.replace(/,/g, '').split('.');
  // A dot followed by three digits can be a grouping separator; do not guess.
  if (fraction.length === 3) return null;
  const scale = unit === '억' ? 8 : unit === '천만' ? 7 : unit === '만' ? 4 : unit === '천' ? 3 : 0;
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) return null;
  const n = Number(whole! + fraction.slice(0, scale).padEnd(scale, '0'));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const amount = (n: number): SourceAmount => Number.isSafeInteger(n) && n > 0 ? { state: 'KNOWN', value: n } : { state: 'UNKNOWN', value: null };
/** 보증금: «0원»·«없음»·«무보증» 은 ZERO(확인된 0), 숫자가 있으면 KNOWN, 블록이 없거나 읽을 수 없으면 UNKNOWN. */
export const ironDeposit = (block: string): SourceAmount => {
  const t = text(withoutStruck(block));
  if (!t) return { state: 'UNKNOWN', value: null };
  if (/무보증|보증금\s*없음|^없음$/.test(t)) {
    if (!/\d/.test(t.replace(/\d+\s*개월/g, '')) || wonOrNull(block) === 0) return { state: 'ZERO', value: 0 };
    return { state: 'UNKNOWN', value: null };
  }
  const n = wonOrNull(block);
  return n === 0 ? { state: 'ZERO', value: 0 } : n === null ? { state: 'UNKNOWN', value: null } : amount(n);
};
/** 약정거리: «연 2만km»→20000km/year, «월 2,000km»→2000km/month, 단위 없는 «2만km»→20000km. 없으면 null. */
export const ironMileage = (label: string): string | null => {
  const m = /(연|월|년)?\s*(\d+(?:[.,]\d+)*)\s*(만)?\s*(?:km|킬로)/i.exec(label);
  if (!m) return null;
  const n = Math.round(Number(m[2]!.replace(/,/g, '')) * (m[3] ? 10_000 : 1));
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return `${n}km${m[1] === '월' ? '/month' : m[1] ? '/year' : ''}`;
};
/** 주행거리(누적): «12,345 km»→12345, «1.2만km»→12000. */
export const ironOdometer = (value: string): string | null => {
  const m = /(\d+(?:[.,]\d+)*)\s*(만)?/.exec(value);
  if (!m) return null;
  const n = Math.round(Number(m[1]!.replace(/,/g, '')) * (m[2] ? 10_000 : 1));
  return Number.isSafeInteger(n) && n >= 0 ? String(n) : null;
};
const absolute = (href: string, base: string): string | null => {
  try {
    // HTML attribute separators are escaped by the supplier. Passing &amp;
    // through makes the server ignore page= and repeat the first page.
    const url = new URL(href.replace(/&amp;/gi, '&'), base);
    return url.protocol === 'https:' && url.hostname === IRON_HOMEPAGE_POLICY.host ? url.toString() : null;   // 다른 호스트로 새지 않는다
  } catch { return null; }
};
/** 사진 주소: 홈페이지 호스트, 또는 사진 버킷 호스트의 공개 사진 경로만(https). `/_next/image?url=` 는 원본으로 푼다. */
const photoUrl = (href: string, base: string): string | null => {
  let url: URL;
  try { url = new URL(href, base); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.hostname === IRON_HOMEPAGE_POLICY.host) {
    if (url.pathname === '/_next/image') { const original = url.searchParams.get('url'); return original ? photoUrl(original, base) : null; }
    return url.toString();
  }
  return url.hostname === IRON_PHOTO_POLICY.host && url.pathname.startsWith(IRON_PHOTO_POLICY.pathPrefix) ? url.toString() : null;
};
/** 상세 배지 → 상태. 배지는 상품 본문(배지 묶음 → 없으면 <main>)에서만 읽는다. 상태 어휘가 둘 이상 섞이면 STATUS_AMBIGUOUS, 모르는 배지만
 * 있으면 STATUS_UNKNOWN 으로 보류(판매 가능으로 추정하지 않는다). 배지가 하나도 없으면 ERP4 기준대로 출고협의. */
const SOLD_BADGES = new Set(['판매완료', '출고완료', '출고불가']);
type IronStatus = { raw: string; saleAvailable: boolean | null; provider?: string; hold?: 'STATUS_UNKNOWN' | 'STATUS_AMBIGUOUS' };
export function ironStatusFromBadges(badges: readonly string[], listedSold: boolean): IronStatus {
  const label = (b: string) => SOLD_BADGES.has(b) ? '출고불가' : isContractedStatus(b) ? '계약중' :
    ['즉시출고', '출고가능', '출고협의'].includes(b) ? b : null;
  const known = new Set(badges.map(label).filter((x): x is string => !!x));
  const unknown = badges.filter(b => !label(b));
  // 목록 카드의 판매완료 표시는 그대로 판매 불가(팔린 차를 파는 쪽으로 틀리지 않는다).
  if (listedSold) return { raw: '출고불가', saleAvailable: false };
  if (known.size > 1) return { raw: '상태확인필요', saleAvailable: null, hold: 'STATUS_AMBIGUOUS' };
  const only = [...known][0];
  if (only === '출고불가') return { raw: '출고불가', saleAvailable: false };
  if (only === '계약중') {
    const provider = badges.find(b => isContractedStatus(b))!;
    return { raw: '계약중', saleAvailable: true, ...(provider !== '계약중' ? { provider } : {}) };
  }
  if (only) return { raw: only, saleAvailable: true };
  if (unknown.length) return { raw: '상태확인필요', saleAvailable: null, hold: 'STATUS_UNKNOWN' };
  return { raw: '출고협의', saleAvailable: true };
}

/** 목록 페이지 → 상품 id·판매완료 여부·다음 페이지(«더보기»). */
export function parseIronListingPage(html: string, pageUrl: string, condition: IronCondition): { listings: IronListing[]; nextUrl: string | null } {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
  const listings: IronListing[] = [];
  for (const m of main.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const id = /href=["']\/vehicles\/([^"'?/#\s]+)/.exec(m[2]!)?.[1];
    if (!id) continue;
    const url = absolute(`/vehicles/${id}`, pageUrl);
    if (url) listings.push({ id, url, condition, sold: /\brental-product-card--sold\b/.test(m[1]!) });
  }
  let nextUrl: string | null = null;
  for (const a of main.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (text(a[2]!) === '더보기') { nextUrl = absolute(a[1]!, pageUrl); break; }
  }
  return { listings, nextUrl };
}

/** 상세 페이지 → 엔진 레코드. 번호 형식이 틀리거나 제목이 없으면 던진다(상품 하나의 실패 → 읽기 불완전). */
export function parseIronDetail(html: string, listing: IronListing, observedAt: string): SourceProductRecord {
  const title = text(/<h1\b[^>]*product-detail-title[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '');
  if (!title) throw new Error('IRON_TITLE_MISSING');
  const facts = new Map<string, string>();
  for (const m of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const key = text(m[1]!), value = text(m[2]!);
    if (key && value && !facts.has(key)) facts.set(key, value);
  }
  const plate = (facts.get('차량번호') ?? '').replace(/\s/g, '');
  if (!/^\d{2,3}[가-힣]\d{4}$/.test(plate) || !isAssignedPlate(plate)) throw new Error('IRON_PLATE_INVALID');
  const subtitle = text(/<(\w+)\b[^>]*product-detail-subtitle[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? '');
  const depositBlock = /<(\w+)\b[^>]*product-detail-price-block--deposit[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? '';
  const deposit = ironDeposit(depositBlock);
  const terms: SourceTerm[] = [];
  const rawPriceRows: Array<{ period: string; rent: string; rent_html: string }> = [];
  for (const m of html.matchAll(/<(\w+)\b[^>]*product-detail-rent-row[^>]*>([\s\S]*?)<\/\1>/gi)) {
    // 기간 칸에는 약정거리가 함께 올 수 있다(«연 2만km · 48개월») — 개월은 «N개월» 로만, 약정거리는 km 표기로 따로 읽는다.
    const label = text(/<dt\b[^>]*>([\s\S]*?)<\/dt>/i.exec(m[2]!)?.[1] ?? '');
    const months = Number(/(\d+)\s*개월/.exec(label)?.[1]);
    const rentBlock = /<dd\b[^>]*>([\s\S]*?)<\/dd>/i.exec(m[2]!)?.[1] ?? '';
    rawPriceRows.push({ period: label, rent: text(rentBlock), rent_html: rentBlock });
    // Explicit no-offer text excludes only that period, under the shared rule.
    if (isNoPriceText(text(rentBlock))) continue;
    const rent = wonOrNull(rentBlock);
    if (Number.isSafeInteger(months) && months > 0) terms.push({ months,
      monthlyRent: rent !== null && isPlausibleMonthlyRent(rent) ? amount(rent) : { state: 'UNKNOWN', value: null },
      deposit: { ...deposit }, mileage: ironMileage(label), raw: { period_text: label, rent_text: text(withoutStruck(rentBlock)), rent_html: rentBlock, deposit_text: text(depositBlock), normalized_amount_unit: 'KRW' } });
  }
  // 배지는 상품 본문에서만: 배지 묶음(product-detail-badges)이 있으면 그 안, 없으면 <main> 안(추천·비슷한 차 카드의 배지를 섞지 않는다).
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
  const badgeScope = /<(\w+)\b[^>]*\bproduct-detail-badges\b[^>]*>([\s\S]*?)<\/\1>/i.exec(main)?.[2] ?? main;
  const badges = [...new Set([...badgeScope.matchAll(/<[^>]*\bbadge-pill\b[^>]*>([\s\S]*?)<\/[^>]+>/gi)].map(m => text(m[1]!)).filter(Boolean))];
  const status = ironStatusFromBadges(badges, listing.sold);
  const sold = status.saleAvailable === false;
  const galleryAt = html.search(/product-detail-gallery/);
  const images = [...new Set([...(galleryAt >= 0 ? html.slice(galleryAt, galleryAt + 20_000) : '').matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map(m => photoUrl(m[1]!.replace(/&amp;/g, '&'), listing.url)).filter((u): u is string => !!u))];
  const spec: Record<string, string> = {};
  const year = /(\d{2,4})\s*년식/.exec(subtitle)?.[1];
  if (year) spec.year = String(Number(year) < 100 ? 2000 + Number(year) : Number(year));
  // 연료는 표준 이름으로만(2026-10-25 «휘발유»가 그대로 들어가던 원인). 표에 없거나 차명과 어긋나면 비운다(raw 모양은 바꾸지 않는다 — 원천 지문 흔들림 방지).
  const fuelText = facts.get('유종');
  const fuel = fuelText ? canonicalFuel(fuelText, title) : null;
  if (fuel) spec.fuel_type = fuel;
  if (facts.get('외장 색상')) spec.ext_color = facts.get('외장 색상')!;
  if (facts.get('내장 색상')) spec.int_color = facts.get('내장 색상')!;
  const mileage = ironOdometer(facts.get('주행거리') ?? '');
  if (mileage) spec.mileage = mileage;
  const key = plateIdentityKey(plate);
  return { sourceId: 'RP006', uid: key, plate: key, vehicleText: title,
    status: { raw: status.raw, saleAvailable: status.saleAvailable }, terms, observedAt,
    raw: { source: 'ironrentcar-web', source_external_id: listing.id, condition: listing.condition, sold,
      price_rows: rawPriceRows, deposit_text: text(depositBlock),
      ...(status.provider ? { provider_status: status.provider } : {}), ...(status.hold ? { status_hold: status.hold, badges: badges.join('|').slice(0, 200) } : {}),
      product_type: listing.condition === 'new' ? '신차렌트' : '중고렌트', product_group: 'LONG_TERM', variant: subtitle.split('·')[0]?.trim() ?? '',
      images, ...(Object.keys(spec).length ? { spec } : {}) },
    vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] };
}

/** 사이트맵의 상품 상세 id(/vehicles/{id}). urlset 이 닫히지 않았으면(잘림) null. */
export function parseIronSitemapIds(xml: string): string[] | null {
  if (!/<\/urlset>\s*$/.test(xml.trim())) return null;
  const ids = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*https:\/\/ironrentcar\.com\/vehicles\/([^"'?/#<\s]+)[^<]*<\/loc>/g)) ids.add(m[1]!);
  return [...ids];
}

/** 축소 하한 비교용 레코드: 판매 가능이고 계약중이 아닌 것만 — 비교 상대(노출·잠금 없음·계약중 제외 문서)와 같은 것끼리 센다.
 * 판매완료·보류까지 센 전체 레코드 수로 비교하면 판매 가능 차가 크게 줄어도 하한을 통과한다(2026-10-14). */
export const ironFloorRecords = (records: readonly SourceProductRecord[]) =>
  records.filter(r => r.status.saleAvailable === true && r.status.raw !== '계약중');

export type IronHomepageRead = { observedAt: string; complete: boolean; incompleteReason?: string; records: SourceProductRecord[];
  held: Array<{ id: string; reason: string }>; duplicatePlates: string[]; listed: number; sold: number; notes: string[] };

/** 사이트맵에만 있는 id 를 상세로 확인하는 상한. 이보다 많이 빠졌으면 잔재가 아니라 목록 읽기 부족으로 보고 확인 없이 불완전. */
export const IRON_SITEMAP_PROBE_MAX = 10;
/** 주입된 fetchHtml 이 «페이지 없음»을 알리는 유일한 모양(runtime 의 fetchHtml 은 ironFetchFailure 로 `IRON_HTTP_<status>` 를 던진다). 404 만 — 5xx·시간 초과·HTML 아님은 해당 없음. */
const isIronNotFound = (e: unknown): boolean => e instanceof Error && e.message === 'IRON_HTTP_404';
/** runtime fetchHtml 의 실패 판정 — 순서 고정: ① 최종 호스트(리다이렉트 뒤)가 아이언이 아니면 IRON_HOST_REJECTED, ② 그다음 HTTP 오류 IRON_HTTP_<status>.
 * 호스트를 상태보다 먼저 보는 이유: 상세 → 외부 호스트로 리다이렉트 → 404 가 «잔재 404»로 오인되지 않게(2026-10-22 Codex 반례). 둘 다 아니면 null. */
export function ironFetchFailure(response: { ok: boolean; status: number; url?: string }, requestedUrl: string): string | null {
  let host: string | null = null;
  try { host = new URL(response.url || requestedUrl).hostname; } catch { host = null; }
  if (host !== IRON_HOMEPAGE_POLICY.host) return 'IRON_HOST_REJECTED';
  return response.ok ? null : `IRON_HTTP_${response.status}`;
}

/** 목록(신차·중고) 전체 페이지 → 상세 전수. fetchHtml 은 주입(허용 호스트·HTML 검사는 호출부 책임, 여기서는 URL 호스트만 다시 검사). */
export async function readIronHomepage(fetchHtml: (url: string) => Promise<string>,
  opts: { now?: () => string; sleep?: (ms: number) => Promise<void> } = {}): Promise<IronHomepageRead> {
  const clock = opts.now ?? (() => new Date().toISOString());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const observedAt = clock();
  let first = true;
  const get = async (url: string) => {
    if (!absolute(url, IRON_HOMEPAGE_POLICY.baseUrl)) throw new Error('IRON_HOST_REJECTED');
    if (!first) await sleep(IRON_HOMEPAGE_POLICY.minIntervalMs);
    first = false;
    return fetchHtml(url);
  };
  const found = new Map<string, IronListing>();
  let incomplete: string | undefined;
  for (const condition of ['new', 'used'] as const) {
    let pageUrl: string | null = `${IRON_HOMEPAGE_POLICY.baseUrl}/vehicles?condition=${condition}`;
    const pages = new Set<string>();
    let count = 0;
    while (pageUrl && pages.size < IRON_HOMEPAGE_POLICY.maxPages) {
      if (pages.has(pageUrl)) { incomplete ??= 'IRON_LIST_LOOP'; break; }
      pages.add(pageUrl);
      const parsed = parseIronListingPage(await get(pageUrl), pageUrl, condition);
      for (const l of parsed.listings) { if (!found.has(l.id)) { found.set(l.id, l); count++; } }
      pageUrl = parsed.nextUrl;
    }
    if (pageUrl) incomplete ??= 'IRON_LIST_PAGE_LIMIT';
    if (count === 0) incomplete ??= 'IRON_LIST_EMPTY';
  }
  // 완전성 대조: «더보기» 링크가 없다는 것만으로는 목록 끝이 증명되지 않는다. 사이트맵이 읽히면 사이트맵의 상품 id 가 전부 목록에 있어야 한다
  // (빠진 것이 있으면 목록이 덜 읽힌 것 → 불완전, 쓰기·부재 하향 차단). 사이트맵을 못 읽으면 기존 기준으로 두고 note 만 남긴다.
  // 사이트맵 잔재(2026-10-22 실측: 사이트맵 35 중 1건이 목록에 없고 상세는 404)로 회차가 영영 막히지 않게, 사이트맵에만 있는 id 는 상세를 한 번 열어
  // 본다 — «404» 만 사라진 상품(stale)으로 인정하고, 그 밖(상세가 열림 = 목록이 덜 읽힘, 5xx·시간 초과·HTML 아님 = 확인 못 함)은 전부 불완전 그대로.
  const notes: string[] = [];
  let sitemapIds: string[] | null = null;
  try { sitemapIds = parseIronSitemapIds(await get(`${IRON_HOMEPAGE_POLICY.baseUrl}/sitemap.xml`)); } catch { sitemapIds = null; }
  if (sitemapIds === null) notes.push('IRON_SITEMAP_UNAVAILABLE');
  else {
    const onlyInSitemap = sitemapIds.filter(id => !found.has(id));
    let missing = 0, stale = 0;
    // 상한을 넘게 빠졌으면 잔재가 아니라 목록이 덜 읽힌 것 — 확인 요청을 더 보내지 않고 불완전.
    if (onlyInSitemap.length > IRON_SITEMAP_PROBE_MAX) missing = onlyInSitemap.length;
    else for (const id of onlyInSitemap) {
      try { await get(`${IRON_HOMEPAGE_POLICY.baseUrl}/vehicles/${id}`); missing++; }
      catch (e) { if (isIronNotFound(e)) stale++; else missing++; }
    }
    notes.push(`IRON_SITEMAP:${sitemapIds.length}:missing${missing}:stale${stale}`);
    if (missing > 0) incomplete ??= 'IRON_LIST_SHORT_OF_SITEMAP';
  }
  const records: SourceProductRecord[] = [], held: IronHomepageRead['held'] = [], seen = new Set<string>(), duplicates = new Set<string>();
  let sold = 0;
  for (const listing of found.values()) {
    try {
      const record = parseIronDetail(await get(listing.url), listing, observedAt);
      if (seen.has(record.uid)) { duplicates.add(record.uid); continue; }
      seen.add(record.uid); records.push(record);
      if (record.raw.sold === true) sold++;
    } catch (e) {
      const reason = e instanceof Error && /^[A-Z][A-Z0-9_]{2,40}$/.test(e.message) ? e.message : 'IRON_DETAIL_FAILED';
      held.push({ id: listing.id, reason });
      incomplete ??= reason === 'IRON_PLATE_INVALID' ? 'IRON_PLATE_INVALID' : 'IRON_DETAIL_FAILED';
    }
  }
  if (duplicates.size) incomplete ??= 'DUPLICATE_PLATES';
  if (!records.length) incomplete ??= 'IRON_EMPTY';
  return { observedAt, complete: !incomplete, ...(incomplete ? { incompleteReason: incomplete } : {}), records, held,
    duplicatePlates: [...duplicates], listed: found.size, sold, notes };
}
