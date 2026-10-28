import supplierSpec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveTargetProject } from './firebase-target.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { CycleCommands, CycleProduct, SupplierFields, VehicleIdentityRefiner, VehicleIdentityRefinement } from '../ports/source-cycle.js';
import { rawEntryOfRecord, rawEntryOfHeld } from '../domain/source-raw.js';
import { salePriceMap, compactRecord, isPhotoUrlList, PHOTO_URL_LIST_SOURCES, representativeTerms, type SourceAmount, type SourceProductRecord } from '../domain/source-engine.js';
import { SOURCE_ENGINE_WRITER } from '../domain/deposit-evidence.js';
import { boundedOptions, asBoundedOptions, OPTIONS_MAX_ITEMS } from '../domain/sonogong-options.js';
import { resolveErp5InventoryStatus, PROVIDER_AVAILABLE_STATUS_LABELS } from '../domain/erp5-inventory-status.js';
import { hasSupplierDepositPolicy, supplierDepositRuleFor } from '../domain/supplier-deposit-policy.js';
import { canonicalFuel } from '../domain/fuel-alias.js';
import { reviewedSpecApprovals, reviewedSpecOf, type ReviewedSpecApproval } from '../domain/reviewed-spec-correction.js';
import { refillableSpecValues, MASTER_SPEC_KEYS, masterSpecValid, masterSpecFillValues, type MasterSpecValues } from '../domain/spec-refill.js';
import { SPEC_FORMAT_RULES } from '../domain/source-spec-validation.js';
import { policyLinkCodeFor, policyLinkReason } from '../domain/supplier-default-policy-link.js';
import { photoLinkFillState, sheetPhotoLinkFields } from '../domain/sheet-photo-link.js';
import { validSheetIdentity, type SheetIdentity } from '../domain/sheet-identity.js';
import { sheetFactFields, sheetFactState, isBlankFact, SHEET_FACT_KEYS, type SheetFactKey } from '../domain/sheet-facts.js';
import { hostname } from 'node:os';
import { productRevisionModeOf, type ProductRevisionActor } from '../domain/product-revision.js';
import { recordProductRevision, productRevisionSinkOf, localProductRevisionSink, restProductRevisionSink, type ProductRevisionRecordResult } from './product-revision-writer.js';

type Fields = Record<string, unknown>;
type Doc = { name: string; updateTime: string; fields: Fields };
type Backup = { project: string; key: string; before: CycleProduct | null; document: Doc | null };
export const cycleAmount = (v: unknown): SourceAmount => v === 0 ? { state: 'ZERO', value: 0 } :
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? { state: 'KNOWN', value: v } : { state: 'UNKNOWN', value: null };
export function decodeValue(v: any): any {
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('integerValue' in v || 'doubleValue' in v) return Number(v.integerValue ?? v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  throw new Error('FIRESTORE_VALUE_UNSUPPORTED');
}
export const decodeFields = (fields: Fields): Fields => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeValue(v)]));
export function encodeValue(v: any): any {
  if (v === null) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number' && Number.isFinite(v)) return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  throw new Error('FIRESTORE_VALUE_INVALID');
}
export const encodeFields = (fields: Fields): Fields => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encodeValue(v)]));
/** gcloud 사용자 토큰 원천(프로세스 안 캐시). 2026-10-17 장애: 요청마다 powershell→gcloud(Python) 를 새로 띄워(회차당 ≈250회) 호스트가 느려지면
 * 일부가 30초를 넘기거나 stdout 파이프 오류로 죽어 비코드 예외 → CYCLE_ERROR 로 전 공급사가 보류됐다. 이 원천은
 *  - 발급 토큰을 ttlMs(기본 15분 — gcloud 가 «출력한 시각»은 «발급 시각»이 아니라 1시간을 믿지 않는다) 동안 재사용하고,
 *  - 동시 요청은 한 발급 Promise 를 공유하며, 실패하면 1회 재시도(더 긴 시간 제한), 최종 실패 뒤 cooldownMs 동안은 같은 코드로 바로 거절(회차 안 누적 지연 방지),
 *  - 예외는 회차 기록 필터(/^[A-Z_]+$/)를 통과하는 코드만 낸다: GCLOUD_TOKEN_FAILED_TIMEOUT · _CRASH · _EMPTY,
 *  - 계정은 SOURCE_CYCLE_GCLOUD_ACCOUNT(있으면 --account 고정)로 활성 계정 전환에 흔들리지 않게 한다.
 * API 가 401 을 돌려주면 호출자가 invalidate() 뒤 한 번 다시 발급한다(만료 시각을 모르는 토큰의 안전망). */
export type GcloudTokenSource = { (): Promise<string>; invalidate(): void };
export type GcloudTokenExec = (timeoutMs: number) => Promise<string>;
export function createGcloudTokenSource(opts: { exec?: GcloudTokenExec; now?: () => number; ttlMs?: number; timeoutMs?: number; retryTimeoutMs?: number;
  cooldownMs?: number; account?: string } = {}): GcloudTokenSource {
  const now = opts.now ?? Date.now, ttl = opts.ttlMs ?? 15 * 60_000, timeoutMs = opts.timeoutMs ?? 30_000, retryTimeoutMs = opts.retryTimeoutMs ?? 60_000,
    cooldown = opts.cooldownMs ?? 60_000;
  const exec: GcloudTokenExec = opts.exec ?? (ms => runGcloudPrintAccessToken(ms, opts.account));
  let cached: { token: string; at: number } | null = null, inflight: Promise<string> | null = null, failed: { code: string; at: number } | null = null;
  const classify = (e: unknown): string => {
    const m = e instanceof Error ? e.message : String(e);
    if (/^GCLOUD_TOKEN_FAILED_[A-Z_]+$/.test(m)) return m;
    if (/timed out|ETIMEDOUT|TIMEOUT/i.test(m)) return 'GCLOUD_TOKEN_FAILED_TIMEOUT';
    return 'GCLOUD_TOKEN_FAILED_CRASH';
  };
  const once = async (ms: number): Promise<string> => {
    const token = (await exec(ms)).trim();
    if (!token || /\s/.test(token)) throw new Error('GCLOUD_TOKEN_FAILED_EMPTY');
    return token;
  };
  const source = (async (): Promise<string> => {
    if (cached && now() - cached.at < ttl) return cached.token;
    if (inflight) return inflight;
    if (failed && now() - failed.at < cooldown) throw new Error(failed.code);
    inflight = (async () => {
      try {
        let token: string;
        try { token = await once(timeoutMs); } catch (first) {
          const firstCode = classify(first);
          try { token = await once(retryTimeoutMs); } catch (second) { throw new Error(classify(second) === 'GCLOUD_TOKEN_FAILED_EMPTY' ? firstCode : classify(second)); }
        }
        cached = { token, at: now() }; failed = null; return token;
      } catch (e) { cached = null; failed = { code: classify(e), at: now() }; throw new Error(failed.code); }
      finally { inflight = null; }
    })();
    return inflight;
  }) as GcloudTokenSource;
  source.invalidate = () => { cached = null; failed = null; };
  return source;
}
/** powershell → gcloud.cmd 한 번. 시간 제한은 타이머 하나로만 관리한다(execFile 자체 timeout 은 쓰지 않는다 — 부모 powershell 이 먼저 죽으면
 * 자식 gcloud(Python) 가 남아 누적된다, Codex P1). 시간 초과 시 taskkill /T 로 트리 전체를 끝내고, 종료 성공 여부와 무관하게 즉시 거절한다. */
async function runGcloudPrintAccessToken(timeoutMs: number, account?: string): Promise<string> {
  const args = ['auth', 'print-access-token', ...(account ? ['--account', account] : [])];
  const win = process.platform === 'win32';
  const child = execFile(win ? 'powershell.exe' : 'gcloud', win ? ['-NoProfile', '-NonInteractive', '-Command', `& gcloud.cmd ${args.join(' ')}; exit $LASTEXITCODE`] : args,
    { windowsHide: true });
  return new Promise<string>((resolve, reject) => {
    let out = '', settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => {
      if (win && child.pid) { try { execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* 트리 종료 실패는 무시 */ } }
      try { child.kill('SIGKILL'); } catch { /* 이미 끝났을 수 있다 */ }
      finish(() => reject(new Error('GCLOUD_TOKEN_FAILED_TIMEOUT')));
    }, timeoutMs);
    child.stdout?.on('data', d => { out += d; });
    child.on('error', () => finish(() => reject(new Error('GCLOUD_TOKEN_FAILED_CRASH'))));
    child.on('close', code => finish(() => code === 0 ? resolve(out) : reject(new Error('GCLOUD_TOKEN_FAILED_CRASH'))));
  });
}
const fixedAccount = process.env.SOURCE_CYCLE_GCLOUD_ACCOUNT?.trim();
export const gcloudUserToken: GcloudTokenSource = createGcloudTokenSource(fixedAccount ? { account: fixedAccount } : {});
/** 가격 맵 정규화: null·undefined·키 누락을 같게 보고(해당 키 제거) 키를 정렬한다. digest 계산·비교·되읽기 대조 공통 기준. */
export function normalizePrice(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePrice);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, 'en-US')).map(([k, v]) => [k, normalizePrice(v)]));
  }
  return value;
}
export const priceDigest = (price: unknown) => stableDigest(normalizePrice(price ?? {}));
const fieldDigest = (key: string, value: unknown) => key === 'price' ? priceDigest(value) : stableDigest(value);
export function productRecord(uid: string, f: Fields, observedAt: string): SourceProductRecord {
  return { sourceId: String(f.provider_company_code ?? ''), uid, plate: typeof f.car_number === 'string' ? f.car_number : null,
    vehicleText: String(f.car_name ?? (f.원문 as Fields | undefined)?.차명 ?? f.model ?? ''),
    status: { raw: String(f.status ?? ''), saleAvailable: f.listable === true && f.status !== '출고불가' && f.status !== '계약중' && f.status_kind !== '불가' },
    terms: Object.entries((f.price ?? {}) as Record<string, any>).filter(([months]) => /^\d+$/.test(months)).map(([months, p]) => ({ months: Number(months),
      monthlyRent: cycleAmount(p.rent), deposit: cycleAmount(p.deposit), mileage: typeof p.mileage === 'string' ? p.mileage : null, raw: p })),
    observedAt, raw: { source: f.source ?? null,
      ...(f.source_tab !== undefined ? { source_tab: f.source_tab } : {}),
      ...(f.product_group !== undefined ? { product_group: f.product_group } : {}) }, vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] };
}
/** 저장 digest 와 현재 price 대조. 정규화(null=누락) 일치, 또는 다른 쓰기 주체가 표시용 mileage 만 지운 경우(저장 digest 는 기록의 terms 와 일치하고 현재 price 는 mileage 를 뺀 terms 와 같음)를 허용한다. rent·deposit 변경은 여전히 DRIFT. */
export function priceMatchesRecord(price: unknown, storedDigest: unknown, record: SourceProductRecord): boolean {
  if (priceDigest(price) === storedDigest || stableDigest(price ?? {}) === storedDigest) return true;
  const derived = salePriceMap(record.terms);
  if (stableDigest(derived) !== storedDigest && priceDigest(derived) !== storedDigest) return false;
  return priceDigest(price) === priceDigest(salePriceMap(record.terms, false));
}
/** 계약 잠금 필드 판정(허용값 표 하나): 비어 있지 않은 값은 전부 잠금이다 — true, 'LEDGER'(정산원장), 그 밖에 알 수 없는 값도 보수적으로 잠금.
 * 비잠금은 없음(undefined/null)·false·빈 문자열뿐. (runtime 의 노출 대수 판정과 같은 규칙) */
export const isContractLockValue = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== '';
/** 엔진 작성 표식: 엔진이 문서를 쓸 때마다 «누가·어떤 표시 상태로·어느 관측 시각에» 썼는지 한 칸에 남긴다. 계약중 문서를 엔진 소유로 취급하는 유일한 증거다. */
export const SOURCE_CYCLE_WRITER = SOURCE_ENGINE_WRITER;
/** 엔진이 «원천이 직접 계약중으로 읽은 값»을 쓴 문서만 계약 잠금이 아니다. 증거 = 엔진 작성 표식(by·status 계약중) + 엔진이 쓴 모양(표시 상태 계약중·선점·노출,
 * 원천 기록 상태 원문 계약중) + 어떤 계약 잠금 필드 값도 없음. 표식이 없거나 다른 주체이거나, ERP 가 status_kind 를 계약중으로 바꿨거나 잠금 필드를 걸었으면 잠금이다
 * (원천이 출고가능으로 바뀌어도 장부 잠금 차량은 덮어쓰지 않는다 — Codex 독립 검토 2026-10-14 P1 2건). */
