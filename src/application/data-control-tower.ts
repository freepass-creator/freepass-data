export const DATA_CONTROL_TOWER_CONTRACT_VERSION =
  'freepass-data-control-tower-v1' as const;
export const DATA_CONTROL_TOWER_SCHEMA_VERSION = '1.0.0' as const;

export type ControlTowerStatus = 'HEALTHY' | 'DEGRADED' | 'BLOCKED';

export type ScheduledStatusSummary = {
  configured: boolean;
  status: ControlTowerStatus;
  reason?: string;
};

export type ConsumerHealthScheduleSummary = ScheduledStatusSummary & {
  generatedAt?: string;
  counts?: {
    HEALTHY: number;
    DEGRADED: number;
    BLOCKED: number;
  };
};

export type ConsumerReadinessScheduleSummary = ScheduledStatusSummary & {
  generatedAt?: string;
  counts?: {
    readyForNextStage: number;
    hold: number;
    final: number;
  };
  readyTransitions?: Array<{
    consumerId: string;
    from: string;
    to: string;
  }>;
};

export type SheetHealthScheduleSummary = ScheduledStatusSummary & {
  generatedAt?: string;
};

export type EstimateMasterReadinessSummary = {
  contractVersion: 'estimate-master-readiness-v1';
  schemaVersion: '1.0.0';
  status: 'READY' | 'DEGRADED' | 'BLOCKED';
  generatedAt: string;
  projectionId: 'estimate-newcar-master';
  activeReleaseAuthorized: boolean;
  publicationImplemented: boolean;
  counts: {
    total: number;
    active: number;
    hold: number;
  };
  activeRate: number;
  inputDigest: string;
  blockers: string[];
  holdReasons: Array<{ reason: string; count: number }>;
  bridgeConfigured: boolean;
  bridgePath: string | null;
};

export type AuditScheduleHealthSummary = {
  version: 'erp5-audit-schedule-health/1';
  configured: boolean;
  status: ControlTowerStatus;
  reason: string;
  currentReadTime: string;
  previousReadTime: string | null;
  gapMinutes: number | null;
  maxGapMinutes: number | null;
};

export type SourceInventorySummary = {
  version: 'erp5-source-inventory/1';
  source: {
    projectId: string;
    databaseId: string;
    collections: {
      products: number;
      policy: number;
      partner?: number;
    };
    readTime: string;
    digest: string;
    coverage: string;
  };
  authority: {
    canonicalWriteAuthorized: boolean;
    destructiveActionAuthorized: boolean;
    activeReleaseAuthorized: boolean;
    publicationDecision: string;
    publicationHoldReasons: string[];
  };
  runId: string;
};

export type DataControlTowerInput = {
  auditSchedule: AuditScheduleHealthSummary;
  sourceInventory: SourceInventorySummary;
  consumerHealth: ConsumerHealthScheduleSummary;
  consumerReadiness: ConsumerReadinessScheduleSummary;
  sheetHealth: SheetHealthScheduleSummary;
  estimateMasterReadiness?: EstimateMasterReadinessSummary | null;
};

export type DataControlTowerAttentionCode =
  | 'AUDIT_SCHEDULE_BLOCKED'
  | 'AUDIT_SCHEDULE_DEGRADED'
  | 'PUBLICATION_HOLD'
  | 'CONSUMER_HEALTH_BLOCKED'
  | 'CONSUMER_HEALTH_DEGRADED'
  | 'CONSUMER_READINESS_HOLD'
  | 'CONSUMER_READINESS_DEGRADED'
  | 'SHEET_HEALTH_BLOCKED'
  | 'SHEET_HEALTH_DEGRADED'
  | 'HEALTH_POLICY_NOT_CONFIGURED'
  | 'READINESS_POLICY_NOT_CONFIGURED'
  | 'SHEET_POLICY_NOT_CONFIGURED';

