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
export type VehicleProductIdentityRepairItem = {
  id: string;
  from: { maker: string; model: string; sub_model: string };
  to: { maker: string; model: string; sub_model: string };
  evidence: string;
};

export type VehicleNameRepairPlan = {
  sourceDigest: string;
  masterRepairs: VehicleNameRepairItem[];
  productRepairs: VehicleNameRepairItem[];
  /** products.maker/model/sub_model repaired together after matching an active vehicle_master identity. */
  productIdentityRepairs?: VehicleProductIdentityRepairItem[];
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
  /** Retire a vehicle_master entry left over after a merge: mark it (never delete). Refused while trim rows or products still use it. */
  masterRetires?: VehicleMasterRetire[];
  /** vehicle_master.model → 모델 이름(예: 아이오닉5 → 아이오닉 5). Old name kept in model_aliases. */
  masterModelRepairs?: VehicleNameRepairItem[];
  /** vehicle_trim_master.model, same rename as its master. Old name kept in model_aliases. */
  trimModelRepairs?: VehicleNameRepairItem[];
  /** vehicle_master.gen_code → 개발코드(예: CV1 → CV). Old code kept in gen_code_aliases. A blank code may be filled with evidence. */
  masterGenCodeRepairs?: VehicleNameRepairItem[];
  /** vehicle_master.title display name. Old title is kept only in backup/audit; no alias field is written. */
  masterTitleRepairs?: VehicleNameRepairItem[];
  /** New vehicle_master docs (new sub-model). Created only when absent; `data.id` must equal `id`. */
  masterCreates?: VehicleMasterDocCreate[];
  /** New vehicle_trim_master rows. Created only when absent; `data.master_id` must point to an existing or created master. */
  trimCreates?: VehicleMasterDocCreate[];
};

export type VehicleMasterDocCreate = { id: string; data: Record<string, unknown>; evidence: string };
/** `trims` (with `fromTrimsDigest` of the current top-level list) also replaces vehicle_master.trims — consumers match trim names against it. */
export type VehicleMasterVariantRepair = { id: string; fromDigest: string; to: Record<string, unknown>[]; evidence: string; trims?: string[]; fromTrimsDigest?: string };
/** `into` = the master that replaces it (must exist or be created by the same plan). */
export type VehicleMasterRetire = { id: string; into: string; evidence: string };

/** One transaction carries every target write plus one audit per target — keep well under Firestore's 500-write limit. */
export const MAX_VEHICLE_NAME_REPAIR_TARGETS = 200;
/** Upper bound for the in-transaction identity scan of vehicle_master (1,816 entries on 2026-10-04). */
export const MAX_MASTER_IDENTITY_SCAN = 5000;
/** Products scanned (names only) to make sure no product still carries a retired master's name. */
export const MAX_PRODUCT_NAME_SCAN = 20000;
/** The identity of a master entry: maker|model|sub_model (one entry per sub-model). */
export const masterNameKey = (data: Record<string, unknown>) => [data.maker, data.model, data.sub_model].map(clean).join('|');
const MASTER_CREATE_KEYS = ['id', 'maker', 'model', 'sub_model', 'origin'] as const;
const TRIM_CREATE_KEYS = ['maker', 'model', 'sub_model', 'trim', 'master_id', 'trim_row_key'] as const;

/**
 * Name text normalization — one rule for checking and storing: full-width ASCII (Ｌ·Ｅ·１) and ideographic space
 * to half-width, then NFC, trim, collapse spaces. Not NFKC: that would turn real names such as 포터 Ⅱ·플래티넘Ⅰ into «II»/«I».
 */
export const normalizeName = (value: unknown) => String(value ?? '')
  .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ')
  .normalize('NFC') // after the width change, so a second pass changes nothing
  .trim().replace(/\s+/g, ' ');
const clean = normalizeName;
/** Names written by this tool must already be normalized — a value that changes under normalizeName is refused. */
const NAME_KINDS = new Set(['master', 'product', 'trim', 'productTrim', 'trimSubModel', 'masterModel', 'trimModel', 'masterGenCode', 'masterTitle']);
const PRODUCT_IDENTITY_FIELDS = ['maker', 'model', 'sub_model'] as const;
/** Kinds that write a vehicle_master document (a retired master is frozen for all of them). */
const MASTER_DOC_KINDS = new Set(['master', 'masterModel', 'masterGenCode', 'masterTitle']);
/** Every trim name inside variants must also be in the top-level trims list (consumers read both). */
/** A Firestore document id inside one collection: no path separator, not «.»/«..», not reserved «__…__», no surrounding spaces. */
export const isDocId = (value: unknown): value is string => typeof value === 'string' && value !== '' && value === value.trim()
  && !value.includes('/') && value !== '.' && value !== '..' && !/^__.*__$/.test(value);
