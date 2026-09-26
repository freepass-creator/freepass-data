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
    | 'REFERENCE_NODE_MISSING'
    | 'REFERENCE_NODE_HOLD'
    | 'REFERENCE_NODE_SELF'
    | 'PRICE_TARGET_MISSING'
    | 'PRICE_TARGET_HOLD'
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
      } else if (proposal.status !== 'HOLD' && parent.status === 'HOLD') {
        issues.push({
          code: 'PARENT_NODE_HOLD',
          fieldPath: 'parentId',
          detail: proposal.parentId,
        });
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
    } else if (proposal.status !== 'HOLD' && referenced.status === 'HOLD') {
      issues.push({
        code: 'REFERENCE_NODE_HOLD',
        fieldPath: `refs.${field}`,
        detail: refId,
      });
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
  const targetIssue: VehicleMasterEvidenceIssue | null = !priceTarget
    ? {
        code: 'PRICE_TARGET_MISSING',
        fieldPath: 'targetId',
        detail: input.proposal.targetId,
      }
    : priceTarget.status === 'HOLD'
      ? {
          code: 'PRICE_TARGET_HOLD',
          fieldPath: 'targetId',
          detail: input.proposal.targetId,
        }
      : null;
  const decision: VehicleMasterEvidenceDecision = targetIssue
    ? {
        ...sourceDecision,
        status: 'HOLD',
        issues: [...sourceDecision.issues, targetIssue],
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
