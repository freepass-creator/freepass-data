import {
  readConsumerRuntimeEvidence,
  type ConsumerRuntimeEvidenceEntry,
  type ConsumerRuntimeEvidencePolicy
} from './consumer-runtime-evidence.js';
import {
  readSheetConsumerHealth,
  type SheetConsumerHealthEntry
} from './sheet-consumer-health.js';
import type { SheetEvidenceFreshnessPolicy } from './sheet-delivery-evidence.js';
import {
  CONSUMER_SWITCH_REGISTRY,
  type ConsumerCutoverStage,
  type ConsumerSwitchDecision,
  type ConsumerSwitchRegistration
} from '../domain/consumer-cutover.js';
import type { DataAccessEventReader } from '../ports/data-access.js';
import type { SheetDeliveryEvidenceStore } from '../ports/catalog-store.js';

export const CONSUMER_HEALTH_CONTRACT_VERSION =
  'consumer-health-v1' as const;
export const CONSUMER_HEALTH_SCHEMA_VERSION = '1.0.0' as const;

export type ConsumerHealthStatus = 'HEALTHY' | 'DEGRADED' | 'BLOCKED';

export type ConsumerHealthEvidenceSource =
  | 'GATEWAY_RUNTIME'
  | 'SHEET_DELIVERY'
  | 'WHITELABEL_AGGREGATE'
  | 'NOT_IMPLEMENTED';

export type ConsumerHealthEvidenceSummary = {
  source: ConsumerHealthEvidenceSource;
  state: string;
  observedAt: string | null;
  ageMs: number | null;
  eventId: string | null;
  receiptId: string | null;
  releaseAuthority: 'CANONICAL_ACTIVE' | 'LEGACY_VERIFIED_BRIDGE' | null;
  projectionId: string | null;
  releaseId: string | null;
  manifestId: string | null;
  authenticated: boolean;
  freepassReadVerified: boolean;
  productionReadbackVerified: boolean;
  parityVerified: boolean;
  fallbackVerified: boolean;
};

export type ConsumerHealthEntry = {
  consumerId: string;
  project: string;
  repository: string;
  domains: string[];
  status: ConsumerHealthStatus;
  currentStage: ConsumerCutoverStage;
  nextStage: ConsumerCutoverStage | null;
  activeReadOwner: string;
  targetReadOwner: 'freepass-data';
  switchKey: string;
  evidence: ConsumerHealthEvidenceSummary;
  nextTransition: ConsumerSwitchDecision | null;
  blockers: string[];
  staticHoldReasons: string[];
};

export type ConsumerHealthReport = {
  contractVersion: typeof CONSUMER_HEALTH_CONTRACT_VERSION;
  schemaVersion: typeof CONSUMER_HEALTH_SCHEMA_VERSION;
  generatedAt: string;
  status: ConsumerHealthStatus;
  policy: {
    maxAgeMs: number;
    maxFutureSkewMs: number;
    eventLimit: number;
  };
  consumers: ConsumerHealthEntry[];
};

export type ConsumerHealthPolicy =
  ConsumerRuntimeEvidencePolicy &
  SheetEvidenceFreshnessPolicy;

function statusOf(values: ConsumerHealthStatus[]): ConsumerHealthStatus {
  if (values.includes('BLOCKED')) return 'BLOCKED';
  if (values.includes('DEGRADED')) return 'DEGRADED';
  return 'HEALTHY';
}

function registrationMap() {
  return new Map(
    CONSUMER_SWITCH_REGISTRY.map((registration) => [
      registration.consumerId,
      registration
    ])
  );
}

function nonSheetStatus(
  entry: ConsumerRuntimeEvidenceEntry
): ConsumerHealthStatus {
  if (entry.runtime.state !== 'SUCCEEDED') return 'BLOCKED';
  if (entry.stage === 'FREEPASS_DATA_READ') {
    return entry.effectiveEvidence.productionReadbackVerified
      ? 'HEALTHY'
      : 'BLOCKED';
  }
  return entry.nextTransition?.allowed ? 'DEGRADED' : 'BLOCKED';
}

function runtimeSource(entry: ConsumerRuntimeEvidenceEntry): ConsumerHealthEvidenceSource {
  switch (entry.runtime.source) {
    case 'GATEWAY':
      return 'GATEWAY_RUNTIME';
    case 'WHITELABEL_AGGREGATE':
      return 'WHITELABEL_AGGREGATE';
    case 'NOT_IMPLEMENTED':
      return 'NOT_IMPLEMENTED';
    case 'SHEET_DELIVERY_EVIDENCE':
      return 'SHEET_DELIVERY';
  }
}

