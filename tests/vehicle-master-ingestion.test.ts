import { describe, expect, it } from 'vitest';
import {
  deterministicVehicleMasterId,
  deterministicVehicleMasterRecordId,
  sealVehicleMasterNode,
  sealVehicleMasterPriceRevision,
  sealVehicleMasterSourceDocument,
  type VehicleMasterSourceDocument,
} from '../src/domain/vehicle-master.js';
import {
  promoteVehicleMasterNode,
  promoteVehicleMasterPriceRevision,
  type VehicleMasterFieldObservation,
} from '../src/application/vehicle-master-ingestion.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import {
  canonicalPowertrainIdentity,
  canonicalTrimIdentity,
} from '../src/domain/vehicle-master-normalization.js';

const observedAt = '2026-09-25T08:30:00.000Z';
const effectiveFrom = '2026-09-01T00:00:00.000Z';

function source(
  sourceDocumentId: string,
  sourceType: VehicleMasterSourceDocument['sourceType'],
  shaChar: string
) {
  return sealVehicleMasterSourceDocument({
    sourceDocumentId,
    sourceType,
    sourceName: sourceDocumentId,
    sourceUrl: `https://example.test/${sourceDocumentId}`,
    publishedAt: effectiveFrom,
    observedAt,
    effectiveFrom,
    effectiveTo: null,
    storagePath: `vehicle-master/source-documents/test/${sourceDocumentId}.html`,
    sha256: shaChar.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  });
}