export type DataControlTowerReport = {
  contractVersion: typeof DATA_CONTROL_TOWER_CONTRACT_VERSION;
  schemaVersion: typeof DATA_CONTROL_TOWER_SCHEMA_VERSION;
  generatedAt: string;
  runId: string;
  axes: {
    sourceObservation: {
      status: 'OBSERVED';
      projectId: string;
      databaseId: string;
      readTime: string;
      digest: string;
      coverage: string;
      products: number;
      policies: number;
      partners: number | null;
    };
    auditFreshness: AuditScheduleHealthSummary;
    publication: {
      decision: string;
      activeReleaseAuthorized: boolean;
      canonicalWriteAuthorized: boolean;
      destructiveActionAuthorized: boolean;
      holdReasons: string[];
    };
    consumerHealth: ConsumerHealthScheduleSummary;
    consumerReadiness: ConsumerReadinessScheduleSummary;
    sheetHealth: SheetHealthScheduleSummary;
    estimateMasterReadiness: EstimateMasterReadinessSummary | null;
  };
  operatorSummary: {
    readyTransitionCount: number;
    consumerBlockedCount: number | null;
    readinessHoldCount: number | null;
    auditGapMinutes: number | null;
    publicationHoldReasonCount: number;
    estimateCanonicalTrimCount: number | null;
    estimateActiveTrimCount: number | null;
    estimateHoldTrimCount: number | null;
  };
  attention: DataControlTowerAttentionCode[];
};

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const validStatus = (value: unknown): value is ControlTowerStatus =>
  value === 'HEALTHY' || value === 'DEGRADED' || value === 'BLOCKED';

function assertScheduledSummary(
  value: ScheduledStatusSummary,
  code: string
): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.configured !== 'boolean' ||
    !validStatus(value.status)
  ) {
    throw new Error(code);
  }
}

