/** 오토플러스(RP023) 홈페이지 수집 어댑터 — 관측 전용(쓰기 0). 대표 2026-10-14: 오토플러스는 홈페이지가 판매 가능 정본, 시트 수집은 폐기 방향.
 * 근거: ERP4 수집기 계약 사실(ERP 개발 2026-10-14, 고정 커밋의 ingest-reborncar). 토큰·쿠키는 상품별로 페이지에서 얻고 저장하지 않는다.
 *  - 목록: GET /sitemap-ext.xml 의 /rent/<영문2+숫자>/C<11자리> URL 전부(= 게시 중 전수). 홈피 LP API 는 추천 20 고정이라 쓰지 않는다.
 *  - 상세: 상품 자기 상세 URL GET → Set-Cookie·RB_TOKEN(JWT)·_csrf → POST /api/v1/car/getRentCarDetail.rb (본문 productId).
 *  - 호출 규칙: 완전 직렬, 차 사이 150ms, resultCode 1020 이면 응답 msg 의 새 토큰으로 60ms 후 최대 4회.
 * 상태 신호는 «사이트맵에 있음 = 게시 중» 뿐이고(상세 응답에 상태 필드 없음), 보증금은 응답에 없다(UNKNOWN 으로 두고 규칙은 별도 정책). */
import { MONTHLY_RENT_MIN, MONTHLY_RENT_MAX } from '../domain/source-rent-text.js';
import type { SourceAmount, SourceProductRecord, SourceTerm } from '../domain/source-engine.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';

export const AUTOPLUS_HOST = 'https://www.reborncar.co.kr';
const PRODUCT_URL = /\/rent\/[A-Za-z]{2}\d+\/(C\d{11})(?![0-9A-Za-z])/;

export type AutoplusDetailResult = { ok: true; productId: string; data: Record<string, unknown> } | { ok: false; productId: string; code: string };
export interface AutoplusHomepageClient {
  listProductUrls(): Promise<Array<{ productId: string; url: string }>>;
  detail(product: { productId: string; url: string }): Promise<AutoplusDetailResult>;
}

/** sitemap XML 의 <loc> 중 렌트 상품 URL 만, productId 로 중복 제거해 돌려준다. */
export function parseSitemapProductUrls(xml: string): Array<{ productId: string; url: string }> {
  const seen = new Map<string, string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = m[1]!, id = PRODUCT_URL.exec(url)?.[1];
    if (id && !seen.has(id)) seen.set(id, url);
  }
  return [...seen].map(([productId, url]) => ({ productId, url }));
}

/** 상세 페이지 HTML 과 Set-Cookie 에서 세션 정보를 뽑는다. 하나라도 없으면 null(부트스트랩 실패). */
export function parseBootstrap(html: string, setCookies: readonly string[]): { cookie: string; token: string; csrf: string } | null {
  const token = /RB_TOKEN\s*=\s*"([^"]+)"/.exec(html)?.[1];
  const csrf = /<input[^>]*name="_csrf"[^>]*value="([^"]+)"/.exec(html)?.[1] ?? /<input[^>]*value="([^"]+)"[^>]*name="_csrf"/.exec(html)?.[1];
  const cookie = setCookies.map(c => c.split(';')[0]!.trim()).filter(Boolean).join('; ');
  return token && csrf && cookie ? { cookie, token, csrf } : null;
}

type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; text(): Promise<string>; headers: { get(name: string): string | null; getSetCookie?(): string[] } }>;

