import {
  sealVehicleMasterCompatibilityRule,
  sealVehicleMasterNode,
  type VehicleMasterCompatibilityRule,
  type VehicleMasterNode,
} from '../domain/vehicle-master.js';
import {
  canonicalDrivetrain,
  canonicalPowertrainIdentity,
  canonicalTrimIdentity,
} from '../domain/vehicle-master-normalization.js';
import { stableDigest } from '../shared/stable-digest.js';
import {
  auditVehicleMasterGraph,
  type VehicleMasterGraphAuditIssue,
  type VehicleMasterGraphAuditReport,
  type VehicleMasterGraphSnapshot,
} from './vehicle-master-graph-audit.js';
import {
  buildVehicleMasterRepairPlan,
  type VehicleMasterRepairPlan,
  type VehicleMasterRepairPlanItem,
} from './vehicle-master-repair-plan.js';

export type VehicleMasterRepairDryRunChange = {
  fieldPath: string;
  before: unknown;
  after: unknown;
};

export type VehicleMasterRepairDryRunItem = {
  entityKind: 'NODE' | 'RULE';
  entityId: string;
  repairIds: string[];
  actions: VehicleMasterRepairPlanItem['action'][];
  status: 'READY' | 'BLOCKED';
  currentRevision: number | null;
  expectedRevision: number | null;
  beforeContentHash: string | null;
  afterContentHash: string | null;
  changes: VehicleMasterRepairDryRunChange[];
  blockers: string[];
  resolvedIssueCodes: string[];
};

export type VehicleMasterRepairDryRun = {
  status: 'NO_CHANGES' | 'READY' | 'PARTIAL' | 'BLOCKED' | 'STALE_INPUT';
  executionPolicy: 'DRY_RUN_ONLY';
  observedAt: string;
  sourceAuditDigest: string;
  sourceRepairPlanDigest: string;
  digest: string;
  counts: {
    autoSafeItems: number;
    readyEntities: number;
    blockedEntities: number;
    nonAutoItems: number;
    changes: number;
  };
  globalBlockers: string[];
  items: VehicleMasterRepairDryRunItem[];
  simulatedAudit: VehicleMasterGraphAuditReport;
};

type RepairableRecord = VehicleMasterNode | VehicleMasterCompatibilityRule;

const entityKey = (kind: string, id: string) => `${kind}:${id}`;

const issueKey = (issue: {
  code: string;
  entityKind: string;
  entityId: string;
  fieldPath?: string | null;
  relatedId?: string | null;
}) =>
  stableDigest({
    code: issue.code,
    entityKind: issue.entityKind,
    entityId: issue.entityId,
    fieldPath: issue.fieldPath ?? null,
    relatedId: issue.relatedId ?? null,
  });

const diff = (
  fieldPath: string,
  before: unknown,
  after: unknown
): VehicleMasterRepairDryRunChange | null =>
  stableDigest({ value: before }) === stableDigest({ value: after })
    ? null
    : { fieldPath, before, after };

function recordFor(
  snapshot: VehicleMasterGraphSnapshot,
  kind: 'NODE' | 'RULE',
  id: string
): RepairableRecord | null {
  return kind === 'NODE'
    ? snapshot.nodes.find((record) => record.id === id) ?? null
    : snapshot.rules.find((record) => record.id === id) ?? null;
}

function relatedPipelineEntity(
  snapshot: VehicleMasterGraphSnapshot,
  planItem: VehicleMasterRepairPlanItem
) {
  if (planItem.entityKind !== 'PIPELINE') return null;
  const separator = planItem.entityId.indexOf(':');
  if (separator < 0) return null;
  const kind = planItem.entityId.slice(0, separator);
  const recordId = planItem.entityId.slice(separator + 1);
  return snapshot.pipelineRecords?.find(
    (record) => record.kind === kind && record.recordId === recordId
  )?.entityId ?? null;
}

function hasEntityBlocker(
  snapshot: VehicleMasterGraphSnapshot,
  plan: VehicleMasterRepairPlan,
  kind: 'NODE' | 'RULE',
  id: string
) {
  return plan.items.filter((item) => {
    if (item.classification === 'AUTO_SAFE') return false;
    if (item.entityKind === kind && item.entityId === id) return true;
    if (
      item.entityKind === 'REVISION' &&
      item.entityId.startsWith(`${kind}:${id}:r`)
    ) {
      return true;
    }
    return relatedPipelineEntity(snapshot, item) === id;
  });
}

