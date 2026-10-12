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
import { classifyField } from './supplier-field-reconcile-lib.mjs';
import { assertPrivateOutputPath, hiddenRowsByTab, maskPlates } from './sellable-lib.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0], code = argv[1];
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
assertPrivateOutputPath(opt('out')); assertPrivateOutputPath(opt('json')); // 차량번호 전체가 든 증거 파일은 저장소 밖에만
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
  // 대표 확정(10-12): 보이는 탭 장기특별이벤트·신차선출고·중고재렌트(월렌트 별도), 숨김 탭·숨긴 줄(행 숨기기·필터 숨김) 제외
  const gwsGet = params => { const o = execFileSync(gwsBin(), ['sheets', 'spreadsheets', 'get', '--params', JSON.stringify({ spreadsheetId: id, ...params })], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }); return JSON.parse(o.slice(o.indexOf('{'))); };
  const meta = gwsGet({ fields: 'sheets(properties(title,hidden))' });
  const expectedTabs = ['중고재렌트', '장기특별이벤트', '신차선출고'];
  const visibleTabs = expectedTabs.filter(t => meta.sheets.some(x => x.properties.title === t && !x.properties.hidden));
  // fail-closed: 기대 탭이 하나라도 없거나 숨겨졌으면(이름 변경·구조 변경 의심) 빈 재고로 보지 않고 중단
  if (visibleTabs.length !== expectedTabs.length) return { ok: false, reason: `아이카 보이는 탭 구성이 기대와 다름(${visibleTabs.join('·') || '없음'}) — 시트 구조 변경 의심` };
  const hiddenRows = visibleTabs.length ? hiddenRowsByTab(gwsGet({ includeGridData: true, ranges: visibleTabs.map(t => `'${t}'!A1:A1500`), fields: 'sheets(properties(title),data(startRow,rowMetadata(hiddenByUser,hiddenByFilter)))' })) : new Map();
  if (visibleTabs.length && visibleTabs.some(t => !hiddenRows.has(t))) return { ok: false, reason: '아이카 숨긴 줄 메타데이터 응답에 요청한 탭이 빠져 있음 — 숨긴 줄을 판별할 수 없어 중단' }; // fail-closed
  let hiddenSkipped = 0;
  for (const tab of visibleTabs) {
    const v = sheetRead(id, `'${tab}'!A1:Y1500`);
    // fail-closed: 머리글을 못 찾거나 읽기 상한(1500행)에 닿으면 불완전 — 일부 탭만으로 «없음»을 판정하지 않는다
    if (v.length >= 1500) return { ok: false, reason: `아이카 «${tab}» 탭이 읽기 상한(1500행)에 닿음 — 상한 상향 필요` };
    const hi = v.findIndex(r => r.includes('차량번호')); if (hi < 0) return { ok: false, reason: `아이카 «${tab}» 탭에서 차량번호 머리글을 찾지 못함(시트 구조 변경 의심)` };
    if (!v[hi].includes('배차상태')) return { ok: false, reason: `아이카 «${tab}» 탭에 배차상태 머리글이 없음(시트 구조 변경 의심)` };
    const idx = Object.fromEntries(v[hi].map((h, i) => [h, i]));
    for (const [ri, r] of v.entries()) {
      if (ri <= hi) continue;
      const g = h => String(r[idx[h]] ?? '').trim(); if (!g('차량번호')) continue;
      if (hiddenRows.get(tab)?.has(ri + 1)) { hiddenSkipped++; continue; }
      const rent = {}; for (const [h, m] of [['월렌트', 1], ['36개월', 36], ['48개월', 48], ['60개월', 60]]) { const n = Number(g(h).replace(/,/g, '')); if (n > 0) rent[m] = n; }
      records.push({ plate: g('차량번호'), 제조사: g('제조사'), 차명: g('트림'), 연식: null, 최초등록: g('최초등록'), 연료: g('연료'), 주행거리: g('Km'), 외장: g('외장'), 월대여료: rent,
        보증금: g('장기보증'), 상태: g('배차상태'), 사진수: null, 원천탭: tab, raw: Object.fromEntries(v[hi].map((h, i) => [h, r[i] ?? ''])) });
    }
  }
  return { ok: true, readAt: new Date().toISOString(), records, hiddenSkipped, visibleTabs, note: `보이는 탭 ${visibleTabs.join('·')} · 숨긴 줄 ${hiddenSkipped}개 제외 · 시트에는 사진·원천 갱신 시각 칸이 없다` };
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
        if (!/<article\b/.test(html)) return { ok: false, reason: `아이언 «${cond}» ${seen.size}번째 목록 페이지에서 차량을 한 건도 읽지 못함(점검 페이지·구조 변경 의심)` }; // fail-closed
        const cards = [...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)];
        if ((html.match(/<article\b/g) ?? []).length !== cards.length) return { ok: false, reason: `아이언 «${cond}» ${seen.size}번째 목록에 닫히지 않은(잘린) 카드가 있음` }; // fail-closed
        if (cards.some(a => !/href="\/vehicles\/([^"?/#]+)/.test(a[0]))) return { ok: false, reason: `아이언 «${cond}» ${seen.size}번째 목록에 차량 링크를 읽지 못한 카드가 있음(구조 변경 의심)` }; // fail-closed
        for (const a of cards) { const id = a[0].match(/href="\/vehicles\/([^"?/#]+)/)?.[1]; if (id) items.push({ id, cond, sold: /rental-product-card--sold/.test(a[0]) }); }
        const more = html.match(/<a[^>]*href="([^"]+)"[^>]*>\s*더보기\s*<\/a>/)?.[1];
        url = more ? new URL(more.replace(/&amp;/g, '&'), 'https://ironrentcar.com').href : null;
      }
      if (url) return { ok: false, reason: `아이언 «${cond}» 목록이 페이지 상한(10)에 닿았거나 순환 — 불완전` }; // fail-closed
    }
  } catch (e) { return { ok: false, reason: `아이언 목록 읽기 실패(${e.message})` }; }
  { const seenIds = new Set(); for (let i = items.length - 1; i >= 0; i--) { if (seenIds.has(items[i].id)) items.splice(i, 1); else seenIds.add(items[i].id); } } // 같은 차량이 목록에 중복돼 나오면 상세는 한 번만
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
  // fail-closed: 상세 조회가 하나라도 실패했거나 번호를 못 읽은 상세가 있으면 불완전한 원천 — 정상 완료로 돌려주지 않는다.
  const failedDetail = records.filter(r => r.error || !r.plate).length;
  if (failedDetail || !items.length) return { ok: false, reason: `아이언 읽기 불완전(상세 실패·번호 없음 ${failedDetail}건 / 목록 ${items.length}건) — 재읽기 필요` };
  return { ok: true, readAt: new Date().toISOString(), records: records.filter(r => !only || last4(r.plate) === only), note: '홈페이지 HTML 있는 그대로(상세 차량당 1회)', all: records };
}

