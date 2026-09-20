import { describe, expect, it } from 'vitest';
import { AuthorityDeniedError } from '../src/domain/authority.js';
import {
  InvalidManualCatalogEntryError,
  ManualCatalogEntryIdempotencyConflictError,
  createManualCatalogEntry
} from '../src/application/manual-catalog-entry.js';
import { canonicalizeCatalogCandidate } from '../src/application/canonicalize-catalog-candidate.js';
import { processOneOutboxEvent } from '../src/application/catalog.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';

function manualCommand(idempotencyKey = 'idem-manual-entry-0001') {
  return {
    commandId: 'cmd-manual-entry-0001',
    idempotencyKey,
    entry: {
      carNumber: '321가6543',
      maker: '제네시스',
      model: 'GV70',
      subModel: '2세대',
      trimName: '2.5T AWD',
      commercialType: 'USED_RENT' as const,
      supplierId: 'supplier:manual-reviewed',
      fuelType: '가솔린',
      mileageKm: 15000,
      driveType: 'AWD',
      seats: 5,
      priceTerms: [{
        termMonths: 36,
        monthlyRent: { amount: 770000, currency: 'KRW' as const },
        depositState: 'KNOWN' as const,
        deposit: { amount: 3000000, currency: 'KRW' as const },
        mileageLimitKmPerYear: 20000
      }]
    },
    actor: { id: 'user:manual-editor', kind: 'USER' as const },
    reason: '직접 등록 상품'
  };
}

