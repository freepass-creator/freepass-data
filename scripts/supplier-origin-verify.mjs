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
import { reconcile, MISMATCH_TYPES } from './supplier-field-reconcile-lib.mjs';

const spec = JSON.parse(readFileSync(new URL('../contracts/supplier-input-sheet-spec.v1.json', import.meta.url), 'utf8'));
const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
const F05 = process.env.FREEPASS_SHEET_F05_ID;

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
function readTab(tab) {
  const out = execFileSync(gwsBin(), ['sheets', '+read', '--spreadsheet', F05, '--range', `'${tab}'!A1:BX3000`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
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

async function readProducts(token) {
  const out = []; let pageToken = '';
  const top = ['car_number', 'provider_company_code', 'partner_code', 'listable', 'maker', 'model', 'sub_model', 'trim_name', 'ext_color', 'year', 'mileage',
    'engine_cc', 'fuel_type', 'first_registration_date', 'status_label_raw', 'options', 'price', '원문', 'sheet_source_tab', 'source'];
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    for (const f of top) q.append('mask.fieldPaths', /^[A-Za-z_][A-Za-z0-9_]*$/.test(f) ? f : '`' + f + '`');
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/products?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`FIRESTORE_READ_${res.status}`);
    const body = await res.json();
    for (const d of body.documents ?? []) out.push(Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, decodeValue(v)])));
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return out;
}
const flatten = d => ({ car_number: d.car_number, ...Object.fromEntries(FIELDS.map(f => [f, pick(d, f)])) });

export function f05Suppliers() { return spec.supplierChannels.sharedInputSheet.map(x => ({ code: x.code, tab: x.tab, companyName: x.companyName })); }

const summarize = (code, tab, r, t0) => ({ supplier: code, tab, seconds: Math.round((Date.now() - t0) / 100) / 10, rawVehicles: r.rawVehicles, dataVehicles: r.dataVehicles,
  commonVehicles: r.commonVehicles, vehicleCoverage: r.vehicleCoverage, fieldMatchRate: r.fieldMatchRate, fieldExactRate: r.fieldExactRate, types: r.types,
  worstFields: Object.entries(r.perField).filter(([, p]) => p.compared).map(([f, p]) => ({ field: f, compared: p.compared, matchRate: p.matchRate }))
    .sort((a, b) => a.matchRate - b.matchRate).slice(0, 5) });

async function main() {
  if (!F05) { console.error('FREEPASS_SHEET_F05_ID 환경변수 필요(시트 ID 는 비공개 문서에서)'); process.exit(2); }
  const targets = argv.includes('--all') ? f05Suppliers() : f05Suppliers().filter(x => x.code === opt('supplier'));
  if (!targets.length) { console.error('F05 에 없는 공급사이거나 --supplier/--all 누락. F05 공급사: ' + f05Suppliers().map(x => x.code).join(',')); process.exit(2); }
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  const products = await readProducts(token);
  const tabCache = new Map(), results = [], titles = tabTitles();
  for (const t of targets) {
    const t0 = Date.now();
    if (!titles.has(t.tab)) { // 규격엔 있으나 F05 에 탭이 없는 공급사 — 원천 없음으로 표시하고 계속
      results.push({ rep: { supplier: t.code, tab: t.tab, status: 'TAB_ABSENT_IN_F05' }, sum: { supplier: t.code, tab: t.tab, status: 'TAB_ABSENT_IN_F05', seconds: 0, rawVehicles: 0, dataVehicles: products.filter(p => (p.provider_company_code || p.partner_code) === t.code).length, types: Object.fromEntries(MISMATCH_TYPES.map(m => [m, 0])) } });
      continue;
    }
    if (!tabCache.has(t.tab)) tabCache.set(t.tab, readTab(t.tab));
    const sharedTab = f05Suppliers().filter(x => x.tab === t.tab).length > 1;
    const raw = f05Records(tabCache.get(t.tab), sharedTab ? t.companyName : undefined);
    const data = products.filter(p => (p.provider_company_code || p.partner_code) === t.code).map(flatten);
    const rep = { supplier: t.code, tab: t.tab, observedAt: new Date().toISOString(), ...reconcile(raw, data, { fields: FIELDS }) };
    results.push({ rep, sum: summarize(t.code, t.tab, rep, t0) });
    if (opt('out-dir')) { mkdirSync(opt('out-dir'), { recursive: true }); writeFileSync(join(opt('out-dir'), `${t.code}.json`), JSON.stringify(rep, null, 2)); }
  }
  if (opt('out') && results.length === 1) writeFileSync(opt('out'), JSON.stringify(results[0].rep, null, 2));
  if (argv.includes('--report-line')) { console.log(JSON.stringify({ kind: 'supplier-origin-verify/v1', observedAt: new Date().toISOString(), suppliers: results.map(r => r.sum) })); return; }
  if (argv.includes('--json')) { console.log(JSON.stringify(results.map(r => r.rep), null, 2)); return; }
  const pct = n => n == null ? '-' : (n * 100).toFixed(1) + '%';
  console.log('공급사 | 탭 | 원천 | 데이터 | 공통 | 차량포함률 | 항목일치율 | ' + MISMATCH_TYPES.join(' | ') + ' | 초');
  for (const { sum: s } of results) console.log(s.status ? [s.supplier, s.tab, s.status, '데이터', s.dataVehicles].join(' | ') : [s.supplier, s.tab, s.rawVehicles, s.dataVehicles, s.commonVehicles, pct(s.vehicleCoverage), pct(s.fieldMatchRate), ...MISMATCH_TYPES.map(t => s.types[t]), s.seconds].join(' | '));
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) await main();
