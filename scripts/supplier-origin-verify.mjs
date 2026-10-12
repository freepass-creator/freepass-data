#!/usr/bin/env node
// 공급사 원천 직접 확인 — F05(공급사 입력 시트) 탭을 읽기 전용으로 직접 열어 프리패스 데이터 products 와 항목별 대조한다.
// 쓰기 없음(Sheets 읽기 + Firestore 읽기만). 차량번호는 마지막 4자리만 출력. 시트 ID 는 환경변수로만 받는다(공개 저장소에 두지 않음).
//
//   FREEPASS_SHEET_F05_ID=<F05 시트 ID> node scripts/supplier-origin-verify.mjs --supplier RP021 [--json] [--out 결과.json]
//   FREEPASS_SHEET_F05_ID=… node scripts/supplier-origin-verify.mjs --all [--out-dir 폴더]      (F05 공급사 전수, 느려도 순서대로)
//   --report-line  점검 리포트에 붙일 한 줄 JSON(공급사별 요약)만 출력
// F05 에 없는 공급사(API·홈페이지·개별 시트)는 이 도구가 아니라 각 전담 세션의 읽기 도구 + supplier-field-reconcile.mjs 로 대조한다.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeValue } from './supplier-freshness-lib.mjs';
import { reconcile, MISMATCH_TYPES, makeCauseClassifier, CAUSES } from './supplier-field-reconcile-lib.mjs';

const spec = JSON.parse(readFileSync(new URL('../contracts/supplier-input-sheet-spec.v1.json', import.meta.url), 'utf8'));
const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
const F05 = process.env.FREEPASS_SHEET_F05_ID;
const AICA = process.env.FREEPASS_AICA_SHEET_ID; // 아이카 별도 원본 시트(대표 10-12: 재고가 수시로 바뀌어 매번 직접 읽는다)

// F05 탭 머리글 → 프리패스 데이터 칸. 점 경로는 products 문서 안의 중첩 값.
export const HEADER_TO_FIELD = {
  차량번호: 'car_number', 제조사: 'maker', 모델: 'model', 세부모델: 'sub_model', 세부트림: 'trim_name', 외부색상: 'ext_color',
  연식: 'year', 주행거리: 'mileage', 배기량: 'engine_cc', 연료: 'fuel_type', 최초등록일: 'first_registration_date',
  차량상태: 'status_label_raw', '옵션 원문': 'options', '차명 원문': '원문.차명',
};
// 기간별 월대여료/보증금: 1·6개월은 단기보증, 12개월 이상은 장기보증을 보증금 후보로 대조(맞지 않으면 «보증금» 불일치로 드러난다)
export const PERIODS = { '1개월': '1', '6개월': '6', '12개월': '12', '24개월': '24', '36개월': '36', '48개월': '48', '60개월': '60' };
const FIELDS = [...Object.values(HEADER_TO_FIELD).filter(f => f !== 'car_number'),
  ...Object.values(PERIODS).flatMap(p => [`price.${p}.rent`, `price.${p}.deposit`])];

