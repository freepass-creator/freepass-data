// 공급사 원본 ↔ 프리패스 데이터(products) 항목 단위 대조 — 순수 함수. CLI: scripts/supplier-field-reconcile.mjs
// 불일치 유형: MISSING_IN_DATA(원본에만 있는 차) · ONLY_IN_DATA(데이터에만 있는 차) · EMPTY_IN_DATA(원본엔 값, 데이터는 빈칸)
// · EMPTY_IN_RAW(원본 빈칸, 데이터엔 값) · FORMAT_ONLY(표기만 다름, 정규화하면 같음) · VALUE_DIFF(값이 다름) · DUPLICATE_PLATE
import { sha } from './supplier-freshness-lib.mjs';

export const DEFAULT_FIELDS = ['price', 'mileage', 'year', 'maker', 'model', 'sub_model', 'trim_name', 'fuel_type', 'ext_color',
  'first_registration_date', 'status_label_raw', 'engine_cc', 'options'];
export const NEAR_TOLERANCE = { engine_cc: 0.06 }; // 배기량 반올림(3,500↔3470) 허용 비율
export const MISMATCH_TYPES = ['MISSING_IN_DATA', 'ONLY_IN_DATA', 'EMPTY_IN_DATA', 'EMPTY_IN_RAW', 'FORMAT_ONLY', 'NEAR_NUMERIC', 'VALUE_DIFF', 'DUPLICATE_PLATE'];

export const plateKey = v => String(v ?? '').replace(/\s+/g, '').trim();
export const last4 = v => plateKey(v).slice(-4);
const isEmpty = v => v == null || (typeof v === 'string' && (v.trim() === '' || v.trim() === '-')) || (Array.isArray(v) && v.length === 0);

// 표기 차이를 걷어낸 비교 키: 공백·쉼표·단위 접미(원·km·cc), 날짜 구분자, 대소문자, 배열은 정렬 후 결합
export function normalize(v) {
  if (isEmpty(v)) return '';
  if (Array.isArray(v)) return v.map(normalize).filter(Boolean).sort().join('|');
  if (typeof v === 'object') return stableJson(v);
  let s = String(v).trim();
  const num = s.replace(/[,\s]/g, '').replace(/(원|km|㎞|cc|CC)$/u, '');
  if (/^-?\d+(\.\d+)?$/.test(num)) return String(Number(num)); // 숫자가 먼저: 1,300,000 = 1300000 (날짜로 오해하지 않는다)
  const date = s.match(/^(\d{2}|\d{4})[-./\s](\d{1,2})(?:[-./\s](\d{1,2}))?$/);
  if (date) return `${date[1].length === 2 ? '20' + date[1] : date[1]}${date[2].padStart(2, '0')}${date[3] ? date[3].padStart(2, '0') : ''}`;
  return s.replace(/\s+/g, '').toLowerCase();
}
const stableJson = v => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
const exact = v => isEmpty(v) ? '' : (Array.isArray(v) || typeof v === 'object') ? stableJson(v) : String(v).trim(); // 객체를 String() 으로 비교하면 모두 [object Object] 로 같아진다

// 정상 정리 변환(별칭): 원천 표기를 우리 표준 이름으로 바꾸는 것은 오류가 아니다. 키는 normalize() 결과.
export const ALIASES = {
  fuel_type: { hev: '하이브리드', 'hev(하이브리드)': '하이브리드', phev: '플러그인하이브리드', ev: '전기', 전기차: '전기', 가솔린: '가솔린', 휘발유: '가솔린', 경유: '디젤', lpg: 'lpg', lpi: 'lpg' },
  ext_color: { 검정색: '블랙', 검정: '블랙', 흰색: '화이트', 하얀색: '화이트', 은색: '실버', 회색: '그레이', 쥐색: '그레이', 진주색: '화이트', 빨간색: '레드', 파란색: '블루' },
};
const depositAlias = (field, v) => (/\.deposit$/.test(field ?? '') && normalize(v) === '무보증' ? '0' : null);
const BASE_COLORS = ['블랙', '화이트', '실버', '그레이', '블루', '레드', '브라운', '베이지', '그린', '골드', '오렌지', '옐로우', '퍼플'];
function aliased(field, v) {
  const n = normalize(v);
  if (field === 'ext_color') { // «어비스 블랙펄»·«스노우화이트펄(미색)» 처럼 기본 색 이름을 품은 표기는 기본 색으로 정리된 것으로 본다
    const hit = BASE_COLORS.find(c => n.replace(/\(.*?\)/g, '').includes(c));
    if (hit) return hit;
  }
  return depositAlias(field, v) ?? ALIASES[field]?.[n] ?? n;
}