/** 읽기 전용 클라이언트. 직렬·간격·토큰 갱신 규칙만 담고 비밀은 저장하지 않는다. fetch·sleep 은 주입(시험·B3Q 에서 실제 값). */
export function createAutoplusHomepageClient(options: {
  fetcher: Fetcher; sleep?: (ms: number) => Promise<void>; host?: string; userAgent?: string;
}): AutoplusHomepageClient {
  const host = options.host ?? AUTOPLUS_HOST, sleep = options.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const ua = options.userAgent ?? 'Mozilla/5.0 (compatible; FreePassDataObserver/1.0)';
  let first = true;
  return {
    async listProductUrls() {
      const res = await options.fetcher(`${host}/sitemap-ext.xml`, { headers: { 'User-Agent': ua } });
      if (!res.ok) throw new Error(`AUTOPLUS_SITEMAP_HTTP_${res.status}`);
      const xml = await res.text();
      // 잘린 응답은 «사라진 상품»처럼 보이게 만든다: 닫는 태그가 없으면 읽기 실패로 본다(독립 검토 2026-10-14).
      if (!/<\/urlset>\s*$/.test(xml)) throw new Error('AUTOPLUS_SITEMAP_TRUNCATED');
      return parseSitemapProductUrls(xml);
    },
    async detail(product) {
      if (!first) await sleep(150);
      first = false;
      try {
        const page = await options.fetcher(product.url, { headers: { 'User-Agent': ua } });
        if (!page.ok) return { ok: false, productId: product.productId, code: `PAGE_HTTP_${page.status}` };
        const boot = parseBootstrap(await page.text(), page.headers.getSetCookie?.() ?? (page.headers.get('set-cookie') ? [page.headers.get('set-cookie')!] : []));
        if (!boot) return { ok: false, productId: product.productId, code: 'BOOTSTRAP_FAILED' };
        let token = boot.token;
        for (let attempt = 0; attempt < 5; attempt++) {
          const res = await options.fetcher(`${host}/api/v1/car/getRentCarDetail.rb`, { method: 'POST', body: `productId=${encodeURIComponent(product.productId)}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Ajax-call': 'true', Authorization: token,
              'X-CSRF-TOKEN': boot.csrf, Cookie: boot.cookie, 'User-Agent': ua, Referer: product.url } });
          // HTTP 상태를 먼저 판정한다: 200 만 성공 경로(독립 검토 2026-10-14). 500 + resultCode 1400 이 «폐기 제외»로 둔갑하면 안 된다.
          if (res.status !== 200) return { ok: false, productId: product.productId, code: `DETAIL_HTTP_${res.status}` };
          let body: { header?: { resultCode?: unknown; msg?: unknown }; data?: Record<string, unknown> };
          try { body = JSON.parse(await res.text()); } catch { return { ok: false, productId: product.productId, code: 'RESPONSE_INVALID' }; }
          const code = String(body.header?.resultCode ?? '');
          if (code === '1020' && typeof body.header?.msg === 'string' && attempt < 4) { token = body.header.msg; await sleep(60); continue; }
          // 성공 판정(독립 검토 2026-10-14): HTTP 200 + 정상 resultCode(0 계열) + 요청한 상품 id 와 응답 productId 일치. 오류 코드에 data 가 실려 와도 성공이 아니다.
          if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
            // data 가 실려 온 비정상 resultCode 는 «폐기 응답 형태(data 없음)» 가 아니다: 제외(RESULT_1400)로 둔갑하지 않게 별도 실패 코드로 돌려준다.
            if (!/^0+$/.test(code)) return { ok: false, productId: product.productId, code: code ? `RESULT_${code}_WITH_DATA` : 'RESULT_MISSING' };
            if (String((body.data as Record<string, unknown>).productId ?? '').trim() !== product.productId) return { ok: false, productId: product.productId, code: 'PRODUCT_ID_MISMATCH' };
            return { ok: true, productId: product.productId, data: body.data };
          }
          // data 가 «있으면»(배열·문자열·빈 배열 포함) 1400 이어도 폐기 응답 형태가 아니다 → 제외가 아니라 실패(독립 검토 4차).
          if (body.data !== undefined && body.data !== null) return { ok: false, productId: product.productId, code: code ? `RESULT_${code}_WITH_DATA` : 'DATA_INVALID' };
          return { ok: false, productId: product.productId, code: code ? `RESULT_${code}` : 'NO_DATA' };
        }
        return { ok: false, productId: product.productId, code: 'TOKEN_REFRESH_EXHAUSTED' };
      } catch (e) {
        return { ok: false, productId: product.productId, code: e instanceof Error && /^[A-Z][A-Z0-9_]{2,40}$/.test(e.message) ? e.message : 'FETCH_FAILED' };
      }
    },
  };
}

const unknownAmount: SourceAmount = { state: 'UNKNOWN', value: null };
/** 월 대여료만 KNOWN: 숫자 또는 숫자 문자열, 정수, 10만~5천만 원. true/객체/범위 밖 값은 UNKNOWN(독립 검토 2026-10-14: Number(true)=1 이 가격이 되어 REEXPOSE 됨). */
const RENT_MIN = MONTHLY_RENT_MIN, RENT_MAX = MONTHLY_RENT_MAX;   // 공용 월 대여료 타당 범위(공통 시트·아이카와 같은 값)
const amountOf = (v: unknown): SourceAmount => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n >= RENT_MIN && n <= RENT_MAX ? { state: 'KNOWN', value: n } : unknownAmount;
};
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';

/** 상세 응답 → 표준 레코드. 차량번호가 형식에 맞지 않으면 레코드를 만들지 않는다(보류 사유 반환). 가격 없는 행은 항 0개로 두고 listable 은 소비 쪽 정책(대여료 필수)이 정한다. */
export function mapAutoplusDetail(data: Record<string, unknown>, observedAt: string):
  { record: SourceProductRecord } | { hold: 'PLATE_INVALID' | 'PRODUCT_ID_MISSING' } {
  const productId = text(data.productId);
  if (!/^C\d{11}$/.test(productId)) return { hold: 'PRODUCT_ID_MISSING' };
  const plateRaw = text(data.carNumber).replace(/\s+/g, '');
  if (!isAssignedPlate(plateRaw)) return { hold: 'PLATE_INVALID' };
  const plate = plateIdentityKey(plateRaw);
  let prices: unknown[] = [];
  try {
    const raw = data.rentPriceObjs;
    prices = typeof raw === 'string' ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
  } catch { prices = []; }
  const terms: SourceTerm[] = [];
  for (const item of prices) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>, months = Number(o.rentMonth);
    if (!Number.isSafeInteger(months) || months <= 0) continue;
    // 약정거리는 rentPrice2 = 2만km, rentPrice3 = 3만km 로 암묵 코딩된다(연 기준).
    for (const [field, km] of [['rentPrice2', 20000], ['rentPrice3', 30000]] as const) {
      const rent = amountOf(o[field]);   // 원값을 넘긴다: 배열·객체·불리언은 타입 검증에서 UNKNOWN(독립 검토 4차: [500000] 이 KNOWN 으로 통과)
      if (rent.state === 'KNOWN') terms.push({ months, monthlyRent: rent, deposit: unknownAmount, mileage: `${km}km/year`,
        raw: { origin: Number(o[field === 'rentPrice2' ? 'originPrice2' : 'originPrice3']) || null } } as SourceTerm);
    }
  }
  const vehicleText = [data.bmname, data.boname, data.gradename].map(text).filter(Boolean).join(' ');
  return { record: { sourceId: 'RP023', uid: plate, plate, vehicleText, status: { raw: '게시', saleAvailable: true }, terms, observedAt,
    raw: { source: 'website', source_external_id: productId, reborncar_product_id: productId, ap_car_id: text(data.apCarId) || null,
      product_group: 'LONG_TERM', product_type: '오플구독' }, vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] } };
}

export type AutoplusHomepageCollection = {
  observedAt: string; complete: boolean; incompleteReason?: string; productCount: number; records: SourceProductRecord[];
  failures: Array<{ productId: string; code: string }>; held: Array<{ productId: string; reason: string }>; duplicatePlates: string[];
  /** 사이트맵에는 있으나 상세가 폐기 주소(resultCode 1400/HTTP 400)라 «제외»로 센 상품(실패가 아니다, ERP4 수집기와 같은 분류). */
  excluded: string[];
};
/** 사이트맵 전수를 직렬로 읽어 레코드를 만든다. 실패·보류·중복 번호가 하나라도 있으면 complete=false(부재 추론에 쓰지 않는다). */
export async function collectAutoplusHomepage(client: AutoplusHomepageClient, now: () => string = () => new Date().toISOString(),
  /** 완전 읽기 판정용 기대 하한: 사이트맵 상품 수가 이보다 적으면(예: 기존 노출 문서의 80%) 부분 목록으로 보고 incomplete 로 둔다. */
  options: { minExpectedProducts?: number; maxExcludedRatio?: number } = {}): Promise<AutoplusHomepageCollection> {
  const urls = await client.listProductUrls();
  const records: SourceProductRecord[] = [], failures: AutoplusHomepageCollection['failures'] = [], held: AutoplusHomepageCollection['held'] = [];
  const platesSeen = new Set<string>(), duplicatePlates = new Set<string>(), excluded: string[] = [];
  for (const product of urls) {
    const result = await client.detail(product);
    // 폐기 상품으로 «제외»하는 것은 명시적 resultCode 1400 뿐이다. 일반 HTTP 4xx/5xx 는 실패다(독립 검토 2026-10-14).
    if (!result.ok && result.code === 'RESULT_1400') { excluded.push(product.productId); continue; }
    if (!result.ok) { failures.push({ productId: product.productId, code: result.code }); continue; }
    const mapped = mapAutoplusDetail(result.data, now());
    if ('hold' in mapped) { held.push({ productId: product.productId, reason: mapped.hold }); continue; }
    if (platesSeen.has(mapped.record.uid)) { duplicatePlates.add(mapped.record.uid); continue; }
    platesSeen.add(mapped.record.uid); records.push(mapped.record);
  }
  const observedAt = now();
  const shrunk = options.minExpectedProducts !== undefined && urls.length < options.minExpectedProducts;
  const excludedTooMany = urls.length > 0 && excluded.length / urls.length > (options.maxExcludedRatio ?? 0.3);
  const clean = urls.length > 0 && failures.length === 0 && held.length === 0 && duplicatePlates.size === 0;
  const incompleteReason = !clean ? (urls.length === 0 ? 'SITEMAP_EMPTY' : 'DETAIL_FAILURES_OR_HOLDS') : shrunk ? 'SITEMAP_SHRUNK' : excludedTooMany ? 'EXCLUDED_RATIO_HIGH' : undefined;
  return { observedAt, complete: clean && !shrunk && !excludedTooMany, ...(incompleteReason ? { incompleteReason } : {}),
    productCount: urls.length, records, failures, held, duplicatePlates: [...duplicatePlates], excluded };
}

/** Firestore RP023 문서와의 비교(순수): 번호 기준 집합 차이와 가격 있는 대수만 센다. 값·전체 번호는 담지 않고 끝 4자리만 나열한다. */
export function compareAutoplusHomepage(records: readonly SourceProductRecord[],
  docs: ReadonlyArray<{ plate: string | null; listable: boolean }>) {
  const last4 = (p: string) => p.replace(/\D/g, '').slice(-4);
  const home = new Set(records.map(r => r.uid));
  const exposed = new Set(docs.filter(d => d.listable && d.plate).map(d => plateIdentityKey(d.plate!)));
  const all = new Set(docs.filter(d => d.plate).map(d => plateIdentityKey(d.plate!)));
  const onlyHomepage = [...home].filter(p => !all.has(p)), exposedNotOnHomepage = [...exposed].filter(p => !home.has(p));
  return { homepage: home.size, homepageWithPrice: records.filter(r => r.terms.length > 0).length, exposedDocs: exposed.size,
    both: [...home].filter(p => exposed.has(p)).length,
    onlyHomepageCount: onlyHomepage.length, onlyHomepageLast4: onlyHomepage.map(last4).sort(),
    exposedNotOnHomepageCount: exposedNotOnHomepage.length, exposedNotOnHomepageLast4: exposedNotOnHomepage.map(last4).sort() };
}
