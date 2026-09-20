import { describe, expect, it } from 'vitest';
import {
  applyReviewedSourceChange,
  reviewSourceChange,
  ReviewedSourceChangeApprovalMismatchError,
  ReviewedSourceChangeBlockedError,
  ReviewedSourceChangeConflictError,
  ReviewedSourceChangeIdempotencyConflictError
} from '../src/application/reviewed-source-change.js';
import { canonicalizeCatalogCandidate } from '../src/application/canonicalize-catalog-candidate.js';
import { processOneOutboxEvent, updateOfferPrice } from '../src/application/catalog.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import type { FieldLineageRecord } from '../src/domain/lineage.js';
import type {
  NormalizedCandidateRecord,
  SourceHead,
  SourceRun
} from '../src/domain/source.js';

const SOURCE_ID = 'freepasserp3/firestore/products';
const SOURCE_RECORD_ID = 'legacy-product-001';

function evidence(input: {
  runId: string;
  candidateId: string;
  fingerprint: string;
  observedAt: string;
  rent?: number;
  mileageKm?: number;
  depositAmount?: number;
  depositState?: 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
  mileageLimitKmPerYear?: number | null;
  supplierCode?: string;
  termMonths?: number;
  issues?: string[];
}) {
  const rent = input.rent ?? 750000;
  const mileageKm = input.mileageKm ?? 12000;
  const depositState = input.depositState ?? 'KNOWN';
  const depositAmount = input.depositAmount ?? 3000000;
  const mileageLimit = input.mileageLimitKmPerYear === undefined
    ? 20000
    : input.mileageLimitKmPerYear;
  const termMonths = input.termMonths ?? 36;
  const supplierCode = input.supplierCode ?? 'SUP-LEGACY';
  const issues = input.issues ?? [];

  const run: SourceRun = {
    runId: input.runId,
    sourceId: SOURCE_ID,
    status: 'COMPLETED',
    startedAt: input.observedAt,
    completedAt: input.observedAt,
    observedAt: input.observedAt,
    checkpoint: {
      sourceId: SOURCE_ID,
      checksum: `checksum-${input.fingerprint}`,
      observedAt: input.observedAt
    },
    coverage: {
      mode: 'FULL',
      completeness: 'COMPLETE',
      scope: 'firestore:products'
    },
    headStatus: 'CURRENT',
    rawCount: 1,
    candidateCount: 1,
    lineageCount: 13,
    warningCount: issues.length ? 1 : 0
  };

  const head: SourceHead = {
    sourceId: SOURCE_ID,
    runId: input.runId,
    observedAt: input.observedAt,
    acceptedAt: input.observedAt,
    checkpoint: run.checkpoint!,
    coverage: run.coverage
  };

  const termKey = 'source:36_2만';
  const deposit = depositState === 'KNOWN'
    ? { amount: depositAmount, currency: 'KRW' as const }
    : depositState === 'ZERO'
      ? { amount: 0, currency: 'KRW' as const }
      : undefined;

  const candidate: NormalizedCandidateRecord = {
    candidateId: input.candidateId,
    runId: input.runId,
    sourceId: SOURCE_ID,
    sourceRecordId: SOURCE_RECORD_ID,
    sourceFingerprint: input.fingerprint,
    status: issues.length ? 'WARNING' : 'VALID',
    candidate: {
      sourceRecordId: SOURCE_RECORD_ID,
      sourceFingerprint: input.fingerprint,
      productCode: 'P001',
      carNumber: '123가4567',
      maker: '제네시스',
      model: 'GV70',
      subModel: '2세대',
      trimName: '2.5T AWD',
      commercialType: 'USED_RENT',
      providerCompanyCode: supplierCode,
      mileageKm,
      priceTerms: [{
        termKey,
        termMonths,
        monthlyRent: { amount: rent, currency: 'KRW' },
        ...(deposit ? { deposit } : {}),
        depositState,
        ...(mileageLimit !== null
          ? { mileageLimitKmPerYear: mileageLimit }
          : {})
      }],
      issues
    }
  };

  const lineageSpec: Array<[string, string, unknown, unknown]> = [
    ['maker', 'maker', '제네시스', '제네시스'],
    ['model', 'model', 'GV70', 'GV70'],
    ['sub_model', 'subModel', '2세대', '2세대'],
    ['trim_name', 'trimName', '2.5T AWD', '2.5T AWD'],
    ['product_type', 'commercialType', '중고렌트', 'USED_RENT'],
    ['provider_company_code', 'providerCompanyCode', supplierCode, supplierCode],
    ['car_number', 'carNumber', '123가4567', '123가4567'],
    ['mileage', 'mileageKm', mileageKm, mileageKm],
    ['price.36_2만.rent', `priceTerms.${termKey}.monthlyRent.amount`, rent, rent],
    ['price.36_2만.deposit', `priceTerms.${termKey}.depositState`, depositAmount, depositState],
    ['price.36_2만', `priceTerms.${termKey}.termMonths`, termMonths, termMonths]
  ];
  if (deposit) {
    lineageSpec.push([
      'price.36_2만.deposit',
      `priceTerms.${termKey}.deposit.amount`,
      deposit.amount,
      deposit.amount
    ]);
  }
  if (mileageLimit !== null) {
    lineageSpec.push([
      'price.36_2만',
      `priceTerms.${termKey}.mileageLimitKmPerYear`,
      mileageLimit,
      mileageLimit
    ]);
  }
  run.lineageCount = lineageSpec.length;

  const lineage: FieldLineageRecord[] = lineageSpec.map(
    ([sourceFieldPath, normalizedFieldPath, sourceValue, normalizedValue], index) => ({
      lineageRecordId: `rawlin-${input.runId}-${index}`,
      lineageId: `lin-${input.runId}-${index}`,
      stage: 'RAW_TO_NORMALIZED',
      runId: input.runId,
      sourceId: SOURCE_ID,
      sourceRecordId: SOURCE_RECORD_ID,
      sourceFingerprint: input.fingerprint,
      observedAt: input.observedAt,
      source: { fieldPath: sourceFieldPath, value: sourceValue },
      normalized: {
        candidateId: input.candidateId,
        fieldPath: normalizedFieldPath,
        value: normalizedValue
      },
      transformId: 'legacy-freepasserp3-product-normalizer',
      transformVersion: '1.0.0'
    })
  );

  return { run, head, candidate, lineage };
}