export function classifyField(rawV, dataV, field) {
  const re = isEmpty(rawV), de = isEmpty(dataV);
  if (re && de) return 'BOTH_EMPTY';
  if (de && depositAlias(field, rawV) === '0') return 'MATCH'; // 원천 «무보증» = 데이터 보증금 없음
  if (de) return 'EMPTY_IN_DATA';
  if (re) return 'EMPTY_IN_RAW';
  if (exact(rawV) === exact(dataV)) return 'MATCH';
  if (normalize(rawV) === normalize(dataV) || aliased(field, rawV) === aliased(field, dataV)) return 'FORMAT_ONLY';
  const tol = NEAR_TOLERANCE[field], a = Number(normalize(rawV)), b = Number(normalize(dataV));
  if (tol && a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) <= tol) return 'NEAR_NUMERIC';
  return 'VALUE_DIFF';
}

// rawRecords: [{ car_number, ...필드 }] (필드 이름은 map 으로 Firestore 이름에 맞춘 뒤). dataRecords: products 문서 필드 객체 배열.
export function reconcile(rawRecords, dataRecords, { fields = DEFAULT_FIELDS, sampleLimit = 5, cause = null, fixLimit = 300, storedRaw = null } = {}) {
  const byPlate = (rows, label) => {
    const m = new Map(), dup = [];
    for (const r of rows) { const k = plateKey(r.car_number); if (!k) continue; if (m.has(k)) dup.push({ side: label, plate4: last4(k) }); else m.set(k, r); }
    return { m, dup };
  };
  const raw = byPlate(rawRecords, 'RAW'), data = byPlate(dataRecords, 'DATA');
  const types = Object.fromEntries(MISMATCH_TYPES.map(t => [t, 0]));
  const samples = Object.fromEntries(MISMATCH_TYPES.map(t => [t, []]));
  const causes = Object.fromEntries(CAUSES.map(c => [c, 0])), reasons = new Map(), fixCandidates = [];
  const rawColumn = { compared: 0, stale: 0, staleWhileRefinedMatches: 0, perField: {} }; // 원문 칸 ↔ 원천, 정리값 ↔ 원천과 분리해 본다
  const add = (type, s, ctx = {}) => {
    types[type]++; if (samples[type].length < sampleLimit) samples[type].push(s);
    if (!cause || type === 'FORMAT_ONLY' || type === 'NEAR_NUMERIC' || type === 'DUPLICATE_PLATE') return;
    const c = cause({ type, field: ctx.field, rawRec: ctx.rawRec, dataRec: ctx.dataRec, raw: ctx.raw, data: ctx.data });
    causes[c]++;
    const key = type + '|' + (ctx.field ?? '-') + '|' + c;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
    if (c === 'REFINEMENT_ERROR' && fixCandidates.length < fixLimit) fixCandidates.push({ ...s, type, cause: c });
  };
  for (const d of [...raw.dup, ...data.dup]) add('DUPLICATE_PLATE', d);
  const perField = Object.fromEntries(fields.map(f => [f, { compared: 0, match: 0, formatOnly: 0, valueDiff: 0, emptyInData: 0, emptyInRaw: 0 }]));
  let both = 0; const priceDiff = new Set(), priceDiffByType = { VALUE_DIFF: 0, EMPTY_IN_DATA: 0, EMPTY_IN_RAW: 0 }; // 기간별 대여료·보증금(조건) 불일치 차량
  for (const [k, r] of raw.m) {
    const d = data.m.get(k);
    if (!d) { add('MISSING_IN_DATA', { plate4: last4(k) }, { rawRec: r }); continue; }
    both++;
    for (const f of fields) {
      const c = classifyField(r[f], d[f], f), pf = perField[f];
      if (storedRaw) {
        const sv = storedRaw(d, f);
        if (sv !== undefined && !(isEmpty(sv) && isEmpty(r[f]))) {
          const sc = classifyField(r[f], sv, f), stale = !(sc === 'MATCH' || sc === 'FORMAT_ONLY' || sc === 'NEAR_NUMERIC');
          const rf = (rawColumn.perField[f] ??= { compared: 0, stale: 0 });
          rawColumn.compared++; rf.compared++;
          if (stale) {
            rawColumn.stale++; rf.stale++;
            if (c === 'MATCH' || c === 'FORMAT_ONLY' || c === 'NEAR_NUMERIC') { rawColumn.staleWhileRefinedMatches++; causes.RAW_COLUMN_STALE++; const key = 'RAW_COLUMN|' + f + '|RAW_COLUMN_STALE'; reasons.set(key, (reasons.get(key) ?? 0) + 1); }
          }
        }
      }
      if (c === 'BOTH_EMPTY') continue;
      pf.compared++;
      if (f.startsWith('price.') && (c === 'VALUE_DIFF' || c === 'EMPTY_IN_DATA' || c === 'EMPTY_IN_RAW')) { priceDiff.add(k); priceDiffByType[c]++; }
      if (c === 'MATCH') pf.match++;
      else if (c === 'FORMAT_ONLY') { pf.formatOnly++; add('FORMAT_ONLY', { plate4: last4(k), field: f, raw: clip(r[f]), data: clip(d[f]) }); }
      else if (c === 'NEAR_NUMERIC') { pf.formatOnly++; add('NEAR_NUMERIC', { plate4: last4(k), field: f, raw: clip(r[f]), data: clip(d[f]) }); }
      else if (c === 'VALUE_DIFF') { pf.valueDiff++; add('VALUE_DIFF', { plate4: last4(k), field: f, raw: clip(r[f]), data: clip(d[f]) }, { field: f, rawRec: r, dataRec: d, raw: r[f], data: d[f] }); }
      else if (c === 'EMPTY_IN_DATA') { pf.emptyInData++; add('EMPTY_IN_DATA', { plate4: last4(k), field: f, raw: clip(r[f]) }, { field: f, rawRec: r, dataRec: d, raw: r[f], data: d[f] }); }
      else { pf.emptyInRaw++; add('EMPTY_IN_RAW', { plate4: last4(k), field: f, data: clip(d[f]) }, { field: f, rawRec: r, dataRec: d, raw: r[f], data: d[f] }); }
    }
  }
  for (const [k, d] of data.m) if (!raw.m.has(k)) add('ONLY_IN_DATA', { plate4: last4(k) }, { dataRec: d });
  let compared = 0, matched = 0;
  for (const pf of Object.values(perField)) { compared += pf.compared; matched += pf.match + pf.formatOnly; }
  for (const f of fields) { const p = perField[f]; p.matchRate = p.compared ? (p.match + p.formatOnly) / p.compared : null; p.exactRate = p.compared ? p.match / p.compared : null; }
  return {
    rawVehicles: raw.m.size, dataVehicles: data.m.size, commonVehicles: both,
    vehicleCoverage: raw.m.size ? both / raw.m.size : null, // 원본 차량 중 데이터에 있는 비율
    fieldMatchRate: compared ? matched / compared : null, // 정규화 후 일치 / 비교한 항목
    fieldExactRate: compared ? (matched - Object.values(perField).reduce((a, p) => a + p.formatOnly, 0)) / compared : null,
    conditionMismatchVehicles: priceDiff.size, conditionMismatchByType: priceDiffByType,
    comparedFields: compared, perField, types, samples, causes,
    rawColumn: { ...rawColumn, staleRate: rawColumn.compared ? rawColumn.stale / rawColumn.compared : null },
    topReasons: [...reasons].map(([key, n]) => { const [type, field, c] = key.split('|'); return { type, field, cause: c, count: n }; }).sort((a, b) => b.count - a.count).slice(0, 12),
    fixCandidates,
    digest: sha(JSON.stringify([raw.m.size, data.m.size, both, compared, matched, types])),
  };
}
// 값 속 차량번호는 끝 4자리만 남기고 60자로 자른다
const clip = v => { const s = (Array.isArray(v) ? JSON.stringify(v) : String(v)).replace(/\d{2,3}\s?[가-힣]\s?(\d{4})/g, '…$1'); return s.length > 60 ? s.slice(0, 57) + '...' : s; };

