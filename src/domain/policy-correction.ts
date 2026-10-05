import { stableDigest } from '../shared/stable-digest.js';

export type PolicyCorrectionLayer = 'supplierCondition' | 'salesPolicy';
export type PolicyCorrectionEvidenceSource = '공급사답' | '운영정책' | '대표결정';
export type PolicyCorrectionValue = string | number;
export type PolicyCorrectionEvidence = {
  source: PolicyCorrectionEvidenceSource;
  location: string;
  effectiveDate: string;
  answerSha256?: string;
};
export type PolicyCorrectionItem = {
  policyCode: string;
  supplierCode: string;
  field: string;
  layer: PolicyCorrectionLayer;
  from: string | number | null;
  to: PolicyCorrectionValue;
  evidence: PolicyCorrectionEvidence;
};
export type PolicyCorrectionPlan = {
  planId: string;
  createdAt: string;
  items: PolicyCorrectionItem[];
};
export type StoredPolicyDocument = {
  id?: string;
  data: Record<string, unknown>;
};
export type PolicyCorrectionValidationContext = {
  documents?: Record<string, StoredPolicyDocument>;
};

export const MAX_POLICY_CORRECTION_ITEMS = 500;
const EVIDENCE_SOURCES = new Set<PolicyCorrectionEvidenceSource>(['공급사답', '운영정책', '대표결정']);
const YES_NO_DISCUSS = /^(가능|불가|협의)$/;
const MONEY_TEXT = /^(?:\d{1,3}(?:,\d{3})*|\d+)(?:원|만원|억원)$|^(?:대여료의\s*)?\d+%$|^(불가|협의|무료|없음|무한|차량가액)$/;
const MONEY_LIMIT = /^(무한|차량가액|없음|(?:\d{1,3}(?:,\d{3})*|\d+)(?:억원|만원))$/;
const TEXT_MAX = 500;
const TEXT_FIELDS = new Set(['screening_criteria', 'rental_region', 'delivery_fee', 'personal_driver_scope', 'business_driver_scope', 'replacement_car_policy']);

type Rule = { kind: string; validate: (value: PolicyCorrectionValue) => boolean };
const rule = (kind: string, validate: (value: PolicyCorrectionValue) => boolean): Rule => ({ kind, validate });
const str = (value: PolicyCorrectionValue) => typeof value === 'string';
const matches = (re: RegExp) => (value: PolicyCorrectionValue) => str(value) && re.test(value);
const positiveNumber = (value: PolicyCorrectionValue) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = (value: PolicyCorrectionValue) => str(value) && value.trim() === value && value.length > 0 && value.length <= TEXT_MAX;

const amount = rule('amount', (v) => matches(MONEY_TEXT)(v) || positiveNumber(v));
const yn = rule('yes-no-discuss', matches(YES_NO_DISCUSS));
const textRule = rule('text', text);

