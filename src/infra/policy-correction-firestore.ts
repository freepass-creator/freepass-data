import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import type { AuditEvent } from '../domain/catalog.js';
import {
  isPlainObject,
  policyCorrectionItemDigest,
  storedPolicyValue,
  validatePolicyCorrectionPlan,
  type PolicyCorrectionItem,
  type PolicyCorrectionPlan,
} from '../domain/policy-correction.js';
import { stableDigest } from '../shared/stable-digest.js';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { readbackAuditEvents } from './vehicle-name-reference-repair-firestore.js';

type Snapshot = { ref: { path: string; id: string; parent?: { id: string } }; exists: boolean; data: () => Record<string, unknown> | undefined; updateTime?: { toMillis: () => number } };
const objectValue = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? value : {});
const sameStored = (data: Record<string, unknown>, item: PolicyCorrectionItem) => storedPolicyValue(data, item.layer, item.field) === item.to;
const storedEvidence = (data: Record<string, unknown>, item: PolicyCorrectionItem) =>
  item.layer === 'salesPolicy' ? objectValue(objectValue(data.sales_policy)[item.field]) : objectValue(objectValue(data.field_evidence)[item.field]);
const alreadyApplied = (data: Record<string, unknown>, item: PolicyCorrectionItem) =>
  sameStored(data, item) && (storedEvidence(data, item).itemDigest === policyCorrectionItemDigest(item)
    || (storedEvidence(data, item).writer === 'policy-corrector'
      && storedEvidence(data, item).source === item.evidence.source
      && storedEvidence(data, item).location === item.evidence.location
      && storedEvidence(data, item).effectiveDate === item.evidence.effectiveDate));
const byPolicy = (items: PolicyCorrectionItem[]) => items.reduce<Record<string, PolicyCorrectionItem[]>>((acc, item) => {
  (acc[item.policyCode] ??= []).push(item);
  return acc;
}, {});
const serverEvidence = (planId: string, item: PolicyCorrectionItem) => ({
  layer: item.layer,
  value: item.to,
  source: item.evidence.source,
  location: item.evidence.location,
  effectiveDate: item.evidence.effectiveDate,
  ...(item.evidence.answerSha256 ? { answerSha256: item.evidence.answerSha256 } : {}),
  planId,
  itemDigest: policyCorrectionItemDigest(item),
  appliedAt: FieldValue.serverTimestamp(),
  writer: 'policy-corrector',
});
const readbackEvidenceMatches = (data: Record<string, unknown>, planId: string, item: PolicyCorrectionItem) => {
  if (!sameStored(data, item)) return false;
  const evidence = storedEvidence(data, item);
  return evidence.planId === planId && evidence.itemDigest === policyCorrectionItemDigest(item)
    && evidence.source === item.evidence.source && evidence.location === item.evidence.location
    && evidence.effectiveDate === item.evidence.effectiveDate && evidence.writer === 'policy-corrector';
};

