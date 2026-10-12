#!/usr/bin/env node
// 노출 하향·재노출 적용 — 원천 기준(대표 상시 승인 2026-10-12: «무조건 원천 기준, ERP 는 바뀌어야 될 데이터»).
//   node scripts/exposure-apply.mjs --plan <판매가능대수 --plan-out 파일> --supplier RP004 [--apply] [--max-ratio 0.5] [--max-age-min 15]
// 기본은 시험 실행(쓰기 0). --apply 일 때만 쓴다. 삭제 없음 — 문서는 그대로 두고 판매 상태 칸만 바꾼다(원문·가격 행·정책 불변).
// 안전선: ① 계획 digest 재계산 일치 ② 계획이 max-age-min 분 이내(원천이 그 뒤 바뀌었을 수 있어 오래되면 재계획) ③ 계약 잠금(locked_by_contract)·«계약중» 불변
//   ④ 한 공급사에서 하향 대상이 현재 판매 중의 max-ratio 이상이면 쓰기 전 중단 ⑤ 쓰기 직전 문서를 다시 읽어 공급사·판매 중·updateTime 일치(조건부 쓰기)
//   ⑥ 쓰기 전 이전 문서를 비공개 백업 파일에 쓰고 되읽어 같음을 확인 ⑦ 쓴 뒤 문서를 다시 읽어 기대 칸과 대조.
// 하향 표식은 이안카 노출 중단과 같은 규격: listable=false · status/vehicle_status=출고불가 · status_kind=불가 · publication_withdrawal{reason,…,deleteAuthorized:false}
//   이전 값은 publication_withdrawal_prior 에 보존(복원 가능). 열쇠·차량번호 전체는 출력하지 않는다(끝 4자리).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodeValue } from './supplier-freshness-lib.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const supplier = opt('supplier'), planPath = opt('plan');
const maxRatio = Number(opt('max-ratio', '0.5')), maxAgeMin = Number(opt('max-age-min', '15'));
if (!supplier || !planPath) { console.error('필수: --plan <파일> --supplier <공급사코드>'); process.exit(2); }
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/products`;
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const l4 = id => String(id).replace(/\s+/g, '').slice(-4);

const enc = v => v == null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = fields => Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, decodeValue(v)]));

const file = JSON.parse(readFileSync(planPath, 'utf8'));
const { digest, ...rest } = file;
const recomputed = createHash('sha256').update(JSON.stringify(rest.plans)).digest('hex');
if (recomputed !== digest) { console.error('중단: 계획 digest 불일치(파일이 바뀜)'); process.exit(3); }
const ageMin = (Date.now() - Date.parse(rest.readAt)) / 60000;
if (APPLY && ageMin > maxAgeMin) { console.error(`중단: 계획이 ${ageMin.toFixed(0)}분 전 것(상한 ${maxAgeMin}분) — 원천을 다시 읽어 계획을 새로 만든 뒤 적용`); process.exit(3); }
const plan = rest.plans[supplier];
if (!plan) { console.error('계획에 없는 공급사'); process.exit(2); }

async function getDoc(id) {
  const r = await fetch(`${BASE}/${encodeURIComponent(id)}`, { headers: H });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`READ_${r.status}`);
  const d = await r.json(); return { name: d.name, updateTime: d.updateTime, fields: dec(d.fields), raw: d.fields };
}
async function currentListableCount() {
  let n = 0, tok = ''; do { const q = new URLSearchParams({ pageSize: '300' }); for (const f of ['provider_company_code', 'listable']) q.append('mask.fieldPaths', f); if (tok) q.set('pageToken', tok);
    const r = await (await fetch(`${BASE}?${q}`, { headers: H })).json();
    for (const d of r.documents ?? []) { const f = dec(d.fields); if (f.provider_company_code === supplier && f.listable === true) n++; }
    tok = r.nextPageToken ?? ''; } while (tok);
  return n;
}

const withdrawal = (prior, reason) => ({
  listable: false, status: '출고불가', vehicle_status: '출고불가', status_kind: '불가',
  publication_withdrawal: { reason, source: supplier, planDigest: digest.slice(0, 16), planReadAt: rest.readAt, deleteAuthorized: false },
  publication_withdrawal_prior: { listable: prior.listable ?? null, status: prior.status ?? null, vehicle_status: prior.vehicle_status ?? null, status_kind: prior.status_kind ?? null },
});

// ── 하향 대상 선별(쓰기 직전 문서 재확인) ────────────────────────────────────────────────
const eligible = [], skipped = {};
const skip = (why, id) => { (skipped[why] ??= []).push(l4(id)); };
for (const item of plan.downgrade) {
  const doc = await getDoc(item.id);
  if (!doc) { skip('문서없음', item.id); continue; }
  const f = doc.fields;
  if ((f.provider_company_code ?? f.partner_code) !== supplier) { skip('공급사불일치', item.id); continue; }
  if (f.listable !== true) { skip('이미판매아님', item.id); continue; }
  if (f.locked_by_contract || f.status === '계약중') { skip('계약잠금', item.id); continue; }
  if (f.publication_withdrawal) { skip('이미보류표식', item.id); continue; }
  eligible.push({ item, doc });
}
const listableNow = await currentListableCount();
const ratio = listableNow ? eligible.length / listableNow : 0;
console.log(`[${supplier}] 계획 하향 ${plan.downgrade.length} → 대상 ${eligible.length}(현재 판매 중 ${listableNow}, 비율 ${(ratio * 100).toFixed(1)}%) · 제외 ${JSON.stringify(Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v.length])))} · 계획 ${ageMin.toFixed(0)}분 전`);
if (ratio >= maxRatio) { console.error(`중단: 하향 비율 ${(ratio * 100).toFixed(1)}% ≥ 상한 ${maxRatio * 100}% — 원천 대비 비정상 급감 가능성, 쓰기 전 확인 필요`); process.exit(4); }
if (!APPLY) { console.log('시험 실행(쓰기 0). 적용은 --apply'); process.exit(0); }

// ── 백업(쓰기 전, 되읽기 확인) ──────────────────────────────────────────────────────────
const dir = join(homedir(), '.codex', 'private', 'freepass-data-exposure-backups'); mkdirSync(dir, { recursive: true });
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${supplier}`;
const backupPath = join(dir, `exposure-${runId}.json`);
const backup = JSON.stringify({ schema: 'exposure-typed-backup/1', runId, project: PROJECT, supplier, planDigest: digest, docs: eligible.map(e => ({ id: e.item.id, updateTime: e.doc.updateTime, fields: e.doc.raw })) });
writeFileSync(backupPath, backup, { flag: 'wx', mode: 0o600 });
if (readFileSync(backupPath, 'utf8') !== backup) { console.error('중단: 백업 되읽기 불일치'); process.exit(5); }

