import { describe, expect, it } from 'vitest';
import { ingestLegacyProductSnapshot } from '../src/application/ingest-legacy-products.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';
import { canAssertSourceAbsence } from '../src/domain/source.js';

describe('legacy catalog ingestion', () => {
  it('persists immutable raw and normalized candidate without guessing blank deposit', async () => {
    const store = new MemorySourceStore();
    const run = await ingestLegacyProductSnapshot(store, {
      checkpoint: {
        sourceId: 'freepasserp3/firestore/products',
        checksum: 'snapshot-1',
        observedAt: '2026-09-20T10:00:00Z'
      },
      coverage: {
        mode: 'FULL',
        completeness: 'COMPLETE',
        scope: 'firestore:products'
      },
      records: [{
        sourceId: 'freepasserp3/firestore/products',
        sourceRecordId: '123가4567',
        observedAt: '2026-09-20T10:00:00Z',
        fingerprint: 'row-1',
        data: {
          product_code: 'P1',
          car_number: '123가4567',
          maker: '제네시스',
          model: 'GV70',
          product_type: '픽업구독',
          price: {
            '24_3만': { rent: '750,000', deposit: '' }
          }
        }
      }]
    }, '2026-09-20T10:00:01Z');

    expect(run?.status).toBe('COMPLETED');
    expect(run?.rawCount).toBe(1);
    expect(run?.candidateCount).toBe(1);
    expect(run?.lineageCount).toBeGreaterThan(0);
    expect(run?.headStatus).toBe('CURRENT');
    expect(canAssertSourceAbsence(run!)).toBe(true);

    const candidates = await store.listCandidates(run!.runId);
    expect(candidates[0]?.candidate.commercialType).toBe('PICKUP_SUBSCRIPTION');
    expect(candidates[0]?.candidate.priceTerms[0]?.depositState).toBe('UNKNOWN');
    expect(candidates[0]?.candidate.priceTerms[0]?.termKey).toBe('source:24_3만');

    const lineage = await store.listLineage(run!.runId);
    expect(lineage.some((item) =>
      item.source.fieldPath === 'product_type' &&
      item.normalized?.fieldPath === 'commercialType' &&
      item.normalized.value === 'PICKUP_SUBSCRIPTION'
    )).toBe(true);
    expect(lineage.some((item) =>
      item.source.fieldPath === 'price.24_3만.rent' &&
      item.normalized?.fieldPath === 'priceTerms.source:24_3만.monthlyRent.amount' &&
      item.normalized.value === 750000
    )).toBe(true);
    expect(lineage.every((item) => item.stage === 'RAW_TO_NORMALIZED')).toBe(true);
  });

  it('does not let a late older observation replace the accepted source head', async () => {
    const store = new MemorySourceStore();

    const newer = await ingestLegacyProductSnapshot(store, {
      checkpoint: {
        sourceId: 'freepasserp3/firestore/products',
        checksum: 'newer',
        observedAt: '2026-09-20T10:02:00Z'
      },
      coverage: { mode: 'FULL', completeness: 'COMPLETE', scope: 'firestore:products' },
      records: []
    }, '2026-09-20T10:03:00Z');

    const olderLate = await ingestLegacyProductSnapshot(store, {
      checkpoint: {
        sourceId: 'freepasserp3/firestore/products',
        checksum: 'older',
        observedAt: '2026-09-20T10:00:00Z'
      },
      coverage: { mode: 'FULL', completeness: 'COMPLETE', scope: 'firestore:products' },
      records: []
    }, '2026-09-20T10:05:00Z');

    const head = await store.getSourceHead('freepasserp3/firestore/products');
    expect(head?.runId).toBe(newer?.runId);
    expect(newer?.headStatus).toBe('CURRENT');
    expect(olderLate?.headStatus).toBe('STALE');
    expect(canAssertSourceAbsence(olderLate!)).toBe(false);
  });

  it('keeps incomplete collection reads as evidence but never treats absence as authoritative', async () => {
    const store = new MemorySourceStore();

    const incomplete = await ingestLegacyProductSnapshot(store, {
      checkpoint: {
        sourceId: 'freepasserp3/firestore/products',
        checksum: 'partial',
        observedAt: '2026-09-20T10:10:00Z'
      },
      coverage: {
        mode: 'PARTIAL',
        completeness: 'INCOMPLETE',
        scope: 'firestore:products',
        note: 'one page or segment failed'
      },
      records: []
    }, '2026-09-20T10:11:00Z');

    expect(incomplete?.status).toBe('COMPLETED');
    expect(incomplete?.headStatus).toBe('INELIGIBLE');
    expect(canAssertSourceAbsence(incomplete!)).toBe(false);
    expect(await store.getSourceHead('freepasserp3/firestore/products')).toBeNull();
  });
});