function repairNode(
  current: VehicleMasterNode,
  items: readonly VehicleMasterRepairPlanItem[],
  observedAt: string
): { record: VehicleMasterNode | null; blockers: string[] } {
  const blockers: string[] = [];
  const attributes = structuredClone(current.attributes);

  for (const item of items) {
    switch (item.action) {
      case 'RESEAL_DERIVED_HASH':
        break;
      case 'RENORMALIZE_DERIVED_IDENTITY':
        if (current.nodeType === 'POWERTRAIN') {
          attributes.identityKey = canonicalPowertrainIdentity(current.canonicalName);
        } else if (current.nodeType === 'TRIM') {
          attributes.identityKey = canonicalTrimIdentity(current.canonicalName);
        } else {
          blockers.push(`UNSUPPORTED_IDENTITY_NODE_TYPE:${current.nodeType}`);
        }
        break;
      case 'RENORMALIZE_DERIVED_DRIVETRAIN': {
        if (current.nodeType !== 'VARIANT') {
          blockers.push(`UNSUPPORTED_DRIVETRAIN_NODE_TYPE:${current.nodeType}`);
          break;
        }
        const stored =
          typeof current.attributes.drivetrain === 'string'
            ? current.attributes.drivetrain
            : null;
        const canonical = canonicalDrivetrain(stored);
        if (!canonical) {
          blockers.push('DRIVETRAIN_NOT_DETERMINISTIC');
          break;
        }
        attributes.drivetrain = canonical;
        break;
      }
      default:
        blockers.push(`UNSUPPORTED_AUTO_SAFE_ACTION:${item.action}`);
    }
  }

  if (blockers.length) return { record: null, blockers: [...new Set(blockers)].sort() };

  const {
    schemaVersion: _schemaVersion,
    contentHash: _contentHash,
    revision: _revision,
    updatedAt: _updatedAt,
    ...base
  } = current;

  return {
    record: sealVehicleMasterNode({
      ...base,
      attributes,
      revision: current.revision + 1,
      updatedAt: observedAt,
    }),
    blockers: [],
  };
}

function repairRule(
  current: VehicleMasterCompatibilityRule,
  items: readonly VehicleMasterRepairPlanItem[],
  observedAt: string
): { record: VehicleMasterCompatibilityRule | null; blockers: string[] } {
  const blockers = items
    .filter((item) => item.action !== 'RESEAL_DERIVED_HASH')
    .map((item) => `UNSUPPORTED_AUTO_SAFE_ACTION:${item.action}`);

  if (blockers.length) return { record: null, blockers: [...new Set(blockers)].sort() };

  const {
    schemaVersion: _schemaVersion,
    contentHash: _contentHash,
    revision: _revision,
    updatedAt: _updatedAt,
    ...base
  } = current;

  return {
    record: sealVehicleMasterCompatibilityRule({
      ...base,
      revision: current.revision + 1,
      updatedAt: observedAt,
    }),
    blockers: [],
  };
}

function snapshotWithRepair(
  snapshot: VehicleMasterGraphSnapshot,
  kind: 'NODE' | 'RULE',
  candidate: RepairableRecord
): VehicleMasterGraphSnapshot {
  if (kind === 'NODE') {
    const node = candidate as VehicleMasterNode;
    return {
      ...snapshot,
      nodes: snapshot.nodes.map((record) => record.id === node.id ? node : record),
      ...(snapshot.nodeRevisions
        ? { nodeRevisions: [...snapshot.nodeRevisions, node] }
        : {}),
    };
  }

  const rule = candidate as VehicleMasterCompatibilityRule;
  return {
    ...snapshot,
    rules: snapshot.rules.map((record) => record.id === rule.id ? rule : record),
    ...(snapshot.ruleRevisions
      ? { ruleRevisions: [...snapshot.ruleRevisions, rule] }
      : {}),
  };
}

function changesFor(
  before: RepairableRecord,
  after: RepairableRecord
): VehicleMasterRepairDryRunChange[] {
  const changes: Array<VehicleMasterRepairDryRunChange | null> = [
    diff('revision', before.revision, after.revision),
    diff('updatedAt', before.updatedAt, after.updatedAt),
    diff('contentHash', before.contentHash, after.contentHash),
  ];

  if ('nodeType' in before && 'nodeType' in after) {
    changes.push(
      diff(
        'attributes.identityKey',
        before.attributes.identityKey,
        after.attributes.identityKey
      ),
      diff(
        'attributes.drivetrain',
        before.attributes.drivetrain,
        after.attributes.drivetrain
      )
    );
  }

  return changes
    .filter((item): item is VehicleMasterRepairDryRunChange => Boolean(item))
    .sort((a, b) => a.fieldPath.localeCompare(b.fieldPath));
}

