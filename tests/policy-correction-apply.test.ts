import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stableDigest } from '../src/shared/stable-digest.js';
import type { PolicyCorrectionPlan } from '../src/domain/policy-correction.js';

const store = new Map<string, Record<string, unknown>>();
const writes: string[] = [];
type Ref = { path: string; id: string; parent: { id: string } };
const ref = (collection: string, id = `id-${Math.random().toString(16).slice(2)}`): Ref => ({ path: `${collection}/${id}`, id, parent: { id: collection } });
const snap = (r: Ref) => {
  const data = store.get(r.path);
  return { ref: r, id: r.id, exists: data !== undefined, updateTime: { toMillis: () => Number(data?._updateTime ?? 0) }, data: () => data === undefined ? undefined : structuredClone(data) };
};
const setDoc = (path: string, data: Record<string, unknown>) => store.set(path, { ...data, _updateTime: data._updateTime ?? 1 });
const db = {
  collection: (c: string) => ({ doc: (id?: string) => ref(c, id) }),
  getAll: async (...refs: Ref[]) => refs.map(snap),
  runTransaction: async (fn: (t: unknown) => Promise<void>) => {
    const pending: Array<() => void> = [];
    const t = {
      getAll: async (...refs: Ref[]) => refs.map(snap),
      update: (r: Ref, u: Record<string, unknown>) => pending.push(() => {
        writes.push(r.path);
        store.set(r.path, { ...store.get(r.path), ...structuredClone(u), _updateTime: Number(store.get(r.path)?._updateTime ?? 1) + 1 });
      }),
      create: (r: Ref, d: Record<string, unknown>) => pending.push(() => {
        if (store.has(r.path)) throw new Error('ALREADY_EXISTS');
        writes.push(r.path);
        store.set(r.path, structuredClone(d));
      }),
    };
    await fn(t);
    pending.forEach((write) => write());
  },
};
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => db, FieldValue: { serverTimestamp: () => 'ts' } }));
vi.mock('../src/infra/firebase-target.js', () => ({ getTargetFirebaseApp: () => ({}) }));
const backups: string[] = [];
vi.mock('node:fs/promises', () => ({ mkdir: async () => undefined, writeFile: async (path: string) => { backups.push(path); } }));

const { applyPolicyCorrection } = await import('../src/infra/policy-correction-firestore.js');
const baseItem = {
  policyCode: 'POL-0023',
  supplierCode: 'RP000',
  field: 'driver_age_lowering',
  layer: 'supplierCondition' as const,
  from: '협의',
  to: '불가',
  evidence: { source: '공급사답' as const, location: '문의건 1', effectiveDate: '2026-10-05' },
};
const plan = (items: PolicyCorrectionPlan['items'] = [baseItem]): PolicyCorrectionPlan => ({ planId: 'p1', createdAt: '2026-10-05T00:00:00.000Z', items });
const sourceEvidence = { source: '대표결정' as const, location: '계약 원본 AB91/Q95/AB96/U110', effectiveDate: '2026-10-05',
  answerSha256: 'a'.repeat(64), applicability: '원본의 일반 자차 및 중과실 사고 적용 대상' };
const clearRatio = (): PolicyCorrectionPlan['items'][number] => ({
  policyCode: baseItem.policyCode, supplierCode: baseItem.supplierCode, layer: 'supplierCondition',
  field: 'own_damage_repair_ratio', operation: 'clear', from: '20%', evidence: sourceEvidence,
});

beforeEach(() => {
  store.clear();
  writes.length = 0;
  backups.length = 0;
  setDoc('policy/POL-0023', { provider_company_code: 'RP000', updated_at: '2026-10-04T00:00:00.000Z', driver_age_lowering: '협의' });
});

