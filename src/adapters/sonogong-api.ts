/** 손오공 렌터카 공식 파트너 API(partner/v1) 읽기 어댑터 — 로그인 수집 대체(대표 2026-10-14).
 * 계약: 기준 주소 SONOGONG_API_BASE(https://sokrc.com/api/partner/…), 모든 요청에 헤더 x-partner-key(SONOGONG_API_KEY), 읽기 GET 만,
 * 목록 GET /vehicles?tab=rent|sub|pick&page&pageSize(≤50), 상세 GET /vehicles/{id}(보증금·보험은 상세에만 있음), 데이터는 1시간 단위 갱신.
 * 안전: 직렬·요청 간 최소 간격·재시도 0·429/401/403 즉시 정지·redirect 거부·허용 호스트 고정. 키·URL 쿼리·응답 본문은 오류·로그에 남기지 않는다.
 * 키가 없으면 네트워크 호출 0(SONOGONG_API_NOT_CONFIGURED). 이 모듈을 import 하는 것만으로 인증·접속하지 않는다. */
import type { SourceAmount, SourceProductRecord, SourceTerm } from '../domain/source-engine.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';

export const SONOGONG_API_POLICY = Object.freeze({
  allowedHost: 'sokrc.com', pathPrefix: '/api/partner/', pageSize: 50, maxPages: 20, minIntervalMs: 1_500, timeoutMs: 20_000,
  maxDetails: 600, minPassIntervalMinutes: 55,
});
export const SONOGONG_API_TABS = ['rent', 'sub', 'pick'] as const;
export type SonogongApiTab = typeof SONOGONG_API_TABS[number];
/** 탭별 «반납형» 가격 유형 — 명세 tabPriceUsage. 인수형은 raw 에 원문으로만 보존한다(우리 쪽 인수형 정책 대기). */
const RETURN_TYPE: Record<SonogongApiTab, string> = { rent: 'RENT_RETURN', sub: 'SUBSCRIBE_RETURN', pick: 'SUBSCRIBE_RETURN' };
const MONTHS = [12, 24, 36, 48, 60] as const;
/** 탭 → 상품 구분(구독·픽업구독을 화면에서 구분). 소비처 어휘: 중고렌트·오공구독·픽업구독. */
const PRODUCT_TYPE_BY_TAB: Record<SonogongApiTab, string> = { rent: '중고렌트', sub: '오공구독', pick: '픽업구독' };

export class SonogongApiError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); this.name = 'SonogongApiError'; }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createSonogongApiClient(input: { base: string; key: string; fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
  const key = (input.key ?? '').trim();
  let base: URL;
  try { base = new URL(input.base ?? ''); } catch { throw new SonogongApiError('SONOGONG_API_NOT_CONFIGURED'); }
  if (!key || base.protocol !== 'https:' || base.hostname !== SONOGONG_API_POLICY.allowedHost || !base.pathname.startsWith(SONOGONG_API_POLICY.pathPrefix))
    throw new SonogongApiError('SONOGONG_API_NOT_CONFIGURED');
  const send = input.fetch ?? fetch, now = input.now ?? Date.now;
  const sleep = input.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const root = base.href.replace(/\/+$/, '');
  let last = -Infinity, queue: Promise<unknown> = Promise.resolve();
  async function get(path: string, query?: Record<string, string | number>): Promise<{ data: unknown; attrs: Record<string, unknown> }> {
    const job = queue.then(async () => {
      await sleep(Math.max(0, SONOGONG_API_POLICY.minIntervalMs - (now() - last)));
      last = now();
      const url = new URL(root + path);
      for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
      let response: Response;
      try {
        response = await send(url, { method: 'GET', headers: { 'x-partner-key': key, accept: 'application/json' }, redirect: 'error',
          signal: AbortSignal.timeout(SONOGONG_API_POLICY.timeoutMs) });
      } catch { throw new SonogongApiError('SONOGONG_API_TRANSPORT_FAILED'); }   // 원인·URL 은 남기지 않는다
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new SonogongApiError(`SONOGONG_API_HTTP_${response.status}`, response.status);
      }
      let body: unknown;
      try { body = await response.json(); } catch { throw new SonogongApiError('SONOGONG_API_INVALID_RESPONSE'); }
      if (!object(body) || body.success === false) throw new SonogongApiError('SONOGONG_API_INVALID_RESPONSE');
      return { data: body.data, attrs: object(body.attrs) ? body.attrs : {} };
    });
    queue = job.catch(() => undefined);
    return job;
  }
  return { get };
}
export type SonogongApiClient = ReturnType<typeof createSonogongApiClient>;

const amount = (v: unknown): SourceAmount => v === 0 ? { state: 'ZERO', value: 0 }
  : typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? { state: 'KNOWN', value: v } : { state: 'UNKNOWN', value: null };
