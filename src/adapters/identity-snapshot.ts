/** 정체성 승격 계획서 입력 만들기(읽기 전용·순수): ERP5 상품 캡처(erp5-source-capture/1) + 활성 차종 마스터 스냅샷 →
 * build-identity-promotion-plan CLI 가 받는 { products, masters, label } JSON. B3Q 가 손으로 만들던 스냅샷을 대신한다.
 * 번호는 끝 4자리만 싣는다(전체 번호·고객정보 없음). 기본 대상은 «엔진이 원문 차명으로만 편입한 문서»(vehicle_review_required 또는
 * 제조사·모델 빈칸) — 이미 사람이 정리한 문서까지 다시 대조하려면 includeAll. 퇴역 마스터·퇴역 트림은 넣지 않는다. */
import { decodeErp5Value, type Erp5SourceCapture } from './erp5-source-capture.js';
import type { VehicleMasterSnapshot } from './vehicle-identity-inputs.js';

/** build-identity-promotion-plan 입력 모양(application 의 IdentityProduct·IdentityMaster 와 같은 구조 — 어댑터는 application 에 의존하지 않는다, 호환은 시험의 대입이 지킨다). */
export type SnapshotProduct = { id: string; plate4: string; maker: string; model: string; sub_model: string; trim_name: string; rawName: string; year: string; listable: boolean; supplier?: string; engineTemp?: boolean; makerModelFromSource?: boolean; fuel?: string; firstRegistration?: string };
export type SnapshotMaster = { id: string; maker: string; model: string; sub_model: string; model_aliases: string[]; sub_model_aliases: string[];
  yearFrom: number | null; yearTo: number | null; monthFrom?: string; monthTo?: string | null; trims: Array<{ name: string; aliases: string[] }> };
type Rec = Record<string, unknown>;
const object = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()) : [];

function decodeDoc(doc: unknown): { id: string; fields: Rec } | null {
  if (!object(doc) || typeof doc.name !== 'string') return null;
  const fields: Rec = {};
  for (const [k, v] of Object.entries(object(doc.fields) ? doc.fields : {})) {
    try { fields[k] = decodeErp5Value(v); } catch { /* 해석 못 하는 값은 비워 둔다(추정 금지) */ }
  }
  return { id: decodeURIComponent(doc.name.split('/').pop() ?? ''), fields };
}
const yearOf = (f: Rec) => {
  const y = str(f.year) || str(f.model_year);
  if (/^\d{4}$/.test(y)) return y;
  return /^(\d{4})/.exec(str(f.first_registration_date))?.[1] ?? '';
};

/** 문서 한 건(디코드된 평문 필드) → 스냅샷 상품. 기본 대상이 아니면 null. */
function snapshotProductOf(id: string, f: Rec, includeAll: boolean): SnapshotProduct | null {
  const engineRaw = f.vehicle_review_required === true || (!str(f.maker) && !str(f.model));
  if (!includeAll && !engineRaw) return null;
  const original = object(f.원문) ? f.원문 : {};
  return { id, plate4: str(f.car_number).replace(/\D/g, '').slice(-4),
    maker: str(f.maker), model: str(f.model), sub_model: str(f.sub_model), trim_name: str(f.trim_name),
    rawName: str(original.차명) || str(f.car_name), year: yearOf(f), listable: f.listable === true,
    ...(str(f.provider_company_code) ? { supplier: str(f.provider_company_code) } : {}),
    // 표식만으로는 부족하다(Codex #685 (a)): 현재 maker·model 이 «이 경로가 쓴 값 그대로»(vehicle_maker_model_filled)일 때만 원천이 채운 값으로 본다 —
    // 사람이 고친 값은 표식이 남아 있어도 그대로 대조에 쓴다(마스터 값으로 덮어쓰는 수정안을 만들지 않는다).
    ...(f.vehicle_maker_model_source === 'SOURCE_FIELDS' && object(f.vehicle_maker_model_filled)
      && str(f.vehicle_maker_model_filled.maker) === str(f.maker) && str(f.vehicle_maker_model_filled.model) === str(f.model) ? { makerModelFromSource: true } : {}),
    ...(str(f.fuel_type) ? { fuel: str(f.fuel_type) } : {}),
    ...(/^\d{4}-\d{2}(?![0-9])/.test(str(f.first_registration_date)) ? { firstRegistration: str(f.first_registration_date) } : {}),
    ...(f.vehicle_review_required === true || f.vehicle_title_source === 'RAW_VEHICLE_TEXT' ? { engineTemp: true } : {}) };
}