function readAutoplus(products) {
  const sheetId = process.env.FREEPASS_AUTOPLUS_SHEET_ID;
  const plates = new Set(), notes = [];
  if (sheetId) {
    for (const tab of ['판매차량리스트', '★★★  전기차(EV6,니로EV 등) 프로모션(수수료 150만원) ★★★'] /* ERP4 sheet-autoplus 와 같은 2탭 병합 */) {
      try { const rowsAp = sheetRead(sheetId, `'${tab}'!A1:AZ1100`); if (rowsAp.length >= 1100) throw new Error('ROW_LIMIT'); for (const r of rowsAp) for (const c of r) { const m = String(c).replace(/\s/g, '').match(/\d{2,3}[가-힣]\d{4}/); if (m) plates.add(m[0]); } } catch { notes.push(`${tab} 읽기 실패`); }
    }
  } else notes.push('시트 주소 없음(FREEPASS_AUTOPLUS_SHEET_ID)');
  let hp = null;
  if (opt('homepage-plates') && existsSync(opt('homepage-plates'))) hp = new Set(readFileSync(opt('homepage-plates'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  if (!sheetId && !hp) return { ok: false, reason: '시트 주소와 홈페이지 목록이 모두 없음' };
  if (hp && [...hp].filter(x => /\d{2,3}[가-힣]\d{4}/.test(x)).length < 10) return { ok: false, reason: '오토플러스 홈페이지 목록이 비정상적으로 작음(번호 형식 10건 미만) — 재읽기 필요' }; // fail-closed
  if (notes.some(n => /읽기 실패/.test(n))) return { ok: false, reason: `오토플러스 시트 읽기 불완전(${notes.join(',')}) — 재읽기 필요` }; // fail-closed
  const all = new Set([...plates, ...(hp ?? [])]);
  return { ok: true, readAt: new Date().toISOString(), records: [...all].map(p => ({ plate: p, 원천: [plates.has(p) ? '시트' : null, hp?.has(p) ? '홈페이지' : null].filter(Boolean).join('+'), raw: {} })),
    note: `시트 차량 ${plates.size}대${hp ? ` · 홈페이지 ${hp.size}대` : ' · 홈페이지는 목록 API 가 화면 스크립트 전용이라 브라우저로 읽은 파일(--homepage-plates) 필요'}${notes.length ? ' · ' + notes.join(',') : ''}`, partial: !hp || !sheetId };
}

const BLOCKED = { RP012: { ok: false, reason: "손오공은 직접 읽기 없음 — ERP4 매시 수집기 반영 결과를 원천 기준으로 본다(판매가능대수 명령 참고)" } };

// ── 직접 확인: 차량 하나를 원천에서 «그 순간» 읽어 정규 칸으로(저장 없음) ───────────────────────────
// 끝 4자리가 같은 서로 다른 차량: 데이터 상품이 있으면 그 실번호와 정확히 같은 원천 줄만, 없으면 끝 4자리가 유일할 때만 고른다(애매하면 null)
function findSourceRecord(records, prod, plate4) {
  if (prod) return records.find(r => plateKey(r.plate) === plateKey(prod.car_number)) ?? null;
  const m = records.filter(r => last4(r.plate) === plate4);
  if (m.length > 1) return { ambiguous: m.length };
  return m.length === 1 ? m[0] : null;
}
function ianSingle(plate4, exactPlate) {
  const tmp = join(process.env.TEMP || '/tmp', `iancar-one-${Date.now()}.json`);
  const tsx = join(ROOT, 'node_modules', '.bin', 'tsx');
  const bin = existsSync(tsx) ? tsx : join(ROOT, '..', '..', '..', 'node_modules', '.bin', 'tsx');
  try { execFileSync(bin, ['src/jobs/read-iancar-source.ts', '--plate4', plate4, '--out', tmp], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return { ok: false, reason: '이안카 ONE API 읽기 실패(비밀 저장소 접근 또는 API 응답)' }; }
  const j = JSON.parse(readFileSync(tmp, 'utf8')); try { require_unlink(tmp); } catch { /* 임시 파일은 남겨도 저장소 밖 */ }
  const cands = j.detail ?? [];
  if (!exactPlate && cands.length > 1) return { ok: true, readAt: j.readAt, found: false, ambiguous: cands.length, sourceSyncedAt: j.syncedAt };
  const d = exactPlate ? cands.find(x => plateKey(x.vehicle?.data?.plate_number ?? x.list?.plate_number) === plateKey(exactPlate)) : cands[0];
  if (!d) return { ok: true, readAt: j.readAt, found: false, sourceSyncedAt: j.syncedAt };
  const v = d.vehicle?.data ?? d.list, terms = (d.rates?.data ?? []).map(t => ({ 개월: t.rental_period, km: t.contracted_mileage, 주기: t.mileage_period, 월대여료: t.monthly_rate, 보증금: t.deposit }));
  return { ok: true, found: true, readAt: j.readAt, sourceSyncedAt: j.syncedAt, 원천갱신: v.synced_at, 상태: v.inventory_status, 판매가능: v.available, 연식: v.year, 연료: v.fuel, 주행거리: v.mileage, 외장: v.color,
    사진수: Array.isArray(v.photos) ? v.photos.length : null, 차명: v.name, 요금: terms };
}
function require_unlink(f) { execFileSync(process.platform === 'win32' ? 'cmd' : 'rm', process.platform === 'win32' ? ['/c', 'del', f] : [f]); }

const periodKey = t => `${t.개월}_${t.주기 === 'month' ? '월' : '연'}${t.km}km`;
const fmt = v => v == null || v === '' ? '-' : String(v);
const FIELD_OF = { 연료: 'fuel_type', 외장: 'ext_color', 주행거리: 'mileage', 연식: 'year' };
const judge = (항목, a, b) => { const c = classifyField(a, b, FIELD_OF[항목]); return { MATCH: '일치', FORMAT_ONLY: '일치(표기 차이)', NEAR_NUMERIC: '일치(반올림)', EMPTY_IN_DATA: '데이터 빈칸', EMPTY_IN_RAW: '원천 칸 없음', BOTH_EMPTY: '둘 다 빈칸', VALUE_DIFF: '차이' }[c]; };
const same = (a, b) => a != null && b != null && String(a).replace(/[,\s]/g, '') === String(b).replace(/[,\s]/g, '');

async function compareOne(c, plate4, idx = 0) {
  const mine = products.filter(p => (p.provider_company_code || p.partner_code) === c && last4(p.car_number) === plate4);
  const prod = mine[idx];
  const rows = [];
  const row = (항목, 원천, 데이터, 판정) => rows.push({ 항목, 원천: fmt(원천), 데이터: fmt(데이터), 판정: 판정 ?? judge(항목, 원천, 데이터) });
  let readAt, note;
  if (c === 'RP031') {
    const r = ianSingle(plate4, prod?.car_number); if (!r.ok) return { ok: false, reason: r.reason };
    readAt = r.readAt; if (r.ambiguous) return { ok: true, readAt, 식별불가: `끝 4자리가 같은 원천 차량 ${r.ambiguous}대 — 번호 전체가 필요(부재로 판정하지 않음)` };
    if (!r.found) return { ok: true, readAt, 원천에없음: true, 데이터있음: !!prod, 데이터: prod ? { 상태: prod.status, 판매중: prod.listable === true } : null };
    row('원천 갱신 시각', r.원천갱신, prod?._direct_ingest_at ? new Date(prod._direct_ingest_at).toISOString() : null, '참고');
    row('상태', r.상태, prod?.status_label_raw, r.판매가능 ? (prod?.listable ? '원천 가능/데이터 판매중' : '원천 가능인데 데이터 판매 아님') : '원천 불가');
    row('연식', r.연식, prod?.year); row('연료', r.연료, prod?.fuel_type); row('주행거리', r.주행거리, prod?.mileage); row('외장', r.외장, prod?.ext_color);
    row('사진 수', r.사진수, (Array.isArray(prod?.image_urls) ? prod.image_urls.length : 0) + (prod?.photo_link ? 1 : 0));
    for (const t of r.요금.filter(t => t.개월 >= 36 || [12, 24].includes(t.개월))) { const dk = prod?.price?.[periodKey(t)]; row(`${periodKey(t)} 월대여료`, t.월대여료, dk?.rent); row(`${periodKey(t)} 보증금`, t.보증금, dk?.deposit); }
  } else if (c === 'RP004' || c === 'RP006') {
    const res = await readSupplier(c, products); if (!res.ok) return { ok: false, reason: res.reason };
    readAt = res.readAt; const hit = findSourceRecord(res.records, prod, plate4);
    if (hit?.ambiguous) return { ok: true, readAt, 식별불가: `끝 4자리가 같은 원천 차량 ${hit.ambiguous}대 — 번호 전체가 필요(부재로 판정하지 않음)` };
    if (!hit) return { ok: true, readAt, 원천에없음: true, 데이터있음: !!prod, 데이터: prod ? { 상태: prod.status, 판매중: prod.listable === true } : null };
    row('상태', hit.상태, prod?.status_label_raw, hit.상태 ? (prod?.listable ? '데이터 판매중' : '데이터 판매 아님') : undefined);
    row('연료', hit.연료, prod?.fuel_type); row('주행거리', hit.주행거리, prod?.mileage); row('외장', hit.외장, prod?.ext_color);
    for (const [m, rent] of Object.entries(hit.월대여료 ?? {})) { const dk = prod?.price?.[m]; row(`${m}개월 월대여료`, rent, dk?.rent); }
    row('보증금(원천 한 칸)', hit.보증금, Object.values(prod?.price ?? {})[0]?.deposit, '참고');
    row('사진 수', hit.사진수, (Array.isArray(prod?.image_urls) ? prod.image_urls.length : 0) + (prod?.photo_link ? 1 : 0), hit.사진수 == null ? '원천 칸 없음' : undefined);
  } else if (c === 'RP023') {
    const res = await readSupplier(c, products); if (!res.ok) return { ok: false, reason: res.reason };
    readAt = res.readAt; const hit = findSourceRecord(res.records, prod, plate4);
    if (hit?.ambiguous) return { ok: true, readAt, 식별불가: `끝 4자리가 같은 원천 차량 ${hit.ambiguous}대 — 번호 전체가 필요(부재로 판정하지 않음)` };
    if (res.partial) return { ok: true, readAt, 판정: '홈페이지 목록 없음 — 부재 판정 불가(시트만으로는 공개 보류를 판단하지 않는다)', 원천: hit?.원천 ?? null, note: res.note };
    return { ok: true, readAt, 원천에있음: !!hit, 원천: hit?.원천 ?? null, 데이터: prod ? { 상태: prod.status, 사유: prod.status_reason, 판매중: prod.listable === true } : null,
      판정: hit ? (prod?.listable ? '원천에 있고 데이터 판매중' : '원천에 있으나 데이터 판매 아님') : (prod?.listable ? '원천(시트+홈페이지)에 없는데 데이터 판매중 → 공개 보류 후보' : '원천에 없고 데이터도 판매 아님'), note: res.note };
  } else return { ok: false, reason: c === 'RP012' ? BLOCKED.RP012.reason : '지원하지 않는 공급사' };
  if (!prod) note = '프리패스 데이터에 이 차량이 없음(원천에만 있음 → 수집 누락 후보)';
  const diff = rows.filter(r => r.판정 === '차이' || /차이|보류|아닌/.test(r.판정)).length;
  return { ok: true, readAt, 데이터읽은시각: new Date().toISOString(), 데이터마지막반영: prod?._direct_ingest_at ? new Date(prod._direct_ingest_at).toISOString() : null, 데이터마지막폴링: prod?._var_polled_at ? new Date(prod._var_polled_at).toISOString() : null, 차이건수: diff, 항목: rows, note };
}

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
  if (p4) { const r = res.records.filter(x => last4(x.plate) === p4); console.log(maskPlates({ readAt: res.readAt, 찾음: r.length, 레코드: r.map(x => ({ ...x, plate: `…${last4(x.plate)}` })) })); }
  else console.log(maskPlates({ 공급사: code, readAt: res.readAt, 원천대수: res.records.length, ...crossCheck(code, res, products), note: res.note, 필드: Object.keys(res.records[0] ?? {}) }));
} else if (cmd === 'compare' && code && opt('plate4')) {
  const n = Math.max(1, products.filter(p => (p.provider_company_code || p.partner_code) === code && last4(p.car_number) === opt('plate4')).length);
  for (let i = 0; i < n; i++) {
  const r = await compareOne(code, opt('plate4'), i);
  if (!r.ok) { console.error(`막힘: ${r.reason}`); process.exit(3); }
  const tag = n > 1 ? ` (끝4자리 같은 상품 ${i + 1}/${n}: ${(products.filter(p => (p.provider_company_code || p.partner_code) === code && last4(p.car_number) === opt('plate4'))[i]?.model ?? '?')})` : '';
  const mlog = (...a) => console.log(maskPlates(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x, null, 1))).join(' ')));
  if (argv.includes('--json')) console.log(maskPlates(r));
  else if (r.항목) {
    mlog(`[${NAMES[code]} …${opt('plate4')}]${tag} 원천 읽은 시각 ${r.readAt} · 데이터 마지막 반영 ${r.데이터마지막반영 ?? '-'} · 마지막 폴링 ${r.데이터마지막폴링 ?? '-'} · 차이 ${r.차이건수}건${r.note ? ' · ' + r.note : ''}`);
    mlog('항목 | 원천(정답) | 프리패스 데이터 | 판정'); for (const x of r.항목) mlog([x.항목, x.원천, x.데이터, x.판정].join(' | '));
  } else mlog(tag, r);
  }
} else { console.error('사용: compare <공급사코드> --plate4 XXXX | status | status | read <공급사코드> [--plate4 XXXX|--summary] [--out 파일]'); process.exit(2); }
