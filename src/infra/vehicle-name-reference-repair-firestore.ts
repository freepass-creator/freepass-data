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
};

export type VehicleNameRepairPlan = {
  sourceDigest: string;
  masterRepairs: VehicleNameRepairItem[];
  productRepairs: VehicleNameRepairItem[];
};

const clean = (value: unknown) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');

export function validateVehicleNameRepairPlan(plan: VehicleNameRepairPlan) {
  if (!plan.sourceDigest?.trim()) throw new Error('sourceDigest is required');
  const all = [...plan.masterRepairs.map((item) => ({ ...item, kind: 'master' })), ...plan.productRepairs.map((item) => ({ ...item, kind: 'product' }))];
  if (!all.length) throw new Error('repair plan is empty');
  const keys = new Set<string>();
  for (const item of all) {
    if (!item.id?.trim() || !clean(item.from) || !clean(item.to)) throw new Error('repair item requires id/from/to');
    if (clean(item.from) === clean(item.to)) throw new Error(`no-op repair ${item.kind}:${item.id}`);
    const key = `${item.kind}:${item.id}`;
    if (keys.has(key)) throw new Error(`duplicate repair ${key}`);
    keys.add(key);
  }
  return { masterCount: plan.masterRepairs.length, productCount: plan.productRepairs.length };
}

export async function applyVehicleNameReferenceRepair(plan: VehicleNameRepairPlan) {
  const counts = validateVehicleNameRepairPlan(plan);
  const db = getFirestore(getTargetFirebaseApp());
  const masterRefs = plan.masterRepairs.map((item) => db.collection('vehicle_master').doc(item.id));
  const productRefs = plan.productRepairs.map((item) => db.collection('products').doc(item.id));
  const snapshots = await db.getAll(...masterRefs, ...productRefs);
  if (snapshots.some((snapshot) => !snapshot.exists)) throw new Error('repair target missing');
  const expected = [...plan.masterRepairs, ...plan.productRepairs];
  snapshots.forEach((snapshot, index) => {
    if (clean(snapshot.data()?.sub_model) !== clean(expected[index]!.from)) {
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
    const current = await transaction.getAll(...masterRefs, ...productRefs);
    current.forEach((snapshot, index) => {
      if (!snapshot.exists || clean(snapshot.data()?.sub_model) !== clean(expected[index]!.from)) {
        throw new Error(`transaction precondition changed ${snapshot.ref.path}`);
      }
    });
    current.forEach((snapshot, index) => transaction.update(snapshot.ref, {
      sub_model: clean(expected[index]!.to),
      vehicle_name_reference_checked_at: FieldValue.serverTimestamp(),
      vehicle_name_reference_source_digest: plan.sourceDigest,
    }));
  });

  const readback = await db.getAll(...masterRefs, ...productRefs);
  readback.forEach((snapshot, index) => {
    if (clean(snapshot.data()?.sub_model) !== clean(expected[index]!.to)) {
      throw new Error(`readback mismatch ${snapshot.ref.path}`);
    }
  });
  return { runId, backupPath, ...counts, readbackCount: readback.length };
}