const pick = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function gwsBin() {
  if (process.env.GWS_BIN) return process.env.GWS_BIN;
  if (process.platform !== 'win32') return 'gws';
  const where = execFileSync('where', ['gws.cmd'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  const m = readFileSync(where, 'utf8').match(/"([^"]+gws\.exe)"/);
  if (!m) throw new Error('GWS_BIN_NOT_FOUND');
  return m[1];
}
function readTab(tab, sheetId = F05) {
  const out = execFileSync(gwsBin(), ['sheets', '+read', '--spreadsheet', sheetId, '--range', `'${tab}'!A1:BX3000`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.slice(out.indexOf('{'))).values ?? [];
}

// 탭 머리글 행 + 데이터 행 → 대조용 원본 레코드(칸 이름은 프리패스 데이터 기준). companyName 이 있으면 회사명 칸으로 거른다.
export function f05Records(values, companyName) {
  const [head = [], ...rows] = values;
  const idx = Object.fromEntries(head.map((h, i) => [h, i]));
  const get = (r, h) => (idx[h] == null ? '' : (r[idx[h]] ?? ''));
  const out = [];
  for (const r of rows) {
    if (!String(get(r, '차량번호')).trim()) continue;
    if (companyName && String(get(r, '회사명')).trim() !== companyName) continue;
    const rec = {};
    for (const [h, f] of Object.entries(HEADER_TO_FIELD)) rec[f] = get(r, h);
    for (const [h, p] of Object.entries(PERIODS)) {
      rec[`price.${p}.rent`] = get(r, h);
      rec[`price.${p}.deposit`] = String(get(r, h)).trim() ? get(r, Number(p) <= 6 ? '단기보증' : '장기보증') : ''; // 그 기간 대여료가 없으면 보증금도 비교하지 않는다
    }
    out.push(rec);
  }
  return out;
}

function tabTitles() {
  const out = execFileSync(gwsBin(), ['sheets', 'spreadsheets', 'get', '--params', JSON.stringify({ spreadsheetId: F05, fields: 'sheets(properties(title))' })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return new Set(JSON.parse(out.slice(out.indexOf('{'))).sheets.map(x => x.properties.title));
}

// 아이카 원본 시트 탭(재고 3탭) 머리글 → 프리패스 데이터 칸. 월렌트=1개월, 장기보증=보증금(기간 공통).
export const AICA_TABS = ['중고재렌트', '장기특별이벤트', '신차선출고'];
export const AICA_HEADER_TO_FIELD = { 차량번호: 'car_number', 제조사: 'maker', 연료: 'fuel_type', 외장: 'ext_color', 내장: 'int_color', Km: 'mileage', 최초등록: 'first_registration_date',
  배기량: 'engine_cc', 배차상태: 'status_label_raw', 옵션: 'options' };
export function aicaRecords(values) {
  const hi = values.findIndex(r => r.includes('차량번호'));
  if (hi < 0) return [];
  const head = values[hi], idx = Object.fromEntries(head.map((h, i) => [h, i]));
  const get = (r, h) => (idx[h] == null ? '' : (r[idx[h]] ?? ''));
  const out = [];
  for (const r of values.slice(hi + 1)) {
    if (!String(get(r, '차량번호')).trim()) continue;
    const rec = {};
    for (const [h, f] of Object.entries(AICA_HEADER_TO_FIELD)) rec[f] = get(r, h);
    rec['price.1.rent'] = get(r, '월렌트');
    for (const [h, p] of [['36개월', '36'], ['48개월', '48'], ['60개월', '60']]) rec[`price.${p}.rent`] = get(r, h);
    for (const p of ['1', '36', '48', '60']) rec[`price.${p}.deposit`] = (String(rec[`price.${p}.rent`]).trim() && String(rec[`price.${p}.rent`]).trim() !== '-') ? get(r, '장기보증') : '';
    out.push(rec);
  }
  return out;
}
const AICA_FIELDS = [...Object.values(AICA_HEADER_TO_FIELD).filter(f => f !== 'car_number' && f !== 'int_color'),
  ...['1', '36', '48', '60'].flatMap(p => [`price.${p}.rent`, `price.${p}.deposit`])];

// ProductDossier/v1 (contracts/product-dossier-v1.schema.json) → products 문서 모양. 입력: 배열 또는 JSONL 아님(배열/{dossiers:[…]}).
// path: product.<칸> → <칸>, priceRow[source:N].monthlyRent|deposit → price.N.rent|deposit. rawValue + rawRef.rawPath 의 마지막 이름 → 원문.전체[이름](저장된 원문).
export function dossierToProduct(d) {
  if (d?.schema !== 'ProductDossier/v1' || !(d.plate || d.productId)) return null;
  // 최상위 plate·supplierCode·listable 사용(스키마 b6430537 이후). 없으면 productId·fields·status 로 대체.
  const doc = { car_number: d.plate || d.productId, listable: typeof d.listable === 'boolean' ? d.listable : d.status === 'OK', price: {}, 원문: { 전체: {} }, __dossierAsOf: {} };
  if (d.supplierCode) doc.provider_company_code = d.supplierCode;
  let photos = 0;
  for (const f of d.fields ?? []) {
    const price = f.path.match(/^priceRow\[source:(\d+)\]\.(monthlyRent|deposit)$/);
    const prod = f.path.match(/^product\.(.+)$/);
    if (price) (doc.price[price[1]] ??= {})[price[2] === 'monthlyRent' ? 'rent' : 'deposit'] = f.normalizedValue;
    else if (prod) doc[prod[1]] = f.normalizedValue;
    else if (f.path === 'photo.count') photos += Number(f.normalizedValue) || 0;
    else if (f.path === 'photo.urls' || f.group === 'PHOTO') photos += Array.isArray(f.normalizedValue) ? f.normalizedValue.length : (typeof f.normalizedValue === 'string' && f.normalizedValue ? 1 : 0);
    if (f.rawRef?.supplierCode) doc.provider_company_code ??= f.rawRef.supplierCode;
    if (f.rawValue !== undefined && f.rawRef?.rawPath) doc.원문.전체[f.rawRef.rawPath.split('.').pop()] = f.rawValue;
    doc.__dossierAsOf[f.path] = f.asOf;
  }
  if (photos) doc.image_urls = new Array(photos).fill('');
  return doc;
}

async function readProducts(token) {
  if (opt('dossier-json')) {
    const j = JSON.parse(readFileSync(opt('dossier-json'), 'utf8'));
    return (Array.isArray(j) ? j : (j.dossiers ?? [])).map(dossierToProduct).filter(Boolean);
  }
  if (opt('data-json')) { // 상품 전수 조회(읽기) 출력 JSON: 배열 또는 {products:[...]} — 각 항목은 products 문서 필드(디코딩된 값)
    const j = JSON.parse(readFileSync(opt('data-json'), 'utf8'));
    return Array.isArray(j) ? j : (j.products ?? j.items ?? []);
  }
  const out = []; let pageToken = '';
  const top = ['car_number', 'provider_company_code', 'partner_code', 'listable', 'maker', 'model', 'sub_model', 'trim_name', 'ext_color', 'year', 'mileage',
    'engine_cc', 'int_color', 'fuel_type', 'first_registration_date', 'status_label_raw', 'options', 'price', '원문', 'sheet_source_tab', 'source'];
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/products?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`FIRESTORE_READ_${res.status}`);
    const body = await res.json();
    for (const d of body.documents ?? []) out.push(Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, decodeValue(v)])));
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return out;
}
const flatten = d => ({ __orig: d, car_number: d.car_number, listable: d.listable === true, ...Object.fromEntries([...new Set([...FIELDS, ...AICA_FIELDS])].map(f => [f, pick(d, f)])) });

