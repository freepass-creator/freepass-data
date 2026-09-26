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
    attributes: {},
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
      parentId: parent!.parentId,
      refs: parent!.refs,
      aliases: parent!.aliases,
      attributes: parent!.attributes,
      sourceEvidenceIds: parent!.sourceEvidenceIds,
      effectiveFrom: parent!.effectiveFrom,
      effectiveTo: parent!.effectiveTo,
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
