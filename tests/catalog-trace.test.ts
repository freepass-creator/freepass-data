import { describe, expect, it } from 'vitest';
import { buildCatalogProductTrace } from '../src/application/catalog-trace.js';
import { buildErpPublicProjection, updateOfferPrice } from '../src/application/catalog.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { isLocalConsoleDriver } from '../src/api/console-access.js';

describe('local Catalog trace', () => {
  it('shows the real Source to consumer evidence chain', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(store, store, '2026-09-20T10:00:00.000Z');

    const trace = await buildCatalogProductTrace(
      store,
      store,
      'prod_gv70_demo',
      '2026-09-20T10:01:00.000Z'
    );

    expect(trace?.rows.map((row) => row.stage)).toEqual([
      'SOURCE',
      'RAW',
      'NORMALIZED',
      'CANONICAL',
      'PROJECTION',
      'RELEASE',
      'CONSUMER'
    ]);
    expect(trace?.counts).toMatchObject({
      sources: 1,
      rawRecords: 1,
      candidates: 1,
      canonicalEntities: 4,
      releases: 1,
      connectedConsumers: 0
    });
    expect(trace?.rows.find((row) => row.stage === 'RAW')?.details)
      .toMatchObject({ product_code: 'DEMO-GV70-001' });
    expect(trace?.rows.find((row) => row.stage === 'RAW')?.title).toBe('gv70-demo-001');
    expect(trace?.rows.find((row) => row.stage === 'NORMALIZED')?.title)
      .toBe('cand_demo_gv70_001');
    expect((await store.getRawRecord('raw_demo_gv70_001'))?.rawRecordId)
      .toBe('raw_demo_gv70_001');
    expect(trace?.rows.find((row) => row.stage === 'CONSUMER')?.status)
      .toBe('LOCAL_ONLY');
    expect(trace?.fieldFlows[0]).toMatchObject({
      label: '월 대여료',
      origin: 'SOURCE_LINEAGE',
      raw: { fieldPath: 'price_terms.36@20000.monthly_rent', value: 690000 },
      adapter: { normalizedValue: 690000 },
      canonical: { value: 690000 },
      projection: { value: 690000 },
      consumer: { value: 690000 }
    });
  });

  it('shows a manual price command as revision evidence in the next release', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(store, store, '2026-09-20T10:00:00.000Z');
    await updateOfferPrice(store, {
      commandId: 'cmd_trace_price',
      idempotencyKey: 'idem_trace_price',
      offerId: 'offer_gv70_demo',
      expectedRevision: 1,
      termKey: '36@20000',
      monthlyRent: { amount: 735000, currency: 'KRW' },
      reason: 'trace manual revision',
      actor: { id: 'user:test', kind: 'USER' }
    }, '2026-09-20T10:02:00.000Z');
    await buildErpPublicProjection(store, store, '2026-09-20T10:03:00.000Z');

    const trace = await buildCatalogProductTrace(store, store, 'prod_gv70_demo');
    const projection = trace?.rows.find((row) => row.stage === 'PROJECTION');
    expect(projection?.details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceOrigin: 'REVISION_HISTORY',
        canonical: expect.objectContaining({
          entityType: 'offer',
          entityId: 'offer_gv70_demo',
          revision: 2,
          fieldPath: 'priceTerms.36@20000.monthlyRent.amount',
          value: 735000
        })
      })
    ]));
    expect(trace?.rows.find((row) => row.stage === 'CANONICAL')?.summary)
      .toContain('735,000원');
    expect(trace?.rows.find((row) => row.stage === 'RAW')?.details)
      .toMatchObject({ price_terms: { '36@20000': { monthly_rent: 690000 } } });
    expect(trace?.fieldFlows.find((flow) => flow.label === '월 대여료'))
      .toMatchObject({
        origin: 'REVISION_HISTORY',
        raw: { value: 690000 },
        adapter: {
          normalizedValue: 690000,
          mode: 'COMMAND_CHANGED',
          decision: expect.stringContaining('명령으로 r2 값 변경')
        },
        canonical: { revision: 2, value: 735000 },
        projection: { value: 735000 },
        consumer: { value: 735000 }
      });
    expect(trace?.fieldFlows.find((flow) => flow.label === '보증금'))
      .toMatchObject({
        adapter: {
          mode: 'REVISION_CARRIED',
          decision: expect.stringContaining('이 필드값은 원천값 유지')
        },
        raw: { value: 3000000 },
        canonical: { revision: 2, value: 3000000 },
        projection: { value: 3000000 }
      });
  });

  it('uses HOLD instead of inventing missing source evidence', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(store, store, '2026-09-20T10:00:00.000Z');
    const missingEvidenceStore = new Proxy(store, {
      get(target, property) {
        if (property === 'listRawRecordsByRun' || property === 'listCandidatesByRun') {
          return async () => [];
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });

    const trace = await buildCatalogProductTrace(
      missingEvidenceStore,
      store,
      'prod_gv70_demo'
    );
    expect(trace?.rows.find((row) => row.stage === 'RAW')?.status).toBe('HOLD');
    expect(trace?.rows.find((row) => row.stage === 'NORMALIZED')?.status).toBe('HOLD');
  });

  it('does not call a shared-entity projection a successful product delivery', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await buildErpPublicProjection(store, store, '2026-09-20T10:00:00.000Z');
    const emptyProductProjection = {
      stage: store.stage.bind(store),
      stageEvidence: store.stageEvidence.bind(store),
      markReady: store.markReady.bind(store),
      activate: store.activate.bind(store),
      getActive: async (projectionId: string) => {
        const active = await store.getActive(projectionId);
        return active ? { ...active, data: [] } : null;
      },
      getManifest: store.getManifest.bind(store),
      listProjectionLineage: store.listProjectionLineage.bind(store),
      getDeliveryReceipt: store.getDeliveryReceipt.bind(store),
      putDeliveryReceipt: store.putDeliveryReceipt.bind(store)
    };
    const trace = await buildCatalogProductTrace(
      store,
      emptyProductProjection,
      'prod_gv70_demo'
    );
    expect(trace?.rows.find((row) => row.stage === 'PROJECTION')?.status).toBe('HOLD');
    expect(trace?.rows.find((row) => row.stage === 'PROJECTION')?.summary)
      .toContain('선택 상품 0건');
  });

  it('keeps raw trace routes local-only', () => {
    expect(isLocalConsoleDriver('memory')).toBe(true);
    expect(isLocalConsoleDriver('firestore')).toBe(false);
  });
});
