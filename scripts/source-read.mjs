#!/usr/bin/env node
// 원천읽기 — 아이카·이안카·아이언·오토플러스(시트)·손오공 원천을 «있는 그대로» 읽는 읽기 전용 도구. 쓰기 0, 열쇠 값 출력 금지, 차량번호는 끝 4자리만 출력.
//
//   node scripts/source-read.mjs status                       5개사 한 표(읽힘/막힘+이유, 원천 대수, 판매 중 대조)  = 원천대조 요약
//   node scripts/source-read.mjs read RP006 --plate4 1234     차량 하나의 정규 칸 + 원문 보존본(JSON)
//   node scripts/source-read.mjs read RP006 --summary         공급사 원천 요약
//   --out <저장소 밖 경로.json>  원천 전체(차량번호 포함)를 파일로 — 원천대조(supplier-origin-verify --raw-json)의 입력
//   --homepage-plates <파일>     오토플러스 홈페이지 목록(브라우저로 읽은 차량번호, 줄마다 하나)을 같이 대조
// 공급사별 길: RP004 아이카=별도 시트(gws) · RP031 이안카=ONE API(src/jobs/read-iancar-source.ts, 기존 어댑터) · RP006 아이언=홈페이지 HTML(상세 차량당 1회, 동시 2)
//   · RP023 오토플러스=공급사 시트(gws, FREEPASS_AUTOPLUS_SHEET_ID) + 홈페이지(목록 API 가 화면 스크립트 전용 → 브라우저 읽기 필요) · RP012 손오공=ERP 계정 필요(이 PC 에 없음 → 막힘)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeValue } from './supplier-freshness-lib.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0], code = argv[1];
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const last4 = p => String(p ?? '').replace(/\s+/g, '').slice(-4);
const plateKey = p => String(p ?? '').replace(/\s+/g, '');

function gwsBin() {
  if (process.env.GWS_BIN) return process.env.GWS_BIN;
  if (process.platform !== 'win32') return 'gws';
  const where = execFileSync('where', ['gws.cmd'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  const m = readFileSync(where, 'utf8').match(/"([^"]+gws\.exe)"/);
  if (!m) throw new Error('GWS_BIN_NOT_FOUND');
  return m[1];
}
const sheetRead = (id, range) => {
  const out = execFileSync(gwsBin(), ['sheets', '+read', '--spreadsheet', id, '--range', range], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out.slice(out.indexOf('{'))).values ?? [];
};

// ── 프리패스 데이터 products (공급사별) ──────────────────────────────────────────────────────
async function readProducts() {
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  const out = []; let pageToken = '';
  do {
    const q = new URLSearchParams({ pageSize: '300' }); if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/products?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`FIRESTORE_READ_${res.status}`);
    const body = await res.json();
    for (const d of body.documents ?? []) out.push(Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, decodeValue(v)])));
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

// ── 공급사별 원천 읽기: { ok, reason, readAt, records:[{plate, 정규 칸…, raw}] } ─────────────────
const won = t => { const m = String(t ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(만)?\s*원/); return m ? Math.round(Number(m[1]) * (m[2] ? 10000 : 1)) : null; };

async function readAica(products) {
  const id = process.env.FREEPASS_AICA_SHEET_ID || (products.find(p => p.provider_company_code === 'RP004' && /spreadsheets\/d\/([^/]+)/.test(p.source_url ?? ''))?.source_url ?? '').match(/spreadsheets\/d\/([^/]+)/)?.[1];
  if (!id) return { ok: false, reason: '아이카 시트 주소를 찾지 못함(FREEPASS_AICA_SHEET_ID 필요)' };
  const records = [];
  for (const tab of ['중고재렌트', '장기특별이벤트', '신차선출고']) {
    const v = sheetRead(id, `'${tab}'!A1:Y1100`);
    const hi = v.findIndex(r => r.includes('차량번호')); if (hi < 0) continue;
    const idx = Object.fromEntries(v[hi].map((h, i) => [h, i]));
    for (const r of v.slice(hi + 1)) {
      const g = h => String(r[idx[h]] ?? '').trim(); if (!g('차량번호')) continue;
      const rent = {}; for (const [h, m] of [['월렌트', 1], ['36개월', 36], ['48개월', 48], ['60개월', 60]]) { const n = Number(g(h).replace(/,/g, '')); if (n > 0) rent[m] = n; }
      records.push({ plate: g('차량번호'), 제조사: g('제조사'), 차명: g('트림'), 연식: null, 최초등록: g('최초등록'), 연료: g('연료'), 주행거리: g('Km'), 외장: g('외장'), 월대여료: rent,
        보증금: g('장기보증'), 상태: g('배차상태'), 사진수: null, 원천탭: tab, raw: Object.fromEntries(v[hi].map((h, i) => [h, r[i] ?? ''])) });
    }
  }
  return { ok: true, readAt: new Date().toISOString(), records, note: '시트에는 사진·원천 갱신 시각 칸이 없다' };
}

