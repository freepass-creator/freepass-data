import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory Firestore stand-in: enough of getAll/runTransaction/update/create/FieldValue for the repair path.
const store = new Map<string, Record<string, unknown>>();
const UNION = Symbol('union');
type Ref = { path: string; id: string; parent: { id: string } };
const ref = (collection: string, id: string): Ref => ({ path: `${collection}/${id}`, id, parent: { id: collection } });
// Firestore returns map keys in sorted order — the stand-in does too, so readback must not depend on key order.
const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
const snap = (r: Ref) => ({ ref: r, exists: store.has(r.path), data: () => (store.has(r.path) ? sortKeys(structuredClone(store.get(r.path))) as Record<string, unknown> : undefined) });
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
type Query = { collection: string; filters: Array<[string, unknown]>; cap?: number; where: (f: string, op: string, v: unknown) => Query; select: (...f: string[]) => Query; limit: (n: number) => Query; get: () => Promise<ReturnType<typeof runQuery>> };
const query = (collection: string, filters: Array<[string, unknown]> = [], cap?: number): Query => ({
  collection, filters, ...(cap !== undefined ? { cap } : {}), where: (f, _op, v) => query(collection, [...filters, [f, v]], cap), select: () => query(collection, filters, cap), limit: (n) => query(collection, filters, n),
  get: async () => runQuery(query(collection, filters, cap)),
});
const runQuery = (q: Query) => {
  const docs = [...store.entries()].filter(([path, data]) => path.startsWith(`${q.collection}/`) && q.filters.every(([f, v]) => data[f] === v)).slice(0, q.cap ?? Infinity);
  return { empty: docs.length === 0, size: docs.length, docs: docs.map(([path, data]) => ({ id: path.split('/')[1]!, data: () => structuredClone(data) })) };
};
const db = {
  collection: (c: string) => ({ doc: (id: string) => ref(c, id), where: (f: string, op: string, v: unknown) => query(c).where(f, op, v), select: (...f: string[]) => query(c).select(...f) }),
  getAll: async (...refs: Ref[]) => refs.map(snap),
  runTransaction: async (fn: (t: unknown) => Promise<void>) => {
    const writes: Array<() => void> = [];
    const t = {
      getAll: async (...refs: Ref[]) => refs.map(snap),
      get: async (q: Query) => runQuery(q),
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

const { applyVehicleNameReferenceRepair, MAX_MASTER_IDENTITY_SCAN } = await import('../src/infra/vehicle-name-reference-repair-firestore.js');

beforeEach(() => {
  store.clear();
  store.set('vehicle_master/m-gn7', { id: 'm-gn7', maker: '현대', model: '그랜저', sub_model: '그랜저 GN7' });
  store.set('vehicle_trim_master/t1', { sub_model: '그랜저 GN7', master_id: 'm-gn7', trim: '프리미엄', fuel: '하이브리드' });
  store.set('vehicle_trim_master/t2', { sub_model: '디 올 뉴 싼타페 MX5', master_id: 'm-mx5', trim: '익스클루시브', sub_model_aliases: ['싼타페 MX5 신형'] });
  store.set('vehicle_master/m-mx5', { id: 'm-mx5', maker: '현대', model: '싼타페', sub_model: '디 올 뉴 싼타페 MX5' });
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
  it('keeps one trim row key and one master per sub-model — inside the plan and against stored data (값 하나)', async () => {
    const trimData = (key: string) => ({ maker: '현대', model: '그랜저', sub_model: '그랜저 하이브리드 GN7', trim: '프리미엄', master_id: 'm-gn7', trim_row_key: key });
    // two different ids carrying the same trim_row_key inside one plan
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimCreates: [{ id: 'k1', evidence: 'x', data: trimData('k1') }, { id: 'k2', evidence: 'x', data: trimData('k1') }] })).rejects.toThrow(/trim_row_key must equal id/);
    // a stored row (different document id) already carries the key
    store.set('vehicle_trim_master/legacy-doc', { trim_row_key: 'k9', sub_model: '그랜저 GN7' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimCreates: [{ id: 'k9', evidence: 'x', data: trimData('k9') }] })).rejects.toThrow(/trim_row_key already stored/);
    expect(store.has('vehicle_trim_master/k9')).toBe(false);
    // the same maker|model|sub_model twice in one plan, or already stored under another id
    const m2 = { ...hevMaster, id: 'm-gn7-hev-2', data: { ...hevMaster.data, id: 'm-gn7-hev-2' } };
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterCreates: [hevMaster, m2] }))
      .rejects.toThrow(/duplicate master sub-model/);
    store.set('vehicle_master/old-hev', { id: 'old-hev', maker: '현대', model: '그랜저', sub_model: '그랜저 하이브리드 GN7' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterCreates: [hevMaster] }))
      .rejects.toThrow(/would be stored twice/);
  });
  it('rejects renames that would leave two masters with the same final sub-model name', async () => {
    store.set('vehicle_master/m-ig', { id: 'm-ig', maker: '현대', model: '그랜저', sub_model: '그랜저 IG' });
    // rename onto a name another stored master already has
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', productRepairs: [],
      masterRepairs: [{ id: 'm-ig', from: '그랜저 IG', to: '그랜저 GN7' }] })).rejects.toThrow(/would be stored twice/);
    // two renames onto the same new name
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', productRepairs: [],
      masterRepairs: [{ id: 'm-ig', from: '그랜저 IG', to: '그랜저 X' }, { id: 'm-gn7', from: '그랜저 GN7', to: '그랜저 X' }] })).rejects.toThrow(/would be stored twice/);
    // rename A→B and create B in the same plan
    const createB = { id: 'm-b', data: { id: 'm-b', maker: '현대', model: '그랜저', sub_model: '그랜저 B', origin: '국산' }, evidence: 'x' };
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', productRepairs: [],
      masterRepairs: [{ id: 'm-ig', from: '그랜저 IG', to: '그랜저 B' }], masterCreates: [createB] })).rejects.toThrow(/would be stored twice/);
    // a swap (A→B, B→A) is allowed: the final names stay unique
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', productRepairs: [],
      masterRepairs: [{ id: 'm-ig', from: '그랜저 IG', to: '그랜저 GN7' }, { id: 'm-gn7', from: '그랜저 GN7', to: '그랜저 IG' }] });
    expect(store.get('vehicle_master/m-ig')!.sub_model).toBe('그랜저 GN7');
  });
  it('compares stored names normalized — a stray space in stored maker text does not hide a duplicate', async () => {
    store.set('vehicle_master/m-old', { id: 'm-old', maker: ' 현대 ', model: '그랜저', sub_model: '그랜저 TG' });
    const createB = { id: 'm-b', data: { id: 'm-b', maker: '현대', model: '그랜저', sub_model: '그랜저 B', origin: '국산' }, evidence: 'x' };
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', productRepairs: [],
      masterRepairs: [{ id: 'm-old', from: '그랜저 TG', to: '그랜저 B' }], masterCreates: [createB] })).rejects.toThrow(/would be stored twice/);
  });
  it('stops instead of scanning an unbounded vehicle_master inside the transaction', async () => {
    for (let i = 0; i <= MAX_MASTER_IDENTITY_SCAN; i += 1) store.set(`vehicle_master/x${i}`, { maker: 'M', model: 'X', sub_model: `S${i}` });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', productRepairs: [],
      masterRepairs: [{ id: 'm-gn7', from: '그랜저 GN7', to: '그랜저 GN7 새이름' }] })).rejects.toThrow(/unbounded/);
    expect(store.get('vehicle_master/m-gn7')!.sub_model).toBe('그랜저 GN7');
  });
  it('accepts only normalized maker/model/sub-model text for a new master', async () => {
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterCreates: [{ ...hevMaster, data: { ...hevMaster.data, sub_model: ' 그랜저 하이브리드 GN7 ' } }] })).rejects.toThrow(/normalized/);
  });
  it('replaces a master variants list only when it still matches the reviewed digest', async () => {
    const variants = [{ fuel: '가솔린', trims: ['프리미엄'] }, { fuel: '하이브리드', trims: ['프리미엄'] }];
    store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, variants });
    const { stableDigest } = await import('../src/shared/stable-digest.js');
    const repair = { id: 'm-gn7', fromDigest: stableDigest(variants), to: [variants[0]!], evidence: '하이브리드는 그랜저 하이브리드 GN7 로' };
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterVariantRepairs: [repair] });
    expect(store.get('vehicle_master/m-gn7')!.variants).toEqual([variants[0]]);
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterVariantRepairs: [repair] }))
      .rejects.toThrow(/variants precondition changed/);
  });
  it('retires a leftover master only when no trim row or product still uses it (never deletes)', async () => {
    store.set('vehicle_master/m-old', { id: 'm-old', maker: '현대', model: '그랜저', sub_model: '그랜저 옛이름' });
    store.set('vehicle_trim_master/t9', { sub_model: '그랜저 옛이름', master_id: 'm-old', trim: '프리미엄' });
    // a row still links to it → refused
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterRetires: [{ id: 'm-old', into: 'm-gn7', evidence: '합쳐짐' }] })).rejects.toThrow(/still linked by trim rows/);
    // relinking that row away in the same plan makes the retire possible
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimSubModelRepairs: [{ id: 't9', from: '그랜저 옛이름', to: '그랜저 GN7' }], trimMasterLinkRepairs: [{ id: 't9', from: 'm-old', to: 'm-gn7' }],
      masterRetires: [{ id: 'm-old', into: 'm-gn7', evidence: '합쳐짐' }] });
    expect(store.get('vehicle_master/m-old')).toMatchObject({ retired: true, retired_into: 'm-gn7', sub_model: '그랜저 옛이름' });
    // already retired → refused
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterRetires: [{ id: 'm-old', into: 'm-gn7', evidence: 'x' }] })).rejects.toThrow(/already retired/);
  });
  it('refuses a retire when products carry the name only in another spelling, or the plan renames a product into it', async () => {
    store.set('vehicle_master/m-old', { id: 'm-old', maker: '현대', model: '그랜저', sub_model: '그랜저 옛이름' });
    store.set('products/p1', { model: '그랜저', sub_model: ' 그랜저  옛이름' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterRetires: [{ id: 'm-old', into: 'm-gn7', evidence: 'x' }] })).rejects.toThrow(/still used by products/);
    store.set('products/p1', { model: '그랜저', sub_model: '그랜저 GN7' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [{ id: 'p1', from: '그랜저 GN7', to: '그랜저 옛이름' }],
      masterRetires: [{ id: 'm-old', into: 'm-gn7', evidence: 'x' }] })).rejects.toThrow(/name of a master it retires/);
    expect(store.get('vehicle_master/m-old')!.retired).toBeUndefined();
  });
  it('refuses to retire a master whose name products still carry, or into a missing master', async () => {
    store.set('vehicle_master/m-old', { id: 'm-old', maker: '현대', model: '그랜저', sub_model: '그랜저 옛이름' });
    store.set('products/p1', { model: '그랜저', sub_model: '그랜저 옛이름' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterRetires: [{ id: 'm-old', into: 'm-gn7', evidence: 'x' }] })).rejects.toThrow(/still used by products/);
    store.delete('products/p1');
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterRetires: [{ id: 'm-old', into: 'm-none', evidence: 'x' }] })).rejects.toThrow(/into-master missing/);
    expect(store.get('vehicle_master/m-old')!.retired).toBeUndefined();
  });
  it('aborts the whole plan when a precondition changed before commit', async () => {
    store.set('vehicle_trim_master/t1', { ...store.get('vehicle_trim_master/t1')!, sub_model: '다른 이름' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimSubModelRepairs: [{ id: 't1', from: '그랜저 GN7', to: '그랜저 하이브리드 GN7' }] })).rejects.toThrow(/precondition changed/);
  });
});
