/** 손오공 렌터카 공식 파트너 API(partner/v1) 읽기 어댑터 — 로그인 수집 대체(대표 2026-10-14).
 * 계약: 기준 주소 SONOGONG_API_BASE(https://sokrc.com/api/partner/…), 모든 요청에 헤더 x-partner-key(SONOGONG_API_KEY), 읽기 GET 만,
 * 목록 GET /vehicles?tab=rent|sub|pick&page&pageSize(≤50), 상세 GET /vehicles/{id}(보증금·보험은 상세에만 있음), 데이터는 1시간 단위 갱신.
 * 보증금은 공급사 정책 정제 표(domain/supplier-deposit-policy)를 따른다: 양수 원문 금액이 먼저(모든 탭), 원문이 0·빈칸이면 구독·픽업구독만 월 대여료×약정연수(최대 3개월) 산출식, 중고렌트는 UNKNOWN. 0 은 무보증이 아니다.
 * 안전: 직렬·요청 간 최소 간격·재시도 0·429/401/403 즉시 정지·redirect 거부·허용 호스트 고정. 키·URL 쿼리·응답 본문은 오류·로그에 남기지 않는다.
 * 키가 없으면 네트워크 호출 0(SONOGONG_API_NOT_CONFIGURED). 이 모듈을 import 하는 것만으로 인증·접속하지 않는다. */
import type { SourceAmount, SourceProductRecord, SourceTerm } from '../domain/source-engine.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import { fuelName } from './normalize-sonogong.js';
import { computeSupplierRuleDeposit, supplierDepositPolicy } from '../domain/supplier-deposit-policy.js';

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

/** 금액 칸 해석(원 단위 정수). 유한한 0 이상 «정수» 숫자(소수는 읽을 수 없는 값)와 숫자 문자열(쉼표 허용)만 받는다.
 * 값이 «없음»(null·undefined·빈 문자열)이면 UNKNOWN, 값은 있는데 읽을 수 없으면(NaN·음수·글자 등) UNKNOWN 이면서 unparseable=true 로 센다. */
export const parseSonogongAmount = (v: unknown): { amount: SourceAmount; unparseable: boolean } => {
  const unknown = (unparseable: boolean) => ({ amount: { state: 'UNKNOWN' as const, value: null }, unparseable });
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return unknown(false);
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(v.trim())) n = Number(v.trim().replace(/,/g, ''));
  else return unknown(true);
  if (!Number.isFinite(n) || n < 0) return unknown(true);
  // 소수는 반올림하지 않는다(Codex #643 ①): 0.4 를 0 원 확정(ZERO)으로, 1000.5 를 1001 로 바꾸지 않고 읽을 수 없는 값으로 둔다.
  if (!Number.isSafeInteger(n)) return unknown(true);
  const won = n;
  return { amount: won === 0 ? { state: 'ZERO', value: 0 } : { state: 'KNOWN', value: won }, unparseable: false };
};
/** 상세의 실제 최초등록일(YYYY-MM-DD, 없는 날짜는 거른다). 제조연월은 최초등록일이 아니다. */
const registrationDate = (v: unknown): string | null => {
  const m = typeof v === 'string' ? /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})/.exec(v.trim()) : null;
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
};
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
  /** 읽기를 마친 시각(엔진 신선도 창의 기준). 상류 데이터 생성 시각은 generatedAt 에 따로 둔다(1시간 단위 갱신이라 읽기 시각과 다르다). */
  observedAt: string; generatedAt?: string | null; complete: boolean; incompleteReason?: string; tabsRead: SonogongApiTab[];
  records: SourceProductRecord[]; held: Array<{ tab: SonogongApiTab; reason: string }>; duplicatePlates: string[];
  listed: number; detailsRead: number;
  /** 읽기는 정상이지만 사람이 알아야 할 안전한 코드: CROSS_TAB_DUPLICATE:n(탭 우선순위 rent>sub>pick 로 하나만 채택), CROSS_TAB_GENERATION_DIFFERENCE:n(같은 번호의 탭 간 제조연월 차이),
   * AMOUNT_UNPARSEABLE:n(값은 있으나 읽을 수 없어 UNKNOWN 으로 둔 월 대여료·보증금 칸 수), FUEL_UNRESOLVED:n(허용 목록·별칭에 없는 연료 — 칸을 비우고 원문만 보존),
   * DEPOSIT_RULE_DIFFERS:n(구독 항의 API 양수 보증금이 정책 계산값과 다름 — 원문 금액을 쓰고 계산값은 raw.rule_deposit 에 검토용으로 남김),
   * DEPOSIT_PLACEHOLDER_ZERO:n(중고렌트 항의 API 보증금 0 — 자리채움이라 UNKNOWN 으로 둠). */
  notes: string[];
};

