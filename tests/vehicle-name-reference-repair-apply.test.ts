import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stableDigest } from '../src/shared/stable-digest.js';

// In-memory Firestore stand-in: enough of getAll/runTransaction/update/create/FieldValue for the repair path.
const store = new Map<string, Record<string, unknown>>();
const put = (path: string, data: Record<string, unknown>) => { store['set'](path, data); };
const UNION = Symbol('union');
const DELETE = Symbol('delete');
let correctionClock = 100;
type Ref = { path: string; id: string; parent: { id: string } };
const ref = (collection: string, id: string): Ref => ({ path: `${collection}/${id}`, id, parent: { id: collection } });
// Firestore returns map keys in sorted order — the stand-in does too, so readback must not depend on key order.
const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
// A snapshot is fixed at read time, like Firestore's DocumentSnapshot (later writes do not show through it).
const snap = (r: Ref) => { const at = store.has(r.path) ? sortKeys(structuredClone(store.get(r.path))) as Record<string, unknown> : undefined; return { ref: r, exists: at !== undefined, updateTime: updateTimes.get(r.path), data: () => (at === undefined ? undefined : structuredClone(at)) }; };
// 문서별 updateTime(백업 시점 고정 검증용)과 쓰기 때 걸린 precondition 기록.
const updateTimes = new Map<string, unknown>();
const preconditions: Array<[string, unknown]> = [];
const applyUpdate = (path: string, update: Record<string, unknown>) => {
  const doc = { ...store.get(path)! };
  for (const [k, v] of Object.entries(update)) {
    if (v && typeof v === 'object' && UNION in v) {
      const prev = Array.isArray(doc[k]) ? (doc[k] as unknown[]) : [];
      doc[k] = [...prev, ...((v as never)[UNION] as unknown[]).filter((x) => !prev.includes(x))];
    } else if (v === DELETE) delete doc[k];
    else doc[k] = v;
  }
  store.set(path, doc);
};
type Query = { collection: string; filters: Array<[string, unknown]>; cap?: number; where: (f: string, op: string, v: unknown) => Query; select: (...f: string[]) => Query; limit: (n: number) => Query; get: () => Promise<ReturnType<typeof runQuery>> };
const query = (collection: string, filters: Array<[string, unknown]> = [], cap?: number): Query => ({
  collection, filters, ...(cap !== undefined ? { cap } : {}), where: (f, _op, v) => query(collection, [...filters, [f, v]], cap), select: () => query(collection, filters, cap), limit: (n) => query(collection, filters, n),
  get: async () => runQuery(query(collection, filters, cap)),
});

// Like the real client: Firestore.getAll() with no references throws (10-05 운영 실행에서 커밋 뒤 감사 되읽기가 이것으로 실패).
const getAllLikeFirestore = (refs: Ref[]) => {
  if (!refs.length) throw new Error('Function "Firestore.getAll()" requires at least 1 argument');
  return refs.map(snap);
};
const runQuery = (q: Query) => {
  const docs = [...store.entries()].filter(([path, data]) => path.startsWith(`${q.collection}/`) && q.filters.every(([f, v]) => data[f] === v)).slice(0, q.cap ?? Infinity);
  return { empty: docs.length === 0, size: docs.length, docs: docs.map(([path, data]) => ({ id: path.split('/')[1]!, data: () => structuredClone(data) })) };
};
const db = {
  collection: (c: string) => ({ doc: (id: string) => ref(c, id), where: (f: string, op: string, v: unknown) => query(c).where(f, op, v), select: (...f: string[]) => query(c).select(...f), limit: (n: number) => query(c).limit(n) }),
  getAll: async (...refs: Ref[]) => getAllLikeFirestore(refs),
  runTransaction: async (fn: (t: unknown) => Promise<unknown>) => {
    const writes: Array<() => void> = [];
    const t = {
      getAll: async (...refs: Ref[]) => getAllLikeFirestore(refs),
      get: async (q: Query) => runQuery(q),
      update: (r: Ref, u: Record<string, unknown>, pre?: unknown) => { preconditions.push([r.path, pre]); writes.push(() => {
        applyUpdate(r.path, u);
        if (typeof updateTimes.get(r.path) === 'object') updateTimes.set(r.path, { seconds: correctionClock, nanoseconds: 0 });
      }); },
      create: (r: Ref, d: Record<string, unknown>) => writes.push(() => {
        if (store.has(r.path)) throw new Error('ALREADY_EXISTS');
        store.set(r.path, structuredClone(d.committedAt === 'ts' ? { ...d, committedAt: { seconds: correctionClock, nanoseconds: 0 } } : d));
        if (d.committedAt === 'ts') updateTimes.set(r.path, { seconds: correctionClock, nanoseconds: 0 }); // 같은 커밋의 모든 문서는 같은 updateTime
      }),
    };
    const result = await fn(t);
    correctionClock++;
    writes.forEach((w) => w());
    return result;
  },
};
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => db,
  FieldValue: { arrayUnion: (...v: unknown[]) => ({ [UNION]: v }), serverTimestamp: () => 'ts', delete: () => DELETE },
}));
vi.mock('../src/infra/firebase-target.js', () => ({ getTargetFirebaseApp: () => ({ options: { projectId: 'test-project' } }) }));
vi.mock('node:fs/promises', () => ({ mkdir: async () => undefined, writeFile: vi.fn(async () => undefined) }));

const { applyVehicleNameReferenceRepair, MAX_MASTER_IDENTITY_SCAN, readbackAuditEvents, vehicleNameRepairPlanDigest } = await import('../src/infra/vehicle-name-reference-repair-firestore.js');

