import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { buildErpPublicProjection } from '../src/application/catalog.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { FirestoreDataStore } from '../src/infra/firestore-store.js';
import { dataHealthReader } from '../src/infra/firestore-data-health-reader.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { stableRecordSetDigest } from '../src/shared/stable-digest.js';

const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

function createEmulatorFixture() {
  const app = initializeApp(
    { projectId: `freepass-data-test-${randomUUID()}` },
    `freepass-data-emulator-${randomUUID()}`
  );
  const db = getFirestore(app);
  return {
    app,
    db,
    store: new FirestoreDataStore(db)
  };
}

describe.skipIf(!emulatorEnabled)('Firestore projection integrity emulator', () => {
  it('promotes a multi-chunk evidence set and reads it atomically', async () => {
    const { app, db, store } = createEmulatorFixture();

    try {
      const memory = new MemoryDataStore();
    await seedDemoCatalog(memory);
    const active = await buildErpPublicProjection(
      memory,
      memory,
      '2026-09-21T10:00:00.000Z'
    );
    const originalManifest = await memory.getManifest(active.releaseId);
    const originalLineage = await memory.listProjectionLineage(active.releaseId);
    if (!originalManifest || !originalLineage[0]) {
      throw new Error('projection fixture missing');
    }

    const releaseId = `rel_${randomUUID()}`;
    const manifestId = `manifest_${releaseId}`;
    const lineage = Array.from({ length: 801 }, (_, index) => ({
      ...structuredClone(originalLineage[index % originalLineage.length]!),
      lineageRecordId: `plin_emulator_${index.toString().padStart(4, '0')}_${randomUUID()}`,
      releaseId
    }));
    const release = {
      ...active,
      releaseId,
      manifestId,
      status: 'BUILDING' as const,
      activatedAt: null
    };
    const manifest = {
      ...originalManifest,
      releaseId,
      manifestId,
      fieldEvidenceCount: lineage.length,
      fieldEvidenceDigest: stableRecordSetDigest(lineage)
    };

    await store.stage(release);
    await store.stageEvidence({ manifest, lineage });
    await store.markReady(releaseId);
    await store.activate(releaseId);

    const snapshot = await store.getActiveEvidenceSnapshot('erp-public');
    expect(snapshot.consistency).toBe('ATOMIC');
    expect(snapshot.release?.releaseId).toBe(releaseId);
    expect(snapshot.manifest?.fieldEvidenceCount).toBe(801);
    expect(snapshot.lineage).toHaveLength(801);

    const readonly = dataHealthReader(db);
    const readonlySnapshot = await readonly.getActiveEvidenceSnapshot('erp-public');
    expect(readonlySnapshot.consistency).toBe('ATOMIC');
    expect(readonlySnapshot.release?.releaseId).toBe(releaseId);
    expect(readonlySnapshot.manifest?.fieldEvidenceCount).toBe(801);
    expect(readonlySnapshot.lineage).toHaveLength(801);
    expect('stage' in readonly).toBe(false);
    expect('activate' in readonly).toBe(false);
    expect('transact' in readonly).toBe(false);
    } finally {
      await deleteApp(app);
    }
  });

  it('rejects ACTIVE transition when READY evidence is modified', async () => {
    const { app, db, store } = createEmulatorFixture();

    try {
      const memory = new MemoryDataStore();
    await seedDemoCatalog(memory);
    const active = await buildErpPublicProjection(
      memory,
      memory,
      '2026-09-21T11:00:00.000Z'
    );
    const originalManifest = await memory.getManifest(active.releaseId);
    const originalLineage = await memory.listProjectionLineage(active.releaseId);
    if (!originalManifest || !originalLineage[0]) {
      throw new Error('projection fixture missing');
    }

    const releaseId = `rel_${randomUUID()}`;
    const manifestId = `manifest_${releaseId}`;
    const lineage = originalLineage.map((item, index) => ({
      ...structuredClone(item),
      lineageRecordId: `plin_emulator_tamper_${index}_${randomUUID()}`,
      releaseId
    }));
    const release = {
      ...active,
      releaseId,
      manifestId,
      status: 'BUILDING' as const,
      activatedAt: null
    };
    const manifest = {
      ...originalManifest,
      releaseId,
      manifestId,
      fieldEvidenceCount: lineage.length,
      fieldEvidenceDigest: stableRecordSetDigest(lineage)
    };

    await store.stage(release);
    await store.stageEvidence({ manifest, lineage });
    await store.markReady(releaseId);

    await db.collection('projection_field_lineage')
      .doc(lineage[0]!.lineageRecordId)
      .update({
        'projection.value': 'TAMPERED_AFTER_READY'
      });

    await expect(store.activate(releaseId))
      .rejects.toThrow('EVIDENCE_DIGEST_MISMATCH');

      expect(await store.getActive('erp-public')).toBeNull();
    } finally {
      await deleteApp(app);
    }
  });
});
