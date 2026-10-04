import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';

export type VehicleNameRepairItem = {
  id: string;
  from: string;
  to: string;
  /** Required when `from` is blank (filling an empty name): the supplier source text that names it. */
  evidence?: string;
};

export type VehicleNameRepairPlan = {
  sourceDigest: string;
  masterRepairs: VehicleNameRepairItem[];
  productRepairs: VehicleNameRepairItem[];
  /** vehicle_trim_master.trim → F03 세부트림 name (old name kept in trim_aliases). Optional; absent = no trim repairs. */
  trimRepairs?: VehicleNameRepairItem[];
};

const clean = (value: unknown) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');

export function validateVehicleNameRepairPlan(plan: VehicleNameRepairPlan) {
  if (!plan.sourceDigest?.trim()) throw new Error('sourceDigest is required');
  const all = [...plan.masterRepairs.map((item) => ({ ...item, kind: 'master' })), ...plan.productRepairs.map((item) => ({ ...item, kind: 'product' })),
    ...(plan.trimRepairs ?? []).map((item) => ({ ...item, kind: 'trim' }))];
  if (!all.length) throw new Error('repair plan is empty');
  const keys = new Set<string>();
  for (const item of all) {
    // A blank `from` fills an empty name; it is only allowed with source-text evidence, and the transaction
    // precondition still requires the stored value to be blank at write time.
    if (!item.id?.trim() || !clean(item.to) || (!clean(item.from) && !clean(item.evidence))) throw new Error('repair item requires id/from/to');
    if (clean(item.from) === clean(item.to)) throw new Error(`no-op repair ${item.kind}:${item.id}`);
    const key = `${item.kind}:${item.id}`;
    if (keys.has(key)) throw new Error(`duplicate repair ${key}`);
    keys.add(key);
  }
  return { masterCount: plan.masterRepairs.length, productCount: plan.productRepairs.length,
    ...(plan.trimRepairs ? { trimCount: plan.trimRepairs.length } : {}) };
}

export async function applyVehicleNameReferenceRepair(plan: VehicleNameRepairPlan) {
  const counts = validateVehicleNameRepairPlan(plan);
  const db = getFirestore(getTargetFirebaseApp());
  // Each target = collection + field; vehicle_master/products repair sub_model, vehicle_trim_master repairs trim.
  const targets = [
    ...plan.masterRepairs.map((item) => ({ item, ref: db.collection('vehicle_master').doc(item.id), field: 'sub_model' as const })),
    ...plan.productRepairs.map((item) => ({ item, ref: db.collection('products').doc(item.id), field: 'sub_model' as const })),
    ...(plan.trimRepairs ?? []).map((item) => ({ item, ref: db.collection('vehicle_trim_master').doc(item.id), field: 'trim' as const })),
  ];
  const refs = targets.map((x) => x.ref);
  const snapshots = await db.getAll(...refs);
  if (snapshots.some((snapshot) => !snapshot.exists)) throw new Error('repair target missing');
  snapshots.forEach((snapshot, index) => {
    if (clean(snapshot.data()?.[targets[index]!.field]) !== clean(targets[index]!.item.from)) {
      throw new Error(`precondition changed ${snapshot.ref.path}`);
    }
  });

  const backupDir = join(homedir(), '.codex', 'private', 'freepass-data-vehicle-name-backups');
  await mkdir(backupDir, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const backupPath = join(backupDir, `${runId}.json`);
  await writeFile(backupPath, JSON.stringify({
    runId,
    projectId: process.env.FIREBASE_PROJECT_ID,
    sourceDigest: plan.sourceDigest,
    capturedAt: new Date().toISOString(),
    documents: snapshots.map((snapshot) => ({ path: snapshot.ref.path, data: snapshot.data() })),
  }, null, 2), { flag: 'wx', mode: 0o600 });

  await db.runTransaction(async (transaction) => {
    const current = await transaction.getAll(...refs);
    current.forEach((snapshot, index) => {
      if (!snapshot.exists || clean(snapshot.data()?.[targets[index]!.field]) !== clean(targets[index]!.item.from)) {
        throw new Error(`transaction precondition changed ${snapshot.ref.path}`);
      }
    });
    current.forEach((snapshot, index) => {
      const { item, field } = targets[index]!;
      transaction.update(snapshot.ref, {
        [field]: clean(item.to),
        ...(field === 'trim' ? { trim_aliases: FieldValue.arrayUnion(clean(item.from)) } : {}),
        vehicle_name_reference_checked_at: FieldValue.serverTimestamp(),
        vehicle_name_reference_source_digest: plan.sourceDigest,
      });
    });
  });

  const readback = await db.getAll(...refs);
  readback.forEach((snapshot, index) => {
    const { item, field } = targets[index]!;
    const data = snapshot.data();
    if (clean(data?.[field]) !== clean(item.to)) throw new Error(`readback mismatch ${snapshot.ref.path}`);
    if (field === 'trim') {
      // The old name must be kept as an alias, and aliases present before the repair must still be there.
      const aliases: unknown[] = Array.isArray(data?.trim_aliases) ? data.trim_aliases : [];
      const before = snapshots[index]!.data()?.trim_aliases;
      const kept = Array.isArray(before) ? before.every((a: unknown) => aliases.includes(a)) : true;
      if (!aliases.map(clean).includes(clean(item.from)) || !kept) throw new Error(`readback alias mismatch ${snapshot.ref.path}`);
    }
  });
  return { runId, backupPath, ...counts, readbackCount: readback.length };
}
