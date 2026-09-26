import { stableDigest } from '../shared/stable-digest.js';
import {
  deterministicVehicleMasterRecordId,
  sealVehicleMasterPipelineRecord,
  type VehicleMasterCompatibilityRule,
  type VehicleMasterNode,
  type VehicleMasterPipelineRecord,
  type VehicleMasterPriceRevision,
  type VehicleMasterSourceDocument,
  type VehicleMasterWriteResult,
} from '../domain/vehicle-master.js';
import {
  canonicalDrivetrain,
  canonicalPowertrainIdentity,
  canonicalSeatCount,
  canonicalTrimIdentity,
  inferPowertrainFuelType,
  inferVariantFacts,
} from '../domain/vehicle-master-normalization.js';
import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';

export type VehicleMasterFieldObservation = {
  fieldPath: string;
  value: unknown;
  sourceDocumentId: string;
};

export type VehicleMasterEvidencePolicy = {
  requiredFieldPaths: string[];
  minCorroboratingSourcesWithoutOfficial: number;
};

export type VehicleMasterEvidenceIssue = {
  code:
    | 'FIELD_EVIDENCE_MISSING'
    | 'FIELD_EVIDENCE_CONFLICT'
    | 'FIELD_VALUE_MISMATCH'
    | 'SOURCE_DOCUMENT_MISSING'
    | 'SOURCE_EFFECTIVE_PERIOD_MISMATCH'
    | 'SOURCE_AUTHORITY_INSUFFICIENT'
    | 'PARENT_NODE_MISSING'
    | 'PARENT_NODE_HOLD'
    | 'PARENT_EFFECTIVE_RANGE_MISMATCH'
    | 'PARENT_REFERENCE_MISMATCH'
    | 'PHASE_EFFECTIVE_RANGE_OVERLAP'
    | 'MODEL_YEAR_VALUE_INVALID'
    | 'MODEL_YEAR_NAME_MISMATCH'
    | 'MODEL_YEAR_ALIAS_MISMATCH'
    | 'MODEL_YEAR_DUPLICATE_IN_PHASE'
    | 'POWERTRAIN_IDENTITY_MISMATCH'
    | 'POWERTRAIN_FUEL_TYPE_MISMATCH'
    | 'POWERTRAIN_DUPLICATE_IN_MODEL_YEAR'
    | 'TRIM_IDENTITY_MISMATCH'
    | 'TRIM_DUPLICATE_IN_VARIANT'
    | 'VARIANT_SEATS_INVALID'
    | 'VARIANT_DRIVETRAIN_INVALID'
    | 'VARIANT_NAME_SEATS_MISMATCH'
    | 'VARIANT_NAME_DRIVETRAIN_MISMATCH'
    | 'VARIANT_DUPLICATE_IN_POWERTRAIN'
    | 'REFERENCE_NODE_MISSING'
    | 'REFERENCE_NODE_HOLD'
    | 'REFERENCE_EFFECTIVE_RANGE_MISMATCH'
    | 'REFERENCE_NODE_SELF'
    | 'PRICE_TARGET_MISSING'
    | 'PRICE_TARGET_HOLD'
    | 'PRICE_TARGET_EFFECTIVE_RANGE_MISMATCH'
    | 'PRICE_EFFECTIVE_FROM_REQUIRED_FOR_HISTORY'
    | 'PRICE_EFFECTIVE_START_CONFLICT'
    | 'PRICE_EXPLICIT_RANGE_OVERLAP'
    | 'RULE_SUBJECT_MISSING'
    | 'RULE_TARGET_MISSING'
    | 'RULE_SCOPE_REFERENCE_MISSING';
  fieldPath?: string;
  sourceDocumentId?: string;
  detail?: string;
};

export type VehicleMasterEvidenceDecision = {
  status: 'APPROVED' | 'HOLD';
  issues: VehicleMasterEvidenceIssue[];
  evidenceDocumentIds: string[];
  authorityScore: number;
};

export type PromoteVehicleMasterNodeInput = {
  proposal: VehicleMasterNode;
  observations: VehicleMasterFieldObservation[];
  policy: VehicleMasterEvidencePolicy;
  observedAt: string;
};

export type PromoteVehicleMasterRuleInput = {
  proposal: VehicleMasterCompatibilityRule;
  observations: VehicleMasterFieldObservation[];
  policy: VehicleMasterEvidencePolicy;
  observedAt: string;
};

export type PromoteVehicleMasterPriceInput = {
  proposal: VehicleMasterPriceRevision;
  observations: VehicleMasterFieldObservation[];
  policy: VehicleMasterEvidencePolicy;
  observedAt: string;
};