export function validateDataControlTowerInput(
  input: DataControlTowerInput
): void {
  const audit = input.auditSchedule;
  if (
    audit.version !== 'erp5-audit-schedule-health/1' ||
    typeof audit.configured !== 'boolean' ||
    !validStatus(audit.status) ||
    typeof audit.reason !== 'string' ||
    !Number.isFinite(Date.parse(audit.currentReadTime)) ||
    (audit.previousReadTime !== null &&
      !Number.isFinite(Date.parse(audit.previousReadTime))) ||
    (audit.gapMinutes !== null && !finiteNonNegative(audit.gapMinutes)) ||
    (audit.maxGapMinutes !== null && !finiteNonNegative(audit.maxGapMinutes))
  ) {
    throw new Error('INVALID_CONTROL_TOWER_AUDIT_SCHEDULE');
  }

  const source = input.sourceInventory;
  if (
    source.version !== 'erp5-source-inventory/1' ||
    source.source.projectId !== 'freepasserp5' ||
    source.source.databaseId !== '(default)' ||
    !Number.isFinite(Date.parse(source.source.readTime)) ||
    !/^[a-f0-9]{64}$/.test(source.source.digest) ||
    !finiteNonNegative(source.source.collections.products) ||
    !finiteNonNegative(source.source.collections.policy) ||
    (source.source.collections.partner !== undefined &&
      !finiteNonNegative(source.source.collections.partner)) ||
    typeof source.runId !== 'string' ||
    source.runId.length === 0 ||
    typeof source.authority.canonicalWriteAuthorized !== 'boolean' ||
    typeof source.authority.destructiveActionAuthorized !== 'boolean' ||
    typeof source.authority.activeReleaseAuthorized !== 'boolean' ||
    typeof source.authority.publicationDecision !== 'string' ||
    !Array.isArray(source.authority.publicationHoldReasons)
  ) {
    throw new Error('INVALID_CONTROL_TOWER_SOURCE_INVENTORY');
  }

  assertScheduledSummary(
    input.consumerHealth,
    'INVALID_CONTROL_TOWER_CONSUMER_HEALTH'
  );
  assertScheduledSummary(
    input.consumerReadiness,
    'INVALID_CONTROL_TOWER_CONSUMER_READINESS'
  );
  assertScheduledSummary(
    input.sheetHealth,
    'INVALID_CONTROL_TOWER_SHEET_HEALTH'
  );

  const healthCounts = input.consumerHealth.counts;
  if (
    input.consumerHealth.configured &&
    (!healthCounts ||
      !finiteNonNegative(healthCounts.HEALTHY) ||
      !finiteNonNegative(healthCounts.DEGRADED) ||
      !finiteNonNegative(healthCounts.BLOCKED) ||
      healthCounts.HEALTHY + healthCounts.DEGRADED + healthCounts.BLOCKED !== 8)
  ) {
    throw new Error('INVALID_CONTROL_TOWER_CONSUMER_HEALTH_COUNTS');
  }

  const readinessCounts = input.consumerReadiness.counts;
  if (
    input.consumerReadiness.configured &&
    (!readinessCounts ||
      !finiteNonNegative(readinessCounts.readyForNextStage) ||
      !finiteNonNegative(readinessCounts.hold) ||
      !finiteNonNegative(readinessCounts.final) ||
      readinessCounts.readyForNextStage +
        readinessCounts.hold +
        readinessCounts.final !== 8)
  ) {
    throw new Error('INVALID_CONTROL_TOWER_READINESS_COUNTS');
  }

  if (
    input.consumerReadiness.readyTransitions !== undefined &&
    !Array.isArray(input.consumerReadiness.readyTransitions)
  ) {
    throw new Error('INVALID_CONTROL_TOWER_READY_TRANSITIONS');
  }

  const estimate = input.estimateMasterReadiness;
  if (estimate !== undefined && estimate !== null) {
    if (
      estimate.contractVersion !== 'estimate-master-readiness-v1' ||
      estimate.schemaVersion !== '1.0.0' ||
      !['READY', 'DEGRADED', 'BLOCKED'].includes(estimate.status) ||
      !Number.isFinite(Date.parse(estimate.generatedAt)) ||
      estimate.projectionId !== 'estimate-newcar-master' ||
      typeof estimate.activeReleaseAuthorized !== 'boolean' ||
      typeof estimate.publicationImplemented !== 'boolean' ||
      !finiteNonNegative(estimate.counts.total) ||
      !finiteNonNegative(estimate.counts.active) ||
      !finiteNonNegative(estimate.counts.hold) ||
      estimate.counts.active + estimate.counts.hold !== estimate.counts.total ||
      typeof estimate.activeRate !== 'number' ||
      !Number.isFinite(estimate.activeRate) ||
      estimate.activeRate < 0 ||
      estimate.activeRate > 1 ||
      !/^[a-f0-9]{64}$/i.test(estimate.inputDigest) ||
      !Array.isArray(estimate.blockers) ||
      !Array.isArray(estimate.holdReasons) ||
      estimate.holdReasons.some((item) =>
        !item ||
        typeof item.reason !== 'string' ||
        !finiteNonNegative(item.count)
      ) ||
      typeof estimate.bridgeConfigured !== 'boolean' ||
      (estimate.bridgePath !== null && typeof estimate.bridgePath !== 'string')
    ) {
      throw new Error('INVALID_CONTROL_TOWER_ESTIMATE_MASTER_READINESS');
    }
  }
}

