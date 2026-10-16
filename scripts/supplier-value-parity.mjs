#!/usr/bin/env node
// 공급사 원본 시트 ↔ 프리패스 데이터(products) 항목 단위 일치 점검 — 읽기 전용, AI 토큰 0.
// 사용: SUPPLIER_PARITY_SOURCES_JSON='[{"code":"RP004","label":"아이카","sheetId":"…","tabs":["중고재렌트"],"kind":"aica"},…]' node scripts/supplier-value-parity.mjs [--json] [--samples N]
// 시트 ID 는 환경변수로만 받는다(공개 저장소에 쓰지 않는다). 차량번호는 마지막 4자리만 출력한다. gcloud·gws 로그인 필요.
import { execFileSync } from 'node:child_process';
import { FIELD_MAPS, compareSupplier, decodeFields } from './supplier-value-parity-lib.mjs';

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
const sources = JSON.parse(process.env.SUPPLIER_PARITY_SOURCES_JSON ?? 'null');
if (!Array.isArray(sources) || !sources.length) { console.error('SUPPLIER_PARITY_SOURCES_JSON 필요'); process.exit(2); }
const samples = Number(process.argv[process.argv.indexOf('--samples') + 1]) || 3;
const shell = process.platform === 'win32';
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell }).trim();

function readTab(sheetId, tab) {
  const out = execFileSync('gws', ['sheets', '+read', '--spreadsheet', sheetId, '--range', `${tab}!A1:BA3000`], { encoding: 'utf8', shell, maxBuffer: 1 << 28 });
  const json = JSON.parse(out.slice(out.indexOf('{')));
  const [header, ...rows] = json.values ?? [];
  return rows.map((r, i) => ({ tab, row: i + 2, cells: Object.fromEntries(header.map((h, c) => [h, (r[c] ?? '').toString()])) }));
}
async function listProducts(code) {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/products?${q}${pageToken ? `&pageToken=${pageToken}` : ''}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`FIRESTORE_READ_${res.status}`);
    const body = await res.json();
    for (const d of body.documents ?? []) {
      const f = decodeFields(d.fields ?? {});
      if ((f.provider_company_code || f.partner_code) === code) out.push(f);
    }
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

const report = [];
for (const s of sources) {
  const map = FIELD_MAPS[s.kind];
  if (!map) throw new Error(`UNKNOWN_KIND_${s.kind}`);
  const sourceRows = s.tabs.flatMap(tab => readTab(s.sheetId, tab));
  report.push({ code: s.code, label: s.label, ...compareSupplier({ map, sourceRows, products: await listProducts(s.code), samples }) });
}
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else for (const r of report) {
  console.log(`\n== ${r.code} ${r.label} — 원본 ${r.sourceRows}행(번호 있는 ${r.sourcePlates}대) · Data ${r.dataProducts}대 · 양쪽 ${r.both} · 원본에만 ${r.onlySource.length}(끝4자리 ${r.onlySource.slice(0,12).join(',')}) · 원본 번호 중복 ${r.duplicatePlatesInSource} · Data에만 ${r.onlyData}(그중 판매 중 ${r.onlyDataListable})`);
  console.log('항목 | 비교 | 일치 | 정제 차이 | 불일치 | 원본빈칸인데 Data값 | 양쪽 빈칸 | 정확일치율 | 정제포함율');
  for (const f of r.fields) console.log([f.field, f.compared, f.match, f.normalized, f.mismatch, f.extra, f.sourceBlank, f.exactRate ?? '-', f.rate ?? '-'].join(' | '));
  for (const f of r.fields.filter(x => x.examples.length)) console.log(`  · ${f.field}: ${f.examples.join(' / ')}`);
}
