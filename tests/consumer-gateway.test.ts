import { describe, expect, it } from 'vitest';
import { createConsumerGateway, parseConsumerBindings } from '../src/api/consumer-gateway.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { buildErpPublicProjection } from '../src/application/catalog.js';

const token = 'test-service-token-0123456789abcdef';
const binding = { id: 'erp-com', projectionId: 'erp-public' as const, token };
const url = '/v1/consumers/erp-com/catalog';
const headers = { authorization: `Bearer ${token}` };

describe('read-only consumer gateway', () => {
  it('does not read storage before authenticating the registered consumer', async () => {
    let reads = 0;
    const app = createConsumerGateway({ getActive: async () => { reads++; return null; }, getManifest: async () => null }, [binding]);
    for (const request of [{ url }, { url, headers: { authorization: 'Bearer wrong' } }, { url: '/v1/consumers/admin/catalog', headers }]) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    expect(reads).toBe(0);
    await app.close();
  });
  it('returns HOLD instead of demo data when the operational release is absent', async () => {
    const app = createConsumerGateway(new MemoryDataStore(), [binding]);
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ code: 'NO_ACTIVE_RELEASE' });
    expect((await app.inject({ method: 'POST', url: '/v1/commands/offers/1/price', payload: {} })).statusCode).toBe(404);
    await app.close();
  });
  it('returns the actual release identity to each separately registered consumer', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const release = await buildErpPublicProjection(store, store);
    const app = createConsumerGateway(store, [binding, { id: 'whitelabel-test', projectionId: 'erp-public', token: token + '2' }]);
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json().meta.releaseId).toBe(release.releaseId);
    expect(result.json().meta.dataDigest).toBe(release.dataDigest);
    expect((await app.inject({ url: '/v1/consumers/whitelabel-test/catalog', headers })).statusCode).toBe(401);
    const other = await app.inject({ url: '/v1/consumers/whitelabel-test/catalog', headers: { authorization: `Bearer ${token}2` } });
    expect(other.json().meta.releaseId).toBe(release.releaseId);
    await app.close();
  });
  it('rejects modified data, missing evidence and cross-projection release pointers', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const release = await buildErpPublicProjection(store, store);
    for (const altered of [
      { ...release, data: [] },
      { ...release, status: 'READY' as const },
      { ...release, projectionId: 'admin-catalog' },
      { ...release, activatedAt: null },
      { ...release, schemaVersion: 'unreviewed-version' },
      { ...release, data: release.data.map((row) => ({ ...row, privateCustomer: 'must-not-be-returned' })) },
    ]) {
      const app = createConsumerGateway({ getActive: async () => altered, getManifest: (id) => store.getManifest(id) }, [binding]);
      expect((await app.inject({ url, headers })).statusCode).toBe(503);
      await app.close();
    }
    const app = createConsumerGateway({ getActive: async () => release, getManifest: async () => null }, [binding]);
    expect((await app.inject({ url, headers })).statusCode).toBe(503);
    await app.close();
  });
  it('does not silently reuse the ERP contract for Sheets or Admin, or share credentials', () => {
    for (const id of ['f01', 'f86', 'admin']) {
      expect(() => parseConsumerBindings(JSON.stringify([{ ...binding, id }]))).toThrow('not implemented');
    }
    expect(() => parseConsumerBindings(JSON.stringify([binding, { ...binding, id: 'whitelabel-test' }]))).toThrow('shared service token');
    expect(() => parseConsumerBindings(undefined)).toThrow('required');
    for (const entries of [[], [{ ...binding, token: 'short' }], [{ ...binding, token: token + ' ' }], [{ ...binding, projectionId: 'admin-catalog' }]]) {
      expect(() => parseConsumerBindings(JSON.stringify(entries))).toThrow();
    }
  });
});