async function initialCanonical(store: MemoryDataStore) {
  const original = evidence({
    runId: 'run-original',
    candidateId: 'candidate-original',
    fingerprint: 'fp-original',
    observedAt: '2026-09-21T00:00:00Z'
  });
  await store.seed!({
    sourceRuns: [original.run],
    sourceHeads: [original.head],
    candidates: [original.candidate],
    lineage: original.lineage
  });

  const receipt = await canonicalizeCatalogCandidate(
    store,
    {
      commandId: 'cmd-initial-canonical',
      idempotencyKey: 'idem-initial-canonical',
      candidateId: original.candidate.candidateId,
      expectedHeadRunId: original.run.runId,
      decision: {
        vehicleModel: { action: 'CREATE', id: 'vm_source_change_gv70' },
        vehicleAsset: {
          action: 'CREATE',
          id: 'va_source_change_gv70',
          status: 'AVAILABLE'
        },
        supplierId: 'supplier:reviewed-legacy'
      },
      actor: { id: 'user:reviewer', kind: 'USER' },
      reason: 'initial source review'
    },
    '2026-09-21T00:01:00Z'
  );

  return { original, receipt };
}

async function installChangedHead(
  store: MemoryDataStore,
  original: ReturnType<typeof evidence>,
  changed: ReturnType<typeof evidence>
) {
  original.run.headStatus = 'STALE';
  await store.seed!({
    sourceRuns: [original.run, changed.run],
    sourceHeads: [changed.head],
    candidates: [changed.candidate],
    lineage: changed.lineage
  });
}

