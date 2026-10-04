import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory Firestore stand-in: enough of getAll/runTransaction/update/create/FieldValue for the repair path.
const store = new Map<string, Record<string, unknown>>();
const UNION = Symbol('union');
type Ref = { path: string; id: string; parent: { id: string } };
const ref = (collection: string, id: string): Ref => ({ path: `${collection}/${id}`, id, parent: { id: collection } });
// Firestore returns map keys in sorted order — the stand-in does too, so readback must not depend on key order.
const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
// A snapshot is fixed at read time, like Firestore's DocumentSnapshot (later writes do not show through it).
const snap = (r: Ref) => { const at = store.has(r.path) ? sortKeys(structuredClone(store.get(r.path))) as Record<string, unknown> : undefined; return { ref: r, exists: at !== undefined, data: () => (at === undefined ? undefined : structuredClone(at)) }; };
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
  store.set('vehicle_trim_master/t1', { model: '그랜저', sub_model: '그랜저 GN7', master_id: 'm-gn7', trim: '프리미엄', fuel: '하이브리드' });
  store.set('vehicle_trim_master/t2', { model: '싼타페', sub_model: '디 올 뉴 싼타페 MX5', master_id: 'm-mx5', trim: '익스클루시브', sub_model_aliases: ['싼타페 MX5 신형'] });
  store.set('vehicle_master/m-mx5', { id: 'm-mx5', maker: '현대', model: '싼타페', sub_model: '디 올 뉴 싼타페 MX5' });
});

