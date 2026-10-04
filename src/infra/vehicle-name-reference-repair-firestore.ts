import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import type { AuditEvent } from '../domain/catalog.js';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { stableDigest } from '../shared/stable-digest.js';

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
  /** products.trim_name → F03 세부트림 name. Optional; `from` must be a non-blank name. */
  productTrimRepairs?: VehicleNameRepairItem[];
  /** vehicle_trim_master.sub_model → 세부모델 이름 v1 (rename, or move a hybrid row to its own sub-model). Old name kept in sub_model_aliases. */
  trimSubModelRepairs?: VehicleNameRepairItem[];
  /** vehicle_trim_master.master_id → the vehicle_master doc of the row's new sub-model (hybrid split). */
  trimMasterLinkRepairs?: VehicleNameRepairItem[];
  /** vehicle_master.variants after a hybrid split: the reviewed current list (by digest) is replaced with the remaining powertrains. */
  masterVariantRepairs?: VehicleMasterVariantRepair[];
  /** New vehicle_master docs (new sub-model). Created only when absent; `data.id` must equal `id`. */
  masterCreates?: VehicleMasterDocCreate[];
  /** New vehicle_trim_master rows. Created only when absent; `data.master_id` must point to an existing or created master. */
  trimCreates?: VehicleMasterDocCreate[];
};

export type VehicleMasterDocCreate = { id: string; data: Record<string, unknown>; evidence: string };
export type VehicleMasterVariantRepair = { id: string; fromDigest: string; to: Record<string, unknown>[]; evidence: string };

/** One transaction carries every target write plus one audit per target — keep well under Firestore's 500-write limit. */
export const MAX_VEHICLE_NAME_REPAIR_TARGETS = 200;
/** The identity of a master entry: maker|model|sub_model (one entry per sub-model). */
export const masterNameKey = (data: Record<string, unknown>) => [data.maker, data.model, data.sub_model].map(clean).join('|');
const MASTER_CREATE_KEYS = ['id', 'maker', 'model', 'sub_model', 'origin'] as const;
const TRIM_CREATE_KEYS = ['maker', 'model', 'sub_model', 'trim', 'master_id', 'trim_row_key'] as const;

const clean = (value: unknown) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
/** Stored value matches the plan's `from`. A blank `from` only matches a truly blank value: missing, null or an empty string. */
export const matchesFrom = (stored: unknown, from: string) => clean(from)
  ? clean(stored) === clean(from)
  : stored === undefined || stored === null || (typeof stored === 'string' && stored.trim() === '');

