import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { assertAutoplusPolicyInvariant, AUTOPLUS_POLICY_CODES, AUTOPLUS_PROVIDER_CODE } from '../domain/autoplus-policy-invariant.js';
import { getTargetFirebaseApp } from './firebase-target.js';

function repairedContent(value: unknown) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/운전연령하향\s*:\s*협의/g, '운전연령하향: 불가')
    .replace(/^.*운전연령하향비용.*(?:\r?\n|$)/gm, '');
}

export async function applyAutoplusPolicyRepair() {
  const db = getFirestore(getTargetFirebaseApp());
  const refs = AUTOPLUS_POLICY_CODES.map((code) => db.collection('policy').doc(code));
  const before = await db.getAll(...refs);
  for (const snapshot of before) {
    if (!snapshot.exists) throw new Error(`missing policy ${snapshot.id}`);
    if (snapshot.data()?.provider_company_code !== AUTOPLUS_PROVIDER_CODE) {
      throw new Error(`provider precondition changed policy/${snapshot.id}`);
    }
  }

  const backupDir = join(homedir(), '.codex', 'private', 'freepass-data-autoplus-policy-backups');
  await mkdir(backupDir, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const backupPath = join(backupDir, `${runId}.json`);
  await writeFile(backupPath, JSON.stringify({
    runId,
    projectId: process.env.FIREBASE_PROJECT_ID,
    capturedAt: new Date().toISOString(),
    documents: before.map((snapshot) => ({ path: snapshot.ref.path, data: snapshot.data() })),
  }, null, 2), { flag: 'wx', mode: 0o600 });

  await db.runTransaction(async (transaction) => {
    const current = await transaction.getAll(...refs);
    current.forEach((snapshot, index) => {
      const original = before[index]!;
      if (!snapshot.exists || snapshot.updateTime?.toMillis() !== original.updateTime?.toMillis()) {
        throw new Error(`transaction precondition changed ${snapshot.ref.path}`);
      }
      const data = snapshot.data()!;
      transaction.update(snapshot.ref, {
        basic_driver_age: '만 26세 이상',
        driver_age_lowering: '불가',
        insurance_included: '보험료 포함',
        age_lowering_cost: FieldValue.delete(),
        ...(typeof data.content === 'string' ? { content: repairedContent(data.content) } : {}),
        updated_at: FieldValue.serverTimestamp(),
        policy_correction_reason: 'RP023 기본 만26세 이상; 연령하향 불가',
      });
    });
  });

  const after = await db.getAll(...refs);
  after.forEach((snapshot) => assertAutoplusPolicyInvariant(snapshot.data() ?? {}));
  return {
    runId,
    backupPath,
    policies: after.map((snapshot) => ({
      id: snapshot.id,
      basic_driver_age: snapshot.data()?.basic_driver_age,
      driver_age_lowering: snapshot.data()?.driver_age_lowering,
      annual_mileage: snapshot.data()?.annual_mileage,
      insurance_included: snapshot.data()?.insurance_included,
      has_age_lowering_cost: Object.hasOwn(snapshot.data() ?? {}, 'age_lowering_cost'),
    })),
  };
}