const engineWroteContracted = (f: Fields, record: SourceProductRecord): boolean => {
  const mark = f.source_cycle_write as { by?: unknown; status?: unknown } | null | undefined;
  return !!mark && typeof mark === 'object' && mark.by === SOURCE_CYCLE_WRITER && mark.status === '계약중' &&
    f.status === '계약중' && f.status_kind === '선점' && f.vehicle_status === '계약중' && f.listable === true &&
    record.status.raw === '계약중' && f.source_cycle_record !== undefined && !isContractLockValue(f.locked_by_contract);
};
/** 문서에 사진이 하나라도 있나: 원천 사진(image_urls·image_url), 드라이브 캐시(photo_cache), 승인 사진(photo_original_refs). */
const nonEmptyList = (v: unknown) => Array.isArray(v) && v.some(x => x !== null && x !== undefined && x !== '');
const hasHumanPhotos = (f: Fields) => nonEmptyList(f.photo_original_refs) || (f.photo_cache !== undefined && f.photo_cache !== null);
const hasAnyPhoto = (f: Fields) => hasHumanPhotos(f) || nonEmptyList(f.image_urls) || (typeof f.image_url === 'string' && !!f.image_url.trim());
/** 저장 기록에 API 사진 주소가 있나: 실제 목록이면 비어 있지 않은지, 옛 digest 형태면 «빈 목록의 digest» 가 아닌지. */
const EMPTY_LIST_DIGEST = stableDigest([]).slice(0, 32);
const recordHasPhotoUrls = (record: SourceProductRecord): boolean => {
  const images = record.raw?.images as unknown;
  if (Array.isArray(images)) return images.length > 0;
  const digest = images && typeof images === 'object' ? (images as { __digest?: unknown }).__digest : undefined;
  return typeof digest === 'string' && digest !== EMPTY_LIST_DIGEST;
};
/** 원천 API 사진 → image_urls(소비처 catalog 가 읽는 칸, 첫 장 = image_url). 사람·승인 사진(photo_original_refs·photo_cache)이 있는 문서는 건드리지 않고,
 * API 가 사진을 주지 않으면(빈 목록·digest) 쓰지 않는다 — 모르는 값으로 기존 사진을 지우지 않는다. 목록이 바뀌면 원천 사실이므로 갱신한다. */
export function apiPhotoFields(r: SourceProductRecord, original: Fields): Fields {
  if (!PHOTO_URL_LIST_SOURCES.has(r.sourceId) || hasHumanPhotos(original)) return {};
  const urls = r.raw?.images;
  if (!isPhotoUrlList(urls) || !urls.length) return {};
  return { image_urls: [...urls], image_url: urls[0]! };
}
/** 손오공 API 옵션(대표 2026-10-15 승인, 설계 docs/SONOGONG-OPTIONS-DESIGN-20261016.md): 상세 raw.detail.options → 새 칸 api_options_*.
 * 과거 시트 유래 칸(옵션·options·정제옵션)과 섞지 않는다. 유상 구분 근거는 API category «선택옵션» 하나이며 표시 전용(가격 계산 비반영).
 * 상세가 없거나 options 가 배열이 아니면 «모르는 값»으로 기존 옵션을 지우지 않는다 — 칸이 한 번도 없던 문서에만 확인 표식(api_options_state)을 남겨
 * 되풀이 쓰기(API_OPTIONS 사유)를 막는다. 옵션이 바뀌면 상세 digest 가 바뀌어 일반 변경으로 다시 쓴다. */
export const API_OPTIONS_MAX_ITEMS = OPTIONS_MAX_ITEMS;
export function apiOptionFields(r: SourceProductRecord, original: Fields): Fields {
  if (r.sourceId !== 'RP012') return {};
  // 상세가 있으면 거기서(분류+제한), 계획·저장 단계의 압축 레코드면 저장된 제한 꼴(raw.api_options)에서 읽는다. 분류 전 원문은 저장하지 않는다.
  const kept = boundedOptions((r.raw?.detail as { options?: unknown } | null | undefined)?.options) ?? asBoundedOptions(r.raw?.api_options);
  const hadMark = original.api_options_state !== undefined && original.api_options_state !== null;
  if (!kept) return hadMark ? {} : { api_options_state: 'NO_DETAIL', api_options_observed_at: r.observedAt };
  if (kept.state === 'TOO_MANY') return hadMark ? {} : { api_options_state: 'TOO_MANY', api_options_observed_at: r.observedAt };
  const { basic, paid } = kept;
  return { api_options_basic: basic, api_options_paid: paid, api_options_state: kept.state, api_options_source: 'RP012-api',
    api_options_unclassified_count: kept.unclassified_count,
    api_options_digest: stableDigest({ basic, paid }).slice(0, 32), api_options_observed_at: r.observedAt };
}
/** 엔진 기록(source_cycle_record)이 없는 옛 문서의 관측 기준 시각. 기본은 source_observed_at, 없으면 문서 updateTime.
 * 이안카(RP031) 옛 발행 문서는 사진·정책 연결 쓰기가 updateTime 을 원천 갱신 시각보다 늦게 밀어 엔진이 OBSERVATION_ORDER 로 영영 갱신하지 못했다.
 * 그래서 RP031 은 updateTime 을 쓰지 않고 옛 발행기가 남긴 원천 시각(iancar_phase_one.sourceSyncedAt → _direct_ingest_at)을 쓰고, 둘 다 없으면 «관측 없음»(epoch)으로 본다.
 * 동시성은 그대로다: 쓰기는 문서 updateTime 조건(CAS)·백업·되읽기로만 한다. */
export const LEGACY_NO_OBSERVATION = '1970-01-01T00:00:00.000Z';
export function legacyObservedAt(f: Fields, updateTime: string): string {
  if (typeof f.source_observed_at === 'string' && Number.isFinite(Date.parse(f.source_observed_at))) return f.source_observed_at;
  if (f.provider_company_code !== 'RP031') return String(f.source_observed_at ?? updateTime);
  const phase = f.iancar_phase_one as { sourceSyncedAt?: unknown } | null | undefined;
  if (phase && typeof phase === 'object' && typeof phase.sourceSyncedAt === 'string' && Number.isFinite(Date.parse(phase.sourceSyncedAt)))
    return new Date(Date.parse(phase.sourceSyncedAt)).toISOString();
  const direct = f._direct_ingest_at;
  const ms = typeof direct === 'number' ? direct : typeof direct === 'string' ? Date.parse(direct) : NaN;
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  return LEGACY_NO_OBSERVATION;
}
/** 엔진 회차 정체성 정제(대표 2026-10-15)의 대상: 엔진이 편입한 문서(source_cycle_record 있음) 중 아직 «검토 필요» 이고 제조사·모델이 빈 문서뿐이다.
 * 사람·ERP4 가 정한 정체성(제조사·모델이 하나라도 있음)이나 검토가 끝난 문서는 절대 건드리지 않는다. */
const textOf = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
/** 원천 필드(brand·model)로 제조사·모델만 채운 문서 표식. 이 문서도 아직 마스터로 확정되지 않은 «엔진 보류»이며 정체성 정제가 마스터 이름으로 덮어쓴다. */
export const SOURCE_FIELDS_MARK = 'SOURCE_FIELDS';
const filledByUs = (f: Fields): boolean => {
  const filled = f.vehicle_maker_model_filled as { maker?: unknown; model?: unknown; sub_model?: unknown } | null | undefined;
  // 사람이 maker·model «또는 세부모델»을 고쳤으면 표식만 남아도 보류가 아니다(Codex #685 ①: 세부모델도 «쓴 값 그대로»일 때만).
  return f.vehicle_maker_model_source === SOURCE_FIELDS_MARK && !!filled && typeof filled === 'object'
    && typeof filled.sub_model === 'string' && textOf(f.maker) === textOf(filled.maker) && textOf(f.model) === textOf(filled.model) && textOf(f.sub_model) === textOf(filled.sub_model)
    // 엔진은 이 문서의 트림을 쓴 적이 없다(채움 시점 트림은 빈칸) — 트림이 채워져 있으면 사람이 고친 것이므로 정체성 보류가 아니다(Codex #685 (b)).
    && textOf(f.trim_name) === '';
};
/** 입구 매핑이 채워도 되는 «엔진 소유» 문서인가(Codex #685 (a)): 신규 편입이거나, 세부모델이 엔진이 복사한 원문 차명 그대로이고 트림이 비어 있을 때만.
 * 사람이 고른 세부모델·트림이 있는 문서는 채우지 않으며, 그 값을 «엔진이 쓴 값»으로 기록하지도 않는다. */
const engineOwnedIdentity = (original: Fields, isNew: boolean, r: SourceProductRecord): boolean => {
  if (isNew) return true;
  const rawText = textOf((original.원문 as Fields | undefined)?.차명) || textOf(original.car_name) || textOf(r.vehicleText);
  return textOf(original.trim_name) === '' && (textOf(original.sub_model) === '' || (rawText !== '' && textOf(original.sub_model) === rawText));
};
/** 빈 제조사·모델 문서도 세부모델·트림을 사람이 입력했으면 엔진 보류가 아니다(Codex #704 (b)): 트림이 비어 있고 세부모델이 비었거나 엔진이 복사한 원문 차명 그대로일 때만. */
const engineCopiedIdentity = (f: Fields): boolean => {
  const rawText = textOf((f.원문 as Fields | undefined)?.차명) || textOf(f.car_name);
  return textOf(f.trim_name) === '' && (textOf(f.sub_model) === '' || (rawText !== '' && textOf(f.sub_model) === rawText));
};
export const engineIdentityHold = (f: Fields): boolean =>
  f.source_cycle_record !== undefined && f.source_cycle_record !== null && f.vehicle_review_required === true
  && ((!textOf(f.maker) && !textOf(f.model) && engineCopiedIdentity(f)) || filledByUs(f));
/** 제원 입구 매핑(대표 2026-10-16 «제원하고 모든 게 다 API 에 있을 거야»): 원천이 준 제원(색상·연료·최초등록·연식·주행거리·배기량)을 «기존 문서의 빈 칸에만» 채운다.
 * 지금까지는 새 문서에만 실렸다(sheetSpecFields). 기존 값(사람 입력 포함)은 비접촉 — 값이 다르면 덮어쓰지 않는다(불일치는 쓰지 않음). 짧은 문자열만(≤40자). */
export const SPEC_FILL_KEYS = ['ext_color', 'int_color', 'fuel_type', 'first_registration_date', 'year', 'mileage', 'engine_cc', 'seats'] as const;
const specBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
/** 차종 기준 한 장 제원 목록(연료): 가솔린·디젤·LPG·하이브리드·플러그인 하이브리드·전기·수소·가솔린+LPG. 목록 밖 표기(연료 코드 등)는 채우지 않는다. */
export const SPEC_FUEL_ALLOWED: ReadonlySet<string> = new Set(['가솔린', '디젤', 'LPG', '하이브리드', '플러그인 하이브리드', '전기', '수소', '가솔린+LPG']);
const ELECTRIC_FUELS: ReadonlySet<string> = new Set(['전기', '수소']);
/** 칸별 형식·단위 검증(Codex #688 ①): 숫자는 단위·쉼표 없는 정수 문자열만(2,497·2497cc 는 채우지 않음), 날짜·연식은 정해진 꼴만, 연료는 제원 목록 안에서만. */
/** 실제 달력 날짜(YYYY-MM 또는 YYYY-MM-DD, 윤년 포함): 2026-99-99·2026-02-31 은 최초등록일로 채우지 않는다(Codex #688 (b)). */
const realCalendarDate = (v: string): boolean => {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]);
  if (year < 1950 || year > 2100 || month < 1 || month > 12) return false;
  if (m[3] === undefined) return true;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  const day = Number(m[3]);
  return day >= 1 && day <= days;
};
const SPEC_VALID: Record<(typeof SPEC_FILL_KEYS)[number], (v: string) => boolean> = {
  // 색상은 원천 형식 규칙 하나를 따른다(자리표시자 «-»·«미정» 은 색이 아니다, 대표 2026-10-28 아이언).
  ext_color: v => SPEC_FORMAT_RULES.ext_color!(v),
  int_color: v => SPEC_FORMAT_RULES.int_color!(v),
  fuel_type: v => SPEC_FUEL_ALLOWED.has(v),
  first_registration_date: v => realCalendarDate(v),
  year: v => /^(19|20)\d{2}$/.test(v),
  mileage: v => /^\d{1,7}$/.test(v),
  engine_cc: v => /^\d{3,5}$/.test(v) && Number(v) >= 50,
  seats: v => /^\d{1,2}$/.test(v) && Number(v) >= 1,
};
/** 내장색 전용 완료 표식(Codex #697 비차단): 내장색이 채움 목록에 늘기 전에 제원 채움을 마친 문서(vehicle_spec_source_checked=true)는 내장색만 한 번 더 채운다 — 값이 없어도 표식을 남겨 되풀이하지 않는다. */
export const INT_COLOR_MARK = 'vehicle_int_color_source_checked';
export function intColorOnlyFields(spec: unknown, original: Fields): Fields {
  if (original[INT_COLOR_MARK] === true) return {};
  const v = spec && typeof spec === 'object' && !Array.isArray(spec) ? (spec as Record<string, unknown>).int_color : undefined;
  const out: Fields = { [INT_COLOR_MARK]: true };
  if (specBlank(original.int_color) && typeof v === 'string' && SPEC_VALID.int_color(v.trim())) out.int_color = v.trim();
  return out;
}
export function sourceSpecFillFields(spec: unknown, original: Fields, vehicleText?: unknown, masterFuel: string | null = null, masterSpecs: MasterSpecValues | null = null): Fields {
  if (original.vehicle_spec_source_checked === true) return {};   // 이미 확인한 문서는 다른 변경으로 갱신돼도 여기서는 다시 채우지 않는다(Codex #688 ④) — 빈 칸 다시 채움은 sourceSpecRefillFields
  const out: Fields = {};
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    const src = spec as Record<string, unknown>;
    for (const key of SPEC_FILL_KEYS) {
      const v = src[key];
      if (!specBlank(original[key]) || typeof v !== 'string') continue;
      // 연료는 별칭 표(domain/fuel-alias: 휘발유→가솔린, 가솔린+전기→하이브리드 …)로 표준 이름으로 바꾼 뒤에만 채운다(대표 2026-10-19).
      const value = key === 'fuel_type' ? canonicalFuel(v, vehicleText) : v.trim();
      if (value && SPEC_VALID[key](value)) out[key] = value;
    }
  }
  // 원천에 연료 원문이 없고 정체성이 마스터로 확정된 차: 계획이 고정한 마스터 연료(masterFuelFallback 를 거친 값)만 빈 연료 칸에 쓴다.
  if (specBlank(original.fuel_type) && out.fuel_type === undefined && masterFuel && SPEC_VALID.fuel_type(masterFuel)) out.fuel_type = masterFuel;
  // 원천에 그 칸 원문이 없고 마스터에 연결된 차: 계획이 고정한 마스터 제원(인승·구동방식·배기량, masterSpecFallback 를 거친 값)만 빈 칸에(원천 값이 이긴다).
  Object.assign(out, masterSpecFillValues(original, out, masterSpecs));
  // 전기·수소 차(문서 연료 또는 이번에 채울 연료)에는 배기량을 채우지 않는다 — 의미 충돌(Codex #688 ②).
  const fuel = typeof original.fuel_type === 'string' && original.fuel_type.trim() ? original.fuel_type.trim() : typeof out.fuel_type === 'string' ? out.fuel_type : '';
  if (ELECTRIC_FUELS.has(fuel)) delete out.engine_cc;
  return out;
}
/** 제원 확인 표식이 이미 있는 노출 문서의 «빈 제원 칸» 목록(대표 2026-10-19): 값이 있는 칸은 넣지 않는다. 전기·수소 문서의 배기량은 빈 칸이어도 넣지 않는다. */
export const specRefillKeysOf = (f: Fields): string[] =>
  SPEC_FILL_KEYS.filter(k => specBlank(f[k]) && !(k === 'engine_cc' && ELECTRIC_FUELS.has(String(f.fuel_type ?? '').trim())));
