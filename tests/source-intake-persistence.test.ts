import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { FirestoreSourceStore } from '../src/infra/source-firestore-store.js';
import { ingestRawSourceBatch } from '../src/application/ingest-raw-source.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';
import { canAssertSourceAbsence } from '../src/domain/source.js';

describe('raw-first source intake', () => {
  const retryBatch = (observedAt = '2026-10-09T00:00:00.000Z') => ({
    laneId: 'SUPPLIER' as const,
    source: { sourceId: 'synthetic/retry', kind: 'FILE' as const, displayName: 'Synthetic retry' },
    observedAt, coverage: { mode: 'FULL' as const, completeness: 'COMPLETE' as const },
    records: [{ sourceRecordId: 'one', payload: { amount: null } },
      { sourceRecordId: 'two', payload: { amount: 0 } }]
  });

  it('preserves the accepted head after a committed completion loses its response', async () => {
    const store = new MemorySourceStore();
    const complete = store.completeRun.bind(store);
    vi.spyOn(store, 'completeRun').mockImplementationOnce(async input => {
      await complete(input);
      throw new Error('COMPLETION_RESPONSE_LOST');
    });
    await expect(ingestRawSourceBatch(store, retryBatch())).rejects.toThrow('COMPLETION_RESPONSE_LOST');
    const head = await store.getSourceHead('synthetic/retry');
    const committed = await store.getRun(head!.runId);
    expect(committed).toMatchObject({ status: 'COMPLETED', headStatus: 'CURRENT', rawCount: 2 });
    const replay = await ingestRawSourceBatch(store, retryBatch());
    expect(replay).toEqual(committed);
    expect(await store.listRaw(replay.runId)).toHaveLength(2);
  });

  it('keeps partial RAW immutable and the old head usable, then accepts a fresh capture', async () => {
    const store = new MemorySourceStore();
    const good = await ingestRawSourceBatch(store, retryBatch());
    const append = store.appendRaw.bind(store);
    let calls = 0;
    const spy = vi.spyOn(store, 'appendRaw').mockImplementation(async row => {
      if (++calls === 2) throw new Error('SECOND_RAW_FAILED');
      await append(row);
    });
    const failedBatch = retryBatch('2026-10-09T00:01:00.000Z');
    await expect(ingestRawSourceBatch(store, failedBatch)).rejects.toThrow('SECOND_RAW_FAILED');
    expect((await store.getSourceHead('synthetic/retry'))?.runId).toBe(good.runId);
    await expect(ingestRawSourceBatch(store, failedBatch)).rejects.toThrow('SOURCE_INTAKE_RUN_ALREADY_EXISTS');
    spy.mockRestore();
    const recovered = await ingestRawSourceBatch(store, retryBatch('2026-10-09T00:02:00.000Z'));
    expect(recovered.headStatus).toBe('CURRENT');
    expect((await store.getRun(good.runId))?.headStatus).toBe('STALE');
    expect(await store.listRaw(recovered.runId)).toHaveLength(2);
  });

  it('checks Firestore run status in the failure transaction before mutating it', async () => {
    const update = vi.fn();
    const ref = {};
    let status = 'COMPLETED';
    const db = { collection: () => ({ doc: () => ref }),
      runTransaction: async (fn: (tx: unknown) => Promise<void>) => fn({
        get: async () => ({ exists: true, get: () => status }), update
      }) } as unknown as Firestore;
    const store = new FirestoreSourceStore(db);
    const input = { runId: 'synthetic', completedAt: '2026-10-09T00:00:00.000Z', error: 'late failure' };
    await store.failRun(input);
    expect(update).not.toHaveBeenCalled();
    status = 'RUNNING';
    await store.failRun(input);
    expect(update).toHaveBeenCalledWith(ref, { status: 'FAILED', completedAt: input.completedAt, error: input.error });
    status = 'FAILED';
    update.mockClear();
    await store.failRun({ ...input, error: 'second failure' });
    expect(update).not.toHaveBeenCalled();
  });

  it('persists settlement source rows as RAW evidence without inventing Canonical facts', async () => {
    const store = new MemorySourceStore();
    const run = await ingestRawSourceBatch(store, {
      laneId: 'SETTLEMENT',
      source: {
        sourceId: 'freepass-admin/settlement/export',
        kind: 'FILE',
        displayName: 'Settlement export',
        authorityScope: ['settlement:source-evidence'],
      },
      observedAt: '2026-09-27T05:00:00+09:00',
      sourceRevision: 'export-20260927-0500',
      checksum: 'a'.repeat(64),
      coverage: {
        mode: 'FULL',
        completeness: 'COMPLETE',
        scope: 'settlement-export',
      },
      records: [
        {
          sourceRecordId: 'settlement-1',
          payload: {
            applicationId: 'app-1',
            billedAmount: 1160000,
            paid: null,
          },
        },
      ],
    }, '2026-09-27T05:00:01+09:00');

    expect(run.status).toBe('COMPLETED');
    expect(run.rawCount).toBe(1);
    expect(run.candidateCount).toBe(0);
    expect(run.headStatus).toBe('CURRENT');
    expect(canAssertSourceAbsence(run)).toBe(true);

    const rows = await store.listRaw(run.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      intakeLaneId: 'SETTLEMENT',
      sourceId: 'freepass-admin/settlement/export',
      sourceRecordId: 'settlement-1',
      sourceRevision: 'export-20260927-0500',
      sourceChecksum: 'a'.repeat(64),
    });
    expect(rows[0]?.payload).toEqual({
      applicationId: 'app-1',
      billedAmount: 1160000,
      paid: null,
    });
    expect(await store.listCandidates(run.runId)).toEqual([]);
  });

  it('replays the same batch idempotently instead of duplicating raw records', async () => {
    const store = new MemorySourceStore();
    const batch = {
      laneId: 'SUPPLIER' as const,
      source: {
        sourceId: 'freepasserp5/firestore/partner',
        kind: 'FIRESTORE' as const,
        displayName: 'ERP5 partner',
      },
      observedAt: '2026-09-27T05:05:00+09:00',
      sourceRevision: 'capture:one',
      checksum: 'b'.repeat(64),
      coverage: { mode: 'FULL' as const, completeness: 'COMPLETE' as const },
      records: [
        { sourceRecordId: 'partner-1', payload: { name: 'Supplier A' } },
      ],
    };

    const first = await ingestRawSourceBatch(
      store,
      batch,
      '2026-09-27T05:05:01+09:00'
    );
    const second = await ingestRawSourceBatch(
      store,
      batch,
      '2026-09-27T05:05:02+09:00'
    );

    expect(second.runId).toBe(first.runId);
    expect((await store.listRaw(first.runId))).toHaveLength(1);
  });

  it('does not make incomplete source coverage authoritative for absence', async () => {
    const store = new MemorySourceStore();
    const run = await ingestRawSourceBatch(store, {
      laneId: 'PRODUCT_VEHICLE',
      source: {
        sourceId: 'supplier/demo/products',
        kind: 'API',
        displayName: 'Demo supplier products',
      },
      observedAt: '2026-09-27T05:10:00+09:00',
      coverage: {
        mode: 'PARTIAL',
        completeness: 'INCOMPLETE',
        note: 'page 2 failed',
      },
      records: [],
    }, '2026-09-27T05:10:01+09:00');

    expect(run.headStatus).toBe('INELIGIBLE');
    expect(canAssertSourceAbsence(run)).toBe(false);
  });

  it('rejects duplicate source record ids and malformed checksums', async () => {
    const store = new MemorySourceStore();
    await expect(ingestRawSourceBatch(store, {
      laneId: 'SUPPLIER',
      source: {
        sourceId: 'supplier/demo',
        kind: 'FILE',
        displayName: 'Demo supplier',
      },
      observedAt: '2026-09-27T05:15:00+09:00',
      checksum: 'bad',
      coverage: { mode: 'FULL', completeness: 'COMPLETE' },
      records: [],
    })).rejects.toThrow('INVALID_SOURCE_INTAKE_CHECKSUM');

    await expect(ingestRawSourceBatch(store, {
      laneId: 'SUPPLIER',
      source: {
        sourceId: 'supplier/demo',
        kind: 'FILE',
        displayName: 'Demo supplier',
      },
      observedAt: '2026-09-27T05:15:00+09:00',
      coverage: { mode: 'FULL', completeness: 'COMPLETE' },
      records: [
        { sourceRecordId: 'same', payload: {} },
        { sourceRecordId: 'same', payload: {} },
      ],
    })).rejects.toThrow('INVALID_SOURCE_INTAKE_RECORD');
  });
});
