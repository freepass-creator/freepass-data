import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { buildErpPublicProjection, processOneOutboxEvent } from '../src/application/catalog.js';
import { readCatalogDataHealth } from '../src/application/catalog-health.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { FirestoreDataStore } from '../src/infra/firestore-store.js';
import { dataHealthReader } from '../src/infra/firestore-data-health-reader.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { stableDigest, stableRecordSetDigest } from '../src/shared/stable-digest.js';
import { FIRESTORE_COLLECTIONS, sourceFirestoreDocumentId } from '../src/infra/firestore-layout.js';

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
  it('claims the exact document only and rejects mismatch, expiry and a live lease without writes', async () => {
    const { app, db, store } = createEmulatorFixture();
    try {
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 60000).toISOString();
      const event = { eventId: 'target', eventType: 'catalog.offer.changed', occurredAt: now,
        status: 'PENDING', attempts: 0 };
      await db.collection(FIRESTORE_COLLECTIONS.evidence.outbox).doc('other').set({ ...event, eventId: 'other' });
      const target = db.collection(FIRESTORE_COLLECTIONS.evidence.outbox).doc('target');
      const input = { workerId: 'single', now, leaseUntil: later, eventId: 'target', expiresAt: later };
      const otherBefore = (await db.collection(FIRESTORE_COLLECTIONS.evidence.outbox).doc('other').get()).data();
      expect(await store.claimNext(input)).toBeNull();
      await target.set({ ...event, eventId: 'mismatch' });
      for (const patch of [{}, { eventId: 'target', status: 'PROCESSING', leaseOwner: 'other', leaseUntil: later }]) {
        if (Object.keys(patch).length) await target.set({ ...event, ...patch });
        const before = await target.get();
        expect(await store.claimNext(input)).toBeNull();
        expect((await target.get()).updateTime).toEqual(before.updateTime);
      }
      await target.set(event);
      const before = await target.get();
      expect(await store.claimNext({ ...input, expectedEventDigest: 'unapproved-event' })).toBeNull();
      expect(await store.claimNext({ ...input, expiresAt: now })).toBeNull();
      expect((await target.get()).updateTime).toEqual(before.updateTime);
      expect((await store.claimNext(input))?.eventId).toBe('target');
      await target.update({ leaseOwner: 'replacement' });
      const replaced = await target.get();
      await expect(store.markDone('target', { leaseOwner: 'single', leaseUntil: later })).rejects.toThrow('OUTBOX_LEASE_LOST');
      expect((await target.get()).updateTime).toEqual(replaced.updateTime);
      expect((await db.collection(FIRESTORE_COLLECTIONS.evidence.outbox).doc('other').get()).data()).toEqual(otherBefore);
    } finally { await deleteApp(app); }
  });

  it('restores first ACTIVE absence and selected event preimage while retaining immutable publication evidence', async () => {
    const { app, db, store } = createEmulatorFixture();
    try {
      const memory = new MemoryDataStore();
      await seedDemoCatalog(memory);
      const sourceId = 'local-demo/catalog-file';
      const head = (await memory.getSourceHead(sourceId))!;
      const definition = { ...(await memory.getSourceDefinition(sourceId))!, expectedFreshnessSeconds: 60 };
      await memory.seed({ sourceDefinitions: [definition] });
      const run = (await memory.getSourceRun(head.runId))!;
      for (const [collection, id, value] of [
        [FIRESTORE_COLLECTIONS.source.definitions, sourceFirestoreDocumentId(sourceId), definition],
        [FIRESTORE_COLLECTIONS.source.heads, sourceFirestoreDocumentId(sourceId), head],
        [FIRESTORE_COLLECTIONS.source.runs, run.runId, run]
      ] as const) await db.collection(collection).doc(id).set(value);
      const event = { eventId: 'approved-event', eventType: 'catalog.canonicalized', entityType: 'product',
        entityId: 'prod_gv70_demo', sourceRevision: 0, targetRevision: 1, commandId: 'synthetic',
        correlationId: 'synthetic', causationId: 'synthetic', occurredAt: head.observedAt, status: 'PENDING', attempts: 0 };
      const eventRef = db.collection(FIRESTORE_COLLECTIONS.evidence.outbox).doc(event.eventId);
      await eventRef.set(event);
      const otherRef = db.collection(FIRESTORE_COLLECTIONS.evidence.outbox).doc('unrelated');
      await otherRef.set({ ...event, eventId: 'unrelated' });
      const otherBefore = await otherRef.get();
      const before = await store.captureFirstActivationPreimage(event.eventId);
      expect(await processOneOutboxEvent(memory, store, store, { workerId: 'approved', eventId: event.eventId,
        expiresAt: new Date(Date.parse(head.observedAt) + 30000).toISOString(), requireFreshSources: true,
        expectedEventDigest: stableDigest(before.event), expectedActiveReleaseId: null }, new Date(head.observedAt))).toBe('DONE');
      await expect(store.planFirstActivationRecovery(before, 'unapproved')).rejects.toThrow('RECOVERY_PREIMAGE_INVALID');
      const plan = await store.planFirstActivationRecovery(before, before.digest);
      expect(plan.restore.map(item => item.path)).toEqual([
        `${FIRESTORE_COLLECTIONS.projection.active}/erp-public`, eventRef.path,
        `${FIRESTORE_COLLECTIONS.projection.releases}/${plan.releaseId}` ]);
      expect(plan.preserve.some(item => item.path.startsWith(FIRESTORE_COLLECTIONS.projection.deliveryReceipts + '/'))).toBe(true);
      // Only this isolated test executes the reviewed recovery plan. No production executor exists.
      const restore = async () => {
        expect(app.options.projectId).toMatch(/^freepass-data-test-/);
        const { digest, ...body } = plan;
        expect(stableDigest(body)).toBe(digest);
        await db.runTransaction(async tx => {
          const fences = [...plan.restore, ...plan.preserve];
          const current = await Promise.all(fences.map(item => tx.get(db.doc(item.path))));
          for (let i = 0; i < current.length; i++) {
            const row = current[i]!, fence = fences[i]!;
            if (!row.exists || row.updateTime!.seconds !== fence.updateSeconds || row.updateTime!.nanoseconds !== fence.updateNanos ||
                stableDigest(row.data()) !== fence.digest) throw new Error('RECOVERY_PLAN_DRIFT');
          }
          for (const item of plan.restore) {
            if (item.action === 'DELETE') tx.delete(db.doc(item.path));
            else tx.set(db.doc(item.path), item.value!);
          }
        });
      };
      const releaseRef = db.collection(FIRESTORE_COLLECTIONS.projection.releases).doc(plan.releaseId);
      await releaseRef.update({ recoveryDrift: true });
      const driftedEvent = await eventRef.get();
      await expect(restore()).rejects.toThrow('RECOVERY_PLAN_DRIFT');
      expect((await eventRef.get()).updateTime).toEqual(driftedEvent.updateTime);
      expect(await store.getActive('erp-public')).not.toBeNull();
      await expect(store.planFirstActivationRecovery(before, before.digest)).rejects.toThrow('RECOVERY_RELEASE_FIELDS_CHANGED');
      const contaminated = (await releaseRef.get()).data()!;
      delete contaminated.recoveryDrift;
      await releaseRef.set(contaminated);
      Object.assign(plan, await store.planFirstActivationRecovery(before, before.digest));
      await restore();
      expect(await store.getActive('erp-public')).toBeNull();
      expect((await eventRef.get()).data()).toEqual(before.event);
      expect((await releaseRef.get()).get('status')).toBe('READY');
      expect((await releaseRef.get()).data()).not.toHaveProperty('activatedAt');
      for (const fence of plan.preserve) {
        const doc = await db.doc(fence.path).get();
        expect(stableDigest(doc.data())).toBe(fence.digest);
        expect(doc.updateTime!.nanoseconds).toBe(fence.updateNanos);
        expect(doc.updateTime!.seconds).toBe(fence.updateSeconds);
      }
      expect((await otherRef.get()).updateTime).toEqual(otherBefore.updateTime);
      expect(await processOneOutboxEvent(memory, store, store, { workerId: 'replay', eventId: event.eventId,
        expiresAt: new Date(Date.parse(head.observedAt) + 30000).toISOString(), requireFreshSources: true }, new Date(head.observedAt))).toBe('IDLE');
      const recovered = await eventRef.get();
      expect(recovered.data()).toEqual(before.event);
      expect(await store.claimNext({ workerId: 'loop', now: head.observedAt,
        leaseUntil: new Date(Date.parse(head.observedAt) + 30000).toISOString() })).not.toMatchObject({ eventId: event.eventId });
      expect((await eventRef.get()).updateTime).toEqual(recovered.updateTime);
      expect(await store.getActive('erp-public')).toBeNull();
    } finally { await deleteApp(app); }
  });

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
    const sourceId = 'local-demo/catalog-file';
    const head = (await memory.getSourceHead(sourceId))!;
    const source = { ...(await memory.getSourceDefinition(sourceId))!, expectedFreshnessSeconds: 86400 };
    const run = (await memory.getSourceRun(head.runId))!;
    await db.collection(FIRESTORE_COLLECTIONS.source.definitions).doc(sourceFirestoreDocumentId(sourceId)).set(source);
    await db.collection(FIRESTORE_COLLECTIONS.source.heads).doc(sourceFirestoreDocumentId(sourceId)).set(head);
    await db.collection(FIRESTORE_COLLECTIONS.source.runs).doc(run.runId).set(run);
    const eventId = 'approved-multi-chunk-event';
    const lease = { leaseOwner: 'worker:emulator', leaseUntil: new Date(Date.parse(head.observedAt) + 30000).toISOString() };
    await db.collection(FIRESTORE_COLLECTIONS.evidence.outbox).doc(eventId).set({
      eventId, eventType: 'catalog.canonicalized', status: 'PROCESSING', ...lease,
      targetRevision: 1, attempts: 0, occurredAt: head.observedAt
    });
    const receipt = { eventId, eventType: 'catalog.canonicalized', projectionId: 'erp-public',
      releaseId, inputDigest: release.inputDigest, dataDigest: release.dataDigest,
      targetRevision: 1, processedAt: head.observedAt };
    await expect(store.activate(releaseId, { now: () => head.observedAt, sources: [] }))
      .rejects.toThrow('PROJECTION_FIRST_ACTIVATION_APPROVAL_REQUIRED');
    await store.activate(releaseId, { now: () => head.observedAt, expectedActiveReleaseId: null,
      claim: { eventId, lease }, receipt, sources: [{ sourceId, runId: run.runId,
      digest: stableDigest([source, head, run]), expiresAt: Date.parse(head.observedAt) + 86400000 }] });
    expect(await store.getDeliveryReceipt(eventId)).toEqual(receipt);

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

  it('rejects a canonical payload identity that differs from its document path', async () => {
    const { app, db } = createEmulatorFixture();

    try {
      await db.collection('catalog_products').doc('prod_path').set({
        id: 'prod_payload'
      });

      const readonly = dataHealthReader(db);
      await expect(readonly.listProducts())
        .rejects.toThrow('Firestore document identity mismatch');
    } finally {
      await deleteApp(app);
    }
  });

  it('blocks an erp-public pointer to mutually consistent evidence for another projection', async () => {
    const { app, db } = createEmulatorFixture();

    try {
      const memory = new MemoryDataStore();
      await seedDemoCatalog(memory);
      const active = await buildErpPublicProjection(
        memory,
        memory,
        '2026-09-21T10:00:00.000Z'
      );
      const manifest = await memory.getManifest(active.releaseId);
      const lineage = await memory.listProjectionLineage(active.releaseId);
      if (!manifest) throw new Error('projection fixture missing');

      const wrongLineage = lineage.map((item) => ({
        ...item,
        projectionId: 'wrong-projection'
      }));
      await db.collection('projection_active').doc('erp-public').set({
        releaseId: active.releaseId,
        projectionId: 'erp-public'
      });
      await db.collection('projection_releases').doc(active.releaseId).set({
        ...active,
        projectionId: 'wrong-projection'
      });
      await db.collection('projection_release_manifests').doc(active.releaseId).set({
        ...manifest,
        projectionId: 'wrong-projection',
        fieldEvidenceDigest: stableRecordSetDigest(wrongLineage)
      });
      for (const item of wrongLineage) {
        await db.collection('projection_field_lineage')
          .doc(item.lineageRecordId)
          .set(item);
      }

      const readonly = dataHealthReader(db);
      const report = await readCatalogDataHealth(
        readonly,
        readonly,
        '2026-09-21T10:01:00.000Z'
      );

      expect(report.status).toBe('BLOCKED');
      expect(report.issues).toContainEqual(expect.objectContaining({
        code: 'ACTIVE_RELEASE_PROJECTION_ID_MISMATCH',
        severity: 'ERROR'
      }));
    } finally {
      await deleteApp(app);
    }
  });
});
