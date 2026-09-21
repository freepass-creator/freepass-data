import { describe, expect, it } from 'vitest';
import { buildErpPublicProjection } from '../src/application/catalog.js';
import { readActiveProjectionEvidence } from '../src/application/projection-evidence-reader.js';
import { verifyProjectionReleaseIntegrity } from '../src/shared/projection-integrity.js';
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