function runtimeEvidenceSummary(
  entry: ConsumerRuntimeEvidenceEntry
): ConsumerHealthEvidenceSummary {
  return {
    source: runtimeSource(entry),
    state: entry.runtime.state,
    observedAt: entry.runtime.occurredAt,
    ageMs: entry.runtime.ageMs,
    eventId: entry.runtime.eventId,
    receiptId: null,
    releaseAuthority:
      entry.runtime.approvedRelease ? 'CANONICAL_ACTIVE' : null,
    projectionId: entry.runtime.approvedRelease?.projectionId ?? null,
    releaseId: entry.runtime.approvedRelease?.releaseId ?? null,
    manifestId: entry.runtime.approvedRelease?.manifestId ?? null,
    authenticated: entry.effectiveEvidence.authenticationVerified,
    freepassReadVerified: entry.effectiveEvidence.freepassReadVerified,
    productionReadbackVerified:
      entry.effectiveEvidence.productionReadbackVerified,
    parityVerified: entry.effectiveEvidence.parityVerified,
    fallbackVerified: entry.effectiveEvidence.fallbackVerified
  };
}

function sheetEvidenceSummary(
  entry: SheetConsumerHealthEntry,
  registration: ConsumerSwitchRegistration
): ConsumerHealthEvidenceSummary {
  const observedAt =
    entry.evidence.publicationCompletedAt ??
    entry.evidence.recordedAt;
  return {
    source: 'SHEET_DELIVERY',
    state: entry.evidence.freshness?.status ?? 'UNOBSERVED',
    observedAt,
    ageMs: entry.evidence.freshness?.readbackAgeMs ?? null,
    eventId: null,
    receiptId: entry.evidence.receiptId,
    releaseAuthority: entry.evidence.releaseAuthority,
    projectionId: entry.evidence.projectionId,
    releaseId: entry.evidence.releaseId,
    manifestId: entry.evidence.manifestId,
    authenticated: registration.evidence.authenticationVerified,
    freepassReadVerified: entry.evidence.freepassReadVerified,
    productionReadbackVerified: entry.evidence.productionReadbackVerified,
    parityVerified: registration.evidence.parityVerified,
    fallbackVerified: registration.evidence.fallbackVerified
  };
}

function mergeBlockers(...groups: Array<readonly string[]>) {
  return [...new Set(groups.flat())];
}

function commonFields(
  registration: ConsumerSwitchRegistration,
  status: ConsumerHealthStatus,
  evidence: ConsumerHealthEvidenceSummary,
  nextTransition: ConsumerSwitchDecision | null,
  blockers: string[]
): ConsumerHealthEntry {
  return {
    consumerId: registration.consumerId,
    project: registration.project,
    repository: registration.repository,
    domains: [...registration.domains],
    status,
    currentStage: registration.stage,
    nextStage: nextTransition?.to ?? null,
    activeReadOwner: registration.activeReadOwner,
    targetReadOwner: registration.targetReadOwner,
    switchKey: registration.switchKey,
    evidence,
    nextTransition: nextTransition ? structuredClone(nextTransition) : null,
    blockers,
    staticHoldReasons: [...registration.holdReasons]
  };
}

export async function readConsumerHealth(
  accessEvents: DataAccessEventReader,
  sheetStore: SheetDeliveryEvidenceStore,
  policy: ConsumerHealthPolicy
): Promise<ConsumerHealthReport> {
  const eventLimit = policy.eventLimit ?? 1000;
  const [runtime, sheets] = await Promise.all([
    readConsumerRuntimeEvidence(accessEvents, policy),
    readSheetConsumerHealth(sheetStore, policy)
  ]);

  const registrations = registrationMap();
  const sheetById = new Map<string, SheetConsumerHealthEntry>(
    sheets.consumers.map((entry) => [entry.consumerId, entry])
  );

  const consumers = runtime.consumers.map((entry) => {
    const registration = registrations.get(entry.consumerId);
    if (!registration) {
      throw new Error('CONSUMER_HEALTH_REGISTRATION_MISSING');
    }

    const sheet = sheetById.get(entry.consumerId);
    if (sheet) {
      const evidence = sheetEvidenceSummary(sheet, registration);
      const blockers = mergeBlockers(
        sheet.blockers,
        sheet.nextTransition?.blockers ?? []
      );
      return commonFields(
        registration,
        sheet.status,
        evidence,
        sheet.nextTransition,
        blockers
      );
    }

    const evidence = runtimeEvidenceSummary(entry);
    const blockers = mergeBlockers(
      entry.runtime.blockers,
      entry.nextTransition?.blockers ?? []
    );
    return commonFields(
      registration,
      nonSheetStatus(entry),
      evidence,
      entry.nextTransition,
      blockers
    );
  });

  if (consumers.length !== CONSUMER_SWITCH_REGISTRY.length) {
    throw new Error('CONSUMER_HEALTH_COVERAGE_MISMATCH');
  }

  return {
    contractVersion: CONSUMER_HEALTH_CONTRACT_VERSION,
    schemaVersion: CONSUMER_HEALTH_SCHEMA_VERSION,
    generatedAt: policy.assessedAt,
    status: statusOf(consumers.map((entry) => entry.status)),
    policy: {
      maxAgeMs: policy.maxAgeMs,
      maxFutureSkewMs: policy.maxFutureSkewMs ?? 0,
      eventLimit
    },
    consumers
  };
}
