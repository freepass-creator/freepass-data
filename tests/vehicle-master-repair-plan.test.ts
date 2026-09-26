import { describe, expect, it } from 'vitest';
import {
  buildVehicleMasterRepairPlan,
} from '../src/application/vehicle-master-repair-plan.js';
import type {
  VehicleMasterGraphAuditIssue,
  VehicleMasterGraphAuditReport,
} from '../src/application/vehicle-master-graph-audit.js';
import { stableDigest } from '../src/shared/stable-digest.js';

function report(issues: VehicleMasterGraphAuditIssue[]): VehicleMasterGraphAuditReport {
  const sorted = [...issues].sort((a, b) =>
    a.entityKind.localeCompare(b.entityKind) ||
    a.entityId.localeCompare(b.entityId) ||
    a.code.localeCompare(b.code)
  );
  const errors = sorted.filter((issue) => issue.severity === 'ERROR').length;
  const warnings = sorted.length - errors;
  const counts = {
    nodes: 1,
    rules: 1,
    prices: 1,
    errors,
    warnings,
  };
  return {
    status: errors ? 'FAIL' : 'PASS',
    digest: stableDigest({ counts, issues: sorted }),
    counts,
    issues: sorted,
  };
}

const issue = (
  code: string,
  entityKind: VehicleMasterGraphAuditIssue['entityKind'],
  entityId: string,
  extra: Partial<VehicleMasterGraphAuditIssue> = {}
): VehicleMasterGraphAuditIssue => ({
  code,
  severity: 'ERROR',
  entityKind,
  entityId,
  ...extra,
});

