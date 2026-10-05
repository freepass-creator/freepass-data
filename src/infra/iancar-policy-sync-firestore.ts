import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { IANCAR_POLICY_UPCHARGES, assertIancarPolicySyncNotBlocked, iancarPolicyPatch } from '../domain/iancar-policy-patch.js';
import { getTargetFirebaseApp } from './firebase-target.js';

export type IancarPolicySyncInput = { plate: string; code: string }[];
type FirestoreLike = ReturnType<typeof getFirestore>;
type IancarPolicySyncDeps = {
  db?: FirestoreLike;
  backupDir?: string;
  now?: () => Date;
};

const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, '').toUpperCase();
const snapshotMillis = (snapshot: { updateTime?: { toMillis?: () => number } }) => snapshot.updateTime?.toMillis?.();

export async function applyIancarPolicySync(input: IancarPolicySyncInput, deps: IancarPolicySyncDeps = {}) {
  if (!Array.isArray(input) || input.length !== 119) {
    throw new Error(`Expected 119 mappings, got ${input.length}`);
  }
  const byPlate = new Map(input.map((item) => [normalize(item.plate), item.code]));
  if (byPlate.size !== 119) throw new Error('Duplicate plate in input');
  const allowed = new Set(['RP031_S01', 'RP031_S02', 'RP031_S03', 'RP031_S04']);
  for (const code of byPlate.values()) {
    if (!allowed.has(code)) throw new Error(`Unexpected policy code ${code}`);
  }

  const db = deps.db ?? getFirestore(getTargetFirebaseApp());
  const productSnaps = await db.collection('products').get();
  const matches = productSnaps.docs.filter((doc) =>
    byPlate.has(normalize(doc.data().car_number ?? doc.data().vehicle_number)));
  if (
    matches.length !== 119 ||
    new Set(matches.map((doc) => normalize(doc.data().car_number ?? doc.data().vehicle_number))).size !== 119
  ) {
    throw new Error(`Exact product match failed: ${matches.length}`);
  }

  const policies = IANCAR_POLICY_UPCHARGES;
  const policyRefs = Object.keys(policies).map((code) => db.collection('policy').doc(code));
  const policySnaps = await db.getAll(...policyRefs);
  // Before ANY write (product re-linking included): a policy holding corrector-owned fields refuses the whole sync.
  assertIancarPolicySyncNotBlocked(Object.fromEntries(policySnaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.data() ?? {}])));
  const backupDir = deps.backupDir ?? join(homedir(), '.codex', 'private', 'freepass-data-iancar-policy-backups');
  await mkdir(backupDir, { recursive: true });
  const capturedAt = (deps.now ?? (() => new Date()))().toISOString();
  const runId = `${capturedAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
  const backupPath = join(backupDir, `${runId}.json`);
  await writeFile(backupPath, JSON.stringify({
    runId,
    projectId: process.env.FIREBASE_PROJECT_ID,
    capturedAt,
    policies: policySnaps.map((snap) => ({ id: snap.id, exists: snap.exists, data: snap.data() })),
    products: matches.map((snap) => ({ id: snap.id, data: snap.data() })),
  }, null, 2), { flag: 'wx', mode: 0o600 });

  const now = FieldValue.serverTimestamp();
  await db.runTransaction(async (transaction) => {
    const current = await transaction.getAll(...matches.map((snap) => snap.ref), ...policyRefs);
    const expected = [...matches, ...policySnaps];
    current.forEach((snap, index) => {
      if (!snap.exists || snapshotMillis(snap) !== snapshotMillis(expected[index]!)) {
        throw new Error(`transaction precondition changed ${snap.ref.path}`);
      }
    });
    const currentProducts = current.slice(0, matches.length);
    const currentPolicies = current.slice(matches.length);
    assertIancarPolicySyncNotBlocked(Object.fromEntries(currentPolicies.map((snap) => [snap.id, snap.data() ?? {}])));
    for (const snap of currentProducts) {
      const data = snap.data() ?? {};
      const plate = normalize(data.car_number ?? data.vehicle_number);
      transaction.update(snap.ref, {
        policy_code: byPlate.get(plate),
        policy_code_source_original: data.policy_code_source_original ?? data.policy_code ?? null,
        policy_reference_checked_at: now,
      });
    }
    for (const [code, upcharge] of Object.entries(policies)) {
      const policyPatch = iancarPolicyPatch(code, upcharge, now);
      transaction.set(db.collection('policy').doc(code), policyPatch, { merge: true });
    }
  });

  const verifyProducts = await db.collection('products').get();
  const counts: Record<string, number> = {};
  for (const doc of verifyProducts.docs) {
    const plate = normalize(doc.data().car_number ?? doc.data().vehicle_number);
    if (byPlate.has(plate)) {
      counts[doc.data().policy_code] = (counts[doc.data().policy_code] ?? 0) + 1;
    }
  }
  const verifyPolicies = await db.getAll(...policyRefs);
  for (const snap of verifyPolicies) {
    const expectedUpcharge = policies[snap.id as keyof typeof policies];
    const expectedPatch = iancarPolicyPatch(snap.id, expectedUpcharge, '<updated_at>');
    if (
      !snap.exists ||
      snap.data()?.annual_mileage !== expectedPatch.annual_mileage ||
      snap.data()?.mileage_upcharge_per_10000km !== expectedUpcharge
    ) {
      throw new Error(`Policy readback mismatch ${snap.ref.path}`);
    }
  }
  return {
    runId,
    backupPath,
    matched: matches.length,
    counts,
    policies: verifyPolicies.map((snap) => ({
      id: snap.id,
      annual_mileage: snap.data()?.annual_mileage,
      upcharge: snap.data()?.mileage_upcharge_per_10000km,
    })),
  };
}
