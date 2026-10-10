import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { assertCatalogSourceFreshness, buildErpPublicProjection, processOneOutboxEvent, updateOfferPrice } from '../src/application/catalog.js';
import { readActiveProjectionEvidence } from '../src/application/projection-evidence-reader.js';
import { assertProjectionReleaseIntegrity, verifyProjectionReleaseIntegrity } from '../src/shared/projection-integrity.js';
import { stableDigest, stableRecordSetDigest } from '../src/shared/stable-digest.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { FirestoreDataStore } from '../src/infra/firestore-store.js';
import type { Firestore } from 'firebase-admin/firestore';

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
  async function scheduledFixture() {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const source = (await store.getSourceDefinition('local-demo/catalog-file'))!;
    const head = (await store.getSourceHead(source.sourceId))!;
    await store.seed({ sourceDefinitions: [{ ...source, expectedFreshnessSeconds: 60 }] });
    store.outbox.set('synthetic-event', { eventId: 'synthetic-event', eventType: 'catalog.canonicalized',
      entityType: 'product', entityId: 'prod_gv70_demo', sourceRevision: 0, targetRevision: 1,
      commandId: 'synthetic', correlationId: 'synthetic', causationId: 'synthetic',
      occurredAt: head.observedAt, status: 'PENDING', attempts: 0 });
    return { store, head };
  }

  it('claims only the specified event behind other pending events', async () => {
    const { store, head } = await scheduledFixture();
    const other = structuredClone(store.outbox.get('synthetic-event')!);
    store.outbox.set('other-event', { ...other, eventId: 'other-event', occurredAt: '2000-01-01T00:00:00.000Z' });
    const before = structuredClone(store.outbox.get('other-event'));
    expect(await processOneOutboxEvent(store, store, store, { workerId: 'single', eventId: 'synthetic-event',
      expiresAt: new Date(Date.parse(head.observedAt) + 30000).toISOString(), requireFreshSources: true }, new Date(head.observedAt))).toBe('DONE');
    expect(store.outbox.get('other-event')).toEqual(before);
    expect(store.outbox.get('synthetic-event')?.status).toBe('DONE');
    expect(await store.getDeliveryReceipt('synthetic-event')).not.toBeNull();
  });

  it('missing, busy and expired targets leave every outbox document unchanged', async () => {
    for (const mode of ['missing', 'busy', 'expired']) {
      const { store, head } = await scheduledFixture();
      if (mode === 'busy') Object.assign(store.outbox.get('synthetic-event')!, { status: 'PROCESSING', leaseOwner: 'other',
        leaseUntil: new Date(Date.parse(head.observedAt) + 60000).toISOString() });
      const before = structuredClone([...store.outbox]);
      const activate = vi.spyOn(store, 'activate');
      const receipt = vi.spyOn(store, 'putDeliveryReceipt');
      expect(await processOneOutboxEvent(store, store, store, { workerId: 'single',
        eventId: mode === 'missing' ? 'missing' : 'synthetic-event', expiresAt: mode === 'expired' ? head.observedAt :
          new Date(Date.parse(head.observedAt) + 30000).toISOString(), requireFreshSources: true }, new Date(head.observedAt)))
        .toBe(mode === 'expired' ? 'HOLD' : 'IDLE');
      expect([...store.outbox]).toEqual(before);
      expect(activate).not.toHaveBeenCalled();
      expect(receipt).not.toHaveBeenCalled();
    }
  });

  it('does not reset the claim when approval expires after atomic ACTIVE and receipt', async () => {
    const { store, head } = await scheduledFixture();
    let elapsed = 0;
    const timer = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const activate = store.activate.bind(store);
    vi.spyOn(store, 'activate').mockImplementation(async (...args) => {
      await activate(...args);
      elapsed = 31000;
    });
    const retry = vi.spyOn(store, 'markRetry');
    const done = vi.spyOn(store, 'markDone');
    try {
      expect(await processOneOutboxEvent(store, store, store, { workerId: 'single', eventId: 'synthetic-event',
        expiresAt: new Date(Date.parse(head.observedAt) + 30000).toISOString(), requireFreshSources: true }, new Date(head.observedAt))).toBe('HOLD');
      expect(await store.getActive('erp-public')).not.toBeNull();
      expect(await store.getDeliveryReceipt('synthetic-event')).not.toBeNull();
      expect(store.outbox.get('synthetic-event')?.status).toBe('PROCESSING');
      expect(retry).not.toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
    } finally { timer.mockRestore(); }
  });

  it('rejects a first-activation scope if a competing ACTIVE is already present', async () => {
    const { store, head } = await scheduledFixture();
    const active = await buildErpPublicProjection(store, store, head.observedAt);
    expect(await processOneOutboxEvent(store, store, store, { workerId: 'single', eventId: 'synthetic-event',
      expiresAt: new Date(Date.parse(head.observedAt) + 30000).toISOString(), requireFreshSources: true,
      expectedActiveReleaseId: null }, new Date(head.observedAt))).toBe('HOLD');
    expect((await store.getActive('erp-public'))?.releaseId).toBe(active.releaseId);
    expect(await store.getDeliveryReceipt('synthetic-event')).toBeNull();
    expect(store.outbox.get('synthetic-event')?.attempts).toBe(0);
  });

  it('rechecks approval and lease expiry after receipt reads before the native claim write', async () => {
    for (const elapsedAfterRead of [31000, 61000]) {
      let elapsed = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
      const update = vi.fn();
      const row = { eventId: 'approved', status: 'PENDING' };
      const ref = { get: async () => ({ exists: true, ref, data: () => row }) };
      const receipt = {};
      const db = { collection: (name: string) => ({ doc: () => name === 'outbox_events' ? ref : receipt }),
        runTransaction: async (body: any) => body({ get: async (target: any) => {
          if (target === ref) return { exists: true, data: () => row };
          elapsed = elapsedAfterRead;
          return { exists: false };
        }, update }) };
      try {
        expect(await new FirestoreDataStore(db as unknown as Firestore).claimNext({ workerId: 'approved',
          eventId: 'approved', now: '2026-10-09T00:00:00.000Z', leaseUntil: '2026-10-09T00:01:00.000Z',
          expiresAt: elapsedAfterRead === 31000 ? '2026-10-09T00:00:30.000Z' : '2026-10-09T00:02:00.000Z' })).toBeNull();
        expect(update).not.toHaveBeenCalled();
      } finally { clock.mockRestore(); }
    }
  });

  async function repriceFixture(store: MemoryDataStore, now: string) {
    await updateOfferPrice(store, { commandId: 'synthetic-reprice', idempotencyKey: 'synthetic-reprice',
      offerId: 'offer_gv70_demo', expectedRevision: 1, termKey: '36@20000',
      monthlyRent: { amount: 735000, currency: 'KRW' }, reason: 'crash regression',
      actor: { id: 'synthetic', kind: 'USER' } }, now);
    for (const id of store.outbox.keys()) if (id !== 'synthetic-event') store.outbox.delete(id);
  }

  it('holds a CURRENT but stale source before claiming and preserves old ACTIVE and retries', async () => {
    const { store, head } = await scheduledFixture();
    const old = await buildErpPublicProjection(store, store, head.observedAt);
    const before = structuredClone(store.outbox.get('synthetic-event'));
    const claim = vi.spyOn(store, 'claimNext');
    const late = new Date(Date.parse(head.observedAt) + 60_001);
    expect((await store.getSourceRun(head.runId))?.headStatus).toBe('CURRENT');
    expect(await processOneOutboxEvent(store, store, store, { workerId: 'synthetic', requireFreshSources: true }, late)).toBe('HOLD');
    expect(claim).not.toHaveBeenCalled();
    expect(store.outbox.get('synthetic-event')).toEqual(before);
    expect((await store.getActive('erp-public'))?.releaseId).toBe(old.releaseId);
    expect(await store.getDeliveryReceipt('synthetic-event')).toBeNull();
    await expect(buildErpPublicProjection(store, store, late.toISOString(), { activate: false, requireFreshSources: true }))
      .rejects.toThrow('PROJECTION_SOURCE_STALE');
  });

  it('releases a claim without spending retries when the source becomes stale after preflight', async () => {
    const { store, head } = await scheduledFixture();
    const old = await buildErpPublicProjection(store, store, head.observedAt);
    const event = store.outbox.get('synthetic-event')!;
    event.attempts = 2;
    const claim = store.claimNext.bind(store);
    vi.spyOn(store, 'claimNext').mockImplementation(async (input) => {
      const claimed = await claim(input);
      await store.seed({ sourceHeads: [{ ...head, observedAt: new Date(Date.parse(head.observedAt) - 60_001).toISOString() }] });
      return claimed;
    });
    expect(await processOneOutboxEvent(store, store, store,
      { workerId: 'synthetic', requireFreshSources: true, maxAttempts: 2 }, new Date(head.observedAt))).toBe('HOLD');
    expect(store.outbox.get(event.eventId)).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect((await store.getActive('erp-public'))?.releaseId).toBe(old.releaseId);
    expect(await store.getDeliveryReceipt(event.eventId)).toBeNull();
  });

  it('surfaces source-store failures without disguising them as freshness HOLD', async () => {
    const { store, head } = await scheduledFixture();
    vi.spyOn(store, 'getSourceDefinition').mockRejectedValue(new Error('TEST_PERMISSION_DENIED'));
    const claim = vi.spyOn(store, 'claimNext');
    await expect(processOneOutboxEvent(store, store, store,
      { workerId: 'synthetic', requireFreshSources: true }, new Date(head.observedAt)))
      .rejects.toThrow('TEST_PERMISSION_DENIED');
    expect(claim).not.toHaveBeenCalled();
  });

  it('accepts the exact freshness boundary and holds a future or missing head', async () => {
    const { store, head } = await scheduledFixture();
    const boundary = new Date(Date.parse(head.observedAt) + 60_000);
    await expect(assertCatalogSourceFreshness(store, boundary.toISOString(), true)).resolves.toHaveLength(1);
    expect(await processOneOutboxEvent(store, store, store, { workerId: 'synthetic', requireFreshSources: true,
      eventId: 'synthetic-event', expiresAt: new Date(boundary.getTime() + 30000).toISOString() },
      new Date(boundary.getTime() - 1000))).toBe('DONE');
    await store.seed({ sourceHeads: [{ ...head, observedAt: new Date(boundary.getTime() + 1).toISOString() }] });
    await expect(assertCatalogSourceFreshness(store, boundary.toISOString(), true))
      .rejects.toThrow('PROJECTION_SOURCE_TIME_INVALID');
    vi.spyOn(store, 'getSourceHead').mockResolvedValue(null);
    await expect(buildErpPublicProjection(store, store, boundary.toISOString(), { requireFreshSources: true }))
      .rejects.toThrow('PROJECTION_SOURCE_HEAD_UNVERIFIED');
  });

  it('holds an operational source without a freshness policy while local static preparation stays compatible', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await expect(buildErpPublicProjection(store, store, '2026-10-09T00:00:00.000Z', { activate: false, requireFreshSources: true }))
      .rejects.toThrow('PROJECTION_SOURCE_FRESHNESS_UNKNOWN');
    expect((await buildErpPublicProjection(store, store, '2026-10-09T00:00:00.000Z', { activate: false })).status).toBe('READY');
  });

  it.each(['stage', 'stageEvidence', 'markReady', 'activate', 'putDeliveryReceipt', 'markDone'] as const)(
    'recovers a lost %s response without duplicate delivery', async (operation) => {
      const { store, head } = await scheduledFixture();
      const old = await buildErpPublicProjection(store, store, head.observedAt);
      if (operation !== 'putDeliveryReceipt') await repriceFixture(store, head.observedAt);
      const original = store[operation].bind(store) as (...args: any[]) => Promise<void>;
      vi.spyOn(store, operation).mockImplementationOnce(async (...args: any[]) => {
        await original(...args);
        throw new Error('SIMULATED_LOST_RESPONSE');
      });
      const options = { workerId: 'synthetic', eventId: 'synthetic-event',
        expiresAt: new Date(Date.parse(head.observedAt) + 30000).toISOString(),
        requireFreshSources: true, baseBackoffMs: 1 };
      expect(await processOneOutboxEvent(store, store, store, options, new Date(head.observedAt)))
        .toBe(operation === 'markDone' ? 'HOLD' : 'RETRY');
      const afterFailure = await store.getActive('erp-public');
      if (['stage', 'stageEvidence', 'markReady'].includes(operation)) {
        expect(afterFailure?.releaseId).toBe(old.releaseId);
        expect(await store.getDeliveryReceipt('synthetic-event')).toBeNull();
      }
      expect(store.outbox.get('synthetic-event')).toMatchObject(operation === 'markDone'
        ? { status: 'DONE', attempts: 0 } : { status: 'PENDING', attempts: 1 });
      const activate = vi.spyOn(store, 'activate');
      activate.mockClear();
      expect(await processOneOutboxEvent(store, store, store, options,
        new Date(Date.parse(head.observedAt) + 1000))).toBe(operation === 'markDone' ? 'IDLE' : 'DONE');
      const final = await store.getActive('erp-public');
      expect(final?.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount).toBe(operation === 'putDeliveryReceipt' ? 690000 : 735000);
      expect((await store.getDeliveryReceipt('synthetic-event'))?.releaseId).toBe(final?.releaseId);
      expect(store.outbox.get('synthetic-event')).toMatchObject({ status: 'DONE', attempts: operation === 'markDone' ? 0 : 1 });
      if (['activate', 'putDeliveryReceipt', 'markDone'].includes(operation)) {
        expect(final?.releaseId).toBe(afterFailure?.releaseId);
        expect(activate).not.toHaveBeenCalled();
      }
    });

  it('reclaims a crashed claim only after lease expiry without spending an attempt', async () => {
    const { store, head } = await scheduledFixture();
    const now = Date.parse(head.observedAt);
    await store.claimNext({ workerId: 'crashed', now: head.observedAt,
      leaseUntil: new Date(now + 1000).toISOString() });
    expect(await processOneOutboxEvent(store, store, store,
      { workerId: 'replacement', requireFreshSources: true }, new Date(now + 999))).toBe('IDLE');
    expect(store.outbox.get('synthetic-event')).toMatchObject({ status: 'PROCESSING', attempts: 0, leaseOwner: 'crashed' });
    expect(await processOneOutboxEvent(store, store, store,
      { workerId: 'replacement', requireFreshSources: true, eventId: 'synthetic-event',
        expiresAt: new Date(now + 30000).toISOString() }, new Date(now + 1000))).toBe('DONE');
    expect(store.outbox.get('synthetic-event')).toMatchObject({ status: 'DONE', attempts: 0 });
  });

  it('preserves last-good ACTIVE when source freshness changes during release persistence', async () => {
    const { store, head } = await scheduledFixture();
    const old = await buildErpPublicProjection(store, store, head.observedAt);
    await repriceFixture(store, head.observedAt);
    const markReady = store.markReady.bind(store);
    vi.spyOn(store, 'markReady').mockImplementationOnce(async (id) => {
      await markReady(id);
      await store.seed({ sourceHeads: [{ ...head, observedAt: new Date(Date.parse(head.observedAt) - 60_001).toISOString() }] });
    });
    expect(await processOneOutboxEvent(store, store, store,
      { workerId: 'synthetic', eventId: 'synthetic-event',
        expiresAt: new Date(Date.parse(head.observedAt) + 30000).toISOString(),
        requireFreshSources: true }, new Date(head.observedAt))).toBe('HOLD');
    expect((await store.getActive('erp-public'))?.releaseId).toBe(old.releaseId);
    expect(await store.getDeliveryReceipt('synthetic-event')).toBeNull();
    expect(store.outbox.get('synthetic-event')).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it('uses elapsed build time when the source itself has not changed', async () => {
    const { store, head } = await scheduledFixture();
    const old = await buildErpPublicProjection(store, store, head.observedAt);
    await repriceFixture(store, head.observedAt);
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const markReady = store.markReady.bind(store);
    vi.spyOn(store, 'markReady').mockImplementationOnce(async id => {
      await markReady(id);
      elapsed = 60001;
    });
    try {
      expect(await processOneOutboxEvent(store, store, store,
        { workerId: 'synthetic', eventId: 'synthetic-event',
          expiresAt: new Date(Date.parse(head.observedAt) + 30000).toISOString(),
          requireFreshSources: true }, new Date(head.observedAt))).toBe('HOLD');
      expect(await store.getSourceHead(head.sourceId)).toEqual(head);
      expect((await store.getActive('erp-public'))?.releaseId).toBe(old.releaseId);
      expect(await store.getDeliveryReceipt('synthetic-event')).toBeNull();
      expect(store.outbox.get('synthetic-event')).toMatchObject({ status: 'PROCESSING', attempts: 0 });
    } finally { clock.mockRestore(); }
  });

  it('recovers an interrupted worker after atomic ACTIVE and receipt commit', async () => {
    const { store, head } = await scheduledFixture();
    await buildErpPublicProjection(store, store, head.observedAt);
    await repriceFixture(store, head.observedAt);
    const activateCommit = store.activate.bind(store);
    vi.spyOn(store, 'activate').mockImplementationOnce(async (id, guard) => {
      await activateCommit(id, guard);
      throw new Error('SIMULATED_CRASH');
    });
    vi.spyOn(store, 'markRetry').mockRejectedValueOnce(new Error('PROCESS_TERMINATED'));
    const options = { workerId: 'synthetic', eventId: 'synthetic-event',
      expiresAt: new Date(Date.parse(head.observedAt) + 30000).toISOString(),
      requireFreshSources: true, leaseMs: 1000 };
    await expect(processOneOutboxEvent(store, store, store, options, new Date(head.observedAt)))
      .rejects.toThrow('PROCESS_TERMINATED');
    const committed = await store.getActive('erp-public');
    expect(store.outbox.get('synthetic-event')).toMatchObject({ status: 'PROCESSING', attempts: 0 });
    expect((await store.getDeliveryReceipt('synthetic-event'))?.releaseId).toBe(committed?.releaseId);
    const activate = vi.spyOn(store, 'activate');
    expect(await processOneOutboxEvent(store, store, store, options,
      new Date(Date.parse(head.observedAt) + 1000))).toBe('DONE');
    expect(activate).not.toHaveBeenCalled();
    expect((await store.getDeliveryReceipt('synthetic-event'))?.releaseId).toBe(committed?.releaseId);
    expect(store.outbox.get('synthetic-event')).toMatchObject({ status: 'DONE', attempts: 0 });
  });

  it('does not acknowledge reused ACTIVE after source changes during the evidence read', async () => {
    const { store, head } = await scheduledFixture();
    const old = await buildErpPublicProjection(store, store, head.observedAt);
    const read = store.getActiveEvidenceSnapshot.bind(store);
    vi.spyOn(store, 'getActiveEvidenceSnapshot').mockImplementationOnce(async (id) => {
      const evidence = await read(id);
      await store.seed({ sourceHeads: [{ ...head, observedAt: new Date(Date.parse(head.observedAt) - 60_001).toISOString() }] });
      return evidence;
    });
    expect(await processOneOutboxEvent(store, store, store,
      { workerId: 'synthetic', eventId: 'synthetic-event',
        expiresAt: new Date(Date.parse(head.observedAt) + 30000).toISOString(),
        requireFreshSources: true }, new Date(head.observedAt))).toBe('HOLD');
    expect((await store.getActive('erp-public'))?.releaseId).toBe(old.releaseId);
    expect(await store.getDeliveryReceipt('synthetic-event')).toBeNull();
    expect(store.outbox.get('synthetic-event')).toMatchObject({ status: 'PENDING', attempts: 0 });
  });

  it.each(['markDone', 'markRetry', 'moveToDeadLetter'] as const)(
    'rejects stale owner %s after the expired claim is reclaimed', async (operation) => {
      const { store, head } = await scheduledFixture();
      const firstUntil = new Date(Date.parse(head.observedAt) + 1000).toISOString();
      await store.claimNext({ workerId: 'old', now: head.observedAt, leaseUntil: firstUntil });
      await store.claimNext({ workerId: 'new', now: firstUntil,
        leaseUntil: new Date(Date.parse(firstUntil) + 1000).toISOString() });
      const before = structuredClone(store.outbox.get('synthetic-event'));
      const oldLease = { leaseOwner: 'old', leaseUntil: firstUntil };
      const mutation = operation === 'markDone'
        ? store.markDone('synthetic-event', oldLease)
        : store[operation]({ eventId: 'synthetic-event', attempts: 7,
          nextAttemptAt: firstUntil, error: 'OLD_WORKER', lease: oldLease });
      await expect(mutation).rejects.toThrow('OUTBOX_LEASE_LOST');
      expect(store.outbox.get('synthetic-event')).toEqual(before);
    });

  it.each(['markDone', 'markRetry', 'moveToDeadLetter'] as const)(
    'checks lease identity transactionally before Firestore %s', async (operation) => {
      const update = vi.fn();
      const ref = {};
      let row = { status: 'PROCESSING', leaseOwner: 'new', leaseUntil: '2026-10-09T00:02:00.000Z' };
      const get = vi.fn(async () => ({ exists: true, data: () => row }));
      const db = { collection: () => ({ doc: () => ref }),
        runTransaction: async (body: any) => body({ get, update }) } as unknown as Firestore;
      const store = new FirestoreDataStore(db);
      const mutate = (lease: { leaseOwner: string; leaseUntil: string }) => operation === 'markDone'
        ? store.markDone('synthetic-event', lease)
        : store[operation]({ eventId: 'synthetic-event', attempts: 1,
          nextAttemptAt: '2026-10-09T00:03:00.000Z', error: 'synthetic', lease });
      await expect(mutate({ leaseOwner: 'old', leaseUntil: '2026-10-09T00:01:00.000Z' }))
        .rejects.toThrow('OUTBOX_LEASE_LOST');
      expect(get).toHaveBeenCalledWith(ref);
      expect(update).not.toHaveBeenCalled();
      const current = { leaseOwner: row.leaseOwner, leaseUntil: row.leaseUntil };
      await mutate(current);
      expect(update).toHaveBeenCalledOnce();
      update.mockClear();
      row = { ...row, status: 'DONE' };
      await expect(mutate(current)).rejects.toThrow('OUTBOX_LEASE_LOST');
      expect(update).not.toHaveBeenCalled();
    });

  it('does not release another worker claim when acknowledgement loses ownership', async () => {
    const { store, head } = await scheduledFixture();
    const acknowledge = store.markDone.bind(store);
    vi.spyOn(store, 'markDone').mockImplementationOnce(async (id, lease) => {
      await store.claimNext({ workerId: 'replacement', now: lease.leaseUntil,
        leaseUntil: new Date(Date.parse(lease.leaseUntil) + 1000).toISOString() });
      await acknowledge(id, lease);
    });
    const retry = vi.spyOn(store, 'markRetry');
    expect(await processOneOutboxEvent(store, store, store,
      { workerId: 'old', eventId: 'synthetic-event',
        expiresAt: new Date(Date.parse(head.observedAt) + 30000).toISOString(),
        requireFreshSources: true, leaseMs: 1000 }, new Date(head.observedAt))).toBe('HOLD');
    expect(retry).not.toHaveBeenCalled();
    expect(store.outbox.get('synthetic-event')).toMatchObject({ status: 'PROCESSING', leaseOwner: 'replacement', attempts: 0 });
    expect(await store.getDeliveryReceipt('synthetic-event')).not.toBeNull();
  });

  it.each(['activate', 'receipt'] as const)('fences Firestore %s source snapshot, claim and elapsed time in its transaction', async operation => {
    const { store, head } = await scheduledFixture();
    const release = await buildErpPublicProjection(store, store, head.observedAt, { activate: false });
    const manifest = (await store.getManifest(release.releaseId))!;
    const lineage = await store.listProjectionLineage(release.releaseId);
    const definition = await store.getSourceDefinition(head.sourceId);
    const run = await store.getSourceRun(head.runId);
    const lease = { leaseOwner: 'synthetic', leaseUntil: new Date(Date.parse(head.observedAt) + 30000).toISOString() };
    let current = head.observedAt;
    let changedHead = head;
    let owner = lease.leaseOwner;
    const guard = { now: () => current, sources: [{ sourceId: head.sourceId, runId: head.runId,
      digest: stableDigest([definition, head, run]), expiresAt: Date.parse(head.observedAt) + 60000 }],
      claim: { eventId: 'synthetic-event', lease } };
    const write = vi.fn();
    const get = vi.fn(async (ref: { name: string; id?: string; query?: boolean }) => {
      if (ref.query) return { docs: lineage.map(value => ({ data: () => value })) };
      const values: Record<string, unknown> = {
        projection_releases: release, projection_release_manifests: manifest,
        projection_active: { releaseId: release.releaseId }, sources: definition,
        source_heads: changedHead, source_runs: run,
        outbox_events: { status: 'PROCESSING', leaseOwner: owner, leaseUntil: lease.leaseUntil },
      };
      const value = values[ref.name];
      return { exists: !!value, data: () => value,
        get: (key: string) => (value as Record<string, unknown>)?.[key] };
    });
    const db = { collection: (name: string) => ({ doc: (id: string) => ({ name, id }),
      where: () => ({ name, query: true }) }), runTransaction: async (body: any) => body({ get, update: write, set: write, create: write }) } as unknown as Firestore;
    const target = new FirestoreDataStore(db);
    const receipt = { eventId: 'synthetic-event', eventType: 'catalog.canonicalized', projectionId: release.projectionId,
      releaseId: release.releaseId, inputDigest: release.inputDigest, dataDigest: release.dataDigest,
      targetRevision: 1, processedAt: head.observedAt };
    const publish = () => operation === 'activate' ? target.activate(release.releaseId, { ...guard, receipt }) : target.putDeliveryReceipt(receipt, guard);
    await publish();
    expect(write).toHaveBeenCalled();
    if (operation === 'activate') expect(write).toHaveBeenCalledWith(
      { name: 'projection_delivery_receipts', id: receipt.eventId }, receipt);
    write.mockClear();
    changedHead = { ...head, observedAt: new Date(Date.parse(head.observedAt) + 1).toISOString() };
    await expect(publish()).rejects.toThrow('PROJECTION_SOURCE_CHANGED');
    changedHead = head; owner = 'replacement';
    await expect(publish()).rejects.toThrow('OUTBOX_LEASE_LOST');
    owner = lease.leaseOwner; current = lease.leaseUntil;
    await expect(publish()).rejects.toThrow('OUTBOX_LEASE_LOST');
    current = new Date(Date.parse(head.observedAt) + 60001).toISOString();
    await expect(publish()).rejects.toThrow('PROJECTION_SOURCE_STALE');
    expect(write).not.toHaveBeenCalled();
  });

  it('runs the default and explicit worker preparation entrypoints once without activating a release', () => {
    for (const args of [
      ['src/worker.ts'],
      ['src/worker.ts', '--prepare'],
      ['scripts/run-memory.mjs', 'worker'],
      ['scripts/run-memory.mjs', 'worker', '--prepare']
    ]) {
      const output = execFileSync(process.execPath, ['--import', 'tsx', ...args], {
        encoding: 'utf8', timeout: 8000,
        env: { ...process.env, FREEPASS_DATA_DRIVER: 'memory', NODE_ENV: 'test' }
      });
      expect(JSON.parse(output)).toMatchObject({ mode: 'PREPARE', status: 'READY',
        persistentWrites: 0, projectionStore: 'memory' });
    }
  }, 15000);

  it('holds an unapproved first activation without marking the event done', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await updateOfferPrice(store, {
      commandId: 'cmd_unapproved_first_active',
      idempotencyKey: 'idem_unapproved_first_active',
      offerId: 'offer_gv70_demo',
      expectedRevision: 1,
      termKey: '36@20000',
      monthlyRent: { amount: 734000, currency: 'KRW' },
      reason: 'unapproved first activation regression',
      actor: { id: 'user:test', kind: 'USER' }
    }, '2026-09-20T10:00:00.000Z');
    const event = [...store.outbox.values()][0]!;

    expect(await processOneOutboxEvent(store, store, store, { workerId: 'worker:first-active' },
      new Date('2026-09-20T10:00:01.000Z'))).toBe('HOLD');

    expect(store.outbox.get(event.eventId)).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      leaseOwner: null,
      leaseUntil: null,
      lastError: 'PROJECTION_ACTIVATION_REQUIRES_APPROVED_EVENT_OR_ACTIVE_RELEASE'
    });
    expect(await store.getActive('erp-public')).toBeNull();
    expect(await store.getDeliveryReceipt(event.eventId)).toBeNull();
  });

  it('runs the memory worker execute loop and refreshes the ACTIVE release', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/run-memory.mjs', 'worker', '--execute'], {
      encoding: 'utf8', timeout: 8000,
      env: {
        ...process.env,
        FREEPASS_DATA_DRIVER: 'memory',
        FREEPASS_DATA_WORKER_TEST_REPRICE: '1',
        FREEPASS_DATA_WORKER_MAX_EVENTS: '1',
        NODE_ENV: 'test'
      }
    });

    expect(JSON.parse(output)).toMatchObject({
      mode: 'EXECUTE',
      result: 'DONE',
      processedEvents: 1,
      monthlyRent: 734000
    });
  }, 15000);

  it('prepares a validated release without activating or replacing the old good release', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const previous = await buildErpPublicProjection(store, store);
    const activate = vi.spyOn(store, 'activate');
    const ready = await buildErpPublicProjection(store, store, '2026-10-09T00:00:00.000Z', { activate: false });
    expect(ready.status).toBe('READY');
    expect(ready.releaseId).not.toBe(previous.releaseId);
    expect(activate).not.toHaveBeenCalled();
    expect((await store.getActive('erp-public'))?.releaseId).toBe(previous.releaseId);
    const manifest = await store.getManifest(ready.releaseId);
    expect(verifyProjectionReleaseIntegrity(ready, manifest!, await store.listProjectionLineage(ready.releaseId)).valid).toBe(true);
  });

  it('activates and receipts a claimed worker event without requiring an explicit event id option', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const previous = await buildErpPublicProjection(store, store);
    await updateOfferPrice(store, {
      commandId: 'cmd_stage_only_worker',
      idempotencyKey: 'idem_stage_only_worker',
      offerId: 'offer_gv70_demo',
      expectedRevision: 1,
      termKey: '36@20000',
      monthlyRent: { amount: 731000, currency: 'KRW' },
      reason: 'stage-only worker regression',
      actor: { id: 'user:test', kind: 'USER' }
    }, '2026-09-20T10:00:00.000Z');
    const event = [...store.outbox.values()][0]!;
    const activate = vi.spyOn(store, 'activate');

    expect(await processOneOutboxEvent(store, store, store, { workerId: 'worker:loop' },
      new Date('2026-09-20T10:00:01.000Z'))).toBe('DONE');

    expect(activate).toHaveBeenCalled();
    const active = await store.getActive('erp-public');
    expect(active?.releaseId).not.toBe(previous.releaseId);
    expect(active?.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount).toBe(731000);
    expect(await store.getDeliveryReceipt(event.eventId)).toMatchObject({
      eventId: event.eventId,
      releaseId: active?.releaseId,
      targetRevision: 2
    });
  });

  it('uses the same guarded activation path for the local console refresh', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const previous = await buildErpPublicProjection(store, store);
    await updateOfferPrice(store, {
      commandId: 'cmd_local_console_refresh',
      idempotencyKey: 'idem_local_console_refresh',
      offerId: 'offer_gv70_demo',
      expectedRevision: 1,
      termKey: '36@20000',
      monthlyRent: { amount: 733000, currency: 'KRW' },
      reason: 'local console refresh regression',
      actor: { id: 'user:test', kind: 'USER' }
    }, '2026-09-20T10:00:00.000Z');

    expect(await processOneOutboxEvent(store, store, store, {
      workerId: 'worker:local-console',
      expectedActiveReleaseId: previous.releaseId
    }, new Date('2026-09-20T10:00:01.000Z'))).toBe('DONE');

    const active = await store.getActive('erp-public');
    expect(active?.releaseId).not.toBe(previous.releaseId);
    expect(active?.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount).toBe(733000);
  });

  it('rejects replacing ACTIVE without an approved outbox transition', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const previous = await buildErpPublicProjection(store, store);
    await updateOfferPrice(store, {
      commandId: 'cmd_unapproved_activate',
      idempotencyKey: 'idem_unapproved_activate',
      offerId: 'offer_gv70_demo',
      expectedRevision: 1,
      termKey: '36@20000',
      monthlyRent: { amount: 732000, currency: 'KRW' },
      reason: 'unapproved activation regression',
      actor: { id: 'user:test', kind: 'USER' }
    }, '2026-09-20T10:00:00.000Z');
    const ready = await buildErpPublicProjection(store, store, '2026-09-20T10:00:01.000Z', { activate: false });

    await expect(store.activate(ready.releaseId))
      .rejects.toThrow('PROJECTION_ACTIVATION_APPROVAL_REQUIRED');
    expect((await store.getActive('erp-public'))?.releaseId).toBe(previous.releaseId);
  });

  it('requires an approved single-event guard for the first Firestore ERP activation', async () => {
    const data = [{ productId: 'p1', productRevision: 1, vehicleModelId: 'm1',
      displayName: 'demo', commercialType: 'USED_RENT' as const, vehicle: { maker: 'A', model: 'B' }, offers: [] }];
    const release = {
      releaseId: 'rel_first_guard',
      projectionId: 'erp-public',
      schemaVersion: '1.0.0',
      canonicalRevision: 0,
      manifestId: 'manifest_rel_first_guard',
      inputDigest: stableDigest([]),
      dataDigest: stableDigest(data),
      status: 'READY',
      generatedAt: '2026-10-09T00:00:00.000Z',
      data
    };
    const manifest = {
      manifestId: release.manifestId,
      releaseId: release.releaseId,
      projectionId: release.projectionId,
      schemaVersion: release.schemaVersion,
      generatedAt: release.generatedAt,
      canonicalInputs: [],
      productCount: 1,
      offerCount: 0,
      fieldEvidenceCount: 0,
      fieldEvidenceDigest: stableDigest([]),
      inputDigest: release.inputDigest,
      dataDigest: release.dataDigest
    };
    const get = vi.fn(async (ref: { name: string; query?: boolean }) => {
      if (ref.query) return { docs: [] };
      const values: Record<string, unknown> = {
        projection_releases: release,
        projection_release_manifests: manifest,
        projection_active: null
      };
      const value = values[ref.name];
      return { exists: !!value, data: () => value, get: (key: string) => (value as Record<string, unknown>)?.[key] };
    });
    const write = vi.fn();
    const db = { collection: (name: string) => ({ doc: (id: string) => ({ name, id }),
      where: () => ({ name, query: true }) }), runTransaction: async (body: any) => body({ get, update: write, set: write, create: write }) } as unknown as Firestore;

    await expect(new FirestoreDataStore(db).activate(release.releaseId))
      .rejects.toThrow('PROJECTION_FIRST_ACTIVATION_APPROVAL_REQUIRED');
    expect(write).not.toHaveBeenCalled();
  });

  it('retains old ACTIVE evidence after a staging failure and retries through a fresh release', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const previous = await buildErpPublicProjection(store, store);
    vi.spyOn(store, 'stageEvidence').mockRejectedValueOnce(new Error('EVIDENCE_STAGE_FAILED'));
    await expect(buildErpPublicProjection(store, store, '2026-10-09T00:00:00.000Z', { activate: false }))
      .rejects.toThrow('EVIDENCE_STAGE_FAILED');
    expect((await store.getActive('erp-public'))?.releaseId).toBe(previous.releaseId);
    const ready = await buildErpPublicProjection(store, store, '2026-10-09T00:00:00.000Z', { activate: false });
    expect(ready.status).toBe('READY');
    expect((await store.getActive('erp-public'))?.releaseId).toBe(previous.releaseId);
  });

  it('prepares the first release without silently performing the first cutover', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    const ready = await buildErpPublicProjection(store, store, '2026-10-09T00:00:00.000Z', { activate: false });
    expect(ready.status).toBe('READY');
    expect(await store.getActive('erp-public')).toBeNull();
  });

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