/** 확정 정체성(검토 끝남·제조사·모델·세부모델·세부트림 모두 있음)이고 연료가 빈 문서의 마스터 연료(vehicle_trim_master, 하나로 모일 때만). 아니면 null. */
export function masterFuelOf(f: Fields, trimFuel: VehicleIdentityRefiner['trimFuel'] | null | undefined): string | null {
  if (!trimFuel || !specBlank(f.fuel_type) || f.vehicle_review_required !== false) return null;
  const [maker, model, sub_model, trim_name] = [f.maker, f.model, f.sub_model, f.trim_name].map(textOf);
  if (!maker || !model || !sub_model || !trim_name) return null;
  const year = yearOf(f.year), cc = f.engine_cc === undefined || f.engine_cc === null ? '' : String(f.engine_cc).trim();
  return trimFuel({ maker, model, sub_model, trim_name, ...(year ? { year } : {}), ...(cc ? { engine_cc: cc } : {}) });
}
/** 빈 칸 다시 채움(대표 2026-10-19 «한 번만 채움» 표식 재검토): 확인 표식이 있는 문서라도 «문서 칸이 비어 있고 지금 원천에 형식 맞는 값이 있으면» 그 칸만 채운다.
 * 값이 있는 칸은 덮지 않는다. 원천에 연료가 없으면 마스터 연료(masterFuel)로. 판정은 계획과 같은 순수 함수(domain/spec-refill)를 쓴다. 표식은 바꾸지 않는다. */
export function sourceSpecRefillFields(spec: unknown, original: Fields, vehicleText?: unknown, masterFuel: string | null = null, masterSpecs: MasterSpecValues | null = null): Fields {
  if (original.vehicle_spec_source_checked !== true) return {};
  const out: Fields = { ...refillableSpecValues(spec, specRefillKeysOf(original), vehicleText, original.fuel_type) };
  if (specBlank(original.fuel_type) && out.fuel_type === undefined && masterFuel && SPEC_VALID.fuel_type(masterFuel)) {
    out.fuel_type = masterFuel;
    if (ELECTRIC_FUELS.has(masterFuel)) delete out.engine_cc;
  }
  // 마스터 제원(인승·구동방식·배기량): 원천 값으로 채우지 않은 빈 칸만, 최종 연료가 전기·수소면 배기량 제외(같은 순수 함수).
  return { ...out, ...masterSpecFillValues(original, out, masterSpecs) };
}
/** 확정 정체성(검토 끝남·제조사·모델·세부모델·세부트림)이고 마스터에 연결된(vehicle_master_id) 문서의 빈 인승·구동방식·배기량에 쓸 마스터 제원(트림 행이 하나로 모이는 칸만).
 * 전기·수소 문서의 배기량은 넣지 않는다. 채울 칸이 없으면 null. masterFuelOf 와 같은 자리에서 읽기 경로가 계산한다(대표 2026-10-22). */
export function masterSpecsOf(f: Fields, trimSpecs: VehicleIdentityRefiner['trimSpecs'] | null | undefined): MasterSpecValues | null {
  if (!trimSpecs || f.vehicle_review_required !== false) return null;
  const [maker, model, sub_model, trim_name, master_id] = [f.maker, f.model, f.sub_model, f.trim_name, f.vehicle_master_id].map(textOf);
  if (!maker || !model || !sub_model || !trim_name || !master_id) return null;
  const fuel = textOf(f.fuel_type);
  const blank = MASTER_SPEC_KEYS.filter(k => specBlank(f[k]) && !(k === 'engine_cc' && ELECTRIC_FUELS.has(fuel)));
  if (!blank.length) return null;
  const str = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
  const year = yearOf(f.year), cc = str(f.engine_cc), drive = str(f.drive_type), seats = str(f.seats);
  const found = trimSpecs({ maker, model, sub_model, trim_name, master_id, ...(year ? { year } : {}), ...(cc ? { engine_cc: cc } : {}),
    ...(fuel ? { fuel_type: fuel } : {}), ...(drive ? { drive_type: drive } : {}), ...(seats ? { seats } : {}) });
  const out: MasterSpecValues = {};
  for (const k of blank) if (masterSpecValid(k, found?.[k])) out[k] = found[k];
  return Object.keys(out).length ? out : null;
}
/** 입구 매핑(대표 2026-10-16 «제조사·모델이 안 옮겨진다»): 원천이 준 제조사·모델을 «빈 maker·model 에만» 채운다. 기존 값·사람 입력은 비접촉, 세부모델·트림은 건드리지 않는다.
 * 이번 회차에 마스터로 확정되면(identity) 마스터 이름이 이긴다. 원천에 값이 없으면 표식(ABSENT)만 남겨 되풀이를 막는다. 기본 꺼짐(운영 변수로 공급사별). */
/** 모델 키: 공백·대소문자·전각 차이만 무시(괄호·세대·수식어는 지우지 않는다 — 일치하지 않으면 마스터에 없는 이름이다). */
const modelKey = (v: unknown): string => textOf(v).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
/** 마스터 모델 목록(제조사 → 키 → «정식 모델 이름»). 정식 이름은 자기 자신으로, 등록된 별칭은 정식 이름으로 변환한다. */
export type SourceModels = ReadonlyMap<string, ReadonlyMap<string, string>>;
export const sourceModelsOf = (models: Readonly<Record<string, readonly string[]>> | undefined,
  aliases?: Readonly<Record<string, Readonly<Record<string, string>>>>): SourceModels | null => {
  if (!models) return null;
  const out = new Map<string, Map<string, string>>();
  for (const [maker, names] of Object.entries(models)) {
    const byKey = new Map<string, string>();
    for (const name of [...names].sort()) if (modelKey(name) && !byKey.has(modelKey(name))) byKey.set(modelKey(name), textOf(name));   // 같은 키의 정식 이름이 둘이면 정렬 첫 번째로 고정
    // 별칭: 정식 이름(저장된 값)으로 변환한다(별칭 대상 표기가 대소문자만 달라도 정식 값을 쓴다). 같은 별칭 키가 서로 다른 정식으로 가면 제외(모호).
    const aliasTargets = new Map<string, Set<string>>();
    for (const [alias, canonical] of Object.entries(aliases?.[maker] ?? {})) {
      const canon = byKey.get(modelKey(canonical));
      if (!modelKey(alias) || !canon || byKey.has(modelKey(alias))) continue;
      (aliasTargets.get(modelKey(alias)) ?? aliasTargets.set(modelKey(alias), new Set<string>()).get(modelKey(alias))!).add(canon);
    }
    for (const [aliasKey, targets] of aliasTargets) if (targets.size === 1) byKey.set(aliasKey, [...targets][0]!);
    out.set(maker.trim(), byKey);
  }
  return out;
};
/** 원천 모델 표기의 «정식 마스터 모델 이름»(없으면 null). */
const canonicalModel = (models: SourceModels | null, maker: unknown, model: unknown): string | null =>
  !models || !modelKey(model) ? null : models.get(textOf(maker))?.get(modelKey(model)) ?? null;
/** 입구 매핑이 이미 쓴 모델이 마스터 모델 이름이 아니면(괄호·세대·«신형/더 뉴» 수식어 등) 되돌려야 하는가(대표 2026-10-16 «마스터가 작동을 안 한다»):
 * 채움 그대로(표식·세 값 일치·트림 빈칸)이고 마스터 목록을 읽었고 모델이 목록에 없을 때만. 사람 입력·마스터 정제로 확정된 값은 해당 없음. */
export const sourceModelRevertDue = (f: Fields, models: SourceModels | null): boolean =>
  // 되돌리기는 «검토 필요 true 이면서 채움 기록과 현재 값이 같을 때만»(사람이 값을 승인하고 검토를 끝낸 문서는 보존, Codex #706 ②).
  !!models && f.vehicle_review_required === true && f.vehicle_maker_model_source === SOURCE_FIELDS_MARK && filledByUs(f) && !!textOf(f.model)
  && canonicalModel(models, f.maker, f.model) !== textOf(f.model);
export function sourceIdentityFields(r: SourceProductRecord, original: Fields, refinedThisCycle: boolean, makers: ReadonlySet<string> | null = null, subModelAtFill = '',
  models: SourceModels | null = null): Fields {
  if (refinedThisCycle) return {};
  // 이미 쓴 모델이 마스터 이름이 아니면 모델만 비운다(제조사·세부모델·표식은 그대로, 정제 대기).
  if (sourceModelRevertDue(original, models)) {
    const filled = original.vehicle_maker_model_filled as { maker?: unknown; sub_model?: unknown };
    const canonical = canonicalModel(models, original.maker, original.model) ?? '';   // 등록된 별칭이면 정식 이름으로, 아니면 비움
    return { model: canonical, vehicle_maker_model_filled: { maker: textOf(filled.maker), model: canonical, sub_model: textOf(filled.sub_model) } };
  }
  if (textOf(original.maker) || textOf(original.model)) return {};
  if (original.vehicle_maker_model_source !== undefined && original.vehicle_maker_model_source !== null) {
    // 이미 시도했다. 원천 값이 바뀌었으면 표식이 SOURCE_FIELDS 인 문서에 한해 갱신(사람·마스터가 채운 문서는 위에서 걸러짐).
    if (original.vehicle_maker_model_source !== SOURCE_FIELDS_MARK) return {};
  }
  const maker = textOf(r.raw?.source_maker), model = textOf(r.raw?.source_model);
  if (!maker && !model) return original.vehicle_maker_model_source === undefined || original.vehicle_maker_model_source === null ? { vehicle_maker_model_source: 'ABSENT' } : {};
  // 제조사는 활성 차종 마스터에 «있는 표기»일 때만 채운다(옛 표기 르노삼성 등이 maker 에 들어가 교정 대상에서 빠지는 것을 막는다, Codex #685 (c)).
  // 마스터를 못 읽었거나(목록 없음) 마스터에 없는 표기면 채우지 않고 표식(UNMAPPED)만 남긴다 — 마스터에 제조사가 생긴 뒤의 재시도는 별도 승인(표식 초기화).
  if (!makers || !maker || !makers.has(maker)) return original.vehicle_maker_model_source === undefined || original.vehicle_maker_model_source === null ? { vehicle_maker_model_source: 'UNMAPPED' } : {};
  // 모델은 마스터 모델 이름(별칭 포함)과 일치할 때만 쓴다 — 괄호·세대·«신형/더 뉴/디 올뉴» 수식어가 든 원천 표기는 쓰지 않고 정제 대기로 둔다(마스터 목록이 없으면 쓰지 않음).
  const writeModel = canonicalModel(models, maker, model) ?? '';
  return { maker, model: writeModel, vehicle_maker_model_source: SOURCE_FIELDS_MARK, vehicle_maker_model_filled: { maker, model: writeModel, sub_model: subModelAtFill } };
}
const yearOf = (v: unknown): string => { const m = /^(\d{4})/.exec(typeof v === 'number' ? String(v) : textOf(v)); return m ? m[1]! : ''; };
const specOf = (r: SourceProductRecord | undefined): Fields => {
  const spec = r?.raw?.spec;
  return spec && typeof spec === 'object' && !Array.isArray(spec) ? spec as Fields : {};
};
/** 대조에 쓰는 연식: 문서 연식 → 원천 연식 → 문서 최초등록 연도 → 원천 최초등록 연도(계획서 생성기 입력과 같은 뜻: 연식 또는 최초등록 연도). */
export const identityYear = (f: Fields, r?: SourceProductRecord): string =>
  yearOf(f.year) || yearOf(specOf(r).year) || yearOf(f.first_registration_date) || yearOf(specOf(r).first_registration_date);