export type PromoteVehicleMasterNodeResult = {
  decision: VehicleMasterEvidenceDecision;
  canonicalWrite: VehicleMasterWriteResult | null;
  candidateFactId: string;
  evidenceSetId: string;
  revisionCandidateId: string;
  promotionResultId: string;
  changeEventId: string | null;
};

export type PromoteVehicleMasterRuleResult = PromoteVehicleMasterNodeResult;
export type PromoteVehicleMasterPriceResult = PromoteVehicleMasterNodeResult;

const SOURCE_AUTHORITY: Record<VehicleMasterSourceDocument['sourceType'], number> = {
  MANUFACTURER_OFFICIAL: 100,
  PUBLIC_CERTIFIED: 90,
  STRUCTURED_PROVIDER: 80,
  DANAWA: 70,
  CARNOON: 70,
  CARISYOU: 70,
  WIKICAR: 40,
  MARKET_LISTING: 30,
  MANUAL: 20,
  OTHER: 10,
};

const CORROBORATING_SOURCE_TYPES = new Set<VehicleMasterSourceDocument['sourceType']>([
  'MANUFACTURER_OFFICIAL',
  'PUBLIC_CERTIFIED',
  'STRUCTURED_PROVIDER',
  'DANAWA',
  'CARNOON',
  'CARISYOU',
]);


function sourceOriginKey(source: VehicleMasterSourceDocument) {
  if (
    source.sourceType !== 'STRUCTURED_PROVIDER' &&
    source.sourceType !== 'PUBLIC_CERTIFIED' &&
    source.sourceType !== 'OTHER'
  ) {
    return source.sourceType;
  }
  if (source.sourceUrl) {
    try {
      return `${source.sourceType}:${new URL(source.sourceUrl).hostname.toLowerCase()}`;
    } catch {
      // fall through to the persisted source name
    }
  }
  return `${source.sourceType}:${source.sourceName.trim().toLowerCase()}`;
}

type TemporalTarget = {
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};

const time = (value?: string | null) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function temporalCompatible(source: VehicleMasterSourceDocument, target: TemporalTarget) {
  const sourceFrom = time(source.effectiveFrom);
  const sourceTo = time(source.effectiveTo);
  const targetFrom = time(target.effectiveFrom);
  const targetTo = time(target.effectiveTo);

  if (sourceFrom !== null && targetTo !== null && sourceFrom >= targetTo) return false;
  if (targetFrom !== null && sourceTo !== null && targetFrom >= sourceTo) return false;
  return true;
}

function temporalContains(container: TemporalTarget, child: TemporalTarget) {
  const containerFrom = time(container.effectiveFrom) ?? Number.NEGATIVE_INFINITY;
  const containerTo = time(container.effectiveTo) ?? Number.POSITIVE_INFINITY;
  const childFrom = time(child.effectiveFrom) ?? Number.NEGATIVE_INFINITY;
  const childTo = time(child.effectiveTo) ?? Number.POSITIVE_INFINITY;

  return childFrom >= containerFrom && childTo <= containerTo;
}

function explicitTemporalOverlap(a: TemporalTarget, b: TemporalTarget) {
  const aFrom = time(a.effectiveFrom);
  const aTo = time(a.effectiveTo);
  const bFrom = time(b.effectiveFrom);
  const bTo = time(b.effectiveTo);

  if (aFrom === null || bFrom === null) return false;
  if (aTo !== null && bFrom < aTo && bFrom >= aFrom) return true;
  if (bTo !== null && aFrom < bTo && aFrom >= bFrom) return true;
  return false;
}

function expectedParentRef(proposal: VehicleMasterNode): string | null {
  switch (proposal.nodeType) {
    case 'MODEL': return proposal.refs.makeId ?? null;
    case 'GENERATION': return proposal.refs.modelId ?? null;
    case 'PHASE': return proposal.refs.generationId ?? null;
    case 'MODEL_YEAR': return proposal.refs.phaseId ?? null;
    case 'POWERTRAIN': return proposal.refs.modelYearId ?? null;
    case 'VARIANT': return proposal.refs.powertrainId ?? null;
    case 'TRIM': return proposal.refs.variantId ?? null;
    default: return null;
  }
}

function modelYearValue(proposal: VehicleMasterNode): number | null {
  const value = proposal.attributes.modelYear;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1900 &&
    value <= 2200
    ? value
    : null;
}