function simulateEntity(
  snapshot: VehicleMasterGraphSnapshot,
  report: VehicleMasterGraphAuditReport,
  plan: VehicleMasterRepairPlan,
  kind: 'NODE' | 'RULE',
  id: string,
  items: VehicleMasterRepairPlanItem[],
  observedAt: string
): {
  item: VehicleMasterRepairDryRunItem;
  candidate: RepairableRecord | null;
} {
  const current = recordFor(snapshot, kind, id);
  const blockers = hasEntityBlocker(snapshot, plan, kind, id)
    .map((item) => `NON_AUTO_SAFE_ISSUE:${item.issueCode}:${item.entityKind}:${item.entityId}`);

  if (!current) blockers.push('CURRENT_CANONICAL_RECORD_MISSING');

  let candidate: RepairableRecord | null = null;
  if (current && !blockers.length) {
    const repaired = kind === 'NODE'
      ? repairNode(current as VehicleMasterNode, items, observedAt)
      : repairRule(current as VehicleMasterCompatibilityRule, items, observedAt);
    candidate = repaired.record;
    blockers.push(...repaired.blockers);
  }

  let resolvedIssueCodes: string[] = [];
  if (current && candidate && !blockers.length) {
    const entitySnapshot = snapshotWithRepair(snapshot, kind, candidate);
    const post = auditVehicleMasterGraph(entitySnapshot);
    const postIssueKeys = new Set(post.issues.map(issueKey));
    const targetedIssues = items.map((item) => ({
      code: item.issueCode,
      entityKind: item.entityKind,
      entityId: item.entityId,
      fieldPath: item.fieldPath,
      relatedId: item.relatedId,
    }));
    const unresolved = targetedIssues.filter((target) =>
      postIssueKeys.has(issueKey(target))
    );
    if (unresolved.length) {
      blockers.push(
        ...unresolved.map((target) => `POST_AUDIT_ISSUE_REMAINS:${target.code}`)
      );
    } else {
      resolvedIssueCodes = [...new Set(items.map((item) => item.issueCode))].sort();
    }

    const beforeEntityIssueKeys = new Set(
      report.issues
        .filter((issue) => issue.entityKind === kind && issue.entityId === id)
        .map(issueKey)
    );
    const newEntityIssues = post.issues
      .filter((issue) => issue.entityKind === kind && issue.entityId === id)
      .filter((issue) => !beforeEntityIssueKeys.has(issueKey(issue)));
    if (newEntityIssues.length) {
      blockers.push(
        ...newEntityIssues.map((issue) => `POST_AUDIT_NEW_ISSUE:${issue.code}`)
      );
    }
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  const ready = Boolean(current && candidate && !uniqueBlockers.length);

  return {
    candidate: ready ? candidate : null,
    item: {
      entityKind: kind,
      entityId: id,
      repairIds: items.map((item) => item.repairId).sort(),
      actions: [...new Set(items.map((item) => item.action))].sort(),
      status: ready ? 'READY' : 'BLOCKED',
      currentRevision: current?.revision ?? null,
      expectedRevision: ready && candidate ? candidate.revision : null,
      beforeContentHash: current?.contentHash ?? null,
      afterContentHash: ready && candidate ? candidate.contentHash : null,
      changes: ready && current && candidate ? changesFor(current, candidate) : [],
      blockers: uniqueBlockers,
      resolvedIssueCodes: ready ? resolvedIssueCodes : [],
    },
  };
}

export function buildVehicleMasterRepairDryRun(input: {
  snapshot: VehicleMasterGraphSnapshot;
  auditReport: VehicleMasterGraphAuditReport;
  repairPlan: VehicleMasterRepairPlan;
  observedAt: string;
}): VehicleMasterRepairDryRun {
  const currentAudit = auditVehicleMasterGraph(input.snapshot);
  const expectedPlan = buildVehicleMasterRepairPlan(input.auditReport);
  const globalBlockers: string[] = [];

  if (currentAudit.digest !== input.auditReport.digest) {
    globalBlockers.push('AUDIT_SNAPSHOT_DIGEST_MISMATCH');
  }
  if (input.repairPlan.sourceAuditDigest !== input.auditReport.digest) {
    globalBlockers.push('REPAIR_PLAN_SOURCE_AUDIT_MISMATCH');
  }
  if (expectedPlan.digest !== input.repairPlan.digest) {
    globalBlockers.push('REPAIR_PLAN_DIGEST_MISMATCH');
  }

  const autoItems = input.repairPlan.items.filter(
    (item) => item.classification === 'AUTO_SAFE'
  );
  const nonAutoItems = input.repairPlan.items.length - autoItems.length;

  if (globalBlockers.length) {
    const simulatedAudit = currentAudit;
    const counts = {
      autoSafeItems: autoItems.length,
      readyEntities: 0,
      blockedEntities: 0,
      nonAutoItems,
      changes: 0,
    };
    return {
      status: 'STALE_INPUT',
      executionPolicy: 'DRY_RUN_ONLY',
      observedAt: input.observedAt,
      sourceAuditDigest: input.auditReport.digest,
      sourceRepairPlanDigest: input.repairPlan.digest,
      digest: stableDigest({
        status: 'STALE_INPUT',
        observedAt: input.observedAt,
        sourceAuditDigest: input.auditReport.digest,
        sourceRepairPlanDigest: input.repairPlan.digest,
        counts,
        globalBlockers: [...globalBlockers].sort(),
        items: [],
        simulatedAuditDigest: simulatedAudit.digest,
      }),
      counts,
      globalBlockers: [...globalBlockers].sort(),
      items: [],
      simulatedAudit,
    };
  }

  const groups = new Map<string, VehicleMasterRepairPlanItem[]>();
  for (const item of autoItems) {
    const key = entityKey(item.entityKind, item.entityId);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const simulations = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, items]) => {
      const [kind, ...idParts] = key.split(':');
      const id = idParts.join(':');
      if (kind !== 'NODE' && kind !== 'RULE') {
        return {
          candidate: null,
          item: {
            entityKind: 'NODE' as const,
            entityId: id,
            repairIds: items.map((item) => item.repairId).sort(),
            actions: [...new Set(items.map((item) => item.action))].sort(),
            status: 'BLOCKED' as const,
            currentRevision: null,
            expectedRevision: null,
            beforeContentHash: null,
            afterContentHash: null,
            changes: [],
            blockers: [`UNSUPPORTED_AUTO_SAFE_ENTITY_KIND:${kind}`],
            resolvedIssueCodes: [],
          },
        };
      }
      return simulateEntity(
        input.snapshot,
        input.auditReport,
        input.repairPlan,
        kind,
        id,
        items,
        input.observedAt
      );
    });

  let simulatedSnapshot = input.snapshot;
  for (const simulation of simulations) {
    if (!simulation.candidate || simulation.item.status !== 'READY') continue;
    simulatedSnapshot = snapshotWithRepair(
      simulatedSnapshot,
      simulation.item.entityKind,
      simulation.candidate
    );
  }
  const simulatedAudit = auditVehicleMasterGraph(simulatedSnapshot);

  const items = simulations.map((simulation) => simulation.item);
  const readyEntities = items.filter((item) => item.status === 'READY').length;
  const blockedEntities = items.length - readyEntities;
  const changes = items.reduce((sum, item) => sum + item.changes.length, 0);
  const counts = {
    autoSafeItems: autoItems.length,
    readyEntities,
    blockedEntities,
    nonAutoItems,
    changes,
  };

  const status =
    !autoItems.length
      ? 'NO_CHANGES'
      : readyEntities === 0
        ? 'BLOCKED'
        : blockedEntities
          ? 'PARTIAL'
          : 'READY';

  return {
    status,
    executionPolicy: 'DRY_RUN_ONLY',
    observedAt: input.observedAt,
    sourceAuditDigest: input.auditReport.digest,
    sourceRepairPlanDigest: input.repairPlan.digest,
    digest: stableDigest({
      status,
      observedAt: input.observedAt,
      sourceAuditDigest: input.auditReport.digest,
      sourceRepairPlanDigest: input.repairPlan.digest,
      counts,
      globalBlockers,
      items,
      simulatedAuditDigest: simulatedAudit.digest,
    }),
    counts,
    globalBlockers,
    items,
    simulatedAudit,
  };
}