export function validateVehicleNameRepairPlan(plan: VehicleNameRepairPlan) {
  if (!plan.sourceDigest?.trim()) throw new Error('sourceDigest is required');
  const all = [...plan.masterRepairs.map((item) => ({ ...item, kind: 'master' })), ...plan.productRepairs.map((item) => ({ ...item, kind: 'product' })),
    ...(plan.trimRepairs ?? []).map((item) => ({ ...item, kind: 'trim' })),
    ...(plan.productTrimRepairs ?? []).map((item) => ({ ...item, kind: 'productTrim' })),
    ...(plan.trimSubModelRepairs ?? []).map((item) => ({ ...item, kind: 'trimSubModel' })),
    ...(plan.trimMasterLinkRepairs ?? []).map((item) => ({ ...item, kind: 'trimMasterLink' }))];
  const creates = [...(plan.masterCreates ?? []).map((c) => ({ ...c, kind: 'masterCreate', keys: MASTER_CREATE_KEYS })),
    ...(plan.trimCreates ?? []).map((c) => ({ ...c, kind: 'trimCreate', keys: TRIM_CREATE_KEYS }))];
  const variantRepairs = plan.masterVariantRepairs ?? [];
  for (const v of variantRepairs) {
    if (!v.id?.trim() || !/^[0-9a-f]{64}$/.test(v.fromDigest ?? '') || !Array.isArray(v.to) || !v.to.length) throw new Error('masterVariantRepair requires id, fromDigest and a non-empty variants list');
    if (typeof v.evidence !== 'string' || !v.evidence.trim()) throw new Error(`masterVariantRepair ${v.id} requires evidence`);
    if (stableDigest(v.to) === v.fromDigest) throw new Error(`no-op masterVariantRepair ${v.id}`);
  }
  if (new Set(variantRepairs.map((v) => v.id)).size !== variantRepairs.length) throw new Error('duplicate masterVariantRepair');
  if (!all.length && !creates.length && !variantRepairs.length) throw new Error('repair plan is empty');
  if (all.length + creates.length + variantRepairs.length > MAX_VEHICLE_NAME_REPAIR_TARGETS) throw new Error(`repair plan too large (max ${MAX_VEHICLE_NAME_REPAIR_TARGETS} targets) — split it`);
  const createKeys = new Set<string>();
  for (const c of creates) {
    if (!c.id?.trim() || typeof c.data !== 'object' || c.data === null || Array.isArray(c.data)) throw new Error(`${c.kind} requires id and data`);
    if (typeof c.evidence !== 'string' || !c.evidence.trim()) throw new Error(`${c.kind} ${c.id} requires evidence`);
    for (const key of c.keys) if (key !== 'id' && !clean(c.data[key])) throw new Error(`${c.kind} ${c.id} requires data.${key}`);
    if (c.kind === 'masterCreate' && c.data.id !== c.id) throw new Error(`masterCreate ${c.id} data.id must equal id`);
    if (c.id !== c.id.trim()) throw new Error(`${c.kind} id must have no surrounding spaces`);
    if (c.kind === 'trimCreate' && (typeof c.data.master_id !== 'string' || c.data.master_id !== c.data.master_id.trim())) throw new Error(`trimCreate ${c.id} master_id must be an exact id`);
    const key = `${c.kind}:${c.id}`;
    if (createKeys.has(key)) throw new Error(`duplicate create ${key}`);
    createKeys.add(key);
  }
  // «값 하나»: a trim row key and a master's maker|model|sub_model may appear only once — inside the plan here,
  // and against stored data inside the transaction at apply time.
  const trimKeys = new Set<string>();
  for (const c of plan.trimCreates ?? []) {
    if (c.data.trim_row_key !== c.id) throw new Error(`trimCreate ${c.id} trim_row_key must equal id`);
    if (trimKeys.has(c.id)) throw new Error(`duplicate trim_row_key ${c.id}`);
    trimKeys.add(c.id);
  }
  const masterNames = new Set<string>();
  for (const c of plan.masterCreates ?? []) {
    const name = masterNameKey(c.data);
    if (masterNames.has(name)) throw new Error(`duplicate master sub-model ${name}`);
    masterNames.add(name);
  }
  // Linked masters must exist already or be created by this plan — checked against Firestore at apply time.
  const productIds = new Set(plan.productRepairs.map((item) => item.id));
  if ((plan.productTrimRepairs ?? []).some((item) => productIds.has(item.id))) throw new Error('one product per plan: sub_model and trim_name repairs must not overlap');
  const keys = new Set<string>();
  for (const item of all) {
    // A blank `from` fills an empty products.sub_model only, with source-text evidence; the transaction
    // precondition still requires the stored value to be blank at write time. Every other kind needs a name.
    const evidenceOk = typeof item.evidence === 'string' && item.evidence.trim() !== '';
    if (item.evidence !== undefined && !evidenceOk) throw new Error('repair item evidence must be a non-empty string');
    const blankFill = !clean(item.from) && item.kind === 'product' && evidenceOk;
    if (!item.id?.trim() || !clean(item.to) || (!clean(item.from) && !blankFill)) throw new Error('repair item requires id/from/to');
    if (clean(item.from) === clean(item.to)) throw new Error(`no-op repair ${item.kind}:${item.id}`);
    if (item.kind === 'trimMasterLink' && item.to !== item.to.trim()) throw new Error(`trimMasterLink ${item.id} to must be an exact master id`);
    const key = `${item.kind}:${item.id}`;
    if (keys.has(key)) throw new Error(`duplicate repair ${key}`);
    keys.add(key);
  }
  return { masterCount: plan.masterRepairs.length, productCount: plan.productRepairs.length,
    ...(plan.trimRepairs ? { trimCount: plan.trimRepairs.length } : {}),
    ...(plan.productTrimRepairs ? { productTrimCount: plan.productTrimRepairs.length } : {}),
    ...(plan.trimSubModelRepairs ? { trimSubModelCount: plan.trimSubModelRepairs.length } : {}),
    ...(plan.trimMasterLinkRepairs ? { trimMasterLinkCount: plan.trimMasterLinkRepairs.length } : {}),
    ...(plan.masterVariantRepairs ? { masterVariantCount: plan.masterVariantRepairs.length } : {}),
    ...(plan.masterCreates ? { masterCreateCount: plan.masterCreates.length } : {}),
    ...(plan.trimCreates ? { trimCreateCount: plan.trimCreates.length } : {}) };
}