function explicitModelYearLabel(value: string): number | null {
  const normalized = value.normalize('NFKC').trim();
  const match = normalized.match(/^(19|20|21|22)\d{2}(?:년형|MY)?$/i);
  return match ? Number(normalized.slice(0, 4)) : null;
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function sameValue(a: unknown, b: unknown) {
  return stableDigest(a) === stableDigest(b);
}

async function evaluateEvidence(
  store: VehicleMasterStore,
  target: unknown,
  temporalTarget: TemporalTarget,
  observations: VehicleMasterFieldObservation[],
  policy: VehicleMasterEvidencePolicy
): Promise<VehicleMasterEvidenceDecision> {
  const issues: VehicleMasterEvidenceIssue[] = [];
  const sourceIds = [...new Set(observations.map((item) => item.sourceDocumentId))].sort();
  const sourceEntries = await Promise.all(
    sourceIds.map(async (sourceDocumentId) => ({
      sourceDocumentId,
      source: await store.getSourceDocument(sourceDocumentId),
    }))
  );
  const sources = new Map<string, VehicleMasterSourceDocument>();

  for (const entry of sourceEntries) {
    if (!entry.source) {
      issues.push({
        code: 'SOURCE_DOCUMENT_MISSING',
        sourceDocumentId: entry.sourceDocumentId,
      });
      continue;
    }
    sources.set(entry.sourceDocumentId, entry.source);
    if (!temporalCompatible(entry.source, temporalTarget)) {
      issues.push({
        code: 'SOURCE_EFFECTIVE_PERIOD_MISMATCH',
        sourceDocumentId: entry.sourceDocumentId,
      });
    }
  }

  for (const fieldPath of policy.requiredFieldPaths) {
    const fieldObservations = observations.filter((item) => item.fieldPath === fieldPath);
    if (!fieldObservations.length) {
      issues.push({ code: 'FIELD_EVIDENCE_MISSING', fieldPath });
      continue;
    }

    const distinctValues = new Map<string, unknown>();
    for (const observation of fieldObservations) {
      distinctValues.set(stableDigest(observation.value), observation.value);
    }
    if (distinctValues.size > 1) {
      issues.push({
        code: 'FIELD_EVIDENCE_CONFLICT',
        fieldPath,
        detail: [...distinctValues.keys()].sort().join(','),
      });
      continue;
    }

    const observedValue = fieldObservations[0]?.value;
    const targetValue = valueAtPath(target, fieldPath);
    if (!sameValue(observedValue, targetValue)) {
      issues.push({
        code: 'FIELD_VALUE_MISMATCH',
        fieldPath,
        detail: stableDigest({ observedValue, targetValue }),
      });
      continue;
    }

    const fieldSources = [...new Set(fieldObservations.map((item) => item.sourceDocumentId))]
      .map((sourceId) => sources.get(sourceId))
      .filter((source): source is VehicleMasterSourceDocument => Boolean(source));

    const hasOfficial = fieldSources.some(
      (source) => source.sourceType === 'MANUFACTURER_OFFICIAL'
    );
    const corroboratingCount = new Set(
      fieldSources
        .filter((source) => CORROBORATING_SOURCE_TYPES.has(source.sourceType))
        .map(sourceOriginKey)
    ).size;

    if (
      !hasOfficial &&
      corroboratingCount < policy.minCorroboratingSourcesWithoutOfficial
    ) {
      issues.push({
        code: 'SOURCE_AUTHORITY_INSUFFICIENT',
        fieldPath,
        detail: `corroborating=${corroboratingCount}`,
      });
    }
  }

  const authorityScore = [...sources.values()].reduce(
    (max, source) => Math.max(max, SOURCE_AUTHORITY[source.sourceType]),
    0
  );

  return {
    status: issues.length ? 'HOLD' : 'APPROVED',
    issues,
    evidenceDocumentIds: [...sources.keys()].sort(),
    authorityScore,
  };
}

export async function evaluateVehicleMasterEvidence(
  store: VehicleMasterStore,
  input: PromoteVehicleMasterNodeInput
): Promise<VehicleMasterEvidenceDecision> {
  return evaluateEvidence(store, input.proposal, input.proposal, input.observations, input.policy);
}

export async function evaluateVehicleMasterRuleEvidence(
  store: VehicleMasterStore,
  input: PromoteVehicleMasterRuleInput
): Promise<VehicleMasterEvidenceDecision> {
  return evaluateEvidence(store, input.proposal, input.proposal, input.observations, input.policy);
}

export async function evaluateVehicleMasterPriceEvidence(
  store: VehicleMasterStore,
  input: PromoteVehicleMasterPriceInput
): Promise<VehicleMasterEvidenceDecision> {
  return evaluateEvidence(store, input.proposal, input.proposal, input.observations, input.policy);
}


async function applyNodeReferenceGate(
  store: VehicleMasterStore,
  proposal: VehicleMasterNode,
  decision: VehicleMasterEvidenceDecision
): Promise<VehicleMasterEvidenceDecision> {
  const issues = [...decision.issues];
  const expectedParent = expectedParentRef(proposal);

  if (
    proposal.parentId &&
    expectedParent &&
    proposal.parentId !== expectedParent
  ) {
    issues.push({
      code: 'PARENT_REFERENCE_MISMATCH',
      fieldPath: 'parentId',
      detail: `${proposal.parentId}!=${expectedParent}`,
    });
  }

  if (proposal.parentId) {
    if (proposal.parentId === proposal.id) {
      issues.push({
        code: 'REFERENCE_NODE_SELF',
        fieldPath: 'parentId',
        detail: proposal.parentId,
      });
    } else {
      const parent = await store.getNode(proposal.parentId);
      if (!parent) {
        issues.push({
          code: 'PARENT_NODE_MISSING',
          fieldPath: 'parentId',
          detail: proposal.parentId,
        });
      } else {
        if (proposal.status !== 'HOLD' && parent.status === 'HOLD') {
          issues.push({
            code: 'PARENT_NODE_HOLD',
            fieldPath: 'parentId',
            detail: proposal.parentId,
          });
        }
        if (!temporalContains(parent, proposal)) {
          issues.push({
            code: 'PARENT_EFFECTIVE_RANGE_MISMATCH',
            fieldPath: 'parentId',
            detail: proposal.parentId,
          });
        }
      }
    }
  }

  const refs = Object.entries(proposal.refs)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [field, refId] of refs) {
    if (refId === proposal.id) {
      issues.push({
        code: 'REFERENCE_NODE_SELF',
        fieldPath: `refs.${field}`,
        detail: refId,
      });
      continue;
    }
    const referenced = await store.getNode(refId);
    if (!referenced) {
      issues.push({
        code: 'REFERENCE_NODE_MISSING',
        fieldPath: `refs.${field}`,
        detail: refId,
      });
    } else {
      if (proposal.status !== 'HOLD' && referenced.status === 'HOLD') {
        issues.push({
          code: 'REFERENCE_NODE_HOLD',
          fieldPath: `refs.${field}`,
          detail: refId,
        });
      }
      if (!temporalContains(referenced, proposal)) {
        issues.push({
          code: 'REFERENCE_EFFECTIVE_RANGE_MISMATCH',
          fieldPath: `refs.${field}`,
          detail: refId,
        });
      }
    }
  }

  if (proposal.nodeType === 'MODEL_YEAR') {
    const year = modelYearValue(proposal);
    if (year === null) {
      issues.push({
        code: 'MODEL_YEAR_VALUE_INVALID',
        fieldPath: 'attributes.modelYear',
      });
    } else {
      const nameYear = explicitModelYearLabel(proposal.canonicalName);
      if (nameYear !== null && nameYear !== year) {
        issues.push({
          code: 'MODEL_YEAR_NAME_MISMATCH',
          fieldPath: 'canonicalName',
          detail: `${nameYear}!=${year}`,
        });
      }

      for (const alias of proposal.aliases) {
        const aliasYear = explicitModelYearLabel(alias);
        if (aliasYear !== null && aliasYear !== year) {
          issues.push({
            code: 'MODEL_YEAR_ALIAS_MISMATCH',
            fieldPath: 'aliases',
            detail: `${alias}!=${year}`,
          });
        }
      }

      if (proposal.parentId) {
        const siblings = (await store.listNodesByType('MODEL_YEAR'))
          .filter((node) =>
            node.id !== proposal.id &&
            node.parentId === proposal.parentId &&
            node.status !== 'HOLD'
          );

        for (const sibling of siblings) {
          if (modelYearValue(sibling) === year) {
            issues.push({
              code: 'MODEL_YEAR_DUPLICATE_IN_PHASE',
              fieldPath: 'attributes.modelYear',
              detail: sibling.id,
            });
          }
        }
      }
    }
  }

  if (proposal.nodeType === 'POWERTRAIN') {
    const expectedIdentity = canonicalPowertrainIdentity(proposal.canonicalName);
    const storedIdentity =
      typeof proposal.attributes.identityKey === 'string'
        ? proposal.attributes.identityKey.trim()
        : '';

    if (!storedIdentity || storedIdentity !== expectedIdentity) {
      issues.push({
        code: 'POWERTRAIN_IDENTITY_MISMATCH',
        fieldPath: 'attributes.identityKey',
        detail: `${storedIdentity || 'MISSING'}!=${expectedIdentity}`,
      });
    }

    const inferredFuelType = inferPowertrainFuelType(proposal.canonicalName);
    const storedFuelType =
      typeof proposal.attributes.fuelType === 'string'
        ? proposal.attributes.fuelType.trim().toUpperCase()
        : null;

    if (inferredFuelType && storedFuelType !== inferredFuelType) {
      issues.push({
        code: 'POWERTRAIN_FUEL_TYPE_MISMATCH',
        fieldPath: 'attributes.fuelType',
        detail: `${storedFuelType ?? 'MISSING'}!=${inferredFuelType}`,
      });
    }

    if (proposal.parentId) {
      const siblings = (await store.listNodesByType('POWERTRAIN'))
        .filter((node) =>
          node.id !== proposal.id &&
          node.parentId === proposal.parentId &&
          node.status !== 'HOLD'
        );

      for (const sibling of siblings) {
        if (canonicalPowertrainIdentity(sibling.canonicalName) === expectedIdentity) {
          issues.push({
            code: 'POWERTRAIN_DUPLICATE_IN_MODEL_YEAR',
            fieldPath: 'canonicalName',
            detail: sibling.id,
          });
        }
      }
    }
  }

  if (proposal.nodeType === 'TRIM') {
    const expectedIdentity = canonicalTrimIdentity(proposal.canonicalName);
    const storedIdentity =
      typeof proposal.attributes.identityKey === 'string'
        ? proposal.attributes.identityKey.trim()
        : '';

    if (!storedIdentity || storedIdentity !== expectedIdentity) {
      issues.push({
        code: 'TRIM_IDENTITY_MISMATCH',
        fieldPath: 'attributes.identityKey',
        detail: `${storedIdentity || 'MISSING'}!=${expectedIdentity}`,
      });
    }

    if (proposal.parentId) {
      const proposalNames = new Set(
        [proposal.canonicalName, ...proposal.aliases]
          .map(canonicalTrimIdentity)
          .filter(Boolean)
      );
      const siblings = (await store.listNodesByType('TRIM'))
        .filter((node) =>
          node.id !== proposal.id &&
          node.parentId === proposal.parentId &&
          node.status !== 'HOLD'
        );

      for (const sibling of siblings) {
        const siblingNames = new Set(
          [sibling.canonicalName, ...sibling.aliases]
            .map(canonicalTrimIdentity)
            .filter(Boolean)
        );
        if ([...proposalNames].some((name) => siblingNames.has(name))) {
          issues.push({
            code: 'TRIM_DUPLICATE_IN_VARIANT',
            fieldPath: 'canonicalName',
            detail: sibling.id,
          });
        }
      }
    }
  }

  if (proposal.nodeType === 'VARIANT') {
    const seats = canonicalSeatCount(proposal.attributes.seats);
    const drivetrain =
      typeof proposal.attributes.drivetrain === 'string'
        ? canonicalDrivetrain(proposal.attributes.drivetrain)
        : null;

    if (seats === null) {
      issues.push({
        code: 'VARIANT_SEATS_INVALID',
        fieldPath: 'attributes.seats',
      });
    }
    if (drivetrain === null) {
      issues.push({
        code: 'VARIANT_DRIVETRAIN_INVALID',
        fieldPath: 'attributes.drivetrain',
      });
    }

    const labelFacts = inferVariantFacts(proposal.canonicalName);
    if (labelFacts.seats !== null && seats !== null && labelFacts.seats !== seats) {
      issues.push({
        code: 'VARIANT_NAME_SEATS_MISMATCH',
        fieldPath: 'canonicalName',
        detail: `${labelFacts.seats}!=${seats}`,
      });
    }
    if (
      labelFacts.drivetrain !== null &&
      drivetrain !== null &&
      labelFacts.drivetrain !== drivetrain
    ) {
      issues.push({
        code: 'VARIANT_NAME_DRIVETRAIN_MISMATCH',
        fieldPath: 'canonicalName',
        detail: `${labelFacts.drivetrain}!=${drivetrain}`,
      });
    }

    if (proposal.parentId && seats !== null && drivetrain !== null) {
      const siblings = (await store.listNodesByType('VARIANT'))
        .filter((node) =>
          node.id !== proposal.id &&
          node.parentId === proposal.parentId &&
          node.status !== 'HOLD'
        );

      for (const sibling of siblings) {
        const siblingSeats = canonicalSeatCount(sibling.attributes.seats);
        const siblingDrivetrain =
          typeof sibling.attributes.drivetrain === 'string'
            ? canonicalDrivetrain(sibling.attributes.drivetrain)
            : null;
        if (siblingSeats === seats && siblingDrivetrain === drivetrain) {
          issues.push({
            code: 'VARIANT_DUPLICATE_IN_POWERTRAIN',
            fieldPath: 'attributes',
            detail: sibling.id,
          });
        }
      }
    }
  }

  if (proposal.nodeType === 'PHASE' && proposal.parentId) {
    const siblings = (await store.listNodesByType('PHASE'))
      .filter((node) =>
        node.id !== proposal.id &&
        node.parentId === proposal.parentId &&
        node.status !== 'HOLD'
      );

    for (const sibling of siblings) {
      if (explicitTemporalOverlap(sibling, proposal)) {
        issues.push({
          code: 'PHASE_EFFECTIVE_RANGE_OVERLAP',
          fieldPath: 'effectiveFrom',
          detail: sibling.id,
        });
      }
    }
  }

  return {
    ...decision,
    status: issues.length ? 'HOLD' : 'APPROVED',
    issues,
  };
}

