import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IANCAR_POLICY_UPCHARGES } from '../src/domain/iancar-policy-patch.js';

type DocData = Record<string, unknown>;
type Ref = { path: string; id: string };

const store = new Map<string, { data: DocData; version: number }>();
const stats = { batchCommits: 0, transactions: 0, writes: 0 };
let beforeTransaction: (() => void) | undefined;
let failOnWritePath: string | undefined;

const ref = (collection: string, id: string): Ref => ({ path: `${collection}/${id}`, id });
const clone = <T>(value: T): T => structuredClone(value);
const updateTime = (version: number) => ({ toMillis: () => version });
const snap = (r: Ref) => {
  const entry = store.get(r.path);
  const data = entry ? clone(entry.data) : undefined;
  const version = entry?.version;
  return {
    ref: r,
    id: r.id,
    exists: data !== undefined,
    updateTime: version === undefined ? undefined : updateTime(version),
    data: () => (data === undefined ? undefined : clone(data)),
  };
};
const put = (path: string, data: DocData, version = 1) => store.set(path, { data: clone(data), version });
const applyUpdate = (path: string, patch: DocData) => {
  if (failOnWritePath === path) throw new Error(`write failed ${path}`);
  const current = store.get(path);
  if (!current) throw new Error(`missing ${path}`);
  store.set(path, { data: { ...current.data, ...clone(patch) }, version: current.version + 1 });
};
const applySet = (path: string, patch: DocData, options?: { merge?: boolean }) => {
  if (failOnWritePath === path) throw new Error(`write failed ${path}`);
  const current = store.get(path);
  store.set(path, { data: options?.merge && current ? { ...current.data, ...clone(patch) } : clone(patch), version: (current?.version ?? 0) + 1 });
};

const db = {
  collection: (collection: string) => ({
    doc: (id: string) => ref(collection, id),
    get: async () => ({
      docs: [...store.keys()]
        .filter((path) => path.startsWith(`${collection}/`))
        .map((path) => snap(ref(collection, path.slice(collection.length + 1)))),
    }),
  }),
  getAll: async (...refs: Ref[]) => refs.map(snap),
  batch: () => ({
    update: vi.fn(),
    set: vi.fn(),
    commit: async () => { stats.batchCommits += 1; },
  }),
  runTransaction: async (fn: (transaction: {
    getAll: (...refs: Ref[]) => Promise<ReturnType<typeof snap>[]>;
    update: (r: Ref, patch: DocData) => void;
    set: (r: Ref, patch: DocData, options?: { merge?: boolean }) => void;
  }) => Promise<void>) => {
    stats.transactions += 1;
    const writes: Array<() => void> = [];
    beforeTransaction?.();
    await fn({
      getAll: async (...refs: Ref[]) => refs.map(snap),
      update: (r, patch) => writes.push(() => applyUpdate(r.path, patch)),
      set: (r, patch, options) => writes.push(() => applySet(r.path, patch, options)),
    });
    const next = new Map([...store.entries()].map(([path, entry]) => [path, clone(entry)]));
    try {
      writes.forEach((write) => write());
      stats.writes += writes.length;
    } catch (error) {
      store.clear();
      next.forEach((value, key) => store.set(key, value));
      throw error;
    }
  },
};

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => db,
  FieldValue: { serverTimestamp: () => 'server-ts' },
}));
vi.mock('../src/infra/firebase-target.js', () => ({ getTargetFirebaseApp: () => ({}) }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) }));

const { applyIancarPolicySync } = await import('../src/infra/iancar-policy-sync-firestore.js');
const fsPromises = await import('node:fs/promises');

