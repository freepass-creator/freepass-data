import { describe, expect, it } from 'vitest';
import { buildErpPublicProjection, updateOfferPrice } from '../src/application/catalog.js';
import { readCatalogDataHealth } from '../src/application/catalog-health.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';

describe('Catalog Data Health v1', () => {
  it('reports a valid release as HEALTHY when all projection digests match', async () => {
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
    expect(report.observation).toMatchObject({
      readAt: '2026-09-21T10:01:00.000Z',
      consistency: 'PARTIAL_MULTI_READ',
      partialObservation: true,
      activeReleaseCanonicalRevision: 1,
      startActiveReleaseId: release.releaseId,
      endActiveReleaseId: release.releaseId,
      activeReleaseStable: true,
      projectionEvidenceConsistency: 'ATOMIC'
    });
    expect(report.checks.referentialIntegrity).toEqual({
      status: 'PASS',
      issueCount: 0
    });
    expect(report.checks.activeInputParity).toEqual({
      status: 'PASS',
      missingCount: 0,
      staleRevisionCount: 0,
      validationMismatchCount: 0
    });
    expect(report.checks.activeProjection).toMatchObject({
      status: 'PASS',
      activeReleaseId: release.releaseId,
      releaseStatus: 'ACTIVE',
      manifestPresent: true,
      productCount: 1,
      dataPayloadDigest: { status: 'PASS' },
      canonicalInputDigest: { status: 'PASS' },
      lineageContentIntegrity: { status: 'PASS' }
    });
    expect(report.checks.activeProjection.expectedEvidenceCount)
      .toBe(report.checks.activeProjection.actualEvidenceCount);
    expect(report.coverage.evaluated).toContain('PROJECTION_LINEAGE_CONTENT_INTEGRITY');
    expect(report.coverage.notEvaluated).not.toContain('PROJECTION_LINEAGE_CONTENT_INTEGRITY');
    expect(report.coverage.notEvaluated).toContain('CONSISTENT_SNAPSHOT');
  });

  it('degrades when ACTIVE release changes during the health observation window', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const first = await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T09:00:00.000Z'
    );

    await updateOfferPrice(store, {
      commandId: 'cmd_health_fence_r2',
      idempotencyKey: 'idem_health_fence_r2',
      offerId: 'offer_gv70_demo',
      expectedRevision: 1,
      termKey: '36@20000',
      monthlyRent: { amount: 720000, currency: 'KRW' },
      reason: 'health observation fence test',
      actor: { id: 'user:test', kind: 'USER' }
    }, '2026-09-21T09:30:00.000Z');

    const second = await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T09:31:00.000Z'
    );

    let activeReadCount = 0;
    const changingProjection = {
      getActive: async (_projectionId: string) => {
        activeReadCount += 1;
        return activeReadCount === 1
          ? { ...first, status: 'ACTIVE' as const }
          : second;
      },
      getManifest: store.getManifest.bind(store),
      listProjectionLineage: store.listProjectionLineage.bind(store)
    };

    const report = await readCatalogDataHealth(
      store,
      changingProjection,
      '2026-09-21T10:01:00.000Z'
    );

    expect(report.status).toBe('DEGRADED');
    expect(report.observation).toMatchObject({
      startActiveReleaseId: first.releaseId,
      endActiveReleaseId: second.releaseId,
      activeReleaseStable: false,
      projectionEvidenceConsistency: 'PARTIAL_MULTI_READ'
    });
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'ACTIVE_RELEASE_CHANGED_DURING_OBSERVATION',
      severity: 'WARNING'
    }));
  });

  it('degrades when ACTIVE manifest inputs lag current Canonical revisions', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T09:00:00.000Z'
    );

    await updateOfferPrice(store, {
      commandId: 'cmd_health_stale_r2',
      idempotencyKey: 'idem_health_stale_r2',
      offerId: 'offer_gv70_demo',
      expectedRevision: 1,
      termKey: '36@20000',
      monthlyRent: { amount: 725000, currency: 'KRW' },
      reason: 'leave ACTIVE projection one revision behind',
      actor: { id: 'user:test', kind: 'USER' }
    }, '2026-09-21T09:30:00.000Z');

    const report = await readCatalogDataHealth(
      store,
      store,
      '2026-09-21T10:01:00.000Z'
    );

    expect(report.status).toBe('DEGRADED');
    expect(report.checks.activeInputParity).toEqual({
      status: 'WARN',
      missingCount: 0,
      staleRevisionCount: 1,
      validationMismatchCount: 0
    });
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'ACTIVE_RELEASE_CANONICAL_INPUT_STALE',
      severity: 'WARNING'
    }));
    expect(report.coverage.evaluated).toContain('ACTIVE_PROJECTION_INPUT_PARITY');
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
      manifestPresent: false,
      dataPayloadDigest: { status: 'NOT_APPLICABLE' },
      canonicalInputDigest: { status: 'NOT_APPLICABLE' }
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

  it('blocks when release.data is tampered without updating the stored digest', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T10:00:00.000Z'
    );

    const tamperedProjection = {
      getActive: async (projectionId: string) => {
        const release = await store.getActive(projectionId);
        if (!release) return null;
        const data = structuredClone(release.data);
        data[0] = {
          ...data[0]!,
          displayName: '변조된 상품명'
        };
        return { ...release, data };
      },
      getManifest: store.getManifest.bind(store),
      listProjectionLineage: store.listProjectionLineage.bind(store)
    };

    const report = await readCatalogDataHealth(
      store,
      tamperedProjection,
      '2026-09-21T10:01:00.000Z'
    );

    expect(report.status).toBe('BLOCKED');
    expect(report.checks.activeProjection.dataPayloadDigest.status).toBe('FAIL');
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'ACTIVE_RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH',
      severity: 'ERROR'
    }));
  });

  it('blocks when manifest canonicalInputs are tampered without updating inputDigest', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T10:00:00.000Z'
    );

    const tamperedProjection = {
      getActive: store.getActive.bind(store),
      getManifest: async (releaseId: string) => {
        const manifest = await store.getManifest(releaseId);
        if (!manifest) return null;
        const canonicalInputs = structuredClone(manifest.canonicalInputs);
        canonicalInputs[0] = {
          ...canonicalInputs[0]!,
          revision: canonicalInputs[0]!.revision + 100
        };
        return { ...manifest, canonicalInputs };
      },
      listProjectionLineage: store.listProjectionLineage.bind(store)
    };

    const report = await readCatalogDataHealth(
      store,
      tamperedProjection,
      '2026-09-21T10:01:00.000Z'
    );

    expect(report.status).toBe('BLOCKED');
    expect(report.checks.activeProjection.canonicalInputDigest.status).toBe('FAIL');
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'ACTIVE_RELEASE_CANONICAL_INPUT_DIGEST_MISMATCH',
      severity: 'ERROR'
    }));
  });

  it('keeps a legacy manifest without lineage digest as DEGRADED and NOT_EVALUATED', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T10:00:00.000Z'
    );

    const legacyProjection = {
      getActive: store.getActive.bind(store),
      getManifest: async (releaseId: string) => {
        const manifest = await store.getManifest(releaseId);
        if (!manifest) return null;
        const { fieldEvidenceDigest: _legacyOmitted, ...legacyManifest } = manifest;
        return legacyManifest;
      },
      listProjectionLineage: store.listProjectionLineage.bind(store)
    };

    const report = await readCatalogDataHealth(
      store,
      legacyProjection,
      '2026-09-21T10:01:00.000Z'
    );

    expect(report.status).toBe('DEGRADED');
    expect(report.checks.activeProjection.lineageContentIntegrity).toMatchObject({
      status: 'NOT_EVALUATED',
      stored: null
    });
    expect(report.coverage.notEvaluated).toContain('PROJECTION_LINEAGE_CONTENT_INTEGRITY');
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'ACTIVE_RELEASE_LINEAGE_DIGEST_MISSING',
      severity: 'WARNING'
    }));
  });

  it('blocks same-count lineage content tamper with the manifest digest', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T10:00:00.000Z'
    );

    const sameCountTamperedLineage = {
      getActive: store.getActive.bind(store),
      getManifest: store.getManifest.bind(store),
      listProjectionLineage: async (releaseId: string) => {
        const lineage = await store.listProjectionLineage(releaseId);
        const copy = structuredClone(lineage);
        if (copy[0]) {
          copy[0] = {
            ...copy[0],
            projection: {
              ...copy[0].projection,
              value: 'tampered-with-same-count'
            }
          };
        }
        return copy;
      }
    };

    const report = await readCatalogDataHealth(
      store,
      sameCountTamperedLineage,
      '2026-09-21T10:01:00.000Z'
    );

    expect(report.checks.activeProjection.expectedEvidenceCount)
      .toBe(report.checks.activeProjection.actualEvidenceCount);
    expect(report.checks.activeProjection.lineageContentIntegrity).toMatchObject({
      status: 'FAIL'
    });
    expect(report.status).toBe('BLOCKED');
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'ACTIVE_RELEASE_LINEAGE_CONTENT_DIGEST_MISMATCH',
      severity: 'ERROR'
    }));
  });
});