/** 대조에 쓰는 최초등록일(세대가 겹치는 해를 등록월로 가른다): 문서 최초등록일 → 원천 최초등록일. «YYYY-MM» 이상일 때만, 아니면 ''. */
export const identityFirstRegistration = (f: Fields, r?: SourceProductRecord): string => {
  for (const v of [f.first_registration_date, specOf(r).first_registration_date]) if (typeof v === 'string' && /^\d{4}-\d{2}(?![0-9])/.test(v.trim())) return v.trim();
  return '';
};
const withRegistration = (f: Fields, r?: SourceProductRecord) => { const v = identityFirstRegistration(f, r); return v ? { firstRegistration: v } : {}; };
/** 대조에 쓰는 원천 차명: 이번에 쓸 차명(car_name) → 없으면 편입 때 남긴 원문 차명. 목록(envelope)과 쓰기(nativeCycleFields)가 같은 값을 보게 한다. */
const identityRawName = (carName: unknown, f: Fields): string => textOf(carName) || textOf((f.원문 as Fields | undefined)?.차명);
/** 마스터로 하나로 특정된 정체성 칸. 원문(원문.차명)은 건드리지 않는다. 세부트림은 하나로 특정됐고 문서 세부트림이 비어 있을 때만,
 * 연식은 기존 문서에 없고 원천이 연식을 줄 때만(새 문서는 원천 사실 칸이 이미 싣는다). */
function identityFields(id: VehicleIdentityRefinement, original: Fields, r: SourceProductRecord, isNew: boolean): Fields {
  const sourceYear = yearOf(specOf(r).year);
  return { maker: id.maker, model: id.model, sub_model: id.sub_model,
    ...(id.trim_name && !textOf(original.trim_name) ? { trim_name: id.trim_name } : {}),
    vehicle_review_required: false, vehicle_title_source: 'MASTER_MATCH', vehicle_master_id: id.master_id,
    ...(!isNew && !yearOf(original.year) && sourceYear ? { year: sourceYear } : {}) };
}
function envelope(d: Doc, acceptDrift: ReadonlySet<string> = new Set(), drifted?: string[], heldDrift?: string[], writeMonthlyProductType = false,
  identity: VehicleIdentityRefiner | null = null, writeApiOptions = false, sourceIdentitySources: ReadonlySet<string> | null = null, sourceModels: SourceModels | null = null,
  specSources: ReadonlySet<string> | null = sourceIdentitySources, trimFuel: VehicleIdentityRefiner['trimFuel'] | null = null,
  provenanceUids: ReadonlySet<string> = new Set(), reviewedApprovals: ReadonlyMap<string, ReviewedSpecApproval> = new Map(),
  trimSpecs: VehicleIdentityRefiner['trimSpecs'] | null = null): CycleProduct {
  const f = decodeFields(d.fields), uid = decodeURIComponent(d.name.split('/').at(-1)!);
  const record = (f.source_cycle_record ?? productRecord(uid, f, legacyObservedAt(f, d.updateTime))) as SourceProductRecord;
  if (record.uid !== uid || record.sourceId !== f.provider_company_code) throw new Error('CATALOG_IDENTITY_INVALID');
  if (f.source_cycle_record) {
    if (!priceMatchesRecord(f.price, f.source_cycle_price_digest, record) || f.car_number !== record.plate) {
      const plateSame = f.car_number === record.plate;
      if (acceptDrift.has(String(f.provider_company_code)) && plateSame) {
        // 승인된 외부 보정(예: 정책 보증금)을 코드별 명시 옵션으로만 받아들인다.
        const current = productRecord(uid, f, record.observedAt);
        record.terms = current.terms; drifted?.push(uid);
      } else if (heldDrift && plateSame) {
        // 가격만 다른 문서는 목록 조립 단계에서 전체를 막지 않고 UID 만 표시한다. 계획이 그 문서를 실제로 쓰게 될 때만 막는다.
        heldDrift.push(uid);
      } else throw new Error('CATALOG_SOURCE_RECORD_DRIFT');   // 번호판 불일치와 쓰기 단계(read·backup)는 항상 DRIFT
    }
  }
  // 판매 가격 칸에 소비처가 읽는 옵션 키(개월_연·월N km)가 빠진 노출 문서: 값은 같아도 한 번 다시 써서 키를 채운다(되풀이되지 않음).
  const expectedOptionKeys = Object.keys(salePriceMap(record.terms)).filter(k => k.includes('_'));
  const engineOwned = f.listable === true && f.source_cycle_record !== undefined;
  const rewriteReasons: NonNullable<CycleProduct['rewriteReasons']> = [];
  if (engineOwned && expectedOptionKeys.some(k => !(f.price && typeof f.price === 'object' && k in (f.price as Record<string, unknown>)))) rewriteReasons.push('PRICE_LAYOUT');
  // 저장된 status_kind 가 저장된 vehicle_status 의 계약 값과 다른 노출 문서(검토된 상태만): 쓰면 표시 상태·status_kind 가 함께 맞춰져 되풀이되지 않는다.
  const storedKind = resolveErp5InventoryStatus(f.vehicle_status);
  if (engineOwned && storedKind.known && f.status_kind !== storedKind.statusKind) rewriteReasons.push('STATUS_KIND');
  // 월렌트 모델 문서의 상품 구분(product_type «월렌트»): 중앙 어휘 확장이 합쳐진 뒤 SOURCE_CYCLE_WRITE_MONTHLY_PRODUCT_TYPE=1 일 때만 켠다.
  if (engineOwned && writeMonthlyProductType && f.product_group === 'MONTHLY_RENT' && f.product_type !== MONTHLY_PRODUCT_TYPE) rewriteReasons.push('PRODUCT_TYPE');
  // 오토플러스(RP023)는 상품 구분이 정책으로 «오플구독» 하나다. 구분이 빈 노출 문서는 한 번 다시 써서 채운다(되풀이되지 않음).
  if (engineOwned && f.provider_company_code === 'RP023' && !(typeof f.product_type === 'string' && f.product_type.trim())) rewriteReasons.push('PRODUCT_TYPE');
  // 손오공 API 사진(대표 10-15): 사진이 하나도 없는 노출 문서인데 저장 기록에 API 사진 주소가 있으면 한 번 다시 써서 image_urls 를 채운다.
  // 쓰면 image_urls 가 생겨 되풀이되지 않는다. 사진 목록이 같은 문서는 이 사유 없이는 다시 쓰지 않는다(일괄 UPDATE 없음).
  if (engineOwned && PHOTO_URL_LIST_SOURCES.has(String(f.provider_company_code)) && !hasAnyPhoto(f) && recordHasPhotoUrls(record)) rewriteReasons.push('PHOTO_URLS');
  // 손오공 API 옵션(대표 10-15 승인): 옵션 확인 표식(api_options_state)이 한 번도 없던 노출 문서는 한 번 다시 써서 칸을 채운다.
  // 쓰면 표식이 생겨 되풀이되지 않는다(상세가 없으면 NO_DETAIL 표식). 회차당 상한은 계획 단계(API_OPTIONS_DEFERRED)가 건다.
  // 대표 승인 전에는 쓰지 않는다(기본 꺼짐): 운영 변수 SOURCE_CYCLE_WRITE_API_OPTIONS=1 일 때만 켠다(월렌트 상품 구분과 같은 방식).
  // 입구 매핑: 제조사·모델이 비어 있고 표식이 없는 노출 문서는 한 번 다시 써서 원천 brand·model 을 채운다(쓰면 표식이 생겨 되풀이되지 않음). 기본 꺼짐·공급사별 허용.
  if (sourceIdentitySources && sourceIdentitySources.has(String(f.provider_company_code)) && engineOwned && f.vehicle_review_required === true
    && !textOf(f.maker) && !textOf(f.model) && (f.vehicle_maker_model_source === undefined || f.vehicle_maker_model_source === null)
    && engineOwnedIdentity(f, false, record)) rewriteReasons.push('SOURCE_IDENTITY');   // 선정에도 같은 소유 검사: 사람이 세부모델·트림을 입력한 행은 사유 자체를 주지 않는다(되풀이 쓰기 방지)
  // 이미 쓴 모델이 마스터 모델 이름이 아니면(괄호·세대·수식어) 모델만 비우는 되돌리기: 채움 그대로인 문서에만, 같은 사유·같은 회차 상한(되풀이 없음: 비우면 조건이 거짓).
  else if (sourceIdentitySources && sourceIdentitySources.has(String(f.provider_company_code)) && engineOwned && sourceModelRevertDue(f, sourceModels) && engineOwnedIdentity(f, false, record)) rewriteReasons.push('SOURCE_IDENTITY');   // 선정에도 쓰기와 같은 소유 검사(선정만 되고 안 써져 되풀이되는 일 방지)
  // 제원 입구 매핑: 제원 칸이 비어 있고 확인 표식(vehicle_spec_source_checked)이 없는 노출 문서는 한 번 다시 써서 원천 제원을 채운다. 옛 저장 기록은 제원이 digest 라
  // 기록만으로는 알 수 없으므로 문서 상태와 표식으로 정한다 — 표식을 항상 쓰므로(채울 값이 없어도) 되풀이되지 않는다. 같은 허용 공급사·회차 상한을 쓴다.
  // 제원 채움 공급사(specSources): 입구 매핑 공급사 + 제원 채움만 켠 공급사(SOURCE_CYCLE_SPEC_FILL_SOURCES).
  const specAllowed = !!specSources && specSources.has(String(f.provider_company_code)) && engineOwned;
  const lockedNow = isContractLockValue(f.locked_by_contract) || ((f.status === '계약중' || f.status_kind === '계약중') && !engineWroteContracted(f, record));
  // Opt-in exact UID repair through the existing fresh-source plan/CAS/backup writer. No record alone proves current provenance.
  if (provenanceUids.has(uid) && engineOwned && !lockedNow && record.raw.source === 'shared-sheet'
    && f.source_cycle_write == null && !f.publication_withdrawal && !f._deleted && !f.deletedAt
    && !['RP012', 'RP031'].includes(record.sourceId)) rewriteReasons.push('SOURCE_PROVENANCE');
  const reviewedSpec = engineOwned && !lockedNow && f.listable === true && !f.publication_withdrawal && !f._deleted && !f.deletedAt
    ? reviewedSpecOf(uid, f, reviewedApprovals.get(uid)) : undefined;
  let specRefillKeys: string[] = [];
  if (specAllowed
    && (f.vehicle_spec_source_checked === undefined || f.vehicle_spec_source_checked === null)
    && SPEC_FILL_KEYS.some(k => specBlank(f[k]) && !(k === 'engine_cc' && ELECTRIC_FUELS.has(String(f.fuel_type ?? '').trim())))) rewriteReasons.push('SOURCE_SPEC');
  // 제원 확인을 이미 마친 문서의 내장색 보완(내장색 전용 표식으로 문서당 한 번 — 저장 기록은 제원이 digest 라 원천에 내장색이 있는지는 쓰기 때 현재 관측으로 정한다).
  else if (specAllowed && f.vehicle_spec_source_checked === true
    && f[INT_COLOR_MARK] !== true && specBlank(f.int_color)) rewriteReasons.push('SOURCE_SPEC');
  // 확인 표식이 있는 문서의 빈 칸 다시 채움(대표 2026-10-19): 빈 칸 목록만 실어 두고, 이번 관측 원천에 형식 맞는 값이 있는지는 계획이 정한다(domain/spec-refill).
  // 원천에 연료가 없어도 정체성이 확정된 차는 마스터 연료가 하나로 모이면 그 자체가 채울 근거다(쓰면 연료가 생겨 되풀이되지 않음). 계약 잠금 문서는 제외.
  else if (specAllowed && f.vehicle_spec_source_checked === true && !lockedNow) specRefillKeys = specRefillKeysOf(f);
  if (reviewedSpec) specRefillKeys = [...new Set([...specRefillKeys, ...Object.keys(reviewedSpec.values)])];
  // 정체성이 확정된 연료 빈 문서의 마스터 연료(하나로 모일 때만). 값을 읽기 경로에 실어 계획 digest·백업 대조에 고정한다 — 계획 뒤 마스터 연료가 바뀌면 백업 대조가 멈춘다(Codex 검토).
  // 쓸지 말지는 계획이 이번 관측 원천에 연료 원문이 «없을 때만» 정한다(masterFuelFallback).
  const specMasterFuel = specAllowed && !lockedNow ? masterFuelOf(f, trimFuel) : null;
  // 마스터 제원(인승·구동방식·배기량, 대표 2026-10-22): 같은 자리·같은 고정 방식. 쓸지 말지는 계획이 원천에 그 칸 원문이 «없을 때만» 정한다(masterSpecFallback).
  const specMasterSpecs = specAllowed && !lockedNow ? masterSpecsOf(f, trimSpecs) : null;
  if (writeApiOptions && engineOwned && f.provider_company_code === 'RP012' && (f.api_options_state === undefined || f.api_options_state === null)) rewriteReasons.push('API_OPTIONS');
  // 이안카(RP031) 노출 문서에 공급사 차량 ID(iancar_one_vehicle_id)가 없으면 사진·정책 연결이 그 문서를 못 쓴다. 한 번 다시 써서 채운다(되풀이되지 않음).
  if (engineOwned && f.provider_company_code === 'RP031' && !(typeof f.iancar_one_vehicle_id === 'string' && f.iancar_one_vehicle_id.trim())
    && typeof record.raw?.vehicle_id === 'string' && record.raw.vehicle_id.trim()) rewriteReasons.push('IANCAR_VEHICLE_ID');
  // 공급사 기본 정책 연결(대표 2026-10-22): 정책이 비어 있는 엔진 노출 문서에만, 규칙 표(단일 근거)에 있는 공급사의 기본 정책 코드를 연결한다.
  // 쓰면 policy_code 가 채워져 사유가 사라진다(되풀이되지 않음). 계약 잠금 문서·이미 정책이 있는 문서·월렌트 모델 줄(MONTHLY_RENT, 장기 정책과 다를 수 있다)은 대상이 아니다. 신규 편입은 공급사 기본값 그대로 들어오고 다음 회차에 연결된다.
  const policyLinkCode = engineOwned && !lockedNow && f.product_group !== 'MONTHLY_RENT' ? policyLinkCodeFor(f.provider_company_code, f.policy_code) : null;
  // 빈 photo_link 표시(F05 공통시트 문서만, 대표 2026-10-22): 계획이 이번 관측 원천의 차량번호 칸 사진 폴더 링크가 있을 때만 PHOTO_LINK 로 쓴다(되풀이 없음: 쓰면 칸이 찬다).
  const photoLinkFill = engineOwned && !lockedNow && record.raw?.source === 'shared-sheet' && !f.publication_withdrawal ? photoLinkFillState(f) : null;
  if (policyLinkCode) rewriteReasons.push('POLICY_LINK');
  // 정체성 보류 문서(엔진 편입, 제조사·모델 빈칸, 검토 필요)가 이번 회차 차종 마스터로 «하나로» 특정되면 한 번 다시 써서 이름을 채운다.
  // 쓰면 제조사·모델이 채워지고 검토 필요가 풀려 조건이 거짓이 된다(되풀이되지 않음). 특정되지 않으면 사유가 없어 일괄 UPDATE 도 없다.
  if (engineOwned && identity && engineIdentityHold(f) &&
    identity.match({ rawName: identityRawName(f.car_name, f), year: identityYear(f, record), ...withRegistration(f, record) })) rewriteReasons.push('VEHICLE_IDENTITY');
  // 정체성 보류 노출 문서 표시(계획이 시트 차종 후보 정제 대상을 고를 때 쓴다).
  const identityHold = engineOwned && !f.publication_withdrawal && engineIdentityHold(f) ? { year: identityYear(f, record) } : null;
  return { record, ...(reviewedSpec ? { reviewedSpec } : {}), ...(rewriteReasons.length ? { rewriteReasons } : {}), ...(specRefillKeys.length ? { specRefillKeys } : {}), ...(specMasterFuel ? { specMasterFuel } : {}), ...(specMasterSpecs ? { specMasterSpecs } : {}), ...(policyLinkCode ? { policyLinkCode } : {}),
    ...(photoLinkFill ? { photoLinkFill } : {}), ...(identityHold ? { identityHold } : {}),
    ...(typeof f.provider_name === 'string' && f.provider_name.trim() ? { supplierFields: {
    provider_name: f.provider_name, policy_code: typeof f.policy_code === 'string' ? f.policy_code : null } } : {}), listable: f.listable === true,
    locked_by_contract: isContractLockValue(f.locked_by_contract) || ((f.status === '계약중' || f.status_kind === '계약중') && !engineWroteContracted(f, record)),
    publication_withdrawal: (f.publication_withdrawal ?? null) as CycleProduct['publication_withdrawal'],
    publication_withdrawal_prior: (f.publication_withdrawal_prior ?? null) as CycleProduct['publication_withdrawal_prior'],
    ...(typeof (f.supplier_confirmed_sold as { record_observed_at?: unknown } | undefined)?.record_observed_at === 'string'
      ? { supplierConfirmedSold: { recordObservedAt: (f.supplier_confirmed_sold as { record_observed_at: string }).record_observed_at } } : {}) };
}
/** 표시 상태가 정하는 status_kind (ERP5 재고 계약표). 예전에는 노출이면 무조건 «가용» 이어서 계약중·상품화중 문서가 계약 검사의
 * status_kind 드리프트로 잡혔다(2026-10-13 발행 단계 33건). 검토되지 않은 상태는 «불가»(fail-closed, 독립 검토 2026-10-14): 가용으로 추정해 노출하지 않는다. */
