import { stableDigest } from '../shared/stable-digest.js';
import type {
  VehicleMasterGraphAuditIssue,
  VehicleMasterGraphAuditReport,
} from './vehicle-master-graph-audit.js';

export type VehicleMasterRepairClassification =
  | 'AUTO_SAFE'
  | 'MANUAL_REVIEW'
  | 'SOURCE_REQUIRED'
  | 'UNRECOVERABLE';

export type VehicleMasterRepairOwner =
  | 'E-01'
  | 'I-01'
  | 'REVIEW_QUEUE'
  | 'INCIDENT_RECOVERY';

export type VehicleMasterRepairAction =
  | 'RESEAL_DERIVED_HASH'
  | 'RENORMALIZE_DERIVED_IDENTITY'
  | 'RENORMALIZE_DERIVED_DRIVETRAIN'
  | 'REVIEW_CANONICAL_RELATIONSHIP'
  | 'REVIEW_DUPLICATE_IDENTITY'
  | 'REVIEW_RULE_CONFLICT'
  | 'REVIEW_REVISION_HEAD'
  | 'REFETCH_AUTHORITATIVE_SOURCE'
  | 'RESTORE_MISSING_SOURCE_EVIDENCE'
  | 'RESTORE_TEMPORAL_EVIDENCE'
  | 'RESTORE_REVISION_FROM_IMMUTABLE_BACKUP'
  | 'RESTORE_PIPELINE_FROM_IMMUTABLE_BACKUP'
  | 'REBUILD_FROM_TRUSTED_SNAPSHOT';

export type VehicleMasterRepairPlanItem = {
  repairId: string;
  issueCode: string;
  entityKind: VehicleMasterGraphAuditIssue['entityKind'];
  entityId: string;
  fieldPath: string | null;
  relatedId: string | null;
  classification: VehicleMasterRepairClassification;
  owner: VehicleMasterRepairOwner;
  action: VehicleMasterRepairAction;
  reason: string;
  preconditions: string[];
  executionPolicy: 'PLAN_ONLY';
};

export type VehicleMasterRepairPlan = {
  status: 'NO_REPAIR_NEEDED' | 'REPAIR_REQUIRED';
  sourceAuditDigest: string;
  digest: string;
  executionPolicy: 'PLAN_ONLY';
  counts: Record<VehicleMasterRepairClassification, number>;
  items: VehicleMasterRepairPlanItem[];
};

type RepairRule = Omit<
  VehicleMasterRepairPlanItem,
  'repairId' | 'issueCode' | 'entityKind' | 'entityId' | 'fieldPath' | 'relatedId' | 'executionPolicy'
>;

const MANUAL_RELATIONSHIP_CODES = new Set([
  'PARENT_ID_REQUIRED',
  'PARENT_NODE_MISSING',
  'PARENT_NODE_TYPE_MISMATCH',
  'PARENT_NODE_HOLD',
  'PARENT_REFERENCE_MISMATCH',
  'REFERENCE_NODE_SELF',
  'REFERENCE_NODE_MISSING',
  'REFERENCE_NODE_TYPE_MISMATCH',
  'REFERENCE_NODE_HOLD',
  'REFERENCE_LINEAGE_INCOMPLETE',
  'REFERENCE_LINEAGE_MISMATCH',
  'PARENT_CYCLE',
  'RULE_SUBJECT_MISSING',
  'RULE_SUBJECT_HOLD',
  'RULE_TARGET_MISSING',
  'RULE_TARGET_HOLD',
  'RULE_SCOPE_REFERENCE_MISSING',
  'RULE_SCOPE_REFERENCE_TYPE_MISMATCH',
  'RULE_SCOPE_REFERENCE_HOLD',
  'RULE_LINEAGE_INCOMPLETE',
  'RULE_LINEAGE_MISMATCH',
  'RULE_SCOPE_SUBJECT_MISMATCH',
  'PRICE_TARGET_MISSING',
  'PRICE_TARGET_TYPE_MISMATCH',
  'PRICE_TARGET_LINEAGE_INCOMPLETE',
  'PRICE_TARGET_HOLD',
]);