function pipelineRecord(
  kind: VehicleMasterPipelineRecord['kind'],
  identity: Record<string, unknown>,
  observedAt: string,
  entityId: string,
  payload: Record<string, unknown>
) {
  return sealVehicleMasterPipelineRecord({
    recordId: deterministicVehicleMasterRecordId(kind.toLowerCase(), identity),
    kind,
    entityId,
    observedAt,
    payload,
  });
}

async function putOutcomeRecordOnce(
  store: VehicleMasterStore,
  record: VehicleMasterPipelineRecord
): Promise<VehicleMasterPipelineRecord> {
  const existing = await store.getPipelineRecord(record.kind, record.recordId);
  if (existing) return existing;
  await store.putPipelineRecord(record);
  return record;
}

async function persistPromotionEvidence(
  store: VehicleMasterStore,
  input: {
    entityKind: 'NODE' | 'PRICE';
    entityId: string;
    revision: number;
    proposalHash: string;
    observations: VehicleMasterFieldObservation[];
    observedAt: string;
    decision: VehicleMasterEvidenceDecision;
    candidatePayload: Record<string, unknown>;
  }
) {
  // The immutable candidate payload and its identity must use the same order.
  // Value digest breaks ties without discarding contradictory observations.
  const canonicalObservations = [...input.observations].sort((a, b) =>
    a.fieldPath.localeCompare(b.fieldPath) ||
    a.sourceDocumentId.localeCompare(b.sourceDocumentId) ||
    stableDigest(a.value).localeCompare(stableDigest(b.value))
  );
  const observationDigest = stableDigest(canonicalObservations);
  const identity = {
    entityKind: input.entityKind,
    entityId: input.entityId,
    revision: input.revision,
    proposalHash: input.proposalHash,
    observationDigest,
  };

  const candidateFact = pipelineRecord(
    'CANDIDATE_FACT',
    identity,
    input.observedAt,
    input.entityId,
    { ...input.candidatePayload, observations: canonicalObservations }
  );
  await store.putPipelineRecord(candidateFact);

  const evidenceSet = pipelineRecord(
    'EVIDENCE_SET',
    identity,
    input.observedAt,
    input.entityId,
    {
      evidenceDocumentIds: input.decision.evidenceDocumentIds,
      authorityScore: input.decision.authorityScore,
      decisionStatus: input.decision.status,
      issues: input.decision.issues,
    }
  );
  await store.putPipelineRecord(evidenceSet);

  const revisionCandidate = pipelineRecord(
    'REVISION_CANDIDATE',
    identity,
    input.observedAt,
    input.entityId,
    {
      revision: input.revision,
      proposalHash: input.proposalHash,
      evidenceSetId: evidenceSet.recordId,
      status: input.decision.status,
    }
  );
  await store.putPipelineRecord(revisionCandidate);

  return { identity, candidateFact, evidenceSet, revisionCandidate };
}