const hevMaster = { id: 'm-gn7-hev', data: { id: 'm-gn7-hev', maker: '현대', model: '그랜저', sub_model: '그랜저 하이브리드 GN7', origin: '국산', variants: [{ turbo: true, label: '하이브리드 1.6', fuel: '하이브리드', trims: ['프리미엄'] }], trims: ['프리미엄'] }, evidence: '규칙 15·18' };

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
    store.set('vehicle_trim_master/legacy-doc', { model: '그랜저', trim_row_key: 'k9', sub_model: '그랜저 GN7' });
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
    const variants = [{ label: 'v', fuel: '가솔린', trims: ['프리미엄'] }, { label: 'v', fuel: '하이브리드', trims: ['프리미엄'] }];
    store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, variants, trims: ['프리미엄'] });
    const { stableDigest } = await import('../src/shared/stable-digest.js');
    const repair = { id: 'm-gn7', fromDigest: stableDigest(variants), to: [variants[0]!], evidence: '하이브리드는 그랜저 하이브리드 GN7 로' };
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterVariantRepairs: [repair] });
    expect(store.get('vehicle_master/m-gn7')!.variants).toEqual([variants[0]]);
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterVariantRepairs: [repair] }))
      .rejects.toThrow(/variants precondition changed/);
  });
  it('retires a leftover master only when no trim row or product still uses it (never deletes)', async () => {
    store.set('vehicle_master/m-old', { id: 'm-old', maker: '현대', model: '그랜저', sub_model: '그랜저 옛이름' });
    store.set('vehicle_trim_master/t9', { model: '그랜저', sub_model: '그랜저 옛이름', master_id: 'm-old', trim: '프리미엄' });
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
  it('refuses a chain: after A is retired into B, B cannot be retired', async () => {
    store.set('vehicle_master/m-old', { id: 'm-old', maker: '현대', model: '그랜저', sub_model: '그랜저 옛이름' });
    store.set('vehicle_master/m-new', { id: 'm-new', maker: '현대', model: '그랜저', sub_model: '그랜저 새이름' });
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterRetires: [{ id: 'm-old', into: 'm-gn7', evidence: '합쳐짐' }] });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimMasterLinkRepairs: [{ id: 't1', from: 'm-gn7', to: 'm-new' }],
      masterRetires: [{ id: 'm-gn7', into: 'm-new', evidence: 'x' }] })).rejects.toThrow(/retired into/);
    expect(store.get('vehicle_master/m-gn7')!.retired).toBeUndefined();
  });
  it('refuses to rename a product onto a retired master name in a later plan', async () => {
    store.set('vehicle_master/m-old', { id: 'm-old', maker: '현대', model: '그랜저', sub_model: '그랜저 옛이름' });
    store.set('products/p7', { model: '그랜저', sub_model: '그랜저 GN7' });
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterRetires: [{ id: 'm-old', into: 'm-gn7', evidence: '합쳐짐' }] });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [],
      productRepairs: [{ id: 'p7', from: '그랜저 GN7', to: '그랜저 옛이름' }] })).rejects.toThrow(/retired master/);
    expect(store.get('products/p7')!.sub_model).toBe('그랜저 GN7');
  });
  it('freezes a retired master: no rename (alone or together with a product rename) and no variants edit', async () => {
    const { stableDigest } = await import('../src/shared/stable-digest.js');
    store.set('vehicle_master/m-old', { id: 'm-old', maker: '현대', model: '그랜저', sub_model: '그랜저 옛이름' });
    store.set('products/p7', { model: '그랜저', sub_model: '그랜저 GN7' });
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterRetires: [{ id: 'm-old', into: 'm-gn7', evidence: '합쳐짐' }] });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', productRepairs: [],
      masterRepairs: [{ id: 'm-old', from: '그랜저 옛이름', to: '그랜저 다른이름' }] })).rejects.toThrow(/cannot be renamed/);
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1',
      masterRepairs: [{ id: 'm-old', from: '그랜저 옛이름', to: '그랜저 새이름' }],
      productRepairs: [{ id: 'p7', from: '그랜저 GN7', to: '그랜저 새이름' }] })).rejects.toThrow(/cannot be renamed/);
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterVariantRepairs: [{ id: 'm-old', fromDigest: stableDigest(null), to: [{ label: 'x', fuel: '가솔린' }], evidence: 'x' }] })).rejects.toThrow(/retired/);
    expect(store.get('vehicle_master/m-old')).toMatchObject({ sub_model: '그랜저 옛이름', retired: true });
    expect(store.get('products/p7')!.sub_model).toBe('그랜저 GN7');
  });
  it('replaces the top-level trims list together with variants, guarded by its own digest', async () => {
    const { stableDigest } = await import('../src/shared/stable-digest.js');
    const variants = [{ label: 'v', fuel: '가솔린', trims: ['프리미엄', '아너스'] }];
    store.set('vehicle_master/m-gn7', { id: 'm-gn7', maker: '현대', model: '그랜저', sub_model: '그랜저 GN7', variants, trims: ['아너스', '프리미엄'] });
    const repair = { id: 'm-gn7', fromDigest: stableDigest(variants), to: [{ label: 'v', fuel: '가솔린', trims: ['프리미엄', '블랙 잉크'] }], evidence: '행 기준',
      trims: ['프리미엄', '블랙 잉크'], fromTrimsDigest: stableDigest(['프리미엄']) };
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterVariantRepairs: [repair] })).rejects.toThrow(/precondition/);
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterVariantRepairs: [{ ...repair, fromTrimsDigest: stableDigest(['아너스', '프리미엄']) }] });
    expect(store.get('vehicle_master/m-gn7')).toMatchObject({ trims: ['프리미엄', '블랙 잉크'], variants: repair.to });
  });
  it('trims edit: audit carries before/after, a trims change after the early check aborts with no writes, readback catches a mismatch, retired masters are frozen', async () => {
    const { stableDigest } = await import('../src/shared/stable-digest.js');
    const variants = [{ label: 'v', fuel: '가솔린', trims: ['프리미엄'] }];
    const seed = () => store.set('vehicle_master/m-gn7', { id: 'm-gn7', maker: '현대', model: '그랜저', sub_model: '그랜저 GN7', variants, trims: ['아너스'] });
    const repair = { id: 'm-gn7', fromDigest: stableDigest(variants), to: variants, evidence: '행 기준', trims: ['프리미엄'], fromTrimsDigest: stableDigest(['아너스']) };
    const plan = { sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterVariantRepairs: [repair] };
    const audits = () => [...store.entries()].filter(([k]) => k.startsWith('audit_events/')).map(([, v]) => v);
    const original = db.runTransaction;
    // 1) trims changed by someone else after the early check → aborted, nothing written
    seed();
    db.runTransaction = async (fn) => { store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, trims: ['아너스', '르블랑'] }); return original(fn); };
    try { await expect(applyVehicleNameReferenceRepair(plan)).rejects.toThrow(/precondition/); } finally { db.runTransaction = original; }
    expect(store.get('vehicle_master/m-gn7')!.trims).toEqual(['아너스', '르블랑']);
    expect(audits()).toHaveLength(0);
    // 2) trims-only change (variants identical) succeeds; audit records before digest and after list
    seed();
    await applyVehicleNameReferenceRepair(plan);
    expect(store.get('vehicle_master/m-gn7')!.trims).toEqual(['프리미엄']);
    expect(audits()).toEqual(expect.arrayContaining([expect.objectContaining({ before: expect.objectContaining({ trimsDigest: stableDigest(['아너스']) }), after: expect.objectContaining({ trims: ['프리미엄'] }) })]));
    // 3) readback mismatch is detected
    store.clear(); seed();
    db.runTransaction = async (fn) => { await original(fn); store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, trims: ['다른 값'] }); };
    try { await expect(applyVehicleNameReferenceRepair(plan)).rejects.toThrow(/readback trims mismatch/); } finally { db.runTransaction = original; }
    // 4) a retired master is frozen for trims edits too
    store.clear(); seed(); store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, retired: true, retired_into: 'm-x' });
    await expect(applyVehicleNameReferenceRepair(plan)).rejects.toThrow(/retired/);
    expect(store.get('vehicle_master/m-gn7')!.trims).toEqual(['아너스']);
  });
  it('renames the model on a master and its trim rows and the gen_code, keeping old values as aliases', async () => {
    store.set('vehicle_master/m-i5', { id: 'm-i5', maker: '현대', model: '아이오닉5', sub_model: '아이오닉 5 NE', gen_code: 'NE1' });
    store.set('vehicle_trim_master/r1', { model: '아이오닉5', sub_model: '아이오닉 5 NE', master_id: 'm-i5', trim: '프레스티지' });
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterModelRepairs: [{ id: 'm-i5', from: '아이오닉5', to: '아이오닉 5' }], trimModelRepairs: [{ id: 'r1', from: '아이오닉5', to: '아이오닉 5' }],
      masterGenCodeRepairs: [{ id: 'm-i5', from: 'NE1', to: 'NE' }] });
    expect(store.get('vehicle_master/m-i5')).toMatchObject({ model: '아이오닉 5', model_aliases: ['아이오닉5'], gen_code: 'NE', gen_code_aliases: ['NE1'] });
    expect(store.get('vehicle_trim_master/r1')).toMatchObject({ model: '아이오닉 5', model_aliases: ['아이오닉5'] });
  });
  it('refuses a model rename that would store the same maker|model|sub_model twice, and model or gen_code edits on a retired master', async () => {
    store.set('vehicle_master/m-a', { id: 'm-a', maker: '현대', model: '아이오닉5', sub_model: '아이오닉 5 NE' });
    store.set('vehicle_master/m-b', { id: 'm-b', maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterModelRepairs: [{ id: 'm-a', from: '아이오닉5', to: '아이오닉 5' }] })).rejects.toThrow(/stored twice/);
    store.set('vehicle_master/m-b', { id: 'm-b', maker: '현대', model: '아이오닉5', sub_model: '옛 이름', gen_code: 'X', retired: true, retired_into: 'm-a' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterModelRepairs: [{ id: 'm-b', from: '아이오닉5', to: '아이오닉 5' }] })).rejects.toThrow(/retired master/);
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterGenCodeRepairs: [{ id: 'm-b', from: 'X', to: 'Y' }] })).rejects.toThrow(/retired master/);
    expect(store.get('vehicle_master/m-a')!.model).toBe('아이오닉5');
  });
  it('keeps one model name per master and its rows: master-only rename, a missed row, a row added meanwhile are refused', async () => {
    store.set('vehicle_master/m-i5', { id: 'm-i5', maker: '현대', model: '아이오닉5', sub_model: '아이오닉 5 NE', model_aliases: ['IONIQ5'] });
    store.set('vehicle_trim_master/r1', { model: '아이오닉5', sub_model: '아이오닉 5 NE', master_id: 'm-i5', trim: 'A' });
    store.set('vehicle_trim_master/r2', { model: '아이오닉5', sub_model: '아이오닉 5 NE', master_id: 'm-i5', trim: 'B' });
    const base = { sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterModelRepairs: [{ id: 'm-i5', from: '아이오닉5', to: '아이오닉 5' }] };
    await expect(applyVehicleNameReferenceRepair(base)).rejects.toThrow(/model would differ/);
    await expect(applyVehicleNameReferenceRepair({ ...base, trimModelRepairs: [{ id: 'r1', from: '아이오닉5', to: '아이오닉 5' }] })).rejects.toThrow(/model would differ.*r2/);
    // a row only on the trim side is refused as well
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], trimModelRepairs: [{ id: 'r1', from: '아이오닉5', to: '아이오닉 5' }] })).rejects.toThrow(/model would differ/);
    const full = { ...base, trimModelRepairs: [{ id: 'r1', from: '아이오닉5', to: '아이오닉 5' }, { id: 'r2', from: '아이오닉5', to: '아이오닉 5' }] };
    const original = db.runTransaction;
    db.runTransaction = async (fn) => { store.set('vehicle_trim_master/r3', { model: '아이오닉5', sub_model: '아이오닉 5 NE', master_id: 'm-i5', trim: 'C' }); return original(fn); };
    try { await expect(applyVehicleNameReferenceRepair(full)).rejects.toThrow(/model would differ.*r3/); } finally { db.runTransaction = original; }
    store.delete('vehicle_trim_master/r3');
    await applyVehicleNameReferenceRepair(full);
    // existing aliases are kept next to the old name
    expect(store.get('vehicle_master/m-i5')).toMatchObject({ model: '아이오닉 5', model_aliases: ['IONIQ5', '아이오닉5'] });
    // readback catches a tampered model
    store.set('vehicle_master/m-x', { id: 'm-x', maker: '현대', model: '아이오닉6', sub_model: '아이오닉 6 CE' });
    db.runTransaction = async (fn) => { await original(fn); store.set('vehicle_master/m-x', { ...store.get('vehicle_master/m-x')!, model: '변조' }); };
    try { await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterModelRepairs: [{ id: 'm-x', from: '아이오닉6', to: '아이오닉 6' }] })).rejects.toThrow(/readback mismatch/); } finally { db.runTransaction = original; }
  });
  it('fills a blank gen_code only with evidence, without an alias', async () => {
    store.set('vehicle_master/m-9', { id: 'm-9', maker: '현대', model: '아이오닉 9', sub_model: '아이오닉 9 ME', gen_code: '' });
    const base = { sourceDigest: 'v1', masterRepairs: [], productRepairs: [] };
    await expect(applyVehicleNameReferenceRepair({ ...base, masterGenCodeRepairs: [{ id: 'm-9', from: '', to: 'ME' }] })).rejects.toThrow(/requires/);
    await applyVehicleNameReferenceRepair({ ...base, masterGenCodeRepairs: [{ id: 'm-9', from: '', to: 'ME', evidence: '세부모델 이름의 개발코드' }] });
    expect(store.get('vehicle_master/m-9')).toMatchObject({ gen_code: 'ME' });
    expect(store.get('vehicle_master/m-9')!.gen_code_aliases).toBeUndefined();
    // a blank fill still keeps the aliases that were there (readback catches a loss)
    store.set('vehicle_master/m-8', { id: 'm-8', maker: '현대', model: '아이오닉 9', sub_model: '아이오닉 8', gen_code: '', gen_code_aliases: ['OLD'] });
    const original = db.runTransaction;
    db.runTransaction = async (fn) => { await original(fn); store.set('vehicle_master/m-8', { ...store.get('vehicle_master/m-8')!, gen_code_aliases: [] }); };
    try { await expect(applyVehicleNameReferenceRepair({ ...base, masterGenCodeRepairs: [{ id: 'm-8', from: '', to: 'ME', evidence: 'x' }] })).rejects.toThrow(/readback alias mismatch/); } finally { db.runTransaction = original; }
    // a stored code is not a blank: the plan's blank from no longer matches
    await expect(applyVehicleNameReferenceRepair({ ...base, masterGenCodeRepairs: [{ id: 'm-9', from: '', to: 'ME1', evidence: 'x' }] })).rejects.toThrow(/precondition/);
  });
  it('checks names with model and sub-model renamed together, and against a created master', async () => {
    store.set('vehicle_master/m-a', { id: 'm-a', maker: '현대', model: '아이오닉5', sub_model: '옛 이름' });
    store.set('vehicle_master/m-b', { id: 'm-b', maker: '현대', model: '아이오닉 5', sub_model: '아이오닉 5 NE' });
    const both = { sourceDigest: 'v1', productRepairs: [], masterModelRepairs: [{ id: 'm-a', from: '아이오닉5', to: '아이오닉 5' }] };
    await expect(applyVehicleNameReferenceRepair({ ...both, masterRepairs: [{ id: 'm-a', from: '옛 이름', to: '아이오닉 5 NE' }] })).rejects.toThrow(/stored twice/);
    await applyVehicleNameReferenceRepair({ ...both, masterRepairs: [{ id: 'm-a', from: '옛 이름', to: '아이오닉 5 N' }] });
    expect(store.get('vehicle_master/m-a')).toMatchObject({ model: '아이오닉 5', sub_model: '아이오닉 5 N' });
    store.set('vehicle_master/m-c', { id: 'm-c', maker: '현대', model: '아이오닉6', sub_model: '아이오닉 6 CE' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterModelRepairs: [{ id: 'm-c', from: '아이오닉6', to: '아이오닉 6' }],
      masterCreates: [{ id: 'm-new', evidence: 'x', data: { id: 'm-new', maker: '현대', model: '아이오닉 6', sub_model: '아이오닉 6 CE', origin: '국산' } }] })).rejects.toThrow(/stored twice/);
  });
  it('refuses a variants edit without trims when the stored trims list does not cover the new variant trims', async () => {
    const { stableDigest } = await import('../src/shared/stable-digest.js');
    const variants = [{ label: 'v', fuel: '가솔린', trims: ['프리미엄'] }];
    store.set('vehicle_master/m-gn7', { id: 'm-gn7', maker: '현대', model: '그랜저', sub_model: '그랜저 GN7', variants, trims: ['프리미엄'] });
    const base = { sourceDigest: 'v1', masterRepairs: [], productRepairs: [] };
    await expect(applyVehicleNameReferenceRepair({ ...base, masterVariantRepairs: [{ id: 'm-gn7', fromDigest: stableDigest(variants), to: [{ label: 'v', fuel: '가솔린', trims: ['프리미엄', '블랙 잉크'] }], evidence: 'x' }] }))
      .rejects.toThrow(/missing from the stored trims/);
    await applyVehicleNameReferenceRepair({ ...base, masterVariantRepairs: [{ id: 'm-gn7', fromDigest: stableDigest(variants), to: [{ label: 'v', fuel: 'LPG', trims: ['프리미엄'] }], evidence: 'x' }] });
    expect(store.get('vehicle_master/m-gn7')!.variants).toEqual([{ label: 'v', fuel: 'LPG', trims: ['프리미엄'] }]);
    // the stored list shrinks after the early check → refused inside the transaction
    const now = store.get('vehicle_master/m-gn7')!.variants;
    const original = db.runTransaction;
    db.runTransaction = async (fn) => { store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, trims: [] }); return original(fn); };
    try { await expect(applyVehicleNameReferenceRepair({ ...base, masterVariantRepairs: [{ id: 'm-gn7', fromDigest: stableDigest(now), to: [{ label: 'v', fuel: '가솔린', trims: ['프리미엄'] }], evidence: 'x' }] })).rejects.toThrow(/transaction variants name trims missing/); } finally { db.runTransaction = original; }
    // an empty stored list refuses non-empty variant trims; a missing, null or non-list trims also refuses them (pass trims)
    await expect(applyVehicleNameReferenceRepair({ ...base, masterVariantRepairs: [{ id: 'm-gn7', fromDigest: stableDigest(now), to: [{ label: 'v', fuel: '가솔린', trims: ['프리미엄'] }], evidence: 'x' }] })).rejects.toThrow(/missing from the stored trims/);
    for (const bad of [null, '프리미엄', undefined]) {
      store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, trims: bad });
      await expect(applyVehicleNameReferenceRepair({ ...base, masterVariantRepairs: [{ id: 'm-gn7', fromDigest: stableDigest(now), to: [{ label: 'v', fuel: '가솔린', trims: ['프리미엄'] }], evidence: 'x' }] })).rejects.toThrow(/not a list/);
    }
    // a stored trims list with non-string entries is refused
    store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, trims: ['프리미엄', 3] });
    await expect(applyVehicleNameReferenceRepair({ ...base, masterVariantRepairs: [{ id: 'm-gn7', fromDigest: stableDigest(now), to: [{ label: 'v', fuel: '가솔린', trims: ['프리미엄'] }], evidence: 'x' }] })).rejects.toThrow(/list of strings/);
    store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, trims: ['프리미엄'] });
    // a stored trims of the wrong type is refused even when the new variants name no trims
    for (const bad of [null, 3, 'A', {}]) {
      store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, trims: bad });
      await expect(applyVehicleNameReferenceRepair({ ...base, masterVariantRepairs: [{ id: 'm-gn7', fromDigest: stableDigest(now), to: [{ label: 'v', fuel: 'gas' }], evidence: 'x' }] })).rejects.toThrow(/not a list of strings/);
    }
    // ... and also when the plan replaces the list (the stored value must still be a valid list or absent)
    for (const bad of [null, 3, 'A', {}, ['A', 3], ['']]) {
      store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, trims: bad });
      await expect(applyVehicleNameReferenceRepair({ ...base, masterVariantRepairs: [{ id: 'm-gn7', fromDigest: stableDigest(now), to: [{ label: 'v', fuel: 'gas', trims: ['A'] }], evidence: 'x', trims: ['A'], fromTrimsDigest: stableDigest(bad) }] })).rejects.toThrow(/not a list of strings/);
    }
    // a stored variants list of the wrong shape is refused before it is replaced
    store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, trims: ['프리미엄'] });
    for (const bad of ['x', [3], [{ trims: 'A' }], [{ trims: null }], [{ trims: [3] }]]) {
      store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, variants: bad });
      await expect(applyVehicleNameReferenceRepair({ ...base, masterVariantRepairs: [{ id: 'm-gn7', fromDigest: stableDigest(bad), to: [{ label: 'v', fuel: 'gas' }], evidence: 'x' }] })).rejects.toThrow(/stored variants is not a list/);
    }
    store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, variants: now });
    store.set('vehicle_master/m-gn7', { ...store.get('vehicle_master/m-gn7')!, trims: undefined });
    // variants without any trim names need no trims list
    await applyVehicleNameReferenceRepair({ ...base, masterVariantRepairs: [{ id: 'm-gn7', fromDigest: stableDigest(now), to: [{ label: 'v', fuel: '가솔린' }], evidence: 'x' }] });
  });
  it('checks the model of every relink destination, refuses non-list alias fields, and keeps the stored spelling as an alias', async () => {
    // ② a row relinked away from a master whose model changes, to a master with another model, is refused
    store.set('vehicle_master/m-i5', { id: 'm-i5', maker: '현대', model: '아이오닉5', sub_model: '아이오닉 5 NE' });
    store.set('vehicle_master/m-k', { id: 'm-k', maker: '현대', model: '코나', sub_model: '코나 OS' });
    store.set('vehicle_trim_master/r1', { model: '아이오닉5', sub_model: '아이오닉 5 NE', master_id: 'm-i5', trim: 'A' });
    store.set('vehicle_trim_master/r2', { model: '아이오닉5', sub_model: '아이오닉 5 NE', master_id: 'm-i5', trim: 'B' });
    const base = { sourceDigest: 'v1', masterRepairs: [], productRepairs: [] };
    await expect(applyVehicleNameReferenceRepair({ ...base, masterModelRepairs: [{ id: 'm-i5', from: '아이오닉5', to: '아이오닉 5' }],
      trimModelRepairs: [{ id: 'r1', from: '아이오닉5', to: '아이오닉 5' }], trimMasterLinkRepairs: [{ id: 'r2', from: 'm-i5', to: 'm-k' }] }))
      .rejects.toThrow(/model would differ between vehicle_master\/m-k/);
    // ② a relink-only plan is checked too: a row of another model cannot move under a master
    await expect(applyVehicleNameReferenceRepair({ ...base, trimMasterLinkRepairs: [{ id: 'r2', from: 'm-i5', to: 'm-k' }] })).rejects.toThrow(/model would differ between vehicle_master\/m-k/);
    await expect(applyVehicleNameReferenceRepair({ ...base, trimCreates: [{ id: 'k1', evidence: 'x', data: { maker: '현대', model: '아이오닉5', sub_model: '코나 OS', trim: 'A', master_id: 'm-k', trim_row_key: 'k1' } }] })).rejects.toThrow(/model would differ/);
    // ④ the stored spelling changing between the early read and the transaction aborts before any write
    store.set('vehicle_master/m-s', { id: 'm-s', maker: '현대', model: '코나', sub_model: ' S1 ' });
    const orig0 = db.runTransaction;
    db.runTransaction = async (fn) => { store.set('vehicle_master/m-s', { ...store.get('vehicle_master/m-s')!, sub_model: 'S1' }); return orig0(fn); };
    try { await expect(applyVehicleNameReferenceRepair({ ...base, masterRepairs: [{ id: 'm-s', from: 'S1', to: 'S2' }] })).rejects.toThrow(/stored spelling changed/); } finally { db.runTransaction = orig0; }
    expect(store.get('vehicle_master/m-s')!.sub_model).toBe('S1');
    // ③ an alias field that is not a list is refused (it would be overwritten)
    store.set('vehicle_master/m-k', { ...store.get('vehicle_master/m-k')!, sub_model_aliases: '옛 코나' });
    await expect(applyVehicleNameReferenceRepair({ ...base, masterRepairs: [{ id: 'm-k', from: '코나 OS', to: '코나 OS2' }] })).rejects.toThrow(/alias field is not a list/);
    expect(store.get('vehicle_master/m-k')!.sub_model_aliases).toBe('옛 코나');
    store.set('vehicle_master/m-k', { ...store.get('vehicle_master/m-k')!, sub_model_aliases: ['옛 코나', { x: 1 }] });
    await expect(applyVehicleNameReferenceRepair({ ...base, masterRepairs: [{ id: 'm-k', from: '코나 OS', to: '코나 OS2' }] })).rejects.toThrow(/not a list of strings/);
    // ④ the stored spelling is kept next to the normalized old name
    store.set('vehicle_master/m-k', { id: 'm-k', maker: '현대', model: '코나', sub_model: ' 코나　OS ', sub_model_aliases: ['KONA'] });
    await applyVehicleNameReferenceRepair({ ...base, masterRepairs: [{ id: 'm-k', from: '코나 OS', to: '코나 OS2' }] });
    expect(store.get('vehicle_master/m-k')!.sub_model_aliases).toEqual(['KONA', '코나 OS', ' 코나　OS ']);
    // ③ readback catches an alias list that lost an old entry
    store.set('vehicle_master/m-z', { id: 'm-z', maker: '현대', model: '코나', sub_model: '코나 Z', sub_model_aliases: ['옛 Z'] });
    const original = db.runTransaction;
    db.runTransaction = async (fn) => { await original(fn); store.set('vehicle_master/m-z', { ...store.get('vehicle_master/m-z')!, sub_model_aliases: ['코나 Z'] }); };
    try { await expect(applyVehicleNameReferenceRepair({ ...base, masterRepairs: [{ id: 'm-z', from: '코나 Z', to: '코나 Z2' }] })).rejects.toThrow(/readback alias mismatch/); } finally { db.runTransaction = original; }
  });
  it('refuses to link a trim row to a retired master in a later plan', async () => {
    store.set('vehicle_master/m-old', { id: 'm-old', maker: '현대', model: '그랜저', sub_model: '그랜저 옛이름' });
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterRetires: [{ id: 'm-old', into: 'm-gn7', evidence: '합쳐짐' }] });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimMasterLinkRepairs: [{ id: 't1', from: 'm-gn7', to: 'm-old' }] })).rejects.toThrow(/missing or retired/);
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      trimCreates: [{ id: 'k9', evidence: 'x', data: { maker: '현대', model: '그랜저', sub_model: '그랜저 옛이름', trim: '프리미엄', master_id: 'm-old', trim_row_key: 'k9' } }] })).rejects.toThrow(/missing or retired/);
    expect(store.get('vehicle_trim_master/t1')!.master_id).toBe('m-gn7');
  });
  it('catches a product added in another spelling after the early check (checked again inside the transaction)', async () => {
    store.set('vehicle_master/m-old', { id: 'm-old', maker: '현대', model: '그랜저', sub_model: '그랜저 옛이름' });
    const original = db.runTransaction;
    db.runTransaction = async (fn) => {
      store.set('products/p9', { model: '그랜저', sub_model: '그랜저\u3000옛이름' }); // 전각 공백, 사전 확인 뒤에 들어옴
      return original(fn);
    };
    try {
      await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
        masterRetires: [{ id: 'm-old', into: 'm-gn7', evidence: 'x' }] })).rejects.toThrow(/still used by products/);
    } finally { db.runTransaction = original; }
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