type FieldType = 'string' | 'number' | 'boolean' | 'stringList' | 'nullableString' | 'nullableNumber' | 'variants';
const isStringList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '' && x === clean(x)) && new Set(v).size === v.length;
const fieldOk = (type: FieldType, v: unknown): boolean => {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'stringList': return isStringList(v);
    case 'nullableString': return v === null || typeof v === 'string';
    case 'nullableNumber': return v === null || (typeof v === 'number' && Number.isFinite(v));
    case 'variants': return Array.isArray(v);
  }
};
/** Fields a created vehicle_master / vehicle_trim_master document may carry, with their types (as the stored data has them). */
const MASTER_CREATE_SCHEMA: Record<string, FieldType> = {
  id: 'string', maker: 'string', model: 'string', sub_model: 'string', origin: 'string', title: 'string', gen_code: 'string',
  market_class: 'string', newcar_priced: 'boolean', year_start: 'string', year_end: 'string', variants: 'variants', trims: 'stringList',
  sub_model_aliases: 'stringList', model_aliases: 'stringList', gen_code_aliases: 'stringList',
};
const TRIM_CREATE_SCHEMA: Record<string, FieldType> = {
  maker: 'string', model: 'string', sub_model: 'string', trim: 'string', master_id: 'string', trim_row_key: 'string', origin: 'string',
  development_code: 'string', trim_seq: 'number', trim_aliases: 'stringList', sub_model_aliases: 'stringList', model_aliases: 'stringList',
  management_status: 'string', verification_status: 'string', production_start: 'string', production_end: 'string', data_as_of: 'string', usage_tier: 'string',
};
/** A variant's fields and types (the stored variants use exactly these). */
const VARIANT_SCHEMA: Record<string, FieldType> = {
  label: 'string', fuel: 'nullableString', displacement_l: 'nullableNumber', drivetrain: 'nullableString', seat: 'nullableNumber',
  battery_kwh: 'nullableNumber', turbo: 'boolean', default: 'boolean', trims: 'stringList',
};
const checkSchema = (data: Record<string, unknown>, schema: Record<string, FieldType>, where: string) => {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue; // absent
    const type = schema[k];
    if (!type) throw new Error(`${where} has a field this tool does not create: ${k}`);
    if (!fieldOk(type, v)) throw new Error(`${where} ${k} has the wrong type`);
  }
};
/** Planned variants: each one is checked against VARIANT_SCHEMA (label and fuel required). */
const checkPlannedVariants = (variants: unknown, where: string) => {
  if (!Array.isArray(variants)) throw new Error(`${where} variants must be a list`);
  variants.forEach((v, i) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where} variant ${i} must be an object`);
    checkSchema(v as Record<string, unknown>, VARIANT_SCHEMA, `${where} variant ${i}`);
    if (!('label' in (v as object)) || !('fuel' in (v as object))) throw new Error(`${where} variant ${i} requires label and fuel`);
  });
};
/** Shape check too: variants is a list of objects; a variant's trims, when present, is a list of strings — anything else is refused. */
const variantTrimNames = (variants: unknown): string[] => {
  if (variants === undefined) return [];
  if (!Array.isArray(variants)) throw new Error('variants must be a list');
  return variants.flatMap((v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('each variant must be an object');
    const trims = (v as Record<string, unknown>).trims;
    if (trims === undefined) return [];
    if (!Array.isArray(trims) || trims.some((t) => typeof t !== 'string')) throw new Error('variant trims must be a list of strings');
    if (trims.some((t) => !t || t !== clean(t))) throw new Error('variant trims must be non-empty normalized names');
    return trims as string[];
  });
};
/** A stored top-level trims list used for the ⊆ check must be a list of strings. */
const storedTrimList = (value: unknown, where: string): string[] | undefined => {
  if (value === undefined) return undefined; // absent: only variants without trim names may be written
  if (!Array.isArray(value) || value.some((t) => typeof t !== 'string' || !t.trim())) throw new Error(`stored trims is not a list of strings ${where}`);
  return value.map(clean);
};
/** A stored variants list (being replaced) must still be a list of objects whose trims, when present, are non-empty strings. */
const storedVariantsShape = (value: unknown, where: string) => {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => !v || typeof v !== 'object' || Array.isArray(v)
    || ((v as Record<string, unknown>).trims !== undefined && (!Array.isArray((v as Record<string, unknown>).trims)
      || ((v as Record<string, unknown>).trims as unknown[]).some((t) => typeof t !== 'string' || !t.trim()))))) {
    throw new Error(`stored variants is not a list of variants ${where}`);
  }
};
/** An alias field, when present, must be a list of strings (kept-alias checks compare by value). */
const aliasListOk = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.every((a) => typeof a === 'string'));
/** Stored value matches the plan's `from`. A blank `from` only matches a truly blank value: missing, null or an empty string. */
export const matchesFrom = (stored: unknown, from: string) => clean(from)
  ? typeof stored === 'string' && clean(stored) === clean(from) // a number or other type never matches a name
  : stored === undefined || stored === null || (typeof stored === 'string' && stored.trim() === '');
const identityKeyFrom = (data: Partial<Record<(typeof PRODUCT_IDENTITY_FIELDS)[number], unknown>>) => PRODUCT_IDENTITY_FIELDS.map((field) => clean(data[field])).join('|');
const matchesProductIdentityFromField = (stored: unknown, from: string) => from === ''
  ? stored === undefined || stored === null || stored === ''
  : typeof stored === 'string' && stored === from;
const matchesIdentityFrom = (stored: Record<string, unknown> | undefined, from: VehicleProductIdentityRepairItem['from']) =>
  PRODUCT_IDENTITY_FIELDS.every((field) => matchesProductIdentityFromField(stored?.[field], from[field]));
const productIdentityToObject = (item: VehicleProductIdentityRepairItem) => ({
  maker: clean(item.to.maker), model: clean(item.to.model), sub_model: clean(item.to.sub_model),
});

export function validateVehicleNameRepairPlan(plan: VehicleNameRepairPlan) {
  if (!plan.sourceDigest?.trim()) throw new Error('sourceDigest is required');
  const all = [...plan.masterRepairs.map((item) => ({ ...item, kind: 'master' })), ...plan.productRepairs.map((item) => ({ ...item, kind: 'product' })),
    ...(plan.trimRepairs ?? []).map((item) => ({ ...item, kind: 'trim' })),
    ...(plan.productTrimRepairs ?? []).map((item) => ({ ...item, kind: 'productTrim' })),
    ...(plan.trimSubModelRepairs ?? []).map((item) => ({ ...item, kind: 'trimSubModel' })),
    ...(plan.trimMasterLinkRepairs ?? []).map((item) => ({ ...item, kind: 'trimMasterLink' })),
    ...(plan.masterModelRepairs ?? []).map((item) => ({ ...item, kind: 'masterModel' })),
    ...(plan.trimModelRepairs ?? []).map((item) => ({ ...item, kind: 'trimModel' })),
    ...(plan.masterGenCodeRepairs ?? []).map((item) => ({ ...item, kind: 'masterGenCode' })),
    ...(plan.masterTitleRepairs ?? []).map((item) => ({ ...item, kind: 'masterTitle' }))];
  const productIdentityRepairs = plan.productIdentityRepairs ?? [];
  if (productIdentityRepairs.length && (plan.masterRepairs.length || (plan.masterModelRepairs ?? []).length || (plan.masterRetires ?? []).length)) {
    throw new Error('상품 차종 칸 고치기는 마스터 이름 바꾸기·퇴역과 다른 계획으로');
  }
  const creates = [...(plan.masterCreates ?? []).map((c) => ({ ...c, kind: 'masterCreate', keys: MASTER_CREATE_KEYS })),
    ...(plan.trimCreates ?? []).map((c) => ({ ...c, kind: 'trimCreate', keys: TRIM_CREATE_KEYS }))];
  const variantRepairs = plan.masterVariantRepairs ?? [];
  for (const v of variantRepairs) {
    if (!v.id?.trim() || !/^[0-9a-f]{64}$/.test(v.fromDigest ?? '') || !Array.isArray(v.to) || !v.to.length) throw new Error('masterVariantRepair requires id, fromDigest and a non-empty variants list');
    if (typeof v.evidence !== 'string' || !v.evidence.trim()) throw new Error(`masterVariantRepair ${v.id} requires evidence`);
    variantTrimNames(v.to); // shape
    checkPlannedVariants(v.to, `masterVariantRepair ${v.id}`);
    if (!isDocId(v.id)) throw new Error('masterVariantRepair id must be a single document id');
    if ((v.trims === undefined) !== (v.fromTrimsDigest === undefined)) throw new Error(`masterVariantRepair ${v.id} needs trims and fromTrimsDigest together`);
    if (v.trims !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(v.fromTrimsDigest ?? '') || !Array.isArray(v.trims) || !v.trims.length) throw new Error(`masterVariantRepair ${v.id} requires a non-empty trims list and fromTrimsDigest`);
      if (v.trims.some((t) => typeof t !== 'string' || !t || t !== normalizeName(t))) throw new Error(`masterVariantRepair ${v.id} trims must be normalized names`);
      if (new Set(v.trims).size !== v.trims.length) throw new Error(`masterVariantRepair ${v.id} has duplicate trims`);
      const listed = new Set(v.trims);
      const missing = variantTrimNames(v.to).filter((t) => !listed.has(t));
      if (missing.length) throw new Error(`masterVariantRepair ${v.id} variants name trims missing from trims: ${[...new Set(missing)].join(', ')}`);
    }
    if (stableDigest(v.to) === v.fromDigest && (v.trims === undefined || stableDigest(v.trims) === v.fromTrimsDigest)) throw new Error(`no-op masterVariantRepair ${v.id}`);
  }
  if (new Set(variantRepairs.map((v) => v.id)).size !== variantRepairs.length) throw new Error('duplicate masterVariantRepair');
  const retires = plan.masterRetires ?? [];
  for (const r of retires) {
    if (!r.id?.trim() || r.id !== r.id.trim() || !r.into?.trim() || r.into !== r.into.trim()) throw new Error('masterRetire requires exact id and into');
    if (!isDocId(r.id) || !isDocId(r.into)) throw new Error('masterRetire id and into must be single document ids');
    if (r.id === r.into) throw new Error(`masterRetire ${r.id} cannot retire into itself`);
    if (typeof r.evidence !== 'string' || !r.evidence.trim()) throw new Error(`masterRetire ${r.id} requires evidence`);
  }
  if (new Set(retires.map((r) => r.id)).size !== retires.length) throw new Error('duplicate masterRetire');
  if (retires.some((r) => [...(plan.masterRepairs ?? []), ...(plan.masterVariantRepairs ?? []), ...(plan.masterModelRepairs ?? []), ...(plan.masterGenCodeRepairs ?? []), ...(plan.masterTitleRepairs ?? [])].some((m) => m.id === r.id))) throw new Error('a retired master must not be renamed or edited in the same plan');
  const retiredIds = new Set(retires.map((r) => r.id));
  if (retires.some((r) => retiredIds.has(r.into))) throw new Error('masterRetire into must not itself be retired in the same plan (no chains or cycles)');
  if ((plan.trimCreates ?? []).some((c) => retiredIds.has(String(c.data.master_id))) || (plan.trimMasterLinkRepairs ?? []).some((l) => retiredIds.has(l.to))) {
    throw new Error('the same plan must not link a trim row to a master it retires');
  }
  if ((plan.masterCreates ?? []).some((c) => c.data.retired !== undefined || c.data.retired_into !== undefined)) throw new Error('masterCreate must create an active master (no retired fields)');
  if (!all.length && !productIdentityRepairs.length && !creates.length && !variantRepairs.length && !retires.length) throw new Error('repair plan is empty');
  if (all.length + productIdentityRepairs.length + creates.length + variantRepairs.length + retires.length > MAX_VEHICLE_NAME_REPAIR_TARGETS) throw new Error(`repair plan too large (max ${MAX_VEHICLE_NAME_REPAIR_TARGETS} targets) — split it`);
  const createKeys = new Set<string>();
  for (const c of creates) {
    if (!c.id?.trim() || typeof c.data !== 'object' || c.data === null || Array.isArray(c.data)) throw new Error(`${c.kind} requires id and data`);
    if (typeof c.evidence !== 'string' || !c.evidence.trim()) throw new Error(`${c.kind} ${c.id} requires evidence`);
    for (const key of c.keys) if (key !== 'id' && !clean(c.data[key])) throw new Error(`${c.kind} ${c.id} requires data.${key}`);
    if (c.kind === 'trimCreate') {
      for (const key of ['maker', 'model', 'sub_model', 'trim'] as const) {
        if (typeof c.data[key] !== 'string' || c.data[key] !== clean(c.data[key])) throw new Error(`trimCreate ${c.id} ${key} must be normalized text`);
      }
    }
    if (c.kind === 'masterCreate' && c.data.id !== c.id) throw new Error(`masterCreate ${c.id} data.id must equal id`);
    if (!isDocId(c.id)) throw new Error(`${c.kind} id must be a single document id`);
    checkSchema(c.data, c.kind === 'masterCreate' ? MASTER_CREATE_SCHEMA : TRIM_CREATE_SCHEMA, `${c.kind} ${c.id}`);
    if (c.data.variants !== undefined) checkPlannedVariants(c.data.variants, `${c.kind} ${c.id}`);
    if (c.kind === 'trimCreate' && !isDocId(c.data.master_id)) throw new Error(`trimCreate ${c.id} master_id must be an exact id (single document id)`);
    if (c.data.gen_code !== undefined && c.data.gen_code !== clean(c.data.gen_code)) throw new Error(`${c.kind} ${c.id} gen_code must be normalized text`);
    for (const f of ['sub_model_aliases', 'model_aliases', 'gen_code_aliases', 'trim_aliases'] as const) {
      if (c.data[f] !== undefined && !(Array.isArray(c.data[f]) && (c.data[f] as unknown[]).every((a) => typeof a === 'string'))) throw new Error(`${c.kind} ${c.id} ${f} must be a list of strings`);
    }
    if (c.data.gen_code !== undefined && typeof c.data.gen_code !== 'string') throw new Error(`${c.kind} ${c.id} gen_code must be a string`);
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
    for (const key of ['maker', 'model', 'sub_model'] as const) {
      if (typeof c.data[key] !== 'string' || c.data[key] !== clean(c.data[key])) throw new Error(`masterCreate ${c.id} ${key} must be normalized text`);
    }
    if (c.data.trims !== undefined && (!Array.isArray(c.data.trims) || c.data.trims.some((t) => typeof t !== 'string' || !t || t !== clean(t)))) throw new Error(`masterCreate ${c.id} trims must be a list of normalized strings`);
    if (variantTrimNames(c.data.variants).length && !Array.isArray(c.data.trims)) throw new Error(`masterCreate ${c.id} variants name trims but trims is not a list`);
    if (Array.isArray(c.data.variants) && Array.isArray(c.data.trims)) {
      const listed = new Set((c.data.trims as unknown[]).map(clean));
      const missing = variantTrimNames(c.data.variants).filter((t) => !listed.has(t));
      if (missing.length) throw new Error(`masterCreate ${c.id} variants name trims missing from trims: ${[...new Set(missing)].join(', ')}`);
    }
    const name = masterNameKey(c.data);
    if (masterNames.has(name)) throw new Error(`duplicate master sub-model ${name}`);
    masterNames.add(name);
  }
  // Linked masters must exist already or be created by this plan — checked against Firestore at apply time.
  const productIds = new Set(plan.productRepairs.map((item) => item.id));
  if ((plan.productTrimRepairs ?? []).some((item) => productIds.has(item.id))) throw new Error('one product per plan: sub_model and trim_name repairs must not overlap');
  const productIdentityIds = new Set<string>();
  for (const item of productIdentityRepairs) {
    if (!isDocId(item.id)) throw new Error('productIdentity repair id must be a single document id');
    if (productIdentityIds.has(item.id)) throw new Error(`duplicate productIdentity repair productIdentity:${item.id}`);
    productIdentityIds.add(item.id);
    if (productIds.has(item.id) || (plan.productTrimRepairs ?? []).some((p) => p.id === item.id)) {
      throw new Error('one product per plan: product identity, sub_model and trim_name repairs must not overlap');
    }
    if (typeof item.evidence !== 'string' || !item.evidence.trim()) throw new Error(`productIdentity ${item.id} requires evidence`);
    for (const side of ['from', 'to'] as const) {
      for (const field of PRODUCT_IDENTITY_FIELDS) if (typeof item[side]?.[field] !== 'string') throw new Error(`productIdentity ${item.id} ${side}.${field} must be a string`);
    }
    for (const field of PRODUCT_IDENTITY_FIELDS) {
      if (!clean(item.to[field])) throw new Error(`productIdentity ${item.id} to.${field} requires a non-empty value`);
      if (item.to[field] !== clean(item.to[field])) throw new Error(`productIdentity ${item.id} to.${field} must be normalized text`);
    }
    if (PRODUCT_IDENTITY_FIELDS.every((field) => clean(item.from[field]) === clean(item.to[field]))) throw new Error(`no-op productIdentity:${item.id}`);
  }
  const keys = new Set<string>();
  for (const item of all) {
    // A blank `from` fills an empty products.sub_model only, with source-text evidence; the transaction
    // precondition still requires the stored value to be blank at write time. Every other kind needs a name.
    const evidenceOk = typeof item.evidence === 'string' && item.evidence.trim() !== '';
    if (item.evidence !== undefined && !evidenceOk) throw new Error('repair item evidence must be a non-empty string');
    // A blank gen_code may be filled too (the code is already in the sub-model name), with evidence.
    const blankFill = !clean(item.from) && (item.kind === 'product' || item.kind === 'masterGenCode') && evidenceOk;
    if (typeof item.id !== 'string' || typeof item.from !== 'string' || typeof item.to !== 'string') throw new Error('repair item id/from/to must be strings');
    if (!item.id?.trim() || !clean(item.to) || (!clean(item.from) && !blankFill)) throw new Error('repair item requires id/from/to');
    if (!isDocId(item.id)) throw new Error(`repair item ${item.kind} id must be a single document id`);
    if (item.kind === 'trimMasterLink' && (!isDocId(item.to) || !isDocId(item.from))) throw new Error(`trimMasterLink ${item.id} from/to must be exact master ids`);
    if (clean(item.from) === clean(item.to)) throw new Error(`no-op repair ${item.kind}:${item.id}`);
    if (item.kind === 'trimMasterLink' && item.to !== item.to.trim()) throw new Error(`trimMasterLink ${item.id} to must be an exact master id`);
    if (NAME_KINDS.has(item.kind) && item.to !== clean(item.to)) throw new Error(`${item.kind} ${item.id} to must be normalized text`);
    const key = `${item.kind}:${item.id}`;
    if (keys.has(key)) throw new Error(`duplicate repair ${key}`);
    keys.add(key);
  }
  return { masterCount: plan.masterRepairs.length, productCount: plan.productRepairs.length,
    ...(plan.productIdentityRepairs ? { productIdentityCount: plan.productIdentityRepairs.length } : {}),
    ...(plan.trimRepairs ? { trimCount: plan.trimRepairs.length } : {}),
    ...(plan.productTrimRepairs ? { productTrimCount: plan.productTrimRepairs.length } : {}),
    ...(plan.trimSubModelRepairs ? { trimSubModelCount: plan.trimSubModelRepairs.length } : {}),
    ...(plan.trimMasterLinkRepairs ? { trimMasterLinkCount: plan.trimMasterLinkRepairs.length } : {}),
    ...(plan.masterVariantRepairs ? { masterVariantCount: plan.masterVariantRepairs.length } : {}),
    ...(plan.masterRetires ? { masterRetireCount: plan.masterRetires.length } : {}),
    ...(plan.masterCreates ? { masterCreateCount: plan.masterCreates.length } : {}),
    ...(plan.trimCreates ? { trimCreateCount: plan.trimCreates.length } : {}),
    ...(plan.masterModelRepairs ? { masterModelCount: plan.masterModelRepairs.length } : {}),
    ...(plan.trimModelRepairs ? { trimModelCount: plan.trimModelRepairs.length } : {}),
    ...(plan.masterGenCodeRepairs ? { masterGenCodeCount: plan.masterGenCodeRepairs.length } : {}),
    ...(plan.masterTitleRepairs ? { masterTitleCount: plan.masterTitleRepairs.length } : {}) };
}

type RepairField = 'sub_model' | 'trim' | 'trim_name' | 'master_id' | 'model' | 'gen_code' | 'title';
type AliasField = 'trim_aliases' | 'sub_model_aliases' | 'model_aliases' | 'gen_code_aliases';
/** The old name is kept in an alias list on these kinds (rule 20: sub-model aliases live in FreePass Data). */
const ALIAS_FIELD: Partial<Record<string, AliasField>> = {
  trim: 'trim_aliases', master: 'sub_model_aliases', trimSubModel: 'sub_model_aliases',
  masterModel: 'model_aliases', trimModel: 'model_aliases', masterGenCode: 'gen_code_aliases',
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
    ...(plan.masterModelRepairs ?? []).map((item) => ({ kind: 'masterModel', item, ref: db.collection('vehicle_master').doc(item.id), field: 'model' as RepairField })),
    ...(plan.trimModelRepairs ?? []).map((item) => ({ kind: 'trimModel', item, ref: db.collection('vehicle_trim_master').doc(item.id), field: 'model' as RepairField })),
    ...(plan.masterGenCodeRepairs ?? []).map((item) => ({ kind: 'masterGenCode', item, ref: db.collection('vehicle_master').doc(item.id), field: 'gen_code' as RepairField })),
    ...(plan.masterTitleRepairs ?? []).map((item) => ({ kind: 'masterTitle', item, ref: db.collection('vehicle_master').doc(item.id), field: 'title' as RepairField })),
  ];
  const identityTargets = (plan.productIdentityRepairs ?? []).map((item) => ({ kind: 'productIdentity', item, ref: db.collection('products').doc(item.id) }));
  const creates = [
    ...(plan.masterCreates ?? []).map((c) => ({ c, ref: db.collection('vehicle_master').doc(c.id) })),
    ...(plan.trimCreates ?? []).map((c) => ({ c, ref: db.collection('vehicle_trim_master').doc(c.id) })),
  ];
  // Rows may only be linked to an active (not retired) master that already exists or that this plan creates.
  const createdMasterIds = new Set((plan.masterCreates ?? []).map((c) => c.id));
  const linkedMasterIds = [...new Set([...(plan.trimMasterLinkRepairs ?? []).map((i) => i.to),
    ...(plan.trimCreates ?? []).map((c) => String(c.data.master_id))])].filter((id) => !createdMasterIds.has(id));
  const linkRefs = linkedMasterIds.map((id) => db.collection('vehicle_master').doc(id));
  if (linkRefs.length && (await db.getAll(...linkRefs)).some((snapshot) => !snapshot.exists || snapshot.data()?.retired === true)) throw new Error('linked vehicle_master missing or retired');

  const refs = targets.map((x) => x.ref);
  const snapshots = refs.length ? await db.getAll(...refs) : [];
  if (snapshots.some((snapshot) => !snapshot.exists)) throw new Error('repair target missing');
  snapshots.forEach((snapshot, index) => {
    if (!matchesFrom(snapshot.data()?.[targets[index]!.field], targets[index]!.item.from)) {
      throw new Error(`precondition changed ${snapshot.ref.path}`);
    }
    const aliasField = ALIAS_FIELD[targets[index]!.kind];
    const aliasValue = aliasField ? snapshot.data()?.[aliasField] : undefined;
    if (!aliasListOk(aliasValue)) throw new Error(`alias field is not a list of strings ${snapshot.ref.path}.${aliasField}`);
  });
  const identityRefs = identityTargets.map((x) => x.ref);
  const identitySnapshots = identityRefs.length ? await db.getAll(...identityRefs) : [];
  if (identitySnapshots.some((snapshot) => !snapshot.exists)) throw new Error('productIdentity repair target missing');
  identitySnapshots.forEach((snapshot, index) => {
    if (!matchesIdentityFrom(snapshot.data(), identityTargets[index]!.item.from)) throw new Error(`productIdentity precondition changed ${snapshot.ref.path}`);
  });
  const variantRepairs = plan.masterVariantRepairs ?? [];
  const variantRefs = variantRepairs.map((v) => db.collection('vehicle_master').doc(v.id));
  const variantSnaps = variantRefs.length ? await db.getAll(...variantRefs) : [];
  variantSnaps.forEach((snapshot, index) => {
    const v = variantRepairs[index]!;
    storedTrimList(snapshot.data()?.trims, snapshot.ref.path); // shape, whether or not the list is replaced
    storedVariantsShape(snapshot.data()?.variants, snapshot.ref.path);
    if (!snapshot.exists || stableDigest(snapshot.data()?.variants ?? null) !== v.fromDigest
      || (v.trims !== undefined && stableDigest(snapshot.data()?.trims ?? null) !== v.fromTrimsDigest)) {
      throw new Error(`variants precondition changed ${snapshot.ref.path}`);
    }
    if (v.trims === undefined) {
      const stored = storedTrimList(snapshot.data()?.trims, snapshot.ref.path);
      if (!stored && variantTrimNames(v.to).length) throw new Error(`masterVariantRepair ${v.id} stored trims is not a list — pass trims`);
      const listed = new Set(stored ?? []);
      const missing = variantTrimNames(v.to).filter((t) => !listed.has(t));
      if (missing.length) throw new Error(`masterVariantRepair ${v.id} variants name trims missing from the stored trims (pass trims): ${[...new Set(missing)].join(', ')}`);
    }
  });
  const retires = plan.masterRetires ?? [];
  const retireRefs = retires.map((x) => db.collection('vehicle_master').doc(x.id));
  const retireSnaps = retireRefs.length ? await db.getAll(...retireRefs) : [];
  retireSnaps.forEach((snapshot) => {
    if (!snapshot.exists || snapshot.data()?.retired === true) throw new Error(`retire target missing or already retired ${snapshot.ref.path}`);
  });
  // Pinned at backup time; the transaction refuses to retire a document that changed after the backup.
  const retireDigests = retireSnaps.map((snapshot) => stableDigest(snapshot.data() ?? null));
  const retiredNameKeys = new Set(retireSnaps.map((snapshot) => `${clean(snapshot.data()?.model)}|${clean(snapshot.data()?.sub_model)}`));
  const retiredSubModels = new Set(retireSnaps.map((snapshot) => clean(snapshot.data()?.sub_model)));
  const retiredIdentityKeys = new Set(retireSnaps.map((snapshot) => identityKeyFrom({
    maker: snapshot.data()?.maker, model: snapshot.data()?.model, sub_model: snapshot.data()?.sub_model,
  })));
  if (plan.productRepairs.some((item) => retiredSubModels.has(clean(item.to)))) throw new Error('the same plan must not give a product the name of a master it retires');
  if ((plan.productIdentityRepairs ?? []).some((item) => retiredIdentityKeys.has(identityKeyFrom(item.to)))) throw new Error('the same plan must not give a product the identity of a master it retires');
  if (retires.length) {
    // Early refusal only; the binding check repeats inside the transaction. Maker is not compared (spellings differ), so this only errs toward refusing.
    const products = await db.collection('products').select('model', 'sub_model').limit(MAX_PRODUCT_NAME_SCAN + 1).get();
    if (products.docs.length > MAX_PRODUCT_NAME_SCAN) throw new Error(`products has more than ${MAX_PRODUCT_NAME_SCAN} entries — retire name check would be unbounded`);
    const used = products.docs.find((doc) => retiredNameKeys.has(`${clean(doc.data().model)}|${clean(doc.data().sub_model)}`));
    if (used) throw new Error(`master name still used by products products/${used.id}`);
  }
  const retireIntoRefs = [...new Set(retires.map((x) => x.into))].filter((id) => !createdMasterIds.has(id)).map((id) => db.collection('vehicle_master').doc(id));
  if (retireIntoRefs.length && (await db.getAll(...retireIntoRefs)).some((snapshot) => !snapshot.exists || snapshot.data()?.retired === true)) throw new Error('retire into-master missing or retired');
  // Rows this plan moves away from a retired master no longer count as «still linked».
  const relinkedAway = new Set((plan.trimMasterLinkRepairs ?? []).map((l) => `${l.from}|${l.id}`));
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
    documents: [...snapshots, ...identitySnapshots, ...variantSnaps, ...retireSnaps].map((snapshot) => ({ path: snapshot.ref.path, data: snapshot.data() })),
    // The reviewed items (incl. source-text evidence for blank fills) are kept with the before-images.
    repairs: targets.map(({ item, field, ref }) => ({ path: ref.path, field, ...item })),
    productIdentityRepairs: identityTargets.map(({ item, ref }) => ({ path: ref.path, ...item })),
    creates: creates.map(({ c, ref }) => ({ path: ref.path, evidence: c.evidence, data: c.data })),
    variantRepairs: variantRepairs.map((v) => ({ path: `vehicle_master/${v.id}`, ...v })),
    retires: retires.map((x) => ({ path: `vehicle_master/${x.id}`, ...x })),
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
    ...identityTargets.map(({ item, ref }): AuditEvent => ({
      eventId: auditId(ref.path, 'identity'), commandId: `vehicle-name-repair:${runId}`, actor,
      entityType: ref.parent.id, entityId: ref.id, action: 'VEHICLE_NAME_REFERENCE_REPAIRED',
      before: Object.fromEntries(PRODUCT_IDENTITY_FIELDS.map((field) => [field, item.from[field]])),
      after: productIdentityToObject(item),
      reason: `원문 근거: ${item.evidence}`,
      revisionBefore: 0, revisionAfter: 0, occurredAt,
    })),
    ...retires.map((x, index): AuditEvent => ({
      eventId: auditId(retireRefs[index]!.path, 'retired'), commandId: `vehicle-name-repair:${runId}`, actor,
      entityType: 'vehicle_master', entityId: x.id, action: 'VEHICLE_MASTER_ENTRY_RETIRED',
      before: { retired: retireSnaps[index]!.data()?.retired ?? null, retired_into: retireSnaps[index]!.data()?.retired_into ?? null }, after: { retired: true, retired_into: x.into },
      reason: `차종 마스터 퇴역(지우지 않고 표시) 근거: ${x.evidence} (${plan.sourceDigest})`,
      revisionBefore: 0, revisionAfter: 0, occurredAt,
    })),
    ...variantRepairs.map((v, index): AuditEvent => ({
      eventId: auditId(variantRefs[index]!.path, 'variants'), commandId: `vehicle-name-repair:${runId}`, actor,
      entityType: 'vehicle_master', entityId: v.id, action: 'VEHICLE_MASTER_VARIANTS_REPAIRED',
      before: { variantsDigest: v.fromDigest, ...(v.trims ? { trimsDigest: v.fromTrimsDigest } : {}) }, after: { variantsDigest: stableDigest(v.to), ...(v.trims ? { trims: v.trims } : {}) },
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
  for (const { item, ref } of identityTargets) {
    const entry = byPath[ref.path] ?? { ref, fields: {}, aliases: {} };
    for (const field of PRODUCT_IDENTITY_FIELDS) {
      if (entry.fields[field] !== undefined) throw new Error(`two repairs write ${ref.path}.${field}`);
      entry.fields[field] = clean(item.to[field]);
    }
    byPath[ref.path] = entry;
  }

  // A master's variants list joins that document's single update (it may also be renamed in the same plan).
  retires.forEach((_, index) => {
    const r = retireRefs[index]!;
    byPath[r.path] = byPath[r.path] ?? { ref: r, fields: {}, aliases: {} };
  });
  const retireByPath: Record<string, string> = Object.fromEntries(retires.map((x, i) => [retireRefs[i]!.path, x.into]));
  variantRepairs.forEach((_, index) => {
    const r = variantRefs[index]!;
    byPath[r.path] = byPath[r.path] ?? { ref: r, fields: {}, aliases: {} };
  });
  const variantsByPath: Record<string, Record<string, unknown>[]> = Object.fromEntries(variantRepairs.map((v, i) => [variantRefs[i]!.path, v.to]));
  const masterTrimsByPath: Record<string, string[]> = Object.fromEntries(variantRepairs.filter((v) => v.trims).map((v) => [`vehicle_master/${v.id}`, v.trims!]));

  await db.runTransaction(async (transaction) => {
    const current = refs.length ? await transaction.getAll(...refs) : [];
    const identityCurrent = identityRefs.length ? await transaction.getAll(...identityRefs) : [];
    identityCurrent.forEach((snapshot, index) => {
      if (!snapshot.exists || !matchesIdentityFrom(snapshot.data(), identityTargets[index]!.item.from)) {
        throw new Error(`transaction productIdentity precondition changed ${snapshot.ref.path}`);
      }
      for (const field of PRODUCT_IDENTITY_FIELDS) {
        if (snapshot.data()?.[field] !== identitySnapshots[index]!.data()?.[field]) {
          throw new Error(`transaction stored spelling changed since backup ${snapshot.ref.path}.${field}`);
        }
      }
    });
    // A retired master is frozen: its name is not changed again (a rename would let products use it under a new name).
    const frozen = targets.findIndex((t, i) => MASTER_DOC_KINDS.has(t.kind) && current[i]?.data()?.retired === true);
    if (frozen >= 0) throw new Error(`retired master cannot be renamed ${targets[frozen]!.ref.path}`);
    const finalMasterSubModels: Record<string, string> = {};
    for (const t of targets) if (t.kind === 'master') finalMasterSubModels[t.ref.id] = clean(t.item.to);
    targets.forEach((t, index) => {
      if (t.kind !== 'masterTitle') return;
      const data = current[index]?.data();
      const expected = clean(`${clean(data?.maker)} ${finalMasterSubModels[t.ref.id] ?? clean(data?.sub_model)}`);
      if (clean(t.item.to) !== expected) throw new Error(`masterTitle ${t.ref.path} must equal final maker + sub_model (${expected})`);
    });
    // A product must not be renamed onto the name of a master that is already retired (in any earlier plan).
    const productTargets = targets.map((t, i) => ({ t, data: current[i]?.data() })).filter((x) => x.t.kind === 'product');
    if (productTargets.length) {
      const retired = await transaction.get(db.collection('vehicle_master').where('retired', '==', true).select('model', 'sub_model').limit(MAX_MASTER_IDENTITY_SCAN + 1));
      if (retired.docs.length > MAX_MASTER_IDENTITY_SCAN) throw new Error(`more than ${MAX_MASTER_IDENTITY_SCAN} retired masters — product name check would be unbounded`);
      const retiredKeys = new Set(retired.docs.map((doc) => `${clean(doc.data().model)}|${clean(doc.data().sub_model)}`));
      const hit = productTargets.find((x) => retiredKeys.has(`${clean(x.data?.model)}|${clean(x.t.item.to)}`));
      if (hit) throw new Error(`product ${hit.t.ref.path} would take the name of a retired master`);
    }
    if (identityTargets.length) {
      const retired = await transaction.get(db.collection('vehicle_master').where('retired', '==', true).select('maker', 'model', 'sub_model').limit(MAX_MASTER_IDENTITY_SCAN + 1));
      if (retired.docs.length > MAX_MASTER_IDENTITY_SCAN) throw new Error(`more than ${MAX_MASTER_IDENTITY_SCAN} retired masters — product identity check would be unbounded`);
      const retiredKeys = new Set(retired.docs.map((doc) => identityKeyFrom(doc.data())));
      const retiredHit = identityTargets.find((x) => retiredKeys.has(identityKeyFrom(x.item.to)));
      if (retiredHit) throw new Error(`product ${retiredHit.ref.path} would take the identity of a retired master`);
      const stored = await transaction.get(db.collection('vehicle_master').select('maker', 'model', 'sub_model', 'retired').limit(MAX_MASTER_IDENTITY_SCAN + 1));
      if (stored.docs.length > MAX_MASTER_IDENTITY_SCAN) throw new Error(`vehicle_master has more than ${MAX_MASTER_IDENTITY_SCAN} entries — product identity check would be unbounded`);
      const activeKeys: Record<string, string[]> = {};
      const addActive = (key: string, id: string, retired?: unknown) => {
        if (retired === true) return;
        activeKeys[key] = [...(activeKeys[key] ?? []), id];
      };
      for (const doc of stored.docs) addActive(identityKeyFrom(doc.data()), doc.id, doc.data().retired);
      for (const c of plan.masterCreates ?? []) addActive(masterNameKey(c.data), c.id);
      const miss = identityTargets.find((x) => (activeKeys[identityKeyFrom(x.item.to)] ?? []).length !== 1);
      if (miss) throw new Error(`productIdentity target does not match exactly one active vehicle_master ${miss.ref.path}`);
    }
    // Linked masters and create targets are read inside the transaction too, so a concurrent delete/create aborts it.
    if (linkRefs.length && (await transaction.getAll(...linkRefs)).some((snapshot) => !snapshot.exists || snapshot.data()?.retired === true)) throw new Error('transaction linked vehicle_master missing or retired');
    if (createRefs.length && (await transaction.getAll(...createRefs)).some((snapshot) => snapshot.exists)) throw new Error('transaction create target already exists');
    for (const c of plan.trimCreates ?? []) {
      const same = await transaction.get(db.collection('vehicle_trim_master').where('trim_row_key', '==', c.id));
      if (!same.empty) throw new Error(`trim_row_key already stored ${c.id}`);
    }
    // Final identity check (값 하나): every stored master (names only, normalized — stored values may carry stray spaces),
    // with this plan's renames and creates applied, must not end up with the same maker|model|sub_model twice.
    if (targets.some((t) => t.kind === 'master' || t.kind === 'masterModel') || (plan.masterCreates ?? []).length) {
      const renamedMasters: Record<string, string> = {};
      const remodeledMasters: Record<string, string> = {};
      for (const t of targets) if (t.kind === 'master') renamedMasters[t.ref.id] = clean(t.item.to);
      for (const t of targets) if (t.kind === 'masterModel') remodeledMasters[t.ref.id] = clean(t.item.to);
      // Bounded read: names only, at most MAX_MASTER_IDENTITY_SCAN documents (stop rather than run an unbounded transaction).
      const stored = await transaction.get(db.collection('vehicle_master').select('maker', 'model', 'sub_model').limit(MAX_MASTER_IDENTITY_SCAN + 1));
      if (stored.docs.length > MAX_MASTER_IDENTITY_SCAN) throw new Error(`vehicle_master has more than ${MAX_MASTER_IDENTITY_SCAN} entries — identity check would be unbounded`);
      const finalKeys: Record<string, string> = {};
      for (const doc of stored.docs) {
        const data = doc.data();
        finalKeys[doc.id] = [clean(data.maker), remodeledMasters[doc.id] ?? clean(data.model), renamedMasters[doc.id] ?? clean(data.sub_model)].join('|');
      }
      for (const c of plan.masterCreates ?? []) finalKeys[c.id] = masterNameKey(c.data);
      const touched = new Set([...Object.keys(renamedMasters), ...Object.keys(remodeledMasters), ...(plan.masterCreates ?? []).map((c) => c.id)].map((id) => finalKeys[id]));
      const owners: Record<string, string> = {};
      for (const [id, key] of Object.entries(finalKeys)) {
        if (!touched.has(key)) continue;
        if (owners[key] !== undefined) throw new Error(`master sub-model would be stored twice ${key} (${owners[key]}, ${id})`);
        owners[key] = id;
      }
    }
    // Model consistency (one model name per master and its rows): for every master whose model changes, every master
    // of a row whose model changes, every relink destination and every master that gets a created row, the final model of each linked row (after this plan's relinks, row renames and creates)
    // must equal the master's final model — a master renamed without its rows, or a row added meanwhile, aborts.
    if (targets.some((t) => t.kind === 'masterModel' || t.kind === 'trimModel' || t.kind === 'trimMasterLink') || (plan.trimCreates ?? []).length) {
      const linkTo: Record<string, string> = Object.fromEntries((plan.trimMasterLinkRepairs ?? []).map((l) => [l.id, l.to]));
      const rowModelTo: Record<string, string> = {};
      const masterModelTo: Record<string, string> = {};
      const affected = new Set<string>();
      targets.forEach((t, i) => {
        if (t.kind === 'masterModel') { masterModelTo[t.ref.id] = clean(t.item.to); affected.add(t.ref.id); }
        if (t.kind === 'trimModel') { rowModelTo[t.ref.id] = clean(t.item.to); affected.add(linkTo[t.ref.id] ?? String(current[i]?.data()?.master_id ?? '')); }
      });
      // Rows relinked away from a master whose model changes keep their model unless renamed — so every relink destination is checked as well.
      for (const to of Object.values(linkTo)) affected.add(to);
      for (const c of plan.trimCreates ?? []) affected.add(String(c.data.master_id));
      const createdMaster: Record<string, Record<string, unknown>> = Object.fromEntries((plan.masterCreates ?? []).map((c) => [c.id, c.data]));
      for (const mid of affected) {
        if (!mid) throw new Error('trim row without master_id cannot change model');
        const masterData = createdMaster[mid] ?? (await transaction.getAll(db.collection('vehicle_master').doc(mid)))[0]!.data();
        if (!masterData) throw new Error(`model check: master missing vehicle_master/${mid}`);
        const want = masterModelTo[mid] ?? clean(masterData.model);
        const stored = await transaction.get(db.collection('vehicle_trim_master').where('master_id', '==', mid).limit(MAX_MASTER_IDENTITY_SCAN + 1));
        if (stored.docs.length > MAX_MASTER_IDENTITY_SCAN) throw new Error(`model check: too many rows on vehicle_master/${mid}`);
        const rows: Record<string, unknown> = {};
        for (const doc of stored.docs) if ((linkTo[doc.id] ?? mid) === mid) rows[doc.id] = doc.data().model;
        const incomingIds = Object.entries(linkTo).filter(([id, to]) => to === mid && rows[id] === undefined).map(([id]) => id);
        if (incomingIds.length) for (const snap of await transaction.getAll(...incomingIds.map((id) => db.collection('vehicle_trim_master').doc(id)))) rows[snap.ref.id] = snap.data()?.model;
        for (const c of plan.trimCreates ?? []) if (c.data.master_id === mid) rows[c.id] = c.data.model;
        const off = Object.entries(rows).find(([id, model]) => (rowModelTo[id] ?? clean(model)) !== want);
        if (off) throw new Error(`model would differ between vehicle_master/${mid} (${want}) and vehicle_trim_master/${off[0]}`);
      }
    }
    if (retireIntoRefs.length && (await transaction.getAll(...retireIntoRefs)).some((snapshot) => !snapshot.exists || snapshot.data()?.retired === true)) throw new Error('transaction retire into-master missing or retired');
    // Retire only when nothing still uses the master: no trim row links to it (after this plan's relinks) and no product carries its name.
    for (const [index, x] of retires.entries()) {
      const current = await transaction.getAll(retireRefs[index]!);
      const data = current[0]!.data();
      if (!current[0]!.exists || stableDigest(data ?? null) !== retireDigests[index]) throw new Error(`transaction retire target changed since backup ${retireRefs[index]!.path}`);
      const rows = await transaction.get(db.collection('vehicle_trim_master').where('master_id', '==', x.id).limit(MAX_VEHICLE_NAME_REPAIR_TARGETS + 1));
      if (rows.docs.some((row) => !relinkedAway.has(`${x.id}|${row.id}`))) throw new Error(`master still linked by trim rows ${retireRefs[index]!.path}`);
      // No chains: a master that others were already retired into stays active (its incoming retired_into would dangle).
      const incoming = await transaction.get(db.collection('vehicle_master').where('retired_into', '==', x.id).limit(1));
      if (!incoming.empty) throw new Error(`other masters are retired into ${retireRefs[index]!.path} — it cannot be retired`);
    }
    if (retires.length) {
      // Binding product check inside the transaction, normalized, so a product added in another spelling after the early check is still caught.
      const products = await transaction.get(db.collection('products').select('model', 'sub_model').limit(MAX_PRODUCT_NAME_SCAN + 1));
      if (products.docs.length > MAX_PRODUCT_NAME_SCAN) throw new Error(`products has more than ${MAX_PRODUCT_NAME_SCAN} entries — retire name check would be unbounded`);
      const used = products.docs.find((doc) => retiredNameKeys.has(`${clean(doc.data().model)}|${clean(doc.data().sub_model)}`));
      if (used) throw new Error(`master name still used by products products/${used.id}`);
    }
    if (variantRefs.length && (await transaction.getAll(...variantRefs)).some((snapshot, index) =>
      !snapshot.exists || snapshot.data()?.retired === true || stableDigest(snapshot.data()?.variants ?? null) !== variantRepairs[index]!.fromDigest
      || (variantRepairs[index]!.trims !== undefined && stableDigest(snapshot.data()?.trims ?? null) !== variantRepairs[index]!.fromTrimsDigest))) {
      throw new Error('transaction variants precondition changed or master retired');
    }
    // trims is pinned by fromTrimsDigest when given; otherwise the stored list (read again here) must still cover the new variants.
    for (const [index, v] of variantRepairs.entries()) {
      const stored = (await transaction.getAll(variantRefs[index]!))[0]!.data()?.trims;
      storedTrimList(stored, variantRefs[index]!.path); // shape, whether or not the list is replaced
      storedVariantsShape((await transaction.getAll(variantRefs[index]!))[0]!.data()?.variants, variantRefs[index]!.path);
      if (v.trims !== undefined) continue;
      const names = variantTrimNames(v.to);
      const listed = storedTrimList(stored, variantRefs[index]!.path);
      if (!listed ? names.length > 0 : names.some((t) => !listed.includes(t))) throw new Error(`transaction variants name trims missing from the stored trims ${variantRefs[index]!.path}`);
    }
    current.forEach((snapshot, index) => {
      if (!snapshot.exists || !matchesFrom(snapshot.data()?.[targets[index]!.field], targets[index]!.item.from)) {
        throw new Error(`transaction precondition changed ${snapshot.ref.path}`);
      }
      const { kind, item, field, ref } = targets[index]!;
      const aliasField = ALIAS_FIELD[kind];
      if (kind === 'masterTitle' && snapshot.data()?.[field] !== snapshots[index]!.data()?.[field]) {
        throw new Error(`transaction stored spelling changed since backup ${ref.path}.${field}`);
      }
      if (!aliasField) return;
      const aliasValue = snapshot.data()?.[aliasField];
      if (!aliasListOk(aliasValue)) throw new Error(`transaction alias field is not a list of strings ${ref.path}.${aliasField}`);
      // The stored spelling is kept too when it differs from the normalized old name (e.g. stray or full-width spaces).
      const raw = snapshot.data()?.[field];
      // The stored spelling must still be the one read before the backup (the backup and the readback rely on it).
      if (raw !== snapshots[index]!.data()?.[field]) throw new Error(`transaction stored spelling changed since backup ${ref.path}.${field}`);
      const entry = byPath[ref.path]!;
      if (typeof raw === 'string' && clean(raw) && raw !== clean(item.from) && !(entry.aliases[aliasField] ?? []).includes(raw)) {
        entry.aliases[aliasField] = [...(entry.aliases[aliasField] ?? []), raw];
      }
    });
    for (const { ref, fields, aliases } of Object.values(byPath)) {
      transaction.update(ref, {
        ...fields,
        ...(variantsByPath[ref.path] ? { variants: variantsByPath[ref.path] } : {}),
        ...(masterTrimsByPath[ref.path] ? { trims: masterTrimsByPath[ref.path] } : {}),
        ...(retireByPath[ref.path] ? { retired: true, retired_into: retireByPath[ref.path], retired_at: FieldValue.serverTimestamp() } : {}),
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
      // Aliases present before the repair must still be there (also for a blank fill); a non-blank old name must be added.
      const aliases: unknown[] = Array.isArray(data?.[aliasField]) ? data[aliasField] : [];
      const before = snapshots[index]!.data()?.[aliasField];
      const kept = Array.isArray(before) ? before.every((a: unknown) => aliases.includes(a)) : before === undefined || before === null;
      const raw = snapshots[index]!.data()?.[field];
      const rawKept = typeof raw !== 'string' || !clean(raw) || raw === clean(item.from) || aliases.includes(raw);
      if ((clean(item.from) && !aliases.map(clean).includes(clean(item.from))) || !kept || !rawKept) throw new Error(`readback alias mismatch ${snapshot.ref.path}`);
    }
  });
  const identityReadback = identityRefs.length ? await db.getAll(...identityRefs) : [];
  identityReadback.forEach((snapshot, index) => {
    const want = productIdentityToObject(identityTargets[index]!.item);
    const data = snapshot.data();
    if (!snapshot.exists || PRODUCT_IDENTITY_FIELDS.some((field) => clean(data?.[field]) !== want[field])) throw new Error(`readback productIdentity mismatch ${snapshot.ref.path}`);
  });
  const retireReadback = retireRefs.length ? await db.getAll(...retireRefs) : [];
  retireReadback.forEach((snapshot, index) => {
    if (snapshot.data()?.retired !== true || snapshot.data()?.retired_into !== retires[index]!.into) throw new Error(`readback retire mismatch ${snapshot.ref.path}`);
  });
  const variantReadback = variantRefs.length ? await db.getAll(...variantRefs) : [];
  variantReadback.forEach((snapshot, index) => {
    if (stableDigest(snapshot.data()?.variants ?? null) !== stableDigest(variantRepairs[index]!.to)) throw new Error(`readback variants mismatch ${snapshot.ref.path}`);
    if (variantRepairs[index]!.trims && stableDigest(snapshot.data()?.trims ?? null) !== stableDigest(variantRepairs[index]!.trims)) throw new Error(`readback trims mismatch ${snapshot.ref.path}`);
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
  return { runId, backupPath, ...counts, readbackCount: readback.length + identityReadback.length + createReadback.length + variantReadback.length + retireReadback.length, auditCount: auditReadback.length };
}