export const MONTHLY_PRODUCT_TYPE = '월렌트';
/** 손오공 공식 API 탭 → 상품 구분: rent=중고렌트, sub=오공구독, pick=픽업구독(소비처 구독 표시 규칙의 고정 어휘). */
export const SONOGONG_PRODUCT_TYPES: ReadonlySet<string> = new Set(['중고렌트', '오공구독', '픽업구독']);
export const IRON_PRODUCT_TYPES: ReadonlySet<string> = new Set(['신차렌트', '중고렌트']);
/** 그 밖의 원천(F05 계열·아이카·오토플러스 등)의 상품 구분: 어댑터가 원천 자기 칸(상품구분/구분)이나 고정 정책에서 읽어 raw.product_type 에 둔 값이
 * 중앙 어휘(erp5-product-mapping 의 상품 구분)일 때만, 그리고 기존 문서에 구분이 «비어 있을 때만» 채운다. 기존 값은 덮어쓰지 않는다. */
export const COMMON_PRODUCT_TYPES: ReadonlySet<string> = new Set(['신차렌트', '중고렌트', '재렌트', '신차구독', '중고구독', '재구독', '오공구독', '픽업구독', '오플구독']);export const statusKindOf = (display: string, listable: boolean) =>
  !listable ? '불가' : (() => { const r = resolveErp5InventoryStatus(display); return r.known ? r.statusKind : PROVIDER_AVAILABLE_STATUS_LABELS.has(display) ? '가용' : '불가'; })();
/** 공급사 시트가 주는 차 한 대 사실(색상·연료·최초등록·연식·주행거리)을 «새 문서»에만 싣는다. 허용 키·짧은 문자열만 통과한다(기존 문서는 건드리지 않는다). */
const SHEET_SPEC_KEYS = ['ext_color', 'fuel_type', 'first_registration_date', 'year', 'mileage'] as const;
export const sheetSpecFields = (spec: unknown): Fields => {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return {};
  const out: Fields = {};
  for (const key of SHEET_SPEC_KEYS) {
    const v = (spec as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim() && v.length <= 40) out[key] = v.trim();
  }
  return out;
};
/** 공급사 정책 계산 보증금 표식(정제 표 domain/supplier-deposit-policy — RP023·RP012, 대표 2026-10-14 «값이 숫자로 존재하거나 산출식으로 존재한다»).
 * 항(개월)마다 규칙 코드를 deposit_rules[개월] 에 쓴다 — 판매 가격 칸(price[개월])과 같은 대표 항에서 만들어 가격과 항상 짝이 맞는다(문서 단위 표식이면
 * 원문 금액 항과 계산 항이 섞이거나 탭이 바뀐 뒤 낡은 표식이 남는다). 계산 항이 없으면 null 로 지운다. 옛 문서 단위 deposit_rule(#642)도 null 로 지운다.
 * 정제 대상이 아닌 공급사는 아무것도 쓰지 않는다. 가격을 새로 쓸 때만 함께 쓴다(nativeCycleFields). */
export const calculatedDepositFields = (r: SourceProductRecord): Fields => {
  if (!hasSupplierDepositPolicy(r.sourceId)) return {};
  const rules: Record<string, string> = {};
  for (const t of representativeTerms(r.terms)) {
    const code = t.deposit.state === 'KNOWN' ? supplierDepositRuleFor(r.sourceId, t.raw?.deposit_rule) : null;
    if (code) rules[String(t.months)] = code;
  }
  const any = Object.keys(rules).length > 0;
  return { deposit_source: any ? 'CALCULATED' : null, deposit_rules: any ? rules : null, deposit_rule: null };
};
/** 이안카(RP031) 공급사 차량 ID 칸. 사진 경로(isPublicIancarPhotoProduct)·정책 연결이 이 칸으로 원천 차량을 찾는다.
 * 원천 기록의 vehicle_id 를 쓴다: 문서에 없으면 채우고, 같으면 그대로. 같은 번호 문서에 «다른» ID 가 이미 있으면 덮어쓰지 않는다(공급사 신원 충돌 —
 * 기존 ID 에 묶인 사진·정책·보증금 근거가 다른 차로 옮겨 가지 않게). 충돌은 iancar_one_vehicle_id_conflict 에 관측 ID 와 시각으로 남겨 사람이 본다. */