const plate = (index: number) => `${String(10 + Math.floor(index / 100)).padStart(2, '0')}가${String(1111 + index).padStart(4, '0')}`;
const codeFor = (index: number) => Object.keys(IANCAR_POLICY_UPCHARGES)[index % 4]!;
const input119 = () => Array.from({ length: 119 }, (_, index) => ({ plate: plate(index), code: codeFor(index) }));
const seedProducts = () => {
  for (let index = 0; index < 119; index += 1) {
    put(`products/p-${index}`, { car_number: plate(index), policy_code: 'OLD' }, 10 + index);
  }
};
const seedPolicies = (extra: DocData = {}) => {
  for (const code of Object.keys(IANCAR_POLICY_UPCHARGES)) {
    put(`policy/${code}`, { policy_code: code, provider_company_code: 'RP031', ...extra }, 200);
  }
};
const call = (input = input119()) => applyIancarPolicySync(input, {
  db: db as never,
  backupDir: 'C:/tmp/iancar-policy-test',
  now: () => new Date('2026-10-05T00:00:00.000Z'),
});

beforeEach(() => {
  store.clear();
  stats.batchCommits = 0;
  stats.transactions = 0;
  stats.writes = 0;
  beforeTransaction = undefined;
  failOnWritePath = undefined;
  vi.mocked(fsPromises.writeFile).mockClear();
  seedProducts();
  seedPolicies();
});

describe('iancar policy sync transaction', () => {
  it('writes 119 products and 4 policies in one transaction with no batch commits', async () => {
    const result = await call();
    expect(result).toMatchObject({ matched: 119 });
    expect(stats.transactions).toBe(1);
    expect(stats.batchCommits).toBe(0);
    expect(stats.writes).toBe(123);
    expect(store.get('products/p-0')!.data).toMatchObject({ policy_code: 'RP031_S01', policy_code_source_original: 'OLD', policy_reference_checked_at: 'server-ts' });
    expect(store.get('policy/RP031_S04')!.data).toMatchObject({ provider_company_code: 'RP031', mileage_upcharge_per_10000km: IANCAR_POLICY_UPCHARGES.RP031_S04 });
  });

  it('does not update products when a policy precondition changes inside the transaction', async () => {
    beforeTransaction = () => { store.get('policy/RP031_S02')!.version += 1; };
    await expect(call()).rejects.toThrow(/transaction precondition changed policy\/RP031_S02/);
    expect(stats.writes).toBe(0);
    expect(store.get('products/p-0')!.data.policy_code).toBe('OLD');
  });

  it('does not update anything when a policy write fails', async () => {
    failOnWritePath = 'policy/RP031_S03';
    await expect(call()).rejects.toThrow(/write failed policy\/RP031_S03/);
    expect(stats.writes).toBe(0);
    expect(store.get('products/p-10')!.data.policy_code).toBe('OLD');
    expect(store.get('policy/RP031_S01')!.data.annual_mileage).toBeUndefined();
  });

  it('does not update anything when a product updateTime changes inside the transaction', async () => {
    beforeTransaction = () => { store.get('products/p-77')!.version += 1; };
    await expect(call()).rejects.toThrow(/transaction precondition changed products\/p-77/);
    expect(stats.writes).toBe(0);
    expect(store.get('products/p-77')!.data.policy_code).toBe('OLD');
  });

  it('refuses corrector-owned policy fields before backup and writes', async () => {
    seedPolicies({ field_evidence: { annual_mileage: { writer: 'policy-corrector' } } });
    await expect(call()).rejects.toThrow(/POLICY_FIELD_OWNED_BY_CORRECTOR/);
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    expect(stats.writes).toBe(0);
  });

  it('keeps input count, duplicate plate, and allowed-code validation', async () => {
    await expect(call(input119().slice(0, 118))).rejects.toThrow(/Expected 119/);
    const duplicated = input119();
    duplicated[1] = { ...duplicated[1]!, plate: duplicated[0]!.plate };
    await expect(call(duplicated)).rejects.toThrow(/Duplicate plate/);
    const badCode = input119();
    badCode[0] = { ...badCode[0]!, code: 'RP031_BAD' };
    await expect(call(badCode)).rejects.toThrow(/Unexpected policy code/);
  });
});
