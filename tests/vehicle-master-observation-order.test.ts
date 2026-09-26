import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  promoteVehicleMasterCompatibilityRule,
  promoteVehicleMasterNode,
  promoteVehicleMasterPriceRevision,
  type VehicleMasterFieldObservation,
} from '../src/application/vehicle-master-ingestion.js';
import {
  sealVehicleMasterCompatibilityRule,
  sealVehicleMasterNode,
  sealVehicleMasterPipelineRecord,
  sealVehicleMasterPriceRevision,
  sealVehicleMasterSourceDocument,
} from '../src/domain/vehicle-master.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';

// Synthetic evidence only; no source fetching or Firebase access.
const observedAt = '2026-09-25T00:00:00.000Z';
const sourceDocumentId = 'source_order_regression';
const meta = {
  revision: 1,
  createdAt: observedAt,
  updatedAt: observedAt,
  sourceEvidenceIds: [sourceDocumentId],
};
const makeNode = (id: string) => sealVehicleMasterNode({
  ...meta, id, nodeType: 'MAKE', status: 'ACTIVE', canonicalName: id,
  refs: {}, aliases: [], attributes: { synthetic: true },
});

type Kind = 'node' | 'price' | 'rule';

async function fixture(kind: Kind) {
  const store = new MemoryVehicleMasterStore();
  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId, sourceType: 'MANUFACTURER_OFFICIAL',
    sourceName: 'Synthetic order regression', sourceUrl: null,
    publishedAt: null, observedAt, storagePath: 'synthetic/order-regression',
    sha256: 'a'.repeat(64), mimeType: 'text/plain', metadata: { synthetic: true },
  }));
  const observe = (fieldPath: string, value: unknown): VehicleMasterFieldObservation => ({
    fieldPath, value, sourceDocumentId,
  });
  const policy = (requiredFieldPaths: string[]) => ({
    requiredFieldPaths, minCorroboratingSourcesWithoutOfficial: 2,
  });

  if (kind === 'node') {
    const proposal = makeNode('make_order_subject');
    return {
      store,
      observations: [observe('canonicalName', proposal.canonicalName), observe('attributes.synthetic', true)],
      contradiction: observe('attributes.synthetic', false),
      run: (observations: VehicleMasterFieldObservation[]) => promoteVehicleMasterNode(store, {
        proposal, observations, observedAt,
        policy: policy(['canonicalName', 'attributes.synthetic']),
      }),
      readCanonical: () => store.getNode(proposal.id),
    };
  }

  await store.putNode(makeNode('make_order_subject'));
  if (kind === 'price') {
    const proposal = sealVehicleMasterPriceRevision({
      ...meta, id: 'price_order_regression', targetId: 'make_order_subject',
      // This fixture tests observation ordering only. BASE target semantics are
      // covered separately by vehicle-master-price-semantics.test.ts.
      priceType: 'ADJUSTMENT', amount: 100, currency: 'KRW',
      sourceDocumentIds: [sourceDocumentId],
    });
    return {
      store,
      observations: [observe('currency', 'KRW'), observe('amount', 100)],
      contradiction: observe('amount', 101),
      run: (observations: VehicleMasterFieldObservation[]) => promoteVehicleMasterPriceRevision(store, {
        proposal, observations, observedAt, policy: policy(['currency', 'amount']),
      }),
      readCanonical: () => store.getPriceRevision(proposal.id),
    };
  }

  const make = await store.getNode('make_order_subject');
  assert.ok(make);
  const model = sealVehicleMasterNode({
    ...meta,
    id: 'model_order',
    nodeType: 'MODEL',
    status: 'ACTIVE',
    canonicalName: 'model_order',
    parentId: make.id,
    refs: { makeId: make.id },
    aliases: [],
    attributes: { synthetic: true },
  });
  const generation = sealVehicleMasterNode({
    ...meta,
    id: 'gen_order',
    nodeType: 'GENERATION',
    status: 'ACTIVE',
    canonicalName: 'gen_order',
    parentId: model.id,
    refs: { makeId: make.id, modelId: model.id },
    aliases: [],
    attributes: { synthetic: true },
  });
  const phase = sealVehicleMasterNode({
    ...meta,
    id: 'phase_order',
    nodeType: 'PHASE',
    status: 'ACTIVE',
    canonicalName: 'phase_order',
    parentId: generation.id,
    refs: {
      makeId: make.id,
      modelId: model.id,
      generationId: generation.id,
    },
    aliases: [],
    attributes: { synthetic: true },
  });
  const modelYear = sealVehicleMasterNode({
    ...meta,
    id: 'my_order',
    nodeType: 'MODEL_YEAR',
    status: 'ACTIVE',
    canonicalName: '2026년형',
    parentId: phase.id,
    refs: {
      makeId: make.id,
      modelId: model.id,
      generationId: generation.id,
      phaseId: phase.id,
    },
    aliases: ['2026MY'],
    attributes: { modelYear: 2026 },
  });
  const powertrain = sealVehicleMasterNode({
    ...meta,
    id: 'pt_order',
    nodeType: 'POWERTRAIN',
    status: 'ACTIVE',
    canonicalName: 'synthetic powertrain',
    parentId: modelYear.id,
    refs: {
      ...modelYear.refs,
      modelYearId: modelYear.id,
    },
    aliases: [],
    attributes: { identityKey: 'synthetic|powertrain', fuelType: null },
  });
  const variant = sealVehicleMasterNode({
    ...meta,
    id: 'variant_order',
    nodeType: 'VARIANT',
    status: 'ACTIVE',
    canonicalName: '5인승 2WD',
    parentId: powertrain.id,
    refs: {
      ...powertrain.refs,
      powertrainId: powertrain.id,
    },
    aliases: [],
    attributes: { seats: 5, drivetrain: '2WD' },
  });
  const trim = sealVehicleMasterNode({
    ...meta,
    id: 'trim_order',
    nodeType: 'TRIM',
    status: 'ACTIVE',
    canonicalName: 'trim_order',
    parentId: variant.id,
    refs: {
      ...variant.refs,
      variantId: variant.id,
    },
    aliases: [],
    attributes: { identityKey: 'trim_order' },
  });
  const optionRefs = {
    makeId: make.id,
    modelId: model.id,
    generationId: generation.id,
    phaseId: phase.id,
    modelYearId: modelYear.id,
  };
  const subject = sealVehicleMasterNode({
    ...meta,
    id: 'option_order_subject',
    nodeType: 'OPTION',
    status: 'ACTIVE',
    canonicalName: 'option_order_subject',
    parentId: modelYear.id,
    refs: optionRefs,
    aliases: [],
    attributes: { synthetic: true },
  });
  const target = sealVehicleMasterNode({
    ...meta,
    id: 'option_order_target',
    nodeType: 'OPTION',
    status: 'ACTIVE',
    canonicalName: 'option_order_target',
    parentId: modelYear.id,
    refs: optionRefs,
    aliases: [],
    attributes: { synthetic: true },
  });
  for (const node of [model, generation, phase, modelYear, powertrain, variant, trim, subject, target]) {
    await store.putNode(node);
  }

  const proposal = sealVehicleMasterCompatibilityRule({
    ...meta, id: 'rule_order_regression', subjectId: subject.id,
    ruleType: 'REQUIRES', targetIds: [target.id],
    scope: { trimId: trim.id }, condition: null, effect: 'VALID', priority: 1,
  });
  return {
    store,
    observations: [observe('targetIds', proposal.targetIds), observe('ruleType', 'REQUIRES')],
    contradiction: observe('ruleType', 'EXCLUDES'),
    run: (observations: VehicleMasterFieldObservation[]) => promoteVehicleMasterCompatibilityRule(store, {
      proposal, observations, observedAt, policy: policy(['targetIds', 'ruleType']),
    }),
    readCanonical: () => store.getCompatibilityRule(proposal.id),
  };
}

