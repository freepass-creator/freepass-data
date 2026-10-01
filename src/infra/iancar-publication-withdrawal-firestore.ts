import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { stableDigest } from '../shared/stable-digest.js';

/** Operator withdrawal, not supplier absence/retirement or contract cancellation. */
export async function withdrawIancarPublication(input: {
  apply: boolean; expectedCount: number; expectedOpen: number;
}) {
  const app = getTargetFirebaseApp();
  if (app.options.projectId !== 'freepasserp5') throw new Error('IANCAR_WITHDRAWAL_WRONG_PROJECT');
  const db = getFirestore(app);
  const query = db.collection('products').where('provider_company_code', '==', 'RP031');
  const before = await query.get();
  const open = before.docs.filter(doc => doc.data().vehicle_status !== '출고불가' || doc.data().listable === true);
  if (before.size !== input.expectedCount || open.length !== input.expectedOpen)
    throw new Error('IANCAR_WITHDRAWAL_SCOPE_CHANGED');
  if (before.docs.some(doc => doc.data().locked_by_contract))
    throw new Error('IANCAR_WITHDRAWAL_CONTRACT_LOCK_REQUIRES_REVIEW');
  const summary = { provider: 'RP031', productCount: before.size,
    changedCount: open.length, deletes: 0, contractChanges: 0 };
  if (!input.apply) return { ...summary, status: 'DRY_RUN', writeExecuted: false };
  const runId = randomUUID();
  const backupDir = join(homedir(), '.codex', 'private', 'freepass-data-iancar-withdrawals');
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `${runId}.json`);
  const backup = JSON.stringify({ runId, projectId: 'freepasserp5',
    capturedAt: new Date().toISOString(),
    documents: before.docs.map(doc => ({ path: doc.ref.path,
      updateTime: doc.updateTime.toDate().toISOString(), data: doc.data() })) });
  await writeFile(backupPath, backup, { flag: 'wx', mode: 0o600 });
  if (await readFile(backupPath, 'utf8') !== backup) throw new Error('IANCAR_BACKUP_READBACK_FAILED');
  const originals = new Map(before.docs.map(doc => [doc.id, doc]));
  const changedIds = new Set(open.map(doc => doc.id));
  await db.runTransaction(async transaction => {
    const current = await transaction.get(query);
    if (current.size !== before.size) throw new Error('IANCAR_WITHDRAWAL_SCOPE_CHANGED');
    for (const doc of current.docs) {
      const original = originals.get(doc.id);
      if (!original || !doc.updateTime.isEqual(original.updateTime))
        throw new Error('IANCAR_WITHDRAWAL_REVISION_CHANGED');
      if (doc.data().provider_company_code !== 'RP031' || doc.data().locked_by_contract)
        throw new Error('IANCAR_WITHDRAWAL_AUTHORITY_CHANGED');
    }
    for (const doc of current.docs) {
      if (!changedIds.has(doc.id)) continue;
      transaction.update(doc.ref, {
        vehicle_status: '출고불가', status: '출고불가', status_kind: '불가', listable: false,
        status_reason: '사용자 요청: 이안카 API 연동 검증 전 임시 노출 중단',
        publication_withdrawal: { runId, reason: 'IANCAR_API_CUTOVER_HOLD',
          previousVehicleStatus: originals.get(doc.id)!.data().vehicle_status ?? null }
      });
    }
  });
  const after = await query.get();
  if (after.size !== before.size || after.docs.some(doc => doc.data().listable === true
    || doc.data().vehicle_status !== '출고불가')) throw new Error('IANCAR_WITHDRAWAL_READBACK_FAILED');
  for (const doc of after.docs) {
    const original = originals.get(doc.id)!;
    const data = doc.data();
    const prior = original.data();
    const allowed = new Set(['vehicle_status', 'status', 'status_kind', 'listable', 'status_reason', 'publication_withdrawal']);
    const untouched = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
      .filter(([key]) => !allowed.has(key)));
    if (stableDigest(untouched(data)) !== stableDigest(untouched(prior)))
      throw new Error('IANCAR_WITHDRAWAL_UNEXPECTED_FIELD_CHANGE');
  }
  return { ...summary, status: 'WITHDRAWN_ATOM_READBACK_VERIFIED', writeExecuted: true,
    runId, backupPath, backupDigest: stableDigest(backup), consumerReadback: 'NOT_VERIFIED' };
}
