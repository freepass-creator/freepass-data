import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { readSingleProductCompatibility } from '../src/infra/erp5-compat-catalog-reader.js';

const time = '2026-10-12T00:00:00.000Z';
const stamp = (value = time) => ({ toDate: () => new Date(value), seconds: Math.floor(Date.parse(value) / 1000), nanoseconds: 123,
  isEqual(other: { seconds: number; nanoseconds: number }) { return this.seconds === other.seconds && this.nanoseconds === other.nanoseconds; } });
const scope = new Set<'products' | 'policy' | 'partner'>(['products', 'policy', 'partner']);
function fixture(product: Record<string, unknown> | undefined = {
  product_code: 'display-code', provider_company_code: 'RP031', policy_code: 'P1',
  price: { '12_0': { rent: 100000, deposit: null, depositState: 'UNKNOWN', internal_fee: 900 } },
  vehicle_status: ' 출고 불가 ', status: 'deleted', _deleted: false,
  commission: 900, credentials: 'private', source_url: 'https://private.invalid',
  iancar_phase_one: { policyStage: 'DEFERRED', priceAliases: { '12_0': '12_0' }, rawSource: 'private' },
}) {
  const records: Record<string, Record<string, unknown> | undefined> = {
    'products/machine-id': product,
    'policy/P1': { policy_code: 'P1', policy_name: 'known', internal_fee: 99 },
    'partner/RP031': { partner_code: 'RP031', partner_name: 'supplier', credentials: 'private' },
  };
  const reads: string[] = [];
  const timestamps: Record<string, string> = {};
  const nanos: Record<string, number> = {};
  const db = {
    collection: (collection: string) => ({ doc: (id: string) => ({ path: `${collection}/${id}`, id }) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>, options: unknown) => {
      expect(options).toEqual({ readOnly: true });
      return fn({ get: async (ref: { path: string; id: string }) => {
        reads.push(ref.path);
        return { id: ref.id, exists: records[ref.path] !== undefined, data: () => records[ref.path],
          readTime: { ...stamp(timestamps[ref.path] ?? time), nanoseconds: nanos[ref.path] ?? 123 }, updateTime: stamp() };
      } });
    },
  } as unknown as Firestore;
  return { db, records, reads, timestamps, nanos };
}

describe('bounded compatibility product facts', () => {
  it('reads only exact documents and preserves ERP gate inputs without private fields', async () => {
    const f = fixture();
    const result = await readSingleProductCompatibility(f.db, 'erp-com', 'machine-id', scope);
    expect(f.reads).toEqual(['products/machine-id', 'policy/P1', 'partner/RP031']);
    expect(result.meta).toMatchObject({ selection: 'SINGLE_PRODUCT', readScope: 'SINGLE_PRODUCT', selectedProductId: 'machine-id', readAt: time });
    expect(result.meta.documentVersions.product).toMatchObject({ id: 'machine-id', updateTime: time, updateTimeExact: { nanoseconds: 123 } });
    expect(result.data.products['machine-id']).toMatchObject({ _key: 'machine-id', product_code: 'display-code' });
    expect(result.data.products['machine-id']!.vehicle_status).toBe(' 출고 불가 ');
    expect(result.data.products['machine-id']!.price).toEqual({ '12_0': { rent: 100000, deposit: null, depositState: 'UNKNOWN' } });
    expect(JSON.stringify(result)).not.toMatch(/credentials|internal_fee|commission|source_url|rawSource/);
    expect(result.data).not.toHaveProperty('users');
  });
  it('keeps missing linked facts UNKNOWN without a scan or invented zero', async () => {
    const f = fixture(); delete f.records['policy/P1']; delete f.records['partner/RP031'];
    const result = await readSingleProductCompatibility(f.db, 'whitelabel-eancar', 'machine-id', scope);
    expect(result.meta.linkedFacts.policy).toEqual({ state: 'UNKNOWN', reasonCode: 'POLICY_NOT_OBSERVED' });
    expect(result.meta.linkedFacts.partner.state).toBe('UNKNOWN');
    expect(Object.keys(result.data.products)).toEqual(['machine-id']);
  });
  it('returns not found without reading related facts', async () => {
    const f = fixture(); delete f.records['products/machine-id'];
    await expect(readSingleProductCompatibility(f.db, 'erp-com', 'machine-id', scope)).rejects.toMatchObject({ statusCode: 404 });
    expect(f.reads).toEqual(['products/machine-id']);
  });
  it('rejects unauthorized consumers and unavailable collection grants before widening reads', async () => {
    for (const consumer of ['erp5-public-media', 'erp5-public-catalog', 'freepass-admin-catalog', 'internal-ai-test']) {
      const f = fixture();
      await expect(readSingleProductCompatibility(f.db, consumer, 'machine-id', scope)).rejects.toMatchObject({ statusCode: 503 });
      expect(f.reads).toEqual([]);
    }
    const f = fixture();
    await expect(readSingleProductCompatibility(f.db, 'erp-com', 'machine-id', new Set(['products']))).rejects.toMatchObject({ statusCode: 503 });
  });
  it('fails closed on mixed read snapshots and unsafe references or values', async () => {
    const f = fixture(); f.timestamps['policy/P1'] = '2026-10-12T00:00:01.000Z';
    await expect(readSingleProductCompatibility(f.db, 'erp-com', 'machine-id', scope)).rejects.toMatchObject({ statusCode: 503 });
    for (const change of [{ policy_code: '../private' }, { product_code: 'https://private.invalid' }, { price: [] }]) {
      const g = fixture({ ...fixture().records['products/machine-id'], ...change });
      await expect(readSingleProductCompatibility(g.db, 'erp-com', 'machine-id', scope)).rejects.toMatchObject({ statusCode: 503 });
    }
  });
  it('rejects nanosecond snapshot mismatch even when ISO milliseconds match', async () => {
    const f = fixture(); f.nanos['policy/P1'] = 124;
    await expect(readSingleProductCompatibility(f.db, 'erp-com', 'machine-id', scope)).rejects.toMatchObject({ statusCode: 503 });
  });
  it('preserves Korean variants, mileage and slash keys without redefining price semantics', async () => {
    const keys = ['36_2만', '12_인수형', '12_월30000km', '36/20000'];
    const f = fixture({ price: Object.fromEntries(keys.map(key => [key, { rent: '500000', deposit: null }])) });
    const result = await readSingleProductCompatibility(f.db, 'erp-com', 'machine-id', scope);
    expect(result.data.products['machine-id']!.price).toEqual(Object.fromEntries(keys.map(key => [key, { rent: '500000', deposit: null }])));
  });
});
