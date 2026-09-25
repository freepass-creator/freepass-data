import { createFirestoreVehicleMasterStore } from '../infra/vehicle-master-firestore-store.js';
import { loadNormalizedVehicleMasterTrimRecords } from '../application/vehicle-master-normalized-loader.js';
import { reconcileVehicleMasterTrimFacts } from '../application/vehicle-master-reconcile.js';
import { buildVehicleMasterTrimProposalSet } from '../application/vehicle-master-canonical-builder.js';
import { buildVehicleMasterOptionProposalSet } from '../application/vehicle-master-option-builder.js';
import { buildVehicleMasterBaseItemProposalSet } from '../application/vehicle-master-base-item-builder.js';
import { promoteVehicleMasterTrimProposalSet } from '../application/vehicle-master-promote-chain.js';
import { promoteVehicleMasterOptionProposalSet } from '../application/vehicle-master-option-promote.js';
import { promoteVehicleMasterBaseItemProposalSet } from '../application/vehicle-master-base-item-promote.js';
import {
  evaluateVehicleMasterEvidence,
  evaluateVehicleMasterPriceEvidence,
  evaluateVehicleMasterRuleEvidence,
} from '../application/vehicle-master-ingestion.js';
import type { VehicleMasterCanonicalProposalUnit } from '../application/vehicle-master-canonical-builder.js';
import type {
  VehicleMasterCompatibilityRule,
  VehicleMasterNode,
  VehicleMasterPriceRevision,
} from '../domain/vehicle-master.js';

