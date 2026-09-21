import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { buildErpPublicProjection } from '../src/application/catalog.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { FirestoreDataStore } from '../src/infra/firestore-store.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { stableRecordSetDigest } from '../src/shared/stable-digest.js';

const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const app = emulatorEnabled
  ? initializeApp(
      { projectId: `freepass-data-test-${randomUUID()}` },
      `freepass-data-emulator-${randomUUID()}`
    )
  : null;

afterAll(async () => {
  if (app) await deleteApp(app);
});

describe.skipIf(!emulatorEnabled)('Firestore projection integrity emulator', () => {
  it('promotes a multi-chunk evidence set and reads it atomically', async () => {
    if (!app) throw new Error('emulator app missing');
    const db = getFirestore(app);
    const store = new FirestoreDataStore(db);

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

    const releaseId = `rel_emulator_${randomUUID()}`;
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
  });

  it('rejects ACTIVE transition when READY evidence is modified', async () => {
    if (!app) throw new Error('emulator app missing');
    const db = getFirestore(app);
    const store = new FirestoreDataStore(db);

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

    const releaseId = `rel_emulator_tamper_${randomUUID()}`;
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
  });
});