// 칸 → 원천 머리글(데이터의 원문.전체 에 보존된 원천 행에서 같은 머리글을 찾아 «저장된 원문»을 얻는다)
const f05Header = f => {
  const inv = Object.fromEntries(Object.entries(HEADER_TO_FIELD).map(([h, x]) => [x, h]));
  const m = f.match(/^price\.(\d+)\.(rent|deposit)$/);
  if (m) return m[2] === 'rent' ? m[1] + '개월' : (Number(m[1]) <= 6 ? '단기보증' : '장기보증');
  return f === '원문.차명' ? '차명 원문' : inv[f];
};
const aicaHeader = f => {
  const inv = Object.fromEntries(Object.entries(AICA_HEADER_TO_FIELD).map(([h, x]) => [x, h]));
  const m = f.match(/^price\.(\d+)\.(rent|deposit)$/);
  if (m) return m[2] === 'deposit' ? '장기보증' : (m[1] === '1' ? '월렌트' : m[1] + '개월');
  return inv[f];
};
const storedFor = headerOf => (d, field) => {
  const h = field && headerOf(field); if (!h) return undefined;
  const o = d?.__orig?.원문; if (!o) return undefined;
  if (String(h).includes('.')) { const v = pick(o, h); return v; } // 점 경로: 원문 안 경로(예 전체.월렌트, 사진)
  const row = o.전체; return row && h in row ? row[h] : undefined;
};

// 전 필드 완전성 — 데이터가 가진 상품별 칸(기본·제원·상태·가격 행·보증금·사진 수·정책 연결·원문)의 채움률
const COMPLETENESS = { 기본: ['maker', 'model', 'sub_model', 'trim_name', 'year', 'ext_color'], 제원: ['engine_cc', 'fuel_type', 'seats', 'first_registration_date', 'mileage'],
  상태: ['status', 'status_label_raw', 'vehicle_status'], 정책연결: ['policy_code'], 식별: ['vehicle_uid'] };
