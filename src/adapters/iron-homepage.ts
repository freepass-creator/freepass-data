/** 아이언렌트카(RP006) 홈페이지 상세 기준 어댑터 — 커맨드 센터 2026-10-14: «사이트맵·목록 상세 전수, 판매완료 라벨 제외, 번호 키, 사진 갤러리».
 * 구조는 ERP4 수집기(lib/server/ironrentcar-source.ts)가 검증한 것과 같다: 목록 `/vehicles?condition=new|used`(더보기 페이지네이션, article 의
 * `rental-product-card--sold` = 판매완료) → 상세 `/vehicles/{id}`(제목·dt/dd 사실·기간별 요금 행·보증금 블록·배지·갤러리).
 * 안전: 허용 호스트 고정(ironrentcar.com), 직렬·간격·재시도 0, 읽기 GET 만, HTML 응답 아님·번호 형식 오류·목록 순환은 실패.
 * 이 모듈을 import 하는 것만으로 접속하지 않는다(fetch 주입). 번호 전체·원문은 로그·오류에 남기지 않는다. */
import type { SourceAmount, SourceProductRecord, SourceTerm } from '../domain/source-engine.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';

export const IRON_HOMEPAGE_POLICY = Object.freeze({ host: 'ironrentcar.com', baseUrl: 'https://ironrentcar.com', maxPages: 10, minIntervalMs: 500, timeoutMs: 20_000 });
export type IronCondition = 'new' | 'used';
export type IronListing = { id: string; url: string; condition: IronCondition; sold: boolean };

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, m => ENTITIES[m] ?? m).replace(/\s+/g, ' ').trim();
const won = (value: string): number => {
  const t = text(value).replace(/,/g, '');
  const man = /([\d.]+)\s*만원/.exec(t);
  if (man) return Math.round(Number(man[1]) * 10_000);
  const plain = /([\d.]+)\s*원/.exec(t);
  return plain ? Math.round(Number(plain[1])) : 0;
};
const amount = (n: number): SourceAmount => Number.isSafeInteger(n) && n > 0 ? { state: 'KNOWN', value: n } : { state: 'UNKNOWN', value: null };
const absolute = (href: string, base: string): string | null => {
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' && url.hostname === IRON_HOMEPAGE_POLICY.host ? url.toString() : null;   // 다른 호스트로 새지 않는다
  } catch { return null; }
};

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
  const deposit = won(/<(\w+)\b[^>]*product-detail-price-block--deposit[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? '');
  const terms: SourceTerm[] = [];
  for (const m of html.matchAll(/<(\w+)\b[^>]*product-detail-rent-row[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const period = /(\d+)/.exec(text(/<dt\b[^>]*>([\s\S]*?)<\/dt>/i.exec(m[2]!)?.[1] ?? ''))?.[1];
    const rent = won(/<dd\b[^>]*>([\s\S]*?)<\/dd>/i.exec(m[2]!)?.[1] ?? '');
    const months = Number(period);
    if (Number.isSafeInteger(months) && months > 0 && rent > 0) terms.push({ months, monthlyRent: amount(rent),
      deposit: deposit > 0 ? amount(deposit) : { state: 'UNKNOWN', value: null }, mileage: null, raw: {} });
  }
  const badges = [...html.matchAll(/<[^>]*\bbadge-pill\b[^>]*>([\s\S]*?)<\/[^>]+>/gi)].map(m => text(m[1]!));
  const sold = listing.sold || badges.includes('판매완료');
  // 판매완료 라벨은 판매 불가(1차 무조건 편입은 비노출로), 그 밖은 배지 어휘: 즉시출고·출고가능, 배지가 없으면 출고협의(ERP4 와 같은 기준).
  const display = sold ? '출고불가' : badges.includes('즉시출고') ? '즉시출고' : badges.includes('출고가능') ? '출고가능' : '출고협의';
  const galleryAt = html.search(/product-detail-gallery/);
  const images = [...new Set([...(galleryAt >= 0 ? html.slice(galleryAt, galleryAt + 20_000) : '').matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map(m => {
      const abs = absolute(m[1]!, listing.url);
      if (!abs) return null;
      const u = new URL(abs);
      if (u.pathname === '/_next/image') { const original = u.searchParams.get('url'); return original ? absolute(original, listing.url) : abs; }
      return abs;
    }).filter((u): u is string => !!u))];
  const spec: Record<string, string> = {};
  const year = /(\d{2,4})\s*년식/.exec(subtitle)?.[1];
  if (year) spec.year = String(Number(year) < 100 ? 2000 + Number(year) : Number(year));
  if (facts.get('유종')) spec.fuel_type = facts.get('유종')!;
  if (facts.get('외장 색상')) spec.ext_color = facts.get('외장 색상')!;
  if (facts.get('내장 색상')) spec.int_color = facts.get('내장 색상')!;
  const mileage = /\d+/.exec((facts.get('주행거리') ?? '').replace(/,/g, ''))?.[0];
  if (mileage) spec.mileage = mileage;
  const key = plateIdentityKey(plate);
  return { sourceId: 'RP006', uid: key, plate: key, vehicleText: title,
    status: { raw: display, saleAvailable: !sold }, terms, observedAt,
    raw: { source: 'ironrentcar-web', source_external_id: listing.id, condition: listing.condition, sold,
      product_type: listing.condition === 'new' ? '신차렌트' : '중고렌트', product_group: 'LONG_TERM', variant: subtitle.split('·')[0]?.trim() ?? '',
      maker_hint: title.split(' ')[0] ?? '',
      images, ...(Object.keys(spec).length ? { spec } : {}) },
    vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] };
}

export type IronHomepageRead = { observedAt: string; complete: boolean; incompleteReason?: string; records: SourceProductRecord[];
  held: Array<{ id: string; reason: string }>; duplicatePlates: string[]; listed: number; sold: number; notes: string[] };

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
    duplicatePlates: [...duplicates], listed: found.size, sold, notes: [] };
}
