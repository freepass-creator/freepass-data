#!/usr/bin/env node
// 아이카·빌린카 새 수집 파이프라인 편입 현황 — 읽기 전용(프리패스 데이터 읽기만), AI 토큰 0. 차량번호는 출력·저장하지 않는다.
// 사용: node scripts/supplier-intake-coverage.mjs [--json]   (gcloud 로그인 필요)
import { execFileSync } from 'node:child_process';
import { decodeFields, intakeCoverage } from './supplier-intake-coverage-lib.mjs';

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
const DOCS = `projects/${PROJECT}/databases/(default)/documents`;
const BASE = `https://firestore.googleapis.com/v1/${DOCS}`;
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const call = async (url, init) => {
  const r = await fetch(url, { headers, ...init });
  if (!r.ok) throw new Error(`FIRESTORE_READ_${r.status}`);
  return r.json();
};
const runQuery = structuredQuery => call(`${BASE}:runQuery`, { method: 'POST', body: JSON.stringify({ structuredQuery }) });

async function listAll(collection, fields) {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ pageSize: '300' });
    for (const f of fields) q.append('mask.fieldPaths', f);
    if (pageToken) q.set('pageToken', pageToken);
    const body = await call(`${BASE}/${collection}?${q}`);
    for (const d of body.documents ?? []) out.push(decodeFields(d.fields ?? {}));
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

const products = (await listAll('products', ['car_number', 'provider_company_code', 'partner_code', 'listable']))
  .filter(d => d.car_number)
  .map(d => ({ plate: d.car_number, supplier: d.provider_company_code || d.partner_code || '', listable: d.listable === true }));
const runs = (await runQuery({ from: [{ collectionId: 'source_runs' }],
  orderBy: [{ field: { fieldPath: 'observedAt' }, direction: 'DESCENDING' }], limit: 200,
  select: { fields: ['sourceId', 'observedAt', 'status', 'runId'].map(fieldPath => ({ fieldPath })) } }))
  .filter(r => r.document).map(r => decodeFields(r.document.fields));
const latest = runs.find(r => r.sourceId?.startsWith('shared-sheet:') && r.status === 'COMPLETED');

const rawRows = [];
if (latest) {
  // 최신 완료 run 의 raw 문서 ID 는 «<runId>:<해시>» — ID 접두 범위로만 읽는다(전체 스캔 금지).
  let after = null;
  for (;;) {
    const res = (await runQuery({ from: [{ collectionId: 'raw_records' }],
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: '__name__' }, op: 'GREATER_THAN_OR_EQUAL', value: { referenceValue: `${DOCS}/raw_records/${latest.runId}:` } } },
        { fieldFilter: { field: { fieldPath: '__name__' }, op: 'LESS_THAN', value: { referenceValue: `${DOCS}/raw_records/${latest.runId};` } } }] } },
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: 300,
      ...(after ? { startAt: { values: [{ referenceValue: after }], before: false } } : {}) })).filter(r => r.document);
    for (const r of res) {
      const f = decodeFields(r.document.fields ?? {});
      rawRows.push({ tab: f.payload?.tab, plate: f.payload?.values?.[4] });
    }
    if (res.length < 300) break;
    after = res.at(-1).document.name;
  }
}

// 차량번호 열 가정(values[4]) 검증: 값이 번호판 모양인 행이 90% 미만이면 편입률을 믿지 않는다.
const platePattern = /^\d{2,3}[가-힣]\d{4}$/;
const plateShape = rawRows.length ? rawRows.filter(r => platePattern.test(String(r.plate ?? '').replace(/\s+/g, ''))).length / rawRows.length : 0;
const result = { plateColumnVerified: plateShape >= 0.9, observedAt: new Date().toISOString(), latestSharedSheetRun: latest?.observedAt ?? null, rawRows: rawRows.length,
  suppliers: intakeCoverage({ products, rawRows, runs, nowMs: Date.now() }) };
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  if (!result.plateColumnVerified) console.log('경고: 원문 차량번호 열 가정이 맞지 않는다 — 편입률 신뢰 불가');
  console.log(`관측 ${result.observedAt} · 최신 공통 시트 run ${result.latestSharedSheetRun ?? '없음'} · raw ${result.rawRows}행`);
  console.log('공급사 | 경로 | 판매중/전체 | 편입 | 편입률 | 마지막 run 경과(분) | 판정');
  for (const s of result.suppliers) {
    console.log([`${s.code} ${s.label}`, s.route, `${s.listable}/${s.total}`, s.intaken, s.intakeRate ?? '-', s.lastRunAgeMin ?? '-', s.verdict].join(' | '));
  }
}