type PromotionRequest = {
  approval: 'PROMOTE_CANONICAL';
  sourceDocumentIds: string[];
  anchor: {
    makeId: string;
    modelId: string;
    generationId: string;
    phaseId: string;
  };
  selector: {
    modelYear: number;
    trimName: string;
    powertrainName?: string;
    seats?: number;
    drivetrain?: string;
    basePrice?: number;
  };
};

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`VEHICLE_MASTER_PROMOTION_INVALID:${field}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`VEHICLE_MASTER_PROMOTION_INVALID:${field}`);
  }
  return value.trim();
}

function parseRequest(raw: string | undefined): PromotionRequest {
  if (!raw) throw new Error('VEHICLE_MASTER_PROMOTION_JSON is required');
  const root = object(JSON.parse(raw), 'root');
  if (root.approval !== 'PROMOTE_CANONICAL') {
    throw new Error('VEHICLE_MASTER_PROMOTION_APPROVAL_REQUIRED');
  }
  if (!Array.isArray(root.sourceDocumentIds) || root.sourceDocumentIds.length === 0) {
    throw new Error('VEHICLE_MASTER_PROMOTION_SOURCE_DOCUMENTS_REQUIRED');
  }
  const anchor = object(root.anchor, 'anchor');
  const selector = object(root.selector, 'selector');
  if (!Number.isInteger(selector.modelYear)) {
    throw new Error('VEHICLE_MASTER_PROMOTION_INVALID:selector.modelYear');
  }

  const request: PromotionRequest = {
    approval: 'PROMOTE_CANONICAL',
    sourceDocumentIds: root.sourceDocumentIds.map((value, index) =>
      text(value, `sourceDocumentIds[${index}]`)
    ),
    anchor: {
      makeId: text(anchor.makeId, 'anchor.makeId'),
      modelId: text(anchor.modelId, 'anchor.modelId'),
      generationId: text(anchor.generationId, 'anchor.generationId'),
      phaseId: text(anchor.phaseId, 'anchor.phaseId'),
    },
    selector: {
      modelYear: Number(selector.modelYear),
      trimName: text(selector.trimName, 'selector.trimName'),
    },
  };
  if (typeof selector.powertrainName === 'string') request.selector.powertrainName = selector.powertrainName.trim();
  if (Number.isInteger(selector.seats)) request.selector.seats = Number(selector.seats);
  if (typeof selector.drivetrain === 'string') request.selector.drivetrain = selector.drivetrain.trim();
  if (Number.isSafeInteger(selector.basePrice)) request.selector.basePrice = Number(selector.basePrice);
  return request;
}

function normalized(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '').trim();
}

function matchesSelector(
  row: ReturnType<typeof reconcileVehicleMasterTrimFacts>[number],
  selector: PromotionRequest['selector']
) {
  if (row.modelYear !== selector.modelYear) return false;
  if (normalized(row.trimName) !== normalized(selector.trimName)) return false;
  if (
    selector.powertrainName &&
    normalized(row.powertrainName) !== normalized(selector.powertrainName)
  ) return false;
  if (selector.seats !== undefined && row.seats !== selector.seats) return false;
  if (selector.drivetrain && row.drivetrain !== selector.drivetrain) return false;
  if (selector.basePrice !== undefined && row.basePrice !== selector.basePrice) return false;
  return true;
}

async function assertAnchor(
  store: Awaited<ReturnType<typeof createFirestoreVehicleMasterStore>>,
  request: PromotionRequest
) {
  const expected = [
    ['makeId', request.anchor.makeId, 'MAKE'],
    ['modelId', request.anchor.modelId, 'MODEL'],
    ['generationId', request.anchor.generationId, 'GENERATION'],
    ['phaseId', request.anchor.phaseId, 'PHASE'],
  ] as const;
  for (const [field, id, nodeType] of expected) {
    const node = await store.getNode(id);
    if (!node) throw new Error(`VEHICLE_MASTER_PROMOTION_ANCHOR_MISSING:${field}:${id}`);
    if (node.nodeType !== nodeType) {
      throw new Error(`VEHICLE_MASTER_PROMOTION_ANCHOR_TYPE:${field}:${node.nodeType}`);
    }
  }
}

async function preflightNode(
  store: Awaited<ReturnType<typeof createFirestoreVehicleMasterStore>>,
  unit: VehicleMasterCanonicalProposalUnit<VehicleMasterNode>
) {
  const decision = await evaluateVehicleMasterEvidence(store, {
    proposal: unit.record,
    observations: unit.observations,
    policy: unit.policy,
    observedAt: unit.record.updatedAt,
  });
  if (decision.status !== 'APPROVED') {
    throw new Error(`VEHICLE_MASTER_PROMOTION_HOLD:NODE:${unit.record.id}:${decision.issues.map((issue) => issue.code).join(',')}`);
  }
}

async function preflightPrice(
  store: Awaited<ReturnType<typeof createFirestoreVehicleMasterStore>>,
  unit: VehicleMasterCanonicalProposalUnit<VehicleMasterPriceRevision>
) {
  const decision = await evaluateVehicleMasterPriceEvidence(store, {
    proposal: unit.record,
    observations: unit.observations,
    policy: unit.policy,
    observedAt: unit.record.updatedAt,
  });
  if (decision.status !== 'APPROVED') {
    throw new Error(`VEHICLE_MASTER_PROMOTION_HOLD:PRICE:${unit.record.id}:${decision.issues.map((issue) => issue.code).join(',')}`);
  }
}

async function preflightRule(
  store: Awaited<ReturnType<typeof createFirestoreVehicleMasterStore>>,
  unit: VehicleMasterCanonicalProposalUnit<VehicleMasterCompatibilityRule>
) {
  const decision = await evaluateVehicleMasterRuleEvidence(store, {
    proposal: unit.record,
    observations: unit.observations,
    policy: unit.policy,
    observedAt: unit.record.updatedAt,
  });
  if (decision.status !== 'APPROVED') {
    throw new Error(`VEHICLE_MASTER_PROMOTION_HOLD:RULE:${unit.record.id}:${decision.issues.map((issue) => issue.code).join(',')}`);
  }
}

const request = parseRequest(process.env.VEHICLE_MASTER_PROMOTION_JSON);
if (process.env.VEHICLE_MASTER_PROMOTION_APPROVED !== 'true') {
  throw new Error('VEHICLE_MASTER_PROMOTION_APPROVED=true is required');
}

const store = createFirestoreVehicleMasterStore();
await assertAnchor(store, request);

const normalizedRows = await loadNormalizedVehicleMasterTrimRecords(
  store,
  request.sourceDocumentIds
);
const reconciled = reconcileVehicleMasterTrimFacts(normalizedRows)
  .filter((row) => matchesSelector(row, request.selector));

if (reconciled.length !== 1) {
  throw new Error(`VEHICLE_MASTER_PROMOTION_SELECTOR_MATCH_COUNT:${reconciled.length}`);
}
const selected = reconciled[0]!;
if (selected.conflicts.length || selected.seats === null || selected.drivetrain === null) {
  throw new Error('VEHICLE_MASTER_PROMOTION_STRUCTURAL_HOLD');
}

const observedAt = new Date().toISOString();
const trimSet = buildVehicleMasterTrimProposalSet({
  anchor: request.anchor,
  reconciled: selected,
  observedAt,
});
const optionSet = buildVehicleMasterOptionProposalSet({
  reconciled: selected,
  trimProposalSet: trimSet,
  observedAt,
});
const baseItemSet = buildVehicleMasterBaseItemProposalSet({
  reconciled: selected,
  trimProposalSet: trimSet,
  observedAt,
});

if (optionSet.unresolvedConditions.length) {
  throw new Error(
    `VEHICLE_MASTER_PROMOTION_UNRESOLVED_OPTION_RULES:${optionSet.unresolvedConditions.length}`
  );
}

await preflightNode(store, trimSet.modelYear);
await preflightNode(store, trimSet.powertrain);
await preflightNode(store, trimSet.variant);
await preflightNode(store, trimSet.trim);
await preflightPrice(store, trimSet.basePrice);
for (const option of optionSet.options) {
  await preflightNode(store, option.node);
  if (option.price) await preflightPrice(store, option.price);
  await preflightRule(store, option.availability);
  for (const dependency of option.dependencies) await preflightRule(store, dependency);
}
for (const item of baseItemSet.items) {
  await preflightNode(store, item.node);
  await preflightRule(store, item.inclusion);
}

const trimResult = await promoteVehicleMasterTrimProposalSet(store, trimSet);
const optionResult = await promoteVehicleMasterOptionProposalSet(store, optionSet);
const baseItemResult = await promoteVehicleMasterBaseItemProposalSet(store, baseItemSet);

process.stdout.write(JSON.stringify({
  status: 'PROMOTED',
  selector: request.selector,
  sourceDocumentIds: request.sourceDocumentIds,
  trimId: trimSet.trim.record.id,
  trim: {
    modelYear: trimResult.modelYear.canonicalWrite,
    powertrain: trimResult.powertrain.canonicalWrite,
    variant: trimResult.variant.canonicalWrite,
    trim: trimResult.trim.canonicalWrite,
    basePrice: trimResult.basePrice.canonicalWrite,
  },
  options: {
    count: optionResult.options.length,
    structuralSelections: optionResult.structuralSelections,
    unresolvedConditions: optionResult.unresolvedConditions,
  },
  baseItems: {
    count: baseItemResult.items.length,
  },
}, null, 2) + '\n');
