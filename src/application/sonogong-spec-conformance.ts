/** 손오공(RP012) 규격 일치 점검(읽기 전용·쓰기 0): 상품 문서(평문 필드) 목록 → 필드별 채움률·규격 위반 건수·대표 사례 3개(끝 4자리만).
 * 설계: docs/SONOGONG-SPEC-CONFORMANCE-20261016.md. 기준: 차종 기준 한 장(연료 8종·마스터에 없는 이름은 만들지 않음)·공급사 입력 규격·상품 스키마 값 형식.
 * 이 모듈은 문서를 바꾸지 않고, 위반 값을 «고쳐 쓰지» 않는다 — 보고만 한다(규격 검증 단계 제안은 문서 §5). */
import { MONTHLY_RENT_MAX, MONTHLY_RENT_MIN } from '../domain/source-rent-text.js';

export type ConformanceField = { field: string; label: string; total: number; filled: number; blank: number; violations: number; examples: Array<{ l4: string; value: string; why: string }> };
export type ConformanceReport = { source: string; population: number; fields: ConformanceField[] };
type Rec = Record<string, unknown>;

export const FUEL_ALLOWED: ReadonlySet<string> = new Set(['가솔린', '디젤', 'LPG', '하이브리드', '플러그인 하이브리드', '전기', '수소', '가솔린+LPG']);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const calendar = (v: string): boolean => {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]);
  if (y < 1950 || y > 2100 || mo < 1 || mo > 12) return false;
  if (m[3] === undefined) return true;
  const d = Number(m[3]), leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
};
const intIn = (v: string, min: number, max: number): boolean => /^\d{1,9}$/.test(v) && Number(v) >= min && Number(v) <= max;
const last4 = (f: Rec): string => String(f.car_number ?? '').replace(/\D/g, '').slice(-4);
const short = (v: string): string => (v.length > 30 ? `${v.slice(0, 29)}…` : v);