function attentionCodes(
  input: DataControlTowerInput
): DataControlTowerAttentionCode[] {
  const out: DataControlTowerAttentionCode[] = [];

  if (input.auditSchedule.status === 'BLOCKED') {
    out.push('AUDIT_SCHEDULE_BLOCKED');
  } else if (input.auditSchedule.status === 'DEGRADED') {
    out.push('AUDIT_SCHEDULE_DEGRADED');
  }

  if (!input.sourceInventory.authority.activeReleaseAuthorized) {
    out.push('PUBLICATION_HOLD');
  }

  if (!input.consumerHealth.configured) {
    out.push('HEALTH_POLICY_NOT_CONFIGURED');
  } else if (input.consumerHealth.status === 'BLOCKED') {
    out.push('CONSUMER_HEALTH_BLOCKED');
  } else if (input.consumerHealth.status === 'DEGRADED') {
    out.push('CONSUMER_HEALTH_DEGRADED');
  }

  if (!input.consumerReadiness.configured) {
    out.push('READINESS_POLICY_NOT_CONFIGURED');
  } else if (
    (input.consumerReadiness.counts?.hold ?? 0) > 0 ||
    input.consumerReadiness.status === 'BLOCKED'
  ) {
    out.push('CONSUMER_READINESS_HOLD');
  } else if (input.consumerReadiness.status === 'DEGRADED') {
    out.push('CONSUMER_READINESS_DEGRADED');
  }

  if (!input.sheetHealth.configured) {
    out.push('SHEET_POLICY_NOT_CONFIGURED');
  } else if (input.sheetHealth.status === 'BLOCKED') {
    out.push('SHEET_HEALTH_BLOCKED');
  } else if (input.sheetHealth.status === 'DEGRADED') {
    out.push('SHEET_HEALTH_DEGRADED');
  }

  return [...new Set(out)];
}

export function buildDataControlTower(
  input: DataControlTowerInput
): DataControlTowerReport {
  validateDataControlTowerInput(input);

  return {
    contractVersion: DATA_CONTROL_TOWER_CONTRACT_VERSION,
    schemaVersion: DATA_CONTROL_TOWER_SCHEMA_VERSION,
    generatedAt: input.sourceInventory.source.readTime,
    runId: input.sourceInventory.runId,
    axes: {
      sourceObservation: {
        status: 'OBSERVED',
        projectId: input.sourceInventory.source.projectId,
        databaseId: input.sourceInventory.source.databaseId,
        readTime: input.sourceInventory.source.readTime,
        digest: input.sourceInventory.source.digest,
        coverage: input.sourceInventory.source.coverage,
        products: input.sourceInventory.source.collections.products,
        policies: input.sourceInventory.source.collections.policy,
        partners: input.sourceInventory.source.collections.partner ?? null
      },
      auditFreshness: structuredClone(input.auditSchedule),
      publication: {
        decision: input.sourceInventory.authority.publicationDecision,
        activeReleaseAuthorized:
          input.sourceInventory.authority.activeReleaseAuthorized,
        canonicalWriteAuthorized:
          input.sourceInventory.authority.canonicalWriteAuthorized,
        destructiveActionAuthorized:
          input.sourceInventory.authority.destructiveActionAuthorized,
        holdReasons: [
          ...input.sourceInventory.authority.publicationHoldReasons
        ]
      },
      consumerHealth: structuredClone(input.consumerHealth),
      consumerReadiness: structuredClone(input.consumerReadiness),
      sheetHealth: structuredClone(input.sheetHealth),
      estimateMasterReadiness:
        input.estimateMasterReadiness == null
          ? null
          : structuredClone(input.estimateMasterReadiness)
    },
    operatorSummary: {
      readyTransitionCount:
        input.consumerReadiness.counts?.readyForNextStage ?? 0,
      consumerBlockedCount:
        input.consumerHealth.counts?.BLOCKED ?? null,
      readinessHoldCount:
        input.consumerReadiness.counts?.hold ?? null,
      auditGapMinutes: input.auditSchedule.gapMinutes,
      publicationHoldReasonCount:
        input.sourceInventory.authority.publicationHoldReasons.length,
      estimateCanonicalTrimCount:
        input.estimateMasterReadiness?.counts.total ?? null,
      estimateActiveTrimCount:
        input.estimateMasterReadiness?.counts.active ?? null,
      estimateHoldTrimCount:
        input.estimateMasterReadiness?.counts.hold ?? null
    },
    attention: attentionCodes(input)
  };
}