function trimProposal(sourceEvidenceIds: string[], status: 'ACTIVE' | 'HISTORICAL' = 'ACTIVE') {
  const modelYearId = deterministicVehicleMasterId('MODEL_YEAR', {
    modelId: 'model_sorento',
    modelYear: 2027,
  });
  const powertrainId = deterministicVehicleMasterId('POWERTRAIN', {
    modelYearId,
    code: 'g2.5t',
  });
  const variantId = deterministicVehicleMasterId('VARIANT', {
    powertrainId,
    seats: 5,
    drivetrain: '2WD',
  });
  const id = deterministicVehicleMasterId('TRIM', {
    variantId,
    canonicalName: '프레스티지',
  });

  return sealVehicleMasterNode({
    id,
    nodeType: 'TRIM',
    status,
    revision: 1,
    canonicalName: '프레스티지',
    parentId: variantId,
    refs: {
      makeId: 'make_kia',
      modelId: 'model_sorento',
      modelYearId,
      powertrainId,
      variantId,
    },
    aliases: ['Prestige', '프레스티지'],
    attributes: { identityKey: canonicalTrimIdentity('프레스티지') },
    sourceEvidenceIds,
    effectiveFrom,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
}

function observations(
  proposal: ReturnType<typeof trimProposal>,
  sourceDocumentIds: string[]
): VehicleMasterFieldObservation[] {
  const fields = [
    ['canonicalName', proposal.canonicalName],
    ['refs.modelYearId', proposal.refs.modelYearId],
    ['refs.powertrainId', proposal.refs.powertrainId],
    ['refs.variantId', proposal.refs.variantId],
  ] as const;
  return fields.flatMap(([fieldPath, value]) =>
    sourceDocumentIds.map((sourceDocumentId) => ({
      fieldPath,
      value,
      sourceDocumentId,
    }))
  );
}


async function seedAncestors(
  store: MemoryVehicleMasterStore,
  proposal: ReturnType<typeof trimProposal>
) {
  const rows = [
    { id: 'make_kia', type: 'MAKE' as const, name: '기아', parentId: null },
    { id: 'model_sorento', type: 'MODEL' as const, name: '쏘렌토', parentId: 'make_kia' },
    {
      id: proposal.refs.modelYearId!,
      type: 'MODEL_YEAR' as const,
      name: '2027년형',
      parentId: 'model_sorento',
    },
    {
      id: proposal.refs.powertrainId!,
      type: 'POWERTRAIN' as const,
      name: '2.5 가솔린 터보',
      parentId: proposal.refs.modelYearId!,
    },
    {
      id: proposal.refs.variantId!,
      type: 'VARIANT' as const,
      name: '5인승 2WD',
      parentId: proposal.refs.powertrainId!,
    },
  ];

  for (const row of rows) {
    await store.putNode(sealVehicleMasterNode({
      id: row.id,
      nodeType: row.type,
      status: proposal.status,
      revision: 1,
      canonicalName: row.name,
      parentId: row.parentId,
      refs: {},
      aliases: [],
      attributes: {},
      sourceEvidenceIds: proposal.sourceEvidenceIds,
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));
  }
}

const identityPolicy = {
  requiredFieldPaths: [
    'canonicalName',
    'refs.modelYearId',
    'refs.powertrainId',
    'refs.variantId',
  ],
  minCorroboratingSourcesWithoutOfficial: 2,
};

describe('vehicle master evidence-gated ingestion', () => {
  it('promotes a current trim when manufacturer evidence is present', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('kia-official-2027-sorento', 'MANUFACTURER_OFFICIAL', 'a');
    const carnoon = source('carnoon-2027-sorento', 'CARNOON', 'b');
    await store.putSourceDocument(official);
    await store.putSourceDocument(carnoon);

    const proposal = trimProposal([official.sourceDocumentId, carnoon.sourceDocumentId]);
    await seedAncestors(store, proposal);
    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: observations(proposal, [
        official.sourceDocumentId,
        carnoon.sourceDocumentId,
      ]),
      policy: identityPolicy,
      observedAt,
    });

    expect(result.decision.status).toBe('APPROVED');
    expect(result.decision.authorityScore).toBe(100);
    expect(result.canonicalWrite).toBe('CREATED');
    expect(result.changeEventId).toBeTruthy();
    expect((await store.getNode(proposal.id))?.contentHash).toBe(proposal.contentHash);
  });

  it('allows historical recovery from two corroborating archive-quality sources', async () => {
    const store = new MemoryVehicleMasterStore();
    const carnoon = source('carnoon-historical', 'CARNOON', 'c');
    const carisyou = source('carisyou-historical', 'CARISYOU', 'd');
    await store.putSourceDocument(carnoon);
    await store.putSourceDocument(carisyou);

    const proposal = trimProposal([carnoon.sourceDocumentId, carisyou.sourceDocumentId], 'HISTORICAL');
    await seedAncestors(store, proposal);
    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: observations(proposal, [
        carnoon.sourceDocumentId,
        carisyou.sourceDocumentId,
      ]),
      policy: identityPolicy,
      observedAt,
    });

    expect(result.decision.status).toBe('APPROVED');
    expect(result.decision.authorityScore).toBe(70);
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('does not let a dealer/archive source independently complete historical corroboration', async () => {
    const store = new MemoryVehicleMasterStore();
    const carisyou = source('carisyou-historical', 'CARISYOU', '7');
    const wikicar = source('wikicar-discovery', 'WIKICAR', '8');
    await store.putSourceDocument(carisyou);
    await store.putSourceDocument(wikicar);

    const proposal = trimProposal([carisyou.sourceDocumentId, wikicar.sourceDocumentId], 'HISTORICAL');
    await seedAncestors(store, proposal);
    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: observations(proposal, [
        carisyou.sourceDocumentId,
        wikicar.sourceDocumentId,
      ]),
      policy: identityPolicy,
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_AUTHORITY_INSUFFICIENT',
          detail: 'corroborating=1',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps a single non-official source on HOLD', async () => {
    const store = new MemoryVehicleMasterStore();
    const carnoon = source('carnoon-only', 'CARNOON', 'e');
    await store.putSourceDocument(carnoon);

    const proposal = trimProposal([carnoon.sourceDocumentId]);
    await seedAncestors(store, proposal);
    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: observations(proposal, [carnoon.sourceDocumentId]),
      policy: identityPolicy,
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues.some(
      (issue) => issue.code === 'SOURCE_AUTHORITY_INSUFFICIENT'
    )).toBe(true);
    expect(result.canonicalWrite).toBeNull();
    expect(await store.getNode(proposal.id)).toBeNull();
  });

  it('blocks conflicting evidence even when one source is official', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-conflict', 'MANUFACTURER_OFFICIAL', 'f');
    const secondary = source('secondary-conflict', 'CARNOON', '1');
    await store.putSourceDocument(official);
    await store.putSourceDocument(secondary);

    const proposal = trimProposal([official.sourceDocumentId, secondary.sourceDocumentId]);
    await seedAncestors(store, proposal);
    const mixed = observations(proposal, [official.sourceDocumentId]);
    mixed.push({
      fieldPath: 'canonicalName',
      value: '노블레스',
      sourceDocumentId: secondary.sourceDocumentId,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: mixed,
      policy: identityPolicy,
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FIELD_EVIDENCE_CONFLICT', fieldPath: 'canonicalName' }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('does not count repeated captures from the same provider as independent corroboration', async () => {
    const store = new MemoryVehicleMasterStore();
    const carnoonA = source('carnoon-capture-a', 'CARNOON', '5');
    const carnoonB = source('carnoon-capture-b', 'CARNOON', '6');
    await store.putSourceDocument(carnoonA);
    await store.putSourceDocument(carnoonB);

    const proposal = trimProposal([carnoonA.sourceDocumentId, carnoonB.sourceDocumentId]);
    await seedAncestors(store, proposal);
    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: observations(proposal, [
        carnoonA.sourceDocumentId,
        carnoonB.sourceDocumentId,
      ]),
      policy: identityPolicy,
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_AUTHORITY_INSUFFICIENT',
          detail: 'corroborating=1',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps a child node on HOLD when its canonical parent is missing', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-missing-parent', 'MANUFACTURER_OFFICIAL', '4');
    await store.putSourceDocument(official);

    const proposal = trimProposal([official.sourceDocumentId]);
    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: observations(proposal, [official.sourceDocumentId]),
      policy: identityPolicy,
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PARENT_NODE_MISSING' }),
        expect.objectContaining({ code: 'REFERENCE_NODE_MISSING' }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps a resolved child on HOLD when a canonical ancestor is HOLD', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-hold-parent', 'MANUFACTURER_OFFICIAL', '9');
    await store.putSourceDocument(official);

    const proposal = trimProposal([official.sourceDocumentId]);
    await seedAncestors(store, proposal);

    const parent = await store.getNode(proposal.parentId!);
    expect(parent).toBeTruthy();
    await store.putNode(sealVehicleMasterNode({
      id: parent!.id,
      nodeType: parent!.nodeType,
      status: 'HOLD',
      revision: parent!.revision + 1,
      canonicalName: parent!.canonicalName,
      parentId: parent!.parentId ?? null,
      refs: parent!.refs,
      aliases: parent!.aliases,
      attributes: parent!.attributes,
      sourceEvidenceIds: parent!.sourceEvidenceIds,
      effectiveFrom: parent!.effectiveFrom ?? null,
      effectiveTo: parent!.effectiveTo ?? null,
      createdAt: parent!.createdAt,
      updatedAt: observedAt,
    }));

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: observations(proposal, [official.sourceDocumentId]),
      policy: identityPolicy,
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PARENT_NODE_HOLD', detail: proposal.parentId }),
        expect.objectContaining({ code: 'REFERENCE_NODE_HOLD', fieldPath: 'refs.variantId' }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
    expect(await store.getNode(proposal.id)).toBeNull();
  });

  it('keeps a node on HOLD when parentId disagrees with its canonical parent ref', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-parent-ref-mismatch', 'MANUFACTURER_OFFICIAL', 'e');
    await store.putSourceDocument(official);

    const base = trimProposal([official.sourceDocumentId]);
    await seedAncestors(store, base);

    await store.putNode(sealVehicleMasterNode({
      id: 'variant_alternate_parent',
      nodeType: 'VARIANT',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '5인승 AWD',
      parentId: base.refs.powertrainId!,
      refs: {},
      aliases: [],
      attributes: { seats: 5, drivetrain: 'AWD' },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const proposal = sealVehicleMasterNode({
      id: base.id,
      nodeType: base.nodeType,
      status: base.status,
      revision: base.revision,
      canonicalName: base.canonicalName,
      parentId: 'variant_alternate_parent',
      refs: base.refs,
      aliases: base.aliases,
      attributes: base.attributes,
      sourceEvidenceIds: base.sourceEvidenceIds,
      effectiveFrom: base.effectiveFrom ?? null,
      effectiveTo: base.effectiveTo ?? null,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: observations(proposal, [official.sourceDocumentId]),
      policy: identityPolicy,
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PARENT_REFERENCE_MISMATCH',
          fieldPath: 'parentId',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps MODEL_YEAR on HOLD when canonicalName disagrees with attributes.modelYear', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-model-year-name-mismatch', 'MANUFACTURER_OFFICIAL', '1');
    await store.putSourceDocument(official);

    const phase = sealVehicleMasterNode({
      id: 'phase_model_year_semantics',
      nodeType: 'PHASE',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '초기형',
      parentId: null,
      refs: {},
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(phase);

    const proposal = sealVehicleMasterNode({
      id: 'my_name_mismatch',
      nodeType: 'MODEL_YEAR',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '2024년형',
      parentId: phase.id,
      refs: { phaseId: phase.id },
      aliases: ['2025MY'],
      attributes: { modelYear: 2025 },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'attributes.modelYear',
        value: 2025,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['attributes.modelYear'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MODEL_YEAR_NAME_MISMATCH',
          detail: '2024!=2025',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps MODEL_YEAR on HOLD when an explicit year alias disagrees with the fact value', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-model-year-alias-mismatch', 'MANUFACTURER_OFFICIAL', '2');
    await store.putSourceDocument(official);

    const phase = sealVehicleMasterNode({
      id: 'phase_model_year_alias',
      nodeType: 'PHASE',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '초기형',
      parentId: null,
      refs: {},
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(phase);

    const proposal = sealVehicleMasterNode({
      id: 'my_alias_mismatch',
      nodeType: 'MODEL_YEAR',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '2025년형',
      parentId: phase.id,
      refs: { phaseId: phase.id },
      aliases: ['2024MY', '2025'],
      attributes: { modelYear: 2025 },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'attributes.modelYear',
        value: 2025,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['attributes.modelYear'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MODEL_YEAR_ALIAS_MISMATCH',
          detail: '2024MY!=2025',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps duplicate MODEL_YEAR facts on HOLD within the same PHASE', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-model-year-duplicate', 'MANUFACTURER_OFFICIAL', '3');
    await store.putSourceDocument(official);

    const phase = sealVehicleMasterNode({
      id: 'phase_model_year_duplicate',
      nodeType: 'PHASE',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '초기형',
      parentId: null,
      refs: {},
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(phase);

    await store.putNode(sealVehicleMasterNode({
      id: 'my_2025_existing',
      nodeType: 'MODEL_YEAR',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '2025년형',
      parentId: phase.id,
      refs: { phaseId: phase.id },
      aliases: ['2025MY'],
      attributes: { modelYear: 2025 },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const proposal = sealVehicleMasterNode({
      id: 'my_2025_duplicate',
      nodeType: 'MODEL_YEAR',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '2025년형',
      parentId: phase.id,
      refs: { phaseId: phase.id },
      aliases: ['2025'],
      attributes: { modelYear: 2025 },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'attributes.modelYear',
        value: 2025,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['attributes.modelYear'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MODEL_YEAR_DUPLICATE_IN_PHASE',
          detail: 'my_2025_existing',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps a semantic duplicate POWERTRAIN on HOLD within the same MODEL_YEAR', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-powertrain-duplicate', 'MANUFACTURER_OFFICIAL', '4');
    await store.putSourceDocument(official);

    const modelYear = sealVehicleMasterNode({
      id: 'my_powertrain_duplicate',
      nodeType: 'MODEL_YEAR',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '2026년형',
      parentId: null,
      refs: {},
      aliases: ['2026MY'],
      attributes: { modelYear: 2026 },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(modelYear);

    await store.putNode(sealVehicleMasterNode({
      id: 'pt_hybrid_existing',
      nodeType: 'POWERTRAIN',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '1.6 하이브리드',
      parentId: modelYear.id,
      refs: { modelYearId: modelYear.id },
      aliases: [],
      attributes: {
        identityKey: canonicalPowertrainIdentity('1.6 하이브리드'),
        fuelType: 'HYBRID',
      },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const identityKey = canonicalPowertrainIdentity('1.6 HEV');
    const proposal = sealVehicleMasterNode({
      id: 'pt_hev_duplicate',
      nodeType: 'POWERTRAIN',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '1.6 HEV',
      parentId: modelYear.id,
      refs: { modelYearId: modelYear.id },
      aliases: [],
      attributes: { identityKey, fuelType: 'HYBRID' },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'attributes.identityKey',
        value: identityKey,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['attributes.identityKey'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'POWERTRAIN_DUPLICATE_IN_MODEL_YEAR',
          detail: 'pt_hybrid_existing',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps POWERTRAIN on HOLD when explicit fuel semantics contradict fuelType', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-powertrain-fuel-mismatch', 'MANUFACTURER_OFFICIAL', '5');
    await store.putSourceDocument(official);

    const modelYear = sealVehicleMasterNode({
      id: 'my_powertrain_fuel',
      nodeType: 'MODEL_YEAR',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '2026년형',
      parentId: null,
      refs: {},
      aliases: ['2026MY'],
      attributes: { modelYear: 2026 },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(modelYear);

    const identityKey = canonicalPowertrainIdentity('1.6 터보 하이브리드');
    const proposal = sealVehicleMasterNode({
      id: 'pt_fuel_mismatch',
      nodeType: 'POWERTRAIN',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '1.6 터보 하이브리드',
      parentId: modelYear.id,
      refs: { modelYearId: modelYear.id },
      aliases: [],
      attributes: { identityKey, fuelType: 'GASOLINE' },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'attributes.identityKey',
        value: identityKey,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['attributes.identityKey'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'POWERTRAIN_FUEL_TYPE_MISMATCH',
          detail: 'GASOLINE!=HYBRID',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps POWERTRAIN on HOLD when identityKey does not match its canonical label', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-powertrain-key-mismatch', 'MANUFACTURER_OFFICIAL', '6');
    await store.putSourceDocument(official);

    const modelYear = sealVehicleMasterNode({
      id: 'my_powertrain_key',
      nodeType: 'MODEL_YEAR',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '2026년형',
      parentId: null,
      refs: {},
      aliases: ['2026MY'],
      attributes: { modelYear: 2026 },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(modelYear);

    const proposal = sealVehicleMasterNode({
      id: 'pt_identity_mismatch',
      nodeType: 'POWERTRAIN',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '2.2 디젤',
      parentId: modelYear.id,
      refs: { modelYearId: modelYear.id },
      aliases: [],
      attributes: { identityKey: '2.2|가솔린', fuelType: 'DIESEL' },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'attributes.identityKey',
        value: '2.2|가솔린',
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['attributes.identityKey'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'POWERTRAIN_IDENTITY_MISMATCH',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps a semantic duplicate VARIANT on HOLD within the same POWERTRAIN', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-variant-duplicate', 'MANUFACTURER_OFFICIAL', 'a');
    await store.putSourceDocument(official);

    const base = trimProposal([official.sourceDocumentId]);
    await seedAncestors(store, base);

    await store.putNode(sealVehicleMasterNode({
      id: 'variant_fwd_existing',
      nodeType: 'VARIANT',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '5인승 전륜',
      parentId: base.refs.powertrainId!,
      refs: { powertrainId: base.refs.powertrainId! },
      aliases: [],
      attributes: { seats: 5, drivetrain: 'FWD' },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const proposal = sealVehicleMasterNode({
      id: 'variant_fwd_duplicate',
      nodeType: 'VARIANT',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: 'FWD 5seat',
      parentId: base.refs.powertrainId!,
      refs: { powertrainId: base.refs.powertrainId! },
      aliases: [],
      attributes: { seats: 5, drivetrain: 'FWD' },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [
        { fieldPath: 'attributes.seats', value: 5, sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'attributes.drivetrain', value: 'FWD', sourceDocumentId: official.sourceDocumentId },
      ],
      policy: {
        requiredFieldPaths: ['attributes.seats', 'attributes.drivetrain'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'VARIANT_DUPLICATE_IN_POWERTRAIN',
          detail: 'variant_fwd_existing',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps VARIANT on HOLD when drivetrain is semantically valid but not canonicalized', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-variant-noncanonical-drive', 'MANUFACTURER_OFFICIAL', 'b');
    await store.putSourceDocument(official);

    const base = trimProposal([official.sourceDocumentId]);
    await seedAncestors(store, base);

    const proposal = sealVehicleMasterNode({
      id: 'variant_noncanonical_drive',
      nodeType: 'VARIANT',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '5인승 전륜',
      parentId: base.refs.powertrainId!,
      refs: { powertrainId: base.refs.powertrainId! },
      aliases: [],
      attributes: { seats: 5, drivetrain: '전륜' },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [
        { fieldPath: 'attributes.seats', value: 5, sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'attributes.drivetrain', value: '전륜', sourceDocumentId: official.sourceDocumentId },
      ],
      policy: {
        requiredFieldPaths: ['attributes.seats', 'attributes.drivetrain'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'VARIANT_DRIVETRAIN_NOT_CANONICAL',
          detail: '전륜!=FWD',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps VARIANT on HOLD when explicit label facts contradict seats and drivetrain', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-variant-label-mismatch', 'MANUFACTURER_OFFICIAL', 'c');
    await store.putSourceDocument(official);

    const base = trimProposal([official.sourceDocumentId]);
    await seedAncestors(store, base);

    const proposal = sealVehicleMasterNode({
      id: 'variant_label_mismatch',
      nodeType: 'VARIANT',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '7인승 AWD',
      parentId: base.refs.powertrainId!,
      refs: { powertrainId: base.refs.powertrainId! },
      aliases: [],
      attributes: { seats: 5, drivetrain: 'FWD' },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [
        { fieldPath: 'attributes.seats', value: 5, sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'attributes.drivetrain', value: 'FWD', sourceDocumentId: official.sourceDocumentId },
      ],
      policy: {
        requiredFieldPaths: ['attributes.seats', 'attributes.drivetrain'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'VARIANT_NAME_SEATS_MISMATCH',
          detail: '7!=5',
        }),
        expect.objectContaining({
          code: 'VARIANT_NAME_DRIVETRAIN_MISMATCH',
          detail: 'AWD!=FWD',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps a semantic duplicate TRIM on HOLD within the same VARIANT', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-trim-duplicate', 'MANUFACTURER_OFFICIAL', '7');
    await store.putSourceDocument(official);

    const base = trimProposal([official.sourceDocumentId]);
    await seedAncestors(store, base);

    await store.putNode(sealVehicleMasterNode({
      id: 'trim_noblesse_existing',
      nodeType: 'TRIM',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '노블레스',
      parentId: base.refs.variantId!,
      refs: base.refs,
      aliases: ['Noblesse'],
      attributes: { identityKey: canonicalTrimIdentity('노블레스') },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const proposal = sealVehicleMasterNode({
      id: 'trim_noblesse_duplicate',
      nodeType: 'TRIM',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: 'Noblesse',
      parentId: base.refs.variantId!,
      refs: base.refs,
      aliases: [],
      attributes: { identityKey: canonicalTrimIdentity('Noblesse') },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'canonicalName',
        value: proposal.canonicalName,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['canonicalName'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'TRIM_DUPLICATE_IN_VARIANT',
          detail: 'trim_noblesse_existing',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps TRIM on HOLD when identityKey does not match the canonical label', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-trim-key-mismatch', 'MANUFACTURER_OFFICIAL', '8');
    await store.putSourceDocument(official);

    const base = trimProposal([official.sourceDocumentId]);
    await seedAncestors(store, base);

    const proposal = sealVehicleMasterNode({
      id: 'trim_identity_mismatch',
      nodeType: 'TRIM',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '시그니처',
      parentId: base.refs.variantId!,
      refs: base.refs,
      aliases: [],
      attributes: { identityKey: canonicalTrimIdentity('노블레스') },
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'canonicalName',
        value: proposal.canonicalName,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['canonicalName'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'TRIM_IDENTITY_MISMATCH',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps duplicate MODEL aliases on HOLD within the same MAKE', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-model-alias-duplicate', 'MANUFACTURER_OFFICIAL', 'a');
    await store.putSourceDocument(official);

    const make = sealVehicleMasterNode({
      id: 'make_kia_alias_test',
      nodeType: 'MAKE',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '기아',
      parentId: null,
      refs: {},
      aliases: ['Kia'],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(make);

    await store.putNode(sealVehicleMasterNode({
      id: 'model_sorento_existing',
      nodeType: 'MODEL',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '쏘렌토',
      parentId: make.id,
      refs: { makeId: make.id },
      aliases: ['Sorento'],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const proposal = sealVehicleMasterNode({
      id: 'model_sorento_english_duplicate',
      nodeType: 'MODEL',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: 'Sorento',
      parentId: make.id,
      refs: { makeId: make.id },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'canonicalName',
        value: proposal.canonicalName,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['canonicalName'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MODEL_DUPLICATE_IN_MAKE',
          detail: 'model_sorento_existing',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps duplicate GENERATION aliases on HOLD within the same MODEL', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-generation-alias-duplicate', 'MANUFACTURER_OFFICIAL', 'b');
    await store.putSourceDocument(official);

    const model = sealVehicleMasterNode({
      id: 'model_generation_alias_test',
      nodeType: 'MODEL',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '쏘렌토',
      parentId: null,
      refs: {},
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(model);

    await store.putNode(sealVehicleMasterNode({
      id: 'gen_mq4_existing',
      nodeType: 'GENERATION',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '4세대 MQ4',
      parentId: model.id,
      refs: { modelId: model.id },
      aliases: ['MQ4'],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const proposal = sealVehicleMasterNode({
      id: 'gen_mq4_duplicate',
      nodeType: 'GENERATION',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: 'MQ4',
      parentId: model.id,
      refs: { modelId: model.id },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'canonicalName',
        value: proposal.canonicalName,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['canonicalName'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'GENERATION_DUPLICATE_IN_MODEL',
          detail: 'gen_mq4_existing',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps duplicate PHASE aliases on HOLD within the same GENERATION', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-phase-alias-duplicate', 'MANUFACTURER_OFFICIAL', 'c');
    await store.putSourceDocument(official);

    const generation = sealVehicleMasterNode({
      id: 'gen_phase_alias_test',
      nodeType: 'GENERATION',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: 'MQ4',
      parentId: null,
      refs: {},
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(generation);

    await store.putNode(sealVehicleMasterNode({
      id: 'phase_facelift_existing',
      nodeType: 'PHASE',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '더 뉴 쏘렌토',
      parentId: generation.id,
      refs: { generationId: generation.id },
      aliases: ['페이스리프트'],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const proposal = sealVehicleMasterNode({
      id: 'phase_facelift_duplicate',
      nodeType: 'PHASE',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '페이스리프트',
      parentId: generation.id,
      refs: { generationId: generation.id },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'canonicalName',
        value: proposal.canonicalName,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['canonicalName'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PHASE_DUPLICATE_IN_GENERATION',
          detail: 'phase_facelift_existing',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('allows the same hierarchy label under a different canonical parent', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-generation-parent-scope', 'MANUFACTURER_OFFICIAL', 'd');
    await store.putSourceDocument(official);

    const modelA = sealVehicleMasterNode({
      id: 'model_parent_a',
      nodeType: 'MODEL',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '모델 A',
      parentId: null,
      refs: {},
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    const modelB = sealVehicleMasterNode({
      id: 'model_parent_b',
      nodeType: 'MODEL',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '모델 B',
      parentId: null,
      refs: {},
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(modelA);
    await store.putNode(modelB);

    await store.putNode(sealVehicleMasterNode({
      id: 'gen_first_under_a',
      nodeType: 'GENERATION',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '1세대',
      parentId: modelA.id,
      refs: { modelId: modelA.id },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const proposal = sealVehicleMasterNode({
      id: 'gen_first_under_b',
      nodeType: 'GENERATION',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '1세대',
      parentId: modelB.id,
      refs: { modelId: modelB.id },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'canonicalName',
        value: proposal.canonicalName,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['canonicalName'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('keeps an overlapping sibling PHASE on HOLD within the same generation', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-phase-overlap', 'MANUFACTURER_OFFICIAL', 'f');
    await store.putSourceDocument(official);

    const generation = sealVehicleMasterNode({
      id: 'gen_overlap_test',
      nodeType: 'GENERATION',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '테스트 세대',
      parentId: null,
      refs: {},
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: '2027-01-01T00:00:00.000Z',
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(generation);

    await store.putNode(sealVehicleMasterNode({
      id: 'phase_pre_overlap',
      nodeType: 'PHASE',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '초기형',
      parentId: generation.id,
      refs: { generationId: generation.id },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: '2026-10-01T00:00:00.000Z',
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const proposal = sealVehicleMasterNode({
      id: 'phase_facelift_overlap',
      nodeType: 'PHASE',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '페이스리프트',
      parentId: generation.id,
      refs: { generationId: generation.id },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [official.sourceDocumentId],
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      effectiveTo: '2027-01-01T00:00:00.000Z',
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: [{
        fieldPath: 'canonicalName',
        value: proposal.canonicalName,
        sourceDocumentId: official.sourceDocumentId,
      }],
      policy: {
        requiredFieldPaths: ['canonicalName'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PHASE_EFFECTIVE_RANGE_OVERLAP',
          detail: 'phase_pre_overlap',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps a child on HOLD when its effective range escapes the canonical parent', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-temporal-parent', 'MANUFACTURER_OFFICIAL', 'a');
    await store.putSourceDocument(official);

    const proposal = trimProposal([official.sourceDocumentId]);
    await seedAncestors(store, proposal);

    const parent = await store.getNode(proposal.parentId!);
    expect(parent).toBeTruthy();
    await store.putNode(sealVehicleMasterNode({
      id: parent!.id,
      nodeType: parent!.nodeType,
      status: parent!.status,
      revision: parent!.revision + 1,
      canonicalName: parent!.canonicalName,
      parentId: parent!.parentId ?? null,
      refs: parent!.refs,
      aliases: parent!.aliases,
      attributes: parent!.attributes,
      sourceEvidenceIds: parent!.sourceEvidenceIds,
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: null,
      createdAt: parent!.createdAt,
      updatedAt: observedAt,
    }));

    const result = await promoteVehicleMasterNode(store, {
      proposal,
      observations: observations(proposal, [official.sourceDocumentId]),
      policy: identityPolicy,
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PARENT_EFFECTIVE_RANGE_MISMATCH',
          detail: proposal.parentId,
        }),
        expect.objectContaining({
          code: 'REFERENCE_EFFECTIVE_RANGE_MISMATCH',
          fieldPath: 'refs.variantId',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps a price on HOLD when its effective range escapes the target trim', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-temporal-price', 'MANUFACTURER_OFFICIAL', 'b');
    await store.putSourceDocument(official);

    const trim = trimProposal([official.sourceDocumentId]);
    await seedAncestors(store, trim);
    await store.putNode(trim);
    await store.putNode(sealVehicleMasterNode({
      id: trim.id,
      nodeType: trim.nodeType,
      status: trim.status,
      revision: 2,
      canonicalName: trim.canonicalName,
      parentId: trim.parentId ?? null,
      refs: trim.refs,
      aliases: trim.aliases,
      attributes: trim.attributes,
      sourceEvidenceIds: trim.sourceEvidenceIds,
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: null,
      createdAt: trim.createdAt,
      updatedAt: observedAt,
    }));

    const price = sealVehicleMasterPriceRevision({
      id: deterministicVehicleMasterRecordId('price', {
        targetId: trim.id,
        priceType: 'BASE',
        effectiveFrom,
      }),
      targetId: trim.id,
      priceType: 'BASE',
      amount: 36410000,
      currency: 'KRW',
      revision: 1,
      sourceEvidenceIds: [official.sourceDocumentId],
      sourceDocumentIds: [official.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterPriceRevision(store, {
      proposal: price,
      observations: [
        { fieldPath: 'amount', value: 36410000, sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'currency', value: 'KRW', sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'targetId', value: trim.id, sourceDocumentId: official.sourceDocumentId },
      ],
      policy: {
        requiredFieldPaths: ['amount', 'currency', 'targetId'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PRICE_TARGET_EFFECTIVE_RANGE_MISMATCH',
          detail: trim.id,
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps a conflicting price on HOLD when another price starts at the same time', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-price-same-start', 'MANUFACTURER_OFFICIAL', 'c');
    await store.putSourceDocument(official);

    const trim = trimProposal([official.sourceDocumentId]);
    await seedAncestors(store, trim);
    await store.putNode(trim);

    await store.putPriceRevision(sealVehicleMasterPriceRevision({
      id: 'price_existing_same_start',
      targetId: trim.id,
      priceType: 'BASE',
      amount: 36000000,
      currency: 'KRW',
      revision: 1,
      sourceEvidenceIds: [official.sourceDocumentId],
      sourceDocumentIds: [official.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const proposal = sealVehicleMasterPriceRevision({
      id: 'price_conflicting_same_start',
      targetId: trim.id,
      priceType: 'BASE',
      amount: 37000000,
      currency: 'KRW',
      revision: 1,
      sourceEvidenceIds: [official.sourceDocumentId],
      sourceDocumentIds: [official.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterPriceRevision(store, {
      proposal,
      observations: [
        { fieldPath: 'amount', value: 37000000, sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'currency', value: 'KRW', sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'targetId', value: trim.id, sourceDocumentId: official.sourceDocumentId },
      ],
      policy: {
        requiredFieldPaths: ['amount', 'currency', 'targetId'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PRICE_EFFECTIVE_START_CONFLICT',
          detail: 'price_existing_same_start',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps an explicitly overlapping price range on HOLD', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('official-price-overlap', 'MANUFACTURER_OFFICIAL', 'd');
    await store.putSourceDocument(official);

    const trim = trimProposal([official.sourceDocumentId]);
    await seedAncestors(store, trim);
    await store.putNode(trim);

    await store.putPriceRevision(sealVehicleMasterPriceRevision({
      id: 'price_existing_explicit_range',
      targetId: trim.id,
      priceType: 'BASE',
      amount: 36000000,
      currency: 'KRW',
      revision: 1,
      sourceEvidenceIds: [official.sourceDocumentId],
      sourceDocumentIds: [official.sourceDocumentId],
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      effectiveTo: '2026-10-01T00:00:00.000Z',
      createdAt: observedAt,
      updatedAt: observedAt,
    }));

    const proposal = sealVehicleMasterPriceRevision({
      id: 'price_overlapping_explicit_range',
      targetId: trim.id,
      priceType: 'BASE',
      amount: 37000000,
      currency: 'KRW',
      revision: 1,
      sourceEvidenceIds: [official.sourceDocumentId],
      sourceDocumentIds: [official.sourceDocumentId],
      effectiveFrom: '2026-09-15T00:00:00.000Z',
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterPriceRevision(store, {
      proposal,
      observations: [
        { fieldPath: 'amount', value: 37000000, sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'currency', value: 'KRW', sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'targetId', value: trim.id, sourceDocumentId: official.sourceDocumentId },
      ],
      policy: {
        requiredFieldPaths: ['amount', 'currency', 'targetId'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PRICE_EXPLICIT_RANGE_OVERLAP',
          detail: 'price_existing_explicit_range',
        }),
      ])
    );
    expect(result.canonicalWrite).toBeNull();
  });

  it('promotes base price through the same evidence gate', async () => {
    const store = new MemoryVehicleMasterStore();
    const official = source('kia-price-2027-sorento', 'MANUFACTURER_OFFICIAL', '2');
    const carnoon = source('carnoon-price-2027-sorento', 'CARNOON', '3');
    await store.putSourceDocument(official);
    await store.putSourceDocument(carnoon);

    const trim = trimProposal([official.sourceDocumentId, carnoon.sourceDocumentId]);
    await seedAncestors(store, trim);
    await store.putNode(trim);
    const price = sealVehicleMasterPriceRevision({
      id: deterministicVehicleMasterRecordId('price', {
        targetId: trim.id,
        priceType: 'BASE',
        effectiveFrom,
      }),
      targetId: trim.id,
      priceType: 'BASE',
      amount: 36410000,
      currency: 'KRW',
      revision: 1,
      sourceEvidenceIds: [official.sourceDocumentId, carnoon.sourceDocumentId],
      sourceDocumentIds: [official.sourceDocumentId, carnoon.sourceDocumentId],
      effectiveFrom,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });

    const result = await promoteVehicleMasterPriceRevision(store, {
      proposal: price,
      observations: [
        { fieldPath: 'amount', value: 36410000, sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'amount', value: 36410000, sourceDocumentId: carnoon.sourceDocumentId },
        { fieldPath: 'currency', value: 'KRW', sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'currency', value: 'KRW', sourceDocumentId: carnoon.sourceDocumentId },
        { fieldPath: 'targetId', value: trim.id, sourceDocumentId: official.sourceDocumentId },
        { fieldPath: 'targetId', value: trim.id, sourceDocumentId: carnoon.sourceDocumentId },
      ],
      policy: {
        requiredFieldPaths: ['amount', 'currency', 'targetId'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
      observedAt,
    });

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
    expect((await store.getPriceRevision(price.id))?.amount).toBe(36410000);
  });
});