export function identityProductsFromCapture(capture: Erp5SourceCapture, options: { includeAll?: boolean } = {}): SnapshotProduct[] {
  const out: SnapshotProduct[] = [];
  for (const raw of capture.collections.products.documents) {
    const doc = decodeDoc(raw);
    if (!doc || !doc.id) continue;
    const item = snapshotProductOf(doc.id, doc.fields, options.includeAll === true);
    if (item) out.push(item);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 평문 문서 목록({ id, data })에서 만든다 — 봉인 캡처가 없을 때(운영 읽기 전용 덤프). 전체 번호는 끝 4자리로만 싣는다. */
export function identityProductsFromPlainDocs(docs: ReadonlyArray<{ id: string; data: Record<string, unknown> }>, options: { includeAll?: boolean } = {}): SnapshotProduct[] {
  const out: SnapshotProduct[] = [];
  for (const doc of docs) {
    if (!doc || typeof doc.id !== 'string' || !doc.id || !object(doc.data)) continue;
    const item = snapshotProductOf(doc.id, doc.data, options.includeAll === true);
    if (item) out.push(item);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function identityMastersFromSnapshot(snapshot: Pick<VehicleMasterSnapshot, 'masters' | 'trims'>): SnapshotMaster[] {
  const trimsBy = new Map<string, Rec[]>();
  for (const t of snapshot.trims) {
    if (t.data.retired === true || typeof t.data.master_id !== 'string') continue;
    (trimsBy.get(t.data.master_id) ?? trimsBy.set(t.data.master_id, []).get(t.data.master_id)!).push(t.data);
  }
  const year = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) ? v : typeof v === 'string' && /^\d{4}$/.test(v) ? Number(v) : null;
  return snapshot.masters.filter(m => m.data.retired !== true && str(m.data.sub_model)).map(m => {
    const trims = trimsBy.get(m.id) ?? [];
    // 연식 범위 근거: 마스터 자체의 year_start/year_end 가 있으면 먼저, 없으면 트림의 model_year_start/end(구) 또는 production_start/end(신 생성 스키마).
    // 값이 없으면 제한 없음(연식으로 좁히지 않을 뿐 — 후보를 지어내지 않는다). «현재»는 끝 제한 없음.
    const open = (v: unknown) => typeof v === 'string' && v.trim() === '현재';
    const yearPrefix = (v: unknown) => year(typeof v === 'string' ? v.trim().slice(0, 4) : v);
    const masterFrom = yearPrefix(m.data.year_start), masterToOpen = open(m.data.year_end), masterTo = yearPrefix(m.data.year_end);
    const starts = trims.map(t => year(t.model_year_start) ?? yearPrefix(t.production_start)).filter((y): y is number => y !== null);
    const ends = trims.map(t => (t.model_year_end === '현재' || open(t.production_end)) ? null : (year(t.model_year_end) ?? yearPrefix(t.production_end)));
    return { id: m.id, maker: str(m.data.maker), model: str(m.data.model), sub_model: str(m.data.sub_model),
      model_aliases: strings(m.data.model_aliases), sub_model_aliases: strings(m.data.sub_model_aliases),
      // 세대 연식 범위: 트림 시작 연식의 최소~끝 연식의 최대(하나라도 «현재»·없음이면 끝 제한 없음). 트림 연식이 없으면 제한 없음.
      yearFrom: masterFrom !== null ? masterFrom : starts.length ? Math.min(...starts) : null,
      yearTo: masterToOpen ? null : masterTo !== null ? masterTo : !ends.length || ends.some(e => e === null) ? null : Math.max(...(ends as number[])),
      // 세대 출시월·단종월(엔진 경로 generationMonths 와 같은 규칙: 트림 행 하나라도 월 근거가 없으면 둘 다 없음).
      ...monthsOf(trims),
      // 세부트림: vehicle_trim_master(master_id 로 연결, 별칭 포함)가 정본. 연결된 트림 문서가 하나도 없을 때만 마스터의 trims 문자열 목록(별칭 없음)을 쓴다.
      trims: trims.length
        ? trims.filter(t => str(t.trim)).map(t => ({ name: str(t.trim), aliases: strings(t.trim_aliases) }))
        : strings(m.data.trims).map(name => ({ name, aliases: [] as string[] })) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** 트림 행 production_start 최소 · production_end 최대(«현재» = 끝 없음). 한 행이라도 «YYYY-MM» 근거가 없으면 빈 객체(application generationMonths 와 같은 규칙). */
function monthsOf(trims: readonly Rec[]): { monthFrom?: string; monthTo?: string | null } {
  const ym = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}(?![0-9])/.test(v.trim()) ? v.trim().slice(0, 7) : null);
  if (!trims.length) return {};
  const starts = trims.map(t => ym(t.production_start)), ends = trims.map(t => (str(t.production_end) === '현재' ? 'OPEN' : ym(t.production_end)));
  if (starts.some(s => s === null) || ends.some(e => e === null)) return {};
  return { monthFrom: (starts as string[]).sort()[0]!, monthTo: ends.includes('OPEN') ? null : (ends as string[]).sort().at(-1)! };
}