export async function promoteVehicleMasterNode(
  store: VehicleMasterStore,
  input: PromoteVehicleMasterNodeInput
): Promise<PromoteVehicleMasterNodeResult> {
  const sourceDecision = await evaluateVehicleMasterEvidence(store, input);
  const decision = await applyNodeReferenceGate(store, input.proposal, sourceDecision);
  const evidence = await persistPromotionEvidence(store, {
    entityKind: 'NODE',
    entityId: input.proposal.id,
    revision: input.proposal.revision,
    proposalHash: input.proposal.contentHash,
    observations: input.observations,
    observedAt: input.observedAt,
    decision,
    candidatePayload: {
      proposalHash: input.proposal.contentHash,
      nodeType: input.proposal.nodeType,
      observations: input.observations,
    },
  });

  let canonicalWrite: VehicleMasterWriteResult | null = null;
  let promotionStatus: 'PROMOTED' | 'HOLD' = 'HOLD';
  if (decision.status === 'APPROVED') {
    canonicalWrite = await store.putNode(input.proposal);
    promotionStatus = 'PROMOTED';
  }

  const promotionResult = await putOutcomeRecordOnce(store, pipelineRecord(
    'PROMOTION_RESULT',
    evidence.identity,
    input.observedAt,
    input.proposal.id,
    {
      revisionCandidateId: evidence.revisionCandidate.recordId,
      status: promotionStatus,
      canonicalWrite,
      issues: decision.issues,
    }
  ));

  let changeEventId: string | null = null;
  if (promotionStatus === 'PROMOTED') {
    const changeEvent = await putOutcomeRecordOnce(store, pipelineRecord(
      'CHANGE_EVENT',
      { ...evidence.identity, promotionResultId: promotionResult.recordId },
      input.observedAt,
      input.proposal.id,
      {
        eventType:
          canonicalWrite === 'CREATED'
            ? 'VEHICLE_MASTER_CREATED'
            : canonicalWrite === 'UPDATED'
              ? 'VEHICLE_MASTER_REVISED'
              : 'VEHICLE_MASTER_CONFIRMED',
        revision: input.proposal.revision,
        canonicalWrite,
        evidenceSetId: evidence.evidenceSet.recordId,
      }
    ));
    changeEventId = changeEvent.recordId;
  }

  return {
    decision,
    canonicalWrite,
    candidateFactId: evidence.candidateFact.recordId,
    evidenceSetId: evidence.evidenceSet.recordId,
    revisionCandidateId: evidence.revisionCandidate.recordId,
    promotionResultId: promotionResult.recordId,
    changeEventId,
  };
}

