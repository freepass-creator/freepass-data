// 공급사 원본 ↔ 프리패스 데이터(products) 항목 단위 대조 — 순수 함수. CLI: scripts/supplier-field-reconcile.mjs
// 불일치 유형: MISSING_IN_DATA(원본에만 있는 차) · ONLY_IN_DATA(데이터에만 있는 차) · EMPTY_IN_DATA(원본엔 값, 데이터는 빈칸)
// · EMPTY_IN_RAW(원본 빈칸, 데이터엔 값) · FORMAT_ONLY(표기만 다름, 정규화하면 같음) · VALUE_DIFF(값이 다름) · DUPLICATE_PLATE
import { sha } from './supplier-freshness-lib.mjs';

export const DEFAULT_FIELDS = ['price', 'mileage', 'year', 'maker', 'model', 'sub_model', 'trim_name', 'fuel_type', 'ext_color',
  'first_registration_date', 'status_label_raw', 'engine_cc', 'options'];
export const MISMATCH_TYPES = ['MISSING_IN_DATA', 'ONLY_IN_DATA', 'EMPTY_IN_DATA', 'EMPTY_IN_RAW', 'FORMAT_ONLY', 'VALUE_DIFF', 'DUPLICATE_PLATE'];

export const plateKey = v => String(v ?? '').replace(/\s+/g, '').trim();
export const last4 = v => plateKey(v).slice(-4);
const isEmpty = v => v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

// 표기 차이를 걷어낸 비교 키: 공백·쉼표·단위 접미(원·km·cc), 날짜 구분자, 대소문자, 배열은 정렬 후 결합
export function normalize(v) {
  if (isEmpty(v)) return '';
  if (Array.isArray(v)) return v.map(normalize).filter(Boolean).sort().join('|');
  if (typeof v === 'object') return JSON.stringify(v);
  let s = String(v).trim();
  const date = s.match(/^(\d{4})[-./\s]?(\d{1,2})[-./\s]?(\d{1,2})/);
  if (date) return `${date[1]}${date[2].padStart(2, '0')}${date[3].padStart(2, '0')}`;
  const num = s.replace(/[,\s]/g, '').replace(/(원|km|㎞|cc|CC)$/u, '');
  if (/^-?\d+(\.\d+)?$/.test(num)) return String(Number(num));
  return s.replace(/\s+/g, '').toLowerCase();
}
const exact = v => isEmpty(v) ? '' : Array.isArray(v) ? JSON.stringify(v) : String(v).trim();

export function classifyField(rawV, dataV) {
  const re = isEmpty(rawV), de = isEmpty(dataV);
  if (re && de) return 'BOTH_EMPTY';
  if (de) return 'EMPTY_IN_DATA';
  if (re) return 'EMPTY_IN_RAW';
  if (exact(rawV) === exact(dataV)) return 'MATCH';
  return normalize(rawV) === normalize(dataV) ? 'FORMAT_ONLY' : 'VALUE_DIFF';
}

// rawRecords: [{ car_number, ...필드 }] (필드 이름은 map 으로 Firestore 이름에 맞춘 뒤). dataRecords: products 문서 필드 객체 배열.
export function reconcile(rawRecords, dataRecords, { fields = DEFAULT_FIELDS, sampleLimit = 5 } = {}) {
  const byPlate = (rows, label) => {
    const m = new Map(), dup = [];
    for (const r of rows) { const k = plateKey(r.car_number); if (!k) continue; if (m.has(k)) dup.push({ side: label, plate4: last4(k) }); else m.set(k, r); }
    return { m, dup };
  };
  const raw = byPlate(rawRecords, 'RAW'), data = byPlate(dataRecords, 'DATA');
  const types = Object.fromEntries(MISMATCH_TYPES.map(t => [t, 0]));
  const samples = Object.fromEntries(MISMATCH_TYPES.map(t => [t, []]));
  const add = (type, s) => { types[type]++; if (samples[type].length < sampleLimit) samples[type].push(s); };
  for (const d of [...raw.dup, ...data.dup]) add('DUPLICATE_PLATE', d);
  const perField = Object.fromEntries(fields.map(f => [f, { compared: 0, match: 0, formatOnly: 0, valueDiff: 0, emptyInData: 0, emptyInRaw: 0 }]));
  let both = 0;
  for (const [k, r] of raw.m) {
    const d = data.m.get(k);
    if (!d) { add('MISSING_IN_DATA', { plate4: last4(k) }); continue; }
    both++;
    for (const f of fields) {
      const c = classifyField(r[f], d[f]), pf = perField[f];
      if (c === 'BOTH_EMPTY') continue;
      pf.compared++;
      if (c === 'MATCH') pf.match++;
      else if (c === 'FORMAT_ONLY') { pf.formatOnly++; add('FORMAT_ONLY', { plate4: last4(k), field: f, raw: clip(r[f]), data: clip(d[f]) }); }
      else if (c === 'VALUE_DIFF') { pf.valueDiff++; add('VALUE_DIFF', { plate4: last4(k), field: f, raw: clip(r[f]), data: clip(d[f]) }); }
      else if (c === 'EMPTY_IN_DATA') { pf.emptyInData++; add('EMPTY_IN_DATA', { plate4: last4(k), field: f, raw: clip(r[f]) }); }
      else { pf.emptyInRaw++; add('EMPTY_IN_RAW', { plate4: last4(k), field: f, data: clip(d[f]) }); }
    }
  }
  for (const [k] of data.m) if (!raw.m.has(k)) add('ONLY_IN_DATA', { plate4: last4(k) });
  let compared = 0, matched = 0;
  for (const pf of Object.values(perField)) { compared += pf.compared; matched += pf.match + pf.formatOnly; }
  for (const f of fields) { const p = perField[f]; p.matchRate = p.compared ? (p.match + p.formatOnly) / p.compared : null; p.exactRate = p.compared ? p.match / p.compared : null; }
  return {
    rawVehicles: raw.m.size, dataVehicles: data.m.size, commonVehicles: both,
    vehicleCoverage: raw.m.size ? both / raw.m.size : null, // 원본 차량 중 데이터에 있는 비율
    fieldMatchRate: compared ? matched / compared : null, // 정규화 후 일치 / 비교한 항목
    fieldExactRate: compared ? (matched - Object.values(perField).reduce((a, p) => a + p.formatOnly, 0)) / compared : null,
    comparedFields: compared, perField, types, samples,
    digest: sha(JSON.stringify([raw.m.size, data.m.size, both, compared, matched, types])),
  };
}
const clip = v => { const s = Array.isArray(v) ? JSON.stringify(v) : String(v); return s.length > 60 ? s.slice(0, 57) + '...' : s; };
