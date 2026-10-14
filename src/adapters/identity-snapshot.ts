/** 정체성 승격 계획서 입력 만들기(읽기 전용·순수): ERP5 상품 캡처(erp5-source-capture/1) + 활성 차종 마스터 스냅샷 →
 * build-identity-promotion-plan CLI 가 받는 { products, masters, label } JSON. B3Q 가 손으로 만들던 스냅샷을 대신한다.
 * 번호는 끝 4자리만 싣는다(전체 번호·고객정보 없음). 기본 대상은 «엔진이 원문 차명으로만 편입한 문서»(vehicle_review_required 또는
 * 제조사·모델 빈칸) — 이미 사람이 정리한 문서까지 다시 대조하려면 includeAll. 퇴역 마스터·퇴역 트림은 넣지 않는다. */
import { decodeErp5Value, type Erp5SourceCapture } from './erp5-source-capture.js';
import type { VehicleMasterSnapshot } from './vehicle-identity-inputs.js';

/** build-identity-promotion-plan 입력 모양(application 의 IdentityProduct·IdentityMaster 와 같은 구조 — 어댑터는 application 에 의존하지 않는다, 호환은 시험의 대입이 지킨다). */
export type SnapshotProduct = { id: string; plate4: string; maker: string; model: string; sub_model: string; trim_name: string; rawName: string; year: string; listable: boolean };
export type SnapshotMaster = { id: string; maker: string; model: string; sub_model: string; model_aliases: string[]; sub_model_aliases: string[];
  yearFrom: number | null; yearTo: number | null; trims: Array<{ name: string; aliases: string[] }> };
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

export function identityProductsFromCapture(capture: Erp5SourceCapture, options: { includeAll?: boolean } = {}): SnapshotProduct[] {
  const out: SnapshotProduct[] = [];
  for (const raw of capture.collections.products.documents) {
    const doc = decodeDoc(raw);
    if (!doc || !doc.id) continue;
    const f = doc.fields;
    const engineRaw = f.vehicle_review_required === true || (!str(f.maker) && !str(f.model));
    if (!options.includeAll && !engineRaw) continue;
    const original = object(f.원문) ? f.원문 : {};
    out.push({ id: doc.id, plate4: str(f.car_number).replace(/\D/g, '').slice(-4),
      maker: str(f.maker), model: str(f.model), sub_model: str(f.sub_model), trim_name: str(f.trim_name),
      rawName: str(original.차명) || str(f.car_name), year: yearOf(f), listable: f.listable === true });
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
    const starts = trims.map(t => year(t.model_year_start)).filter((y): y is number => y !== null);
    const ends = trims.map(t => t.model_year_end === '현재' ? null : year(t.model_year_end));
    return { id: m.id, maker: str(m.data.maker), model: str(m.data.model), sub_model: str(m.data.sub_model),
      model_aliases: strings(m.data.model_aliases), sub_model_aliases: strings(m.data.sub_model_aliases),
      // 세대 연식 범위: 트림 시작 연식의 최소~끝 연식의 최대(하나라도 «현재»·없음이면 끝 제한 없음). 트림 연식이 없으면 제한 없음.
      yearFrom: starts.length ? Math.min(...starts) : null,
      yearTo: !ends.length || ends.some(e => e === null) ? null : Math.max(...(ends as number[])),
      trims: trims.filter(t => str(t.trim)).map(t => ({ name: str(t.trim), aliases: strings(t.trim_aliases) })) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
