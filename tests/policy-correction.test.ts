import { describe, expect, it } from 'vitest';
import { isPlainObject, validatePolicyCorrectionPlan, type PolicyCorrectionPlan } from '../src/domain/policy-correction.js';

const item = (over: Partial<PolicyCorrectionPlan['items'][number]> = {}): PolicyCorrectionPlan['items'][number] => ({
  policyCode: 'POL-0023',
  supplierCode: 'RP000',
  field: 'driver_age_lowering',
  layer: 'supplierCondition',
  from: '협의',
  to: '불가',
  evidence: { source: '공급사답', location: '문의건 1', effectiveDate: '2026-10-05' },
  ...over,
});
const plan = (items: PolicyCorrectionPlan['items'] = [item()]): PolicyCorrectionPlan => ({
  planId: 'p1',
  createdAt: '2026-10-05T00:00:00.000Z',
  items,
});
const docs = (data: Record<string, unknown>) => ({ 'POL-0023': { data: { provider_company_code: 'RP000', updated_at: '2026-10-04T00:00:00.000Z', ...data } } });

describe('policy correction domain validation', () => {
  it('accepts a valid correction and returns counts plus digest', () => {
    expect(validatePolicyCorrectionPlan(plan(), { documents: docs({ driver_age_lowering: '협의' }) })).toMatchObject({ itemCount: 1, policyCount: 1 });
  });
  it('rejects unknown fields, empty to, old source, and empty location', () => {
    expect(() => validatePolicyCorrectionPlan(plan([item({ field: 'unknown' })]))).toThrow(/FIELD_NOT_ALLOWED/);
    expect(() => validatePolicyCorrectionPlan(plan([item({ to: '' })]))).toThrow(/EMPTY_TO/);
    expect(() => validatePolicyCorrectionPlan(plan([item({ evidence: { source: '옛입력' as never, location: 'x', effectiveDate: '2026-10-05' } })]))).toThrow(/INVALID_EVIDENCE_SOURCE/);
    expect(() => validatePolicyCorrectionPlan(plan([item({ evidence: { source: '공급사답', location: ' ', effectiveDate: '2026-10-05' } })]))).toThrow(/EVIDENCE_LOCATION_REQUIRED/);
  });
  it('keeps 0 and text states distinct', () => {
    expect(validatePolicyCorrectionPlan(plan([item({ field: 'over_mileage_rate_domestic', from: 100, to: 0 })]))).toMatchObject({ itemCount: 1 });
    expect(() => validatePolicyCorrectionPlan(plan([item({ field: 'over_mileage_rate_domestic', from: '없음', to: '' })]))).toThrow(/EMPTY_TO/);
  });
  it('rejects supplier-layer age lowering contradictions but keeps salesPolicy separate', () => {
    expect(() => validatePolicyCorrectionPlan(plan([item({ field: 'driver_age_lowering', from: '협의', to: '불가' })]),
      { documents: docs({ driver_age_lowering: '협의', age_21_cost: '10만원' }) })).toThrow(/CONTRADICTION/);
    expect(validatePolicyCorrectionPlan(plan([item({ field: 'driver_age_lowering', layer: 'salesPolicy', from: '협의', to: '불가' })]),
      { documents: docs({ driver_age_lowering: '협의', age_21_cost: '10만원', sales_policy: { driver_age_lowering: { value: '협의' } } }) })).toMatchObject({ itemCount: 1 });
  });
  it('rejects stale evidence, succession contradiction, deductible min greater than max, supplier mismatch, and too many items', () => {
    expect(() => validatePolicyCorrectionPlan(plan(), { documents: docs({ driver_age_lowering: '협의', field_evidence: { driver_age_lowering: { effectiveDate: '2026-10-05' } } }) })).toThrow(/STALE_EVIDENCE/);
    expect(() => validatePolicyCorrectionPlan(plan([item({ field: 'succession_allowed', from: '가능', to: '불가' })]), { documents: docs({ succession_allowed: '가능', succession_fee: '10만원' }) })).toThrow(/CONTRADICTION/);
    expect(() => validatePolicyCorrectionPlan(plan([item({ field: 'own_damage_min_deductible', from: '50만원', to: '100만원' })]), { documents: docs({ own_damage_min_deductible: '50만원', own_damage_max_deductible: '50만원' }) })).toThrow(/CONTRADICTION/);
    expect(() => validatePolicyCorrectionPlan(plan(), { documents: { 'POL-0023': { data: { provider_company_code: 'RP999', driver_age_lowering: '협의' } } } })).toThrow(/SUPPLIER_MISMATCH/);
    expect(() => validatePolicyCorrectionPlan(plan(Array.from({ length: 501 }, (_, i) => item({ policyCode: `P${i}` }))))).toThrow(/MAX_ITEMS/);
  });
  it('rejects duplicate items for the same policy, layer and field', () => {
    expect(() => validatePolicyCorrectionPlan(plan([item(), item({ to: '협의' })]))).toThrow(/DUPLICATE_ITEM/);
  });
  it('reads updated_at given as epoch milliseconds and refuses evidence not newer than it', () => {
    const at = Date.parse('2026-10-05T12:00:00Z');
    expect(() => validatePolicyCorrectionPlan(plan(), { documents: docs({ driver_age_lowering: '협의', updated_at: at }) })).toThrow(/STALE_EVIDENCE/);
    expect(validatePolicyCorrectionPlan(plan(), { documents: docs({ driver_age_lowering: '협의', updated_at: Date.parse('2026-10-01T00:00:00Z') }) })).toMatchObject({ itemCount: 1 });
  });
  it('checks salesPolicy contradictions on unwrapped values', () => {
    const base = { driver_age_lowering: '협의', sales_policy: { driver_age_lowering: { value: '불가' } } };
    expect(() => validatePolicyCorrectionPlan(plan([item({ field: 'age_21_cost', layer: 'salesPolicy', from: null, to: '10만원' })]),
      { documents: docs(base) })).toThrow(/CONTRADICTION/);
    expect(validatePolicyCorrectionPlan(plan([item({ field: 'age_21_cost', layer: 'salesPolicy', from: null, to: '불가' })]),
      { documents: docs(base) })).toMatchObject({ itemCount: 1 });
  });
  it('refuses stored values whose shape is not what the corrector writes (never read as absent)', () => {
    const sales = (field: string) => item({ field, layer: 'salesPolicy', from: null, to: '불가' });
    const run = (stored: Record<string, unknown>, it = sales('age_21_cost')) => () => validatePolicyCorrectionPlan(plan([it]), { documents: docs(stored) });
    expect(run({ sales_policy: { age_21_cost: '협의' } })).toThrow(/STORED_SHAPE_MISMATCH/);
    expect(run({ sales_policy: { age_21_cost: 7 } })).toThrow(/STORED_SHAPE_MISMATCH/);
    expect(run({ sales_policy: { age_21_cost: ['협의'] } })).toThrow(/STORED_SHAPE_MISMATCH/);
    expect(run({ sales_policy: { age_21_cost: { source: '대표결정' } } })).toThrow(/STORED_SHAPE_MISMATCH/);
    expect(run({ sales_policy: '협의' })).toThrow(/STORED_SHAPE_MISMATCH/);
    expect(run({ sales_policy: ['x'] })).toThrow(/STORED_SHAPE_MISMATCH/);
    expect(run({ driver_age_lowering: '협의', field_evidence: { driver_age_lowering: '협의' } }, item())).toThrow(/STORED_SHAPE_MISMATCH/);
    expect(run({ field_evidence: 3 }, item())).toThrow(/STORED_SHAPE_MISMATCH/);
    // a well-formed entry keeps its original stored value for the from check
    expect(run({ sales_policy: { age_21_cost: { value: '협의', effectiveDate: '2026-10-01' } } }, item({ field: 'age_21_cost', layer: 'salesPolicy', from: '협의', to: '불가' }))).not.toThrow();
    expect(run({ sales_policy: { age_21_cost: { value: '협의', effectiveDate: '2026-10-01' } } })).toThrow(/CONFLICT/);
  });
  it('does not accept Date, Timestamp-like or class instances as stored maps (plain objects only)', () => {
    class FakeTimestamp { seconds = 1; nanoseconds = 0; toDate() { return new Date(0); } }
    const salesItem = item({ field: 'age_21_cost', layer: 'salesPolicy', from: null, to: '불가' });
    for (const bad of [new Date('2026-10-01'), new FakeTimestamp(), Object.create({ inherited: true })]) {
      expect(() => validatePolicyCorrectionPlan(plan([salesItem]), { documents: docs({ sales_policy: { age_21_cost: bad } }) })).toThrow(/STORED_SHAPE_MISMATCH/);
      expect(() => validatePolicyCorrectionPlan(plan([salesItem]), { documents: docs({ sales_policy: bad }) })).toThrow(/STORED_SHAPE_MISMATCH/);
      expect(() => validatePolicyCorrectionPlan(plan([item()]), { documents: docs({ driver_age_lowering: '협의', field_evidence: { driver_age_lowering: bad } }) })).toThrow(/STORED_SHAPE_MISMATCH/);
    }
    expect(isPlainObject(Object.create(null))).toBe(true);
  });
  it('refuses the whole policy when ANY sales_policy / field_evidence entry is malformed, even a sibling of the corrected field', () => {
    const salesItem = item({ field: 'age_21_cost', layer: 'salesPolicy', from: null, to: '10만원' });
    // sibling driver_age_lowering stored as the bare string '불가' (not a map): must not be dropped before the contradiction check
    expect(() => validatePolicyCorrectionPlan(plan([salesItem]), { documents: docs({ sales_policy: { driver_age_lowering: '불가' } }) })).toThrow(/STORED_SHAPE_MISMATCH/);
    expect(() => validatePolicyCorrectionPlan(plan([salesItem]), { documents: docs({ sales_policy: { driver_age_lowering: { note: 'no value' } } }) })).toThrow(/STORED_SHAPE_MISMATCH/);
    expect(() => validatePolicyCorrectionPlan(plan([item()]), { documents: docs({ driver_age_lowering: '협의', field_evidence: { age_21_cost: 'x' } }) })).toThrow(/STORED_SHAPE_MISMATCH/);
    // well-formed siblings still feed the contradiction check with their real stored values
    expect(() => validatePolicyCorrectionPlan(plan([salesItem]), { documents: docs({ sales_policy: { driver_age_lowering: { value: '불가' } } }) })).toThrow(/CONTRADICTION/);
  });
  it('refuses non-scalar sales_policy values (array / object / NaN) so they cannot bypass the contradiction check', () => {
    const salesItem = item({ field: 'age_21_cost', layer: 'salesPolicy', from: null, to: '10만원' });
    for (const bad of [['불가'], { x: 1 }, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validatePolicyCorrectionPlan(plan([salesItem]), { documents: docs({ sales_policy: { driver_age_lowering: { value: bad } } }) })).toThrow(/STORED_SHAPE_MISMATCH/);
    }
    expect(() => validatePolicyCorrectionPlan(plan([salesItem]), { documents: docs({ sales_policy: { driver_age_lowering: { value: null } } }) })).not.toThrow();
  });
});
