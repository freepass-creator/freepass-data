import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { buildPolicyLinkPlan, IANCAR_COMMON_POLICY_CODE, IANCAR_S_CODES, isPolicyEmpty, type PolicyLinkScope, type VehicleTerms } from '../domain/iancar-policy-link.js';
import { decodeIancarBackupValue, encodeIancarBackupValue } from './iancar-backup-value.js';
import { getTargetFirebaseApp } from './firebase-target.js';
import { stableDigest } from '../shared/stable-digest.js';

const BACKUP_BUCKET = 'freepasserp5-data-audit-evidence';   // 기존 비공개 증거 버킷(코드가 이 버킷만 허용)

/** 원천(ONE 요금 원문)에서 차량 한 대의 조건을 읽는 함수. 원천에 없거나(404) 읽지 못하면 terms 없이 사유만 돌려준다. */
export type FetchVehicleTerms = (vehicleId: string) => Promise<{ terms?: VehicleTerms; error?: string }>;

async function readInputs(db: ReturnType<typeof getFirestore>, fetchTerms: FetchVehicleTerms, scope: PolicyLinkScope = 'ALL') {
  const policySnap = await db.collection('policy').doc(IANCAR_COMMON_POLICY_CODE).get();
  const productsSnap = await db.collection('products').where('provider_company_code', '==', 'RP031').get();
  const products = productsSnap.docs.map(doc => ({ id: doc.id, updateTimeMs: doc.updateTime.toMillis(), data: doc.data() }));
  const vehicleTerms: Record<string, VehicleTerms | undefined> = {}, vehicleTermsErrors: Record<string, string> = {};
  // 원천 요금 조회는 동시 3개까지(ONE 429 방지) — 결과는 상품 순서와 무관하게 상품 ID 로 모은다.
  const isSCoded = (data: Record<string, unknown>) => typeof data.policy_code === 'string' && IANCAR_S_CODES.includes(data.policy_code);
  const listed = products.filter(product => product.data.listable === true && (scope === 'ALL' || (scope === 'S_RELINK' ? isSCoded(product.data) : isPolicyEmpty(product.data))));   // 범위 밖(이미 정책 있음) 상품은 원천을 조회하지도 않는다
  for (const product of listed) if (typeof product.data.iancar_one_vehicle_id !== 'string' || !product.data.iancar_one_vehicle_id.trim()) vehicleTermsErrors[product.id] = 'ID_MISSING';   // 조회 못 한 노출 차량은 침묵하지 않고 오류로 남긴다
  const queue = listed.filter(product => !(product.id in vehicleTermsErrors));
  let cursor = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < queue.length) {
      const product = queue[cursor++]!;
      const result = await fetchTerms(product.data.iancar_one_vehicle_id as string);
      if (result.terms) vehicleTerms[product.id] = result.terms; else vehicleTermsErrors[product.id] = result.error ?? 'UNKNOWN';
    }
  }));
  const sPolicies: Record<string, { exists: boolean; updateTimeMs: number | null; dataDigest: string | null }> = {};
  if (scope === 'S_FROM_NULL' || scope === 'S_RELINK') for (const code of IANCAR_S_CODES) {
    const snap = await db.collection('policy').doc(code).get();
    sPolicies[code] = { exists: snap.exists, updateTimeMs: snap.updateTime?.toMillis() ?? null, dataDigest: snap.exists ? stableDigest(encodeIancarBackupValue(snap.data() ?? {})) : null };
  }
  return { policy: { exists: policySnap.exists, updateTimeMs: policySnap.updateTime?.toMillis() ?? null, data: policySnap.data() ?? {} }, products, vehicleTerms, vehicleTermsErrors, sPolicies };
}

/** 읽기 전용 계획. 쓰기 없음. */
export async function planIancarPolicyLinkFromFirestore(options: { fetchTerms: FetchVehicleTerms; scope?: PolicyLinkScope }) {
  const db = getFirestore(getTargetFirebaseApp());
  return buildPolicyLinkPlan(await readInputs(db, options.fetchTerms, options.scope ?? 'ALL'), { scope: options.scope ?? 'ALL' });
}

