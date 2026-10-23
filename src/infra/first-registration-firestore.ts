import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { buildFirstRegistrationPlan } from '../domain/first-registration-normalize.js';
import { decodeIancarBackupValue, encodeIancarBackupValue } from './iancar-backup-value.js';
import { getTargetFirebaseApp } from './firebase-target.js';
import { stableDigest } from '../shared/stable-digest.js';

const BACKUP_BUCKET = 'freepasserp5-data-audit-evidence';   // 기존 비공개 증거 버킷(코드가 이 버킷만 허용)

async function readProducts(db: ReturnType<typeof getFirestore>) {
  const snap = await db.collection('products').where('listable', '==', true).get();
  return snap.docs.map(doc => ({ id: doc.id, updateTimeMs: doc.updateTime.toMillis(), data: doc.data() }));
}

/** 읽기 전용 계획(쓰기 0). nowMs 는 계획과 적용이 같은 값을 쓰도록 호출자가 고정해 넘긴다(미래 날짜 판정). */
export async function planFirstRegistration(options: { nowMs: number }) {
  const db = getFirestore(getTargetFirebaseApp());
  return buildFirstRegistrationPlan({ products: await readProducts(db), nowMs: options.nowMs });
}

/** 승인된 digest 와 같은 계획만 적용: 비공개 백업(로컬+버킷) → 문서 updateTime 조건부 트랜잭션 → 되읽기(계획 칸 일치 + 계획 밖 칸 불변). 삭제 없음. */
export async function applyFirstRegistration(options: { nowMs: number; expectedPlanDigest: string }) {
  const app = getTargetFirebaseApp();
  if (app.options.projectId !== 'freepasserp5') throw new Error('FIRST_REGISTRATION_WRONG_PROJECT');
  const db = getFirestore(app);
  const products = await readProducts(db);
  const plan = buildFirstRegistrationPlan({ products, nowMs: options.nowMs });
  if (plan.planDigest !== options.expectedPlanDigest) throw new Error('FIRST_REGISTRATION_PLAN_CHANGED');
  const appliedAt = new Date().toISOString();
  const patches = plan.patches.map(row => ({ ...row, patch: Object.fromEntries(Object.entries(row.patch).map(([k, v]) =>
    [k, k === 'first_registration_date_correction' ? { ...(v as Record<string, unknown>), at: appliedAt } : v])) }));
  const runId = randomUUID();
  const backup = JSON.stringify({
    schema: 'first-registration-typed-backup/1', runId, projectId: 'freepasserp5', planDigest: plan.planDigest, capturedAt: appliedAt,
    documents: patches.map(row => {
      const before = products.find(p => p.id === row.id)!.data;
      return { path: `products/${row.id}`, updateTimeMs: row.updateTimeMs,
        before: Object.fromEntries(Object.keys(row.patch).map(k => [k, k in before ? encodeIancarBackupValue(before[k]) : { type: 'absent' }])),
        patch: encodeIancarBackupValue(row.patch) };
    }),
  });
  const dir = join(homedir(), '.codex', 'private', 'freepass-data-first-registration');
  await mkdir(dir, { recursive: true });
  const backupPath = join(dir, `first-registration-${runId}.json`);
  await writeFile(backupPath, backup, { flag: 'wx', mode: 0o600 });
  if (await readFile(backupPath, 'utf8') !== backup) throw new Error('FIRST_REGISTRATION_BACKUP_READBACK_FAILED');
  const objectName = `first-registration/${runId}/backup.json`;
  const file = getStorage(app).bucket(BACKUP_BUCKET).file(objectName);
  await file.save(backup, { resumable: false, contentType: 'application/json', preconditionOpts: { ifGenerationMatch: 0 } });
  const [bytes] = await file.download();
  if (bytes.toString('utf8') !== backup) throw new Error('FIRST_REGISTRATION_PRIVATE_BACKUP_READBACK_FAILED');

  // 500건 한도를 피해 100건씩 트랜잭션(각 문서 updateTime 조건). 중간에 실패하면 이미 쓴 묶음은 백업으로 복원한다.
  const CHUNK = 100;
  for (let i = 0; i < patches.length; i += CHUNK) {
    const part = patches.slice(i, i + CHUNK);
    await db.runTransaction(async tx => {
      const refs = part.map(row => db.collection('products').doc(row.id));
      const current = await tx.getAll(...refs);
      part.forEach((row, j) => { if (current[j]!.updateTime?.toMillis() !== row.updateTimeMs) throw Object.assign(new Error('FIRST_REGISTRATION_REVISION_CHANGED'), { runId, backupPath }); });
      part.forEach((row, j) => tx.update(refs[j]!, row.patch));
    });
  }
  for (const row of patches) {
    const after = (await db.collection('products').doc(row.id).get()).data() ?? {};
    const before = products.find(p => p.id === row.id)!.data;
    for (const [k, v] of Object.entries(row.patch)) if (stableDigest(after[k] ?? null) !== stableDigest(v)) throw Object.assign(new Error('FIRST_REGISTRATION_READBACK_FAILED'), { runId, backupPath });
    for (const [k, v] of Object.entries(before)) if (!(k in row.patch) && stableDigest(after[k]) !== stableDigest(v)) throw Object.assign(new Error('FIRST_REGISTRATION_UNEXPECTED_FIELD_CHANGE'), { runId, backupPath });
  }
  return { status: 'FIRST_REGISTRATION_READBACK_VERIFIED', runId, backupPath, privateBackupObject: objectName, planDigest: plan.planDigest, summary: plan.summary, writeExecuted: true };
}