function applyCommand(
  review: Awaited<ReturnType<typeof reviewSourceChange>>,
  idempotencyKey: string,
  approvedChangeIds = review.reviewableChangeIds
) {
  return {
    commandId: `cmd-${idempotencyKey}`,
    idempotencyKey,
    bindingId: review.bindingId,
    candidateId: review.candidateId,
    expectedHeadRunId: review.sourceRunId,
    expectedBindingRevision: review.bindingRevision,
    expectedVehicleModelRevision: review.vehicleModelRevision,
    expectedProductRevision: review.productRevision,
    expectedOfferRevision: review.offerRevision,
    ...(review.vehicleAssetRevision !== undefined
      ? { expectedVehicleAssetRevision: review.vehicleAssetRevision }
      : {}),
    approvedChangeIds,
    approvedIssues: review.candidateIssues,
    actor: { id: 'user:reviewer', kind: 'USER' as const },
    reason: 'reviewed source refresh'
  };
}

describe('reviewed source change', () => {
  it('applies approved rent and odometer changes, advances binding, and republishes', async () => {
    const store = new MemoryDataStore();
    const { original, receipt: initial } = await initialCanonical(store);

    const changed = evidence({
      runId: 'run-changed',
      candidateId: 'candidate-changed',
      fingerprint: 'fp-changed',
      observedAt: '2026-09-21T00:10:00Z',
      rent: 790000,
      mileageKm: 18000
    });
    await installChangedHead(store, original, changed);

    const review = await reviewSourceChange(
      store,
      initial.bindingId,
      changed.candidate.candidateId
    );

    expect(review.blockedChangeIds).toHaveLength(0);
    expect(review.reviewableChangeIds).toHaveLength(2);
    expect(review.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        classification: 'REVIEWABLE',
        entityType: 'offer',
        fieldPath: 'priceTerms.source:36_2만.monthlyRent'
      }),
      expect.objectContaining({
        classification: 'REVIEWABLE',
        entityType: 'vehicle_asset',
        fieldPath: 'odometerKm'
      })
    ]));

    const result = await applyReviewedSourceChange(
      store,
      applyCommand(review, 'idem-source-change-001'),
      '2026-09-21T00:11:00Z'
    );

    expect(result.status).toBe('CANONICAL_COMMITTED');
    expect(result.bindingRevision).toBe(2);
    expect(result.offerRevision).toBe(2);
    expect(result.vehicleAssetRevision).toBe(2);

    const binding = await store.getSourceBinding(initial.bindingId);
    expect(binding?.sourceFingerprint).toBe('fp-changed');
    expect(binding?.sourceRunId).toBe('run-changed');
    expect(binding?.sourceSupplierCode).toBe('SUP-LEGACY');

    expect((await store.getOffer(initial.offerId))?.priceTerms[0]?.monthlyRent.amount)
      .toBe(790000);
    expect((await store.getVehicleAsset('va_source_change_gv70'))?.odometerKm)
      .toBe(18000);

    const offerHistory = await store.listEntityHistory('offer', initial.offerId);
    const assetHistory = await store.listEntityHistory(
      'vehicle_asset',
      'va_source_change_gv70'
    );
    expect(offerHistory.map((item) => item.revision)).toEqual([1, 2]);
    expect(assetHistory.map((item) => item.revision)).toEqual([1, 2]);
    expect(offerHistory[1]?.origin).toBe('SOURCE_REFRESH');
    expect(assetHistory[1]?.origin).toBe('SOURCE_REFRESH');

    const canonicalLineage = await store.listLineageByStage('NORMALIZED_TO_CANONICAL');
    expect(canonicalLineage.some((item) =>
      item.sourceFingerprint === 'fp-changed' &&
      item.canonical?.entityType === 'offer' &&
      item.canonical.revision === 2 &&
      item.canonical.fieldPath === 'priceTerms.source:36_2만.monthlyRent.amount' &&
      item.canonical.value === 790000
    )).toBe(true);
    expect(canonicalLineage.some((item) =>
      item.sourceFingerprint === 'fp-changed' &&
      item.canonical?.entityType === 'vehicle_asset' &&
      item.canonical.revision === 2 &&
      item.canonical.fieldPath === 'odometerKm' &&
      item.canonical.value === 18000
    )).toBe(true);

    expect(await processOneOutboxEvent(
      store,
      store,
      store,
      { workerId: 'worker:source-change' },
      new Date('2026-09-21T00:12:00Z')
    )).toBe('DONE');

    const active = await store.getActive('erp-public');
    expect(active?.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount).toBe(790000);
    expect(active?.data[0]?.vehicle.odometerKm).toBe(18000);

    const manifest = await store.getManifest(active!.releaseId);
    expect(manifest?.canonicalInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entityType: 'offer',
        entityId: initial.offerId,
        revision: 2
      }),
      expect.objectContaining({
        entityType: 'vehicle_asset',
        entityId: 'va_source_change_gv70',
        revision: 2
      })
    ]));

    const projectedPrice = (await store.listProjectionLineage(active!.releaseId))
      .find((item) =>
        item.canonical.entityType === 'offer' &&
        item.canonical.entityId === initial.offerId &&
        item.canonical.revision === 2 &&
        item.canonical.fieldPath === 'priceTerms.source:36_2만.monthlyRent.amount'
      );
    expect(projectedPrice?.evidenceOrigin).toBe('SOURCE_LINEAGE');
    expect(projectedPrice?.parentLineageRecordId).toBeTruthy();
  });

  it('replays the same reviewed command and rejects idempotency-key payload reuse', async () => {
    const store = new MemoryDataStore();
    const { original, receipt: initial } = await initialCanonical(store);

    const changed = evidence({
      runId: 'run-idempotent',
      candidateId: 'candidate-idempotent',
      fingerprint: 'fp-idempotent',
      observedAt: '2026-09-21T00:10:00Z',
      rent: 790000
    });
    await installChangedHead(store, original, changed);

    const review = await reviewSourceChange(
      store,
      initial.bindingId,
      changed.candidate.candidateId
    );
    const command = applyCommand(review, 'idem-source-change-replay');

    const first = await applyReviewedSourceChange(
      store,
      command,
      '2026-09-21T00:11:00Z'
    );
    const replay = await applyReviewedSourceChange(
      store,
      command,
      '2026-09-21T00:12:00Z'
    );

    expect(replay).toEqual(first);
    expect((await store.getOffer(initial.offerId))?.revision).toBe(2);
    expect((await store.getSourceBinding(initial.bindingId))?.revision).toBe(2);

    await expect(applyReviewedSourceChange(
      store,
      {
        ...command,
        reason: 'different reviewed reason'
      },
      '2026-09-21T00:13:00Z'
    )).rejects.toBeInstanceOf(ReviewedSourceChangeIdempotencyConflictError);
  });

  it('blocks supplier mapping or term-structure changes instead of partially applying them', async () => {
    const store = new MemoryDataStore();
    const { original, receipt: initial } = await initialCanonical(store);

    const changed = evidence({
      runId: 'run-structural',
      candidateId: 'candidate-structural',
      fingerprint: 'fp-structural',
      observedAt: '2026-09-21T00:10:00Z',
      rent: 790000,
      supplierCode: 'SUP-NEW',
      termMonths: 48
    });
    await installChangedHead(store, original, changed);

    const review = await reviewSourceChange(
      store,
      initial.bindingId,
      changed.candidate.candidateId
    );

    expect(review.blockedChangeIds.length).toBeGreaterThan(0);
    expect(review.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        classification: 'BLOCKED',
        fieldPath: 'sourceSupplierCode'
      }),
      expect.objectContaining({
        classification: 'BLOCKED',
        fieldPath: 'priceTerms.source:36_2만.termMonths'
      })
    ]));

    await expect(applyReviewedSourceChange(
      store,
      applyCommand(review, 'idem-source-change-blocked'),
      '2026-09-21T00:11:00Z'
    )).rejects.toBeInstanceOf(ReviewedSourceChangeBlockedError);

    expect((await store.getOffer(initial.offerId))?.revision).toBe(1);
    expect((await store.getSourceBinding(initial.bindingId))?.revision).toBe(1);
  });

  it('requires the full current reviewable diff set, not a partial approval', async () => {
    const store = new MemoryDataStore();
    const { original, receipt: initial } = await initialCanonical(store);

    const changed = evidence({
      runId: 'run-partial-approval',
      candidateId: 'candidate-partial-approval',
      fingerprint: 'fp-partial-approval',
      observedAt: '2026-09-21T00:10:00Z',
      rent: 790000,
      mileageKm: 18000
    });
    await installChangedHead(store, original, changed);

    const review = await reviewSourceChange(
      store,
      initial.bindingId,
      changed.candidate.candidateId
    );

    await expect(applyReviewedSourceChange(
      store,
      applyCommand(
        review,
        'idem-source-change-partial',
        review.reviewableChangeIds.slice(0, 1)
      ),
      '2026-09-21T00:11:00Z'
    )).rejects.toBeInstanceOf(ReviewedSourceChangeApprovalMismatchError);

    expect((await store.getSourceBinding(initial.bindingId))?.revision).toBe(1);
    expect((await store.getOffer(initial.offerId))?.revision).toBe(1);
  });

  it('rejects a stale review if Canonical changed after the preview', async () => {
    const store = new MemoryDataStore();
    const { original, receipt: initial } = await initialCanonical(store);

    const changed = evidence({
      runId: 'run-stale-review',
      candidateId: 'candidate-stale-review',
      fingerprint: 'fp-stale-review',
      observedAt: '2026-09-21T00:10:00Z',
      rent: 790000
    });
    await installChangedHead(store, original, changed);

    const review = await reviewSourceChange(
      store,
      initial.bindingId,
      changed.candidate.candidateId
    );

    await updateOfferPrice(
      store,
      {
        commandId: 'cmd-intervening-price',
        idempotencyKey: 'idem-intervening-price',
        offerId: initial.offerId,
        expectedRevision: review.offerRevision,
        termKey: 'source:36_2만',
        monthlyRent: { amount: 780000, currency: 'KRW' },
        reason: 'intervening operator edit',
        actor: { id: 'user:operator', kind: 'USER' }
      },
      '2026-09-21T00:10:30Z'
    );

    await expect(applyReviewedSourceChange(
      store,
      applyCommand(review, 'idem-source-change-stale'),
      '2026-09-21T00:11:00Z'
    )).rejects.toBeInstanceOf(ReviewedSourceChangeConflictError);

    expect((await store.getOffer(initial.offerId))?.revision).toBe(2);
    expect((await store.getOffer(initial.offerId))?.priceTerms[0]?.monthlyRent.amount)
      .toBe(780000);
    expect((await store.getSourceBinding(initial.bindingId))?.revision).toBe(1);
  });

  it('advances source evidence without a Canonical revision when normalized values are unchanged', async () => {
    const store = new MemoryDataStore();
    const { original, receipt: initial } = await initialCanonical(store);

    const changed = evidence({
      runId: 'run-same-values',
      candidateId: 'candidate-same-values',
      fingerprint: 'fp-new-raw-same-normalized',
      observedAt: '2026-09-21T00:10:00Z'
    });
    await installChangedHead(store, original, changed);

    const review = await reviewSourceChange(
      store,
      initial.bindingId,
      changed.candidate.candidateId
    );
    expect(review.diffs).toHaveLength(0);

    const result = await applyReviewedSourceChange(
      store,
      applyCommand(review, 'idem-source-change-noop'),
      '2026-09-21T00:11:00Z'
    );

    expect(result.status).toBe('NO_CHANGE');
    expect(result.bindingRevision).toBe(2);
    expect(result.offerRevision).toBe(1);
    expect(result.vehicleAssetRevision).toBe(1);
    expect((await store.getSourceBinding(initial.bindingId))?.sourceFingerprint)
      .toBe('fp-new-raw-same-normalized');
    expect(await store.listEntityHistory('offer', initial.offerId)).toHaveLength(1);
    expect(await store.listEntityHistory(
      'vehicle_asset',
      'va_source_change_gv70'
    )).toHaveLength(1);
    expect(store.outbox.size).toBe(1); // initial canonicalization only
  });
});