export async function promoteVehicleMasterPriceRevision(
  store: VehicleMasterStore,
  input: PromoteVehicleMasterPriceInput
): Promise<PromoteVehicleMasterPriceResult> {
  const sourceDecision = await evaluateVehicleMasterPriceEvidence(store, input);
  const priceTarget = await store.getNode(input.proposal.targetId);
  const targetIssues: VehicleMasterEvidenceIssue[] = [];
  if (!priceTarget) {
    targetIssues.push({
      code: 'PRICE_TARGET_MISSING',
      fieldPath: 'targetId',
      detail: input.proposal.targetId,
    });
  } else {
    if (priceTarget.status === 'HOLD') {
      targetIssues.push({
        code: 'PRICE_TARGET_HOLD',
        fieldPath: 'targetId',
        detail: input.proposal.targetId,
      });
    }
    if (!temporalContains(priceTarget, input.proposal)) {
      targetIssues.push({
        code: 'PRICE_TARGET_EFFECTIVE_RANGE_MISMATCH',
        fieldPath: 'targetId',
        detail: input.proposal.targetId,
      });
    }
  }
  const siblingPrices = (await store.listPriceRevisionsByTarget(input.proposal.targetId))
    .filter((price) =>
      price.priceType === input.proposal.priceType &&
      price.id !== input.proposal.id
    );

  if (siblingPrices.length && !input.proposal.effectiveFrom) {
    targetIssues.push({
      code: 'PRICE_EFFECTIVE_FROM_REQUIRED_FOR_HISTORY',
      fieldPath: 'effectiveFrom',
      detail: input.proposal.targetId,
    });
  }

  for (const existing of siblingPrices) {
    if (!existing.effectiveFrom) {
      targetIssues.push({
        code: 'PRICE_EFFECTIVE_FROM_REQUIRED_FOR_HISTORY',
        fieldPath: 'effectiveFrom',
        detail: existing.id,
      });
      continue;
    }
    if (
      input.proposal.effectiveFrom &&
      existing.effectiveFrom === input.proposal.effectiveFrom
    ) {
      targetIssues.push({
        code: 'PRICE_EFFECTIVE_START_CONFLICT',
        fieldPath: 'effectiveFrom',
        detail: existing.id,
      });
      continue;
    }
    if (explicitTemporalOverlap(existing, input.proposal)) {
      targetIssues.push({
        code: 'PRICE_EXPLICIT_RANGE_OVERLAP',
        fieldPath: 'effectiveFrom',
        detail: existing.id,
      });
    }
  }

  const decision: VehicleMasterEvidenceDecision = targetIssues.length
    ? {
        ...sourceDecision,
        status: 'HOLD',
        issues: [...sourceDecision.issues, ...targetIssues],
      }
    : sourceDecision;
  const evidence = await persistPromotionEvidence(store, {
    entityKind: 'PRICE',
    entityId: input.proposal.id,
    revision: input.proposal.revision,
    proposalHash: input.proposal.contentHash,
    observations: input.observations,
    observedAt: input.observedAt,
    decision,
    candidatePayload: {
      proposalHash: input.proposal.contentHash,
      targetId: input.proposal.targetId,
      priceType: input.proposal.priceType,
      observations: input.observations,
    },
  });

  let canonicalWrite: VehicleMasterWriteResult | null = null;
  let promotionStatus: 'PROMOTED' | 'HOLD' = 'HOLD';
  if (decision.status === 'APPROVED') {
    canonicalWrite = await store.putPriceRevision(input.proposal);
    promotionStatus = 'PROMOTED';
  }

  const promotionResult = await putOutcomeRecordOnce(store, pipelineRecord(
    'PROMOTION_RESULT',
    evidence.identity,
    input.observedAt,
    input.proposal.id,
    {
      revisionCandidateId: evidence.revisionCandidate.recordId,
      status: promotionStatus,
      canonicalWrite,
      issues: decision.issues,
    }
  ));

  let changeEventId: string | null = null;
  if (promotionStatus === 'PROMOTED') {
    const changeEvent = await putOutcomeRecordOnce(store, pipelineRecord(
      'CHANGE_EVENT',
      { ...evidence.identity, promotionResultId: promotionResult.recordId },
      input.observedAt,
      input.proposal.id,
      {
        eventType: 'VEHICLE_MASTER_PRICE_REVISION_PROMOTED',
        revision: input.proposal.revision,
        canonicalWrite,
        targetId: input.proposal.targetId,
        amount: input.proposal.amount,
        evidenceSetId: evidence.evidenceSet.recordId,
      }
    ));
    changeEventId = changeEvent.recordId;
  }

  return {
    decision,
    canonicalWrite,
    candidateFactId: evidence.candidateFact.recordId,
    evidenceSetId: evidence.evidenceSet.recordId,
    revisionCandidateId: evidence.revisionCandidate.recordId,
    promotionResultId: promotionResult.recordId,
    changeEventId,
  };
}


