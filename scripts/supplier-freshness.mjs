#!/usr/bin/env node
// 공급사 갱신 신선도 점검 — 읽기 전용(Firestore 읽기만), AI 토큰 0. 상태 파일만 로컬(.local, git 제외)에 쓴다.
// 사용: node scripts/supplier-freshness.mjs [--json] [--no-save]   (gcloud 로그인 필요. 15분~1시간마다 돌릴수록 정확)
// 차량번호는 저장·출력하지 않는다(해시만).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applySnapshot, computeMetrics, decodeValue, digestOf, emptyState, ourObservedMs, sha } from './supplier-freshness-lib.mjs';

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
const stateFile = process.env.FRESHNESS_STATE_FILE || join(process.cwd(), '.local', 'supplier-freshness', 'state.json');
const args = new Set(process.argv.slice(2));
const FIELDS = ['car_number', 'provider_company_code', 'partner_code', 'listable', 'price', 'status', 'status_label_raw', 'vehicle_status',
  'status_kind', 'mileage', 'options', '원문', '_var_polled_at', '_direct_ingest_at', '_mirror_at', '_var_synced_at'];

const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
async function readAll() {
  const out = []; let pageToken = '';
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    for (const f of FIELDS) q.append('mask.fieldPaths', /^[A-Za-z_][A-Za-z0-9_]*$/.test(f) ? f : '`' + f + '`');
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/products?${q}`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`FIRESTORE_READ_${res.status}`);
    const body = await res.json();
    for (const d of body.documents ?? []) out.push({ ...Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, decodeValue(v)])), __updateTime: d.updateTime });
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

const now = Date.now();
const docs = await readAll();
const rows = docs.filter(f => f.car_number).map(f => ({
  id: sha(f.car_number), sup: f.provider_company_code || f.partner_code || '', listable: f.listable === true,
  digest: digestOf(f), ourMs: ourObservedMs(f), touchedMs: Date.parse(f.__updateTime) || null }));
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : emptyState();
applySnapshot(state, rows, now);
const metrics = computeMetrics(state, rows, now);
if (!args.has('--no-save')) { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify(state)); }

const f1 = n => n == null ? '-' : n.toFixed(1);
const result = { observedAt: new Date(now).toISOString(), totalProducts: rows.length, listable: rows.filter(r => r.listable).length,
  runsRecorded: state.runs.length, baselineOnly: state.runs.every(r => r.baseline), suppliers: metrics,
  stalled: metrics.filter(m => m.verdict === 'SUPPLIER_STALE').map(m => m.code),
  ourStale: metrics.filter(m => m.verdict === 'OBSERVATION_STAMP_STALE').map(m => m.code) };
if (args.has('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`관측 ${result.observedAt} · 상품 ${result.totalProducts} · 판매중 ${result.listable} · 기록 회차 ${result.runsRecorded}`);
  console.log('공급사 | 판매중/전체 | 24h변경 | 우리관측경과(중앙/p90,h) | 마지막쓰기경과(중앙/p90,h) | 변경후경과(중앙/p90,h) | 평소주기h | 판정');
  for (const m of metrics) console.log([m.code, `${m.listable}/${m.total}`, m.changed24h, `${f1(m.ourObservedAgeH.median)}/${f1(m.ourObservedAgeH.p90)}`, `${f1(m.anyWriteAgeH.median)}/${f1(m.anyWriteAgeH.p90)}`,
    `${f1(m.sinceChangeH.median)}/${f1(m.sinceChangeH.p90)}`, f1(m.typicalIntervalH), m.verdict].join(' | '));
  console.log(`공급사 정체: ${result.stalled.join(', ') || '없음'} · 관측 도장 정체: ${result.ourStale.join(', ') || '없음'}`);
}