// ── 조건부 쓰기 + 되읽기 ────────────────────────────────────────────────────────────────
let written = 0; const failed = [];
for (const { item, doc } of eligible) {
  const patch = withdrawal(doc.fields, item.reason);
  const mask = Object.keys(patch).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url = `${BASE}/${encodeURIComponent(item.id)}?${mask}&currentDocument.updateTime=${encodeURIComponent(doc.updateTime)}`;
  try {
    const r = await fetch(url, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, enc(v)])) }) });
    if (!r.ok) { failed.push(`${l4(item.id)}:HTTP${r.status}`); continue; }
    const after = await getDoc(item.id);
    const ok = after && after.fields.listable === false && after.fields.status === '출고불가' && after.fields.publication_withdrawal?.reason === item.reason
      && after.fields.price && JSON.stringify(after.fields.price) === JSON.stringify(doc.fields.price); // 가격 행 불변
    if (ok) written++; else failed.push(`${l4(item.id)}:READBACK`);
  } catch (e) { failed.push(`${l4(item.id)}:${e.message}`); }
}
console.log(`적용: 하향 ${written}/${eligible.length} · 되읽기 통과 ${written} · 실패 ${failed.length}${failed.length ? ' ' + failed.join(',') : ''} · 백업 ${backupPath.replace(homedir(), '~')}`);
process.exitCode = failed.length ? 6 : 0;