describe('vehicle master repair plan', () => {
  it('returns an empty plan for a clean audit', () => {
    const source = report([]);
    const plan = buildVehicleMasterRepairPlan(source);

    expect(plan.status).toBe('NO_REPAIR_NEEDED');
    expect(plan.sourceAuditDigest).toBe(source.digest);
    expect(plan.executionPolicy).toBe('PLAN_ONLY');
    expect(plan.counts).toEqual({
      AUTO_SAFE: 0,
      MANUAL_REVIEW: 0,
      SOURCE_REQUIRED: 0,
      UNRECOVERABLE: 0,
    });
    expect(plan.items).toEqual([]);
    expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('classifies deterministic current Canonical normalization repairs as AUTO_SAFE', () => {
    const source = report([
      issue('CONTENT_HASH_MISMATCH', 'NODE', 'trim_a'),
      issue('POWERTRAIN_IDENTITY_MISMATCH', 'NODE', 'pt_a'),
      issue('TRIM_IDENTITY_MISMATCH', 'NODE', 'trim_b'),
      issue('VARIANT_DRIVETRAIN_NOT_CANONICAL', 'NODE', 'variant_a'),
    ]);

    const plan = buildVehicleMasterRepairPlan(source);

    expect(plan.counts.AUTO_SAFE).toBe(4);
    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueCode: 'CONTENT_HASH_MISMATCH',
        classification: 'AUTO_SAFE',
        owner: 'E-01',
        action: 'RESEAL_DERIVED_HASH',
      }),
      expect.objectContaining({
        issueCode: 'POWERTRAIN_IDENTITY_MISMATCH',
        classification: 'AUTO_SAFE',
        action: 'RENORMALIZE_DERIVED_IDENTITY',
      }),
      expect.objectContaining({
        issueCode: 'TRIM_IDENTITY_MISMATCH',
        classification: 'AUTO_SAFE',
        action: 'RENORMALIZE_DERIVED_IDENTITY',
      }),
      expect.objectContaining({
        issueCode: 'VARIANT_DRIVETRAIN_NOT_CANONICAL',
        classification: 'AUTO_SAFE',
        action: 'RENORMALIZE_DERIVED_DRIVETRAIN',
      }),
    ]));

    for (const item of plan.items) {
      expect(item.executionPolicy).toBe('PLAN_ONLY');
      expect(item.preconditions.length).toBeGreaterThan(0);
    }
  });

  it('never treats immutable evidence hash corruption as AUTO_SAFE', () => {
    const source = report([
      issue('CONTENT_HASH_MISMATCH', 'SOURCE', 'source_a'),
      issue('CONTENT_HASH_MISMATCH', 'REVISION', 'NODE:trim_a:r1'),
      issue('CONTENT_HASH_MISMATCH', 'PIPELINE', 'EVIDENCE_SET:e1'),
    ]);

    const plan = buildVehicleMasterRepairPlan(source);

    expect(plan.counts.UNRECOVERABLE).toBe(3);
    expect(plan.counts.AUTO_SAFE).toBe(0);
    for (const item of plan.items) {
      expect(item.classification).toBe('UNRECOVERABLE');
      expect(item.owner).toBe('INCIDENT_RECOVERY');
      expect(item.action).toBe('REBUILD_FROM_TRUSTED_SNAPSHOT');
    }
  });

  it('routes missing or ambiguous source facts to SOURCE_REQUIRED', () => {
    const source = report([
      issue('SOURCE_EVIDENCE_MISSING', 'NODE', 'trim_a', {
        relatedId: 'source_missing',
      }),
      issue('MODEL_YEAR_ALIAS_MISMATCH', 'NODE', 'my_a'),
      issue('POWERTRAIN_FUEL_TYPE_MISMATCH', 'NODE', 'pt_a'),
      issue('PHASE_EFFECTIVE_RANGE_OVERLAP', 'NODE', 'phase_b'),
      issue('PRICE_EFFECTIVE_START_CONFLICT', 'PRICE', 'price_b'),
      issue('PIPELINE_EVIDENCE_SOURCE_MISSING', 'PIPELINE', 'EVIDENCE_SET:e1'),
    ]);

    const plan = buildVehicleMasterRepairPlan(source);

    expect(plan.counts.SOURCE_REQUIRED).toBe(6);
    for (const item of plan.items) {
      expect(item.classification).toBe('SOURCE_REQUIRED');
      expect(item.owner).toBe('I-01');
    }
  });

  it('routes identity/relationship and rule conflicts to manual review', () => {
    const source = report([
      issue('REFERENCE_LINEAGE_MISMATCH', 'NODE', 'trim_a'),
      issue('TRIM_DUPLICATE_IN_VARIANT', 'NODE', 'trim_b'),
      issue('RULE_DEPENDENCY_CYCLE_CONFLICT', 'RULE', 'rule_a'),
      issue('RULE_INCLUDES_CONFLICT', 'RULE', 'rule_b'),
      issue('PRICE_TARGET_TYPE_MISMATCH', 'PRICE', 'price_a'),
      issue('REVISION_LATEST_MISMATCH', 'NODE', 'trim_c'),
    ]);

    const plan = buildVehicleMasterRepairPlan(source);

    expect(plan.counts.MANUAL_REVIEW).toBe(6);
    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueCode: 'TRIM_DUPLICATE_IN_VARIANT',
        action: 'REVIEW_DUPLICATE_IDENTITY',
      }),
      expect.objectContaining({
        issueCode: 'RULE_DEPENDENCY_CYCLE_CONFLICT',
        action: 'REVIEW_RULE_CONFLICT',
      }),
      expect.objectContaining({
        issueCode: 'REVISION_LATEST_MISMATCH',
        action: 'REVIEW_REVISION_HEAD',
      }),
    ]));
  });

  it('routes missing immutable history to UNRECOVERABLE recovery', () => {
    const source = report([
      issue('REVISION_SEQUENCE_GAP', 'NODE', 'trim_a'),
      issue('REVISION_HISTORY_MISSING', 'RULE', 'rule_a'),
      issue('PIPELINE_REVISION_CANDIDATE_MISSING', 'PIPELINE', 'PROMOTION_RESULT:p1'),
      issue('PIPELINE_PROPOSAL_HASH_MISMATCH', 'PIPELINE', 'PROMOTION_RESULT:p2'),
      issue('PIPELINE_CHANGE_EVENT_MISSING', 'PIPELINE', 'PROMOTION_RESULT:p3'),
    ]);

    const plan = buildVehicleMasterRepairPlan(source);

    expect(plan.counts.UNRECOVERABLE).toBe(5);
    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueCode: 'REVISION_SEQUENCE_GAP',
        action: 'RESTORE_REVISION_FROM_IMMUTABLE_BACKUP',
      }),
      expect.objectContaining({
        issueCode: 'PIPELINE_CHANGE_EVENT_MISSING',
        action: 'RESTORE_PIPELINE_FROM_IMMUTABLE_BACKUP',
      }),
    ]));
  });

  it('fails closed to MANUAL_REVIEW for unknown future issue codes', () => {
    const source = report([
      issue('FUTURE_UNKNOWN_AUDIT_ISSUE', 'NODE', 'node_future'),
    ]);

    const plan = buildVehicleMasterRepairPlan(source);

    expect(plan.items[0]).toEqual(expect.objectContaining({
      issueCode: 'FUTURE_UNKNOWN_AUDIT_ISSUE',
      classification: 'MANUAL_REVIEW',
      owner: 'REVIEW_QUEUE',
      executionPolicy: 'PLAN_ONLY',
    }));
  });

  it('is deterministic regardless of audit issue input order', () => {
    const issues = [
      issue('SOURCE_EVIDENCE_MISSING', 'NODE', 'trim_a'),
      issue('TRIM_DUPLICATE_IN_VARIANT', 'NODE', 'trim_b'),
      issue('CONTENT_HASH_MISMATCH', 'NODE', 'trim_c'),
      issue('REVISION_SEQUENCE_GAP', 'NODE', 'trim_d'),
    ];

    const a = buildVehicleMasterRepairPlan(report(issues));
    const b = buildVehicleMasterRepairPlan(report([...issues].reverse()));

    expect(b).toEqual(a);
  });
});