for (const kind of ['node', 'price', 'rule'] as const) {
  test(`${kind}: reordered evidence reuses IDs and preserves first outcome`, async () => {
    const f = await fixture(kind);
    const original = structuredClone(f.observations);
    const first = await f.run(f.observations);
    assert.equal(first.canonicalWrite, 'CREATED');
    assert.equal(first.decision.status, 'APPROVED');
    const evidenceBefore = await f.store.getPipelineRecord('CANDIDATE_FACT', first.candidateFactId);
    const outcomeBefore = await f.store.getPipelineRecord('PROMOTION_RESULT', first.promotionResultId);
    const eventBefore = await f.store.getPipelineRecord('CHANGE_EVENT', first.changeEventId!);

    const retry = await f.run([...f.observations].reverse());
    assert.equal(retry.canonicalWrite, 'UNCHANGED');
    assert.deepEqual(retry, { ...first, canonicalWrite: 'UNCHANGED' });
    assert.deepEqual(await f.store.getPipelineRecord('CANDIDATE_FACT', retry.candidateFactId), evidenceBefore);
    assert.deepEqual(await f.store.getPipelineRecord('PROMOTION_RESULT', retry.promotionResultId), outcomeBefore);
    assert.deepEqual(await f.store.getPipelineRecord('CHANGE_EVENT', retry.changeEventId!), eventBefore);
    assert.equal(outcomeBefore?.payload.canonicalWrite, 'CREATED');
    assert.deepEqual(f.observations, original, 'caller observation order must not be mutated');
  });

  test(`${kind}: same-field same-source conflicting values are order-stable HOLD`, async () => {
    const f = await fixture(kind);
    const observations = [...f.observations, f.contradiction];
    const first = await f.run(observations);
    const retry = await f.run([...observations].reverse());
    assert.equal(first.decision.status, 'HOLD');
    assert.ok(first.decision.issues.some((issue) => issue.code === 'FIELD_EVIDENCE_CONFLICT'));
    assert.equal(first.canonicalWrite, null);
    assert.equal(first.changeEventId, null);
    assert.deepEqual(retry, first);
    assert.equal(await f.readCanonical(), null, 'conflicting evidence must not write Canonical');
  });
}