export const ALLOWED_FIELDS: Record<string, Rule> = {
  screening_criteria: textRule,
  insurance_included: yn,
  maintenance_service: yn,
  additional_driver_allowance_count: rule('count', matches(/^\d+인까지$/)),
  additional_driver_cost: amount,
  deposit_installment: rule('installment', matches(/^(불가|가능|협의|\d+회까지)$/)),
  succession_allowed: yn,
  succession_fee: amount,
  annual_mileage: rule('annual-mileage', matches(/^연 \d{1,3}(?:,\d{3})*km$/)),
  mileage_upcharge_per_10000km: amount,
  over_mileage_rate_domestic: amount,
  over_mileage_rate_imported: amount,
  basic_driver_age: rule('age-lower', matches(/^만 \d+세 이상$/)),
  driver_age_lowering: rule('age-lowering', matches(/^(불가|협의|만 \d+세까지)$/)),
  age_lowering_cost: amount,
  age_21_cost: amount,
  age_23_cost: amount,
  driver_age_upper_limit: rule('age-upper', matches(/^만 \d+세 이하$/)),
  license_period: rule('license-period', matches(/^(제한없음|\d+년 이상)$/)),
  personal_driver_scope: textRule,
  business_driver_scope: textRule,
  deposit_card_payment: yn,
  deposit_return_days: rule('days', matches(/^\d+일$/)),
  delivery_fee: textRule,
  injury_compensation_limit: rule('limit', matches(MONEY_LIMIT)),
  injury_deductible: amount,
  property_compensation_limit: rule('limit', matches(MONEY_LIMIT)),
  property_deductible: amount,
  self_body_accident: rule('limit', matches(MONEY_LIMIT)),
  self_body_deductible: amount,
  uninsured_damage: rule('limit', matches(MONEY_LIMIT)),
  uninsured_deductible: amount,
  own_damage_compensation: rule('limit', matches(MONEY_LIMIT)),
  own_damage_repair_ratio: rule('ratio', matches(/^\d+%$/)),
  own_damage_min_deductible: amount,
  own_damage_max_deductible: amount,
  annual_roadside_assistance: rule('count', matches(/^\d+회$/)),
  replacement_car_policy: textRule,
  rental_region: textRule,
  early_termination_rate_under1y: rule('ratio', matches(/^\d+%$/)),
  early_termination_rate_over1y: rule('ratio', matches(/^\d+%$/)),
  accident_termination_count: rule('count', matches(/^\d+회$/)),
  engine_control_overdue_days: rule('days', matches(/^\d+일$/)),
};

for (const field of TEXT_FIELDS) ALLOWED_FIELDS[field] = textRule;

export const policyCorrectionItemDigest = (item: PolicyCorrectionItem) => stableDigest(item);
const present = (value: unknown) => value !== undefined && value !== null && value !== '';
const exactSame = (a: unknown, b: unknown) => a === b;
const isoDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const isoDateTime = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const dateOnly = (value: unknown): string | null => {
  // updated_at / created_at arrive as ISO strings, epoch milliseconds, Date or Firestore Timestamp depending on the writer.
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString().slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const ts = value as { toDate?: () => Date } | null;
  if (ts && typeof ts === 'object' && typeof ts.toDate === 'function') return dateOnly(ts.toDate());
  return isoDateTime(value) ? String(value).slice(0, 10) : null;
};
// A «map» is a plain object only — Date, Firestore Timestamp / GeoPoint / DocumentReference, arrays and class instances are not maps.
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const objectValue = (value: unknown): Record<string, unknown> | undefined => (isPlainObject(value) ? value : undefined);
// salesPolicy entries are stored as { value, …evidence }; compare the plain values, never the wrapper objects.
const layerMap = (data: Record<string, unknown>, layer: PolicyCorrectionLayer): Record<string, unknown> =>
  layer === 'salesPolicy'
    ? Object.fromEntries(Object.entries(objectValue(data.sales_policy) ?? {}).map(([field, entry]) => [field, objectValue(entry)?.value]))
    : data;
const storedEvidence = (data: Record<string, unknown>, layer: PolicyCorrectionLayer, field: string): Record<string, unknown> | undefined =>
  layer === 'salesPolicy' ? objectValue(objectValue(data.sales_policy)?.[field]) : objectValue(objectValue(data.field_evidence)?.[field]);
/** The stored layer container / entry must have the shape this corrector writes (a map, entries as maps with a «value»).
 * Anything else (string, number, array …) is refused — never read as «absent», so «from: null» cannot overwrite it. */
