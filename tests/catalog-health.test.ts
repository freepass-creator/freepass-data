import { describe, expect, it } from 'vitest';
import { buildErpPublicProjection } from '../src/application/catalog.js';
import { readCatalogDataHealth } from '../src/application/catalog-health.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';

describe('Catalog Data Health v1', () => {
  it('reports healthy for a valid Canonical catalog with an evidence-gated ACTIVE release', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const release = await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T10:00:00.000Z'
    );

    const report = await readCatalogDataHealth(
      store,
      store,
      '2026-09-21T10:01:00.000Z'
    );

    expect(report.status).toBe('HEALTHY');
    expect(report.counts).toMatchObject({
      vehicleModels: 1,
      vehicleAssets: 1,
      products: 1,
      offers: 1,
      policies: 0,
      invalidCanonicalEntities: 0
    });
    expect(report.checks.referentialIntegrity).toEqual({
      status: 'PASS',
      issueCount: 0
    });
    expect(report.checks.activeProjection).toMatchObject({
      status: 'PASS',
      activeReleaseId: release.releaseId,
      releaseStatus: 'ACTIVE',
      manifestPresent: true,
      productCount: 1
    });
    expect(report.checks.activeProjection.expectedEvidenceCount)
      .toBe(report.checks.activeProjection.actualEvidenceCount);
    expect(report.coverage.notEvaluated).toContain('SOURCE_FRESHNESS');
    expect(report.issues).toEqual([]);
  });

  it('blocks health when Canonical references are broken', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const product = await store.getProduct('prod_gv70_demo');

    await store.seed!({
      products: [{
        ...product!,
        vehicleModelId: 'vm_missing'
      }]
    });

    const report = await readCatalogDataHealth(
      store,
      store,
      '2026-09-21T10:01:00.000Z'
    );

    expect(report.status).toBe('BLOCKED');
    expect(report.checks.referentialIntegrity.status).toBe('FAIL');
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'MISSING_PRODUCT_VEHICLE_MODEL',
        severity: 'ERROR',
        entityType: 'product',
        entityId: 'prod_gv70_demo'
      })
    ]));
  });

  it('degrades rather than claiming healthy when no ACTIVE projection exists', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);

    const report = await readCatalogDataHealth(
      store,
      store,
      '2026-09-21T10:01:00.000Z'
    );

    expect(report.status).toBe('DEGRADED');
    expect(report.checks.activeProjection).toMatchObject({
      status: 'WARN',
      activeReleaseId: null,
      manifestPresent: false
    });
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'NO_ACTIVE_RELEASE',
      severity: 'WARNING'
    }));
  });

  it('blocks when ACTIVE release evidence count disagrees with the manifest', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T10:00:00.000Z'
    );

    const inconsistentProjection = {
      getActive: store.getActive.bind(store),
      getManifest: async (releaseId: string) => {
        const manifest = await store.getManifest(releaseId);
        return manifest
          ? { ...manifest, fieldEvidenceCount: manifest.fieldEvidenceCount + 1 }
          : null;
      },
      listProjectionLineage: store.listProjectionLineage.bind(store)
    };

    const report = await readCatalogDataHealth(
      store,
      inconsistentProjection,
      '2026-09-21T10:01:00.000Z'
    );

    expect(report.status).toBe('BLOCKED');
    expect(report.checks.activeProjection.status).toBe('FAIL');
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'ACTIVE_RELEASE_EVIDENCE_COUNT_MISMATCH',
      severity: 'ERROR'
    }));
  });
});
