import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';

export type IancarPolicySyncInput = { plate: string; code: string }[];

const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, '').toUpperCase();
const chunks = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size));

export async function applyIancarPolicySync(input: IancarPolicySyncInput) {
  if (!Array.isArray(input) || input.length !== 119) {
    throw new Error(`Expected 119 mappings, got ${input.length}`);
  }
  const byPlate = new Map(input.map((item) => [normalize(item.plate), item.code]));
  if (byPlate.size !== 119) throw new Error('Duplicate plate in input');
  const allowed = new Set(['RP031_S01', 'RP031_S02', 'RP031_S03', 'RP031_S04']);
  for (const code of byPlate.values()) {
    if (!allowed.has(code)) throw new Error(`Unexpected policy code ${code}`);
  }

  const db = getFirestore(getTargetFirebaseApp());
  const productSnaps = await db.collection('products').get();
  const matches = productSnaps.docs.filter((doc) =>
    byPlate.has(normalize(doc.data().car_number ?? doc.data().vehicle_number)));
  if (
    matches.length !== 119 ||
    new Set(matches.map((doc) => normalize(doc.data().car_number ?? doc.data().vehicle_number))).size !== 119
  ) {
    throw new Error(`Exact product match failed: ${matches.length}`);
  }

  const policies = {
    RP031_S01: '5만원',
    RP031_S02: '10만원',
    RP031_S03: '15만원',
    RP031_S04: '25만원',
  } as const;
  const policyRefs = Object.keys(policies).map((code) => db.collection('policy').doc(code));
  const policySnaps = await db.getAll(...policyRefs);
  const backupDir = join(homedir(), '.codex', 'private', 'freepass-data-iancar-policy-backups');
  await mkdir(backupDir, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const backupPath = join(backupDir, `${runId}.json`);
  await writeFile(backupPath, JSON.stringify({
    runId,
    projectId: process.env.FIREBASE_PROJECT_ID,
    capturedAt: new Date().toISOString(),
    policies: policySnaps.map((snap) => ({ id: snap.id, exists: snap.exists, data: snap.data() })),
    products: matches.map((snap) => ({ id: snap.id, data: snap.data() })),
  }, null, 2), { flag: 'wx', mode: 0o600 });

  const now = FieldValue.serverTimestamp();
  for (const part of chunks(matches, 400)) {
    const batch = db.batch();
    for (const snap of part) {
      const data = snap.data();
      const plate = normalize(data.car_number ?? data.vehicle_number);
      batch.update(snap.ref, {
        policy_code: byPlate.get(plate),
        policy_code_source_original: data.policy_code_source_original ?? data.policy_code ?? null,
        policy_reference_checked_at: now,
      });
    }
    await batch.commit();
  }

  const policyBatch = db.batch();
  for (const [code, upcharge] of Object.entries(policies)) {
    policyBatch.set(db.collection('policy').doc(code), {
      policy_code: code,
      policy_name: `RP031 이안카 연 2만km / 1만km 추가 ${upcharge}`,
      provider_company_code: 'RP031',
      maintenance_service: '미제공',
      deposit_installment: '불가',
      annual_mileage: '연 20,000km',
      mileage_upcharge_per_10000km: upcharge,
      driver_age_lowering: '불가',
      age_21_cost: '불가',
      age_23_cost: '불가',
      personal_driver_scope: '개인/사업자',
      injury_compensation_limit: '무한',
      injury_deductible: '50만원',
      property_compensation_limit: '1억원',
      property_deductible: '50만원',
      self_body_accident: '1천5백만원',
      self_body_deductible: '50만원',
      uninsured_damage: '없음',
      own_damage_min_deductible: '50만원',
      own_damage_max_deductible: '100만원',
      updated_at: now,
    }, { merge: true });
  }
  await policyBatch.commit();

  const verifyProducts = await db.collection('products').get();
  const counts: Record<string, number> = {};
  for (const doc of verifyProducts.docs) {
    const plate = normalize(doc.data().car_number ?? doc.data().vehicle_number);
    if (byPlate.has(plate)) {
      counts[doc.data().policy_code] = (counts[doc.data().policy_code] ?? 0) + 1;
    }
  }
  const verifyPolicies = await db.getAll(...policyRefs);
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