const DUPLICATE_CODES = new Set([
  'MAKE_DUPLICATE',
  'MODEL_DUPLICATE_IN_MAKE',
  'GENERATION_DUPLICATE_IN_MODEL',
  'PHASE_DUPLICATE_IN_GENERATION',
  'MODEL_YEAR_DUPLICATE_IN_PHASE',
  'POWERTRAIN_DUPLICATE_IN_MODEL_YEAR',
  'VARIANT_DUPLICATE_IN_POWERTRAIN',
  'TRIM_DUPLICATE_IN_VARIANT',
  'SUPPLEMENTAL_DUPLICATE_IN_MODEL_YEAR',
  'SUPPLEMENTAL_TYPE_CONFLICT_IN_MODEL_YEAR',
]);

const RULE_CONFLICT_CODES = new Set([
  'RULE_INCLUDES_SUBJECT_TYPE_MISMATCH',
  'RULE_INCLUDES_TARGET_TYPE_MISMATCH',
  'RULE_INCLUDES_EFFECT_MISMATCH',
  'RULE_INCLUDES_DUPLICATE',
  'RULE_INCLUDES_CONFLICT',
  'RULE_PRICE_OVERRIDE_UNDEFINED',
  'RULE_AVAILABILITY_EFFECT_MISMATCH',
  'RULE_AVAILABILITY_DUPLICATE',
  'RULE_AVAILABILITY_CONFLICT',
  'RULE_GROUP_SUBJECT_TYPE_MISMATCH',
  'RULE_GROUP_TARGET_TYPE_MISMATCH',
  'RULE_GROUP_TARGET_COUNT_INVALID',
  'RULE_GROUP_MAX_SELECTION_INVALID',
  'RULE_GROUP_DUPLICATE',
  'RULE_GROUP_CONSTRAINT_CONFLICT',
  'RULE_DEPENDENCY_DUPLICATE',
  'RULE_DEPENDENCY_CONFLICT',
  'RULE_DEPENDENCY_TRANSITIVE_CONFLICT',
  'RULE_DEPENDENCY_CYCLE_CONFLICT',
]);

const SOURCE_REQUIRED_CODES = new Set([
  'SOURCE_EVIDENCE_REQUIRED',
  'SOURCE_EVIDENCE_MISSING',
  'PRICE_SOURCE_DOCUMENT_REQUIRED',
  'PRICE_SOURCE_DOCUMENT_MISSING',
  'MODEL_YEAR_NAME_MISMATCH',
  'MODEL_YEAR_ALIAS_MISMATCH',
  'POWERTRAIN_FUEL_TYPE_MISMATCH',
  'VARIANT_SEATS_INVALID',
  'VARIANT_DRIVETRAIN_INVALID',
  'VARIANT_NAME_SEATS_MISMATCH',
  'VARIANT_NAME_DRIVETRAIN_MISMATCH',
  'PHASE_EFFECTIVE_RANGE_OVERLAP',
  'PARENT_EFFECTIVE_RANGE_MISMATCH',
  'REFERENCE_EFFECTIVE_RANGE_MISMATCH',
  'PRICE_TARGET_EFFECTIVE_RANGE_MISMATCH',
  'PRICE_EFFECTIVE_FROM_REQUIRED_FOR_HISTORY',
  'PRICE_EFFECTIVE_START_CONFLICT',
  'PRICE_EXPLICIT_RANGE_OVERLAP',
  'RULE_AVAILABILITY_CONDITION_REQUIRED',
  'PIPELINE_SOURCE_DOCUMENT_MISSING',
  'PIPELINE_EVIDENCE_SOURCE_MISSING',
]);

const PIPELINE_INTEGRITY_CODES = new Set([
  'REVISION_HISTORY_MISSING',
  'REVISION_SEQUENCE_GAP',
  'REVISION_DUPLICATE_NUMBER',
  'REVISION_ORPHAN',
  'PIPELINE_EVIDENCE_SET_ID_MISSING',
  'PIPELINE_EVIDENCE_SET_MISSING',
  'PIPELINE_EVIDENCE_DOCUMENT_IDS_INVALID',
  'PIPELINE_EVIDENCE_SET_ORPHAN',
  'PIPELINE_REVISION_CANDIDATE_ID_MISSING',
  'PIPELINE_REVISION_CANDIDATE_MISSING',
  'PIPELINE_REVISION_CANDIDATE_ORPHAN',
  'PIPELINE_REVISION_NUMBER_INVALID',
  'PIPELINE_PROPOSAL_HASH_MISSING',
  'PIPELINE_CANDIDATE_FACT_MISSING',
  'PIPELINE_STATUS_MISMATCH',
  'PIPELINE_PROPOSAL_HASH_MISMATCH',
  'PIPELINE_CHANGE_EVENT_MISSING',
]);

