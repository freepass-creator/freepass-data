import { describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import {
  CanonicalizationRejectedError,
  SourceChangedReviewRequiredError,
  canonicalizeCatalogCandidate
} from '../src/application/canonicalize-catalog-candidate.js';
import type {
  CanonicalizeCatalogCandidateInput
} from '../src/application/canonicalize-catalog-candidate.js';
import { processOneOutboxEvent } from '../src/application/catalog.js';
import type { FieldLineageRecord } from '../src/domain/lineage.js';
import type {
  NormalizedCandidateRecord,
  SourceHead,
  SourceRun
} from '../src/domain/source.js';

const SOURCE_ID = 'freepasserp3/firestore/products';

function evidence(input: {
  runId: string;
  candidateId: string;
  fingerprint: string;
  observedAt: string;
  rent?: number;
  issues?: string[];
}) {
  const rent = input.rent ?? 750000;
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
    lineageCount: 12,
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

  const candidate: NormalizedCandidateRecord = {
    candidateId: input.candidateId,
    runId: input.runId,
    sourceId: SOURCE_ID,
    sourceRecordId: 'legacy-product-001',
    sourceFingerprint: input.fingerprint,
    status: issues.length ? 'WARNING' : 'VALID',
    candidate: {
      sourceRecordId: 'legacy-product-001',
      sourceFingerprint: input.fingerprint,
      productCode: 'P001',
      carNumber: '123가4567',
      maker: '제네시스',
      model: 'GV70',
      subModel: '2세대',
      trimName: '2.5T AWD',
      commercialType: 'USED_RENT',
      providerCompanyCode: 'SUP-LEGACY',
      mileageKm: 12000,
      priceTerms: [{
        termKey: 'source:36_2만',
        termMonths: 36,
        monthlyRent: { amount: rent, currency: 'KRW' },
        deposit: { amount: 3000000, currency: 'KRW' },
        depositState: 'KNOWN',
        mileageLimitKmPerYear: 20000
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
    ['car_number', 'carNumber', '123가4567', '123가4567'],
    ['mileage', 'mileageKm', 12000, 12000],
    ['price.36_2만.rent', 'priceTerms.source:36_2만.monthlyRent.amount', rent, rent],
    ['price.36_2만.deposit', 'priceTerms.source:36_2만.depositState', 3000000, 'KNOWN'],
    ['price.36_2만.deposit', 'priceTerms.source:36_2만.deposit.amount', 3000000, 3000000],
    ['price.36_2만', 'priceTerms.source:36_2만.termMonths', 36, 36],
    ['price.36_2만', 'priceTerms.source:36_2만.mileageLimitKmPerYear', 20000, 20000]
  ];

  const lineage: FieldLineageRecord[] = lineageSpec.map(
    ([sourceFieldPath, normalizedFieldPath, sourceValue, normalizedValue], index) => ({
      lineageRecordId: `rawlin-${index}-${input.runId}`,
      lineageId: `lineage-${index}`,
      stage: 'RAW_TO_NORMALIZED',
      runId: input.runId,
      sourceId: SOURCE_ID,
      sourceRecordId: candidate.sourceRecordId,
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

function command(
  candidateId: string,
  headRunId: string,
  idempotencyKey: string
): CanonicalizeCatalogCandidateInput {
  return {
    commandId: `cmd-${idempotencyKey}`,
    idempotencyKey,
    candidateId,
    expectedHeadRunId: headRunId,
    decision: {
      vehicleModel: { action: 'CREATE' as const, id: 'vm_reviewed_gv70_001' },
      vehicleAsset: {
        action: 'CREATE' as const,
        id: 'va_reviewed_123ga4567',
        status: 'AVAILABLE' as const
      },
      supplierId: 'supplier:reviewed-legacy'
    },
    actor: { id: 'user:reviewer', kind: 'USER' as const },
    reason: 'reviewed legacy product canonicalization'
  };
}

describe('safe catalog canonicalization', () => {
  it('commits reviewed current-head candidate and publishes it through the outbox', async () => {
    const store = new MemoryDataStore();
    const fixture = evidence({
      runId: 'run-current',
      candidateId: 'candidate-current',
      fingerprint: 'fp-current',
      observedAt: '2026-09-21T00:00:00Z'
    });
    await store.seed!({
      sourceRuns: [fixture.run],
      sourceHeads: [fixture.head],
      candidates: [fixture.candidate],
      lineage: fixture.lineage
    });

    const receipt = await canonicalizeCatalogCandidate(
      store,
      command(fixture.candidate.candidateId, fixture.run.runId, 'idem-canonical-001'),
      '2026-09-21T00:01:00Z'
    );

    expect(receipt.status).toBe('CANONICAL_COMMITTED');
    expect((await store.getVehicleModel('vm_reviewed_gv70_001'))?.model).toBe('GV70');
    expect((await store.getVehicleAsset('va_reviewed_123ga4567'))?.plateNumber).toBe('123가4567');

    const binding = await store.getSourceBinding(receipt.bindingId);
    expect(binding?.sourceRunId).toBe('run-current');
    expect(binding?.sourceFingerprint).toBe('fp-current');

    const canonicalLineage = await store.listLineageByStage('NORMALIZED_TO_CANONICAL');
    expect(canonicalLineage.some((item) =>
      item.normalized?.fieldPath === 'commercialType' &&
      item.canonical?.entityType === 'product'
    )).toBe(true);
    expect(canonicalLineage.some((item) =>
      item.normalized?.fieldPath === 'priceTerms.source:36_2만.monthlyRent.amount' &&
      item.canonical?.entityType === 'offer' &&
      item.canonical.value === 750000
    )).toBe(true);

    expect(store.audits).toHaveLength(1);
    expect(store.outbox.size).toBe(1);

    expect(await processOneOutboxEvent(
      store,
      store,
      store,
      { workerId: 'worker:canonical-test' },
      new Date('2026-09-21T00:02:00Z')
    )).toBe('DONE');

    const active = await store.getActive('erp-public');
    expect(active?.data).toHaveLength(1);
    expect(active?.data[0]?.productId).toBe(receipt.productId);
    expect(active?.data[0]?.vehicle.subModel).toBe('2세대');
    expect(active?.data[0]?.offers[0]?.offerId).toBe(receipt.offerId);
    expect(active?.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount).toBe(750000);
  });

  it('does not duplicate canonical entities when the same source fingerprint is reviewed again', async () => {
    const store = new MemoryDataStore();
    const fixture = evidence({
      runId: 'run-current',
      candidateId: 'candidate-current',
      fingerprint: 'fp-current',
      observedAt: '2026-09-21T00:00:00Z'
    });
    await store.seed!({
      sourceRuns: [fixture.run],
      sourceHeads: [fixture.head],
      candidates: [fixture.candidate],
      lineage: fixture.lineage
    });

    const first = await canonicalizeCatalogCandidate(
      store,
      command(fixture.candidate.candidateId, fixture.run.runId, 'idem-canonical-002a'),
      '2026-09-21T00:01:00Z'
    );
    const second = await canonicalizeCatalogCandidate(
      store,
      command(fixture.candidate.candidateId, fixture.run.runId, 'idem-canonical-002b'),
      '2026-09-21T00:02:00Z'
    );

    expect(first.status).toBe('CANONICAL_COMMITTED');
    expect(second.status).toBe('NO_CHANGE');
    expect(second.bindingId).toBe(first.bindingId);
    expect(await store.listProducts()).toHaveLength(1);
    expect(await store.listOffers()).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
    expect(store.outbox.size).toBe(1);
  });

  it('rejects a candidate that is no longer from the accepted current source head', async () => {
    const store = new MemoryDataStore();
    const old = evidence({
      runId: 'run-old',
      candidateId: 'candidate-old',
      fingerprint: 'fp-old',
      observedAt: '2026-09-21T00:00:00Z'
    });
    const current = evidence({
      runId: 'run-new',
      candidateId: 'candidate-new',
      fingerprint: 'fp-new',
      observedAt: '2026-09-21T00:05:00Z'
    });
    old.run.headStatus = 'STALE';
    await store.seed!({
      sourceRuns: [old.run, current.run],
      sourceHeads: [current.head],
      candidates: [old.candidate, current.candidate],
      lineage: [...old.lineage, ...current.lineage]
    });

    await expect(canonicalizeCatalogCandidate(
      store,
      command(old.candidate.candidateId, old.run.runId, 'idem-canonical-003'),
      '2026-09-21T00:06:00Z'
    )).rejects.toBeInstanceOf(CanonicalizationRejectedError);

    expect(await store.listProducts()).toHaveLength(0);
    expect(store.outbox.size).toBe(0);
  });

  it('requires explicit re-review when the bound source record fingerprint changes', async () => {
    const store = new MemoryDataStore();
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

    await canonicalizeCatalogCandidate(
      store,
      command(original.candidate.candidateId, original.run.runId, 'idem-canonical-004a'),
      '2026-09-21T00:01:00Z'
    );

    const changed = evidence({
      runId: 'run-changed',
      candidateId: 'candidate-changed',
      fingerprint: 'fp-changed',
      observedAt: '2026-09-21T00:10:00Z',
      rent: 790000
    });
    original.run.headStatus = 'STALE';
    await store.seed!({
      sourceRuns: [original.run, changed.run],
      sourceHeads: [changed.head],
      candidates: [changed.candidate],
      lineage: changed.lineage
    });

    await expect(canonicalizeCatalogCandidate(
      store,
      command(changed.candidate.candidateId, changed.run.runId, 'idem-canonical-004b'),
      '2026-09-21T00:11:00Z'
    )).rejects.toBeInstanceOf(SourceChangedReviewRequiredError);

    expect((await store.listOffers())[0]?.priceTerms[0]?.monthlyRent.amount).toBe(750000);
    expect(store.audits).toHaveLength(1);
    expect(store.outbox.size).toBe(1);
  });

  it('rejects canonicalization when a critical field has no normalized lineage evidence', async () => {
    const store = new MemoryDataStore();
    const fixture = evidence({
      runId: 'run-missing-lineage',
      candidateId: 'candidate-missing-lineage',
      fingerprint: 'fp-missing-lineage',
      observedAt: '2026-09-21T00:00:00Z'
    });
    fixture.lineage = fixture.lineage.filter(
      (item) => item.normalized?.fieldPath !== 'priceTerms.source:36_2만.depositState'
    );
    await store.seed!({
      sourceRuns: [fixture.run],
      sourceHeads: [fixture.head],
      candidates: [fixture.candidate],
      lineage: fixture.lineage
    });

    await expect(canonicalizeCatalogCandidate(
      store,
      command(
        fixture.candidate.candidateId,
        fixture.run.runId,
        'idem-canonical-missing-lineage'
      ),
      '2026-09-21T00:01:00Z'
    )).rejects.toThrow('Missing normalized lineage');

    expect(await store.listProducts()).toHaveLength(0);
    expect(store.outbox.size).toBe(0);
  });

  it('rejects contradictory deposit state before Canonical commit', async () => {
    const store = new MemoryDataStore();
    const fixture = evidence({
      runId: 'run-bad-deposit',
      candidateId: 'candidate-bad-deposit',
      fingerprint: 'fp-bad-deposit',
      observedAt: '2026-09-21T00:00:00Z'
    });
    fixture.candidate.candidate.priceTerms[0]!.depositState = 'ZERO';
    await store.seed!({
      sourceRuns: [fixture.run],
      sourceHeads: [fixture.head],
      candidates: [fixture.candidate],
      lineage: fixture.lineage
    });

    await expect(canonicalizeCatalogCandidate(
      store,
      command(
        fixture.candidate.candidateId,
        fixture.run.runId,
        'idem-canonical-bad-deposit'
      ),
      '2026-09-21T00:01:00Z'
    )).rejects.toThrow('ZERO deposit must contain KRW 0');

    expect(await store.listProducts()).toHaveLength(0);
    expect(store.outbox.size).toBe(0);
  });

  it('requires exact approval of warning issues before canonicalization', async () => {
    const store = new MemoryDataStore();
    const fixture = evidence({
      runId: 'run-warning',
      candidateId: 'candidate-warning',
      fingerprint: 'fp-warning',
      observedAt: '2026-09-21T00:00:00Z',
      issues: ['UNKNOWN_PRODUCT_NOTE:manual-check']
    });
    await store.seed!({
      sourceRuns: [fixture.run],
      sourceHeads: [fixture.head],
      candidates: [fixture.candidate],
      lineage: fixture.lineage
    });

    await expect(canonicalizeCatalogCandidate(
      store,
      command(fixture.candidate.candidateId, fixture.run.runId, 'idem-canonical-005'),
      '2026-09-21T00:01:00Z'
    )).rejects.toBeInstanceOf(CanonicalizationRejectedError);

    const approved = command(
      fixture.candidate.candidateId,
      fixture.run.runId,
      'idem-canonical-006'
    );
    approved.decision.approvedIssues = ['UNKNOWN_PRODUCT_NOTE:manual-check'];

    const receipt = await canonicalizeCatalogCandidate(
      store,
      approved,
      '2026-09-21T00:02:00Z'
    );
    expect(receipt.status).toBe('CANONICAL_COMMITTED');
    expect((await store.getProduct(receipt.productId))?.validationStatus).toBe('WARNING');
  });

  it('preserves legacy policy_code as Offer.policyId with lineage evidence', async () => {
    const store = new MemoryDataStore();
    const fixture = evidence({
      runId: 'run-policy-binding',
      candidateId: 'candidate-policy-binding',
      fingerprint: 'fp-policy-binding',
      observedAt: '2026-09-21T00:00:00Z'
    });
    fixture.candidate.candidate.policyCode = 'policy-basic-21';
    fixture.lineage.push({
      lineageRecordId: 'rawlin-policy-binding',
      lineageId: 'lineage-policy-binding',
      stage: 'RAW_TO_NORMALIZED',
      runId: fixture.run.runId,
      sourceId: SOURCE_ID,
      sourceRecordId: fixture.candidate.sourceRecordId,
      sourceFingerprint: fixture.candidate.sourceFingerprint,
      observedAt: fixture.run.observedAt!,
      source: { fieldPath: 'policy_code', value: 'policy-basic-21' },
      normalized: {
        candidateId: fixture.candidate.candidateId,
        fieldPath: 'policyCode',
        value: 'policy-basic-21'
      },
      transformId: 'legacy-freepasserp3-product-normalizer',
      transformVersion: '1.0.0'
    });
    fixture.run.lineageCount = fixture.lineage.length;

    await store.seed!({
      sourceRuns: [fixture.run],
      sourceHeads: [fixture.head],
      candidates: [fixture.candidate],
      lineage: fixture.lineage
    });

    const receipt = await canonicalizeCatalogCandidate(
      store,
      command(
        fixture.candidate.candidateId,
        fixture.run.runId,
        'idem-canonical-policy-binding'
      ),
      '2026-09-21T00:01:00Z'
    );

    const offer = await store.getOffer(receipt.offerId);
    expect(offer?.policyId).toBe('policy-basic-21');

    const canonicalLineage = await store.listLineageByStage('NORMALIZED_TO_CANONICAL');
    expect(canonicalLineage.some((item) =>
      item.normalized?.fieldPath === 'policyCode'
      && item.canonical?.entityType === 'offer'
      && item.canonical?.fieldPath === 'policyId'
      && item.canonical?.value === 'policy-basic-21'
    )).toBe(true);
  });

});
