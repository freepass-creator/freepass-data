import { describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { RevisionConflictError, buildErpPublicProjection, processOneOutboxEvent, updateOfferPrice } from '../src/application/catalog.js';

describe('Catalog V1 vertical slice', () => {
  it('is idempotent and rejects stale revisions', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    const command={
      commandId:'cmd_1',idempotencyKey:'idem_price_0001',offerId:'offer_gv70_demo',expectedRevision:1,termKey:'36@20000',
      monthlyRent:{amount:710000,currency:'KRW' as const},reason:'테스트 가격 변경',actor:{id:'user:test',kind:'USER' as const}
    };
    const first=await updateOfferPrice(store,command,'2026-09-20T10:00:00.000Z');
    const replay=await updateOfferPrice(store,command,'2026-09-20T10:00:01.000Z');
    expect(replay).toEqual(first); expect((await store.getOffer(command.offerId))?.revision).toBe(2);
    expect(store.audits).toHaveLength(1); expect(store.outbox.size).toBe(1);
    await expect(updateOfferPrice(store,{...command,commandId:'cmd_2',idempotencyKey:'idem_price_0002',expectedRevision:1}))
      .rejects.toBeInstanceOf(RevisionConflictError);
  });

  it('preserves commercial/offer/term boundaries in projection', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    const release=await buildErpPublicProjection(store,store,'2026-09-20T10:00:00.000Z');
    expect(release.data[0]?.commercialType).toBe('USED_RENT');
    expect(release.data[0]?.offers[0]?.priceTerms[0]?.termKey).toBe('36@20000');
    expect(release.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount).toBe(690000);
  });

  it('excludes UNKNOWN deposit terms from ERP public projection', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    const offer = await store.getOffer('offer_gv70_demo');
    await store.seed!({
      offers: [{
        ...offer!,
        priceTerms: offer!.priceTerms.map((term) => ({
          ...term,
          deposit: null,
          depositState: 'UNKNOWN' as const
        }))
      }]
    });

    const release=await buildErpPublicProjection(store,store,'2026-09-20T10:00:00.000Z');
    expect(release.data).toHaveLength(0);
  });

  it('outbox publishes repriced release', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    await buildErpPublicProjection(store,store,'2026-09-20T09:00:00.000Z');
    await updateOfferPrice(store,{
      commandId:'cmd_outbox',idempotencyKey:'idem_outbox_1',offerId:'offer_gv70_demo',expectedRevision:1,termKey:'36@20000',
      monthlyRent:{amount:730000,currency:'KRW'},reason:'outbox projection test',actor:{id:'user:test',kind:'USER'}
    },'2026-09-20T10:00:00.000Z');
    expect(await processOneOutboxEvent(store,store,store,{workerId:'worker:test'},new Date('2026-09-20T10:00:01.000Z'))).toBe('DONE');
    expect((await store.getActive('erp-public'))?.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount).toBe(730000);
  });
});