// ── 원인 분류 ────────────────────────────────────────────────────────────────────────────────
// COLLECTION_LAG   수집 지연: 원천은 바뀌었는데 데이터에 저장된 원문(원문.전체)이 옛 값이거나, 원천에 새로 생긴 차가 아직 없음
// REFINEMENT_ERROR 정제 오류: 저장된 원문은 현재 원천과 같은데 정리된 값이 다름 → 정제 규칙·마스터 쪽 수정 PR 후보
// SOURCE_CHANGE    원천 변경: 원천에서 차가 사라졌거나 상태가 바뀜(데이터가 판매 중으로 남아 있으면 반영 지연도 겸함)
// SOURCE_ANOMALY   원천 값 이상: 원천 값 자체가 규칙에 맞지 않음(숫자가 아닌 주행거리, 0 이하 요금 등)
// UNDETERMINED     저장된 원문이 없어 원인을 가를 수 없음
export const CAUSES = ['COLLECTION_LAG', 'REFINEMENT_ERROR', 'SOURCE_CHANGE', 'SOURCE_ANOMALY', 'RAW_COLUMN_STALE', 'UNDETERMINED'];
// RAW_COLUMN_STALE 원문 칸 낡음: 정리값은 현재 원천과 맞는데 데이터에 보존된 원문(원문.전체)만 옛 값 — 정제 오류가 아니다(손오공: 원문은 09월 백필 스냅샷)
export const REFINED_FIELDS = new Set(['maker', 'model', 'sub_model', 'trim_name']);