// 상품 정체성 정정은 승인 digest(계획 전체 digest)와 함께만 적용된다 — 적용기가 직접 대조한다.
const applyApproved = (plan: Parameters<typeof applyVehicleNameReferenceRepair>[0]) => applyVehicleNameReferenceRepair(plan, { approvedPlanDigest: stableDigest(plan) });

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
  it('repairs a master title alone when it matches final maker and sub-model', async () => {
    const master = store.get('vehicle_master/m-gn7')!;
    master.title = `${master.maker} Old`;
    const to = `${master.maker} ${master.sub_model}`;
    const result = await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterTitleRepairs: [{ id: 'm-gn7', from: String(master.title), to }] });
    expect(store.get('vehicle_master/m-gn7')).toMatchObject({ title: to, vehicle_name_reference_source_digest: 'v1' });
    expect(store.get('vehicle_master/m-gn7')!.sub_model_aliases).toBeUndefined();
    expect(result).toMatchObject({ masterTitleCount: 1, readbackCount: 1, auditCount: 1 });
    const audit = [...store.entries()].find(([k]) => k.startsWith('audit_events/'))![1];
    expect(audit.before).toEqual({ title: `${master.maker} Old` });
    expect(audit.after).toEqual({ title: to });
  });
  it('repairs a master title together with a sub-model rename using the final sub-model', async () => {
    const master = store.get('vehicle_master/m-gn7')!;
    master.title = `${master.maker} Old`;
    const toTitle = `${master.maker} GN7 Final`;
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', productRepairs: [],
      masterRepairs: [{ id: 'm-gn7', from: String(master.sub_model), to: 'GN7 Final' }],
      masterTitleRepairs: [{ id: 'm-gn7', from: String(master.title), to: toTitle }] });
    expect(store.get('vehicle_master/m-gn7')).toMatchObject({ sub_model: 'GN7 Final', title: toTitle });
  });
  it('rejects master title mismatch, retired masters, and title precondition mismatches', async () => {
    const master = store.get('vehicle_master/m-gn7')!;
    master.title = `${master.maker} Old`;
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterTitleRepairs: [{ id: 'm-gn7', from: String(master.title), to: `${master.maker} Wrong` }] })).rejects.toThrow(/maker \+ sub_model/);
    expect(store.get('vehicle_master/m-gn7')!.title).toBe(`${master.maker} Old`);
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterTitleRepairs: [{ id: 'm-gn7', from: 'Other Old', to: `${master.maker} ${master.sub_model}` }] })).rejects.toThrow(/precondition/);
    master.retired = true;
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterTitleRepairs: [{ id: 'm-gn7', from: String(master.title), to: `${master.maker} ${master.sub_model}` }] })).rejects.toThrow(/retired master/);
  });
  it('compares the stored title exactly — extra spaces in the stored title are not the plan from', async () => {
    const master = store.get('vehicle_master/m-gn7')!;
    master.title = `${master.maker}  Old`;
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      masterTitleRepairs: [{ id: 'm-gn7', from: `${master.maker} Old`, to: `${master.maker} ${master.sub_model}` }] })).rejects.toThrow(/precondition/);
    expect(store.get('vehicle_master/m-gn7')!.title).toBe(`${master.maker}  Old`);
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
    store.set('products/p-identity', { maker: '', model: 'Model A', sub_model: '' });
    const result = await applyApproved({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
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
    await expect(applyApproved({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], productIdentityRepairs: [repair] })).rejects.toThrow(/precondition/);
    store.set('products/p-identity', { maker: '', model: 'Model A', sub_model: '' });
    await expect(applyApproved({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productIdentityRepairs: [{ ...repair, to: { maker: 'Maker', model: 'Missing', sub_model: 'Missing New' } }] })).rejects.toThrow(/exactly one active vehicle_master/);
    store.set('vehicle_master/m-old-identity', { id: 'm-old-identity', maker: 'Maker', model: 'Old', sub_model: 'Old New', retired: true });
    await expect(applyApproved({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productIdentityRepairs: [{ ...repair, to: { maker: 'Maker', model: 'Old', sub_model: 'Old New' } }] })).rejects.toThrow(/retired master/);
  });

  it('compares product identity from cells by exact stored spelling only', async () => {
    store.set('vehicle_master/m-alpha', { id: 'm-alpha', maker: 'Maker', model: 'Model A', sub_model: 'Model A New' });
    const repair = { id: 'p-identity', from: { maker: '', model: 'Model A', sub_model: '' }, to: { maker: 'Maker', model: 'Model A', sub_model: 'Model A New' }, evidence: 'source text' };
    store.set('products/p-identity', { maker: '', model: ' Model A ', sub_model: '' });
    await expect(applyApproved({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], productIdentityRepairs: [repair] })).rejects.toThrow(/productIdentity precondition changed/);
    store.set('products/p-identity', { maker: ' ', model: 'Model A', sub_model: '' });
    await expect(applyApproved({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], productIdentityRepairs: [repair] })).rejects.toThrow(/productIdentity precondition changed/);
    store.set('products/p-identity', { model: 'Model A' });
    await expect(applyApproved({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], productIdentityRepairs: [repair] })).resolves.toMatchObject({ productIdentityCount: 1 });
  });

  it('matches product identity repairs against masters created in the same plan and catches readback drift', async () => {
    const created = { id: 'm-created-identity', evidence: 'source text', data: { id: 'm-created-identity', maker: 'Maker', model: 'Created', sub_model: 'Created New', origin: 'local' } };
    store.set('products/p-identity', { maker: '', model: '', sub_model: '' });
    await applyApproved({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], masterCreates: [created],
      productIdentityRepairs: [{ id: 'p-identity', from: { maker: '', model: '', sub_model: '' }, to: { maker: 'Maker', model: 'Created', sub_model: 'Created New' }, evidence: 'source text' }] });
    expect(store.get('products/p-identity')).toMatchObject({ maker: 'Maker', model: 'Created', sub_model: 'Created New' });
    const original = db.runTransaction;
    store.set('vehicle_master/m-readback', { id: 'm-readback', maker: 'Maker', model: 'Readback', sub_model: 'Readback New' });
    store.set('products/p-readback', { maker: '', model: '', sub_model: '' });
    db.runTransaction = async (fn) => { await original(fn); store.set('products/p-readback', { ...store.get('products/p-readback')!, model: 'tampered' }); };
    try {
      await expect(applyApproved({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
        productIdentityRepairs: [{ id: 'p-readback', from: { maker: '', model: '', sub_model: '' }, to: { maker: 'Maker', model: 'Readback', sub_model: 'Readback New' }, evidence: 'source text' }] })).rejects.toThrow(/readback productIdentity mismatch/);
    } finally { db.runTransaction = original; }
  });

  it('rejects product identity when stored spelling changes between backup and transaction', async () => {
    store.set('vehicle_master/m-spelling', { id: 'm-spelling', maker: 'Maker', model: 'Spelling', sub_model: 'Spelling New' });
    store.set('products/p-spelling', { model: 'Spelling' });
    const original = db.runTransaction;
    db.runTransaction = async (fn) => {
      store.set('products/p-spelling', { maker: null, model: 'Spelling', sub_model: undefined });
      return original(fn);
    };
    try {
      await expect(applyApproved({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
        productIdentityRepairs: [{ id: 'p-spelling', from: { maker: '', model: 'Spelling', sub_model: '' }, to: { maker: 'Maker', model: 'Spelling', sub_model: 'Spelling New' }, evidence: 'source text' }] }))
        .rejects.toThrow(/stored spelling changed since backup/);
    } finally { db.runTransaction = original; }
  });
});

