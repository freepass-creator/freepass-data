import { describe, expect, it } from 'vitest';
import { createConsumerGateway, parseConsumerBindings, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { buildErpPublicProjection } from '../src/application/catalog.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';

const token = 'test-service-token-0123456789abcdef';
const binding = { id: 'erp-com', projectionId: 'erp-public' as const, token };
const url = '/v1/consumers/erp-com/catalog';
const headers = { authorization: `Bearer ${token}` };
const healthUrl = '/v1/consumers/erp-com/catalog-health';
const healthBinding: ConsumerBinding = {
  ...binding,
  capabilities: ['catalog', 'catalog-health']
};

const withAccess = (
  store: Parameters<typeof createConsumerGateway>[0],
  bindings: ConsumerBinding[],
  healthStore?: Parameters<typeof createConsumerGateway>[3]
) => {
  const logs = new MemoryDataAccessLogStore();
  const access = new DataAccessGateway(logs);
  return {
    logs,
    app: createConsumerGateway(store, bindings, access, healthStore)
  };
};

describe('read-only consumer gateway', () => {
  it('does not read storage before authenticating the registered consumer', async () => {
    let reads = 0;
    const { app, logs } = withAccess(
      { getActive: async () => { reads++; return null; }, getManifest: async () => null },
      [binding]
    );
    for (const request of [{ url }, { url, headers: { authorization: 'Bearer wrong' } }, { url: '/v1/consumers/admin/catalog', headers }]) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    expect(reads).toBe(0);
    expect(logs.events).toHaveLength(3);
    expect(logs.events.every((event) =>
      event.mode === 'READ' &&
      event.phase === 'DENIED' &&
      event.reasonCode === 'UNAUTHORIZED'
    )).toBe(true);
    await app.close();
  });
  it('returns HOLD instead of demo data when the operational release is absent', async () => {
    const { app } = withAccess(new MemoryDataStore(), [binding]);
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
    const { app, logs } = withAccess(store, [binding, { id: 'whitelabel-test', projectionId: 'erp-public', token: token + '2' }]);
    const result = await app.inject({ url, headers });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json().meta.releaseId).toBe(release.releaseId);
    expect(result.json().meta.authority).toBe('CANONICAL_ACTIVE');
    expect(result.json().meta.dataDigest).toBe(release.dataDigest);
    expect(logs.events.slice(0, 2).map((event) => event.phase)).toEqual(['STARTED', 'SUCCEEDED']);
    expect(logs.events[1]).toMatchObject({
      mode: 'READ',
      operation: 'READ_CONSUMER_CATALOG',
      result: {
        count: release.data.length,
        digest: release.dataDigest,
        releaseId: release.releaseId,
        manifestId: release.manifestId,
        revision: release.canonicalRevision
      }
    });
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
      const { app } = withAccess(
        { getActive: async () => altered, getManifest: (id: string) => store.getManifest(id) } as unknown as Parameters<typeof createConsumerGateway>[0],
        [binding]
      );
      expect((await app.inject({ url, headers })).statusCode).toBe(503);
      await app.close();
    }
    const { app } = withAccess(
      { getActive: async () => release, getManifest: async () => null } as unknown as Parameters<typeof createConsumerGateway>[0],
      [binding]
    );
    expect((await app.inject({ url, headers })).statusCode).toBe(503);
    await app.close();
  });
  it('authenticates before touching the Data Health reader', async () => {
    let healthReads = 0;
    const healthStore = {
      listVehicleModels: async () => { healthReads++; return []; },
      listVehicleAssets: async () => [],
      listProducts: async () => [],
      listOffers: async () => [],
      listPolicies: async () => [],
      listRevisionHistory: async () => [],
      getActive: async () => null,
      getManifest: async () => null,
      listProjectionLineage: async () => []
    } as any;

    const { app } = withAccess(
      { getActive: async () => null, getManifest: async () => null },
      [healthBinding],
      healthStore
    );

    for (const request of [
      { url: healthUrl },
      { url: healthUrl, headers: { authorization: 'Bearer wrong' } }
    ]) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    expect(healthReads).toBe(0);
    await app.close();
  });

  it('requires an explicit catalog-health capability', async () => {
    const store = new MemoryDataStore();
    const { app } = withAccess(store, [binding], store);

    const result = await app.inject({ url: healthUrl, headers });
    expect(result.statusCode).toBe(403);
    expect(result.json()).toEqual({ code: 'FORBIDDEN' });

    await app.close();
  });

  it('returns DEGRADED as HTTP 200 because the diagnostic read itself succeeded', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);

    const { app } = withAccess(store, [healthBinding], store);
    const result = await app.inject({ url: healthUrl, headers });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      contractVersion: 'catalog-data-health-v1',
      status: 'DEGRADED'
    });

    await app.close();
  });

  it('returns 503 and audits denial when a health-capable registration has no Health reader', async () => {
    const store = new MemoryDataStore();
    const { app, logs } = withAccess(store, [healthBinding]);

    const result = await app.inject({ url: healthUrl, headers });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ code: 'HEALTH_READER_UNAVAILABLE' });
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      mode: 'READ',
      phase: 'DENIED',
      operation: 'READ_CATALOG_HEALTH',
      reasonCode: 'HEALTH_READER_UNAVAILABLE'
    });

    await app.close();
  });

  it('returns a schema-valid HEALTHY report to an explicitly authorized health reader', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(store, store);

    const { app } = withAccess(store, [healthBinding], store);
    const result = await app.inject({ url: healthUrl, headers });

    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json()).toMatchObject({
      contractVersion: 'catalog-data-health-v1',
      schemaVersion: '1.0.0',
      scope: 'catalog-v1',
      status: 'HEALTHY'
    });

    await app.close();
  });

  it('returns HTTP 503 with the report body when Catalog Data Health is BLOCKED', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(store, store);

    const product = await store.getProduct('prod_gv70_demo');
    await store.seed!({
      products: [{
        ...product!,
        vehicleModelId: 'vm_missing'
      }]
    });

    const { app } = withAccess(store, [healthBinding], store);
    const result = await app.inject({ url: healthUrl, headers });

    expect(result.statusCode).toBe(503);
    expect(result.json()).toMatchObject({
      contractVersion: 'catalog-data-health-v1',
      status: 'BLOCKED'
    });
    expect(result.json().issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'MISSING_PRODUCT_VEHICLE_MODEL',
        severity: 'ERROR'
      })
    ]));

    await app.close();
  });

  it('allows a health-only registration without granting catalog data access', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(store, store);

    const healthOnly: ConsumerBinding = {
      ...binding,
      capabilities: ['catalog-health']
    };
    const { app } = withAccess(store, [healthOnly], store);

    expect((await app.inject({ url, headers })).statusCode).toBe(403);
    expect((await app.inject({ url: healthUrl, headers })).statusCode).toBe(200);

    await app.close();
  });

  it('does not silently reuse the ERP contract for Sheets or Admin, or share credentials', () => {
    for (const id of ['f01', 'f86', 'admin']) {
      expect(() => parseConsumerBindings(JSON.stringify([{ ...binding, id }]))).toThrow('not implemented');
    }
    expect(() => parseConsumerBindings(JSON.stringify([binding, { ...binding, id: 'whitelabel-test' }]))).toThrow('shared service token');
    expect(() => parseConsumerBindings(undefined)).toThrow('required');
    expect(parseConsumerBindings(JSON.stringify([{ ...binding, id: 'kakao-ops' }]))[0]?.id).toBe('kakao-ops');
    for (const entries of [
      [],
      [{ ...binding, token: 'short' }],
      [{ ...binding, token: token + ' ' }],
      [{ ...binding, projectionId: 'admin-catalog' }],
      [{ ...binding, capabilities: [] }],
      [{ ...binding, capabilities: ['unknown'] }],
      [{ ...binding, capabilities: ['catalog', 'catalog'] }]
    ]) {
      expect(() => parseConsumerBindings(JSON.stringify(entries))).toThrow();
    }
  });
});