export async function applyPolicyCorrection(plan: PolicyCorrectionPlan) {
  const planDigest = stableDigest(plan);
  validatePolicyCorrectionPlan(plan);
  const db = getFirestore(getTargetFirebaseApp());
  const grouped = byPolicy(plan.items);
  const refs = Object.keys(grouped).map((code) => db.collection('policy').doc(code));
  const before = refs.length ? await db.getAll(...refs) as Snapshot[] : [];
  const documents: Record<string, { data: Record<string, unknown> }> = {};
  before.forEach((snapshot) => {
    if (!snapshot.exists) throw new Error(`POLICY_NOT_FOUND ${snapshot.ref.path}`);
    documents[snapshot.ref.id] = { data: snapshot.data() ?? {} };
  });
  const skippedAlreadyApplied = plan.items.filter((item) => alreadyApplied(documents[item.policyCode]!.data, item)).length;
  const activeGrouped = Object.fromEntries(Object.entries(grouped)
    .map(([code, items]) => [code, items.filter((item) => !alreadyApplied(documents[code]!.data, item))])
    .filter(([, items]) => (items as PolicyCorrectionItem[]).length)) as Record<string, PolicyCorrectionItem[]>;
  const activeItems = Object.values(activeGrouped).flat();
  if (activeItems.length) validatePolicyCorrectionPlan({ ...plan, items: activeItems }, { documents });
  const activeRefs = refs.filter((ref) => activeGrouped[ref.id]?.length);
  const activeBefore = before.filter((snapshot) => activeGrouped[snapshot.ref.id]?.length);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const backupDir = join(homedir(), '.codex', 'private', 'freepass-data-policy-corrector-backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `${runId}.json`);
  await writeFile(backupPath, JSON.stringify({
    runId,
    planId: plan.planId,
    planDigest,
    projectId: process.env.FIREBASE_PROJECT_ID,
    capturedAt: new Date().toISOString(),
    documents: before.map((snapshot) => ({ path: snapshot.ref.path, exists: snapshot.exists, updateTime: snapshot.updateTime?.toMillis?.() ?? null, data: snapshot.data() })),
  }, null, 2), { flag: 'wx', mode: 0o600 });

  const auditRefs: unknown[] = [];
  const audits: AuditEvent[] = [];
  await db.runTransaction(async (transaction) => {
    const current = activeRefs.length ? await transaction.getAll(...activeRefs) as Snapshot[] : [];
    const txDocs: Record<string, { data: Record<string, unknown> }> = {};
    current.forEach((snapshot, index) => {
      const original = activeBefore[index]!;
      if (!snapshot.exists || snapshot.updateTime?.toMillis?.() !== original.updateTime?.toMillis?.()) throw new Error(`transaction precondition changed ${snapshot.ref.path}`);
      txDocs[snapshot.ref.id] = { data: snapshot.data() ?? {} };
    });
    if (activeItems.length) validatePolicyCorrectionPlan({ ...plan, items: activeItems }, { documents: txDocs });
    current.forEach((snapshot) => {
      const data = snapshot.data() ?? {};
      const items = activeGrouped[snapshot.ref.id]!;
      const fieldEvidence = { ...objectValue(data.field_evidence) };
      const salesPolicy = { ...objectValue(data.sales_policy) };
      const update: Record<string, unknown> = {
        policy_field_owner: 'policy-corrector',
        policy_correction_last: plan.planId,
        updated_at: FieldValue.serverTimestamp(),
      };
      for (const item of items) {
        const evidence = serverEvidence(plan.planId, item);
        if (item.layer === 'supplierCondition') {
          update[item.field] = item.to;
          fieldEvidence[item.field] = evidence;
        } else {
          salesPolicy[item.field] = evidence;
        }
        const auditId = 'pcorr_' + createHash('sha256').update([runId, item.policyCode, item.layer, item.field, policyCorrectionItemDigest(item)].join('|')).digest('hex').slice(0, 32);
        const auditRef = db.collection(FIRESTORE_COLLECTIONS.evidence.audits).doc(auditId);
        auditRefs.push(auditRef);
        audits.push({
          eventId: auditRef.id,
          commandId: `${plan.planId}:${policyCorrectionItemDigest(item)}`,
          actor: { id: 'service:policy-corrector', kind: 'SERVICE' },
          entityType: 'Policy',
          entityId: item.policyCode,
          action: 'POLICY_FIELD_CORRECTED',
          before: { [item.field]: storedPolicyValue(data, item.layer, item.field) ?? null },
          after: { layer: item.layer, [item.field]: item.to, evidence },
          reason: `policy-corrector ${plan.planId} ${item.evidence.source} ${item.evidence.location}`,
          writerId: 'policy-corrector',
          revisionBefore: 0,
          revisionAfter: 0,
          occurredAt: new Date().toISOString(),
        });
      }
      if (items.some((item) => item.layer === 'supplierCondition')) update.field_evidence = fieldEvidence;
      if (items.some((item) => item.layer === 'salesPolicy')) update.sales_policy = salesPolicy;
      transaction.update(snapshot.ref as never, update as never);
    });
    audits.forEach((audit, index) => transaction.create(auditRefs[index] as never, audit));
  });

  const after = activeRefs.length ? await db.getAll(...activeRefs) as Snapshot[] : [];
  after.forEach((snapshot) => {
    const data = snapshot.data() ?? {};
    const mismatch = activeGrouped[snapshot.ref.id]!.find((item) => !readbackEvidenceMatches(data, plan.planId, item));
    if (mismatch) throw new Error(`readback mismatch ${snapshot.ref.path}.${mismatch.field}`);
  });
  const auditReadback = await readbackAuditEvents(db as never, auditRefs as never[], audits, 'readback policy correction audit mismatch');
  return {
    runId,
    backupPath,
    planDigest,
    policyCount: Object.keys(grouped).length,
    itemCount: plan.items.length,
    skippedAlreadyApplied,
    appliedCount: plan.items.length - skippedAlreadyApplied,
    writtenItemCount: plan.items.length - skippedAlreadyApplied,
    readbackCount: plan.items.length - skippedAlreadyApplied,
    auditCount: auditReadback.length,
  };
}