export async function promoteVehicleMasterCompatibilityRule(
  store: VehicleMasterStore,
  input: PromoteVehicleMasterRuleInput
): Promise<PromoteVehicleMasterRuleResult> {
  const sourceDecision = await evaluateVehicleMasterRuleEvidence(store, input);
  const issues = [...sourceDecision.issues];

  if (!(await store.getNode(input.proposal.subjectId))) {
    issues.push({
      code: 'RULE_SUBJECT_MISSING',
      fieldPath: 'subjectId',
      detail: input.proposal.subjectId,
    });
  }
  for (const targetId of input.proposal.targetIds) {
    if (!(await store.getNode(targetId))) {
      issues.push({
        code: 'RULE_TARGET_MISSING',
        fieldPath: 'targetIds',
        detail: targetId,
      });
    }
  }
  for (const [field, refId] of Object.entries(input.proposal.scope)) {
    if (refId && !(await store.getNode(refId))) {
      issues.push({
        code: 'RULE_SCOPE_REFERENCE_MISSING',
        fieldPath: `scope.${field}`,
        detail: refId,
      });
    }
  }

  const decision: VehicleMasterEvidenceDecision = {
    ...sourceDecision,
    status: issues.length ? 'HOLD' : 'APPROVED',
    issues,
  };
  const evidence = await persistPromotionEvidence(store, {
    entityKind: 'NODE',
    entityId: input.proposal.id,
    revision: input.proposal.revision,
    proposalHash: input.proposal.contentHash,
    observations: input.observations,
    observedAt: input.observedAt,
    decision,
    candidatePayload: {
      proposalHash: input.proposal.contentHash,
      entityType: 'COMPATIBILITY_RULE',
      subjectId: input.proposal.subjectId,
      ruleType: input.proposal.ruleType,
      targetIds: input.proposal.targetIds,
      scope: input.proposal.scope,
      observations: input.observations,
    },
  });

  let canonicalWrite: VehicleMasterWriteResult | null = null;
  let promotionStatus: 'PROMOTED' | 'HOLD' = 'HOLD';
  if (decision.status === 'APPROVED') {
    canonicalWrite = await store.putCompatibilityRule(input.proposal);
    promotionStatus = 'PROMOTED';
  }

  const promotionResult = await putOutcomeRecordOnce(store, pipelineRecord(
    'PROMOTION_RESULT',
    evidence.identity,
    input.observedAt,
    input.proposal.id,
    {
      revisionCandidateId: evidence.revisionCandidate.recordId,
      status: promotionStatus,
      canonicalWrite,
      issues: decision.issues,
    }
  ));

  let changeEventId: string | null = null;
  if (promotionStatus === 'PROMOTED') {
    const changeEvent = await putOutcomeRecordOnce(store, pipelineRecord(
      'CHANGE_EVENT',
      { ...evidence.identity, promotionResultId: promotionResult.recordId },
      input.observedAt,
      input.proposal.id,
      {
        eventType:
          canonicalWrite === 'CREATED'
            ? 'VEHICLE_MASTER_RULE_CREATED'
            : canonicalWrite === 'UPDATED'
              ? 'VEHICLE_MASTER_RULE_REVISED'
              : 'VEHICLE_MASTER_RULE_CONFIRMED',
        revision: input.proposal.revision,
        canonicalWrite,
        evidenceSetId: evidence.evidenceSet.recordId,
      }
    ));
    changeEventId = changeEvent.recordId;
  }

  return {
    decision,
    canonicalWrite,
    candidateFactId: evidence.candidateFact.recordId,
    evidenceSetId: evidence.evidenceSet.recordId,
    revisionCandidateId: evidence.revisionCandidate.recordId,
    promotionResultId: promotionResult.recordId,
    changeEventId,
  };
}