function readIancar() {
  const tmp = join(process.env.TEMP || '/tmp', `iancar-src-${Date.now()}.json`);
  const tsx = join(ROOT, 'node_modules', '.bin', 'tsx');
  const bin = existsSync(tsx) ? tsx : join(ROOT, '..', '..', '..', 'node_modules', '.bin', 'tsx');
  let summary;
  try { summary = execFileSync(bin, ['src/jobs/read-iancar-source.ts', '--out', tmp], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return { ok: false, reason: '이안카 ONE API 읽기 실패(비밀 저장소 접근 또는 API 응답) — 상세는 tsx src/jobs/read-iancar-source.ts 직접 실행' }; }
  const cap = JSON.parse(readFileSync(tmp, 'utf8'));
  const records = cap.records.map(p => ({ plate: p.plate_number, 제조사: p.manufacturer, 차명: `${p.model ?? ''} ${p.trim ?? ''}`.trim(), 연식: p.year, 연료: p.fuel, 주행거리: p.mileage, 외장: p.color,
    월대여료: null, 보증금: null, 상태: `${p.inventory_status ?? ''}${p.available === false ? '/불가' : ''}`, 사진수: Array.isArray(p.photos) ? p.photos.length : null, 원천갱신: p.synced_at, raw: p }));
  return { ok: true, readAt: cap.capturedAt, sourceSyncedAt: cap.syncedAt, stale: cap.stale, records, note: '목록 응답에는 월대여료·보증금이 없다(상세 요금은 기간별 상세 호출 필요 — 기존 collectIancarOneFullFacts)' };
}

const clean = h => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
async function readIron() {
  const UA = 'FreepassData read-only source check';
  const get = async url => { const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
  const items = [];
  try {
    for (const cond of ['used', 'new']) {
      let url = `https://ironrentcar.com/vehicles?condition=${cond}`; const seen = new Set();
      while (url && seen.size < 10 && !seen.has(url)) {
        seen.add(url); const html = await get(url);
        for (const a of html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)) { const id = a[0].match(/href="\/vehicles\/([^"?/#]+)/)?.[1]; if (id) items.push({ id, cond, sold: /rental-product-card--sold/.test(a[0]) }); }
        const more = html.match(/<a[^>]*href="([^"]+)"[^>]*>\s*더보기\s*<\/a>/)?.[1];
        url = more ? new URL(more.replace(/&amp;/g, '&'), 'https://ironrentcar.com').href : null;
      }
    }
  } catch (e) { return { ok: false, reason: `아이언 목록 읽기 실패(${e.message})` }; }
  const only = opt('plate4');
  const records = []; let cursor = 0;
  const worker = async () => { while (cursor < items.length) { const it = items[cursor++]; // 차량당 1회, 동시 2
    try {
      const html = await get(`https://ironrentcar.com/vehicles/${it.id}`);
      const dt = Object.fromEntries([...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)].map(m => [clean(m[1]), clean(m[2])]));
      const rent = {}; for (const [k, v] of Object.entries(dt)) { const m = k.match(/^(\d+)개월$/); if (m) rent[m[1]] = won(v); }
      const title = clean(html.match(/product-detail-title[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '');
      const dep = clean(html.match(/product-detail-price-estimate[^>]*>([\s\S]*?)<\/(?:div|p)>/)?.[1] ?? '');
      records.push({ plate: dt['차량번호'] ?? '', 제조사: null, 차명: title, 연료: dt['유종'], 주행거리: dt['주행거리'], 외장: dt['외장 색상'], 월대여료: rent, 보증금: dep, 상태: it.sold ? '판매완료' : '게시', 사진수: (html.match(/<img[^>]+vehicles?[^>]*>/g) ?? []).length || null, 구분: it.cond, raw: { ...dt } });
    } catch (e) { records.push({ plate: '', 차명: `읽기 실패 ${it.id}`, error: e.message }); } } };
  await Promise.all([worker(), worker()]);
  return { ok: true, readAt: new Date().toISOString(), records: records.filter(r => !only || last4(r.plate) === only), note: '홈페이지 HTML 있는 그대로(상세 차량당 1회)', all: records };
}

function readAutoplus(products) {
  const sheetId = process.env.FREEPASS_AUTOPLUS_SHEET_ID;
  const plates = new Set(), notes = [];
  if (sheetId) {
    for (const tab of ['판매차량리스트', '★★★  전기차(EV6,니로EV 등) 프로모션(수수료 150만원) ★★★'] /* ERP4 sheet-autoplus 와 같은 2탭 병합 */) {
      try { for (const r of sheetRead(sheetId, `'${tab}'!A1:AZ1100`)) for (const c of r) { const m = String(c).replace(/\s/g, '').match(/\d{2,3}[가-힣]\d{4}/); if (m) plates.add(m[0]); } } catch { notes.push(`${tab} 읽기 실패`); }
    }
  } else notes.push('시트 주소 없음(FREEPASS_AUTOPLUS_SHEET_ID)');
  let hp = null;
  if (opt('homepage-plates') && existsSync(opt('homepage-plates'))) hp = new Set(readFileSync(opt('homepage-plates'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  if (!sheetId && !hp) return { ok: false, reason: '시트 주소와 홈페이지 목록이 모두 없음' };
  const all = new Set([...plates, ...(hp ?? [])]);
  return { ok: true, readAt: new Date().toISOString(), records: [...all].map(p => ({ plate: p, 원천: [plates.has(p) ? '시트' : null, hp?.has(p) ? '홈페이지' : null].filter(Boolean).join('+'), raw: {} })),
    note: `시트 차량 ${plates.size}대${hp ? ` · 홈페이지 ${hp.size}대` : ' · 홈페이지는 목록 API 가 화면 스크립트 전용이라 브라우저로 읽은 파일(--homepage-plates) 필요'}${notes.length ? ' · ' + notes.join(',') : ''}`, partial: !hp || !sheetId };
}

const BLOCKED = { RP012: { ok: false, reason: '손오공 ERP 계정이 이 PC·freepass-data 에 없음 — 대표 손 한 가지: 손오공 로그인 계정을 비밀 저장소(freepass-data 프로젝트)에 등록' } };

async function readSupplier(c, products) {
  if (c === 'RP004') return readAica(products);
  if (c === 'RP031') return readIancar();
  if (c === 'RP006') return readIron();
  if (c === 'RP023') return readAutoplus(products);
  if (c === 'RP012') return BLOCKED.RP012;
  return { ok: false, reason: '지원하지 않는 공급사(공통 시트 공급사는 supplier-origin-verify.mjs)' };
}

function crossCheck(c, res, products) {
  const mine = products.filter(p => (p.provider_company_code || p.partner_code) === c);
  const listable = mine.filter(p => p.listable === true);
  const src = new Set(res.records.map(r => plateKey(r.plate)).filter(Boolean));
  const dataSet = new Set(mine.map(p => plateKey(p.car_number)));
  return { sourceCount: src.size, dataTotal: mine.length, dataListable: listable.length, listableInSource: listable.filter(p => src.has(plateKey(p.car_number))).length,
    listableNotInSource: listable.filter(p => !src.has(plateKey(p.car_number))).length, sourceNotInData: [...src].filter(p => !dataSet.has(p)).length };
}

const NAMES = { RP004: '아이카', RP031: '이안카', RP012: '손오공', RP023: '오토플러스', RP006: '아이언' };
const products = await readProducts();
if (cmd === 'status') {
  console.log('공급사 | 결과 | 원천 대수 | 데이터(전체/판매중) | 판매중 중 원천에 있음 | 판매중 중 원천에 없음 | 원천에만 있음 | 원천 읽은 시각 | 비고/막힌 이유');
  const out = {};
  for (const c of ['RP004', 'RP031', 'RP006', 'RP023', 'RP012']) {
    let res; try { res = await readSupplier(c, products); } catch (e) { res = { ok: false, reason: `예외: ${e.message}` }; }
    if (!res.ok) { console.log([`${NAMES[c]} ${c}`, '막힘', '-', '-', '-', '-', '-', '-', res.reason].join(' | ')); out[c] = { ok: false, reason: res.reason }; continue; }
    const x = crossCheck(c, res, products); out[c] = { ok: true, ...x, readAt: res.readAt };
    console.log([`${NAMES[c]} ${c}`, res.partial ? '일부 읽힘' : '읽힘', x.sourceCount, `${x.dataTotal}/${x.dataListable}`, x.listableInSource, x.listableNotInSource, x.sourceNotInData, res.readAt, res.note ?? ''].join(' | '));
  }
  if (opt('json')) writeFileSync(opt('json'), JSON.stringify(out, null, 2));
} else if (cmd === 'read' && code) {
  const res = await readSupplier(code, products);
  if (!res.ok) { console.error(`막힘: ${res.reason}`); process.exit(3); }
  if (opt('out')) writeFileSync(opt('out'), JSON.stringify(res.records));
  const p4 = opt('plate4');
  if (p4) { const r = res.records.filter(x => last4(x.plate) === p4); console.log(JSON.stringify({ readAt: res.readAt, 찾음: r.length, 레코드: r.map(x => ({ ...x, plate: `…${last4(x.plate)}` })) }, null, 1)); }
  else console.log(JSON.stringify({ 공급사: code, readAt: res.readAt, 원천대수: res.records.length, ...crossCheck(code, res, products), note: res.note, 필드: Object.keys(res.records[0] ?? {}) }, null, 1));
} else { console.error('사용: status | read <공급사코드> [--plate4 XXXX|--summary] [--out 파일]'); process.exit(2); }
