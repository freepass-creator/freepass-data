import { describe, expect, it } from 'vitest';
import { ingestRawSourceBatch } from '../src/application/ingest-raw-source.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';
import { canAssertSourceAbsence } from '../src/domain/source.js';

describe('raw-first source intake', () => {
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