export function rawAnomaly(field, v) {
  if (v == null || String(v).trim() === '') return false;
  const n = Number(String(v).replace(/[,\s]/g, '').replace(/(원|km|cc)$/iu, ''));
  if (/\.deposit$/.test(field) && String(v).trim() === '무보증') return false; // 보증금 없음의 정상 표기
  if (/^price\..*\.(rent|deposit)$/.test(field)) return !Number.isFinite(n) || n < 0 || (field.endsWith('rent') && n === 0);
  if (field === 'mileage' || field === 'engine_cc') return !Number.isFinite(n) || n < 0;
  if (field === 'year') return !/^(19|20)\d{2}$/.test(String(v).trim());
  return false;
}

// opts.storedRaw(dataRec, field) → 데이터에 보존된 원천 원문값(없으면 undefined). opts.dataAgeH(dataRec) → 데이터 마지막 관측 후 경과(시간).
export function makeCauseClassifier({ storedRaw = () => undefined, dataAgeH = () => null } = {}) {
  return ({ type, field, rawRec, dataRec, raw, data }) => {
    if (type === 'MISSING_IN_DATA') return 'COLLECTION_LAG';
    if (type === 'ONLY_IN_DATA') return 'SOURCE_CHANGE';
    if (field && rawAnomaly(field, raw)) return 'SOURCE_ANOMALY';
    const stored = storedRaw(dataRec, field);
    if (stored !== undefined) {
      if (normalize(stored) !== normalize(raw)) return 'COLLECTION_LAG'; // 정리값도 원천과 다르고 원문 칸도 낡음 → 수집 지연(정리값 자체가 못 따라감) // 저장된 원문이 현재 원천과 다름 = 원천이 바뀐 뒤 아직 못 가져옴
      if (/^price\./.test(field ?? '')) return 'UNDETERMINED'; // 원문=원천인데 정리 가격이 다름: 판매가 가공 규칙인지 확인 필요(오류로 단정하지 않음)
      return REFINED_FIELDS.has(field) || type === 'VALUE_DIFF' || type === 'EMPTY_IN_DATA' ? 'REFINEMENT_ERROR' : 'UNDETERMINED';
    }
    if (REFINED_FIELDS.has(field)) return 'REFINEMENT_ERROR'; // 저장된 원문이 없는 정리 칸의 차이는 정제 후보로 본다
    return 'UNDETERMINED';
  };
}