describe('manual catalog entry', () => {
  it('stores manual input as immutable source evidence before canonicalization', async () => {
    const store = new MemoryDataStore();
    const receipt = await createManualCatalogEntry(
      store,
      manualCommand(),
      '2026-09-21T01:00:00Z'
    );

    expect(receipt.status).toBe('SOURCE_ACCEPTED');
    expect(receipt.sourceId).toContain('manual/catalog/manual_');
    expect(receipt.actor.id).toBe('user:manual-editor');
    expect(receipt.reason).toBe('직접 등록 상품');

    const source = await store.getSourceDefinition(receipt.sourceId);
    const run = await store.getSourceRun(receipt.runId);
    const head = await store.getSourceHead(receipt.sourceId);
    const raw = await store.getRawRecord('raw_manual_' + receipt.runId.replace('run_manual_', ''));
    const candidate = await store.getCandidate(receipt.candidateId);

    expect(source?.kind).toBe('MANUAL');
    expect(run?.status).toBe('COMPLETED');
    expect(run?.headStatus).toBe('CURRENT');
    expect(run?.coverage.mode).toBe('FULL');
    expect(run?.coverage.completeness).toBe('COMPLETE');
    expect(head?.runId).toBe(receipt.runId);
    expect(raw?.sourceFingerprint).toBe(receipt.sourceFingerprint);
    expect(candidate?.candidate.providerCompanyCode).toBe('supplier:manual-reviewed');
    expect(candidate?.candidate.priceTerms[0]?.termKey).toBe('manual:36:20000');

    const lineage = await store.listLineageByStage('RAW_TO_NORMALIZED');
    const manualLineage = lineage.filter(
      (item) => item.normalized?.candidateId === receipt.candidateId
    );
    expect(manualLineage.some((item) =>
      item.source.fieldPath === 'supplierId' &&
      item.normalized?.fieldPath === 'providerCompanyCode'
    )).toBe(true);
    expect(manualLineage.some((item) =>
      item.normalized?.fieldPath === 'priceTerms.manual:36:20000.monthlyRent.amount' &&
      item.normalized.value === 770000
    )).toBe(true);
  });

  it('replays the same idempotent manual command without duplicating source evidence', async () => {
    const store = new MemoryDataStore();
    const command = manualCommand('idem-manual-entry-replay');

    const first = await createManualCatalogEntry(
      store,
      command,
      '2026-09-21T01:00:00Z'
    );
    const second = await createManualCatalogEntry(
      store,
      command,
      '2026-09-21T01:00:01Z'
    );

    expect(second).toEqual(first);
    const lineage = (await store.listLineageByStage('RAW_TO_NORMALIZED'))
      .filter((item) => item.normalized?.candidateId === first.candidateId);
    expect(lineage).toHaveLength(16);
  });

  it('rejects idempotency key reuse with different manual input', async () => {
    const store = new MemoryDataStore();
    const command = manualCommand('idem-manual-entry-conflict');
    await createManualCatalogEntry(store, command, '2026-09-21T01:00:00Z');

    await expect(createManualCatalogEntry(
      store,
      {
        ...command,
        entry: {
          ...command.entry,
          priceTerms: [{
            ...command.entry.priceTerms[0]!,
            monthlyRent: { amount: 790000, currency: 'KRW' as const }
          }]
        }
      },
      '2026-09-21T01:00:02Z'
    )).rejects.toBeInstanceOf(ManualCatalogEntryIdempotencyConflictError);
  });

  it('rejects contradictory manual deposit data before writing any source evidence', async () => {
    const store = new MemoryDataStore();
    const command = manualCommand('idem-manual-entry-invalid');

    await expect(createManualCatalogEntry(
      store,
      {
        ...command,
        entry: {
          ...command.entry,
          priceTerms: [{
            ...command.entry.priceTerms[0]!,
            depositState: 'ZERO' as const
          }]
        }
      },
      '2026-09-21T01:00:00Z'
    )).rejects.toBeInstanceOf(InvalidManualCatalogEntryError);

    expect(
      await store.getManualCatalogEntryReceipt('idem-manual-entry-invalid')
    ).toBeNull();
  });

  it('rejects an unregistered service from creating a manual source', async () => {
    const store = new MemoryDataStore();
    const command = manualCommand('idem-manual-entry-authority');

    await expect(createManualCatalogEntry(
      store,
      {
        ...command,
        actor: { id: 'service:unknown', kind: 'SERVICE' as const }
      },
      '2026-09-21T01:00:00Z'
    )).rejects.toBeInstanceOf(AuthorityDeniedError);
  });

  it('flows from direct input through Canonical and an ACTIVE consumer release', async () => {
    const store = new MemoryDataStore();
    const manual = await createManualCatalogEntry(
      store,
      manualCommand('idem-manual-entry-e2e'),
      '2026-09-21T01:00:00Z'
    );

    const canonical = await canonicalizeCatalogCandidate(
      store,
      {
        commandId: 'cmd-canonicalize-manual-001',
        idempotencyKey: 'idem-canonicalize-manual-001',
        candidateId: manual.candidateId,
        expectedHeadRunId: manual.runId,
        decision: {
          vehicleModel: {
            action: 'CREATE',
            id: 'vm_manual_reviewed_gv70_001'
          },
          vehicleAsset: {
            action: 'CREATE',
            id: 'va_manual_reviewed_321ga6543',
            status: 'AVAILABLE'
          },
          supplierId: 'supplier:manual-reviewed'
        },
        actor: { id: 'user:manual-editor', kind: 'USER' },
        reason: '직접 등록 검수 완료'
      },
      '2026-09-21T01:01:00Z'
    );

    expect(canonical.status).toBe('CANONICAL_COMMITTED');
    expect(
      (await store.getOffer(canonical.offerId))?.priceTerms[0]?.monthlyRent.amount
    ).toBe(770000);

    expect(await processOneOutboxEvent(
      store,
      store,
      store,
      { workerId: 'worker:manual-entry-test' },
      new Date('2026-09-21T01:02:00Z')
    )).toBe('DONE');

    const active = await store.getActive('erp-public');
    expect(active?.data).toHaveLength(1);
    expect(active?.data[0]?.productId).toBe(canonical.productId);
    expect(active?.data[0]?.vehicle.plateNumber).toBe('321가6543');
    expect(active?.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount).toBe(770000);

    expect(
      await store.listEntityHistory('product', canonical.productId)
    ).toHaveLength(1);
    expect(
      await store.listEntityHistory('offer', canonical.offerId)
    ).toHaveLength(1);
  });
});