describe('product identity repair apply path', () => {
  it('repairs product maker/model/sub_model together when the target active master exists', async () => {
    store.set('vehicle_master/m-alpha', { id: 'm-alpha', maker: 'Maker', model: 'Model A', sub_model: 'Model A New' });
    store.set('products/p-identity', { maker: '', model: ' Model A ', sub_model: '' });
    const result = await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productIdentityRepairs: [{ id: 'p-identity', from: { maker: '', model: 'Model A', sub_model: '' }, to: { maker: 'Maker', model: 'Model A', sub_model: 'Model A New' }, evidence: 'source text' }] });
    expect(store.get('products/p-identity')).toMatchObject({
      maker: 'Maker',
      model: 'Model A',
      sub_model: 'Model A New',
      vehicle_name_reference_checked_at: 'ts',
      vehicle_name_reference_source_digest: 'v1',
    });
    expect(result).toMatchObject({ productIdentityCount: 1, readbackCount: 1, auditCount: 1 });
    const audit = [...store.entries()].find(([k]) => k.startsWith('audit_events/'))![1];
    expect(audit.before).toEqual({ maker: '', model: 'Model A', sub_model: '' });
    expect(audit.after).toEqual({ maker: 'Maker', model: 'Model A', sub_model: 'Model A New' });
  });

  it('rejects product identity repairs on precondition mismatch, missing master, or retired master', async () => {
    store.set('vehicle_master/m-alpha', { id: 'm-alpha', maker: 'Maker', model: 'Model A', sub_model: 'Model A New' });
    store.set('products/p-identity', { maker: 'Other', model: 'Model A', sub_model: '' });
    const repair = { id: 'p-identity', from: { maker: '', model: 'Model A', sub_model: '' }, to: { maker: 'Maker', model: 'Model A', sub_model: 'Model A New' }, evidence: 'source text' };
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], productIdentityRepairs: [repair] })).rejects.toThrow(/precondition/);
    store.set('products/p-identity', { maker: '', model: 'Model A', sub_model: '' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productIdentityRepairs: [{ ...repair, to: { maker: 'Maker', model: 'Missing', sub_model: 'Missing New' } }] })).rejects.toThrow(/exactly one active vehicle_master/);
    store.set('vehicle_master/m-old-identity', { id: 'm-old-identity', maker: 'Maker', model: 'Old', sub_model: 'Old New', retired: true });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productIdentityRepairs: [{ ...repair, to: { maker: 'Maker', model: 'Old', sub_model: 'Old New' } }] })).rejects.toThrow(/retired master/);
  });

  it('matches product identity repairs against masters created in the same plan and catches readback drift', async () => {
    const created = { id: 'm-created-identity', evidence: 'source text', data: { id: 'm-created-identity', maker: 'Maker', model: 'Created', sub_model: 'Created New', origin: 'local' } };
    store.set('products/p-identity', { maker: '', model: '', sub_model: '' });
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterCreates: [created],
      productIdentityRepairs: [{ id: 'p-identity', from: { maker: '', model: '', sub_model: '' }, to: { maker: 'Maker', model: 'Created', sub_model: 'Created New' }, evidence: 'source text' }] });
    expect(store.get('products/p-identity')).toMatchObject({ maker: 'Maker', model: 'Created', sub_model: 'Created New' });
    const original = db.runTransaction;
    store.set('vehicle_master/m-readback', { id: 'm-readback', maker: 'Maker', model: 'Readback', sub_model: 'Readback New' });
    store.set('products/p-readback', { maker: '', model: '', sub_model: '' });
    db.runTransaction = async (fn) => { await original(fn); store.set('products/p-readback', { ...store.get('products/p-readback')!, model: 'tampered' }); };
    try {
      await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
        productIdentityRepairs: [{ id: 'p-readback', from: { maker: '', model: '', sub_model: '' }, to: { maker: 'Maker', model: 'Readback', sub_model: 'Readback New' }, evidence: 'source text' }] })).rejects.toThrow(/readback productIdentity mismatch/);
    } finally { db.runTransaction = original; }
  });
});