/** 승인된 digest 와 같은 계획만 적용한다: 비공개 백업(로컬+버킷) → 조건부 트랜잭션(문서 updateTime 일치) → 되읽기. 삭제 없음. */
export async function applyIancarPolicyLink(options: { expectedPlanDigest: string; expectedPolicyDocumentChanges: number; fetchTerms: FetchVehicleTerms; scope?: PolicyLinkScope }) {
  const app = getTargetFirebaseApp();
  if (app.options.projectId !== 'freepasserp5') throw new Error('IANCAR_POLICY_LINK_WRONG_PROJECT');
  const db = getFirestore(app);
  const scope = options.scope ?? 'ALL';
  const inputs = await readInputs(db, options.fetchTerms, scope);
  const plan = buildPolicyLinkPlan(inputs, { scope });
  if (plan.blockers.length) throw Object.assign(new Error('IANCAR_POLICY_LINK_BLOCKED'), { blockers: plan.blockers });
  if (plan.planDigest !== options.expectedPlanDigest) throw new Error('IANCAR_POLICY_LINK_PLAN_CHANGED');
  // 정책 문서 변경 건수 관문: 승인 범위(기대 건수)와 다르면 쓰기 전에 중단한다.
  if (plan.counts.policyDocumentChanges !== options.expectedPolicyDocumentChanges) throw Object.assign(new Error('IANCAR_POLICY_LINK_POLICY_DOCUMENT_CHANGES_MISMATCH'), { planned: plan.counts.policyDocumentChanges, expected: options.expectedPolicyDocumentChanges });

  const policyRef = db.collection('policy').doc(IANCAR_COMMON_POLICY_CODE);
  const policyBeforeData = inputs.policy.data;
  const policyKeys = Object.keys(plan.policyPatch);
  const runId = randomUUID();
  const backup = JSON.stringify({
    schema: 'iancar-policy-link-typed-backup/1', runId, projectId: 'freepasserp5', planDigest: plan.planDigest, capturedAt: new Date().toISOString(),
    policy: { path: policyRef.path, updateTimeMs: inputs.policy.updateTimeMs, before: Object.fromEntries(policyKeys.map(k => [k, k in policyBeforeData ? encodeIancarBackupValue(policyBeforeData[k]) : { type: 'absent' }])), patch: encodeIancarBackupValue(plan.policyPatch) },
    documents: plan.productPatches.map(row => {
      const before = inputs.products.find(p => p.id === row.id)!.data;
      return { path: `products/${row.id}`, updateTimeMs: row.updateTimeMs,
        before: Object.fromEntries(Object.keys(row.patch).map(k => [k, k in before ? encodeIancarBackupValue(before[k]) : { type: 'absent' }])),
        patch: encodeIancarBackupValue(row.patch) };
    }),
  });
  const dir = join(homedir(), '.codex', 'private', 'freepass-data-iancar-policy-link');
  await mkdir(dir, { recursive: true });
  const backupPath = join(dir, `policy-link-${runId}.json`);
  await writeFile(backupPath, backup, { flag: 'wx', mode: 0o600 });
  if (await readFile(backupPath, 'utf8') !== backup) throw new Error('IANCAR_POLICY_LINK_BACKUP_READBACK_FAILED');
  const objectName = `iancar-policy-link/${runId}/backup.json`;
  const file = getStorage(app).bucket(BACKUP_BUCKET).file(objectName);
  await file.save(backup, { resumable: false, contentType: 'application/json', preconditionOpts: { ifGenerationMatch: 0 } });
  const [bytes] = await file.download();
  if (bytes.toString('utf8') !== backup) throw new Error('IANCAR_POLICY_LINK_PRIVATE_BACKUP_READBACK_FAILED');

  await db.runTransaction(async tx => {
    const refs = [policyRef, ...plan.productPatches.map(row => db.collection('products').doc(row.id))];
    const sRefs = Object.keys(inputs.sPolicies ?? {}).map(code => db.collection('policy').doc(code));
    const current = await tx.getAll(...refs);
    const sCurrent = sRefs.length ? await tx.getAll(...sRefs) : [];
    sCurrent.forEach((snap, i) => { if (snap.updateTime?.toMillis() !== (inputs.sPolicies ?? {})[sRefs[i]!.id]?.updateTimeMs) throw new Error('IANCAR_POLICY_LINK_REVISION_CHANGED'); });
    if (current[0]!.updateTime?.toMillis() !== inputs.policy.updateTimeMs) throw new Error('IANCAR_POLICY_LINK_REVISION_CHANGED');
    plan.productPatches.forEach((row, i) => { if (current[i + 1]!.updateTime?.toMillis() !== row.updateTimeMs) throw new Error('IANCAR_POLICY_LINK_REVISION_CHANGED'); });
    if (policyKeys.length) tx.update(policyRef, plan.policyPatch);
    plan.productPatches.forEach((row, i) => tx.update(refs[i + 1]!, row.patch));
  });
  // 되읽기: 계획한 칸이 정확히 반영됐는지 + 계획 밖 칸이 바뀌지 않았는지 (S 연결은 S 정책 문서가 한 글자도 안 바뀐 것도 증명)
  for (const [code, before] of Object.entries(inputs.sPolicies ?? {})) {
    const snap = await db.collection('policy').doc(code).get();
    if (stableDigest(encodeIancarBackupValue(snap.data() ?? {})) !== before.dataDigest || snap.updateTime?.toMillis() !== before.updateTimeMs) throw Object.assign(new Error('IANCAR_POLICY_LINK_S_POLICY_CHANGED'), { runId, backupPath });
  }
  const afterPolicy = (await policyRef.get()).data() ?? {};
  for (const [k, v] of Object.entries(plan.policyPatch)) if (stableDigest(afterPolicy[k]) !== stableDigest(v)) throw Object.assign(new Error('IANCAR_POLICY_LINK_READBACK_FAILED'), { runId, backupPath });
  for (const [k, v] of Object.entries(policyBeforeData)) if (!(k in plan.policyPatch) && stableDigest(afterPolicy[k]) !== stableDigest(v)) throw Object.assign(new Error('IANCAR_POLICY_LINK_UNEXPECTED_FIELD_CHANGE'), { runId, backupPath });
  for (const row of plan.productPatches) {
    const after = (await db.collection('products').doc(row.id).get()).data() ?? {};
    const before = inputs.products.find(p => p.id === row.id)!.data;
    for (const [k, v] of Object.entries(row.patch)) if (stableDigest(after[k]) !== stableDigest(v)) throw Object.assign(new Error('IANCAR_POLICY_LINK_READBACK_FAILED'), { runId, backupPath });
    for (const [k, v] of Object.entries(before)) if (!(k in row.patch) && stableDigest(after[k]) !== stableDigest(v)) throw Object.assign(new Error('IANCAR_POLICY_LINK_UNEXPECTED_FIELD_CHANGE'), { runId, backupPath });
  }
  return { status: 'POLICY_LINK_READBACK_VERIFIED', runId, backupPath, privateBackupObject: objectName, planDigest: plan.planDigest, counts: plan.counts, writeExecuted: true };
}