describe('product identity applier guards (Codex 적용기 검토 5건)', () => {
  const master = { id: 'm-alpha', maker: 'Maker', model: 'Model A', sub_model: 'Model A New' };
  const repair = { id: 'p-guard', from: { maker: '', model: '', sub_model: '' }, to: { maker: 'Maker', model: 'Model A', sub_model: 'Model A New' }, evidence: 'source text' };
  const plan = (over: Record<string, unknown> = {}) => ({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [], productIdentityRepairs: [repair], ...over });
  beforeEach(() => { store.set('vehicle_master/m-alpha', master); updateTimes.clear(); preconditions.length = 0; });

  it('(a) refuses a settlement-locked product, including string lock values', async () => {
    for (const lock of ['LEDGER', true, 'anything']) {
      store.set('products/p-guard', { maker: '', model: '', sub_model: '', locked_by_contract: lock });
      await expect(applyApproved(plan())).rejects.toThrow(/product write refused LOCKED_BY_CONTRACT/);
    }
    store.set('products/p-guard', { maker: '', model: '', sub_model: '', locked_by_contract: null });
    await expect(applyApproved(plan())).resolves.toMatchObject({ productIdentityCount: 1 });
  });

  it('(b) refuses a product that carries a publication_withdrawal marker', async () => {
    store.set('products/p-guard', { maker: '', model: '', sub_model: '', publication_withdrawal: { reason: 'REPLACED_BY_API', at: 'x' } });
    await expect(applyApproved(plan())).rejects.toThrow(/product write refused PUBLICATION_WITHDRAWN/);
    store.set('products/p-guard', { maker: '', model: '', sub_model: '', publication_withdrawal: null });
    await expect(applyApproved(plan())).resolves.toMatchObject({ productIdentityCount: 1 });
  });

  it('(c) overwrites only engine-temporary or blank/raw-chunk values, never a manual/confirmed sub_model', async () => {
    const confirmed = { ...repair, from: { maker: 'Human', model: 'Typed', sub_model: 'Typed Sub' } };
    store.set('products/p-guard', { maker: 'Human', model: 'Typed', sub_model: 'Typed Sub' });
    await expect(applyApproved(plan({ productIdentityRepairs: [confirmed] }))).rejects.toThrow(/manual or confirmed value/);
    // 엔진 임시 표식이 있으면 허용
    store.set('products/p-guard', { maker: 'Human', model: 'Typed', sub_model: 'Typed Sub', vehicle_review_required: true });
    await expect(applyApproved(plan({ productIdentityRepairs: [confirmed] }))).resolves.toMatchObject({ productIdentityCount: 1 });
    // 원문 덩어리 그대로(제조사·모델 빈칸)이면 허용
    store.set('products/p-guard', { maker: '', model: '', sub_model: 'RAW CHUNK', 원문: { 차명: 'RAW CHUNK' } });
    const rawRepair = { ...repair, from: { maker: '', model: '', sub_model: 'RAW CHUNK' } };
    await expect(applyApproved(plan({ productIdentityRepairs: [rawRepair] }))).resolves.toMatchObject({ productIdentityCount: 1 });
    // 원문과 다른 세부모델 값은 «원문 덩어리»가 아니다
    store.set('products/p-guard', { maker: '', model: '', sub_model: 'Typed Sub', 원문: { 차명: 'RAW CHUNK' } });
    await expect(applyApproved(plan({ productIdentityRepairs: [{ ...repair, from: { maker: '', model: '', sub_model: 'Typed Sub' } }] }))).rejects.toThrow(/manual or confirmed value/);
  });

  it('(d) pins the write to the backed-up updateTime and refuses when other fields changed since backup', async () => {
    store.set('products/p-guard', { maker: '', model: '', sub_model: '', note: 'before' });
    updateTimes.set('products/p-guard', 'T1');
    await applyApproved(plan());
    expect(preconditions).toEqual([['products/p-guard', { lastUpdateTime: 'T1' }]]);
    // 세 칸이 같아도 다른 칸이 백업 뒤 바뀌었으면 거절(전체 digest)
    store.set('products/p-guard', { maker: '', model: '', sub_model: '', note: 'before' });
    const original = db.runTransaction;
    db.runTransaction = async (fn) => { store.set('products/p-guard', { maker: '', model: '', sub_model: '', note: 'changed by engine' }); return original(fn); };
    try { await expect(applyApproved(plan())).rejects.toThrow(/product changed since backup/); } finally { db.runTransaction = original; }
  });

  it('(e) the applier itself compares the approved plan digest', async () => {
    store.set('products/p-guard', { maker: '', model: '', sub_model: '' });
    await expect(applyVehicleNameReferenceRepair(plan(), { approvedPlanDigest: 'wrong' })).rejects.toThrow(/approved plan digest mismatch/);
    await expect(applyVehicleNameReferenceRepair(plan())).rejects.toThrow(/approved plan digest required/);
    await expect(applyVehicleNameReferenceRepair(plan(), { approvedPlanDigest: stableDigest(plan()) })).resolves.toMatchObject({ productIdentityCount: 1 });
    // 승인 digest 가 없어도 상품 정체성 정정이 없는 옛 계획은 그대로 적용된다(호환)
    expect(store.get('products/p-guard')).toMatchObject({ sub_model: 'Model A New' });
  });

  it('모델 수준(level MODEL): 제조사·모델만 쓰고 세부모델은 저장된 글자 그대로 유지, 백업·되읽기·사람 입력 거절은 그대로', async () => {
    const raw = '현대  더 뉴 싼타페 HEV 1.6 2WD';   // 공백이 정규화되지 않은 원문형 값(그대로 유지되어야 한다)
    const model = { id: 'p-model', level: 'MODEL' as const, from: { maker: '', model: '', sub_model: raw }, to: { maker: 'Maker', model: 'Model A', sub_model: raw }, evidence: 'master 항목·연식∈기간' };
    store.set('products/p-model', { maker: '', model: '', sub_model: raw, vehicle_review_required: true, 원문: { 차명: raw } });
    await expect(applyApproved(plan({ productIdentityRepairs: [model] }))).resolves.toMatchObject({ productIdentityCount: 1, readbackCount: 1 });
    expect(store.get('products/p-model')).toMatchObject({ maker: 'Maker', model: 'Model A', sub_model: raw, vehicle_review_required: true });
    // 마스터에 없는 제조사·모델은 거절
    store.set('products/p-model', { maker: '', model: '', sub_model: raw, vehicle_review_required: true, 원문: { 차명: raw } });
    await expect(applyApproved(plan({ productIdentityRepairs: [{ ...model, to: { maker: 'Maker', model: 'Nope', sub_model: raw } }] }))).rejects.toThrow(/exactly one active vehicle_master/);
    // 사람 입력(검토 완료·원문과 다른 세부모델)은 거절
    store.set('products/p-model', { maker: '', model: '', sub_model: raw, 원문: { 차명: 'something else' } });
    await expect(applyApproved(plan({ productIdentityRepairs: [model] }))).rejects.toThrow(/manual or confirmed value/);
  });

  it('모델 수준 + 저장 세부모델 빈칸: 제조사·모델만 채우고 세부모델 칸은 쓰지 않는다(없던 칸이 생기지 않음), 값이 있으면 종전 규칙', async () => {
    const blank = { id: 'p-nosub', level: 'MODEL' as const, from: { maker: '', model: '', sub_model: '' }, to: { maker: 'Maker', model: 'Model A', sub_model: '' }, evidence: 'master 항목·연식∈기간' };
    store.set('products/p-nosub', { maker: '', model: '' });   // sub_model 칸 자체가 없음
    await expect(applyApproved(plan({ productIdentityRepairs: [blank] }))).resolves.toMatchObject({ productIdentityCount: 1, readbackCount: 1 });
    expect(store.get('products/p-nosub')).toMatchObject({ maker: 'Maker', model: 'Model A' });
    expect(store.get('products/p-nosub')).not.toHaveProperty('sub_model');
    // 마스터에 없는 모델은 여전히 거절
    store.set('products/p-nosub', { maker: '', model: '' });
    await expect(applyApproved(plan({ productIdentityRepairs: [{ ...blank, to: { maker: 'Maker', model: 'Nope', sub_model: '' } }] }))).rejects.toThrow(/exactly one active vehicle_master/);
    // 전체 정정(level 없음)은 여전히 to.sub_model 필수
    await expect(applyApproved(plan({ productIdentityRepairs: [{ ...blank, level: undefined }] }))).rejects.toThrow(/requires a non-empty value/);
  });

  it('Codex #664 확인: false·빈 문자열·null·undefined 는 «잠금/철회 아님»이고, 빈 객체·문자열·true 는 표식 있음(보수)', async () => {
    for (const value of [null, undefined, false, '']) {
      store.set('products/p-guard', { maker: '', model: '', sub_model: '', locked_by_contract: value, publication_withdrawal: value });
      await expect(applyApproved(plan())).resolves.toMatchObject({ productIdentityCount: 1 });
      store.set('products/p-guard', { maker: '', model: '', sub_model: '' });
    }
    for (const marker of [{}, 'x', true, 0]) {
      store.set('products/p-guard', { maker: '', model: '', sub_model: '', publication_withdrawal: marker });
      await expect(applyApproved(plan())).rejects.toThrow(/PUBLICATION_WITHDRAWN/);
      store.set('products/p-guard', { maker: '', model: '', sub_model: '', locked_by_contract: marker });
      await expect(applyApproved(plan())).rejects.toThrow(/LOCKED_BY_CONTRACT/);
    }
  });

  it('(a)(b) also protect productTrim name repairs', async () => {
    store.set('products/p-trim', { trim_name: 'Old', locked_by_contract: 'LEDGER' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productTrimRepairs: [{ id: 'p-trim', from: 'Old', to: 'New' }] })).rejects.toThrow(/product write refused LOCKED_BY_CONTRACT/);
    store.set('products/p-trim', { trim_name: 'Old', publication_withdrawal: { at: 'x' } });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productTrimRepairs: [{ id: 'p-trim', from: 'Old', to: 'New' }] })).rejects.toThrow(/product write refused PUBLICATION_WITHDRAWN/);
  });
});

