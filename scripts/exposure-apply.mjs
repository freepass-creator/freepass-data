// Run with node scripts/exposure-apply.mjs (also imported by the pure-function tests).
// 노출 하향·재노출 적용 — 원천 기준(대표 상시 승인 2026-10-12: «무조건 원천 기준, ERP 는 바뀌어야 될 데이터»).
//   node scripts/exposure-apply.mjs --plan <판매가능대수 --plan-out 파일> --supplier RP004 [--apply] [--max-ratio 0.5] [--max-age-min 15]
//   node scripts/exposure-apply.mjs --approved-unsellable-supplier PT-0023 --approval-ref "대표 10-13 …" [--plan-out 파일] [--apply]
//     ↑ 대표 승인 «출고불가 공급사»(2026-10-13): 원천(F05 탭)이 없어 판매가능대수 계획에 들어오지 않는 공급사를, 승인 근거를 적어 통째로 하향한다.
//       이 옵션이 있을 때만 그 공급사의 현재 판매 중(listable=true) 문서를 읽어 같은 형식(exposure-plan/v1)의 계획을 만들고(파일·digest 기존 규칙),
//       그 공급사에 한해 하향 비율 상한을 100% 까지 허용한다. 다른 공급사·잠금·고정 문서 보호와 백업→조건부 쓰기→되읽기 절차는 그대로.
// 기본은 시험 실행(쓰기 0). --apply 일 때만 쓴다. 삭제 없음 — 문서는 그대로 두고 판매 상태 칸만 바꾼다(원문·가격 행·정책 불변).
// 안전선: ① 계획 digest 재계산 일치 ② 계획이 max-age-min 분 이내(원천이 그 뒤 바뀌었을 수 있어 오래되면 재계획) ③ 계약 잠금(locked_by_contract)·«계약중»·고정(_pin_state=pinned) 불변
//   ④ 한 공급사에서 하향 대상이 현재 판매 중의 max-ratio 이상이면 쓰기 전 중단(승인 공급사만 100% 허용) ⑤ 쓰기 직전 문서를 다시 읽어 공급사·판매 중·updateTime 일치(조건부 쓰기)
//   ⑥ 쓰기 전 이전 문서를 비공개 백업 파일에 쓰고 되읽어 같음을 확인 ⑦ 쓴 뒤 문서를 다시 읽어 기대 칸과 대조.
// 하향 표식은 이안카 노출 중단과 같은 규격: listable=false · status/vehicle_status=출고불가 · status_kind=불가 · publication_withdrawal{reason,…,deleteAuthorized:false}
//   이전 값은 publication_withdrawal_prior 에 보존(복원 가능). 열쇠·차량번호 전체는 출력하지 않는다(끝 4자리).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPROVED_REASON = 'APPROVED_UNSELLABLE_SUPPLIER';
export const SUPPLIER_CODE_RE = /^[A-Z]{2}-?\d{3,4}$/;
const l4 = id => String(id ?? '').replace(/\s+/g, '').slice(-4);
export const planDigest = plans => createHash('sha256').update(JSON.stringify(plans)).digest('hex');

export function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decodeValue(x)]));
  return null;
}
const enc = v => v == null ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'string' ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const dec = fields => Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, decodeValue(v)]));

/** 인자 해석. 두 입구 중 하나만: (--plan + --supplier) 또는 (--approved-unsellable-supplier + --approval-ref). 틀리면 { error } */
export function parseArgs(argv) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const out = { apply: argv.includes('--apply'), planPath: opt('plan'), planOut: opt('plan-out'), supplier: opt('supplier'),
    maxRatio: Number(opt('max-ratio', '0.5')), maxAgeMin: Number(opt('max-age-min', '15')),
    approvedSupplier: opt('approved-unsellable-supplier'), approvalRef: (opt('approval-ref') ?? '').trim() };
  if (out.approvedSupplier) {
    if (!SUPPLIER_CODE_RE.test(out.approvedSupplier)) return { error: `승인 공급사 코드 형식 오류: ${out.approvedSupplier}` };
    if (!out.approvalRef) return { error: '필수: --approval-ref "<대표 승인 근거(날짜·창구·한 줄)>"' };
    if (out.supplier && out.supplier !== out.approvedSupplier) return { error: '--supplier 와 --approved-unsellable-supplier 가 다르다' };
    if (out.planPath) return { error: '승인 하향은 계획을 스스로 만든다 — --plan 과 함께 쓰지 않는다' };
    out.supplier = out.approvedSupplier;
    return out;
  }
  if (!out.supplier || !out.planPath) return { error: '필수: --plan <파일> --supplier <공급사코드>  또는  --approved-unsellable-supplier <코드> --approval-ref "<근거>"' };
  return out;
}

