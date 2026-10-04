import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory Firestore stand-in: enough of getAll/runTransaction/update/create/FieldValue for the repair path.
const store = new Map<string, Record<string, unknown>>();
const UNION = Symbol('union');
type Ref = { path: string; id: string; parent: { id: string } };
const ref = (collection: string, id: string): Ref => ({ path: `${collection}/${id}`, id, parent: { id: collection } });
const snap = (r: Ref) => ({ ref: r, exists: store.has(r.path), data: () => (store.has(r.path) ? structuredClone(store.get(r.path)) : undefined) });
const applyUpdate = (path: string, update: Record<string, unknown>) => {
  const doc = { ...store.get(path)! };
  for (const [k, v] of Object.entries(update)) {
    if (v && typeof v === 'object' && UNION in v) {
      const prev = Array.isArray(doc[k]) ? (doc[k] as unknown[]) : [];
      doc[k] = [...prev, ...((v as never)[UNION] as unknown[]).filter((x) => !prev.includes(x))];
    } else doc[k] = v;
  }
  store.set(path, doc);
};
const db = {
  collection: (c: string) => ({ doc: (id: string) => ref(c, id) }),
  getAll: async (...refs: Ref[]) => refs.map(snap),
  runTransaction: async (fn: (t: unknown) => Promise<void>) => {
    const writes: Array<() => void> = [];
    const t = {
      getAll: async (...refs: Ref[]) => refs.map(snap),
      update: (r: Ref, u: Record<string, unknown>) => writes.push(() => applyUpdate(r.path, u)),
      create: (r: Ref, d: Record<string, unknown>) => writes.push(() => {
        if (store.has(r.path)) throw new Error('ALREADY_EXISTS');
        store.set(r.path, structuredClone(d));
      }),
    };
    await fn(t);
    writes.forEach((w) => w());
  },
};
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => db,
  FieldValue: { arrayUnion: (...v: unknown[]) => ({ [UNION]: v }), serverTimestamp: () => 'ts' },
}));
vi.mock('../src/infra/firebase-target.js', () => ({ getTargetFirebaseApp: () => ({}) }));
vi.mock('node:fs/promises', () => ({ mkdir: async () => undefined, writeFile: async () => undefined }));

const { applyVehicleNameReferenceRepair } = await import('../src/infra/vehicle-name-reference-repair-firestore.js');

beforeEach(() => {
  store.clear();
  store.set('vehicle_master/m-gn7', { id: 'm-gn7', sub_model: '그랜저 GN7' });
  store.set('vehicle_trim_master/t1', { sub_model: '그랜저 GN7', master_id: 'm-gn7', trim: '프리미엄', fuel: '하이브리드' });
  store.set('vehicle_trim_master/t2', { sub_model: '디 올 뉴 싼타페 MX5', master_id: 'm-mx5', trim: '익스클루시브', sub_model_aliases: ['싼타페 MX5 신형'] });
  store.set('vehicle_master/m-mx5', { id: 'm-mx5', sub_model: '디 올 뉴 싼타페 MX5' });
});

const hevMaster = { id: 'm-gn7-hev', data: { id: 'm-gn7-hev', maker: '현대', model: '그랜저', sub_model: '그랜저 하이브리드 GN7', origin: '국산', meta: { z: 1, a: 2 } }, evidence: '규칙 15·18' };

describe('vehicle-name repair apply path (in-memory Firestore)', () => {
  it('moves a hybrid row to a new sub-model master in one transaction and keeps the old name as an alias', async () => {
    const result = await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterCreates: [hevMaster],
      trimSubModelRepairs: [{ id: 't1', from: '그랜저 GN7', to: '그랜저 하이브리드 GN7' }],
      trimMasterLinkRepairs: [{ id: 't1', from: 'm-gn7', to: 'm-gn7-hev' }] });
    expect(store.get('vehicle_trim_master/t1')).toMatchObject({ sub_model: '그랜저 하이브리드 GN7', master_id: 'm-gn7-hev', sub_model_aliases: ['그랜저 GN7'] });
    // Nested maps are compared independent of key order on readback.
    expect(store.get('vehicle_master/m-gn7-hev')).toMatchObject({ sub_model: '그랜저 하이브리드 GN7' });
    expect(result.readbackCount).toBe(3);
    expect(result.auditCount).toBe(3);
    expect([...store.keys()].filter((k) => k.startsWith('audit_events/'))).toHaveLength(3);
  });
  it('renames a master and its rows, adding to (not replacing) existing aliases', async () => {
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', productRepairs: [],
      masterRepairs: [{ id: 'm-mx5', from: '디 올 뉴 싼타페 MX5', to: '싼타페 MX5' }],
      trimSubModelRepairs: [{ id: 't2', from: '디 올 뉴 싼타페 MX5', to: '싼타페 MX5' }] });
    expect(store.get('vehicle_master/m-mx5')).toMatchObject({ sub_model: '싼타페 MX5', sub_model_aliases: ['디 올 뉴 싼타페 MX5'] });
    expect(store.get('vehicle_trim_master/t2')!.sub_model_aliases).toEqual(['싼타페 MX5 신형', '디 올 뉴 싼타페 MX5']);
  });
  it('refuses to link a row to a master that does not exist', async () => {
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimMasterLinkRepairs: [{ id: 't1', from: 'm-gn7', to: 'm-missing' }] })).rejects.toThrow(/linked vehicle_master missing/);
    expect(store.get('vehicle_trim_master/t1')!.master_id).toBe('m-gn7');
  });
  it('aborts when the linked master disappears before commit (read inside the transaction)', async () => {
    const original = db.runTransaction;
    db.runTransaction = async (fn) => { store.delete('vehicle_master/m-gn7-hev'); return original(fn); };
    store.set('vehicle_master/m-gn7-hev', { id: 'm-gn7-hev', sub_model: '그랜저 하이브리드 GN7' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimMasterLinkRepairs: [{ id: 't1', from: 'm-gn7', to: 'm-gn7-hev' }] })).rejects.toThrow(/transaction linked vehicle_master missing/);
    db.runTransaction = original;
    expect(store.get('vehicle_trim_master/t1')!.master_id).toBe('m-gn7');
  });
  it('refuses to create an entry that already exists and rejects inexact ids', async () => {
    store.set('vehicle_master/m-gn7-hev', { id: 'm-gn7-hev' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterCreates: [hevMaster] }))
      .rejects.toThrow(/already exists/);
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimMasterLinkRepairs: [{ id: 't1', from: 'm-gn7', to: ' m-gn7-hev ' }] })).rejects.toThrow(/exact master id/);
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimCreates: [{ id: 'n1', evidence: 'x', data: { maker: '현대', model: '그랜저', sub_model: 'S', trim: 'T', master_id: ' m-gn7 ', trim_row_key: 'n1' } }] }))
      .rejects.toThrow(/exact id/);
  });
  it('aborts the whole plan when a precondition changed before commit', async () => {
    store.set('vehicle_trim_master/t1', { ...store.get('vehicle_trim_master/t1')!, sub_model: '다른 이름' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimSubModelRepairs: [{ id: 't1', from: '그랜저 GN7', to: '그랜저 하이브리드 GN7' }] })).rejects.toThrow(/precondition changed/);
  });
});
