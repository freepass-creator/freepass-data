#!/usr/bin/env node
// 판매가능대수 — 공급사 원천 기준 «팔 수 있는 차» vs 프리패스 데이터 판매(listable) vs ERP5 노출, 차이를 끝 4자리로. 읽기 전용, 쓰기 0.
//   node scripts/sellable-count.mjs [--detail] [--json 파일] [--alert-file 파일] [--homepage-plates 파일(오토플러스 홈피 목록)]
// 원천: 공통 시트(F05) 12탭 = 상태 출고가능·즉시출고·출고협의 / 이안카 ONE = AVAILABLE / 아이카 시트 = 배차가능·배차문의 / 아이언 홈피 = 게시(판매완료 제외)
//       오토플러스 = 시트·홈피 목록에 존재 / 손오공 ERP = 계정 없음(막힘). 환경변수: FREEPASS_SHEET_F05_ID (시트 주소는 비공개 문서에서)
// 차이가 있으면 «[데이터 감독] …» 한 줄을 표준출력(과 --alert-file 에 추가)으로 낸다. 매시 실행은 예약 등록(승인 필요) 전까지 수동 한 줄 명령.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeValue } from './supplier-freshness-lib.mjs';

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const key = p => String(p ?? '').replace(/\s+/g, '');
const l4 = p => key(p).slice(-4);
const spec = JSON.parse(readFileSync(join(ROOT, 'contracts', 'supplier-input-sheet-spec.v1.json'), 'utf8'));
const SELLABLE_F05 = new Set(['출고가능', '즉시출고', '출고협의']);
const NAMES = { RP004: '아이카', RP031: '이안카', RP012: '손오공', RP023: '오토플러스', RP006: '아이언' };
for (const x of spec.supplierChannels.sharedInputSheet) NAMES[x.code] ??= `${x.tab}${x.tab !== x.companyName ? '/' + x.companyName : ''}`;

function gwsBin() {
  if (process.env.GWS_BIN) return process.env.GWS_BIN;
  if (process.platform !== 'win32') return 'gws';
  const where = execFileSync('where', ['gws.cmd'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  return readFileSync(where, 'utf8').match(/"([^"]+gws\.exe)"/)[1];
}
const tmp = name => join(process.env.TEMP || '/tmp', `sellable-${name}-${Date.now()}.json`);

// 프리패스 데이터 + ERP5 노출
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const docs = []; let pageToken = '';
do {
  const q = new URLSearchParams({ pageSize: '300' }); if (pageToken) q.set('pageToken', pageToken);
  for (const f of ['car_number', 'provider_company_code', 'partner_code', 'listable', 'status']) q.append('mask.fieldPaths', f);
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID || 'freepasserp5'}/databases/(default)/documents/products?${q}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`FIRESTORE_READ_${res.status}`);
  const body = await res.json();
  for (const d of body.documents ?? []) { const f = Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, decodeValue(v)])); docs.push({ plate: key(f.car_number), code: f.provider_company_code || f.partner_code || '-', listable: f.listable === true }); }
  pageToken = body.nextPageToken ?? '';
} while (pageToken);
const erp5 = new Set(((await (await fetch('https://freepasserp5.vercel.app/api/catalog', { signal: AbortSignal.timeout(90000) })).json()).vehicles ?? []).map(v => key(v.plate)));
const plateCode = new Map(docs.map(d => [d.plate, d.code]));

// 원천별 판매가능 차량번호 집합 { code: { set:Set, 읽힘, 비고, 분포 } }
const src = {};
const run = (script, args) => execFileSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });

// 공통 시트 F05
if (process.env.FREEPASS_SHEET_F05_ID) {
  const sup = spec.supplierChannels.sharedInputSheet, dist = {};
  for (const tab of [...new Set(sup.map(x => x.tab))]) {
    let v; try { const o = execFileSync(gwsBin(), ['sheets', '+read', '--spreadsheet', process.env.FREEPASS_SHEET_F05_ID, '--range', `'${tab}'!A1:BX1500`], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }); v = JSON.parse(o.slice(o.indexOf('{'))).values ?? []; } catch { continue; }
    const ix = Object.fromEntries((v[0] ?? []).map((h, i) => [h, i])); if (ix['차량번호'] == null) continue;
    const g = (r, k) => String(r[ix[k]] ?? '').trim(), shared = sup.filter(x => x.tab === tab).length > 1;
    for (const r of v.slice(1)) {
      const plate = key(g(r, '차량번호')); if (!plate) continue;
      if (!/\d{2,3}[가-힣]\d{4}/.test(plate)) continue; // «신차» 같은 번호 미배정 줄은 세지 않는다
      const code = (sup.find(x => x.tab === tab && (!shared || x.companyName === g(r, '회사명'))) ?? sup.find(x => x.tab === tab)).code;
      const o = (src[code] ??= { set: new Set(), all: new Set(), 읽힘: true, 비고: '공통 시트 상태 출고가능·즉시출고·출고협의' });
      o.all.add(plate); const st = g(r, '차량상태'); (dist[code] ??= {})[st || '(빈칸)'] = ((dist[code] ??= {})[st || '(빈칸)'] || 0) + 1;
      if (SELLABLE_F05.has(st)) o.set.add(plate);
    }
  }
  for (const x of sup) if (!src[x.code]) src[x.code] = { set: new Set(), all: new Set(), 읽힘: false, 비고: `F05 에 «${x.tab}» 탭 없음` };
} else for (const x of spec.supplierChannels.sharedInputSheet) src[x.code] = { set: new Set(), all: new Set(), 읽힘: false, 비고: 'FREEPASS_SHEET_F05_ID 없음' };

