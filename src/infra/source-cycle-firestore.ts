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
import { resolveErp5InventoryStatus, PROVIDER_AVAILABLE_STATUS_LABELS } from '../domain/erp5-inventory-status.js';
import { hasSupplierDepositPolicy, supplierDepositRuleFor } from '../domain/supplier-deposit-policy.js';

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
export async function gcloudUserToken(): Promise<string> {
  const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'powershell.exe' : 'gcloud',
    process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', '& gcloud.cmd auth print-access-token; exit $LASTEXITCODE']
      : ['auth', 'print-access-token'], { windowsHide: true, timeout: 30_000 });
  const token = stdout.trim();
  if (!token || /\s/.test(token)) throw new Error('GCLOUD_TOKEN_REQUIRED');
  return token;
}
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
export const engineIdentityHold = (f: Fields): boolean =>
  f.source_cycle_record !== undefined && f.source_cycle_record !== null && f.vehicle_review_required === true && !textOf(f.maker) && !textOf(f.model);
const yearOf = (v: unknown): string => { const m = /^(\d{4})/.exec(typeof v === 'number' ? String(v) : textOf(v)); return m ? m[1]! : ''; };
const specOf = (r: SourceProductRecord | undefined): Fields => {
  const spec = r?.raw?.spec;
  return spec && typeof spec === 'object' && !Array.isArray(spec) ? spec as Fields : {};
};
/** 대조에 쓰는 연식: 문서 연식 → 원천 연식 → 문서 최초등록 연도 → 원천 최초등록 연도(계획서 생성기 입력과 같은 뜻: 연식 또는 최초등록 연도). */
export const identityYear = (f: Fields, r?: SourceProductRecord): string =>
  yearOf(f.year) || yearOf(specOf(r).year) || yearOf(f.first_registration_date) || yearOf(specOf(r).first_registration_date);
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
  identity: VehicleIdentityRefiner | null = null): CycleProduct {
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
  // 이안카(RP031) 노출 문서에 공급사 차량 ID(iancar_one_vehicle_id)가 없으면 사진·정책 연결이 그 문서를 못 쓴다. 한 번 다시 써서 채운다(되풀이되지 않음).
  if (engineOwned && f.provider_company_code === 'RP031' && !(typeof f.iancar_one_vehicle_id === 'string' && f.iancar_one_vehicle_id.trim())
    && typeof record.raw?.vehicle_id === 'string' && record.raw.vehicle_id.trim()) rewriteReasons.push('IANCAR_VEHICLE_ID');
  // 정체성 보류 문서(엔진 편입, 제조사·모델 빈칸, 검토 필요)가 이번 회차 차종 마스터로 «하나로» 특정되면 한 번 다시 써서 이름을 채운다.
  // 쓰면 제조사·모델이 채워지고 검토 필요가 풀려 조건이 거짓이 된다(되풀이되지 않음). 특정되지 않으면 사유가 없어 일괄 UPDATE 도 없다.
  if (engineOwned && identity && engineIdentityHold(f) &&
    identity.match({ rawName: identityRawName(f.car_name, f), year: identityYear(f, record) })) rewriteReasons.push('VEHICLE_IDENTITY');
  return { record, ...(rewriteReasons.length ? { rewriteReasons } : {}),
    ...(typeof f.provider_name === 'string' && f.provider_name.trim() ? { supplierFields: {
    provider_name: f.provider_name, policy_code: typeof f.policy_code === 'string' ? f.policy_code : null } } : {}), listable: f.listable === true,
    locked_by_contract: isContractLockValue(f.locked_by_contract) || ((f.status === '계약중' || f.status_kind === '계약중') && !engineWroteContracted(f, record)),
    publication_withdrawal: (f.publication_withdrawal ?? null) as CycleProduct['publication_withdrawal'],
    publication_withdrawal_prior: (f.publication_withdrawal_prior ?? null) as CycleProduct['publication_withdrawal_prior'] };
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
export function nativeCycleFields(p: CycleProduct, original: Fields = {}, opts: { writeMonthlyProductType?: boolean; identity?: VehicleIdentityRefiner | null } = {}): Fields {
  const r = p.record;
  const isNew = !Object.keys(original).length;
  // 정체성 정제: 새 문서이거나 엔진 정체성 보류 문서일 때만, 차종 마스터로 하나로 특정되면 마스터 이름을 쓴다. 아니면 지금처럼 원문 차명·검토 필요.
  const identity = opts.identity && (isNew || engineIdentityHold(original))
    ? opts.identity.match({ rawName: identityRawName(r.vehicleText, original), year: identityYear(original, r) }) : null;
  const rawDisplay = String(r.raw.sourceCycleDisplayStatus ?? ({ AVAILABLE: '출고가능', PREPARING: '출고가능', 게시: '출고가능' } as Record<string, string>)[r.status.raw] ?? r.status.raw);
  const display = ({ 배차문의: '출고협의', 수리중: '상품화중' } as Record<string, string>)[rawDisplay] ?? rawDisplay;
  // fail-closed(독립 검토 BLOCK): 검토된 어휘에 없는 상태는 «가용» 으로 추정해 노출하지 않는다. 플러그인이 먼저 보류하므로 여기 오는 일은 드물다.
  const listable = p.listable && (resolveErp5InventoryStatus(display).known || PROVIDER_AVAILABLE_STATUS_LABELS.has(display));
  const price = !p.listable && original.price ? original.price :
    salePriceMap(r.terms);
  return { car_number: r.plate, provider_company_code: r.sourceId, car_name: r.vehicleText,
    ...(isNew ? { ...p.supplierFields, maker: '', model: '', sub_model: r.vehicleText, trim_name: '', vehicle_review_required: true, vehicle_title_source: 'RAW_VEHICLE_TEXT',
      원문: { 차명: r.vehicleText, source: r.raw }, ...sheetSpecFields(r.raw.spec) } : {}),
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
    source_cycle_write: { by: SOURCE_CYCLE_WRITER, status: listable ? display : '출고불가', at: r.observedAt },
    ...apiPhotoFields(r, original),
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
  token?: () => Promise<string>; observationSources?: string[]; acceptDrift?: string[]; supplierDefaults?: Record<string, SupplierFields>; writeMonthlyProductType?: boolean;
  /** 회차마다 한 번 읽은 활성 차종 마스터 대조기(같은 Promise 를 돌려준다). 없거나 실패(null)면 정체성 정제를 하지 않는다(지금 동작, fail-closed). */
  identity?: () => Promise<VehicleIdentityRefiner | null> }) {
  const project = resolveTargetProject(options.env), base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  const fetcher = options.fetcher ?? fetch, cache = new Map<string, Doc>(), accept = new Set(options.acceptDrift ?? []);
  const monthly = options.writeMonthlyProductType === true;
  let refiner: VehicleIdentityRefiner | null = null;
  const ready = async () => { refiner = options.identity ? await options.identity().catch(() => null) : null; };
  const env = (d: Doc) => envelope(d, accept, undefined, undefined, monthly, refiner);
  const native = (after: CycleProduct, original: Fields) => nativeCycleFields(after, original, { writeMonthlyProductType: monthly, identity: refiner });
  const docPath = (uid: string) => {
    if (!uid || uid.includes('/') || uid === '.' || uid === '..') throw new Error('UID_INVALID');
    return `/products/${encodeURIComponent(uid)}`;
  };
  const request = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
    const response = await fetcher(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${await (options.token ?? gcloudUserToken)()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(response.status === 409 || response.status === 412 ? 'CAS_CONFLICT' : 'FIRESTORE_REQUEST_FAILED');
    return response.json();
  };
  const getDoc = async (uid: string): Promise<Doc | null> => request(docPath(uid));
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
    async list(source) {
      await ready();
      for (const key of cache.keys()) if (key.startsWith(`${source}:`)) cache.delete(key);
      const products: CycleProduct[] = [], drifted: string[] = [], heldDrift: string[] = [], foreign: string[] = []; let page = ''; const pages = new Set<string>();
      do {
        const query = new URLSearchParams({ pageSize: '300' });
        if (page) query.set('pageToken', page);
        for (const field of ['provider_company_code', 'provider_name', 'policy_code', 'car_number', 'car_name', '원문', 'model', 'price', 'listable', 'status', 'status_kind',
          'source', 'source_tab', 'product_group', 'source_observed_at', 'source_cycle_record', 'source_cycle_price_digest', 'locked_by_contract', 'source_cycle_write',
          'publication_withdrawal', 'publication_withdrawal_prior', 'vehicle_status', 'product_type',
          'image_urls', 'image_url', 'photo_cache', 'photo_original_refs', 'iancar_one_vehicle_id', '_direct_ingest_at',
          // 정체성 정제 판정(engineIdentityHold·identityYear)이 읽는 칸 — 목록과 전체 문서의 envelope 가 같아야 백업 대조가 맞는다.
          'maker', 'sub_model', 'trim_name', 'vehicle_review_required', 'year', 'first_registration_date']) query.append('mask.fieldPaths', fieldPath(field));
        // 옛 이안카 발행 근거는 크다(요금 근거 포함): 관측 기준 시각 한 칸만 읽는다(legacyObservedAt).
        query.append('mask.fieldPaths', 'iancar_phase_one.sourceSyncedAt');
        const result = await request('/products?' + query);
        if (!result || (!Array.isArray(result.documents) && result.documents !== undefined)) throw new Error('CATALOG_INCOMPLETE');
        for (const d of (result.documents ?? []) as Doc[]) {
          const f = decodeFields(d.fields);
          if (f.provider_company_code !== source) {
            // 다른 공급사 문서의 ID(= uid): 같은 번호의 편입을 계획 단계에서 보류하는 근거(PLATE_OWNED_BY_OTHER_SUPPLIER).
            const id = typeof d.name === 'string' ? decodeURIComponent(d.name.split('/').at(-1) ?? '') : '';
            if (id) foreign.push(id);
            continue;
          }
          if (!d.updateTime) throw new Error('CATALOG_VERSION_REQUIRED');
          const p = envelope(d, accept, drifted, heldDrift, monthly, refiner); products.push(p); cache.set(`${source}:${p.record.uid}`, d);
        }
        page = result.nextPageToken ?? '';
        if (page && pages.has(page)) throw new Error('CATALOG_PAGINATION_LOOP');
        pages.add(page);
      } while (page);
      return { products, complete: true, enrollmentSupplier: supplierFields(source), ...(refiner ? { identityMasterDigest: refiner.digest } : {}),
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
        (current && env(current).locked_by_contract) || after.locked_by_contract) throw new Error('CAS_CONFLICT');
      if (current && env(current).record.sourceId !== after.record.sourceId) throw new Error('UID_OTHER_SUPPLIER');
      if (!current && (!after.supplierFields?.provider_name.trim() ||
        stableDigest(after.supplierFields) !== stableDigest(supplierFields(after.record.sourceId))))
        throw new Error('SUPPLIER_NAME_REQUIRED');
      const fields = native(after, current ? decodeFields(current.fields) : {});
      const query = new URLSearchParams(current ? { 'currentDocument.updateTime': current.updateTime } : { 'currentDocument.exists': 'false' });
      for (const field of Object.keys(fields)) query.append('updateMask.fieldPaths', fieldPath(field));
      const result = await request(docPath(after.record.uid) + '?' + query, 'PATCH', { fields: encodeFields(fields) });
      const reread = await getDoc(after.record.uid);
      if (!reread || reread.updateTime !== result.updateTime || Object.entries(fields).some(([k, v]) =>
        fieldDigest(k, decodeFields(reread.fields)[k]) !== fieldDigest(k, v))) throw new Error('READBACK_UNCERTAIN');
      await immutable(join(options.directory, `${stableDigest(key)}.receipt.json`), { project, key, after: reread });
    },
  };
  return { ...commands,
    async documents(source: string) { await commands.list(source); return [...cache.values()].filter(d => decodeFields(d.fields).provider_company_code === source); },
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
      return { status: 'ROLLED_BACK' };
    },
    async rollbackDigest(key: string) { const backup = await load(key);
      const receipt = JSON.parse(await readFile(join(options.directory, `${stableDigest(key)}.receipt.json`), 'utf8'));
      return stableDigest({ backup, receipt }); },
  };
}