/** 승인 공급사의 현재 판매 중 문서 → exposure-plan/v1 계획(sellable-count --plan-out 과 같은 모양·digest 규칙). 다른 공급사 문서는 들어오지 않는다. */
export function buildApprovedPlan(docs, supplier, approvalRef, { project = 'freepasserp5', readAt = new Date().toISOString() } = {}) {
  const downgrade = docs
    .filter(d => (d.fields.provider_company_code || d.fields.partner_code) === supplier && d.fields.listable === true)
    .map(d => ({ id: d.id, l4: l4(d.fields.car_number ?? d.id), status: d.fields.status ?? null, pinned: d.fields._pin_state === 'pinned', reason: APPROVED_REASON, updateTime: d.updateTime ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(downgrade.map(x => x.id)).size !== downgrade.length) throw new Error('PLAN_DUPLICATE_ID');
  // 승인 결박은 plans 안에 둔다 — digest 가 덮으므로 계획 파일에서 승인 근거·대상 공급사를 바꾸면 digest 불일치로 멈춘다.
  const approval = { kind: APPROVED_REASON, supplier, project, ref: approvalRef, allowFullDowngrade: true, readAt };
  const plans = { [supplier]: { name: supplier, sourceSellable: 0, unassignedPlateRows: 0, approval, downgrade, enroll: [], reexpose: [] } };
  return { schema: 'exposure-plan/v1', mode: 'DRY_RUN', writes: 0, readAt, plans, digest: planDigest(plans) };
}

/** 쓰기 직전 문서 재확인. 공급사 불일치·판매 아님·계약 잠금·이미 보류 표식은 건너뛴다.
 *  승인 하향(protectPinned)은 고정(_pin_state=pinned)과 계획 뒤 바뀐 문서(updateTime 다름)도 건너뛴다 — 기존 --plan 경로 뜻은 그대로. */
export async function selectEligible(downgrade, supplier, getDoc, { protectPinned = false } = {}) {
  const eligible = [], skipped = {}, seen = new Set();
  const skip = (why, id) => { (skipped[why] ??= []).push(l4(id)); };
  for (const item of downgrade) {
    if (seen.has(item.id)) { skip('중복', item.id); continue; } seen.add(item.id);
    const doc = await getDoc(item.id);
    if (!doc) { skip('문서없음', item.id); continue; }
    const f = doc.fields;
    if ((f.provider_company_code || f.partner_code) !== supplier) { skip('공급사불일치', item.id); continue; }
    if (f.listable !== true) { skip('이미판매아님', item.id); continue; }
    if (f.locked_by_contract || f.status === '계약중') { skip('계약잠금', item.id); continue; }
    if (protectPinned && f._pin_state === 'pinned') { skip('고정', item.id); continue; }
    if (protectPinned && item.updateTime && doc.updateTime !== item.updateTime) { skip('계획후변경', item.id); continue; }
    if (f.publication_withdrawal) { skip('이미보류표식', item.id); continue; }
    eligible.push({ item, doc });
  }
  return { eligible, skipped };
}

/** 하향 비율 가드. 승인 공급사(approval.supplier === supplier)만 100% 까지, 그 밖은 maxRatio 미만이어야 한다. */
export function ratioGuard({ eligibleCount, listableNow, maxRatio, supplier, approval }) {
  const ratio = listableNow ? eligibleCount / listableNow : 0;
  const approved = !!approval && approval.kind === APPROVED_REASON && approval.supplier === supplier && approval.allowFullDowngrade === true;
  const limit = approved ? 1.0 : maxRatio;
  const invalid = !Number.isFinite(ratio) || !Number.isFinite(limit) || limit <= 0 || (eligibleCount > 0 && !listableNow);
  return { ratio, approved, limit, blocked: invalid || (approved ? ratio > limit : ratio >= limit) };
}

/** 하향 표식(이안카 노출 중단과 같은 규격) + 이전 값 보존. 승인 하향이면 approvalRef 를 함께 적는다. */
export function withdrawalPatch(prior, { reason, supplier, digest, readAt, approvalRef }) {
  const publication_withdrawal = { reason, source: supplier, planDigest: digest.slice(0, 16), planReadAt: readAt, deleteAuthorized: false };
  if (approvalRef) publication_withdrawal.approvalRef = approvalRef;
  return {
    listable: false, status: '출고불가', vehicle_status: '출고불가', status_kind: '불가', publication_withdrawal,
    publication_withdrawal_prior: { listable: prior.listable ?? null, status: prior.status ?? null, vehicle_status: prior.vehicle_status ?? null, status_kind: prior.status_kind ?? null },
  };
}

/** 되읽기 비교용 정규화: 키 순서 무관, null/undefined/빈 맵 가지는 «없음»과 같다(REST 응답은 키 순서와 null 표현이 쓰기 전 읽은 것과 달라질 수 있다). */
export function canonicalValue(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map(canonicalValue);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) { const c = canonicalValue(v[k]); if (c !== null) out[k] = c; }
    return Object.keys(out).length ? out : null;
  }
  return v;
}
export const sameValue = (a, b) => JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));
/** 하향 쓰기 뒤 되읽기 판정: 표식 칸이 기대값이고 가격 행은 쓰기 전과 같다(deep 비교). */
export function readbackMatches(after, beforeFields, { reason, approval }) {
  if (!after) return false;
  const f = after.fields ?? after;
  return f.listable === false && f.status === '출고불가' && f.publication_withdrawal?.reason === reason
    && (!approval || f.publication_withdrawal?.approvalRef === approval.ref) && f.status_kind === '불가' && !!f.publication_withdrawal_prior
    && sameValue(f.price, beforeFields.price);
}