export async function readSonogongApi(client: SonogongApiClient, opts: { now?: () => string } = {}): Promise<SonogongApiRead> {
  const clock = opts.now ?? (() => new Date().toISOString());
  const rowsByTab = new Map<SonogongApiTab, Record<string, unknown>[]>();
  let generatedAt: string | null = null, incomplete: string | undefined;
  // 페이지마다 온 상류 생성 시각(ms). 둘 이상이면 읽는 도중 스냅숏이 바뀐 것이다(페이지가 서로 다른 판에서 왔다).
  const generations = new Set<number>();
  for (const tab of SONOGONG_API_TABS) {
    const rows: Record<string, unknown>[] = [];
    // 완료 판정은 «누적 행 수»가 아니라 서로 다른 차 식별자(id, 없으면 행 내용) 수로 한다(Codex #643 ③): 읽는 도중 페이지가 밀려 같은 차가 두 페이지에 오면
    // 행 수만으로 총수에 닿아 뒤 차량을 놓친 채 완료로 보인다. 겹친 행은 한 번만 쓰고 불완전(API_PAGE_OVERLAP)으로 둔다.
    const seenIds = new Set<string>();
    let total: number | null = null, done = false;
    for (let page = 1; page <= SONOGONG_API_POLICY.maxPages; page++) {
      const { data, attrs } = await client.get('/vehicles', { tab, page, pageSize: SONOGONG_API_POLICY.pageSize });
      const batch = listRows(data);
      if (!batch) throw new SonogongApiError('SONOGONG_API_INVALID_RESPONSE');
      if (typeof attrs.generatedAt === 'string' && Number.isFinite(Date.parse(attrs.generatedAt))) {
        generations.add(Date.parse(attrs.generatedAt));
        generatedAt = !generatedAt || Date.parse(attrs.generatedAt) < Date.parse(generatedAt) ? attrs.generatedAt : generatedAt;
      }
      total = totalOf(data, attrs) ?? total;
      for (const row of batch) {
        const key = typeof row.id === 'number' || typeof row.id === 'string' ? `id:${row.id}` : `row:${JSON.stringify(row)}`;
        if (seenIds.has(key)) { incomplete ??= 'API_PAGE_OVERLAP'; continue; }
        seenIds.add(key); rows.push(row);
      }
      // 끝 판정: 총수가 있으면 총수에 닿을 때까지, 없으면 빈 페이지가 올 때까지 읽는다(요청 크기보다 작은 페이지만으로 끝났다고 보지 않는다 —
      // 서버가 페이지 크기를 줄여 주면 뒤 페이지를 통째로 놓친다). 상한(maxPages)을 넘으면 불완전.
      if (batch.length === 0 || (total !== null && seenIds.size >= total)) { done = true; break; }
    }
    if (!done) incomplete ??= 'API_PAGE_LIMIT';
    if (total !== null && rows.length !== total) incomplete ??= 'API_COUNT_MISMATCH';
    rowsByTab.set(tab, rows);
  }
  if (generations.size > 1) incomplete ??= 'SNAPSHOT_CHANGED_DURING_READ';
  // 신선도 창(엔진 OTHER 30분)의 기준은 «읽은 시각»이다. 상류 generatedAt 은 최대 1시간 묵을 수 있어 그대로 observedAt 으로 쓰면 항상 SOURCE_STALE 이 된다
  // (2026-10-14 첫 DRY_RUN: SOURCE_INCOMPLETE,SOURCE_STALE). 상류 정지 여부는 generatedAt 으로 따로 판정한다(guards).
  const observedAt = clock();
  const failureCodes = new Map<string, number>();
  // 상세 404 = «목록에는 있고 상세에는 없는» 차(목록·상세 사이 삭제/비공개). 그 한 대만 건너뛰고(목록 행만 보존, 보증금 미확인) 읽기는 계속한다.
  // 건수가 허용 한도(max(5, 목록의 2%))를 넘을 때만 불완전로 둔다. 429/401/403·전송 오류·5xx·응답 형식 오류는 기존대로 즉시 정지/불완전.
  const skipped404: string[] = [];
  const records: SourceProductRecord[] = [], held: SonogongApiRead['held'] = [], duplicates = new Set<string>();
  // 탭 우선순위(명세서): rent > sub > pick. 같은 번호가 다른 탭에도 있으면 «채택된» 앞선 탭 하나만 쓰고 경고로 센다(불완전 아님).
  // 보류된 행(상태 미상·ID 없음·신원 불일치 등)은 다른 탭의 정상 행을 가리지 않는다 — accepted 에는 레코드로 채택된 행만 들어간다.
  // 같은 탭 안에서 같은 번호가 두 번이면(정상·보류 무관) 원천 오류라 읽기를 불완전으로 둔다.
  const accepted = new Map<string, { tab: SonogongApiTab; ym: string; index: number }>();
  let crossTabContractConflicts = 0;
  let listed = 0, detailsRead = 0, crossTabDuplicates = 0, generationDifferences = 0, amountUnparseable = 0, fuelUnresolved = 0;
  let depositRuleDiffers = 0, depositPlaceholderZero = 0;
  for (const tab of SONOGONG_API_TABS) {
    const inTab = new Set<string>();
    for (const row of rowsByTab.get(tab) ?? []) {
      listed++;
      const plateRaw = String(row.carNumber ?? '').replace(/\s+/g, '');
      if (!/^\d{2,3}[가-힣]\d{4}$/.test(plateRaw) || !isAssignedPlate(plateRaw)) { held.push({ tab, reason: 'PLATE_INVALID' }); continue; }
      const plate = plateIdentityKey(plateRaw);
      const ymRaw = String(row.manufactureYearMonth ?? '').slice(0, 7);
      if (inTab.has(plate)) { duplicates.add(plate); continue; }
      inTab.add(plate);
      const earlier = accepted.get(plate);
      if (earlier) {
        crossTabDuplicates++; if (earlier.ym && ymRaw && earlier.ym !== ymRaw) generationDifferences++;
        // 탭 사이 충돌(Codex #643 ②): 앞선 탭은 출고가능인데 뒤 탭이 계약중이면 출고가능으로 두지 않는다 — 계약중을 우선해 채택 레코드 상태를 바꾼다.
        // 반대(앞 계약중·뒤 출고가능)는 앞선 값 그대로(계약중)다. 한 번이라도 계약중이면 판매 가능으로 내보내지 않는 쪽(fail-closed)이다.
        const kept = records[earlier.index]!;
        if (row.hasActiveContract === true && kept.status.raw !== '계약중') {
          kept.status = { raw: '계약중', saleAvailable: true }; crossTabContractConflicts++;
        }
        continue;
      }
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
          // 진단(2026-10-14): 상태 코드·건수만 남긴다(키·URL·본문 없음) — 429/한도/권한/없는 id 를 가린다.
          if (e instanceof SonogongApiError && e.status === 404) { skipped404.push(plate.replace(/\D/g, '').slice(-4)); }
          else {
            const code = (e instanceof SonogongApiError ? e.code : 'UNKNOWN').replace(/^SONOGONG_API_/, '');
            failureCodes.set(code, (failureCodes.get(code) ?? 0) + 1);
            incomplete ??= 'API_DETAIL_FAILED';
          }
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
      const policy = supplierDepositPolicy('RP012', tab);
      for (const months of MONTHS) {
        const rent = parseSonogongAmount(monthly[String(months)]);
        if (rent.unparseable) amountUnparseable++;
        if (rent.amount.state !== 'KNOWN') continue;
        // 공급사 정책 정제(domain/supplier-deposit-policy, 대표 2026-10-14 «값이 숫자로 존재하거나 산출식으로 존재한다»):
        // 양수 원문 금액 = KNOWN(모든 탭). 원문 0·빈칸 = 자리채움(API 에 무보증 표시 칸 없음) → sub·pick 은 손오공 정책 «월 대여료 × 약정연수(최대 3개월)»
        // 계산값(KNOWN, raw.deposit_rule), rent 는 UNKNOWN. 어느 경우도 ZERO 가 되지 않는다.
        let depositAmount: SourceAmount = { state: 'UNKNOWN', value: null };
        let apiDeposit: SourceAmount | null = null;
        if (detail) {
          const parsed = parseSonogongAmount(deposit[String(months)]);
          if (parsed.unparseable) amountUnparseable++;
          apiDeposit = parsed.amount;
        }
        const raw: Record<string, unknown> = { priceType: RETURN_TYPE[tab] };
        // 숫자가 먼저, 숫자가 없을 때 산출식(«값이 숫자로 존재하거나 산출식으로 존재», READ-RUNTIME «양수 원문 금액 우선»):
        // 양수 원문 금액은 어느 탭이든 KNOWN(원문 금액, 계산 표식 없음). 구독 항의 규칙 값이 다르면 raw.rule_deposit 와 경고로만 남긴다.
        if (apiDeposit?.state === 'KNOWN') {
          depositAmount = apiDeposit;
          if (policy?.deposit === 'RULE') {
            const computed = computeSupplierRuleDeposit(policy.rules[0]!, months, rent.amount.value);
            if (computed && computed.amount !== apiDeposit.value) { depositRuleDiffers++; raw.rule_deposit = computed.amount; }
          }
        } else if (policy?.deposit === 'RULE') {
          // API 0·빈칸·상세 없음 = 자리채움 → 공급사 정책 산출식
          const rule = policy.rules[0]!;
          const computed = computeSupplierRuleDeposit(rule, months, rent.amount.value);
          if (computed) { depositAmount = { state: 'KNOWN', value: computed.amount }; raw.deposit_rule = rule; }
          if (apiDeposit?.state === 'ZERO') raw.api_deposit = 0;   // 자리채움 원문은 대조용으로만
        } else if (apiDeposit?.state === 'ZERO') depositPlaceholderZero++;
        terms.push({ months, monthlyRent: rent.amount, deposit: depositAmount, mileage: null, raw });
      }
      const ym = /^(\d{4})-(\d{2})/.exec(String(row.manufactureYearMonth ?? ''));
      const spec: Record<string, string> = {};
      if (typeof row.exteriorColor === 'string' && row.exteriorColor.trim()) spec.ext_color = row.exteriorColor.trim();
      // 연료: 공통 허용 목록·별칭(normalize-sonogong 의 표)으로만 바꾼다. 모르면 칸을 비운다(원문은 raw.list.fuel 에 그대로 남는다).
      if (typeof row.fuel === 'string' && row.fuel.trim()) {
        const fuel = fuelName(row.fuel);
        if (fuel) spec.fuel_type = fuel; else fuelUnresolved++;
      }
      // 제조연월은 최초등록일이 아니다: manufacture_year_month 로 따로 두고, 최초등록일은 상세에 실제 칸이 있을 때만 쓴다.
      if (ym) { spec.year = ym[1]!; spec.manufacture_year_month = `${ym[1]}-${ym[2]}`; }
      const registered = registrationDate(detail?.firstRegistrationDate);
      if (registered) spec.first_registration_date = registered;
      if (typeof row.mileageKm === 'number') spec.mileage = String(row.mileageKm);
      if (typeof row.displacementCc === 'number') spec.engine_cc = String(row.displacementCc);
      const name = typeof detail?.carName === 'string' && detail.carName.trim() ? detail.carName.trim()
        : [row.brand, row.model, row.detailName].filter(x => typeof x === 'string' && x).join(' ');
      // 사진(대표 10-15 «손오공은 API 연동», 10-14 «URL 그대로 노출»): 상세(없으면 목록)의 images[].url → 없으면 목록 thumbnailUrl.
      const images = sonogongPhotoUrls(detail, row);
      records.push({ sourceId: 'RP012', uid: plate, plate, vehicleText: name,
        // 계약중은 모든 원천에서 같게(커맨드 센터 2026-10-14): 문서 유지 + «계약중» 표시 노출(선점), 출고가능 비교에서는 raw 로 제외.
        status: row.hasActiveContract ? { raw: '계약중', saleAvailable: true } : { raw: '출고가능', saleAvailable: true },
        terms, observedAt,
        raw: { source: 'sonogong-partner-api', tab, vehicle_id: id, product_type: PRODUCT_TYPE_BY_TAB[tab], list: structuredClone(row), ...(detail ? { detail: structuredClone(detail) } : {}),
          prices: structuredClone(prices), images, ...(Object.keys(spec).length ? { spec } : {}) },
        vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] });
      accepted.set(plate, { tab, ym: ymRaw, index: records.length - 1 });
    }
  }
  if (duplicates.size) incomplete ??= 'DUPLICATE_PLATES';
  if (!records.length) incomplete ??= 'API_EMPTY';
  const notes: string[] = [];
  if (skipped404.length) {
    const allowed = Math.max(5, Math.ceil(listed * 0.02));
    if (skipped404.length > allowed) {
      failureCodes.set('HTTP_404', skipped404.length);
      incomplete ??= 'API_DETAIL_FAILED';
    } else {
      for (const tail of skipped404) notes.push(`DETAIL_404:${tail}`);   // 끝 4자리만(전체 번호 없음)
    }
  }
  // 상세 실패 사유가 하나라도 있으면 가장 많은 코드와 건수를 불완전 사유에 합친다(알림·요약에 그대로 남는다, 최대 63자).
  if (incomplete === 'API_DETAIL_FAILED' && failureCodes.size) {
    const [code, n] = [...failureCodes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
    incomplete = `API_DETAIL_FAILED_${code}_${n}of${listed}`.replace(/[^A-Z0-9_a-z]/g, '').toUpperCase().slice(0, 63);
  }
  for (const [code, n] of failureCodes) notes.push(`DETAIL_FAIL:${code}:${n}`.slice(0, 60));
  if (crossTabDuplicates) notes.push(`CROSS_TAB_DUPLICATE:${crossTabDuplicates}`);
  if (crossTabContractConflicts) notes.push(`CROSS_TAB_CONTRACT_CONFLICT:${crossTabContractConflicts}`);
  if (generationDifferences) notes.push(`CROSS_TAB_GENERATION_DIFFERENCE:${generationDifferences}`);
  if (amountUnparseable) notes.push(`AMOUNT_UNPARSEABLE:${amountUnparseable}`);
  if (fuelUnresolved) notes.push(`FUEL_UNRESOLVED:${fuelUnresolved}`);
  if (depositRuleDiffers) notes.push(`DEPOSIT_RULE_DIFFERS:${depositRuleDiffers}`);
  if (depositPlaceholderZero) notes.push(`DEPOSIT_PLACEHOLDER_ZERO:${depositPlaceholderZero}`);
  return { observedAt, generatedAt, complete: !incomplete, ...(incomplete ? { incompleteReason: incomplete } : {}), tabsRead: [...SONOGONG_API_TABS],
    records, held, duplicatePlates: [...duplicates], listed, detailsRead, notes };
}