describe('product source correction apply path', () => {
  const correction = {
    차명: '쏘나타',
    연식: '2021',
    최초등록: null,
    연료: '가솔린',
    배기량: '1999',
    출처: '외부 차량번호 사양 조회',
    조회일: '2026-10-05',
    비고: '원문으로 단정 불가',
  };

  it('archives a product source correction without changing 원문', async () => {
    store.set('products/p-source', { 원문: { supplier: 'first raw' } });
    const result = await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productSourceCorrections: [{ id: 'p-source', correction, expectedCurrentDigest: stableDigest(null), evidence: 'plate lookup result' }] });
    expect(store.get('products/p-source')).toMatchObject({
      원문: { supplier: 'first raw' },
      원문_정정: { ...correction, key: expect.any(String), 기록시각: expect.stringMatching(/^20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/), sourceDigest: 'v1' },
      원문_정정_이력: [{ ...correction, key: expect.any(String), 기록시각: expect.stringMatching(/^20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/), sourceDigest: 'v1' }],
      vehicle_name_reference_checked_at: 'ts',
      vehicle_name_reference_source_digest: 'v1',
    });
    expect(result).toMatchObject({ productSourceCorrectionCount: 1, readbackCount: 1, auditCount: 1 });
    const audit = [...store.entries()].find(([k]) => k.startsWith('audit_events/'))![1];
    expect(audit.before).toEqual({ 원문_정정: null });
    expect(audit.after).toEqual({ 원문_정정: { ...correction, sourceDigest: 'v1', key: expect.any(String) } });
  });

  it('combines source correction with a product trim repair for the same product', async () => {
    store.set('products/p-source', { 원문: 'raw text', trim_name: 'Old Trim' });
    const result = await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productTrimRepairs: [{ id: 'p-source', from: 'Old Trim', to: 'New Trim' }],
      productSourceCorrections: [{ id: 'p-source', correction, expectedCurrentDigest: stableDigest(null), evidence: 'plate lookup result' }] });
    expect(store.get('products/p-source')).toMatchObject({
      원문: 'raw text',
      trim_name: 'New Trim',
      원문_정정: { ...correction, key: expect.any(String), 기록시각: expect.stringMatching(/^20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]T/), sourceDigest: 'v1' },
    });
    expect(result).toMatchObject({ productTrimCount: 1, productSourceCorrectionCount: 1, readbackCount: 2, auditCount: 2 });
  });

  it('rejects missing product and catches concurrent source-correction changes', async () => {
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productSourceCorrections: [{ id: 'missing-source', correction, expectedCurrentDigest: stableDigest(null), evidence: 'plate lookup result' }] })).rejects.toThrow(/target missing/);
    store.set('products/p-source', { 원문: 'raw text', 원문_정정: { ...correction, sourceDigest: 'old' }, 원문_정정_이력: [{ ...correction, sourceDigest: 'old' }] });
    const expectedCurrentDigest = stableDigest(store.get('products/p-source')!.원문_정정);
    const original = db.runTransaction;
    db.runTransaction = async (fn) => {
      store.set('products/p-source', { ...store.get('products/p-source')!, 원문_정정: { ...correction, sourceDigest: 'changed' } });
      return original(fn);
    };
    try {
      await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
        productSourceCorrections: [{ id: 'p-source', correction, expectedCurrentDigest, evidence: 'plate lookup result' }] }))
        .rejects.toThrow(/expectedCurrentDigest mismatch/);
    } finally { db.runTransaction = original; }
    expect(store.get('products/p-source')!.원문_정정).toMatchObject({ sourceDigest: 'changed' });
  });

  it('refuses to overwrite a stored 원문_정정 that is missing from 원문_정정_이력 (it would be lost)', async () => {
    store.set('products/p-source', { 원문: 'raw text', 원문_정정: { ...correction, sourceDigest: 'old' } });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productSourceCorrections: [{ id: 'p-source', correction, expectedCurrentDigest: stableDigest(store.get('products/p-source')!.원문_정정), evidence: 'plate lookup result' }] }))
      .rejects.toThrow(/would be lost/);
    expect(store.get('products/p-source')).toMatchObject({ 원문_정정: { sourceDigest: 'old' } });
    expect(store.get('products/p-source')!.원문_정정_이력).toBeUndefined();
  });

  it('catches a 원문 change between backup and transaction', async () => {
    store.set('products/p-source', { 원문: 'raw text' });
    const original = db.runTransaction;
    db.runTransaction = async (fn) => {
      store.set('products/p-source', { ...store.get('products/p-source')!, 원문: 'changed raw text' });
      return original(fn);
    };
    try {
      await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
        productSourceCorrections: [{ id: 'p-source', correction, expectedCurrentDigest: stableDigest(null), evidence: 'plate lookup result' }] }))
        .rejects.toThrow(/original source changed/);
    } finally { db.runTransaction = original; }
  });

  it('skips a rerun when the same correction key is already in history', async () => {
    put('products/p-source', { 원문: 'raw text' });
    const plan = { sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productSourceCorrections: [{ id: 'p-source', correction, expectedCurrentDigest: stableDigest(null), evidence: 'plate lookup result' }] };
    const first = await applyVehicleNameReferenceRepair(plan);
    const afterFirst = structuredClone(store.get('products/p-source')!);
    const second = await applyVehicleNameReferenceRepair(plan);
    expect(second).toMatchObject({ productSourceCorrectionCount: 1, skippedAlreadyApplied: 1, readbackCount: 0, auditCount: 0 });
    expect(first.skippedAlreadyApplied).toBe(0);
    expect(store.get('products/p-source')!.원문_정정_이력).toHaveLength(1);
    expect(store.get('products/p-source')).toEqual(afterFirst);
    expect([...store.keys()].filter((k) => k.startsWith('audit_events/'))).toHaveLength(1);
  });

  it('rejects stale expectedCurrentDigest before writing anything', async () => {
    put('products/p-source', { 원문: 'raw text', 원문_정정: { ...correction, sourceDigest: 'current' } });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productSourceCorrections: [{ id: 'p-source', correction, expectedCurrentDigest: stableDigest(null), evidence: 'plate lookup result' }] }))
      .rejects.toThrow(/expectedCurrentDigest mismatch/);
    expect(store.get('products/p-source')!.원문_정정).toMatchObject({ sourceDigest: 'current' });
    expect([...store.keys()].filter((k) => k.startsWith('audit_events/'))).toHaveLength(0);
  });

  it('rejects non-array source correction history before and inside the transaction', async () => {
    put('products/p-source', { 원문: 'raw text', 원문_정정_이력: { bad: true } });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productSourceCorrections: [{ id: 'p-source', correction, expectedCurrentDigest: stableDigest(null), evidence: 'plate lookup result' }] }))
      .rejects.toThrow(/history is not a list/);
    put('products/p-source', { 원문: 'raw text' });
    const original = db.runTransaction;
    db.runTransaction = async (fn) => {
      put('products/p-source', { ...store.get('products/p-source')!, 원문_정정_이력: 'bad' });
      return original(fn);
    };
    try {
      await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
        productSourceCorrections: [{ id: 'p-source', correction, expectedCurrentDigest: stableDigest(null), evidence: 'plate lookup result' }] }))
        .rejects.toThrow(/history is not a list/);
    } finally { db.runTransaction = original; }
  });

  it('preserves existing history order and appends exactly one new correction', async () => {
    const previous = { key: 'old-key', sourceDigest: 'old', 기록시각: '2026-10-04T00:00:00.000Z', 출처: 'old source' };
    put('products/p-source', { 원문: 'raw text', 원문_정정_이력: [previous] });
    await applyVehicleNameReferenceRepair({ sourceDigest: 'v1', masterRepairs: [], productRepairs: [],
      productSourceCorrections: [{ id: 'p-source', correction, expectedCurrentDigest: stableDigest(null), evidence: 'plate lookup result' }] });
    const doc = store.get('products/p-source')!;
    expect(doc.원문_정정_이력).toHaveLength(2);
    expect((doc.원문_정정_이력 as unknown[])[0]).toEqual(previous);
    expect((doc.원문_정정_이력 as unknown[])[1]).toEqual(doc.원문_정정);
  });
});

describe('audit readback', () => {
  const fakeDb = (docs: Array<{ reason: string }>) => ({ getAll: async (...refs: number[]) => {
    if (!refs.length) throw new Error('Function "Firestore.getAll()" requires at least 1 argument');
    return refs.map((i) => ({ exists: true, data: () => docs[i] }));
  } });
  it('skips the read only when there are no audits and no refs', async () => {
    await expect(readbackAuditEvents(fakeDb([]), [], [], 'm')).resolves.toEqual([]);
  });
  it('refuses refs that do not match the audits (count) instead of skipping', async () => {
    await expect(readbackAuditEvents(fakeDb([{ reason: 'a' }]), [], [{ reason: 'a' }], 'readback audit mismatch')).rejects.toThrow(/0 audit refs for 1 audits/);
    await expect(readbackAuditEvents(fakeDb([{ reason: 'a' }]), [0], [], 'readback audit mismatch')).rejects.toThrow(/1 audit refs for 0 audits/);
  });
  it('checks each audit reason', async () => {
    await expect(readbackAuditEvents(fakeDb([{ reason: 'a' }]), [0], [{ reason: 'a' }], 'm')).resolves.toHaveLength(1);
    await expect(readbackAuditEvents(fakeDb([{ reason: 'x' }]), [0], [{ reason: 'a' }], 'readback audit mismatch')).rejects.toThrow(/readback audit mismatch/);
  });
});