export const BACKUP_DIR = join(homedir(), '.codex', 'private', 'freepass-data-exposure-backups');

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) { console.error(args.error); process.exit(2); }
  const { apply: APPLY, supplier, maxRatio, maxAgeMin } = args;
  const PROJECT = process.env.FIREBASE_PROJECT_ID || 'freepasserp5';
  const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/products`;
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  async function getDoc(id) {
    const r = await fetch(`${BASE}/${encodeURIComponent(id)}`, { headers: H });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`READ_${r.status}`);
    const d = await r.json(); return { id, name: d.name, updateTime: d.updateTime, fields: dec(d.fields), raw: d.fields };
  }
  const LIST_FIELDS = ['car_number', 'provider_company_code', 'partner_code', 'listable', 'status', '_pin_state', 'locked_by_contract', 'publication_withdrawal'];
  async function listSupplierDocs() { // 공급사 문서 전부(판매 여부 포함) — 계획 만들기·현재 판매 중 수 세기
    const out = []; let tok = '';
    do {
      const q = new URLSearchParams({ pageSize: '300' }); for (const f of LIST_FIELDS) q.append('mask.fieldPaths', f); if (tok) q.set('pageToken', tok);
      const r = await fetch(`${BASE}?${q}`, { headers: H }); if (!r.ok) throw new Error(`LIST_${r.status}`);
      const body = await r.json();
      for (const d of body.documents ?? []) { const f = dec(d.fields); if ((f.provider_company_code || f.partner_code) === supplier) out.push({ id: d.name.split('/').pop(), updateTime: d.updateTime, fields: f }); }
      tok = body.nextPageToken ?? '';
    } while (tok);
    return out;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${supplier}`;
  let file;
  if (args.approvedSupplier) {
    // 승인 하향: 계획을 지금 읽은 문서로 만들어 파일에 남긴다(기존 형식). 그 뒤는 --plan 경로와 같은 절차.
    const supplierDocs = await listSupplierDocs();
    file = buildApprovedPlan(supplierDocs, supplier, args.approvalRef, { project: PROJECT });
    const planOut = args.planOut ?? join(BACKUP_DIR, `exposure-plan-${runId}.json`);
    writeFileSync(planOut, JSON.stringify(file, null, 1));
    console.log(`[${supplier}] 승인 하향 계획 digest ${file.digest.slice(0, 16)} · 판매 중 ${file.plans[supplier].downgrade.length}대 · 근거 «${args.approvalRef}» · 계획 ${planOut.replace(homedir(), '~')}`);
  } else {
    file = JSON.parse(readFileSync(args.planPath, 'utf8'));
  }
  const { digest, ...rest } = file;
  if (planDigest(rest.plans) !== digest) { console.error('중단: 계획 digest 불일치(파일이 바뀜)'); process.exit(3); }
  const readMs = Date.parse(rest.readAt);
  if (!Number.isFinite(readMs) || readMs > Date.now() + 60000) { console.error('중단: 계획 readAt 이 없거나 미래'); process.exit(3); }
  const ageMin = (Date.now() - readMs) / 60000;
  if (APPLY && ageMin > maxAgeMin) { console.error(`중단: 계획이 ${ageMin.toFixed(0)}분 전 것(상한 ${maxAgeMin}분) — 원천을 다시 읽어 계획을 새로 만든 뒤 적용`); process.exit(3); }
  const plan = rest.plans[supplier];
  if (!plan) { console.error('계획에 없는 공급사'); process.exit(2); }
  const approval = plan.approval ?? null;
  if (args.approvedSupplier && !approval) { console.error('중단: 승인 계획이 아니다'); process.exit(2); }
  if (approval && (approval.supplier !== supplier || approval.project !== PROJECT)) { console.error('중단: 계획의 승인 공급사·프로젝트와 실행 인자가 다르다'); process.exit(2); }
  if (approval && !approval.ref) { console.error('중단: 계획에 승인 근거가 없다'); process.exit(2); }

  // ── 하향 대상 선별(쓰기 직전 문서 재확인) ────────────────────────────────────────────────
  const { eligible, skipped } = await selectEligible(plan.downgrade, supplier, getDoc, { protectPinned: !!approval });
  const listableNow = (await listSupplierDocs()).filter(d => d.fields.listable === true).length;
  const guard = ratioGuard({ eligibleCount: eligible.length, listableNow, maxRatio, supplier, approval });
  console.log(`[${supplier}] 계획 하향 ${plan.downgrade.length} → 대상 ${eligible.length}(현재 판매 중 ${listableNow}, 비율 ${(guard.ratio * 100).toFixed(1)}%, 상한 ${guard.limit * 100}%${guard.approved ? ' — 대표 승인 공급사' : ''}) · 제외 ${JSON.stringify(Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v.length])))} · 계획 ${ageMin.toFixed(0)}분 전`);
  if (guard.blocked) { console.error(`중단: 하향 비율 ${(guard.ratio * 100).toFixed(1)}% ≥ 상한 ${guard.limit * 100}% — 원천 대비 비정상 급감 가능성, 쓰기 전 확인 필요`); process.exit(4); }
  if (!APPLY) { console.log('시험 실행(쓰기 0). 적용은 --apply'); process.exit(0); }
  if (!eligible.length) { console.log('적용 대상 0 — 쓰기 없음'); process.exit(0); }

  // ── 백업(쓰기 전, 되읽기 확인) ──────────────────────────────────────────────────────────
  const backupPath = join(BACKUP_DIR, `exposure-${runId}.json`);
  const backup = JSON.stringify({ schema: 'exposure-typed-backup/1', runId, project: PROJECT, supplier, planDigest: digest, approval, docs: eligible.map(e => ({ id: e.item.id, updateTime: e.doc.updateTime, fields: e.doc.raw })) });
  writeFileSync(backupPath, backup, { flag: 'wx', mode: 0o600 });
  if (readFileSync(backupPath, 'utf8') !== backup) { console.error('중단: 백업 되읽기 불일치'); process.exit(5); }

  // ── 조건부 쓰기 + 되읽기 ────────────────────────────────────────────────────────────────
  let written = 0; const failed = [];
  for (const { item, doc } of eligible) {
    const patch = withdrawalPatch(doc.fields, { reason: item.reason, supplier, digest, readAt: rest.readAt, approvalRef: approval?.ref });
    const mask = Object.keys(patch).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const url = `${BASE}/${encodeURIComponent(item.id)}?${mask}&currentDocument.updateTime=${encodeURIComponent(doc.updateTime)}`;
    try {
      const r = await fetch(url, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, enc(v)])) }) });
      if (!r.ok) { failed.push(`${l4(item.id)}:HTTP${r.status}`); continue; }
      const after = await getDoc(item.id);
      const ok = readbackMatches(after, doc.fields, { reason: item.reason, approval }); // 가격 행 불변은 deep 비교(키 순서·null 무시)
      if (ok) written++; else failed.push(`${l4(item.id)}:READBACK`);
    } catch (e) { failed.push(`${l4(item.id)}:${e.message}`); }
  }
  console.log(`적용: 하향 ${written}/${eligible.length} · 되읽기 통과 ${written} · 실패 ${failed.length}${failed.length ? ' ' + failed.join(',') : ''}${approval ? ` · 승인 근거 «${approval.ref}»` : ''} · 백업 ${backupPath.replace(homedir(), '~')}`);
  process.exitCode = failed.length ? 6 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
