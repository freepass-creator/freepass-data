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
  return Number.isInteger(value) ? Number(value) : null;
}

function lifecycle(status: VehicleMasterNode['status']): UsedcarMasterLifecycleStatus {
  if (status === 'ACTIVE') return 'CURRENT';
  if (status === 'HISTORICAL') return 'HISTORICAL';
  if (status === 'DISCONTINUED') return 'DISCONTINUED';
  return 'HOLD';
}

function identityStatus(
  ids: Array<string | null>,
  trimStatus: VehicleMasterNode['status'],
  modelYear: number | null
): UsedcarMasterIdentityStatus {
  if (trimStatus === 'HOLD') return 'HOLD';
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
    const requiredNodes: Array<[string, VehicleMasterNode | null]> = [
      ['MAKE_NOT_FOUND', make],
      ['MODEL_NOT_FOUND', model],
      ['GENERATION_NOT_FOUND', generation],
      ['PHASE_NOT_FOUND', phase],
      ['MODEL_YEAR_NOT_FOUND', modelYear],
      ['POWERTRAIN_NOT_FOUND', powertrain],
      ['VARIANT_NOT_FOUND', variant],
    ];
    for (const [reason, value] of requiredNodes) {
      if (!value) holdReasons.push(reason);
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

    const identity = identityStatus(stableIds, trim.status, modelYearValue);
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
      originalBasePriceHistory: prices.map((price) => ({
        priceRevisionId: price.id,
        amount: price.amount,
        currency: price.currency,
        effectiveFrom: price.effectiveFrom ?? null,
        effectiveTo: price.effectiveTo ?? null,
        sourceDocumentIds: [...price.sourceDocumentIds],
      })),
      lifecycleStatus: lifecycle(trim.status),
      identityStatus: identity,
      holdReasons: [...new Set(holdReasons)].sort(),
      sourceEvidenceIds: [...new Set([
        ...trim.sourceEvidenceIds,
        ...prices.flatMap((price) => price.sourceEvidenceIds),
      ])].sort(),
    });
  }

  return records;
}