describe('source contract apply and readback', () => {
  it('marks the ordinary ratio explicitly blank, preserves separate clauses and writes scoped evidence', async () => {
    setDoc('policy/POL-0023', { provider_company_code: 'RP000', updated_at: '2026-10-04', own_damage_repair_ratio: '20%',
      own_damage_min_deductible: '100만원', own_damage_max_deductible: '100만원', unrelated: 'preserve' });
    const original = '\n중과실 자차사고 (수리금액의 20% 추가납부)\n수리비용의 20% 우선 적용\n동급 차량으로 계약은 유지하며,\n';
    const result = await applyPolicyCorrection(plan([
      clearRatio(),
      { ...baseItem, field: 'own_damage_min_deductible', from: '100만원', to: '50만원', evidence: sourceEvidence },
      { ...baseItem, field: 'policy_extra_terms', from: null, to: original, evidence: sourceEvidence },
    ]));
    const after = store.get('policy/POL-0023')!;
    expect(Object.hasOwn(after, 'own_damage_repair_ratio')).toBe(true);
    expect(after.own_damage_repair_ratio).toBeNull();
    expect(after).toMatchObject({ own_damage_min_deductible: '50만원', own_damage_max_deductible: '100만원', unrelated: 'preserve', policy_extra_terms: original,
      field_evidence: { own_damage_repair_ratio: { operation: 'clear', value: null, ...sourceEvidence } } });
    const audit = [...store.entries()].find(([path, data]) => path.startsWith('audit_events/') && (data.after as Record<string, unknown>).operation === 'clear')![1];
    expect(audit).toMatchObject({ before: { own_damage_repair_ratio: '20%' }, after: { operation: 'clear', own_damage_repair_ratio: null } });
    expect(result).toMatchObject({ writtenItemCount: 3, readbackCount: 3, auditCount: 3 });
    writes.length = 0;
    expect(await applyPolicyCorrection(plan([
      clearRatio(),
      { ...baseItem, field: 'own_damage_min_deductible', from: '100만원', to: '50만원', evidence: sourceEvidence },
      { ...baseItem, field: 'policy_extra_terms', from: null, to: original, evidence: sourceEvidence },
    ]))).toMatchObject({ writtenItemCount: 0, skippedAlreadyApplied: 3 });
    expect(writes).toHaveLength(0);
  });
  it('refuses a rerun whose supplier binding changed even if item digests still match', async () => {
    await applyPolicyCorrection(plan());
    store.set('policy/POL-0023', { ...store.get('policy/POL-0023'), provider_company_code: 'RP999' });
    writes.length = 0;
    await expect(applyPolicyCorrection(plan())).rejects.toThrow(/SUPPLIER_MISMATCH/);
    expect(writes).toHaveLength(0);
  });
  it.each(['empty', 'missing'])('refuses an explicit-blank readback that comes back as %s', async (state) => {
    setDoc('policy/POL-0023', { provider_company_code: 'RP000', updated_at: '2026-10-04', own_damage_repair_ratio: '20%' });
    const original = db.runTransaction;
    db.runTransaction = async (fn) => {
      await original(fn);
      const changed = { ...store.get('policy/POL-0023'), own_damage_repair_ratio: '' } as Record<string, unknown>;
      if (state === 'missing') delete changed.own_damage_repair_ratio;
      store.set('policy/POL-0023', changed);
    };
    try { await expect(applyPolicyCorrection(plan([clearRatio()]))).rejects.toThrow(/readback mismatch/); }
    finally { db.runTransaction = original; }
  });
  it('does not treat altered source applicability as an already-applied clear', async () => {
    setDoc('policy/POL-0023', { provider_company_code: 'RP000', updated_at: '2026-10-04', own_damage_repair_ratio: '20%' });
    await applyPolicyCorrection(plan([clearRatio()]));
    const after = store.get('policy/POL-0023')!;
    const evidence = after.field_evidence as Record<string, Record<string, unknown>>;
    evidence.own_damage_repair_ratio!.applicability = 'different scope';
    writes.length = 0;
    await expect(applyPolicyCorrection(plan([clearRatio()]))).rejects.toThrow(/CONFLICT/);
    expect(writes).toHaveLength(0);
  });
});

describe('policy correction Firestore apply path', () => {
  it('applies supplierCondition value, evidence, backup, readback, and audit', async () => {
    const result = await applyPolicyCorrection(plan());
    expect(store.get('policy/POL-0023')).toMatchObject({
      driver_age_lowering: '불가',
      policy_field_owner: 'policy-corrector',
      policy_correction_last: 'p1',
      field_evidence: { driver_age_lowering: { writer: 'policy-corrector', itemDigest: stableDigest(baseItem), value: '불가' } },
    });
    expect(backups).toHaveLength(1);
    expect([...store.keys()].filter((k) => k.startsWith('audit_events/'))).toHaveLength(1);
    expect(result).toMatchObject({ writtenItemCount: 1, skippedAlreadyApplied: 0, auditCount: 1 });
  });
  it('aborts all writes on from conflict', async () => {
    await expect(applyPolicyCorrection(plan([{ ...baseItem, from: '불가' }]))).rejects.toThrow(/CONFLICT/);
    expect(writes).toHaveLength(0);
    expect(store.get('policy/POL-0023')!.driver_age_lowering).toBe('협의');
  });
  it('skips already applied reruns with zero writes', async () => {
    await applyPolicyCorrection(plan());
    writes.length = 0;
    const second = await applyPolicyCorrection(plan());
    expect(second).toMatchObject({ skippedAlreadyApplied: 1, writtenItemCount: 0, auditCount: 0 });
    expect(writes).toHaveLength(0);
  });
  it('writes salesPolicy without changing supplier condition', async () => {
    setDoc('policy/POL-0023', { provider_company_code: 'RP000', updated_at: '2026-10-04T00:00:00.000Z', driver_age_lowering: '협의', sales_policy: { driver_age_lowering: { value: '협의' } } });
    await applyPolicyCorrection(plan([{ ...baseItem, layer: 'salesPolicy', from: '협의', to: '불가' }]));
    expect(store.get('policy/POL-0023')!.driver_age_lowering).toBe('협의');
    expect(store.get('policy/POL-0023')).toMatchObject({ sales_policy: { driver_age_lowering: { value: '불가', writer: 'policy-corrector' } } });
  });
  it('aborts when a value changes inside the transaction', async () => {
    const original = db.runTransaction;
    db.runTransaction = async (fn) => {
      store.set('policy/POL-0023', { ...store.get('policy/POL-0023')!, driver_age_lowering: '불가', _updateTime: 2 });
      return original(fn);
    };
    try {
      await expect(applyPolicyCorrection(plan())).rejects.toThrow(/transaction precondition changed|CONFLICT/);
    } finally {
      db.runTransaction = original;
    }
  });
});