export function iancarVehicleIdFields(r: SourceProductRecord, original: Fields): Fields {
  if (r.sourceId !== 'RP031') return {};
  const incoming = typeof r.raw?.vehicle_id === 'string' ? r.raw.vehicle_id.trim() : '';
  if (!incoming) return {};
  const stored = typeof original.iancar_one_vehicle_id === 'string' ? original.iancar_one_vehicle_id.trim() : '';
  const hadConflict = original.iancar_one_vehicle_id_conflict !== undefined && original.iancar_one_vehicle_id_conflict !== null;
  if (stored && stored !== incoming) return { iancar_one_vehicle_id_conflict: { observed: incoming, at: r.observedAt } };
  return { iancar_one_vehicle_id: incoming, ...(hadConflict ? { iancar_one_vehicle_id_conflict: null } : {}) };
}
const sheetOf = (r: SourceProductRecord): { sheet?: SheetIdentity } => { const s = validSheetIdentity(r.raw?.sheet_identity); return s ? { sheet: s } : {}; };
/** 계약 잠금 문서에 쓸 수 있는 칸의 고정 허용 목록(대표 2026-10-22): 이름 4칸 + 검토 필요 표식. 계약·금액·상태·잠금·원천 기록은 여기 없다. */
export const IDENTITY_ONLY_FIELDS = ['maker', 'model', 'sub_model', 'trim_name', 'vehicle_review_required'] as const;
export function nativeCycleFields(p: CycleProduct, original: Fields = {}, opts: { writeMonthlyProductType?: boolean; identity?: VehicleIdentityRefiner | null; writeApiOptions?: boolean; sourceIdentitySources?: ReadonlySet<string> | null; sourceMakers?: ReadonlySet<string> | null; sourceModels?: SourceModels | null;
  /** 시트 사실 빈 칸 채움(구동방식·원산지): 켠 공급사 코드와 켠 칸. 둘 다 있을 때만 쓴다(기본 꺼짐). */ sheetFactSources?: ReadonlySet<string> | null; sheetFactKeys?: readonly SheetFactKey[];
  /** 제원 채움 공급사(입구 매핑 공급사 + 제원만 켠 공급사). 없으면 sourceIdentitySources 와 같다. */ specFillSources?: ReadonlySet<string> | null;
  } = {}): Fields {
  const r = p.record;
  if (p.identityOnly === true) {
    const match = opts.identity && p.refineIdentity === true && engineIdentityHold(original)
      ? opts.identity.match({ rawName: identityRawName(r.vehicleText, original), year: identityYear(original, r), ...withRegistration(original, r), ...(p.sheetIdentity ? { sheet: p.sheetIdentity } : sheetOf(r)) }) : null;
    if (!match) return {};
    const all = identityFields(match, original, r, false);
    return Object.fromEntries(IDENTITY_ONLY_FIELDS.filter(k => k in all).map(k => [k, all[k]]));
  }
  const isNew = !Object.keys(original).length;
  const specSources = opts.specFillSources === undefined ? opts.sourceIdentitySources : opts.specFillSources;
  const specFill = !!specSources?.has(r.sourceId) && p.fillSourceIdentity === true;
  // 마스터 연료는 계획이 검증·압축 전 원문으로 판정해 고정한 값(after.specMasterFuel)만 쓴다 — 쓰기 시점에 다시 계산·판정하지 않는다(Codex 검토).
  const masterFuel = specFill && !isNew && typeof p.specMasterFuel === 'string' && p.specMasterFuel ? p.specMasterFuel : null;
  // 마스터 제원도 같다: 계획이 고정한 after.specMasterSpecs 만 쓴다(쓰기 시점에 다시 조회·판정하지 않는다).
  const masterSpecs = specFill && !isNew && p.specMasterSpecs && typeof p.specMasterSpecs === 'object' ? p.specMasterSpecs : null;
  // 정체성 정제: 새 문서이거나 엔진 정체성 보류 문서일 때만, 차종 마스터로 하나로 특정되면 마스터 이름을 쓴다. 아니면 지금처럼 원문 차명·검토 필요.
  // 기존 문서의 하향·철회(after 가 노출 안 함·철회 표식)에는 정체성 정제를 섞지 않는다(Codex #704 (c)): 철회 작업이 이름까지 바꾸지 않게.
  const withdrawing = !isNew && (!p.listable || (p.publication_withdrawal !== null && p.publication_withdrawal !== undefined));
  // 기존 문서는 계획이 양성 표식(refineIdentity)을 준 항목만 정제한다 — 이미 쓰는 문서(가격 변경·재노출)가 회차 상한을 우회하지 못한다(Codex #704 잔여). 신규 편입은 편입 상한이 건다.
  const identity = opts.identity && !withdrawing && (isNew || (p.refineIdentity === true && engineIdentityHold(original)))
    ? opts.identity.match({ rawName: identityRawName(r.vehicleText, original), year: identityYear(original, r), ...withRegistration(original, r), ...sheetOf(r) }) : null;
  const rawDisplay = String(r.raw.sourceCycleDisplayStatus ?? ({ AVAILABLE: '출고가능', PREPARING: '출고가능', 게시: '출고가능' } as Record<string, string>)[r.status.raw] ?? r.status.raw);
  const display = ({ 배차문의: '출고협의', 수리중: '상품화중' } as Record<string, string>)[rawDisplay] ?? rawDisplay;
  // fail-closed(독립 검토 BLOCK): 검토된 어휘에 없는 상태는 «가용» 으로 추정해 노출하지 않는다. 플러그인이 먼저 보류하므로 여기 오는 일은 드물다.
  const listable = p.listable && (resolveErp5InventoryStatus(display).known || PROVIDER_AVAILABLE_STATUS_LABELS.has(display));
  const price = !p.listable && original.price ? original.price :
    salePriceMap(r.terms);
  return { car_number: r.plate, provider_company_code: r.sourceId, car_name: r.vehicleText,
    ...(isNew ? { ...p.supplierFields, maker: '', model: '', sub_model: r.vehicleText, trim_name: '', vehicle_review_required: true, vehicle_title_source: 'RAW_VEHICLE_TEXT',
      원문: { 차명: r.vehicleText, source: r.raw }, ...(opts.sourceIdentitySources?.has(r.sourceId) || specSources?.has(r.sourceId) ? {} : sheetSpecFields(r.raw.spec)) } : {}),
    ...(identity ? identityFields(identity, original, r, isNew) : {}),
    price, source_cycle_price_digest: priceDigest(price),
    ...(price === original.price ? {} : calculatedDepositFields(r)),
    listable, status: listable ? display : '출고불가', status_kind: statusKindOf(display, listable),
    vehicle_status: listable ? display : '출고불가', source: original.source ?? r.raw.source ?? 'source-cycle',
    source_tab: r.raw.source_tab ?? null, source_row: r.raw.source_row ?? null,
    ...(r.raw.product_group ? { product_group: r.raw.product_group } : {}),
    ...(opts.writeMonthlyProductType === true && r.raw.product_group === 'MONTHLY_RENT' ? { product_type: MONTHLY_PRODUCT_TYPE } : {}),
    // 손오공 상품 구분(구독·픽업구독 화면 표시, 기존 구독 상품 규칙 재사용): 어댑터가 탭에서 정한 값이 고정 어휘일 때만 쓴다.
    ...(r.sourceId === 'RP012' && typeof r.raw.product_type === 'string' && SONOGONG_PRODUCT_TYPES.has(r.raw.product_type) ? { product_type: r.raw.product_type } : {}),
    // 아이언 홈페이지: 신차렌트·중고렌트(목록 condition 에서 정함). 다른 원천처럼 기존 문서에 구분이 «비어 있을 때만» 채운다 — 목록 분류로
    // 사람이 정한 구분(재렌트 등)을 매 회차 덮어쓰지 않는다(2026-10-14).
    ...(r.sourceId === 'RP006' && typeof r.raw.product_type === 'string' && IRON_PRODUCT_TYPES.has(r.raw.product_type)
      && !(typeof original.product_type === 'string' && original.product_type.trim()) ? { product_type: r.raw.product_type } : {}),
    ...(r.sourceId !== 'RP012' && r.sourceId !== 'RP006' && typeof r.raw.product_type === 'string' && COMMON_PRODUCT_TYPES.has(r.raw.product_type)
      && !(typeof original.product_type === 'string' && original.product_type.trim()) && !(opts.writeMonthlyProductType === true && r.raw.product_group === 'MONTHLY_RENT')
      ? { product_type: r.raw.product_type } : {}),
    ...iancarVehicleIdFields(r, original),
    // 공급사 기본 정책 연결: 계획이 정한 코드를, 문서의 policy_code 가 «지금도 비어 있을 때만» 쓴다(차 줄 값 우선 — 쓰기 시점에 한 번 더 확인).
    ...(typeof p.policyLinkCode === 'string' && r.raw?.product_group !== 'MONTHLY_RENT' && policyLinkCodeFor(r.sourceId, original.policy_code) === p.policyLinkCode
      ? { policy_code: p.policyLinkCode, policy_code_linked_reason: policyLinkReason(p.policyLinkCode) } : {}),
    source_cycle_write: { by: SOURCE_CYCLE_WRITER, status: listable ? display : '출고불가', at: r.observedAt },
    ...apiPhotoFields(r, original),
    // F05 차량번호 칸 사진 폴더 링크: 빈 photo_link 에만(값 있는 칸·다른 폴더 캐시는 덮지 않음). 원천 기록에 검증된 폴더 링크가 있을 때만.
    ...sheetPhotoLinkFields(r.raw, original, r.observedAt),
    // 시트 사실(구동방식·원산지): 켠 공급사·켠 칸만, 문서가 «지금도 비어 있을 때만»(쓰기 시점 재확인), 기존 문서만.
    ...(!isNew && opts.sheetFactSources?.has(r.sourceId) && opts.sheetFactKeys?.length ? sheetFactFields(r.raw?.sheet_facts, original, opts.sheetFactKeys, (p.sheetFactFill ?? []) as SheetFactKey[]) : {}),
    ...(opts.writeApiOptions === true ? apiOptionFields(r, original) : {}),
    ...(opts.sourceIdentitySources?.has(r.sourceId) && p.fillSourceIdentity === true && engineOwnedIdentity(original, isNew, r)
      ? sourceIdentityFields(r, original, !!identity, opts.sourceMakers ?? null, isNew ? textOf(r.vehicleText) : textOf(original.sub_model), opts.sourceModels ?? null) : {}),
    // 제원 입구 매핑: 계획이 양성 표식을 준 항목에서만, 확인 표식은 채울 값이 없어도 남겨 되풀이를 막는다(이미 확인한 문서는 다시 채우지 않음).
    ...(specFill && original.vehicle_spec_source_checked !== true
      ? { ...sourceSpecFillFields(r.raw?.spec, original, r.vehicleText, masterFuel, masterSpecs), vehicle_spec_source_checked: true, [INT_COLOR_MARK]: true } : {}),
    // 이미 제원 채움을 마친 문서: 내장색 보완(표식으로 한 번) + 빈 칸 다시 채움(빈 칸 + 원천 값 있음, 대표 2026-10-19). 값이 있는 칸은 덮지 않는다.
    ...(specFill && original.vehicle_spec_source_checked === true
      ? { ...intColorOnlyFields(r.raw?.spec, original), ...sourceSpecRefillFields(r.raw?.spec, original, r.vehicleText, masterFuel, masterSpecs) } : {}),
    ...(p.fillSourceIdentity === true && p.reviewedSpec && !withdrawing
      && stableDigest(original.원문_정정 ?? null) === p.reviewedSpec.correctionDigest
      ? { ...refillableSpecValues(p.reviewedSpec.values, Object.keys(p.reviewedSpec.values).filter(k => specBlank(original[k])), r.vehicleText, original.fuel_type),
        vehicle_spec_correction: { correctionDigest: p.reviewedSpec.correctionDigest, at: r.observedAt } } : {}),
    source_observed_at: r.observedAt, source_cycle_record: compactRecord(r),
    publication_withdrawal: p.publication_withdrawal, publication_withdrawal_prior: p.publication_withdrawal_prior };
}
/** ERP5 제목은 maker·(sub_model||model)·trim_name 만 읽는다(차량 정보 확인 필요 방지). 마스터로 특정되기 전 신규 편입은 maker·model 을 비워 두고 원문 차명을 sub_model 에 임시로 둔다(vehicle_review_required 가 true 인 동안만; 마스터 정리 때 덮어쓴다). */
export const rawTitleBackfillFields = (f: Fields): Fields | null =>
  f.vehicle_review_required === true && ['maker', 'model', 'sub_model', 'trim_name'].every(k => !String(f[k] ?? '').trim()) &&
  String((f.원문 as Fields | undefined)?.차명 ?? f.car_name ?? '').trim()
    ? { sub_model: String((f.원문 as Fields | undefined)?.차명 ?? f.car_name).trim(), vehicle_title_source: 'RAW_VEHICLE_TEXT' } : null;
