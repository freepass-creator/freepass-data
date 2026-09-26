import { describe, expect, it } from 'vitest';
import { buildErpPublicProjection } from '../src/application/catalog.js';
import { readActiveProjectionEvidence } from '../src/application/projection-evidence-reader.js';
import { assertProjectionReleaseIntegrity, verifyProjectionReleaseIntegrity } from '../src/shared/projection-integrity.js';
import { stableDigest, stableRecordSetDigest } from '../src/shared/stable-digest.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';

async function fixture() {
  const store = new MemoryDataStore();
  await seedDemoCatalog(store);
  const release = await buildErpPublicProjection(
    store,
    store,
    '2026-09-21T10:00:00.000Z'
  );
  const manifest = await store.getManifest(release.releaseId);
  const lineage = await store.listProjectionLineage(release.releaseId);
  if (!manifest) throw new Error('fixture manifest missing');
  return { release, manifest, lineage };
}

describe('Projection release integrity verifier', () => {
  it('reads Memory active evidence through the atomic snapshot capability', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const release = await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T10:00:00.000Z'
    );

    const observation = await readActiveProjectionEvidence(
      store,
      'erp-public'
    );

    expect(observation.consistency).toBe('ATOMIC');
    expect(observation.release?.releaseId).toBe(release.releaseId);
    expect(observation.manifest?.releaseId).toBe(release.releaseId);
    expect(observation.lineage.length).toBe(
      observation.manifest?.fieldEvidenceCount
    );
  });

  it('keeps legacy projection readers on an explicit partial-read fallback', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const release = await buildErpPublicProjection(
      store,
      store,
      '2026-09-21T10:00:00.000Z'
    );

    const legacyReader = {
      getActive: store.getActive.bind(store),
      getManifest: store.getManifest.bind(store),
      listProjectionLineage: store.listProjectionLineage.bind(store)
    };

    const observation = await readActiveProjectionEvidence(
      legacyReader,
      'erp-public'
    );

    expect(observation.consistency).toBe('PARTIAL_MULTI_READ');
    expect(observation.release?.releaseId).toBe(release.releaseId);
  });

  it('passes a complete untampered release evidence bundle', async () => {
    const { release, manifest, lineage } = await fixture();

    const result = verifyProjectionReleaseIntegrity(
      release,
      manifest,
      lineage
    );

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('detects tampered release payload even if stored digest is unchanged', async () => {
    const { release, manifest, lineage } = await fixture();
    const data = structuredClone(release.data);
    data[0] = {
      ...data[0]!,
      displayName: 'TAMPERED'
    };

    const result = verifyProjectionReleaseIntegrity(
      { ...release, data },
      manifest,
      lineage
    );

    expect(result.valid).toBe(false);
    expect(result.failures).toContain('RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH');
  });

  it('detects tampered canonical inputs even if inputDigest is unchanged', async () => {
    const { release, manifest, lineage } = await fixture();
    const canonicalInputs = structuredClone(manifest.canonicalInputs);
    canonicalInputs[0] = {
      ...canonicalInputs[0]!,
      revision: canonicalInputs[0]!.revision + 100
    };

    const result = verifyProjectionReleaseIntegrity(
      release,
      { ...manifest, canonicalInputs },
      lineage
    );

    expect(result.valid).toBe(false);
    expect(result.failures).toContain('MANIFEST_CANONICAL_INPUT_DIGEST_MISMATCH');
    expect(result.failures).toContain('CANONICAL_REVISION_MISMATCH');
  });

  it('detects same-count lineage content tamper', async () => {
    const { release, manifest, lineage } = await fixture();
    const changed = structuredClone(lineage);
    if (changed[0]) {
      changed[0] = {
        ...changed[0],
        projection: {
          ...changed[0].projection,
          value: 'TAMPERED'
        }
      };
    }

    const result = verifyProjectionReleaseIntegrity(
      release,
      manifest,
      changed
    );

    expect(result.valid).toBe(false);
    expect(result.counts.evidence).toBe(manifest.fieldEvidenceCount);
    expect(result.failures).toContain('EVIDENCE_DIGEST_MISMATCH');
  });

  it('detects release-manifest identity count and revision mismatches', async () => {
    const { release, manifest, lineage } = await fixture();

    expect(verifyProjectionReleaseIntegrity(
      release,
      { ...manifest, dataDigest: '0'.repeat(64) },
      lineage
    ).failures).toContain('MANIFEST_DATA_DIGEST_MISMATCH');

    expect(verifyProjectionReleaseIntegrity(
      { ...release, inputDigest: '0'.repeat(64) },
      manifest,
      lineage
    ).failures).toContain('RELEASE_INPUT_DIGEST_MISMATCH');

    expect(verifyProjectionReleaseIntegrity(
      { ...release, manifestId: 'manifest_tampered' },
      manifest,
      lineage
    ).failures).toContain('MANIFEST_ID_MISMATCH');

    expect(verifyProjectionReleaseIntegrity(
      release,
      { ...manifest, releaseId: 'rel_other' },
      lineage
    ).failures).toContain('RELEASE_ID_MISMATCH');

    expect(verifyProjectionReleaseIntegrity(
      release,
      { ...manifest, projectionId: 'other-projection' },
      lineage
    ).failures).toContain('PROJECTION_ID_MISMATCH');

    expect(verifyProjectionReleaseIntegrity(
      release,
      { ...manifest, schemaVersion: '9.9.9' },
      lineage
    ).failures).toContain('SCHEMA_VERSION_MISMATCH');

    expect(verifyProjectionReleaseIntegrity(
      release,
      { ...manifest, productCount: manifest.productCount + 1 },
      lineage
    ).failures).toContain('PRODUCT_COUNT_MISMATCH');

    expect(verifyProjectionReleaseIntegrity(
      release,
      { ...manifest, offerCount: manifest.offerCount + 1 },
      lineage
    ).failures).toContain('OFFER_COUNT_MISMATCH');

    expect(verifyProjectionReleaseIntegrity(
      { ...release, canonicalRevision: release.canonicalRevision + 1 },
      manifest,
      lineage
    ).failures).toContain('CANONICAL_REVISION_MISMATCH');

    expect(verifyProjectionReleaseIntegrity(
      release,
      manifest,
      lineage.slice(1)
    ).failures).toContain('EVIDENCE_COUNT_MISMATCH');
  });

  it('assertion helper fails closed with machine-readable integrity failure names', async () => {
    const { release, manifest, lineage } = await fixture();
    const data = structuredClone(release.data);
    data[0] = {
      ...data[0]!,
      displayName: 'TAMPERED'
    };

    expect(() => assertProjectionReleaseIntegrity(
      { ...release, data },
      manifest,
      lineage
    )).toThrow('RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH');
  });

  it('rejects lineage with a wrong release identity even when its digest is recomputed', async () => {
    const { release, manifest, lineage } = await fixture();
    const changed = lineage.map((item) => ({
      ...structuredClone(item),
      releaseId: 'rel_wrong'
    }));
    const changedManifest = {
      ...manifest,
      fieldEvidenceDigest: stableRecordSetDigest(changed)
    };

    const result = verifyProjectionReleaseIntegrity(
      release,
      changedManifest,
      changed
    );

    expect(result.valid).toBe(false);
    expect(result.failures).toContain('EVIDENCE_RELEASE_ID_MISMATCH');
    expect(result.failures).not.toContain('EVIDENCE_DIGEST_MISMATCH');
  });

  it('rejects duplicate lineage record IDs even when count and digest agree', async () => {
    const { release, manifest, lineage } = await fixture();
    if (lineage.length < 2) throw new Error('lineage fixture too small');

    const changed = structuredClone(lineage);
    changed[1] = {
      ...changed[1]!,
      lineageRecordId: changed[0]!.lineageRecordId
    };
    const changedManifest = {
      ...manifest,
      fieldEvidenceDigest: stableRecordSetDigest(changed)
    };

    const result = verifyProjectionReleaseIntegrity(
      release,
      changedManifest,
      changed
    );

    expect(result.valid).toBe(false);
    expect(result.failures).toContain('EVIDENCE_RECORD_ID_DUPLICATE');
  });


  it('validates the Estimate master projection without assuming ERP offers[]', () => {
    const data = [{
      productId: 'prod_1',
      vehicleModelId: 'mf-002.md-036',
      modelYearId: 'mf-002.md-036.sm-ka4::my2026',
      trimId: 'mf-002.md-036.sm-ka4::v01::t01',
      powertrainId: 'mf-002.md-036.sm-ka4::v01',
      maker: '기아',
      model: '카니발',
      modelYear: 2026,
      trimName: '노블레스',
      powertrainName: '하이브리드 1.6T',
      basePrice: { amount: 50000000, currency: 'KRW' as const },
      priceBefore: { amount: 50000000, currency: 'KRW' as const },
      priceAfter: { amount: 49500000, currency: 'KRW' as const },
      priceBasis: '세제혜택 후',
      options: [],
      exteriorColors: [{ colorId: 'ext_1', name: '화이트', code: 'SWP', price: { amount: 80000, currency: 'KRW' as const } }],
      interiorColors: [{ colorId: 'int_1', name: '블랙', code: 'BLK', price: { amount: 0, currency: 'KRW' as const } }],
      configuration: { drivetrain: '2WD', seats: 7, bodyConfiguration: '승용' },
      status: 'ACTIVE' as const,
      holdReasons: []
    }];
    const canonicalInputs = [{
      entityType: 'vehicle_model' as const,
      entityId: 'mf-002.md-036',
      revision: 1,
      validationStatus: 'VALID' as const
    }];
    const release = {
      releaseId: 'rel_estimate-master-test',
      projectionId: 'estimate-newcar-master',
      schemaVersion: '1.0.0',
      canonicalRevision: 1,
      manifestId: 'manifest_estimate-master-test',
      inputDigest: stableDigest(canonicalInputs),
      dataDigest: stableDigest(data),
      status: 'ACTIVE' as const,
      generatedAt: '2026-09-25T08:00:00.000Z',
      activatedAt: '2026-09-25T08:01:00.000Z',
      data
    };
    const manifest = {
      manifestId: release.manifestId,
      releaseId: release.releaseId,
      projectionId: release.projectionId,
      schemaVersion: release.schemaVersion,
      generatedAt: release.generatedAt,
      canonicalInputs,
      productCount: 1,
      offerCount: 0,
      fieldEvidenceCount: 0,
      fieldEvidenceDigest: stableRecordSetDigest([]),
      inputDigest: release.inputDigest,
      dataDigest: release.dataDigest
    };
    const result = verifyProjectionReleaseIntegrity(release, manifest, []);
    expect(result.valid).toBe(true);
    expect(result.counts).toMatchObject({ products: 1, offers: 0, evidence: 0 });
  });

  it('fails closed for an unknown projection payload shape', () => {
    const canonicalInputs = [{
      entityType: 'vehicle_model' as const,
      entityId: 'vm_1',
      revision: 1,
      validationStatus: 'VALID' as const
    }];
    const data = [{ anything: true }];
    const release = {
      releaseId: 'rel_unknown-test',
      projectionId: 'unknown-projection',
      schemaVersion: '1.0.0',
      canonicalRevision: 1,
      manifestId: 'manifest_unknown-test',
      inputDigest: stableDigest(canonicalInputs),
      dataDigest: stableDigest(data),
      status: 'ACTIVE' as const,
      generatedAt: '2026-09-25T08:00:00.000Z',
      activatedAt: '2026-09-25T08:01:00.000Z',
      data
    } as any;
    const manifest = {
      manifestId: release.manifestId,
      releaseId: release.releaseId,
      projectionId: release.projectionId,
      schemaVersion: release.schemaVersion,
      generatedAt: release.generatedAt,
      canonicalInputs,
      productCount: 1,
      offerCount: 0,
      fieldEvidenceCount: 0,
      fieldEvidenceDigest: stableRecordSetDigest([]),
      inputDigest: release.inputDigest,
      dataDigest: release.dataDigest
    };
    expect(verifyProjectionReleaseIntegrity(release, manifest, []).failures)
      .toContain('PROJECTION_PAYLOAD_SHAPE_UNSUPPORTED');
  });

  it('treats legacy manifests without lineage digest as incomplete evidence', async () => {
    const { release, manifest, lineage } = await fixture();
    const { fieldEvidenceDigest: _legacyOmitted, ...legacyManifest } = manifest;

    const result = verifyProjectionReleaseIntegrity(
      release,
      legacyManifest,
      lineage
    );

    expect(result.valid).toBe(false);
    expect(result.failures).toContain('EVIDENCE_DIGEST_MISSING');
  });
});
