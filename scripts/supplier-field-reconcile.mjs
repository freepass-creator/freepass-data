#!/usr/bin/env node
// 공급사별 «항목 단위 대조 틀» — 공급사 원본 ↔ 프리패스 데이터(products). 읽기 전용, 토큰 0, 차량번호는 마지막 4자리만 출력.
//
// 사용:
//   node scripts/supplier-field-reconcile.mjs --supplier RP004 --raw <원본.json> [--map <매핑.json>] [--fields price,mileage,...] [--json] [--out <결과.json>]
//
// --raw   : 각 공급사 담당 세션의 읽기 도구가 만든 JSON 배열. 항목 하나 = 차 한 대의 {원본 이름: 값, ...}. (원본은 저장소에 두지 않는다)
// --map   : 선택. {"프리패스 데이터 칸 이름": "원본 키"} — 원본 키는 점 경로 허용(예 "detail.price"). 없으면 같은 이름으로 본다.
//           차량번호 칸은 "car_number" 로 매핑한다.
// 판정  : 정규화 일치(공백·쉼표·단위·날짜 구분자 무시)는 일치로 세되 FORMAT_ONLY 로 따로 센다.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeValue } from './supplier-freshness-lib.mjs';
import { assertPrivateOutputPath } from './sellable-lib.mjs';
import { DEFAULT_FIELDS, MISMATCH_TYPES, reconcile } from './supplier-field-reconcile-lib.mjs';

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
assertPrivateOutputPath(opt('out'));
const supplier = opt('supplier'), rawPath = opt('raw');
if (!supplier || !rawPath) { console.error('필수: --supplier <코드> --raw <원본.json>'); process.exit(2); }
const map = opt('map') ? JSON.parse(readFileSync(opt('map'), 'utf8')) : {};
const fields = opt('fields') ? opt('fields').split(',') : DEFAULT_FIELDS;
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';

const pick = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const rawRows = JSON.parse(readFileSync(rawPath, 'utf8'));
if (!Array.isArray(rawRows)) { console.error('원본은 JSON 배열이어야 한다'); process.exit(2); }
const rawRecords = rawRows.map(r => Object.fromEntries(['car_number', ...fields].map(f => [f, pick(r, map[f] ?? f)])));

const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
async function readSupplier() {
  const out = []; let pageToken = '';
  const q0 = [...new Set(['car_number', 'provider_company_code', 'partner_code', 'listable', ...fields.map(f => f.split('.')[0])])]; // 중첩 경로(price.12.rent)는 맨 앞 칸만 마스크로 요청
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    for (const f of q0) q.append('mask.fieldPaths', /^[A-Za-z_][A-Za-z0-9_]*$/.test(f) ? f : '`' + f + '`');
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/products?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`FIRESTORE_READ_${res.status}`);
    const body = await res.json();
    for (const d of body.documents ?? []) {
      const f = Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, decodeValue(v)]));
      if ((f.provider_company_code || f.partner_code) === supplier) out.push({ car_number: f.car_number, listable: f.listable, ...Object.fromEntries(fields.map(x => [x, pick(f, x)])) }); // 점 경로를 평탄화해 대조 칸과 맞춘다
    }
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

const report = { supplier, observedAt: new Date().toISOString(), ...reconcile(rawRecords, await readSupplier(), { fields }) };
if (opt('out')) writeFileSync(opt('out'), JSON.stringify(report, null, 2));
if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  const pct = n => n == null ? '-' : (n * 100).toFixed(1) + '%';
  console.log(`[${supplier}] 원본 ${report.rawVehicles}대 · 데이터 ${report.dataVehicles}대 · 공통 ${report.commonVehicles}대 · 차량 포함률 ${pct(report.vehicleCoverage)}`);
  console.log(`항목 일치율 ${pct(report.fieldMatchRate)} (표기까지 정확히 같음 ${pct(report.fieldExactRate)}) · 비교 항목 ${report.comparedFields}`);
  console.log('항목 | 비교 | 일치율 | 표기만 다름 | 값 다름 | 데이터 빈칸 | 원본 빈칸');
  for (const f of fields) { const p = report.perField[f]; console.log([f, p.compared, pct(p.matchRate), p.formatOnly, p.valueDiff, p.emptyInData, p.emptyInRaw].join(' | ')); }
  console.log('불일치 유형: ' + MISMATCH_TYPES.map(t => `${t} ${report.types[t]}`).join(' · '));
  for (const t of MISMATCH_TYPES) for (const s of report.samples[t]) console.log(`  ${t} ${JSON.stringify(s)}`);
}