/** 복원 대상 행만 남긴다: 되돌릴 이전 값(before)이 하나도 없는 행(변경 0 이었던 정책 문서)은 건드리지 않는다. */
export const restorableRows = <T extends { before: Record<string, unknown> }>(rows: readonly T[]): T[] => rows.filter(r => Object.keys(r.before).length > 0);

/** 적용 뒤 문서가 아직 계획 값 그대로일 때만 되돌린다(그 사이 바뀌었으면 중단). 이전에 없던 칸은 삭제하지 않고 null 로 되돌린다. */
export async function restoreIancarPolicyLink(options: { backupPath: string; expectedPlanDigest: string; apply: boolean }) {
  const backup = JSON.parse(await readFile(options.backupPath, 'utf8'));
  if (backup.schema !== 'iancar-policy-link-typed-backup/1' || backup.projectId !== 'freepasserp5' || backup.planDigest !== options.expectedPlanDigest) throw new Error('IANCAR_POLICY_LINK_RESTORE_BACKUP_INVALID');
  const db = getFirestore(getTargetFirebaseApp());
  const rows: { path: string; before: Record<string, any>; patch: Record<string, any> }[] = [
    { path: backup.policy.path, before: backup.policy.before, patch: backup.policy.patch },
    ...backup.documents.map((d: any) => ({ path: d.path, before: d.before, patch: d.patch })),
  ];
  const decodedAll = rows.map(r => ({ path: r.path, patch: decodeIancarBackupValue(r.patch, p => db.doc(p)) as Record<string, unknown>,
    before: Object.fromEntries(Object.entries(r.before).map(([k, v]) => [k, (v as any)?.type === 'absent' ? undefined : decodeIancarBackupValue(v, p => db.doc(p))])) }));
  // 복원할 칸이 없는 행(NULL_POLICY_ONLY 적용의 정책 문서: patch·before 모두 {})은 제외 — 빈 update 는 Firestore 가 거절해 트랜잭션 전체가 실패한다(Codex 검토 P1).
  const decoded = restorableRows(decodedAll);
  await db.runTransaction(async tx => {
    const snaps = await tx.getAll(...decoded.map(r => db.doc(r.path)));
    snaps.forEach((snap, i) => {
      const data = snap.data() ?? {};
      for (const [k, v] of Object.entries(decoded[i]!.patch)) if (stableDigest(data[k]) !== stableDigest(v)) throw new Error('IANCAR_POLICY_LINK_RESTORE_REVISION_CHANGED');
    });
    if (!options.apply) return;
    // 이전에 없던 칸은 지우지 않고 null 로 되돌린다(들어온 데이터는 삭제가 아니라 상태로 정리한다는 규칙).
    decoded.forEach(r => tx.update(db.doc(r.path), Object.fromEntries(Object.entries(r.before).map(([k, v]) => [k, v === undefined ? null : v]))));
  });
  return { status: options.apply ? 'RESTORED_REQUIRES_READBACK' : 'RESTORE_PLAN_VERIFIED', count: decoded.length, deletes: 0 };
}