test('changed evidence is not replayed as an approved result', async () => {
  const f = await fixture('node');
  const first = await f.run(f.observations);
  const canonicalBefore = await f.readCanonical();
  const changed = f.observations.map((item) =>
    item.fieldPath === f.contradiction.fieldPath ? f.contradiction : item
  );
  const next = await f.run(changed);
  assert.notEqual(next.candidateFactId, first.candidateFactId);
  assert.equal(next.decision.status, 'HOLD');
  assert.equal(next.canonicalWrite, null);
  assert.deepEqual(await f.readCanonical(), canonicalBefore);
});

test('exact retry still preserves the existing CREATED outcome', async () => {
  const f = await fixture('node');
  const first = await f.run(f.observations);
  const retry = await f.run(f.observations);
  assert.deepEqual(retry, { ...first, canonicalWrite: 'UNCHANGED' });
  const saved = await f.store.getPipelineRecord('PROMOTION_RESULT', first.promotionResultId);
  assert.equal(saved?.payload.canonicalWrite, 'CREATED');
});

test('immutable payload collision protection is not weakened', async () => {
  const f = await fixture('node');
  const result = await f.run(f.observations);
  const saved = await f.store.getPipelineRecord('CANDIDATE_FACT', result.candidateFactId);
  assert.ok(saved);
  const { contentHash: _hash, ...record } = saved;
  const tampered = sealVehicleMasterPipelineRecord({
    ...record, payload: { ...record.payload, proposalHash: 'different' },
  });
  await assert.rejects(f.store.putPipelineRecord(tampered), /VEHICLE_MASTER_DETERMINISTIC_ID_COLLISION/);
  assert.deepEqual(await f.store.getPipelineRecord('CANDIDATE_FACT', result.candidateFactId), saved);
});
