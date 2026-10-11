import { describe, expect, it, vi } from 'vitest';
import { createConsumerGateway, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import type { CatalogCompatibilityProductSnapshot } from '../src/infra/erp5-compat-catalog-reader.js';

const token = 'test-single-product-token-0123456789abcdef';
const headers = { authorization: `Bearer ${token}` };
const id = '10하8099';
const url = (consumer = 'erp-com') => `/v1/consumers/${consumer}/catalog-compat/products/${encodeURIComponent(id)}`;
function snapshot(consumerId = 'erp-com'): CatalogCompatibilityProductSnapshot {
  return { schema: 'freepass-data.catalog-compat/v1',
    data: { products: { [id]: { _key: id, provider_company_code: 'RP031', partner_code: 'RP031', vehicle_status: '계약중', _deleted: false,
      price: { '36/20000': { rent: 500000, deposit: null, depositState: 'UNKNOWN' } } } }, policies: {}, partners: {} },
    meta: { consumerId, authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE', sourceProject: 'freepasserp5',
      depositEvidenceVersion: 'catalog-compat-deposit/1', observedAt: '2026-10-12T00:00:00.000Z', readAt: '2026-10-12T00:00:00.000Z',
      selection: 'SINGLE_PRODUCT', readScope: 'SINGLE_PRODUCT', selectedProductId: id,
      collectionCounts: { products: 1, policies: 0, partners: 0 }, documentVersions: {
        product: { id, updateTime: '2026-10-11T23:00:00.000Z' }, policies: [], partners: [] },
      linkedFacts: { policy: { state: 'UNKNOWN', reasonCode: 'POLICY_REFERENCE_NOT_OBSERVED' },
        partner: { state: 'UNKNOWN', reasonCode: 'PARTNER_NOT_OBSERVED' } } } };
}
function setup(binding: ConsumerBinding = { id: 'erp-com', projectionId: 'erp-public', token, capabilities: ['catalog'] }) {
  const readProductCompat = vi.fn(async () => snapshot(binding.id));
  const read = vi.fn(async () => { throw new Error('full list must not run'); });
  const logs = new MemoryDataAccessLogStore();
  const app = createConsumerGateway(new MemoryDataStore(), [binding], new DataAccessGateway(logs), undefined, { read, readProductCompat });
  return { app, read, readProductCompat };
}
describe('bounded single-product compatibility facts', () => {
  it('returns the exact fact without recalculation or a list read and signals migration', async () => {
    const { app, read, readProductCompat } = setup();
    const response = await app.inject({ url: url(), headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot());
    expect(readProductCompat).toHaveBeenCalledExactlyOnceWith('erp-com', id);
    expect(read).not.toHaveBeenCalled();
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-freepass-read-mode']).toBe('DIRECT_FIRESTORE_REQUIRED');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });
  it('authenticates before selection or reader work', async () => {
    const { app, readProductCompat } = setup();
    expect((await app.inject({ url: url() + '?sourceScope=COLLECTED' })).statusCode).toBe(401);
    expect(readProductCompat).not.toHaveBeenCalled(); await app.close();
  });
  it.each(['erp5-public-media', 'erp5-public-catalog', 'freepass-admin-catalog'])('does not expand %s grants', async consumer => {
    const { app, readProductCompat } = setup({ id: consumer, projectionId: consumer === 'freepass-admin-catalog' ? 'admin-catalog' : 'erp-public', token,
      capabilities: consumer === 'erp5-public-media' ? ['photos'] : ['catalog'] });
    expect((await app.inject({ url: url(consumer), headers })).statusCode).toBe(403);
    expect(readProductCompat).not.toHaveBeenCalled(); await app.close();
  });
  it('preserves the exact authorized whitelabel consumer', async () => {
    const { app, readProductCompat } = setup({ id: 'whitelabel-uniplan', projectionId: 'erp-public', token, capabilities: ['catalog'] });
    expect((await app.inject({ url: url('whitelabel-uniplan'), headers })).statusCode).toBe(200);
    expect(readProductCompat).toHaveBeenCalledExactlyOnceWith('whitelabel-uniplan', id); await app.close();
  });
  it.each(['%20abc', 'abc%2Fdef', 'abc%5Cdef', 'abc%00', 'a'.repeat(201)])('rejects invalid ID %s', async value => {
    const { app, readProductCompat } = setup();
    expect((await app.inject({ url: '/v1/consumers/erp-com/catalog-compat/products/' + value, headers })).statusCode).toBe(value.length > 200 ? 414 : 400);
    expect(readProductCompat).not.toHaveBeenCalled(); await app.close();
  });
  it('rejects scope queries instead of broadening the selection', async () => {
    const { app, readProductCompat } = setup();
    expect((await app.inject({ url: url() + '?sourceScope=COLLECTED', headers })).statusCode).toBe(400);
    expect(readProductCompat).not.toHaveBeenCalled(); await app.close();
  });
  it.each(['PRODUCT_NOT_FOUND', 'PRODUCT_SELECTION_UNAVAILABLE', 'INVALID_PRODUCT_SELECTION', 'private upstream token'])('maps %s safely', async code => {
    const { app, readProductCompat } = setup(); readProductCompat.mockRejectedValueOnce(new Error(code));
    const response = await app.inject({ url: url(), headers });
    expect(response.statusCode).toBe(code === 'PRODUCT_NOT_FOUND' ? 404 : code === 'INVALID_PRODUCT_SELECTION' ? 400 : 503);
    expect(response.body).not.toContain('private upstream'); await app.close();
  });
  it.each(['extraProduct', 'key', 'consumer', 'scope', 'users', 'version', 'futureVersion', 'readAt', 'linked', 'size'])('fails closed on invalid %s', async condition => {
    const { app, readProductCompat } = setup(); const value = snapshot();
    if (condition === 'extraProduct') value.data.products.extra = { _key: 'extra' };
    if (condition === 'key') value.data.products[id]!._key = 'other';
    if (condition === 'consumer') value.meta.consumerId = 'whitelabel-other';
    if (condition === 'scope') (value.meta as unknown as Record<string, unknown>).readScope = 'FULL_CATALOG';
    if (condition === 'users') (value.data as unknown as Record<string, unknown>).users = {};
    if (condition === 'version') value.meta.documentVersions.product.id = 'other';
    if (condition === 'futureVersion') value.meta.documentVersions.product.updateTime = '2026-10-13T00:00:00Z';
    if (condition === 'readAt') value.meta.readAt = 'unknown';
    if (condition === 'linked') value.meta.linkedFacts.policy = { state: 'KNOWN', reasonCode: null };
    if (condition === 'size') value.data.products[id]!.model = 'x'.repeat(1024 * 1024);
    readProductCompat.mockResolvedValueOnce(value);
    expect((await app.inject({ url: url(), headers })).statusCode).toBe(503); await app.close();
  });
});