/** 손오공 사진 주소 목록(원천 순서 그대로): 상세 images[].url(상세가 없거나 images 가 배열이 아니면 목록 images[].url), 그것이 비면 목록 thumbnailUrl.
 * https·사용자정보 없음·길이 ≤ SONOGONG_PHOTO_POLICY.maxUrlLength 만, 중복 제거, 최대 maxPhotos 장. 없으면 빈 배열(사진 없음 — 기존 사진을 지우는 근거가 아니다). */
export const SONOGONG_PHOTO_POLICY = Object.freeze({ maxPhotos: 20, maxUrlLength: 1000 });
export function sonogongPhotoUrls(detail: Record<string, unknown> | null | undefined, row: Record<string, unknown>): string[] {
  const clean = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const text = v.trim();
    if (!text || text.length > SONOGONG_PHOTO_POLICY.maxUrlLength || /\s/.test(text)) return null;
    try {
      const url = new URL(text);
      return url.protocol === 'https:' && !url.username && !url.password && url.hostname ? text : null;
    } catch { return null; }
  };
  const source = Array.isArray(detail?.images) ? detail!.images as unknown[] : Array.isArray(row.images) ? row.images as unknown[] : [];
  const out: string[] = [];
  for (const item of source) {
    const url = clean(object(item) ? item.url : item);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= SONOGONG_PHOTO_POLICY.maxPhotos) break;
  }
  if (!out.length) { const thumb = clean(row.thumbnailUrl); if (thumb) out.push(thumb); }
  return out;
}

/** 행 수 하한(부분 읽기 방어): 직전 정상 회차 목록 수와 잠금 제외 노출 문서 수 중 큰 값의 80%. */
export const sonogongApiRowFloor = (unlockedExposed: number, previousListed: number): number =>
  Math.max(Math.ceil(unlockedExposed * 0.8), Math.ceil(previousListed * 0.8));