const listRows = (data: unknown): Record<string, unknown>[] | null => {
  const rows = Array.isArray(data) ? data : object(data)
    ? (['items', 'vehicles', 'list', 'rows', 'content'] as const).map(k => (data as Record<string, unknown>)[k]).find(Array.isArray) : null;
  return Array.isArray(rows) && rows.every(object) ? rows as Record<string, unknown>[] : null;
};
const totalOf = (data: unknown, attrs: Record<string, unknown>): number | null => {
  const inner = object(data) ? data : {};
  for (const v of [attrs.totalCount, attrs.total, inner.totalCount, inner.total])
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  return null;
};

export type SonogongApiRead = {
  observedAt: string; complete: boolean; incompleteReason?: string; tabsRead: SonogongApiTab[];
  records: SourceProductRecord[]; held: Array<{ tab: SonogongApiTab; reason: string }>; duplicatePlates: string[];
  listed: number; detailsRead: number;
  /** 읽기는 정상이지만 사람이 알아야 할 안전한 코드: CROSS_TAB_DUPLICATE:n(탭 우선순위 rent>sub>pick 로 하나만 채택), CROSS_TAB_GENERATION_DIFFERENCE:n(같은 번호의 탭 간 제조연월 차이). */
  notes: string[];
};

export async function readSonogongApi(client: SonogongApiClient, opts: { now?: () => string } = {}): Promise<SonogongApiRead> {
  const clock = opts.now ?? (() => new Date().toISOString());
  const rowsByTab = new Map<SonogongApiTab, Record<string, unknown>[]>();
  let generatedAt: string | null = null, incomplete: string | undefined;
  for (const tab of SONOGONG_API_TABS) {
    const rows: Record<string, unknown>[] = [];
    let total: number | null = null, done = false;
    for (let page = 1; page <= SONOGONG_API_POLICY.maxPages; page++) {
      const { data, attrs } = await client.get('/vehicles', { tab, page, pageSize: SONOGONG_API_POLICY.pageSize });
      const batch = listRows(data);
      if (!batch) throw new SonogongApiError('SONOGONG_API_INVALID_RESPONSE');
      if (typeof attrs.generatedAt === 'string' && Number.isFinite(Date.parse(attrs.generatedAt)))
        generatedAt = !generatedAt || Date.parse(attrs.generatedAt) < Date.parse(generatedAt) ? attrs.generatedAt : generatedAt;
      total = totalOf(data, attrs) ?? total;
      rows.push(...batch);
      if (batch.length < SONOGONG_API_POLICY.pageSize || (total !== null && rows.length >= total)) { done = true; break; }
    }
    if (!done) incomplete ??= 'API_PAGE_LIMIT';
    if (total !== null && rows.length !== total) incomplete ??= 'API_COUNT_MISMATCH';
    rowsByTab.set(tab, rows);
  }
  const observedAt = generatedAt ?? clock();
  const records: SourceProductRecord[] = [], held: SonogongApiRead['held'] = [], duplicates = new Set<string>();
  // 탭 우선순위(명세서): rent > sub > pick. 같은 번호가 다른 탭에도 있으면 앞선 탭 하나만 채택하고 경고로 센다(불완전 아님).
  // 같은 탭 안에서 같은 번호가 두 번이면 원천 오류라 읽기를 불완전으로 둔다.
  const seen = new Map<string, { tab: SonogongApiTab; ym: string }>();
  let listed = 0, detailsRead = 0, crossTabDuplicates = 0, generationDifferences = 0;
  for (const tab of SONOGONG_API_TABS) {
    for (const row of rowsByTab.get(tab) ?? []) {
      listed++;
      const plateRaw = String(row.carNumber ?? '').replace(/\s+/g, '');
      if (!/^\d{2,3}[가-힣]\d{4}$/.test(plateRaw) || !isAssignedPlate(plateRaw)) { held.push({ tab, reason: 'PLATE_INVALID' }); continue; }
      const plate = plateIdentityKey(plateRaw);
      const ymRaw = String(row.manufactureYearMonth ?? '').slice(0, 7);
      const earlier = seen.get(plate);
      if (earlier) {
        if (earlier.tab === tab) duplicates.add(plate);
        else { crossTabDuplicates++; if (earlier.ym && ymRaw && earlier.ym !== ymRaw) generationDifferences++; }
        continue;
      }
      seen.set(plate, { tab, ym: ymRaw });
      if (typeof row.hasActiveContract !== 'boolean') { held.push({ tab, reason: 'STATUS_UNKNOWN' }); continue; }
      const id = typeof row.id === 'number' || typeof row.id === 'string' ? String(row.id) : '';
      if (!id) { held.push({ tab, reason: 'ID_MISSING' }); continue; }
      let detail: Record<string, unknown> | null = null;
      if (detailsRead < SONOGONG_API_POLICY.maxDetails) {
        try {
          const got = await client.get(`/vehicles/${encodeURIComponent(id)}`);
          detailsRead++;
          if (object(got.data)) detail = got.data;
        } catch (e) {
          // 인증·한도(401/403/429)는 회차 전체를 멈춘다. 그 밖의 상세 실패(404 등)는 이 차만 보증금 «미확인» 으로 두고 읽기를 불완전으로 표시한다.
          if (e instanceof SonogongApiError && [401, 403, 429].includes(e.status ?? 0)) throw e;
          incomplete ??= 'API_DETAIL_FAILED';
        }
      } else incomplete ??= 'API_DETAIL_LIMIT';
      if (detail && plateIdentityKey(String(detail.carNumber ?? '')) !== plate) {
        held.push({ tab, reason: 'IDENTITY_MISMATCH' }); incomplete ??= 'API_IDENTITY_MISMATCH'; continue;
      }
      const prices = object(detail?.prices) ? detail.prices as Record<string, unknown> : object(row.prices) ? row.prices as Record<string, unknown> : {};
      const priced = object(prices[RETURN_TYPE[tab]]) ? prices[RETURN_TYPE[tab]] as Record<string, unknown> : null;
      const monthly = object(priced?.monthly) ? priced.monthly as Record<string, unknown> : {};
      const deposit = detail && object(priced?.deposit) ? priced.deposit as Record<string, unknown> : {};
      const terms: SourceTerm[] = [];
      for (const months of MONTHS) {
        const rent = amount(monthly[String(months)]);
        if (rent.state === 'KNOWN') terms.push({ months, monthlyRent: rent,
          deposit: detail ? amount(deposit[String(months)]) : { state: 'UNKNOWN', value: null }, mileage: null, raw: { priceType: RETURN_TYPE[tab] } });
      }
      const ym = /^(\d{4})-(\d{2})/.exec(String(row.manufactureYearMonth ?? ''));
      const spec: Record<string, string> = {};
      if (typeof row.exteriorColor === 'string' && row.exteriorColor.trim()) spec.ext_color = row.exteriorColor.trim();
      if (typeof row.fuel === 'string' && row.fuel.trim()) spec.fuel_type = row.fuel.trim();
      if (ym) { spec.year = ym[1]!; spec.first_registration_date = `${ym[1]}-${ym[2]}`; }
      if (typeof row.mileageKm === 'number') spec.mileage = String(row.mileageKm);
      if (typeof row.displacementCc === 'number') spec.engine_cc = String(row.displacementCc);
      const name = typeof detail?.carName === 'string' && detail.carName.trim() ? detail.carName.trim()
        : [row.brand, row.model, row.detailName].filter(x => typeof x === 'string' && x).join(' ');
      // 사진: 상세(없으면 목록)의 images[].url 중 https 주소만. 없으면 사진 없음(빈 배열).
      const imageSource = Array.isArray(detail?.images) ? detail!.images as unknown[] : Array.isArray(row.images) ? row.images as unknown[] : [];
      const images = imageSource.map(i => object(i) ? i.url : i).filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u));
      records.push({ sourceId: 'RP012', uid: plate, plate, vehicleText: name,
        // 계약중은 모든 원천에서 같게(커맨드 센터 2026-10-14): 문서 유지 + «계약중» 표시 노출(선점), 출고가능 비교에서는 raw 로 제외.
        status: row.hasActiveContract ? { raw: '계약중', saleAvailable: true } : { raw: '출고가능', saleAvailable: true },
        terms, observedAt,
        raw: { source: 'sonogong-partner-api', tab, vehicle_id: id, product_type: PRODUCT_TYPE_BY_TAB[tab], list: structuredClone(row), ...(detail ? { detail: structuredClone(detail) } : {}),
          prices: structuredClone(prices), images, ...(Object.keys(spec).length ? { spec } : {}) },
        vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] });
    }
  }
  if (duplicates.size) incomplete ??= 'DUPLICATE_PLATES';
  if (!records.length) incomplete ??= 'API_EMPTY';
  const notes: string[] = [];
  if (crossTabDuplicates) notes.push(`CROSS_TAB_DUPLICATE:${crossTabDuplicates}`);
  if (generationDifferences) notes.push(`CROSS_TAB_GENERATION_DIFFERENCE:${generationDifferences}`);
  return { observedAt, complete: !incomplete, ...(incomplete ? { incompleteReason: incomplete } : {}), tabsRead: [...SONOGONG_API_TABS],
    records, held, duplicatePlates: [...duplicates], listed, detailsRead, notes };
}

/** 행 수 하한(부분 읽기 방어): 직전 정상 회차 목록 수와 잠금 제외 노출 문서 수 중 큰 값의 80%. */
export const sonogongApiRowFloor = (unlockedExposed: number, previousListed: number): number =>
  Math.max(Math.ceil(unlockedExposed * 0.8), Math.ceil(previousListed * 0.8));