// A stored sales_policy «value» is a scalar: string, finite number, boolean or null — arrays/objects would slip past the contradiction check.
const scalarValue = (v: unknown) => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
export const assertStoredShape = (policyCode: string, data: Record<string, unknown>, layer: PolicyCorrectionLayer, field: string) => {
  const container = layer === 'salesPolicy' ? data.sales_policy : data.field_evidence;
  const label = layer === 'salesPolicy' ? 'sales_policy' : 'field_evidence';
  if (container !== undefined && container !== null && !objectValue(container)) throw new Error(`STORED_SHAPE_MISMATCH ${policyCode}.${label}`);
  const entry = objectValue(container)?.[field];
  if (entry === undefined || entry === null) return;
  const entryMap = objectValue(entry);
  if (!entryMap || (layer === 'salesPolicy' && (!('value' in entryMap) || !scalarValue(entryMap.value)))) throw new Error(`STORED_SHAPE_MISMATCH ${policyCode}.${label}.${field}`);
};
/** Whole-document shape check: EVERY entry of sales_policy and field_evidence must be a plain map (sales entries with a «value»).
 * A malformed sibling must not be silently read as «absent» by the contradiction check — the whole policy is refused. */
export const assertAllStoredShapes = (policyCode: string, data: Record<string, unknown>) => {
  for (const [layer, label] of [['salesPolicy', 'sales_policy'], ['supplierCondition', 'field_evidence']] as const) {
    const container = layer === 'salesPolicy' ? data.sales_policy : data.field_evidence;
    if (container === undefined || container === null) continue;
    if (!isPlainObject(container)) throw new Error(`STORED_SHAPE_MISMATCH ${policyCode}.${label}`);
    for (const [field, entry] of Object.entries(container)) {
      if (entry === undefined || entry === null) continue;
      if (!isPlainObject(entry) || (layer === 'salesPolicy' && (!('value' in entry) || !scalarValue(entry.value)))) throw new Error(`STORED_SHAPE_MISMATCH ${policyCode}.${label}.${field}`);
    }
  }
};
export const storedPolicyValue = (data: Record<string, unknown>, layer: PolicyCorrectionLayer, field: string): unknown => {
  if (layer === 'salesPolicy') return objectValue(objectValue(data.sales_policy)?.[field])?.value;
  return data[field];
};
const lastEvidenceDate = (data: Record<string, unknown>, layer: PolicyCorrectionLayer, field: string): string | null => {
  const evidenceDate = storedEvidence(data, layer, field)?.effectiveDate;
  if (isoDate(evidenceDate)) return String(evidenceDate);
  return dateOnly(data.updated_at) ?? dateOnly(data.created_at);
};
const toWon = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const m = value.replace(/,/g, '').match(/^(\d+)(억원|만원|원)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === '억원') return n * 100000000;
  if (m[2] === '만원') return n * 10000;
  return n;
};
const finalLayerValues = (data: Record<string, unknown>, layer: PolicyCorrectionLayer, items: PolicyCorrectionItem[]) => ({
  ...layerMap(data, layer),
  ...Object.fromEntries(items.filter((item) => item.layer === layer).map((item) => [item.field, item.to])),
});
const requireNoContradictions = (policyCode: string, data: Record<string, unknown>, layer: PolicyCorrectionLayer, items: PolicyCorrectionItem[]) => {
  const touched = new Set(items.filter((item) => item.layer === layer).map((item) => item.field));
  const values = finalLayerValues(data, layer, items);
  if (['driver_age_lowering', 'age_lowering_cost', 'age_21_cost', 'age_23_cost'].some((f) => touched.has(f))
    && values.driver_age_lowering === '불가'
    && [values.age_lowering_cost, values.age_21_cost, values.age_23_cost].some((v) => present(v) && v !== '불가')) {
    throw new Error(`CONTRADICTION ${policyCode}.${layer}.driver_age_lowering`);
  }
  if (['succession_allowed', 'succession_fee'].some((f) => touched.has(f))
    && values.succession_allowed === '불가' && present(values.succession_fee) && values.succession_fee !== '불가') {
    throw new Error(`CONTRADICTION ${policyCode}.${layer}.succession`);
  }
  if (['own_damage_min_deductible', 'own_damage_max_deductible'].some((f) => touched.has(f))) {
    const min = toWon(values.own_damage_min_deductible);
    const max = toWon(values.own_damage_max_deductible);
    if (min !== null && max !== null && min > max) throw new Error(`CONTRADICTION ${policyCode}.${layer}.own_damage_deductible`);
  }
};