const AUTO_IDENTITY_CODES = new Set([
  'POWERTRAIN_IDENTITY_MISMATCH',
  'TRIM_IDENTITY_MISMATCH',
  'VARIANT_DRIVETRAIN_NOT_CANONICAL',
]);

function autoSafeHash(issue: VehicleMasterGraphAuditIssue): RepairRule | null {
  if (issue.code !== 'CONTENT_HASH_MISMATCH') return null;

  if (
    issue.entityKind === 'NODE' ||
    issue.entityKind === 'RULE' ||
    issue.entityKind === 'PRICE'
  ) {
    return {
      classification: 'AUTO_SAFE',
      owner: 'E-01',
      action: 'RESEAL_DERIVED_HASH',
      reason:
        'contentHash is derived from the already-selected current Canonical payload; repair may only reseal the digest without changing substantive fields.',
      preconditions: [
        'the entity has no unresolved SOURCE_REQUIRED, MANUAL_REVIEW, or UNRECOVERABLE issue',
        'the current payload is confirmed as the intended Canonical payload',
        'repair creates a normal audited revision instead of mutating history in place',
      ],
    };
  }

  return {
    classification: 'UNRECOVERABLE',
    owner: 'INCIDENT_RECOVERY',
    action: 'REBUILD_FROM_TRUSTED_SNAPSHOT',
    reason:
      'hash mismatch is on immutable evidence/history material; recomputing the hash would legitimize potentially corrupted audit evidence.',
    preconditions: [
      'locate an immutable trusted backup or independently verified source snapshot',
      'do not overwrite the damaged evidence record in place',
    ],
  };
}