/** Firestore field paths with non-ASCII or special characters must be backtick-quoted. */
const fieldPath = (name: string): string => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '`' + name.replace(/`/g, '\`') + '`';
/** Legacy products compatibility command port required by SPEC3. No SDK app, deletes or blind retries. */
export function firestoreCycleCommands(options: { env?: NodeJS.ProcessEnv; directory: string; fetcher?: typeof fetch;
  token?: () => Promise<string>; observationSources?: string[]; acceptDrift?: string[]; supplierDefaults?: Record<string, SupplierFields>; writeMonthlyProductType?: boolean; writeApiOptions?: boolean; sourceIdentitySources?: readonly string[]; identityRefine?: boolean;
  /** Runtime opt-in: retain fresh own-supplier completeness and check incoming IDs for foreign ownership. */
  scopedProductReads?: boolean;
  /** 제원 채움만 켤 공급사(입구 매핑 없이 빈 제원 칸 채움·다시 채움, 대표 2026-10-19). 입구 매핑 공급사는 이 목록과 상관없이 제원도 채운다. */
  specFillSources?: readonly string[];
  /** 시트 사실 빈 칸 채움(구동방식·원산지)을 켤 공급사 코드와 칸(기본 꺼짐, 대표 2026-10-23 승인 순서대로 단계마다 켠다). */
  sheetFactSources?: readonly string[]; sheetFactKeys?: readonly string[];
  /** Default off. Exact reviewed shared-sheet UID scope for missing writer provenance. */
  provenanceUids?: readonly string[];
  /** 정체성 정제(마스터 이름 채움)를 켤 공급사 코드 목록(IDENTITY-SAME-CYCLE-DESIGN 2단계). 값이 있으면 그 공급사만, 없으면(undefined) identityRefine 이 전체를 정한다. */
  identityRefineSources?: readonly string[];
  /** 회차마다 한 번 읽은 활성 차종 마스터 대조기(같은 Promise 를 돌려준다). 없거나 실패(null)면 정체성 정제를 하지 않는다(지금 동작, fail-closed). */
  identity?: () => Promise<VehicleIdentityRefiner | null> }) {
  const project = resolveTargetProject(options.env), base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  const fetcher = options.fetcher ?? fetch, cache = new Map<string, Doc>(), accept = new Set(options.acceptDrift ?? []);
  const readMetrics = { fullListRequests: 0, supplierQueries: 0, candidateBatches: 0, documents: 0, missing: 0, jsonBytes: 0 };
  const monthly = options.writeMonthlyProductType === true;
  const apiOptions = options.writeApiOptions === true;
  const srcIdentity: ReadonlySet<string> | null = options.sourceIdentitySources?.length ? new Set(options.sourceIdentitySources) : null;
  const specSrc: ReadonlySet<string> | null = srcIdentity || options.specFillSources?.length
    ? new Set([...(options.sourceIdentitySources ?? []), ...(options.specFillSources ?? [])]) : null;
  let refiner: VehicleIdentityRefiner | null = null;
  const ready = async () => { refiner = options.identity ? await options.identity().catch(() => null) : null; };
  // 정체성 정제(마스터 이름 덮어쓰기)는 identityRefine=false 면 끈다(입구 매핑용 제조사 목록만 읽은 경우).
  const refineSources: ReadonlySet<string> | null = options.identityRefineSources ? new Set(options.identityRefineSources) : null;
  // 공급사 허용 목록이 있으면 그 공급사 문서·레코드에만 정제기를 건넨다(없으면 종전: identityRefine 이 전체를 정한다).
  const refineFor = (source: unknown) => (options.identityRefine === false ? null : refineSources && !refineSources.has(String(source ?? '')) ? null : refiner);
  const docSource = (d: Doc) => { const v = (d.fields as Record<string, { stringValue?: string }> | undefined)?.provider_company_code; return v?.stringValue ?? ''; };
  const srcModels = () => sourceModelsOf(refiner?.models, refiner?.modelAliases);
  const provenanceUids = new Set(options.provenanceUids ?? []);
  const reviewedApprovals = reviewedSpecApprovals(options.env?.SOURCE_CYCLE_REVIEWED_SPEC_CORRECTIONS);
  const factKeys: SheetFactKey[] = (options.sheetFactKeys ?? []).filter((k): k is SheetFactKey => (SHEET_FACT_KEYS as readonly string[]).includes(k));
  const factSources: ReadonlySet<string> | null = options.sheetFactSources?.length && factKeys.length ? new Set(options.sheetFactSources) : null;
  const withFacts = (p: CycleProduct, d: Doc): CycleProduct => {
    if (!factSources?.has(p.record.sourceId) || !p.listable || p.publication_withdrawal || p.locked_by_contract) return p;
    const f = decodeFields(d.fields);
    if (f.source_cycle_record === undefined) return p;
    return { ...p, sheetFactState: sheetFactState(f, factKeys) };
  };
  const env = (d: Doc) => withFacts(envelope(d, accept, undefined, undefined, monthly, refineFor(docSource(d)), apiOptions, srcIdentity, srcModels(), specSrc, refiner?.trimFuel ?? null, provenanceUids, reviewedApprovals, refiner?.trimSpecs ?? null), d);
  const native = (after: CycleProduct, original: Fields) => nativeCycleFields(after, original, { writeMonthlyProductType: monthly, identity: refineFor(after.record.sourceId), writeApiOptions: apiOptions,
    sheetFactSources: factSources, sheetFactKeys: factKeys,
    sourceIdentitySources: srcIdentity, specFillSources: specSrc, sourceMakers: refiner?.makers?.length ? new Set(refiner.makers) : null, sourceModels: sourceModelsOf(refiner?.models, refiner?.modelAliases) });
  const docPath = (uid: string) => {
    if (!uid || uid.includes('/') || uid === '.' || uid === '..') throw new Error('UID_INVALID');
    return `/products/${encodeURIComponent(uid)}`;
  };
  const tokenSource = options.token ?? gcloudUserToken;
  const request = async (path: string, method = 'GET', body?: unknown, retriedAuth = false): Promise<any> => {
    const response = await fetcher(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${await tokenSource()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // 401 = 토큰 만료·무효(발급 시각을 모르는 캐시 토큰의 안전망): 캐시를 비우고 한 번만 다시 발급해 재요청한다.
    if (response.status === 401 && !retriedAuth && typeof (tokenSource as Partial<GcloudTokenSource>).invalidate === 'function') {
      (tokenSource as GcloudTokenSource).invalidate(); return request(path, method, body, true);
    }
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(response.status === 409 || response.status === 412 ? 'CAS_CONFLICT' : 'FIRESTORE_REQUEST_FAILED');
    return response.json();
  };
  const getDoc = async (uid: string): Promise<Doc | null> => request(docPath(uid));
  // 상품 변경 이력(대표 10-25 «모든 정정은 이력»): 기본 off. shadow 는 쓰기·되읽기 확인 뒤 비공식 리비전을 따로 남긴다(기본 로컬 파일 — 운영 DB 쓰기 0).
  const revisionMode = productRevisionModeOf(options.env);
  const revisionSink = () => productRevisionSinkOf(options.env, {
    local: () => localProductRevisionSink(join(options.directory, 'revisions')),
    firestore: () => restProductRevisionSink({ request, encodeFields: v => encodeFields(v as never), decodeFields: f => decodeFields(f as Doc['fields']) }),
  });
  // 작성자 정보는 기록할 때만(지연) 만든다 — off 에서는 호스트 조회도 하지 않는다.
  const engineActor = (): ProductRevisionActor => ({ kind: 'ENGINE', id: 'source-cycle', role: 'SERVICE', via: 'source-cycle', host: hostname(),
    ...(options.env?.SOURCE_CYCLE_GIT_SHA ? { gitSha: options.env.SOURCE_CYCLE_GIT_SHA } : {}) });
  const revisionResults: ProductRevisionRecordResult[] = [];
  const path = (key: string) => join(options.directory, `${stableDigest(key)}.backup.json`);
  const load = async (key: string): Promise<Backup> => {
    const b = JSON.parse(await readFile(path(key), 'utf8')) as Backup;
    if (b.key !== key || b.project !== project) throw new Error('BACKUP_TARGET_MISMATCH');
    return b;
  };
  const immutable = async (file: string, value: unknown) => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    try { await writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST' ||
      stableDigest(JSON.parse(await readFile(file, 'utf8'))) !== stableDigest(value)) throw new Error('BACKUP_IMMUTABLE'); }
  };
  const supplierFields = (source: string): SupplierFields | null => {
    const fields = [...cache.values()].map(d => decodeFields(d.fields)).filter(f => f.provider_company_code === source);
    const mode = (key: string): string | null => {
      const counts = new Map<string, number>();
      for (const f of fields) if (typeof f[key] === 'string' && (f[key] as string).trim()) {
        const value = (f[key] as string).trim(); counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      // Ties are deterministic and independent of Firestore page/order.
      return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0] ?? null;
    };
    const configured = options.supplierDefaults?.[source];
    const name = mode('provider_name') ?? configured?.provider_name ??
      supplierSpec.supplierChannels.sharedInputSheet.find(s => s.code === source)?.companyName ??
      supplierSpec.supplierChannels.notInSharedSheet.find(s => s.code === source)?.name;
    return name?.trim() ? { provider_name: name, policy_code: mode('policy_code') ?? configured?.policy_code ?? null } : null;
  };
  const commands: CycleCommands = {
    async storeRaw({ sourceId, records, held, observedAt, complete }) {
      const entries = [...records.map(r => rawEntryOfRecord(sourceId, r)), ...held.map(h => rawEntryOfHeld(sourceId, h))];
      const seen = new Set(entries.map(e => e.key));
      const existing = new Map<string, { first: string | null; absent: string | null; digest: string | null }>();
      const q = await request(':runQuery', 'POST', { structuredQuery: { from: [{ collectionId: 'source_raw' }],
        where: { fieldFilter: { field: { fieldPath: 'source_id' }, op: 'EQUAL', value: { stringValue: sourceId } } },
        select: { fields: ['key', 'first_seen_at', 'absent_since', 'raw_digest'].map(fieldPath => ({ fieldPath })) } } });
      for (const row of (Array.isArray(q) ? q : []) as Array<{ document?: Doc }>) if (row.document) {
        const f = decodeFields(row.document.fields);
        if (typeof f.key === 'string') existing.set(f.key, { first: (f.first_seen_at as string) ?? null, absent: (f.absent_since as string) ?? null, digest: (f.raw_digest as string) ?? null });
      }
      const docName = (key: string) => `projects/${project}/databases/(default)/documents/source_raw/${encodeURIComponent(key)}`;
      const writes: unknown[] = [];
      for (const e of entries) {
        const prior = existing.get(e.key);
        const fields = { source_id: sourceId, key: e.key, kind: e.kind, plate: e.plate, uid: e.uid, vehicle_text: e.vehicleText, status_raw: e.statusRaw,
          sale_available: e.saleAvailable, terms: e.terms, raw: e.raw, held_reasons: e.heldReasons, raw_digest: e.rawDigest, observed_at: observedAt,
          first_seen_at: prior?.first ?? observedAt, last_seen_at: observedAt, absent_since: null, read_complete: complete };
        writes.push({ update: { name: docName(e.key), fields: encodeFields(fields as never) }, updateMask: { fieldPaths: Object.keys(fields) } });
      }
      let absentMarked = 0;
      // 식별 불가 보류 행이 있는 회차는 «이전 정상 레코드가 보류로 바뀐 것»과 «사라진 것»을 가를 수 없어 사라짐 표식을 유보한다.
      if (complete && held.length === 0) for (const [key, prior] of existing) if (!seen.has(key) && !prior.absent) {
        absentMarked++;
        writes.push({ update: { name: docName(key), fields: encodeFields({ absent_since: observedAt, read_complete: true } as never) }, updateMask: { fieldPaths: ['absent_since', 'read_complete'] } });
      }
      // 요청 크기: 문서 수 200 이하 AND 직렬화 6MB 이하로 나눠 보낸다(Firestore 요청 한도 10MiB 보호).
      let batch: unknown[] = [], bytes = 0;
      const flush = async () => { if (batch.length) { await request(':commit', 'POST', { writes: batch }); batch = []; bytes = 0; } };
      for (const w of writes) {
        const size = Buffer.byteLength(JSON.stringify(w), 'utf8');
        if (batch.length >= 200 || bytes + size > 6_000_000) await flush();
        batch.push(w); bytes += size;
      }
      await flush();
      return { stored: entries.length, absentMarked };
    },
    async list(source, candidateUids) {
      await ready();
      for (const key of cache.keys()) if (key.startsWith(`${source}:`)) cache.delete(key);
      const products: CycleProduct[] = [], drifted: string[] = [], heldDrift: string[] = [], foreign: string[] = []; let page = ''; const pages = new Set<string>();
      do {
        const query = new URLSearchParams({ pageSize: '300' });
        if (page) query.set('pageToken', page);
        for (const field of ['provider_company_code', 'provider_name', 'policy_code', 'car_number', 'car_name', '원문', 'model', 'price', 'listable', 'status', 'status_kind',
          'source', 'source_tab', 'product_group', 'source_observed_at', 'source_cycle_record', 'source_cycle_price_digest', 'locked_by_contract', 'source_cycle_write',
          'publication_withdrawal', 'publication_withdrawal_prior', 'vehicle_status', 'product_type', 'supplier_confirmed_sold',
          'image_urls', 'image_url', 'photo_cache', 'photo_original_refs', 'photo_link', 'iancar_one_vehicle_id', '_direct_ingest_at',
          // 정체성 정제 판정(engineIdentityHold·identityYear)이 읽는 칸 — 목록과 전체 문서의 envelope 가 같아야 백업 대조가 맞는다.
          'maker', 'sub_model', 'trim_name', 'vehicle_review_required', 'year', 'first_registration_date',
          // 손오공 API 옵션 확인 표식(API_OPTIONS 사유 판정) — 옵션 목록 자체는 목록 조회에 싣지 않는다.
          'api_options_state', 'vehicle_maker_model_source', 'vehicle_maker_model_filled',
          // 제원 입구 매핑 판정이 읽는 칸(빈 칸에만 채움)
          'ext_color', 'int_color', 'fuel_type', 'mileage', 'engine_cc', 'seats', 'vehicle_spec_source_checked', 'vehicle_int_color_source_checked',
          // 마스터 제원 보완 판정(masterSpecsOf)이 읽는 칸 — 목록과 전체 문서 envelope 가 같아야 백업 대조가 맞는다(대표 2026-10-22).
          'drive_type', 'vehicle_master_id', ...factKeys]) query.append('mask.fieldPaths', fieldPath(field));
        if (reviewedApprovals.size) for (const field of ['원문_정정', '원문_정정_이력']) query.append('mask.fieldPaths', fieldPath(field));
        // 옛 이안카 발행 근거는 크다(요금 근거 포함): 관측 기준 시각 한 칸만 읽는다(legacyObservedAt).
        query.append('mask.fieldPaths', 'iancar_phase_one.sourceSyncedAt');
        const scoped = options.scopedProductReads === true && candidateUids !== undefined;
        let result;
        if (scoped) {
          readMetrics.supplierQueries++;
          const rows = await request(':runQuery', 'POST', { structuredQuery: {
            from: [{ collectionId: 'products' }],
            where: { fieldFilter: { field: { fieldPath: 'provider_company_code' }, op: 'EQUAL', value: { stringValue: source } } },
            select: { fields: query.getAll('mask.fieldPaths').map(fieldPath => ({ fieldPath })) },
          } });
          if (!Array.isArray(rows) || !rows.length || rows.some(r => !r || r.error || (!r.document && typeof r.readTime !== 'string')))
            throw new Error('CATALOG_INCOMPLETE');
          result = { documents: rows.flatMap(r => r.document ? [r.document] : []) };
          readMetrics.jsonBytes += Buffer.byteLength(JSON.stringify(rows));
        } else {
          readMetrics.fullListRequests++;
          result = await request('/products?' + query);
          readMetrics.jsonBytes += Buffer.byteLength(JSON.stringify(result));
        }
        if (!result || (!Array.isArray(result.documents) && result.documents !== undefined)) throw new Error('CATALOG_INCOMPLETE');
        readMetrics.documents += result.documents?.length ?? 0;
        for (const d of (result.documents ?? []) as Doc[]) {
          const f = decodeFields(d.fields);
          if (f.provider_company_code !== source) {
            if (scoped) throw new Error('CATALOG_INCOMPLETE');
            // 다른 공급사 문서의 ID(= uid): 같은 번호의 편입을 계획 단계에서 보류하는 근거(PLATE_OWNED_BY_OTHER_SUPPLIER).
            const id = typeof d.name === 'string' ? decodeURIComponent(d.name.split('/').at(-1) ?? '') : '';
            if (id) foreign.push(id);
            continue;
          }
          if (!d.updateTime) throw new Error('CATALOG_VERSION_REQUIRED');
          const base = envelope(d, accept, drifted, heldDrift, monthly, refineFor(source), apiOptions, srcIdentity, srcModels(), specSrc, refiner?.trimFuel ?? null, provenanceUids, reviewedApprovals, refiner?.trimSpecs ?? null); const p = withFacts(base, d); products.push(p); cache.set(`${source}:${p.record.uid}`, d);
        }
        page = result.nextPageToken ?? '';
        if (page && pages.has(page)) throw new Error('CATALOG_PAGINATION_LOOP');
        pages.add(page);
      } while (page);
      if (options.scopedProductReads === true && candidateUids !== undefined) {
        const own = new Set(products.map(p => p.record.uid));
        const candidates = [...new Set(candidateUids)].filter(uid => !own.has(uid));
        const resource = (uid: string) => { docPath(uid); return `${base.slice('https://firestore.googleapis.com/v1/'.length)}/products/${uid}`; };
        for (let offset = 0; offset < candidates.length; offset += 100) {
          const names = new Map(candidates.slice(offset, offset + 100).map(uid => [resource(uid), uid]));
          readMetrics.candidateBatches++;
          const rows = await request(':batchGet', 'POST', { documents: [...names.keys()], mask: { fieldPaths: ['provider_company_code'] } });
          if (!Array.isArray(rows)) throw new Error('CATALOG_INCOMPLETE');
          readMetrics.jsonBytes += Buffer.byteLength(JSON.stringify(rows));
          const seen = new Set<string>();
          for (const row of rows) {
            const name = row?.found?.name ?? row?.missing;
            if (row?.error || typeof name !== 'string' || !names.has(name) || seen.has(name) || (!!row.found === !!row.missing))
              throw new Error('CATALOG_INCOMPLETE');
            seen.add(name);
            if (row.found) {
              readMetrics.documents++;
              // Missing owner is foreign too. A newly appearing own document requires a fresh plan.
              if (docSource(row.found) === source) throw new Error('CATALOG_INCOMPLETE');
              foreign.push(names.get(name)!);
            } else readMetrics.missing++;
          }
          if (seen.size !== names.size) throw new Error('CATALOG_INCOMPLETE');
        }
      }
      const sheetRefiner = refineFor(source);
      return { products, complete: true, enrollmentSupplier: supplierFields(source), ...(refiner ? { identityMasterDigest: refiner.digest } : {}),
        ...(sheetRefiner ? { sheetIdentityMatch: (record: SourceProductRecord, year: string) => !!validSheetIdentity(record.raw?.sheet_identity) && !!sheetRefiner.match({ rawName: textOf(record.vehicleText), year, ...sheetOf(record) }) } : {}),
        ...(drifted.length ? { acceptedDrift: drifted.sort() } : {}),
        ...(heldDrift.length ? { driftHeld: heldDrift.sort() } : {}), ...(foreign.length ? { foreignUids: foreign.sort() } : {}) };
    },
    async read(source, uid) {
      await ready();
      const d = await getDoc(uid);
      if (!d) return null;
      const p = env(d);
      if (p.record.sourceId !== source) throw new Error('UID_OTHER_SUPPLIER');
      cache.set(`${source}:${uid}`, d); return p;
    },
    async backup(key, before) {
      await ready();
      const cached = before ? cache.get(`${before.record.sourceId}:${before.record.uid}`) : null;
      const document = before ? await getDoc(before.record.uid) : null;
      if (before && (!document || !cached || cached.updateTime !== document.updateTime ||
        stableDigest(env(document)) !== stableDigest(before))) throw new Error('BACKUP_SNAPSHOT_MISSING');
      await immutable(path(key), { project, key, before, document: document ?? null });
    },
    async readBackup(key) {
      await ready();
      const b = await load(key);
      if (stableDigest(b.document ? env(b.document) : null) !== stableDigest(b.before)) throw new Error('BACKUP_MISMATCH');
      return b.before;
    },
    async precheck(afters) {
      await ready();
      // Firestore 문서 한도 1MiB. 쓰기 뒤 문서 크기 = 기존 문서에서 덮일 필드를 뺀 나머지 + 새 필드. 900,000B 를 넘는 쓰기가 하나라도 있으면
      // 어떤 백업·쓰기도 시작하기 전에 계획 전체를 막는다(일부만 적용되고 멈추는 상태 방지).
      const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
      for (const after of afters) {
        const current = await getDoc(after.record.uid);   // 목록은 필드 마스크라 전체 문서가 아니다 — 크기는 전체 문서로 잰다
        const incoming = encodeFields(native(after, current ? decodeFields(current.fields) : {}));
        const kept = Object.entries(current?.fields ?? {}).filter(([k]) => !(k in incoming));
        if (size(Object.fromEntries(kept)) + size(incoming) > 900_000) throw new Error('DOC_TOO_LARGE');
      }
    },
    async compareAndApply(beforeDigest, after, key) {
      await ready();
      if (options.observationSources?.includes(after.record.sourceId)) throw new Error('OBSERVATION_ONLY');
      const b = await load(key), current = await getDoc(after.record.uid);
      if (stableDigest(b.before) !== beforeDigest || stableDigest(current) !== stableDigest(b.document) ||
        (after.identityOnly !== true && ((current && env(current).locked_by_contract) || after.locked_by_contract))) throw new Error('CAS_CONFLICT');
      if (after.identityOnly === true && !current) throw new Error('CAS_CONFLICT');
      if (current && env(current).record.sourceId !== after.record.sourceId) throw new Error('UID_OTHER_SUPPLIER');
      if (!current && (!after.supplierFields?.provider_name.trim() ||
        stableDigest(after.supplierFields) !== stableDigest(supplierFields(after.record.sourceId))))
        throw new Error('SUPPLIER_NAME_REQUIRED');
      const fields = native(after, current ? decodeFields(current.fields) : {});
      // 계획이 고른 시트 사실 칸은 «지금도 비어 있는데 안 쓰였다면» 실패다(채움 누락을 성공으로 오인하지 않는다). 그 사이 사람이 채웠으면 건너뛴 것이라 정상.
      for (const key of after.sheetFactFill ?? []) if (!(key in fields) && current && isBlankFact(decodeFields(current.fields)[key])) throw new Error('SHEET_FACT_NOT_WRITTEN');
      if (after.identityOnly === true && (!Object.keys(fields).length || Object.keys(fields).some(k => !(IDENTITY_ONLY_FIELDS as readonly string[]).includes(k)))) throw new Error('IDENTITY_ONLY_FIELDS_INVALID');
      const query = new URLSearchParams(current ? { 'currentDocument.updateTime': current.updateTime } : { 'currentDocument.exists': 'false' });
      for (const field of Object.keys(fields)) query.append('updateMask.fieldPaths', fieldPath(field));
      const result = await request(docPath(after.record.uid) + '?' + query, 'PATCH', { fields: encodeFields(fields) });
      const reread = await getDoc(after.record.uid);
      if (!reread || reread.updateTime !== result.updateTime || Object.entries(fields).some(([k, v]) =>
        fieldDigest(k, decodeFields(reread.fields)[k]) !== fieldDigest(k, v))) throw new Error('READBACK_UNCERTAIN');
      // 이름만 쓴 문서는 허용 목록 밖의 모든 칸이 쓰기 전과 같음을 되읽기로 증명한다(계약·금액·상태·잠금 불변).
      if (after.identityOnly === true && current) {
        // 원시 Firestore 값(타입 포함)으로 비교한다 — 해독·정규화(null/누락 동일시)를 거치지 않는다.
        const rawBefore = (current.fields ?? {}) as Record<string, unknown>, rawAfter = (reread.fields ?? {}) as Record<string, unknown>;
        for (const k of new Set([...Object.keys(rawBefore), ...Object.keys(rawAfter)])) {
          if ((IDENTITY_ONLY_FIELDS as readonly string[]).includes(k)) continue;
          if (stableDigest(rawBefore[k] ?? null) !== stableDigest(rawAfter[k] ?? null) || (k in rawBefore) !== (k in rawAfter)) throw new Error('READBACK_UNCERTAIN');
        }
      }
      await immutable(join(options.directory, `${stableDigest(key)}.receipt.json`), { project, key, after: reread });
      // 재시도해도 같은 작업 id(백업 키 digest)라 같은 리비전 하나만 남는다. shadow 실패는 결과로만 남고 쓰기를 막지 않는다.
      revisionResults.push(await recordProductRevision(revisionMode, revisionSink, () => ({
        uid: after.record.uid, operationId: `source-cycle:${stableDigest(key)}`,
        kind: !current ? 'CREATE' : after.identityOnly === true ? 'IDENTITY_CORRECTION' : 'UPDATE',
        actor: engineActor(), tool: { name: 'source-cycle', planDigest: beforeDigest }, reason: `원천 회차 반영(${after.record.sourceId})`,
        evidence: { sourceId: after.record.sourceId, backupKeyDigest: stableDigest(key), sourceObservedAt: after.record.observedAt ?? null },
        before: current ? decodeFields(current.fields) : null, after: fields,
        expectedUpdateTime: current?.updateTime ?? null, committedUpdateTime: reread.updateTime ?? null, at: new Date().toISOString(),
      })));
    },
  };
  return { ...commands,
    readMetrics: () => ({ ...readMetrics }),
    async documents(source: string) { await commands.list(source, []); return [...cache.values()].filter(d => decodeFields(d.fields).provider_company_code === source); },
    async rollback(key: string, approval: string) {
      await ready();
      const b = await load(key), receipt = JSON.parse(await readFile(join(options.directory, `${stableDigest(key)}.receipt.json`), 'utf8'));
      if (receipt.project !== project || receipt.key !== key || approval !== stableDigest({ backup: b, receipt })) throw new Error('ROLLBACK_APPROVAL_REQUIRED');
      const uid = decodeURIComponent(receipt.after.name.split('/').at(-1));
      const current = await getDoc(uid);
      if (!current || stableDigest(current) !== stableDigest(receipt.after) || env(current).locked_by_contract) throw new Error('CAS_CONFLICT');
      if (options.observationSources?.includes(env(current).record.sourceId)) throw new Error('OBSERVATION_ONLY');
      // Newly enrolled documents are withdrawn, never deleted.
      const fields = b.document?.fields ?? { ...current.fields, ...encodeFields({ listable: false, status: '출고불가', status_kind: '불가',
        vehicle_status: '출고불가', publication_withdrawal: { reason: 'ROLLBACK_ENROLL', deleteAuthorized: false } }) };
      await immutable(join(options.directory, `${stableDigest(key)}.rollback-before.json`), current);
      const result = await request(docPath(uid) + '?currentDocument.updateTime=' + encodeURIComponent(current.updateTime), 'PATCH', { fields });
      const reread = await getDoc(uid);
      if (!reread || result.updateTime !== reread.updateTime || stableDigest(reread.fields) !== stableDigest(fields)) throw new Error('ROLLBACK_READBACK_UNCERTAIN');
      // 롤백은 updateMask 없는 전체 교체 — 교체로 사라진 칸도 이력에 남긴다(replace).
      revisionResults.push(await recordProductRevision(revisionMode, revisionSink, () => ({
        uid, operationId: `source-cycle-rollback:${stableDigest(key)}`, kind: 'ROLLBACK', replace: true,
        actor: engineActor(), tool: { name: 'source-cycle-rollback', planDigest: approval },
        reason: '원천 회차 반영 되돌림(승인 digest)', evidence: { backupKeyDigest: stableDigest(key) },
        before: decodeFields(current.fields), after: decodeFields(fields as Doc['fields']),
        expectedUpdateTime: current.updateTime ?? null, committedUpdateTime: reread.updateTime ?? null, at: new Date().toISOString(),
      })));
      return { status: 'ROLLED_BACK' };
    },
    /** 이번 실행에서 남긴 이력 결과(shadow 대사용). */
    revisionResults: () => [...revisionResults],
    async rollbackDigest(key: string) { const backup = await load(key);
      const receipt = JSON.parse(await readFile(join(options.directory, `${stableDigest(key)}.receipt.json`), 'utf8'));
      return stableDigest({ backup, receipt }); },
  };
}