const RESTORE_FIELDS = new Set(['first_registration_date', 'first_registration_date_precision', 'first_registration_date_correction']);

/** 복원: 문서가 «적용 값 그대로»면 되돌리고, 이미 «이전 값»이면 건너뛴다(부분 적용·재시도 가능). 둘 다 아니면 중단한다. 이전에 없던 칸은 삭제하지 않고 null 로 둔다(삭제 금지 원칙). 끝나면 되읽기. */
export async function restoreFirstRegistration(options: { backupPath: string; expectedPlanDigest: string; apply: boolean }) {
  const backup = JSON.parse(await readFile(options.backupPath, 'utf8'));
  const app = getTargetFirebaseApp();
  if (backup.schema !== 'first-registration-typed-backup/1' || backup.projectId !== 'freepasserp5' || app.options.projectId !== 'freepasserp5' || backup.planDigest !== options.expectedPlanDigest) throw new Error('FIRST_REGISTRATION_RESTORE_BACKUP_INVALID');
  const db = getFirestore(app);
  const rows = backup.documents.map((d: any) => {
    if (typeof d.path !== 'string' || !/^products\/[^/]+$/.test(d.path)) throw new Error('FIRST_REGISTRATION_RESTORE_PATH_INVALID');
    const patch = decodeIancarBackupValue(d.patch, p => db.doc(p)) as Record<string, unknown>;
    const before: Record<string, unknown> = {}; const absent = new Set<string>();
    for (const [k, v] of Object.entries(d.before as Record<string, any>)) {
      if (!RESTORE_FIELDS.has(k) || !(k in patch)) throw new Error('FIRST_REGISTRATION_RESTORE_FIELD_INVALID');
      if (v?.type === 'absent') absent.add(k); else before[k] = decodeIancarBackupValue(v, p => db.doc(p));
    }
    return { path: d.path as string, patch, before, absent };
  });
  type Row = (typeof rows)[number];
  const isApplied = (data: Record<string, unknown>, r: Row) => Object.keys(r.patch).every(k => stableDigest(data[k] ?? null) === stableDigest(r.patch[k]));
  const isRestored = (data: Record<string, unknown>, r: Row) => Object.keys(r.patch).every(k => stableDigest(data[k] ?? null) === stableDigest(r.absent.has(k) ? null : r.before[k]));
  for (let i = 0; i < rows.length; i += 100) {
    const part: Row[] = rows.slice(i, i + 100);
    await db.runTransaction(async tx => {
      const snaps = await tx.getAll(...part.map(r => db.doc(r.path)));
      snaps.forEach((snap, j) => {
        const r = part[j]!; const data = (snap.data() ?? {}) as Record<string, unknown>;
        if (isRestored(data, r)) return;                                   // 이미 이전 값 — 건너뜀
        if (!isApplied(data, r)) throw new Error('FIRST_REGISTRATION_RESTORE_REVISION_CHANGED');
        if (options.apply) tx.update(snap.ref, Object.fromEntries(Object.keys(r.patch).map(k => [k, r.absent.has(k) ? null : r.before[k]])));
      });
    });
  }
  if (!options.apply) return { status: 'RESTORE_PLAN_VERIFIED', count: rows.length, deletes: 0 };
  for (const r of rows) {
    const snap = await db.doc(r.path).get();
    if (!isRestored((snap.data() ?? {}) as Record<string, unknown>, r)) throw new Error('FIRST_REGISTRATION_RESTORE_READBACK_FAILED');
  }
  return { status: 'RESTORE_READBACK_VERIFIED', count: rows.length, deletes: 0 };
}
