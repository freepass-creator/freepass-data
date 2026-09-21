import { describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { seedDemoCatalog } from '../src/demo-seed.js';
import { updateOfferPrice } from '../src/application/catalog.js';
import { createManualCatalogEntry } from '../src/application/manual-catalog-entry.js';
import { canonicalizeCatalogCandidate } from '../src/application/canonicalize-catalog-candidate.js';
import { applyReviewedSourceChange } from '../src/application/reviewed-source-change.js';
import { transferCatalogWriterOwnership } from '../src/application/writer-ownership.js';
import {
  WriterOwnershipConflictError,
  WriterOwnershipDeniedError,
  WriterOwnershipTransferIdempotencyConflictError,
  WriterOwnershipTransferRejectedError
} from '../src/domain/writer-ownership.js';

const DATA_WRITER = {
  id: 'service:freepass-data',
  kind: 'SERVICE' as const
};

const OLD_WRITER = {
  id: 'service:freepass-admin',
  kind: 'SERVICE' as const
};

async function transferToData(store: MemoryDataStore) {
  return transferCatalogWriterOwnership(
    store,
    {
      commandId: 'cmd-transfer-catalog-writer',
      idempotencyKey: 'idem-transfer-catalog-writer',
      expectedRevision: 0,
      toWriterId: DATA_WRITER.id,
      actor: { id: 'user:owner', kind: 'USER' },
      writer: DATA_WRITER,
      reason: 'move canonical Catalog writes behind FreePass Data'
    },
    '2026-09-21T01:00:00.000Z'
  );
}

function oldWriterPriceCommand() {
  return {
    commandId: 'cmd-old-writer-price',
    idempotencyKey: 'idem-old-writer-price',
    offerId: 'offer_gv70_demo',
    expectedRevision: 1,
    termKey: '36@20000',
    monthlyRent: { amount: 720000, currency: 'KRW' as const },
    reason: 'legacy writer attempt',
    actor: OLD_WRITER,
    writer: OLD_WRITER
  };
}

function validManualEntry() {
  return {
    commandId: 'cmd-old-writer-manual',
    idempotencyKey: 'idem-old-writer-manual',
    entry: {
      maker: '현대',
      model: '아반떼',
      commercialType: 'USED_RENT' as const,
      supplierId: 'supplier:test',
      priceTerms: [{
        termMonths: 36,
        monthlyRent: { amount: 490000, currency: 'KRW' as const },
        depositState: 'ZERO' as const,
        deposit: { amount: 0, currency: 'KRW' as const }
      }]
    },
    actor: OLD_WRITER,
    writer: OLD_WRITER,
    reason: 'legacy manual writer attempt'
  };
}

describe('Catalog writer ownership transfer', () => {
  it('keeps legacy shared writers compatible before transfer', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);

    const receipt = await updateOfferPrice(
      store,
      oldWriterPriceCommand(),
      '2026-09-21T00:30:00.000Z'
    );

    expect(receipt.status).toBe('CANONICAL_COMMITTED');
    expect(receipt.writerId).toBe(OLD_WRITER.id);
    expect((await store.getOffer('offer_gv70_demo'))?.revision).toBe(2);
  });

  it('transfers Catalog writer ownership to FreePass Data with revision and audit evidence', async () => {
    const store = new MemoryDataStore();

    const receipt = await transferToData(store);
    const ownership = await store.getCatalogWriterOwnership();

    expect(receipt.status).toBe('TRANSFERRED');
    expect(receipt.previousRevision).toBe(0);
    expect(receipt.revision).toBe(1);
    expect(receipt.primaryWriterId).toBe(DATA_WRITER.id);
    expect(receipt.previousWriterIds).toContain(OLD_WRITER.id);
    expect(receipt.writerId).toBe(DATA_WRITER.id);

    expect(ownership).toEqual(expect.objectContaining({
      scope: 'catalog',
      revision: 1,
      mode: 'EXCLUSIVE',
      primaryWriterId: DATA_WRITER.id,
      allowedWriterIds: [DATA_WRITER.id]
    }));
    expect(ownership?.previousWriterIds).toContain(OLD_WRITER.id);

    expect(store.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: 'writer_ownership',
        entityId: 'catalog',
        action: 'CATALOG_WRITER_OWNERSHIP_TRANSFERRED',
        writerId: DATA_WRITER.id,
        revisionBefore: 0,
        revisionAfter: 1
      })
    ]));
  });

  it('replays the same transfer and rejects idempotency-key payload reuse', async () => {
    const store = new MemoryDataStore();
    const first = await transferToData(store);

    const replay = await transferToData(store);
    expect(replay).toEqual(first);
    expect((await store.getCatalogWriterOwnership())?.revision).toBe(1);
    expect(store.audits).toHaveLength(1);

    await expect(transferCatalogWriterOwnership(
      store,
      {
        commandId: 'cmd-transfer-catalog-writer',
        idempotencyKey: 'idem-transfer-catalog-writer',
        expectedRevision: 0,
        toWriterId: DATA_WRITER.id,
        actor: { id: 'user:owner', kind: 'USER' },
        writer: DATA_WRITER,
        reason: 'different transfer payload'
      },
      '2026-09-21T01:01:00.000Z'
    )).rejects.toBeInstanceOf(
      WriterOwnershipTransferIdempotencyConflictError
    );
  });

  it('rejects stale transfer revision and prevents the old writer from taking ownership', async () => {
    const store = new MemoryDataStore();
    await transferToData(store);

    await expect(transferCatalogWriterOwnership(
      store,
      {
        commandId: 'cmd-transfer-stale',
        idempotencyKey: 'idem-transfer-stale',
        expectedRevision: 0,
        toWriterId: DATA_WRITER.id,
        actor: { id: 'user:owner', kind: 'USER' },
        writer: DATA_WRITER,
        reason: 'stale transfer'
      }
    )).rejects.toBeInstanceOf(WriterOwnershipConflictError);

    const otherStore = new MemoryDataStore();
    await expect(transferCatalogWriterOwnership(
      otherStore,
      {
        commandId: 'cmd-transfer-by-old-writer',
        idempotencyKey: 'idem-transfer-by-old-writer',
        expectedRevision: 0,
        toWriterId: DATA_WRITER.id,
        actor: OLD_WRITER,
        writer: OLD_WRITER,
        reason: 'legacy writer tries to claim control'
      }
    )).rejects.toBeInstanceOf(WriterOwnershipTransferRejectedError);
  });

  it('blocks the previous writer across all canonical Catalog write paths after transfer', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await transferToData(store);

    await expect(updateOfferPrice(
      store,
      oldWriterPriceCommand(),
      '2026-09-21T01:10:00.000Z'
    )).rejects.toBeInstanceOf(WriterOwnershipDeniedError);

    await expect(createManualCatalogEntry(
      store,
      validManualEntry(),
      '2026-09-21T01:10:00.000Z'
    )).rejects.toBeInstanceOf(WriterOwnershipDeniedError);

    await expect(canonicalizeCatalogCandidate(
      store,
      {
        commandId: 'cmd-old-writer-canonicalize',
        idempotencyKey: 'idem-old-writer-canonicalize',
        candidateId: 'cand-does-not-matter',
        expectedHeadRunId: 'run-does-not-matter',
        decision: {
          vehicleModel: { action: 'CREATE', id: 'vm_blocked_writer' },
          supplierId: 'supplier:test'
        },
        actor: OLD_WRITER,
        writer: OLD_WRITER,
        reason: 'legacy canonical writer attempt'
      },
      '2026-09-21T01:10:00.000Z'
    )).rejects.toBeInstanceOf(WriterOwnershipDeniedError);

    await expect(applyReviewedSourceChange(
      store,
      {
        commandId: 'cmd-old-writer-source-change',
        idempotencyKey: 'idem-old-writer-source-change',
        bindingId: 'bind-does-not-matter',
        candidateId: 'cand-does-not-matter',
        expectedHeadRunId: 'run-does-not-matter',
        expectedBindingRevision: 1,
        expectedVehicleModelRevision: 1,
        expectedProductRevision: 1,
        expectedOfferRevision: 1,
        approvedChangeIds: [],
        actor: OLD_WRITER,
        writer: OLD_WRITER,
        reason: 'legacy source refresh attempt'
      },
      '2026-09-21T01:10:00.000Z'
    )).rejects.toBeInstanceOf(WriterOwnershipDeniedError);

    expect((await store.getOffer('offer_gv70_demo'))?.revision).toBe(1);
    expect(await store.getManualCatalogEntryReceipt(
      'idem-old-writer-manual'
    )).toBeNull();
    expect(await store.getCanonicalizationReceipt(
      'idem-old-writer-canonicalize'
    )).toBeNull();
    expect(await store.getReviewedSourceChangeReceipt(
      'idem-old-writer-source-change'
    )).toBeNull();
  });

  it('allows a human actor through the FreePass Data execution writer after transfer', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await transferToData(store);

    const receipt = await updateOfferPrice(
      store,
      {
        commandId: 'cmd-user-through-data',
        idempotencyKey: 'idem-user-through-data',
        offerId: 'offer_gv70_demo',
        expectedRevision: 1,
        termKey: '36@20000',
        monthlyRent: { amount: 725000, currency: 'KRW' },
        reason: 'operator edit through FreePass Data',
        actor: { id: 'user:operator', kind: 'USER' },
        writer: DATA_WRITER
      },
      '2026-09-21T01:20:00.000Z'
    );

    expect(receipt.writerId).toBe(DATA_WRITER.id);
    expect((await store.getOffer('offer_gv70_demo'))?.revision).toBe(2);
    expect(store.audits.at(-1)?.writerId).toBe(DATA_WRITER.id);
  });

  it('also blocks an old service that omits explicit writer metadata after transfer', async () => {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    await transferToData(store);

    const command = oldWriterPriceCommand();
    const { writer: _writer, ...withoutWriter } = command;

    await expect(updateOfferPrice(
      store,
      withoutWriter,
      '2026-09-21T01:30:00.000Z'
    )).rejects.toBeInstanceOf(WriterOwnershipDeniedError);
  });
});
