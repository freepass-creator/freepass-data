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

beforeEach(() => {
  store.clear();
  writes.length = 0;
  backups.length = 0;
  setDoc('policy/POL-0023', { provider_company_code: 'RP000', updated_at: '2026-10-04T00:00:00.000Z', driver_age_lowering: '협의' });
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