function classify(issue: VehicleMasterGraphAuditIssue): RepairRule {
  const hashRule = autoSafeHash(issue);
  if (hashRule) return hashRule;

  if (AUTO_IDENTITY_CODES.has(issue.code)) {
    return {
      classification: 'AUTO_SAFE',
      owner: 'E-01',
      action:
        issue.code === 'VARIANT_DRIVETRAIN_NOT_CANONICAL'
          ? 'RENORMALIZE_DERIVED_DRIVETRAIN'
          : 'RENORMALIZE_DERIVED_IDENTITY',
      reason:
        'the flagged field is a deterministic derivative of an already-selected Canonical value and can be recomputed without choosing a new vehicle identity.',
      preconditions: [
        'the source Canonical name/value itself has no unresolved semantic or evidence issue',
        'the repair changes only the derived normalized field',
        'the repair is written as a new audited revision',
      ],
    };
  }

  if (SOURCE_REQUIRED_CODES.has(issue.code)) {
    return {
      classification: 'SOURCE_REQUIRED',
      owner: 'I-01',
      action:
        issue.code.includes('TEMPORAL') ||
        issue.code.includes('EFFECTIVE') ||
        issue.code === 'PHASE_EFFECTIVE_RANGE_OVERLAP' ||
        issue.code.startsWith('PRICE_EFFECTIVE_')
          ? 'RESTORE_TEMPORAL_EVIDENCE'
          : issue.code.includes('EVIDENCE') ||
              issue.code.includes('SOURCE_DOCUMENT') ||
              issue.code.includes('SOURCE_')
            ? 'RESTORE_MISSING_SOURCE_EVIDENCE'
            : 'REFETCH_AUTHORITATIVE_SOURCE',
      reason:
        'choosing the correct Canonical value requires authoritative source evidence; the existing graph alone is insufficient.',
      preconditions: [
        'obtain authoritative or corroborated source evidence',
        'preserve the original audit issue and source observation time',
        'rerun Graph Audit before any Canonical promotion',
      ],
    };
  }

  if (PIPELINE_INTEGRITY_CODES.has(issue.code)) {
    return {
      classification: 'UNRECOVERABLE',
      owner: 'INCIDENT_RECOVERY',
      action:
        issue.code.startsWith('REVISION_')
          ? 'RESTORE_REVISION_FROM_IMMUTABLE_BACKUP'
          : 'RESTORE_PIPELINE_FROM_IMMUTABLE_BACKUP',
      reason:
        'immutable history or promotion evidence is missing or contradictory; fabricating the missing record would destroy audit trust.',
      preconditions: [
        'restore only from immutable backup or independently verifiable evidence',
        'never synthesize historical audit records from the current state alone',
        'if no trusted recovery source exists, quarantine the affected Canonical record',
      ],
    };
  }

  if (issue.code === 'REVISION_LATEST_MISMATCH') {
    return {
      classification: 'MANUAL_REVIEW',
      owner: 'REVIEW_QUEUE',
      action: 'REVIEW_REVISION_HEAD',
      reason:
        'both current and historical records exist but disagree; a reviewer must determine which side is authoritative before advancing the head.',
      preconditions: [
        'compare current record, latest revision, promotion evidence, and source evidence',
        'do not delete either side before the discrepancy is resolved',
      ],
    };
  }

  if (DUPLICATE_CODES.has(issue.code)) {
    return {
      classification: 'MANUAL_REVIEW',
      owner: 'REVIEW_QUEUE',
      action: 'REVIEW_DUPLICATE_IDENTITY',
      reason:
        'deduplication changes entity identity and downstream references; automatic merging could conflate distinct vehicles or configurations.',
      preconditions: [
        'review explicit aliases and source evidence for both entities',
        'choose a survivor only after downstream references are inventoried',
      ],
    };
  }

  if (RULE_CONFLICT_CODES.has(issue.code)) {
    return {
      classification: 'MANUAL_REVIEW',
      owner: 'REVIEW_QUEUE',
      action: 'REVIEW_RULE_CONFLICT',
      reason:
        'the graph contains conflicting business semantics; choosing which rule survives is a domain decision rather than a normalization repair.',
      preconditions: [
        'compare scope, effective period, source evidence, and affected targets',
        'do not auto-delete or rewrite a conflicting rule',
      ],
    };
  }

  if (MANUAL_RELATIONSHIP_CODES.has(issue.code)) {
    return {
      classification: 'MANUAL_REVIEW',
      owner: 'REVIEW_QUEUE',
      action: 'REVIEW_CANONICAL_RELATIONSHIP',
      reason:
        'the relationship or lineage is ambiguous; automatically changing an ID/ref could attach data to the wrong vehicle graph.',
      preconditions: [
        'resolve the intended entity identity from source evidence and neighboring Canonical lineage',
        'inventory downstream refs before changing IDs or parents',
      ],
    };
  }

  return {
    classification: 'MANUAL_REVIEW',
    owner: 'REVIEW_QUEUE',
    action: 'REVIEW_CANONICAL_RELATIONSHIP',
    reason:
      'no explicit safe repair policy exists for this audit issue; fail closed to human review.',
    preconditions: [
      'establish an explicit repair policy before mutation',
      'rerun Graph Audit after the proposed repair',
    ],
  };
}

export function buildVehicleMasterRepairPlan(
  report: VehicleMasterGraphAuditReport
): VehicleMasterRepairPlan {
  const items = report.issues
    .map((issue) => {
      const rule = classify(issue);
      return {
        repairId: `vmrepair_${stableDigest({
          auditDigest: report.digest,
          issue,
          classification: rule.classification,
          action: rule.action,
        }).slice(0, 24)}`,
        issueCode: issue.code,
        entityKind: issue.entityKind,
        entityId: issue.entityId,
        fieldPath: issue.fieldPath ?? null,
        relatedId: issue.relatedId ?? null,
        ...rule,
        executionPolicy: 'PLAN_ONLY' as const,
      };
    })
    .sort((a, b) =>
      a.classification.localeCompare(b.classification) ||
      a.entityKind.localeCompare(b.entityKind) ||
      a.entityId.localeCompare(b.entityId) ||
      a.issueCode.localeCompare(b.issueCode) ||
      (a.fieldPath ?? '').localeCompare(b.fieldPath ?? '')
    );

  const counts: Record<VehicleMasterRepairClassification, number> = {
    AUTO_SAFE: 0,
    MANUAL_REVIEW: 0,
    SOURCE_REQUIRED: 0,
    UNRECOVERABLE: 0,
  };
  for (const item of items) counts[item.classification] += 1;

  return {
    status: items.length ? 'REPAIR_REQUIRED' : 'NO_REPAIR_NEEDED',
    sourceAuditDigest: report.digest,
    digest: stableDigest({
      sourceAuditDigest: report.digest,
      executionPolicy: 'PLAN_ONLY',
      items,
    }),
    executionPolicy: 'PLAN_ONLY',
    counts,
    items,
  };
}