type Check = { field: string; label: string; read: (f: Rec) => string | null; valid: (value: string, f: Rec) => string | null };
const priceRows = (f: Rec): Array<{ months: string; rent: unknown; deposit: unknown }> => {
  const price = f.price && typeof f.price === 'object' && !Array.isArray(f.price) ? f.price as Rec : {};
  return Object.entries(price).filter(([k]) => /^\d+$/.test(k)).map(([months, v]) => {
    const row = v && typeof v === 'object' ? v as Rec : {};
    return { months, rent: row.rent, deposit: row.deposit };
  });
};
/** 필드별 점검: read = 채움 판정용 대표 값(없으면 null), valid = 규격 위반 사유(없으면 null). */
export const SONOGONG_CHECKS: readonly Check[] = [
  { field: 'maker', label: '제조사', read: f => text(f.maker) || null, valid: v => (/[_]/.test(v) || /^\d+$/.test(v) ? '원문 형태(밑줄·숫자만)' : null) },
  { field: 'model', label: '모델', read: f => text(f.model) || null, valid: v => (/[_]/.test(v) ? '원문 형태(밑줄)' : null) },
  { field: 'sub_model', label: '세부모델', read: f => text(f.sub_model) || null,
    valid: (v, f) => (/[_]/.test(v) ? '원문 형태(밑줄)' : f.vehicle_title_source === 'RAW_VEHICLE_TEXT' && v === text(f.car_name) ? '원문 차명 그대로(정제 대기)' : null) },
  { field: 'trim_name', label: '트림', read: f => text(f.trim_name) || null, valid: v => (/[_]/.test(v) ? '원문 형태(밑줄)' : null) },
  { field: 'year', label: '연식', read: f => text(f.year) || null, valid: v => (/^(19|20)\d{2}$/.test(v) ? null : '4자리 연도 아님') },
  { field: 'first_registration_date', label: '최초등록', read: f => text(f.first_registration_date) || null, valid: v => (calendar(v) ? null : '실제 날짜(YYYY-MM[-DD]) 아님') },
  { field: 'fuel_type', label: '연료', read: f => text(f.fuel_type) || null, valid: v => (FUEL_ALLOWED.has(v) ? null : '연료 목록 8종 밖') },
  { field: 'engine_cc', label: '배기량', read: f => text(f.engine_cc) || null,
    valid: (v, f) => (!/^\d{3,5}$/.test(v) ? '정수 cc 아님(리터·단위·쉼표)' : ['전기', '수소'].includes(text(f.fuel_type)) ? '전기·수소에 배기량' : null) },
  { field: 'drive_type', label: '구동', read: f => text(f.drive_type) || null, valid: () => null },
  { field: 'transmission', label: '변속기', read: f => text(f.transmission) || null, valid: () => null },
  { field: 'seats', label: '인승', read: f => text(f.seats) || null, valid: v => (intIn(v, 1, 99) ? null : '1~99 정수 아님') },
  { field: 'ext_color', label: '외장색', read: f => text(f.ext_color) || null, valid: v => (v.length <= 20 && !/\d{4,}/.test(v) ? null : '20자 초과·숫자 4자리 이상') },
  { field: 'int_color', label: '내장색', read: f => text(f.int_color) || null, valid: v => (v.length <= 20 && !/\d{4,}/.test(v) ? null : '20자 초과·숫자 4자리 이상') },
  { field: 'mileage', label: '주행거리', read: f => text(f.mileage) || null, valid: v => (intIn(v, 0, 1_000_000) ? null : '0~1,000,000 정수 아님') },
  { field: 'rent', label: '월 대여료(개월별)', read: f => (priceRows(f).some(r => text(r.rent)) ? 'present' : null),
    valid: (_v, f) => {
      const bad = priceRows(f).find(r => text(r.rent) && !(typeof r.rent === 'number' && Number.isInteger(r.rent) && r.rent >= MONTHLY_RENT_MIN && r.rent <= MONTHLY_RENT_MAX));
      return bad ? `${bad.months}개월 값이 ${MONTHLY_RENT_MIN.toLocaleString('en-US')}~${MONTHLY_RENT_MAX.toLocaleString('en-US')}원 정수 밖` : null;
    } },
  { field: 'deposit', label: '보증금(원)', read: f => (priceRows(f).some(r => text(r.deposit)) ? 'present' : null),
    valid: (_v, f) => {
      const bad = priceRows(f).find(r => text(r.deposit) && !(typeof r.deposit === 'number' && Number.isInteger(r.deposit) && r.deposit >= 0 && r.deposit <= 100_000_000)
        || (typeof r.deposit === 'number' && r.deposit > 0 && r.deposit < 10_000));
      return bad ? `${bad.months}개월 보증금이 원 단위 정수 범위 밖(0~1억, 양수는 1만원 이상)` : null;
    } },
  { field: 'product_type', label: '상품 구분', read: f => text(f.product_type) || null, valid: v => (['중고렌트', '오공구독', '픽업구독'].includes(v) ? null : '손오공 상품 구분 3종 밖') },
  { field: 'status', label: '상태', read: f => text(f.status_kind) || text(f.status) || null, valid: () => null },
  { field: 'api_options_state', label: '옵션 확인', read: f => text(f.api_options_state) || null, valid: v => (['PRESENT', 'NONE', 'NO_DETAIL'].includes(v) ? null : '옵션 상태 값 밖') },
  { field: 'image_urls', label: '사진', read: f => ((Array.isArray(f.image_urls) && f.image_urls.length) || (Array.isArray(f.photo_original_refs) && f.photo_original_refs.length) ? 'present' : null),
    valid: () => null },
];

/** 손오공 노출 문서(listable)만 모아 점검한다. 전체 번호는 보고에 싣지 않는다(끝 4자리). */
export function sonogongSpecConformance(documents: readonly Rec[], source = 'RP012'): ConformanceReport {
  const population = documents.filter(f => f.provider_company_code === source && f.listable === true);
  const fields: ConformanceField[] = SONOGONG_CHECKS.map(check => {
    const out: ConformanceField = { field: check.field, label: check.label, total: population.length, filled: 0, blank: 0, violations: 0, examples: [] };
    for (const f of population) {
      const value = check.read(f);
      if (value === null) { out.blank++; continue; }
      out.filled++;
      const why = check.valid(value, f);
      if (why) { out.violations++; if (out.examples.length < 3) out.examples.push({ l4: last4(f), value: short(value === 'present' ? '(여러 칸)' : value), why }); }
    }
    return out;
  });
  return { source, population: population.length, fields };
}

export function conformanceLines(report: ConformanceReport): string[] {
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '-');
  const lines = [`${report.source} 노출 ${report.population}대 규격 점검(읽기 전용)`];
  for (const f of report.fields) {
    lines.push(`${f.label}(${f.field}): 채움 ${f.filled}/${f.total} (${pct(f.filled, f.total)}) · 빈칸 ${f.blank} · 규격 위반 ${f.violations}`
      + (f.examples.length ? ` · 사례 ${f.examples.map(e => `${e.l4}:${e.value}(${e.why})`).join(' | ')}` : ''));
  }
  return lines;
}
