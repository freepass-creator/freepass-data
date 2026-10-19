import { stableDigest } from '../shared/stable-digest.js';
import { SPEC_FORMAT_RULES } from './source-spec-validation.js';
import { canonicalFuel } from './fuel-alias.js';
import { specValueBlank, refillableSpecValues } from './spec-refill.js';
export type ReviewedSpecApproval = { uid: string; sourceId: string; correctionDigest: string; fields: string[] };
export type ReviewedSpec = { correctionDigest: string; values: Record<string, string> };
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** Reviewed archive bindings are explicit operational input, never inferred from a vehicle name. Default off. */
export function reviewedSpecApprovals(input: string | undefined): ReadonlyMap<string, ReviewedSpecApproval> {
  if (!input) return new Map();
  const rows: unknown = JSON.parse(input);
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('REVIEWED_SPEC_APPROVAL_INVALID');
  const out = new Map<string, ReviewedSpecApproval>();
  for (const row of rows) {
    const r = object(row);
    if (typeof r.uid !== 'string' || !/^\d{2,3}[가-힣]\d{4}$/.test(r.uid) || typeof r.sourceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.sourceId) ||
      typeof r.correctionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(r.correctionDigest) || out.has(r.uid) || !Array.isArray(r.fields) || !r.fields.length || r.fields.length > 4 || new Set(r.fields).size !== r.fields.length || r.fields.some(k => !['year','first_registration_date','fuel_type','engine_cc'].includes(String(k)))) throw new Error('REVIEWED_SPEC_APPROVAL_INVALID');
    out.set(r.uid, r as ReviewedSpecApproval);
  }
  return out;
}
/** Consume only an exact reviewed correction that is still retained verbatim in its existing history. */
export function reviewedSpecOf(uid: string, f: Record<string, unknown>, approval: ReviewedSpecApproval | undefined): ReviewedSpec | undefined {
  if (!approval || approval.uid !== uid || approval.sourceId !== f.provider_company_code || f.car_number !== uid) return;
  const correction = object(f.원문_정정), history = f.원문_정정_이력;
  if (stableDigest(correction) !== approval.correctionDigest || correction.출처 !== '지지오토 사양조회' ||
    typeof correction.key !== 'string' || !correction.key || typeof correction.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(correction.sourceDigest) ||
    typeof correction.조회일 !== 'string' || !Number.isFinite(Date.parse(correction.조회일)) ||
    !Array.isArray(history) || !history.some(v => stableDigest(v) === approval.correctionDigest)) return;
  const values: Record<string, string> = {};
  for (const [field, source] of [['year','연식'],['first_registration_date','최초등록'],['fuel_type','연료'],['engine_cc','배기량']] as const) {
    if (!approval.fields.includes(field) || !specValueBlank(f[field]) || typeof correction[source] !== 'string') continue;
    const raw = String(correction[source]).trim(), value = field === 'fuel_type' ? canonicalFuel(raw, correction.차명) : raw;
    if (value && SPEC_FORMAT_RULES[field]?.(value)) values[field] = value;
  }
  if (['전기','수소'].includes(String(f.fuel_type || values.fuel_type || ''))) delete values.engine_cc;
  return Object.keys(values).length ? { correctionDigest: approval.correctionDigest, values } : undefined;
}
/** A conflicting explicit source model year stays held. First registration never supplies model year. */
export function plannedReviewedSpec(value: ReviewedSpec | undefined, sourceSpec: unknown, vehicleText?: unknown): ReviewedSpec | undefined {
  if (!value) return;
  const values = { ...value.values }, source = object(sourceSpec);
  if (!specValueBlank(source.year) && String(source.year).trim() !== values.year) delete values.year;
  const eligible = Object.fromEntries(Object.entries(refillableSpecValues(values, Object.keys(values), vehicleText)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return Object.keys(eligible).length ? { correctionDigest: value.correctionDigest, values: eligible } : undefined;
}