export function completeness(listableDocs) {
  const n = listableDocs.length, empty = v => v == null || v === '' || (Array.isArray(v) && !v.length);
  const out = { listable: n, fields: {} };
  for (const [group, fs_] of Object.entries(COMPLETENESS)) for (const f of fs_) out.fields[`${group}.${f}`] = n ? listableDocs.filter(d => !empty(d[f])).length / n : null;
  const rows = d => Object.values(d.price ?? {}).filter(x => x && Number(x.rent) > 0);
  out.fields['가격.행있음'] = n ? listableDocs.filter(d => rows(d).length > 0).length / n : null;
  out.fields['가격.보증금있음'] = n ? listableDocs.filter(d => rows(d).some(x => Number(x.deposit) > 0)).length / n : null;
  out.fields['원문.보존'] = n ? listableDocs.filter(d => d.원문 && Object.keys(d.원문.전체 ?? {}).length > 0).length / n : null;
  const photos = d => (Array.isArray(d.image_urls) ? d.image_urls.length : 0) + (d.photo_link ? 1 : 0);
  out.photoCountZero = listableDocs.filter(d => photos(d) === 0).length;
  out.photoCountAvg = n ? listableDocs.reduce((a, d) => a + photos(d), 0) / n : null;
  return out;
}

export function f05Suppliers() { return spec.supplierChannels.sharedInputSheet.map(x => ({ code: x.code, tab: x.tab, companyName: x.companyName })); }

const summarize = (code, tab, r, t0) => ({ supplier: code, tab, conditionMismatchVehicles: r.conditionMismatchVehicles, conditionMismatchByType: r.conditionMismatchByType, causes: r.causes, topReasons: r.topReasons, fixCandidateCount: r.fixCandidates?.length ?? 0, rawColumn: r.rawColumn, photoCountZero: r.dataCompleteness?.photoCountZero, sourceReadAt: r.sourceReadAt, dataReadAt: r.dataReadAt, listableTotal: r.listableTotal, listableNotInSource: r.listableNotInSource, seconds: Math.round((Date.now() - t0) / 100) / 10, rawVehicles: r.rawVehicles, dataVehicles: r.dataVehicles,
  commonVehicles: r.commonVehicles, vehicleCoverage: r.vehicleCoverage, fieldMatchRate: r.fieldMatchRate, fieldExactRate: r.fieldExactRate, types: r.types,
  worstFields: Object.entries(r.perField).filter(([, p]) => p.compared).map(([f, p]) => ({ field: f, compared: p.compared, matchRate: p.matchRate }))
    .sort((a, b) => a.matchRate - b.matchRate).slice(0, 5) });

