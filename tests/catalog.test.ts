import { describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { IdempotencyConflictError, RevisionConflictError, buildErpPublicProjection, processOneOutboxEvent, updateOfferPrice } from '../src/application/catalog.js';
import { AuthorityDeniedError, resolveFieldAuthority } from '../src/domain/authority.js';
import { stableRecordSetDigest } from '../src/application/stable-digest.js';

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
    const history=await store.listEntityHistory('offer',command.offerId);
    expect(history).toHaveLength(2);
    expect(history[0]?.revision).toBe(1);
    expect(history[1]?.revision).toBe(2);
    expect(history[1]?.previousRevision).toBe(1);
    expect(history[1]?.origin).toBe('MANUAL_COMMAND');
    expect((history[1]?.snapshot as any)?.priceTerms[0]?.monthlyRent.amount).toBe(710000);
    await expect(updateOfferPrice(store,{...command,commandId:'cmd_2',idempotencyKey:'idem_price_0002',expectedRevision:1}))
      .rejects.toBeInstanceOf(RevisionConflictError);
    expect(await store.listEntityHistory('offer',command.offerId)).toHaveLength(2);
  });

  it('rejects idempotency key reuse with a different payload', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    const command={
      commandId:'cmd_idem_1',idempotencyKey:'idem_payload_0001',offerId:'offer_gv70_demo',expectedRevision:1,termKey:'36@20000',
      monthlyRent:{amount:710000,currency:'KRW' as const},reason:'테스트 가격 변경',actor:{id:'user:test',kind:'USER' as const}
    };
    await updateOfferPrice(store,command,'2026-09-20T10:00:00.000Z');
    await expect(updateOfferPrice(store,{
      ...command,
      commandId:'cmd_idem_2',
      monthlyRent:{amount:720000,currency:'KRW' as const}
    },'2026-09-20T10:00:01.000Z')).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await store.getOffer(command.offerId))?.revision).toBe(2);
    expect(store.audits).toHaveLength(1);
    expect(store.outbox.size).toBe(1);
  });

  it('resolves the monthly-rent field authority rule', () => {
    const rule=resolveFieldAuthority('offer','priceTerms.36@20000.monthlyRent');
    expect(rule?.ruleId).toBe('catalog.offer.price-term.monthly-rent.v1');
    expect(rule?.conflict).toBe('EXPECTED_REVISION');
    expect(rule?.sourceRefresh).toBe('PRESERVE_CANONICAL_AND_REVIEW');
  });

  it('rejects an unregistered service writer before mutation', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    await expect(updateOfferPrice(store,{
      commandId:'cmd_authority_1',idempotencyKey:'idem_authority_0001',offerId:'offer_gv70_demo',expectedRevision:1,termKey:'36@20000',
      monthlyRent:{amount:720000,currency:'KRW'},reason:'authority test',actor:{id:'service:unknown',kind:'SERVICE'}
    },'2026-09-20T10:00:00.000Z')).rejects.toBeInstanceOf(AuthorityDeniedError);
    expect((await store.getOffer('offer_gv70_demo'))?.revision).toBe(1);
    expect(store.audits).toHaveLength(0);
    expect(store.outbox.size).toBe(0);
  });

  it('allows the registered FreePass Data service writer', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    const receipt=await updateOfferPrice(store,{
      commandId:'cmd_authority_2',idempotencyKey:'idem_authority_0002',offerId:'offer_gv70_demo',expectedRevision:1,termKey:'36@20000',
      monthlyRent:{amount:725000,currency:'KRW'},reason:'authority test',actor:{id:'service:freepass-data',kind:'SERVICE'}
    },'2026-09-20T10:00:00.000Z');
    expect(receipt.status).toBe('CANONICAL_COMMITTED');
    expect(receipt.authorityRuleId).toBe('catalog.offer.price-term.monthly-rent.v1');
    expect(store.audits[0]?.authorityRuleId).toBe('catalog.offer.price-term.monthly-rent.v1');
    expect((await store.getOffer('offer_gv70_demo'))?.revision).toBe(2);
  });

  it('preserves commercial/offer/term boundaries in projection', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    const release=await buildErpPublicProjection(store,store,'2026-09-20T10:00:00.000Z');
    expect(release.data[0]?.commercialType).toBe('USED_RENT');
    expect(release.data[0]?.offers[0]?.priceTerms[0]?.termKey).toBe('36@20000');
    expect(release.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount).toBe(690000);
    const manifest=await store.getManifest(release.releaseId);
    expect(manifest?.releaseId).toBe(release.releaseId);
    expect(manifest?.inputDigest).toBe(release.inputDigest);
    expect(manifest?.dataDigest).toBe(release.dataDigest);
    expect(manifest?.canonicalInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({entityType:'vehicle_model',entityId:'vm_gv70_demo',revision:1}),
      expect.objectContaining({entityType:'vehicle_asset',entityId:'va_gv70_demo',revision:1}),
      expect.objectContaining({entityType:'product',entityId:'prod_gv70_demo',revision:1}),
      expect.objectContaining({entityType:'offer',entityId:'offer_gv70_demo',revision:1})
    ]));
    const lineage=await store.listProjectionLineage(release.releaseId);
    expect(lineage.length).toBe(manifest?.fieldEvidenceCount);
    expect(manifest?.fieldEvidenceDigest).toBe(stableRecordSetDigest(lineage));
    expect(stableRecordSetDigest([...lineage].reverse()))
      .toBe(manifest?.fieldEvidenceDigest);
  });

  it('does not reuse an ACTIVE release whose manifest lacks lineage digest', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    const first=await buildErpPublicProjection(store,store,'2026-09-20T09:00:00.000Z');

    const legacyManifestProjection={
      stage: store.stage.bind(store),
      stageEvidence: store.stageEvidence.bind(store),
      markReady: store.markReady.bind(store),
      activate: store.activate.bind(store),
      getActive: store.getActive.bind(store),
      getManifest: async (releaseId:string) => {
        const manifest=await store.getManifest(releaseId);
        if (!manifest) return null;
        const {fieldEvidenceDigest: _legacyOmitted, ...legacyManifest}=manifest;
        return legacyManifest;
      },
      listProjectionLineage: store.listProjectionLineage.bind(store),
      getDeliveryReceipt: store.getDeliveryReceipt.bind(store),
      putDeliveryReceipt: store.putDeliveryReceipt.bind(store)
    };

    const second=await buildErpPublicProjection(
      store,
      legacyManifestProjection,
      '2026-09-20T09:01:00.000Z'
    );

    expect(second.releaseId).not.toBe(first.releaseId);
    expect((await store.getManifest(second.releaseId))?.fieldEvidenceDigest).toBeTruthy();
  });

  it('rejects same-count lineage tamper before READY promotion', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    const tamperingProjection={
      stage: store.stage.bind(store),
      stageEvidence: async (input: Parameters<typeof store.stageEvidence>[0]) => {
        const lineage=structuredClone(input.lineage);
        if (lineage[0]) {
          lineage[0]={
            ...lineage[0],
            projection:{
              ...lineage[0].projection,
              value:'tampered-before-ready'
            }
          };
        }
        return store.stageEvidence({manifest:input.manifest,lineage});
      },
      markReady: store.markReady.bind(store),
      activate: store.activate.bind(store),
      getActive: store.getActive.bind(store),
      getManifest: store.getManifest.bind(store),
      listProjectionLineage: store.listProjectionLineage.bind(store),
      getDeliveryReceipt: store.getDeliveryReceipt.bind(store),
      putDeliveryReceipt: store.putDeliveryReceipt.bind(store)
    };

    await expect(buildErpPublicProjection(
      store,
      tamperingProjection,
      '2026-09-20T10:00:00.000Z'
    )).rejects.toThrow('Projection field evidence digest mismatch');

    expect(await store.getActive('erp-public')).toBeNull();
  });

  it('excludes UNKNOWN deposit terms from ERP public projection', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    const offer = await store.getOffer('offer_gv70_demo');
    const updatedOffer={
      ...offer!,
      priceTerms: offer!.priceTerms.map((term) => ({
        ...term,
        deposit: null,
        depositState: 'UNKNOWN' as const
      }))
    };
    const [offerRevision]=await store.listEntityHistory('offer','offer_gv70_demo');
    await store.seed!({
      offers: [updatedOffer],
      revisionHistory: [{
        ...offerRevision!,
        snapshot: updatedOffer
      }]
    });

    const release=await buildErpPublicProjection(store,store,'2026-09-20T10:00:00.000Z');
    expect(release.data).toHaveLength(0);
  });

  it('rejects a release when Canonical state drifted without a new revision snapshot', async () => {
    const store=new MemoryDataStore();
    await seedDemoCatalog(store);
    const baseline=await buildErpPublicProjection(
      store,
      store,
      '2026-09-20T09:00:00.000Z'
    );

    const offer=await store.getOffer('offer_gv70_demo');
    await store.seed!({
      offers: [{
        ...offer!,
        priceTerms: offer!.priceTerms.map((term) => ({
          ...term,
          monthlyRent:{amount:999000,currency:'KRW' as const}
        }))
      }]
    });

    await expect(buildErpPublicProjection(
      store,
      store,
      '2026-09-20T10:00:00.000Z'
    )).rejects.toThrow('snapshot drift');

    expect((await store.getActive('erp-public'))?.releaseId).toBe(baseline.releaseId);
  });

  it('keeps the last-known-good ACTIVE release when evidence staging fails', async () => {
    const store=new MemoryDataStore();
    await seedDemoCatalog(store);
    const baseline=await buildErpPublicProjection(
      store,
      store,
      '2026-09-20T09:00:00.000Z'
    );

    // Change a canonical input so release reuse cannot bypass evidence staging.
    await updateOfferPrice(store, {
      commandId: 'cmd_evidence_failure',
      idempotencyKey: 'idem_evidence_failure',
      offerId: 'offer_gv70_demo',
      expectedRevision: 1,
      termKey: '36@20000',
      monthlyRent: { amount: 710000, currency: 'KRW' },
      reason: 'exercise evidence failure on a new release',
      actor: { id: 'user:test', kind: 'USER' }
    });

    const failingProjection={
      stage: store.stage.bind(store),
      stageEvidence: async () => {
        throw new Error('simulated evidence staging failure');
      },
      markReady: store.markReady.bind(store),
      activate: store.activate.bind(store),
      getActive: store.getActive.bind(store),
      getManifest: store.getManifest.bind(store),
      listProjectionLineage: store.listProjectionLineage.bind(store),
      getDeliveryReceipt: store.getDeliveryReceipt.bind(store),
      putDeliveryReceipt: store.putDeliveryReceipt.bind(store)
    };

    await expect(buildErpPublicProjection(
      store,
      failingProjection,
      '2026-09-20T10:00:00.000Z'
    )).rejects.toThrow('simulated evidence staging failure');

    const active=await store.getActive('erp-public');
    expect(active?.releaseId).toBe(baseline.releaseId);
    expect(active?.status).toBe('ACTIVE');
  });

  it('reuses the ACTIVE release when Canonical inputs and output are unchanged', async () => {
    const store=new MemoryDataStore();
    await seedDemoCatalog(store);

    const first=await buildErpPublicProjection(
      store,
      store,
      '2026-09-20T09:00:00.000Z'
    );
    const second=await buildErpPublicProjection(
      store,
      store,
      '2026-09-20T09:01:00.000Z'
    );

    expect(second.releaseId).toBe(first.releaseId);
    expect(second.inputDigest).toBe(first.inputDigest);
    expect(second.dataDigest).toBe(first.dataDigest);
  });

  it('converges out-of-order catalog events on the current Canonical release', async () => {
    const store=new MemoryDataStore();
    await seedDemoCatalog(store);

    await updateOfferPrice(store,{
      commandId:'cmd_order_r2',
      idempotencyKey:'idem_order_r2',
      offerId:'offer_gv70_demo',
      expectedRevision:1,
      termKey:'36@20000',
      monthlyRent:{amount:720000,currency:'KRW'},
      reason:'r2 update',
      actor:{id:'user:test',kind:'USER'}
    },'2026-09-20T10:00:00.000Z');

    await updateOfferPrice(store,{
      commandId:'cmd_order_r3',
      idempotencyKey:'idem_order_r3',
      offerId:'offer_gv70_demo',
      expectedRevision:2,
      termKey:'36@20000',
      monthlyRent:{amount:740000,currency:'KRW'},
      reason:'r3 update',
      actor:{id:'user:test',kind:'USER'}
    },'2026-09-20T10:01:00.000Z');

    const r2=[...store.outbox.values()].find((item)=>item.targetRevision===2)!;
    const r3=[...store.outbox.values()].find((item)=>item.targetRevision===3)!;
    r2.occurredAt='2026-09-20T10:03:00.000Z';
    r3.occurredAt='2026-09-20T10:02:00.000Z';

    expect(await processOneOutboxEvent(
      store,store,store,
      {workerId:'worker:out-of-order'},
      new Date('2026-09-20T10:04:00.000Z')
    )).toBe('DONE');

    const afterR3=await store.getActive('erp-public');
    expect(afterR3?.data[0]?.offers[0]?.offerRevision).toBe(3);
    expect(afterR3?.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount).toBe(740000);

    expect(await processOneOutboxEvent(
      store,store,store,
      {workerId:'worker:out-of-order'},
      new Date('2026-09-20T10:05:00.000Z')
    )).toBe('DONE');

    const afterLateR2=await store.getActive('erp-public');
    expect(afterLateR2?.releaseId).toBe(afterR3?.releaseId);
    expect(afterLateR2?.data[0]?.offers[0]?.offerRevision).toBe(3);
    expect((await store.getDeliveryReceipt(r2.eventId))?.releaseId).toBe(afterR3?.releaseId);
    expect((await store.getDeliveryReceipt(r3.eventId))?.releaseId).toBe(afterR3?.releaseId);
  });

  it('does not create a second release when delivery acknowledgement retries', async () => {
    const store=new MemoryDataStore();
    await seedDemoCatalog(store);
    await updateOfferPrice(store,{
      commandId:'cmd_retry_delivery',
      idempotencyKey:'idem_retry_delivery',
      offerId:'offer_gv70_demo',
      expectedRevision:1,
      termKey:'36@20000',
      monthlyRent:{amount:735000,currency:'KRW'},
      reason:'delivery retry test',
      actor:{id:'user:test',kind:'USER'}
    },'2026-09-20T10:00:00.000Z');

    let failMarkDone=true;
    const flakyOutbox={
      claimNext: store.claimNext.bind(store),
      markDone: async (eventId:string) => {
        if (failMarkDone) {
          failMarkDone=false;
          throw new Error('simulated acknowledgement failure');
        }
        return store.markDone(eventId);
      },
      markRetry: store.markRetry.bind(store),
      moveToDeadLetter: store.moveToDeadLetter.bind(store)
    };

    expect(await processOneOutboxEvent(
      store,
      flakyOutbox,
      store,
      {workerId:'worker:retry'},
      new Date('2026-09-20T10:01:00.000Z')
    )).toBe('RETRY');

    const [event]=[...store.outbox.values()];
    const firstRelease=await store.getActive('erp-public');
    expect(await store.getDeliveryReceipt(event!.eventId)).not.toBeNull();

    expect(await processOneOutboxEvent(
      store,
      flakyOutbox,
      store,
      {workerId:'worker:retry'},
      new Date('2026-09-20T10:02:00.000Z')
    )).toBe('DONE');

    expect((await store.getActive('erp-public'))?.releaseId).toBe(firstRelease?.releaseId);
    expect((await store.getDeliveryReceipt(event!.eventId))?.releaseId)
      .toBe(firstRelease?.releaseId);
  });

  it('outbox publishes repriced release', async () => {
    const store=new MemoryDataStore(); await seedDemoCatalog(store);
    await buildErpPublicProjection(store,store,'2026-09-20T09:00:00.000Z');
    await updateOfferPrice(store,{
      commandId:'cmd_outbox',idempotencyKey:'idem_outbox_1',offerId:'offer_gv70_demo',expectedRevision:1,termKey:'36@20000',
      monthlyRent:{amount:730000,currency:'KRW'},reason:'outbox projection test',actor:{id:'user:test',kind:'USER'}
    },'2026-09-20T10:00:00.000Z');
    expect(await processOneOutboxEvent(store,store,store,{workerId:'worker:test'},new Date('2026-09-20T10:00:01.000Z'))).toBe('DONE');
    const active=await store.getActive('erp-public');
    expect(active?.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount).toBe(730000);
    const manifest=await store.getManifest(active!.releaseId);
    expect(manifest?.canonicalInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({entityType:'offer',entityId:'offer_gv70_demo',revision:2})
    ]));
    const priceEvidence=(await store.listProjectionLineage(active!.releaseId))
      .find((item) =>
        item.canonical.entityType==='offer' &&
        item.canonical.entityId==='offer_gv70_demo' &&
        item.canonical.revision===2 &&
        item.canonical.fieldPath==='priceTerms.36@20000.monthlyRent.amount'
      );
    expect(priceEvidence?.evidenceOrigin).toBe('REVISION_HISTORY');
    expect(priceEvidence?.revisionRecordId).toBeTruthy();
    expect(priceEvidence?.projection.value).toBe(730000);
  });
});