type RepairField = 'sub_model' | 'trim' | 'trim_name' | 'master_id';
type AliasField = 'trim_aliases' | 'sub_model_aliases';
/** The old name is kept in an alias list on these kinds (rule 20: sub-model aliases live in FreePass Data). */
const ALIAS_FIELD: Partial<Record<string, AliasField>> = {
  trim: 'trim_aliases', master: 'sub_model_aliases', trimSubModel: 'sub_model_aliases',
};

export async function applyVehicleNameReferenceRepair(plan: VehicleNameRepairPlan) {
  const counts = validateVehicleNameRepairPlan(plan);
  const db = getFirestore(getTargetFirebaseApp());
  // Each target = collection + field. vehicle_master.sub_model and vehicle_trim_master.trim/sub_model keep the old name as an alias.
  const targets = [
    ...plan.masterRepairs.map((item) => ({ kind: 'master', item, ref: db.collection('vehicle_master').doc(item.id), field: 'sub_model' as RepairField })),
    ...plan.productRepairs.map((item) => ({ kind: 'product', item, ref: db.collection('products').doc(item.id), field: 'sub_model' as RepairField })),
    ...(plan.trimRepairs ?? []).map((item) => ({ kind: 'trim', item, ref: db.collection('vehicle_trim_master').doc(item.id), field: 'trim' as RepairField })),
    ...(plan.productTrimRepairs ?? []).map((item) => ({ kind: 'productTrim', item, ref: db.collection('products').doc(item.id), field: 'trim_name' as RepairField })),
    ...(plan.trimSubModelRepairs ?? []).map((item) => ({ kind: 'trimSubModel', item, ref: db.collection('vehicle_trim_master').doc(item.id), field: 'sub_model' as RepairField })),
    ...(plan.trimMasterLinkRepairs ?? []).map((item) => ({ kind: 'trimMasterLink', item, ref: db.collection('vehicle_trim_master').doc(item.id), field: 'master_id' as RepairField })),
  ];
  const creates = [
    ...(plan.masterCreates ?? []).map((c) => ({ c, ref: db.collection('vehicle_master').doc(c.id) })),
    ...(plan.trimCreates ?? []).map((c) => ({ c, ref: db.collection('vehicle_trim_master').doc(c.id) })),
  ];
  // Rows may only be linked to a master that already exists or that this plan creates.
  const createdMasterIds = new Set((plan.masterCreates ?? []).map((c) => c.id));
  const linkedMasterIds = [...new Set([...(plan.trimMasterLinkRepairs ?? []).map((i) => i.to),
    ...(plan.trimCreates ?? []).map((c) => String(c.data.master_id))])].filter((id) => !createdMasterIds.has(id));
  const linkRefs = linkedMasterIds.map((id) => db.collection('vehicle_master').doc(id));
  if (linkRefs.length && (await db.getAll(...linkRefs)).some((snapshot) => !snapshot.exists)) throw new Error('linked vehicle_master missing');

  const refs = targets.map((x) => x.ref);
  const snapshots = refs.length ? await db.getAll(...refs) : [];
  if (snapshots.some((snapshot) => !snapshot.exists)) throw new Error('repair target missing');
  snapshots.forEach((snapshot, index) => {
    if (!matchesFrom(snapshot.data()?.[targets[index]!.field], targets[index]!.item.from)) {
      throw new Error(`precondition changed ${snapshot.ref.path}`);
    }
  });
  const variantRepairs = plan.masterVariantRepairs ?? [];
  const variantRefs = variantRepairs.map((v) => db.collection('vehicle_master').doc(v.id));
  const variantSnaps = variantRefs.length ? await db.getAll(...variantRefs) : [];
  variantSnaps.forEach((snapshot, index) => {
    if (!snapshot.exists || stableDigest(snapshot.data()?.variants ?? null) !== variantRepairs[index]!.fromDigest) {
      throw new Error(`variants precondition changed ${snapshot.ref.path}`);
    }
  });
  const createRefs = creates.map((x) => x.ref);
  if (createRefs.length && (await db.getAll(...createRefs)).some((snapshot) => snapshot.exists)) throw new Error('create target already exists');

  const backupDir = join(homedir(), '.codex', 'private', 'freepass-data-vehicle-name-backups');
  await mkdir(backupDir, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const backupPath = join(backupDir, `${runId}.json`);
  await writeFile(backupPath, JSON.stringify({
    runId,
    projectId: process.env.FIREBASE_PROJECT_ID,
    sourceDigest: plan.sourceDigest,
    capturedAt: new Date().toISOString(),
    documents: [...snapshots, ...variantSnaps].map((snapshot) => ({ path: snapshot.ref.path, data: snapshot.data() })),
    // The reviewed items (incl. source-text evidence for blank fills) are kept with the before-images.
    repairs: targets.map(({ item, field, ref }) => ({ path: ref.path, field, ...item })),
    creates: creates.map(({ c, ref }) => ({ path: ref.path, evidence: c.evidence, data: c.data })),
    variantRepairs: variantRepairs.map((v) => ({ path: `vehicle_master/${v.id}`, ...v })),
  }, null, 2), { flag: 'wx', mode: 0o600 });

  // Evidence never goes into the repaired documents (products are served to consumers field-for-field);
  // each repair is recorded as an audit event in the same transaction instead.
  const occurredAt = new Date().toISOString();
  const actor = { id: 'service:freepass-data-vehicle-name-repair', kind: 'SERVICE' } as const;
  const auditId = (path: string, field: string) => 'vnr_' + createHash('sha256').update([runId, path, field].join('|')).digest('hex').slice(0, 32);
  const audits: AuditEvent[] = [
    ...targets.map(({ item, field, ref }): AuditEvent => ({
      eventId: auditId(ref.path, field), commandId: `vehicle-name-repair:${runId}`, actor,
      entityType: ref.parent.id, entityId: ref.id, action: 'VEHICLE_NAME_REFERENCE_REPAIRED',
      before: { [field]: item.from }, after: { [field]: clean(item.to) },
      reason: item.evidence ? `원문 근거: ${item.evidence}` : `F03 이름 정정 (${plan.sourceDigest})`,
      revisionBefore: 0, revisionAfter: 0, occurredAt,
    })),
    ...variantRepairs.map((v, index): AuditEvent => ({
      eventId: auditId(variantRefs[index]!.path, 'variants'), commandId: `vehicle-name-repair:${runId}`, actor,
      entityType: 'vehicle_master', entityId: v.id, action: 'VEHICLE_MASTER_VARIANTS_REPAIRED',
      before: { variantsDigest: v.fromDigest }, after: { variantsDigest: stableDigest(v.to) },
      reason: `차종 마스터 파워트레인 목록 정정 근거: ${v.evidence} (${plan.sourceDigest})`,
      revisionBefore: 0, revisionAfter: 0, occurredAt,
    })),
    ...creates.map(({ c, ref }): AuditEvent => ({
      eventId: auditId(ref.path, 'create'), commandId: `vehicle-name-repair:${runId}`, actor,
      entityType: ref.parent.id, entityId: ref.id, action: 'VEHICLE_MASTER_ENTRY_CREATED',
      before: {}, after: { sub_model: clean(c.data.sub_model), ...(c.data.trim !== undefined ? { trim: clean(c.data.trim) } : {}) },
      reason: `차종 마스터 추가 근거: ${c.evidence} (${plan.sourceDigest})`,
      revisionBefore: 0, revisionAfter: 1, occurredAt,
    })),
  ];
  const auditRefs = audits.map((a) => db.collection(FIRESTORE_COLLECTIONS.evidence.audits).doc(a.eventId));

  // One update per document: a trim row can be renamed and relinked in the same plan.
  const byPath: Record<string, { ref: (typeof refs)[number]; fields: Record<string, string>; aliases: Partial<Record<AliasField, string[]>> }> = {};
  for (const { kind, item, field, ref } of targets) {
    const entry = byPath[ref.path] ?? { ref, fields: {}, aliases: {} };
    if (entry.fields[field] !== undefined) throw new Error(`two repairs write ${ref.path}.${field}`);
    entry.fields[field] = field === 'master_id' ? item.to : clean(item.to);
    const aliasField = ALIAS_FIELD[kind];
    if (aliasField && clean(item.from)) entry.aliases[aliasField] = [...(entry.aliases[aliasField] ?? []), clean(item.from)];
    byPath[ref.path] = entry;
  }

  // A master's variants list joins that document's single update (it may also be renamed in the same plan).
  variantRepairs.forEach((_, index) => {
    const r = variantRefs[index]!;
    byPath[r.path] = byPath[r.path] ?? { ref: r, fields: {}, aliases: {} };
  });
  const variantsByPath: Record<string, Record<string, unknown>[]> = Object.fromEntries(variantRepairs.map((v, i) => [variantRefs[i]!.path, v.to]));

  await db.runTransaction(async (transaction) => {
    const current = refs.length ? await transaction.getAll(...refs) : [];
    // Linked masters and create targets are read inside the transaction too, so a concurrent delete/create aborts it.
    if (linkRefs.length && (await transaction.getAll(...linkRefs)).some((snapshot) => !snapshot.exists)) throw new Error('transaction linked vehicle_master missing');
    if (createRefs.length && (await transaction.getAll(...createRefs)).some((snapshot) => snapshot.exists)) throw new Error('transaction create target already exists');
    for (const c of plan.trimCreates ?? []) {
      const same = await transaction.get(db.collection('vehicle_trim_master').where('trim_row_key', '==', c.id));
      if (!same.empty) throw new Error(`trim_row_key already stored ${c.id}`);
    }
    for (const c of plan.masterCreates ?? []) {
      const same = await transaction.get(db.collection('vehicle_master')
        .where('maker', '==', c.data.maker).where('model', '==', c.data.model).where('sub_model', '==', c.data.sub_model));
      if (!same.empty) throw new Error(`master sub-model already stored ${masterNameKey(c.data)}`);
    }
    if (variantRefs.length && (await transaction.getAll(...variantRefs)).some((snapshot, index) =>
      !snapshot.exists || stableDigest(snapshot.data()?.variants ?? null) !== variantRepairs[index]!.fromDigest)) {
      throw new Error('transaction variants precondition changed');
    }
    current.forEach((snapshot, index) => {
      if (!snapshot.exists || !matchesFrom(snapshot.data()?.[targets[index]!.field], targets[index]!.item.from)) {
        throw new Error(`transaction precondition changed ${snapshot.ref.path}`);
      }
    });
    for (const { ref, fields, aliases } of Object.values(byPath)) {
      transaction.update(ref, {
        ...fields,
        ...(variantsByPath[ref.path] ? { variants: variantsByPath[ref.path] } : {}),
        ...Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k, FieldValue.arrayUnion(...v!)])),
        vehicle_name_reference_checked_at: FieldValue.serverTimestamp(),
        vehicle_name_reference_source_digest: plan.sourceDigest,
      });
    }
    // create() fails the whole transaction if the document appeared meanwhile.
    for (const { c, ref } of creates) transaction.create(ref, { ...c.data, vehicle_name_reference_source_digest: plan.sourceDigest });
    audits.forEach((audit, index) => transaction.create(auditRefs[index]!, audit));
  });

  const readback = refs.length ? await db.getAll(...refs) : [];
  readback.forEach((snapshot, index) => {
    const { kind, item, field } = targets[index]!;
    const data = snapshot.data();
    const stored = field === 'master_id' ? data?.[field] : clean(data?.[field]);
    if (stored !== (field === 'master_id' ? item.to : clean(item.to))) throw new Error(`readback mismatch ${snapshot.ref.path}`);
    const aliasField = ALIAS_FIELD[kind];
    if (aliasField) {
      // The old name must be kept as an alias, and aliases present before the repair must still be there.
      const aliases: unknown[] = Array.isArray(data?.[aliasField]) ? data[aliasField] : [];
      const before = snapshots[index]!.data()?.[aliasField];
      const kept = Array.isArray(before) ? before.every((a: unknown) => aliases.includes(a)) : true;
      if (!aliases.map(clean).includes(clean(item.from)) || !kept) throw new Error(`readback alias mismatch ${snapshot.ref.path}`);
    }
  });
  const variantReadback = variantRefs.length ? await db.getAll(...variantRefs) : [];
  variantReadback.forEach((snapshot, index) => {
    if (stableDigest(snapshot.data()?.variants ?? null) !== stableDigest(variantRepairs[index]!.to)) throw new Error(`readback variants mismatch ${snapshot.ref.path}`);
  });
  const createReadback = createRefs.length ? await db.getAll(...createRefs) : [];
  createReadback.forEach((snapshot, index) => {
    const want = creates[index]!.c.data;
    if (!snapshot.exists || Object.keys(want).some((k) => stableDigest(snapshot.data()?.[k] ?? null) !== stableDigest(want[k] ?? null))) {
      throw new Error(`readback create mismatch ${snapshot.ref.path}`);
    }
  });
  const auditReadback = await db.getAll(...auditRefs);
  if (auditReadback.some((s, index) => !s.exists || s.data()?.reason !== audits[index]!.reason)) throw new Error('readback audit mismatch');
  return { runId, backupPath, ...counts, readbackCount: readback.length + createReadback.length + variantReadback.length, auditCount: auditReadback.length };
}