async function main() {
  const rawJson = opt('raw-json') && opt('supplier') ? { code: opt('supplier'), tab: '원천 JSON', rawJson: true } : null;
  const wantAica = !rawJson && (argv.includes('--all') || opt('supplier') === 'RP004');
  const f05Targets = rawJson ? [] : argv.includes('--all') ? f05Suppliers() : f05Suppliers().filter(x => x.code === opt('supplier'));
  if (f05Targets.length && !F05) { console.error('FREEPASS_SHEET_F05_ID 환경변수 필요(시트 ID 는 비공개 문서에서)'); process.exit(2); }
  if (wantAica && !AICA) { console.error('FREEPASS_AICA_SHEET_ID 환경변수 필요'); process.exit(2); }
  const targets = rawJson ? [rawJson] : [...(wantAica ? [{ code: 'RP004', tab: '아이카 별도 시트', aica: true }] : []), ...f05Targets]; // 확인 순서: 아이카 → 공통 시트 공급사
  if (!targets.length) { console.error('F05 에 없는 공급사이거나 --supplier/--all 누락. F05 공급사: ' + f05Suppliers().map(x => x.code).join(',')); process.exit(2); }
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  const products = await readProducts(token);
  const tabCache = new Map(), results = [], titles = f05Targets.length ? tabTitles() : new Set();
  const dataReadAt = new Date().toISOString();
  for (const t of targets) {
    const t0 = Date.now();
    if (!t.aica && !t.rawJson && !titles.has(t.tab)) { // 규격엔 있으나 F05 에 탭이 없는 공급사 — 원천 없음으로 표시하고 계속
      results.push({ rep: { supplier: t.code, tab: t.tab, status: 'TAB_ABSENT_IN_F05' }, sum: { supplier: t.code, tab: t.tab, status: 'TAB_ABSENT_IN_F05', seconds: 0, rawVehicles: 0, dataVehicles: products.filter(p => (p.provider_company_code || p.partner_code) === t.code).length, types: Object.fromEntries(MISMATCH_TYPES.map(m => [m, 0])) } });
      continue;
    }
    let raw, fields = FIELDS;
    const readStarted = new Date().toISOString();
    let headerOf = t.aica ? aicaHeader : f05Header;
    if (t.rawJson) {
      const map = JSON.parse(readFileSync(opt('map'), 'utf8')), stored = opt('stored-map') ? JSON.parse(readFileSync(opt('stored-map'), 'utf8')) : {};
      const rows = JSON.parse(readFileSync(opt('raw-json'), 'utf8'));
      raw = (Array.isArray(rows) ? rows : rows.items ?? rows.vehicles ?? rows.records ?? []).map(r => Object.fromEntries(Object.entries(map).map(([f, k]) => [f, pick(r, k)])));
      fields = Object.keys(map).filter(f => f !== 'car_number');
      headerOf = f => stored[f];
    } else if (t.aica) { raw = AICA_TABS.flatMap(tab => aicaRecords(readTab(tab, AICA))); fields = AICA_FIELDS; }
    if (!t.rawJson && !t.aica) {
      if (!tabCache.has(t.tab)) tabCache.set(t.tab, readTab(t.tab));
      const sharedTab = f05Suppliers().filter(x => x.tab === t.tab).length > 1;
      raw = f05Records(tabCache.get(t.tab), sharedTab ? t.companyName : undefined);
    }
    const data = products.filter(p => (p.provider_company_code || p.partner_code) === t.code).map(d => ({ ...flatten(d), ...Object.fromEntries(fields.map(f => [f, pick(d, f)])) }));
    const rawPlates = new Set(raw.map(r => String(r.car_number).replace(/s+/g, '')));
    const listableNotInSource = data.filter(d => d.listable && !rawPlates.has(String(d.car_number).replace(/s+/g, ''))).length;
    const cause = makeCauseClassifier({ storedRaw: storedFor(headerOf) });
    const rep = { supplier: t.code, tab: t.tab, sourceReadAt: readStarted, dataReadAt, listableTotal: data.filter(d => d.listable).length, listableNotInSource, observedAt: new Date().toISOString(),
      dataCompleteness: completeness(data.filter(d => d.listable).map(d => d.__orig)), ...reconcile(raw, data, { fields, cause, storedRaw: storedFor(headerOf) }) };
    results.push({ rep, sum: summarize(t.code, t.tab, rep, t0) });
    if (opt('out-dir')) { mkdirSync(opt('out-dir'), { recursive: true }); writeFileSync(join(opt('out-dir'), `${t.code}.json`), JSON.stringify(rep, null, 2)); }
  }
  if (opt('out') && results.length === 1) writeFileSync(opt('out'), JSON.stringify(results[0].rep, null, 2));
  if (argv.includes('--report-line')) { console.log(JSON.stringify({ kind: 'supplier-origin-verify/v1', observedAt: new Date().toISOString(), suppliers: results.map(r => r.sum) })); return; }
  if (argv.includes('--json')) { console.log(JSON.stringify(results.map(r => r.rep), null, 2)); return; }
  const pct = n => n == null ? '-' : (n * 100).toFixed(1) + '%';
  console.log('공급사 | 탭 | 원천 | 데이터 | 공통 | 차량포함률 | 항목일치율 | ' + MISMATCH_TYPES.join(' | ') + ' | 판매중 | 원천없는판매중 | 원천읽은시각 | 초');
  for (const { sum: s } of results) console.log(s.status ? [s.supplier, s.tab, s.status, '데이터', s.dataVehicles].join(' | ') : [s.supplier, s.tab, s.rawVehicles, s.dataVehicles, s.commonVehicles, pct(s.vehicleCoverage), pct(s.fieldMatchRate), ...MISMATCH_TYPES.map(t => s.types[t]), s.listableTotal, s.listableNotInSource, s.sourceReadAt, s.seconds].join(' | '));
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) await main();