export function validatePolicyCorrectionPlan(plan: PolicyCorrectionPlan, context: PolicyCorrectionValidationContext = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('plan is required');
  if (typeof plan.planId !== 'string' || !plan.planId.trim()) throw new Error('planId is required');
  if (!isoDateTime(plan.createdAt)) throw new Error('createdAt must be ISO');
  if (!Array.isArray(plan.items) || plan.items.length === 0) throw new Error('items are required');
  if (plan.items.length > MAX_POLICY_CORRECTION_ITEMS) throw new Error(`MAX_ITEMS ${MAX_POLICY_CORRECTION_ITEMS}`);
  const byDoc: Record<string, PolicyCorrectionItem[]> = {};
  const seen = new Set<string>();
  plan.items.forEach((item, index) => {
    if (!item.policyCode?.trim() || !item.supplierCode?.trim()) throw new Error(`item ${index} needs policyCode and supplierCode`);
    if (!ALLOWED_FIELDS[item.field]) throw new Error(`FIELD_NOT_ALLOWED ${item.field}`);
    if (item.to === null || item.to === undefined || item.to === '') throw new Error(`EMPTY_TO ${item.policyCode}.${item.field}`);
    if (!ALLOWED_FIELDS[item.field]!.validate(item.to)) throw new Error(`INVALID_VALUE ${item.policyCode}.${item.field}`);
    if (item.layer !== 'supplierCondition' && item.layer !== 'salesPolicy') throw new Error(`INVALID_LAYER ${item.policyCode}.${item.field}`);
    if (!item.evidence || !EVIDENCE_SOURCES.has(item.evidence.source)) throw new Error(`INVALID_EVIDENCE_SOURCE ${item.policyCode}.${item.field}`);
    if (!item.evidence.location?.trim()) throw new Error(`EVIDENCE_LOCATION_REQUIRED ${item.policyCode}.${item.field}`);
    if (!isoDate(item.evidence.effectiveDate)) throw new Error(`INVALID_EFFECTIVE_DATE ${item.policyCode}.${item.field}`);
    if (item.evidence.answerSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(item.evidence.answerSha256)) throw new Error(`INVALID_ANSWER_SHA256 ${item.policyCode}.${item.field}`);
    const key = `${item.policyCode}|${item.layer}|${item.field}`;
    if (seen.has(key)) throw new Error(`DUPLICATE_ITEM ${item.policyCode}.${item.layer}.${item.field}`);
    seen.add(key);
    (byDoc[item.policyCode] ??= []).push(item);
  });
  for (const [policyCode, items] of Object.entries(byDoc)) {
    const doc = context.documents?.[policyCode];
    if (!doc) continue;
    const data = doc.data;
    if (!data.provider_company_code) throw new Error(`SUPPLIER_CODE_MISSING ${policyCode}`);
    assertAllStoredShapes(policyCode, data);
    for (const item of items) {
      if (data.provider_company_code !== item.supplierCode) throw new Error(`SUPPLIER_MISMATCH ${policyCode}`);
      assertStoredShape(policyCode, data, item.layer, item.field);
      const current = storedPolicyValue(data, item.layer, item.field);
      if (!exactSame(current === undefined ? null : current, item.from)) throw new Error(`CONFLICT ${policyCode}.${item.field}`);
      const lastDate = lastEvidenceDate(data, item.layer, item.field);
      if (lastDate !== null && item.evidence.effectiveDate <= lastDate) throw new Error(`STALE_EVIDENCE ${policyCode}.${item.field}`);
    }
    requireNoContradictions(policyCode, data, 'supplierCondition', items);
    requireNoContradictions(policyCode, data, 'salesPolicy', items);
  }
  return { itemCount: plan.items.length, policyCount: Object.keys(byDoc).length, planDigest: stableDigest(plan) };
}