// 제조사명 정정(기준 한 장 규칙 7 «짧게»: 르노코리아→르노, KG모빌리티→KGM): 마스터·세부트림 행·표시명·상품이 같은 제조사명으로 함께 옮겨 간다. 옛 이름은 별칭으로 남는다.
describe('maker rename repair (masterMaker / trimMaker / productMaker)', () => {
  beforeEach(() => {
    store.clear();
    store.set('vehicle_master/m-arkana', { id: 'm-arkana', maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL', title: '르노코리아 아르카나 LJL' });
    store.set('vehicle_trim_master/t-a1', { maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL', master_id: 'm-arkana', trim: '이스타일' });
    store.set('vehicle_trim_master/t-a2', { maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL', master_id: 'm-arkana', trim: '아이코닉' });
    store.set('products/p-arkana', { maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL', car_number: '12가1234' });
  });
  const masterPlan = {
    sourceDigest: 'maker-v1', masterRepairs: [], productRepairs: [],
    masterMakerRepairs: [{ id: 'm-arkana', from: '르노코리아', to: '르노' }],
    trimMakerRepairs: [{ id: 't-a1', from: '르노코리아', to: '르노' }, { id: 't-a2', from: '르노코리아', to: '르노' }],
    masterTitleRepairs: [{ id: 'm-arkana', from: '르노코리아 아르카나 LJL', to: '르노 아르카나 LJL' }],
  };
  it('renames the master, its trim rows and its title together and keeps the old name as maker_aliases', async () => {
    const result = await applyApproved(masterPlan);
    expect(store.get('vehicle_master/m-arkana')).toMatchObject({ maker: '르노', title: '르노 아르카나 LJL', maker_aliases: ['르노코리아'] });
    expect(store.get('vehicle_trim_master/t-a1')).toMatchObject({ maker: '르노', maker_aliases: ['르노코리아'] });
    expect(store.get('vehicle_trim_master/t-a2')).toMatchObject({ maker: '르노', maker_aliases: ['르노코리아'] });
    expect(result).toMatchObject({ masterMakerCount: 1, trimMakerCount: 2, masterTitleCount: 1 });
  });
  it('refuses a master maker rename that leaves a linked trim row on the old maker', async () => {
    await expect(applyApproved({ ...masterPlan, trimMakerRepairs: [{ id: 't-a1', from: '르노코리아', to: '르노' }] }))
      .rejects.toThrow(/maker would differ between vehicle_master\/m-arkana/);
    expect(store.get('vehicle_master/m-arkana')).toMatchObject({ maker: '르노코리아' });
  });
  it('refuses a rename onto an existing identical master identity (값 하나)', async () => {
    store.set('vehicle_master/m-dup', { id: 'm-dup', maker: '르노', model: '아르카나', sub_model: '아르카나 LJL' });
    await expect(applyApproved(masterPlan)).rejects.toThrow(/master sub-model would be stored twice/);
  });
  it('refuses a stale from (precondition) and a retired master', async () => {
    await expect(applyApproved({ ...masterPlan, masterMakerRepairs: [{ id: 'm-arkana', from: 'KG모빌리티', to: '르노' }] })).rejects.toThrow(/precondition changed/);
    store.set('vehicle_master/m-arkana', { ...store.get('vehicle_master/m-arkana')!, retired: true });
    await expect(applyApproved(masterPlan)).rejects.toThrow(/retired master/);
  });
  it('renames a product maker only when it lands on exactly one active master and the product is not locked', async () => {
    await applyApproved(masterPlan);
    const productPlan = { sourceDigest: 'maker-v1-products', masterRepairs: [], productRepairs: [], productMakerRepairs: [{ id: 'p-arkana', from: '르노코리아', to: '르노' }] };
    await applyApproved(productPlan);
    expect(store.get('products/p-arkana')).toMatchObject({ maker: '르노', model: '아르카나', sub_model: '아르카나 LJL' });
    store.set('products/p-locked', { maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL', locked_by_contract: true });
    await expect(applyApproved({ ...productPlan, productMakerRepairs: [{ id: 'p-locked', from: '르노코리아', to: '르노' }] })).rejects.toThrow(/LOCKED_BY_CONTRACT/);
  });
  it('refuses a product maker repair when no active master carries the target identity', async () => {
    await expect(applyApproved({ sourceDigest: 'x', masterRepairs: [], productRepairs: [],
      productMakerRepairs: [{ id: 'p-arkana', from: '르노코리아', to: '르노' }] })).rejects.toThrow(/does not match exactly one active vehicle_master/);
  });
  it('validates: product maker repairs must not overlap other product repairs; no-op and non-normalized names refused', async () => {
    await expect(applyApproved({ sourceDigest: 'x', masterRepairs: [], productRepairs: [{ id: 'p-arkana', from: 'a', to: 'b' }],
      productMakerRepairs: [{ id: 'p-arkana', from: '르노코리아', to: '르노' }] })).rejects.toThrow(/one product per plan/);
    await expect(applyApproved({ ...masterPlan, masterMakerRepairs: [{ id: 'm-arkana', from: '르노코리아', to: '르노코리아' }] })).rejects.toThrow(/no-op/);
    await expect(applyApproved({ ...masterPlan, masterMakerRepairs: [{ id: 'm-arkana', from: '르노코리아', to: ' 르노' }] })).rejects.toThrow(/normalized/);
  });
  it('(c) approved plan digest is mandatory for maker repairs, and must match', async () => {
    await expect(applyVehicleNameReferenceRepair(masterPlan)).rejects.toThrow(/approved plan digest required for maker repairs/);
    await expect(applyVehicleNameReferenceRepair(masterPlan, { approvedPlanDigest: 'wrong' })).rejects.toThrow(/approved plan digest mismatch/);
    expect(store.get('vehicle_master/m-arkana')).toMatchObject({ maker: '르노코리아' });
    await expect(applyVehicleNameReferenceRepair({ sourceDigest: 'p', masterRepairs: [], productRepairs: [],
      productMakerRepairs: [{ id: 'p-arkana', from: '르노코리아', to: '르노' }] })).rejects.toThrow(/approved plan digest required for maker repairs/);
  });
  it('(a) a non-standard master title aborts the whole plan; a standard one must be repaired together; a blank one is left as is', async () => {
    store.set('vehicle_master/m-arkana', { ...store.get('vehicle_master/m-arkana')!, title: '르노 아르카나(구형 표기)' });
    await expect(applyApproved({ ...masterPlan, masterTitleRepairs: [] })).rejects.toThrow(/not the standard maker \+ sub_model form/);
    expect(store.get('vehicle_master/m-arkana')).toMatchObject({ maker: '르노코리아' });
    store.set('vehicle_master/m-arkana', { ...store.get('vehicle_master/m-arkana')!, title: '르노코리아 아르카나 LJL' });
    await expect(applyApproved({ ...masterPlan, masterTitleRepairs: [] })).rejects.toThrow(/requires a masterTitle repair in the same plan/);
    store.set('vehicle_master/m-arkana', { id: 'm-arkana', maker: '르노코리아', model: '아르카나', sub_model: '아르카나 LJL' });   // 표시명 없음
    { const { masterTitleRepairs: _omit, ...noTitle } = masterPlan; await applyApproved(noTitle); }
    expect(store.get('vehicle_master/m-arkana')).toMatchObject({ maker: '르노' });
    expect(store.get('vehicle_master/m-arkana')!.title).toBeUndefined();
  });
  it('(b) a product maker rename keeps the old name in maker_aliases and checks it on readback', async () => {
    await applyApproved(masterPlan);
    await applyApproved({ sourceDigest: 'p', masterRepairs: [], productRepairs: [], productMakerRepairs: [{ id: 'p-arkana', from: '르노코리아', to: '르노' }] });
    expect(store.get('products/p-arkana')).toMatchObject({ maker: '르노', maker_aliases: ['르노코리아'] });
  });
});

// 별칭 정규화(사람 입력 보존 안전선의 유일한 예외): 확정·사람 입력 세부모델이 대상 마스터의 «등록 별칭» 일 때만 마스터 이름으로 바꾼다. 트림·제조사·모델은 그대로.
describe('alias canonicalization of a confirmed product identity', () => {
  beforeEach(() => {
    store.clear();
    store.set('vehicle_master/m-ax1', { id: 'm-ax1', maker: '현대', model: '캐스퍼', sub_model: '캐스퍼 AX1', sub_model_aliases: ['캐스퍼'] });
    store.set('products/p1', { maker: '현대', model: '캐스퍼', sub_model: '캐스퍼', trim_name: '스마트', car_number: '12가1234' });
  });
  const plan = (over: Record<string, unknown> = {}) => ({ sourceDigest: 'alias-v1', masterRepairs: [], productRepairs: [],
    productIdentityRepairs: [{ id: 'p1', from: { maker: '현대', model: '캐스퍼', sub_model: '캐스퍼' }, to: { maker: '현대', model: '캐스퍼', sub_model: '캐스퍼 AX1' },
      evidence: '원문 차명: 현대_캐스퍼_가솔린 1.0 밴_스마트', ...over }] });
  it('renames the confirmed sub-model to the master name when from is the target master\'s unique registered alias; trim and maker/model untouched', async () => {
    const result = await applyApproved(plan());
    expect(store.get('products/p1')).toMatchObject({ maker: '현대', model: '캐스퍼', sub_model: '캐스퍼 AX1', trim_name: '스마트' });
    expect(result).toMatchObject({ productIdentityCount: 1, readbackCount: 1 });
  });
  it('refuses when from is not a registered alias of the target master', async () => {
    store.set('vehicle_master/m-ax1', { id: 'm-ax1', maker: '현대', model: '캐스퍼', sub_model: '캐스퍼 AX1', sub_model_aliases: [] });
    await expect(applyApproved(plan())).rejects.toThrow(/manual or confirmed value/);
    expect(store.get('products/p1')).toMatchObject({ sub_model: '캐스퍼' });
  });
  it('refuses when two active masters of the same family register the same alias (not unconditional)', async () => {
    store.set('vehicle_master/m-new', { id: 'm-new', maker: '현대', model: '캐스퍼', sub_model: '더 뉴 캐스퍼 AX1', sub_model_aliases: ['캐스퍼'] });
    await expect(applyApproved(plan())).rejects.toThrow(/not a unique registered alias/);
  });
  it('refuses a change of maker or model, and a locked or withdrawn product', async () => {
    store.set('vehicle_master/m-other', { id: 'm-other', maker: '기아', model: '레이', sub_model: '레이 TAM', sub_model_aliases: ['캐스퍼'] });
    await expect(applyApproved(plan({ to: { maker: '기아', model: '레이', sub_model: '레이 TAM' } }))).rejects.toThrow(/manual or confirmed value/);
    store.set('products/p1', { ...store.get('products/p1')!, locked_by_contract: true });
    await expect(applyApproved(plan())).rejects.toThrow(/LOCKED_BY_CONTRACT/);
  });
  it('Codex #683 (a): a human-chosen or confirmed identity is never canonicalized, even when it equals the unique alias', async () => {
    for (const marker of [{ vehicle_title_source: 'MANUAL' }, { confirmed_by: 'someone' }, { identity_manual_override: true }]) {
      store.set('products/p1', { maker: '현대', model: '캐스퍼', sub_model: '캐스퍼', trim_name: '스마트', car_number: '12가1234', ...marker });
      await expect(applyApproved(plan())).rejects.toThrow(/manual or confirmed value/);
      expect(store.get('products/p1')).toMatchObject({ sub_model: '캐스퍼' });
    }
    // 기계 출처(MASTER_MATCH)·표식 없음은 허용
    store.set('products/p1', { maker: '현대', model: '캐스퍼', sub_model: '캐스퍼', trim_name: '스마트', car_number: '12가1234', vehicle_title_source: 'MASTER_MATCH' });
    await applyApproved(plan());
    expect(store.get('products/p1')).toMatchObject({ sub_model: '캐스퍼 AX1' });
  });
  it('Codex #683 (b): maker/model must match the raw stored strings exactly (no normalization-only equality); the write never changes them', async () => {
    store.set('products/p1', { maker: '현대', model: '캐스퍼', sub_model: '캐스퍼', trim_name: '스마트', car_number: '12가1234' });
    await expect(applyApproved(plan({ from: { maker: '현대 ', model: '캐스퍼', sub_model: '캐스퍼' } }))).rejects.toThrow();
    await expect(applyApproved(plan({ from: { maker: '현대', model: '캐스퍼', sub_model: '캐스퍼' }, to: { maker: '현대', model: '캐스퍼 ', sub_model: '캐스퍼 AX1' } }))).rejects.toThrow();
    expect(store.get('products/p1')).toMatchObject({ maker: '현대', model: '캐스퍼', sub_model: '캐스퍼' });
  });
  it('Codex #683 ①: a confirmed / human-source marker blocks even an engine-temporary (vehicle_review_required) product', async () => {
    for (const marker of [{ confirmed: true }, { vehicle_title_source: 'HUMAN_ENTRY' }]) {
      store.set('products/p1', { maker: '현대', model: '캐스퍼', sub_model: '캐스퍼', trim_name: '스마트', car_number: '12가1234', vehicle_review_required: true, ...marker });
      await expect(applyApproved(plan())).rejects.toThrow(/manual or confirmed value/);
      expect(store.get('products/p1')).toMatchObject({ sub_model: '캐스퍼' });
    }
  });
  it('Codex #683 ②: a from that is another active master canonical name is never moved by alias canonicalization', async () => {
    store.set('vehicle_master/m-b', { id: 'm-b', maker: '현대', model: '캐스퍼', sub_model: '캐스퍼', sub_model_aliases: [] });   // 다른 활성 마스터의 정식 이름 «캐스퍼»
    await expect(applyApproved(plan())).rejects.toThrow(/canonical name|manual or confirmed value/);
    expect(store.get('products/p1')).toMatchObject({ sub_model: '캐스퍼' });
  });
  it('Codex #683: productRepairs / productMakerRepairs refuse human-source or confirmed products; masterCreates canonical names also block', async () => {
    store.set('products/p1', { maker: '현대', model: '캐스퍼', sub_model: '캐스퍼', trim_name: '스마트', car_number: '12가1234', confirmed: true });
    await expect(applyApproved({ sourceDigest: 'x', masterRepairs: [], productRepairs: [{ id: 'p1', from: '캐스퍼', to: '캐스퍼 AX1' }] })).rejects.toThrow(/HUMAN_OR_CONFIRMED/);
    await expect(applyApproved({ sourceDigest: 'y', masterRepairs: [], productRepairs: [], productMakerRepairs: [{ id: 'p1', from: '현대', to: '현대자동차' }] })).rejects.toThrow();
    expect(store.get('products/p1')).toMatchObject({ maker: '현대', sub_model: '캐스퍼' });
    // 같은 계획이 만드는 마스터의 정식 이름과 from 이 같으면 별칭 정규화 금지
    store.set('products/p1', { maker: '현대', model: '캐스퍼', sub_model: '캐스퍼', trim_name: '스마트', car_number: '12가1234' });
    await expect(applyApproved({ ...plan(), masterCreates: [{ id: 'm-new', evidence: '근거', data: { id: 'm-new', maker: '현대', model: '캐스퍼', sub_model: '캐스퍼', origin: '국산' } }] }))
      .rejects.toThrow(/canonical name|manual or confirmed value/);
    expect(store.get('products/p1')).toMatchObject({ sub_model: '캐스퍼' });
  });
});

describe('confirmed product identity correction (isolated approval path)', () => {
  type Plan = import('../src/infra/vehicle-name-reference-repair-firestore.js').VehicleNameRepairPlan;
  const fixture = (): Plan => {
    const from = { maker: 'Maker', model: 'Model', sub_model: 'Wrong', trim_name: 'Old' };
    const to = { maker: 'Maker', model: 'Model', sub_model: 'Right', trim_name: 'New' };
    const original = { 차명: 'old source', 전체: { 차량번호: '00가0000' } };
    const correction = { 차명: 'corrected source' };
    const master = { id: 'fake-master', maker: to.maker, model: to.model, sub_model: to.sub_model };
    const trim = { ...master, id: 'fake-trim', master_id: master.id, trim: to.trim_name };
    put('products/00가0000', { ...from, 원문: original, 원문_정정: correction, confirmed: true, unrelated: 'keep' });
    put('vehicle_master/fake-master', master);
    put('vehicle_trim_master/fake-trim', trim);
    updateTimes.set('products/00가0000', { seconds: 1, nanoseconds: 123 });
    const source = (data: unknown, name: string) => ({ source: name, authoredAt: '2026-01-01T00:00:00Z', retrievedAt: '2026-01-02T00:00:00Z', archiveRef: 'private:fake-reference', contentDigest: stableDigest(data) });
    return { kind: 'PRODUCT_IDENTITY_CORRECTION', projectId: 'test-project', sourceDigest: 'fake-source', masterRepairs: [], productRepairs: [], productIdentityCorrections: [{
      id: '00가0000', from, to, expectedUpdateTime: { seconds: 1, nanoseconds: 123 }, reason: 'Reviewed correction explicitly replaces the wrong source identity',
      evidence: { original: source(original, 'supplier'), correction: { ...source(correction, '지지오토'), archiveVehicleNumber: '00가0000' }, vehicleNumber: '00가0000', correctsOriginalDigest: stableDigest(original), correctedFields: ['sub_model', 'trim_name'], resolvedIdentity: to, conflicts: [] },
      master: { id: master.id, trimId: trim.id, contentDigest: stableDigest(master), trimContentDigest: stableDigest(trim) },
    }] };
  };
  // 두 번째 가짜 차량: 번호판·원문 번호·보관 번호를 모두 새 번호로 맞춰 다른 근거 지문을 만든다.
  const secondOf = (p: Plan) => {
    const second = structuredClone(item(p)); second.id = '00가0001';
    const base = store.get('products/00가0000')!; const original = { ...(base.원문 as Record<string, unknown>), 전체: { 차량번호: '00가0001' } };
    second.evidence.vehicleNumber = '00가0001'; second.evidence.correction.archiveVehicleNumber = '00가0001';
    second.evidence.original.contentDigest = stableDigest(original); second.evidence.correctsOriginalDigest = stableDigest(original);
    return { second, original };
  };
  const apply = (p: Plan) => applyVehicleNameReferenceRepair(p, { approvedCorrectionDigest: vehicleNameRepairPlanDigest(p) });
  const item = (p: Plan) => p.productIdentityCorrections![0]!;
  const audits = () => [...store.values()].filter((x) => String(x.action).startsWith('PRODUCT_IDENTITY_CORRECT'));
  const reverse = (p: Plan): Plan => {
    const prior = audits()[0]!;
    const next = structuredClone(p);
    const i = item(next);
    i.from = structuredClone(item(p).to); i.to = structuredClone(item(p).from);
    i.expectedUpdateTime = updateTimes.get('products/00가0000') as typeof i.expectedUpdateTime;
    i.rollbackOf = prior.eventId as string;
    i.reason = 'Approved reversal of this exact correction';
    return next;
  };
  it('corrects confirmed fields atomically and preserves source and unrelated fields', async () => {
    const p = fixture(); const before = structuredClone(store.get('products/00가0000')!);
    const result = await apply(p);
    expect(result.readbackCount).toBe(1); expect(result.auditCount).toBe(1);
    expect(store.get('products/00가0000')).toEqual({ ...before, ...item(p).to });
    expect(audits()[0]).toMatchObject({ action: 'PRODUCT_IDENTITY_CORRECTED', planDigest: vehicleNameRepairPlanDigest(p), before: item(p).from, after: item(p).to });
    expect(preconditions.at(-1)?.[1]).toEqual({ lastUpdateTime: item(p).expectedUpdateTime });
  });
  it('refuses ordinary approval even with the exact correction digest', async () => {
    const p = fixture();
    await expect(applyVehicleNameReferenceRepair(p, { approvedPlanDigest: vehicleNameRepairPlanDigest(p) })).rejects.toThrow(/AUTHORIZE_PRODUCT/);
    await expect(applyVehicleNameReferenceRepair(p, { approvedCorrectionDigest: stableDigest(p) })).rejects.toThrow(/AUTHORIZE_PRODUCT/);
  });
  it('binds approval to the project and every reviewed field', async () => {
    const p = fixture(); const digest = vehicleNameRepairPlanDigest(p); item(p).reason += ' changed';
    await expect(applyVehicleNameReferenceRepair(p, { approvedCorrectionDigest: digest })).rejects.toThrow(/digest/);
    p.projectId = 'other-project'; await expect(apply(p)).rejects.toThrow(/project mismatch/);
  });
  it.each(['masterRepairs', 'productRepairs', 'productIdentityRepairs', 'productTrimRepairs', 'masterCreates'] as const)('refuses mixed %s plans', async (key) => {
    const p = fixture(); (p as unknown as Record<string, unknown>)[key] = [{ id: 'fake-other', from: 'a', to: 'b' }];
    await expect(apply(p)).rejects.toThrow(/mix/);
  });
  it('refuses 11 products, duplicate IDs and empty correction batches', async () => {
    const p = fixture(); const first = item(p);
    p.productIdentityCorrections = Array.from({ length: 11 }, (_, n) => ({ ...first, id: `fake-${n}` }));
    await expect(apply(p)).rejects.toThrow(/1\.\.10/);
    p.productIdentityCorrections = [first, first]; await expect(apply(p)).rejects.toThrow(/duplicate/);
    p.productIdentityCorrections = []; await expect(apply(p)).rejects.toThrow(/1\.\.10/);
  });
  it.each([{ locked_by_contract: true }, { locked_by_contract: 'locked' }, { publication_withdrawal: { reason: 'withdrawn' } }])('refuses protected products %j', async (flag) => {
    const p = fixture(); Object.assign(store.get('products/00가0000')!, flag);
    await expect(apply(p)).rejects.toThrow(/LOCKED_BY_CONTRACT|PUBLICATION_WITHDRAWN/); expect(audits()).toHaveLength(0);
  });
  it.each([undefined, null, '', ' Wrong'])('compares from without normalization: %s', async (value) => {
    const p = fixture(); const data = store.get('products/00가0000')!;
    if (value === undefined) delete data.sub_model; else data.sub_model = value;
    await expect(apply(p)).rejects.toThrow(/from\/version/);
  });
  it('refuses a changed version even when all four names are unchanged', async () => {
    const p = fixture(); updateTimes.set('products/00가0000', { seconds: 1, nanoseconds: 124 });
    await expect(apply(p)).rejects.toThrow(/version/);
  });
  it('rechecks product state after backup and aborts the entire batch', async () => {
    const p = fixture();
    const { writeFile } = await import('node:fs/promises');
    vi.mocked(writeFile).mockImplementationOnce(async () => { store.get('products/00가0000')!.locked_by_contract = true; });
    await expect(apply(p)).rejects.toThrow(/LOCKED_BY_CONTRACT/); expect(audits()).toHaveLength(0);
  });
  it.each(['원문', '원문_정정'])('refuses changed %s content', async (field) => {
    const p = fixture(); (store.get('products/00가0000')![field] as Record<string, unknown>).차명 = 'changed';
    await expect(apply(p)).rejects.toThrow(/evidence changed/);
  });
  it('binds identity by vehicle number even when source and correction names differ and the product has no name field', async () => {
    const p = fixture(); const data = store.get('products/00가0000')!;
    expect(Object.hasOwn(data, '차명')).toBe(false); expect((data.원문 as Record<string, unknown>).차명).not.toBe((data.원문_정정 as Record<string, unknown>).차명);
    await expect(apply(p)).resolves.toMatchObject({ productIdentityCorrectionCount: 1 });
  });
  it('refuses when any of the three vehicle numbers differs', async () => {
    const original = fixture(); ((store.get('products/00가0000')!.원문 as { 전체: Record<string, unknown> }).전체).차량번호 = '00가0001';
    original.productIdentityCorrections![0]!.evidence.original.contentDigest = stableDigest(store.get('products/00가0000')!.원문);
    original.productIdentityCorrections![0]!.evidence.correctsOriginalDigest = stableDigest(store.get('products/00가0000')!.원문);
    await expect(apply(original)).rejects.toThrow(/vehicle mismatch/);
    const archive = fixture(); item(archive).evidence.correction.archiveVehicleNumber = '00가0001';
    await expect(apply(archive)).rejects.toThrow(/unresolved/);
    const claimed = fixture(); item(claimed).evidence.vehicleNumber = '00가0001';
    await expect(apply(claimed)).rejects.toThrow(/unresolved/);
    const car = fixture(); store.get('products/00가0000')!.car_number = '00가0001';
    await expect(apply(car)).rejects.toThrow(/vehicle mismatch/);
  });
  it('accepts spacing inside the original number but refuses a hyphenated different number', async () => {
    const spaced = fixture(); const all = (store.get('products/00가0000')!.원문 as { 전체: Record<string, unknown> }).전체; all.차량번호 = '00가 0000';
    const o = store.get('products/00가0000')!.원문; item(spaced).evidence.original.contentDigest = stableDigest(o); item(spaced).evidence.correctsOriginalDigest = stableDigest(o);
    await expect(apply(spaced)).resolves.toMatchObject({ productIdentityCorrectionCount: 1 });
  });
  it('refuses a hyphenated number as a different vehicle', async () => {
    const p = fixture(); const all = (store.get('products/00가0000')!.원문 as { 전체: Record<string, unknown> }).전체; all.차량번호 = '00가-0000';
    const o = store.get('products/00가0000')!.원문; item(p).evidence.original.contentDigest = stableDigest(o); item(p).evidence.correctsOriginalDigest = stableDigest(o);
    await expect(apply(p)).rejects.toThrow(/vehicle mismatch/);
  });
  it('binds approval to the archive vehicle number: changing it after approval is refused', async () => {
    const p = fixture(); const digest = vehicleNameRepairPlanDigest(p);
    item(p).evidence.correction.archiveVehicleNumber = '00가0001';
    await expect(applyVehicleNameReferenceRepair(p, { approvedCorrectionDigest: digest })).rejects.toThrow(/exact plan digest|unresolved/);
  });
  it('links the exact committed version: audit doc and product share updateTime even when committedAt (server timestamp) differs by ms', async () => {
    const p = fixture(); await apply(p);
    const audit = [...store.entries()].find(([, x]) => x.action === 'PRODUCT_IDENTITY_CORRECTED')!;
    const committed = audit[1].committedAt as { seconds: number; nanoseconds: number };
    audit[1].committedAt = { seconds: committed.seconds, nanoseconds: committed.nanoseconds + 15_000_000 };
    expect(updateTimes.get('products/00가0000')).toEqual(updateTimes.get(audit[0]));
    expect((await apply(p)).skippedAlreadyApplied).toBe(1);
  });
  it('refuses a replay when another write changed and restored the document (same data, different version)', async () => {
    const p = fixture(); await apply(p);
    const v = updateTimes.get('products/00가0000') as { seconds: number; nanoseconds: number };
    updateTimes.set('products/00가0000', { seconds: v.seconds, nanoseconds: v.nanoseconds + 1 });
    await expect(apply(p)).rejects.toThrow(/replay/);
    updateTimes.set('products/00가0000', { seconds: v.seconds - 1, nanoseconds: v.nanoseconds });
    await expect(apply(p)).rejects.toThrow(/replay/);
  });
  it('allows reversal only from the exact committed version, even if the data is identical', async () => {
    const p = fixture(); await apply(p);
    const v = updateTimes.get('products/00가0000') as { seconds: number; nanoseconds: number };
    const stale = reverse(p); updateTimes.set('products/00가0000', { seconds: v.seconds, nanoseconds: v.nanoseconds + 1 });
    item(stale).expectedUpdateTime = updateTimes.get('products/00가0000') as ReturnType<typeof item>['expectedUpdateTime'];
    await expect(apply(stale)).rejects.toThrow(/rollback no longer matches/);
    updateTimes.set('products/00가0000', v);
    const ok = reverse(p); await expect(apply(ok)).resolves.toMatchObject({ productIdentityCorrectionCount: 1 });
  });
  const withOriginal = (p: Plan, original: Record<string, unknown>) => {
    store.get('products/00가0000')!.원문 = original;
    item(p).evidence.original.contentDigest = stableDigest(original); item(p).evidence.correctsOriginalDigest = stableDigest(original);
  };
  it('accepts the supplier original top-level 차번 field when 전체.차량번호 is absent', async () => {
    const p = fixture(); withOriginal(p, { 차명: 'old source', 차번: '00가0000' });
    await expect(apply(p)).resolves.toMatchObject({ productIdentityCorrectionCount: 1 });
  });
  it('requires both original plate fields to agree when both exist', async () => {
    const same = fixture(); withOriginal(same, { 차명: 'old source', 차번: '00가0000', 전체: { 차량번호: '00가 0000' } });
    await expect(apply(same)).resolves.toMatchObject({ productIdentityCorrectionCount: 1 });
  });
  it('refuses when the two original plate fields disagree', async () => {
    const diff = fixture(); withOriginal(diff, { 차명: 'old source', 차번: '00가0001', 전체: { 차량번호: '00가0000' } });
    await expect(apply(diff)).rejects.toThrow(/vehicle mismatch/);
  });
  it('refuses when the preserved original has no plate field at all', async () => {
    const p = fixture(); withOriginal(p, { 차명: 'old source', 옵션: 'x' });
    await expect(apply(p)).rejects.toThrow(/vehicle mismatch/);
  });
  it('explicitly refuses documents without a plate-number id', async () => {
    const p = fixture(); item(p).id = 'RP000:MONTHLY:fake'; item(p).evidence.vehicleNumber = 'RP000:MONTHLY:fake'; item(p).evidence.correction.archiveVehicleNumber = 'RP000:MONTHLY:fake';
    await expect(apply(p)).rejects.toThrow(/unresolved/);
  });
  it('refuses unresolved higher-priority evidence conflicts', async () => {
    const p = fixture(); item(p).evidence.conflicts = ['registration disagrees'];
    await expect(apply(p)).rejects.toThrow(/unresolved/);
  });
  it('requires preserved source provenance and explicit supersession', async () => {
    const p = fixture(); item(p).evidence.original.archiveRef = '';
    await expect(apply(p)).rejects.toThrow(/provenance/);
    item(p).evidence.original.archiveRef = 'private:fake'; item(p).evidence.correctsOriginalDigest = 'bad';
    await expect(apply(p)).rejects.toThrow(/identify the original/);
  });
  it.each(['duplicate', 'retired', 'changed'])('refuses %s masters', async (mode) => {
    const p = fixture(); const m = store.get('vehicle_master/fake-master')!;
    if (mode === 'duplicate') put('vehicle_master/fake-duplicate', { ...m });
    else m[mode === 'retired' ? 'retired' : 'other'] = true;
    await expect(apply(p)).rejects.toThrow(/master ambiguous/);
  });
  it.each(['duplicate', 'retired', 'wrong-link', 'old-trim'])('refuses %s trims', async (mode) => {
    const p = fixture(); const t = store.get('vehicle_trim_master/fake-trim')!;
    if (mode === 'duplicate') put('vehicle_trim_master/fake-duplicate', { ...t });
    else if (mode === 'retired') t.retired = true;
    else if (mode === 'wrong-link') t.master_id = 'fake-other';
    else { item(p).to.trim_name = 'Old'; item(p).evidence.resolvedIdentity = { ...item(p).to }; }
    await expect(apply(p)).rejects.toThrow(/trim ambiguous/);
  });
  it('rechecks master evidence after backup', async () => {
    const p = fixture(); const { writeFile } = await import('node:fs/promises');
    vi.mocked(writeFile).mockImplementationOnce(async () => { store.get('vehicle_master/fake-master')!.retired = true; });
    await expect(apply(p)).rejects.toThrow(/master ambiguous/);
  });
  it('does not write when private backup fails', async () => {
    const p = fixture(); const { writeFile } = await import('node:fs/promises');
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('backup failed'));
    await expect(apply(p)).rejects.toThrow(/backup failed/);
    expect(store.get('products/00가0000')!.sub_model).toBe('Wrong'); expect(audits()).toHaveLength(0);
  });
  it('rejects the whole batch when the second product fails', async () => {
    const p = fixture(); const { second, original } = secondOf(p);
    put('products/00가0001', { ...store.get('products/00가0000')!, 원문: original, locked_by_contract: true });
    updateTimes.set('products/00가0001', second.expectedUpdateTime); p.productIdentityCorrections!.push(second);
    await expect(apply(p)).rejects.toThrow(/LOCKED_BY_CONTRACT/);
    expect(store.get('products/00가0000')!.sub_model).toBe('Wrong'); expect(audits()).toHaveLength(0);
  });
  it('only treats a matching audit AND complete actual result as already applied', async () => {
    const p = fixture(); await apply(p);
    expect((await apply(p)).skippedAlreadyApplied).toBe(1); expect(audits()).toHaveLength(1);
    store.get('products/00가0000')!.unrelated = 'later edit';
    await expect(apply(p)).rejects.toThrow(/replay/);
  });
  it('refuses a corrupted replay receipt', async () => {
    const p = fixture(); await apply(p); audits()[0]!.itemDigest = 'corrupted';
    await expect(apply(p)).rejects.toThrow(/replay/);
  });
  it('refuses changed before-images even when the receipt digest label remains unchanged', async () => {
    const p = fixture(); await apply(p); audits()[0]!.before = { maker: 'tampered' };
    await expect(apply(p)).rejects.toThrow(/replay/);
  });
  it('refuses a partial batch receipt without writing the missing member', async () => {
    const p = fixture(); const { second, original } = secondOf(p);
    put('products/00가0001', { ...store.get('products/00가0000')!, 원문: original });
    updateTimes.set('products/00가0001', second.expectedUpdateTime); p.productIdentityCorrections!.push(second);
    const before = structuredClone(store.get('products/00가0001')!);
    await apply(p);
    for (const [path, data] of store) if (data.entityId === '00가0001' && data.action === 'PRODUCT_IDENTITY_CORRECTED') store.delete(path);
    put('products/00가0001', before); updateTimes.set('products/00가0001', second.expectedUpdateTime);
    await expect(apply(p)).rejects.toThrow(/partial correction/);
    expect(store.get('products/00가0001')!.sub_model).toBe('Wrong');
  });
  it('requires fresh approval for reverse and restores only changed fields', async () => {
    const p = fixture(); await apply(p); const r = reverse(p);
    await expect(applyVehicleNameReferenceRepair(r, { approvedCorrectionDigest: vehicleNameRepairPlanDigest(p) })).rejects.toThrow(/digest/);
    await apply(r); expect(store.get('products/00가0000')).toMatchObject({ ...item(p).from, unrelated: 'keep', confirmed: true });
    expect(audits().at(-1)!.action).toBe('PRODUCT_IDENTITY_CORRECTION_REVERSED');
    expect((await apply(r)).skippedAlreadyApplied).toBe(1);
  });
  it.each(['version', 'lock', 'edited-target'])('refuses reverse after %s change', async (mode) => {
    const p = fixture(); await apply(p); const r = reverse(p);
    if (mode === 'version') { updateTimes.set('products/00가0000', { seconds: 9999, nanoseconds: 0 }); item(r).expectedUpdateTime = { seconds: 9999, nanoseconds: 0 }; }
    else if (mode === 'lock') store.get('products/00가0000')!.locked_by_contract = true;
    else item(r).to.sub_model = 'unapproved';
    await expect(apply(r)).rejects.toThrow(/rollback|LOCKED_BY_CONTRACT/);
  });
  it.each(['null', 'empty'])('restores exact %s values rather than collapsing them', async (mode) => {
    const p = fixture(); const data = store.get('products/00가0000')!;
    data.trim_name = mode === 'null' ? null : ''; item(p).from.trim_name = data.trim_name as string | null;
    await apply(p); await apply(reverse(p));
    expect(Object.hasOwn(store.get('products/00가0000')!, 'trim_name')).toBe(true);
    expect(store.get('products/00가0000')!.trim_name).toBe(mode === 'null' ? null : '');
  });

  it('refuses to restore a missing field by deletion (data-access boundary forbids erasing stored fields)', async () => {
    const p = fixture(); const data = store.get('products/00가0000')!;
    delete data.trim_name; delete item(p).from.trim_name;
    await apply(p);
    await expect(apply(reverse(p))).rejects.toThrow(/field deletion is not allowed/);
    expect(Object.hasOwn(store.get('products/00가0000')!, 'trim_name')).toBe(true);
  });
});
