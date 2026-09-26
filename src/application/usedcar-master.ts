import {
  usedcarMasterRecordId,
  type UsedcarMasterIdentityStatus,
  type UsedcarMasterLifecycleStatus,
  type UsedcarMasterRecord,
} from '../domain/usedcar-master.js';
import type { VehicleMasterNode } from '../domain/vehicle-master.js';
import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';

function attrText(node: VehicleMasterNode | null, key: string) {
  const value = node?.attributes?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function attrInteger(node: VehicleMasterNode | null, key: string) {
  const value = node?.attributes?.[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function lifecycle(nodes: Array<VehicleMasterNode | null>): UsedcarMasterLifecycleStatus {
  if (nodes.some((node) => !node || node.status === 'HOLD')) return 'HOLD';

  const statuses = nodes.map((node) => node!.status);
  if (statuses.includes('DISCONTINUED')) return 'DISCONTINUED';
  if (statuses.includes('HISTORICAL')) return 'HISTORICAL';
  return 'CURRENT';
}

function identityStatus(
  ids: Array<string | null>,
  requiredRefs: Array<{ refId: string | null; node: VehicleMasterNode | null }>,
  trimStatus: VehicleMasterNode['status'],
  modelYear: number | null
): UsedcarMasterIdentityStatus {
  const brokenReference = requiredRefs.some(({ refId, node }) => Boolean(refId) && !node);
  const canonicalHold = trimStatus === 'HOLD'
    || requiredRefs.some(({ node }) => node?.status === 'HOLD');

  if (brokenReference || canonicalHold) return 'HOLD';
  if (ids.every(Boolean) && modelYear != null) return 'RESOLVED';
  return 'PARTIAL';
}

async function node(store: VehicleMasterStore, id: string | null | undefined) {
  return id ? store.getNode(id) : null;
}

function aliases(nodes: Array<VehicleMasterNode | null>) {
  return [...new Set(
    nodes.flatMap((item) => item ? [item.canonicalName, ...item.aliases] : [])
      .filter(Boolean)
  )].sort();
}

function projectedBasePriceHistory(
  prices: Awaited<ReturnType<VehicleMasterStore['listPriceRevisionsByTarget']>>
) {
  return prices.map((price, index) => {
    const next = prices[index + 1];
    const impliedEffectiveTo =
      price.effectiveFrom && next?.effectiveFrom
        ? next.effectiveFrom
        : null;

    return {
      priceRevisionId: price.id,
      amount: price.amount,
      currency: price.currency,
      effectiveFrom: price.effectiveFrom ?? null,
      effectiveTo: price.effectiveTo ?? impliedEffectiveTo,
      sourceDocumentIds: [...price.sourceDocumentIds],
    };
  });
}

export async function buildUsedcarMasterRecords(
  store: VehicleMasterStore
): Promise<UsedcarMasterRecord[]> {
  const trims = (await store.listNodesByType('TRIM'))
    .sort((a, b) => a.id.localeCompare(b.id));
  const records: UsedcarMasterRecord[] = [];

  for (const trim of trims) {
    const refs = trim.refs;
    const [
      make,
      model,
      generation,
      phase,
      modelYear,
      powertrain,
      variant,
    ] = await Promise.all([
      node(store, refs.makeId),
      node(store, refs.modelId),
      node(store, refs.generationId),
      node(store, refs.phaseId),
      node(store, refs.modelYearId),
      node(store, refs.powertrainId),
      node(store, refs.variantId),
    ]);

    const modelYearValue = attrInteger(modelYear, 'modelYear');
    const stableIds = [
      refs.modelId ?? null,
      refs.generationId ?? null,
      refs.phaseId ?? null,
      refs.modelYearId ?? null,
      refs.powertrainId ?? null,
      refs.variantId ?? null,
      trim.id,
    ];
    const holdReasons: string[] = [];
    const requiredNodes: Array<{
      reason: string;
      holdReason: string;
      refId: string | null;
      node: VehicleMasterNode | null;
    }> = [
      { reason: 'MAKE_NOT_FOUND', holdReason: 'CANONICAL_MAKE_HOLD', refId: refs.makeId ?? null, node: make },
      { reason: 'MODEL_NOT_FOUND', holdReason: 'CANONICAL_MODEL_HOLD', refId: refs.modelId ?? null, node: model },
      { reason: 'GENERATION_NOT_FOUND', holdReason: 'CANONICAL_GENERATION_HOLD', refId: refs.generationId ?? null, node: generation },
      { reason: 'PHASE_NOT_FOUND', holdReason: 'CANONICAL_PHASE_HOLD', refId: refs.phaseId ?? null, node: phase },
      { reason: 'MODEL_YEAR_NOT_FOUND', holdReason: 'CANONICAL_MODEL_YEAR_HOLD', refId: refs.modelYearId ?? null, node: modelYear },
      { reason: 'POWERTRAIN_NOT_FOUND', holdReason: 'CANONICAL_POWERTRAIN_HOLD', refId: refs.powertrainId ?? null, node: powertrain },
      { reason: 'VARIANT_NOT_FOUND', holdReason: 'CANONICAL_VARIANT_HOLD', refId: refs.variantId ?? null, node: variant },
    ];
    for (const item of requiredNodes) {
      if (!item.node) holdReasons.push(item.reason);
      if (item.node?.status === 'HOLD') holdReasons.push(item.holdReason);
    }
    if (modelYearValue == null) holdReasons.push('MODEL_YEAR_VALUE_NOT_FOUND');
    if (trim.status === 'HOLD') holdReasons.push('CANONICAL_TRIM_HOLD');

    const prices = (await store.listPriceRevisionsByTarget(trim.id))
      .filter((price) => price.priceType === 'BASE')
      .sort((a, b) =>
        (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? '') ||
        a.revision - b.revision ||
        a.id.localeCompare(b.id)
      );

    const identity = identityStatus(
      stableIds,
      requiredNodes.map(({ refId, node }) => ({ refId, node })),
      trim.status,
      modelYearValue
    );
    if (identity === 'HOLD' && !holdReasons.length) {
      holdReasons.push('IDENTITY_HOLD');
    }

    records.push({
      recordId: usedcarMasterRecordId(trim.id, { refs, trim: trim.canonicalName }),
      vehicleModelId: refs.modelId ?? null,
      generationId: refs.generationId ?? null,
      phaseId: refs.phaseId ?? null,
      modelYearId: refs.modelYearId ?? null,
      powertrainId: refs.powertrainId ?? null,
      variantId: refs.variantId ?? null,
      trimId: trim.id,
      maker: make?.canonicalName ?? 'UNKNOWN',
      model: model?.canonicalName ?? 'UNKNOWN',
      generationName: generation?.canonicalName ?? null,
      phaseName: phase?.canonicalName ?? null,
      modelYear: modelYearValue,
      powertrainName: powertrain?.canonicalName ?? null,
      trimName: trim.canonicalName,
      configuration: {
        fuelType: attrText(powertrain, 'fuelType'),
        drivetrain: attrText(variant, 'drivetrain'),
        seats: attrInteger(variant, 'seats'),
      },
      aliases: aliases([make, model, generation, phase, modelYear, powertrain, variant, trim]),
      originalBasePriceHistory: projectedBasePriceHistory(prices),
      lifecycleStatus: lifecycle([
        make,
        model,
        generation,
        phase,
        modelYear,
        powertrain,
        variant,
        trim,
      ]),
      identityStatus: identity,
      holdReasons: [...new Set(holdReasons)].sort(),
      sourceEvidenceIds: [...new Set([
        ...[make, model, generation, phase, modelYear, powertrain, variant, trim]
          .flatMap((item) => item?.sourceEvidenceIds ?? []),
        ...prices.flatMap((price) => price.sourceEvidenceIds),
      ])].sort(),
    });
  }

  return records;
}