// 별도 원천(원천읽기 도구 재사용)
for (const [code, ok] of [['RP031', r => /^AVAILABLE/.test(r.상태 ?? '') && !/불가/.test(r.상태 ?? '')], ['RP004', r => ['배차가능', '배차문의'].includes(r.상태)], ['RP006', r => r.상태 === '게시']]) {
  const out = tmp(code);
  try { run('source-read.mjs', ['read', code, '--out', out]); const rows = JSON.parse(readFileSync(out, 'utf8')); const set = new Set(rows.filter(ok).map(r => key(r.plate)).filter(Boolean));
    src[code] = { set, all: new Set(rows.map(r => key(r.plate)).filter(Boolean)), 읽힘: true, 비고: { RP031: 'ONE API AVAILABLE', RP004: '시트 배차가능·배차문의', RP006: '홈피 게시(판매완료 제외)' }[code] }; }
  catch { src[code] = { set: new Set(), all: new Set(), 읽힘: false, 비고: '원천 읽기 실패' }; }
}
{ const out = tmp('RP023'); const args = ['read', 'RP023', '--out', out]; if (opt('homepage-plates')) args.push('--homepage-plates', opt('homepage-plates'));
  try { run('source-read.mjs', args); const rows = JSON.parse(readFileSync(out, 'utf8')); const set = new Set(rows.map(r => key(r.plate)));
    src.RP023 = { set, all: set, 읽힘: true, 비고: opt('homepage-plates') ? '시트+홈피 목록에 존재' : '시트 목록에 존재(홈피 목록 파일 없음 → 일부)' }; }
  catch { src.RP023 = { set: new Set(), all: new Set(), 읽힘: false, 비고: '원천 읽기 실패' }; } }
src.RP012 = { set: new Set(), all: new Set(), 읽힘: false, 비고: '손오공 ERP 계정 없음(대표 손: 계정 등록)' };

// 대조
const codes = [...new Set([...Object.keys(src), ...docs.map(d => d.code)])].filter(c => c !== '-');
const rows = [];
for (const c of codes) {
  const s = src[c]; const mine = docs.filter(d => d.code === c);
  const dataSell = new Set(mine.filter(d => d.listable).map(d => d.plate));
  const erp5Sell = new Set([...erp5].filter(p => plateCode.get(p) === c));
  const r = { code: c, 이름: NAMES[c] ?? c, 읽힘: !!s?.읽힘, 비고: s?.비고 ?? '원천 지도에 없음', 원천판매가능: s?.읽힘 ? s.set.size : null, 데이터판매: dataSell.size, ERP5노출: erp5Sell.size };
  if (s?.읽힘) {
    r.원천O데이터X = [...s.set].filter(p => !dataSell.has(p)).map(l4);
    r.데이터O원천X = [...dataSell].filter(p => !s.set.has(p)).map(p => `${l4(p)}${s.all.has(p) ? '(원천 판매불가)' : '(원천에 없음)'}`);
  }
  r.ERP5와데이터차이 = [...new Set([...dataSell].filter(p => !erp5Sell.has(p)).concat([...erp5Sell].filter(p => !dataSell.has(p))))].map(l4);
  rows.push(r);
}
rows.sort((a, b) => b.데이터판매 - a.데이터판매);
const tot = a => rows.reduce((n, r) => n + (r[a] ?? 0), 0);
console.log(`판매가능대수 ${new Date().toISOString()} (원천 읽힘 공급사만 합산)`);
console.log('공급사 | 원천 판매가능 | 데이터 판매 | ERP5 노출 | 원천O데이터X | 데이터O원천X | ERP5≠데이터 | 비고');
for (const r of rows) if (r.데이터판매 || r.원천판매가능) console.log([`${r.이름}(${r.code})`, r.원천판매가능 ?? '막힘', r.데이터판매, r.ERP5노출, r.읽힘 ? r.원천O데이터X.length : '-', r.읽힘 ? r.데이터O원천X.length : '-', r.ERP5와데이터차이.length, r.비고].join(' | '));
const read = rows.filter(r => r.읽힘);
console.log(`합계(읽힘 ${read.length}곳): 원천 판매가능 ${read.reduce((n, r) => n + r.원천판매가능, 0)} · 데이터 판매 ${read.reduce((n, r) => n + r.데이터판매, 0)} · ERP5 노출 ${read.reduce((n, r) => n + r.ERP5노출, 0)} | 전체 데이터 판매 ${tot('데이터판매')} · ERP5 노출 ${erp5.size}`);
if (argv.includes('--detail')) for (const r of read) { if (r.원천O데이터X.length || r.데이터O원천X.length) console.log(`  ${r.이름}: 원천O데이터X [${r.원천O데이터X.join(',')}] / 데이터O원천X [${r.데이터O원천X.join(',')}]`); }
const diffN = read.reduce((n, r) => n + r.원천O데이터X.length + r.데이터O원천X.length, 0), blocked = rows.filter(r => !r.읽힘 && r.데이터판매).map(r => r.이름);
const alert = `[데이터 감독] ${new Date().toISOString()} 판매가능 차이 ${diffN}건(원천O데이터X ${read.reduce((n, r) => n + r.원천O데이터X.length, 0)} · 데이터O원천X ${read.reduce((n, r) => n + r.데이터O원천X.length, 0)}) · ERP5≠데이터 ${rows.reduce((n, r) => n + r.ERP5와데이터차이.length, 0)}${blocked.length ? ' · 원천 미확인 ' + blocked.join(',') : ''}`;
if (diffN || blocked.length) { console.log(alert); if (opt('alert-file')) appendFileSync(opt('alert-file'), alert + '\n'); }
if (opt('json')) writeFileSync(opt('json'), JSON.stringify(rows.map(r => ({ ...r })), null, 1));
