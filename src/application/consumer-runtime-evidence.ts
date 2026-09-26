import type { DataAccessEvent } from '../domain/data-access.js';
import {
  CONSUMER_SWITCH_REGISTRY,
  evaluateConsumerCutover,
  type ApprovedReleaseEvidence,
  type ConsumerCutoverEvidence,
  type ConsumerCutoverStage,
  type ConsumerSwitchDecision,
  type ConsumerSwitchRegistration
} from '../domain/consumer-cutover.js';
import type { DataAccessEventReader } from '../ports/data-access.js';

export const CONSUMER_RUNTIME_EVIDENCE_CONTRACT_VERSION =
  'consumer-runtime-evidence-v1' as const;

export type ConsumerRuntimeEvidencePolicy = {
  assessedAt: string;
  maxAgeMs: number;
  maxFutureSkewMs?: number;
  eventLimit?: number;
};

type GatewaySource = {
  kind: 'GATEWAY';
  clientId: string;
  operation: 'READ_CONSUMER_CATALOG' | 'READ_ESTIMATE_NEWCAR_MASTER';
};

type RuntimeSource =
  | GatewaySource
  | { kind: 'WHITELABEL_AGGREGATE' }
  | { kind: 'SHEET_DELIVERY_EVIDENCE' }
  | { kind: 'NOT_IMPLEMENTED' };

export type ConsumerRuntimeObservationState =
  | 'SUCCEEDED'
  | 'DENIED'
  | 'FAILED'
  | 'INCOMPLETE'
  | 'STALE'
  | 'FUTURE'
  | 'UNOBSERVED'
  | 'SEPARATE_EVIDENCE_SOURCE'
  | 'AGGREGATE_REQUIRES_IDENTITIES'
  | 'NOT_IMPLEMENTED';

export type ConsumerRuntimeObservation = {
  source: RuntimeSource['kind'];
  state: ConsumerRuntimeObservationState;
  clientId: string | null;
  operation: string | null;
  eventId: string | null;
  operationId: string | null;
  occurredAt: string | null;
  ageMs: number | null;
  reasonCode: string | null;
  approvedRelease: ApprovedReleaseEvidence | null;
  observedClientIds: string[];
  blockers: string[];
};

export type ConsumerRuntimeEvidenceEntry = {
  consumerId: string;
  stage: ConsumerCutoverStage;
  nextStage: ConsumerCutoverStage | null;
  staticEvidence: ConsumerCutoverEvidence;
  runtime: ConsumerRuntimeObservation;
  effectiveEvidence: ConsumerCutoverEvidence;
  nextTransition: ConsumerSwitchDecision | null;
};

export type ConsumerRuntimeEvidenceReport = {
  contractVersion: typeof CONSUMER_RUNTIME_EVIDENCE_CONTRACT_VERSION;
  generatedAt: string;
  eventWindow: {
    maxAgeMs: number;
    maxFutureSkewMs: number;
    eventLimit: number;
  };
  consumers: ConsumerRuntimeEvidenceEntry[];
};

const ORDER: ConsumerCutoverStage[] = [
  'LEGACY_DIRECT',
  'OBSERVE',
  'SHADOW_READ',
  'PARITY_VERIFIED',
  'FREEPASS_DATA_READ'
];

const sourceFor = (consumerId: string): RuntimeSource => {
  switch (consumerId) {
    case 'erp-com-public-catalog':
      return {
        kind: 'GATEWAY',
        clientId: 'erp-com',
        operation: 'READ_CONSUMER_CATALOG'
      };
    case 'freepass-admin-catalog':
      return {
        kind: 'GATEWAY',
        clientId: 'freepass-admin-catalog',
        operation: 'READ_CONSUMER_CATALOG'
      };
    case 'freepass-estimate-catalog':
      return {
        kind: 'GATEWAY',
        clientId: 'freepass-estimate',
        operation: 'READ_ESTIMATE_NEWCAR_MASTER'
      };
    case 'kakao-ops-catalog':
      return {
        kind: 'GATEWAY',
        clientId: 'kakao-ops',
        operation: 'READ_CONSUMER_CATALOG'
      };
    case 'erp-whitelabel-catalogs':
      return { kind: 'WHITELABEL_AGGREGATE' };
    case 'google-sheets-f01':
    case 'google-sheets-f86':
      return { kind: 'SHEET_DELIVERY_EVIDENCE' };
    default:
      return { kind: 'NOT_IMPLEMENTED' };
  }
};

function assertPolicy(policy: ConsumerRuntimeEvidencePolicy) {
  const eventLimit = policy.eventLimit ?? 1000;
  if (
    !Number.isFinite(Date.parse(policy.assessedAt)) ||
    !Number.isSafeInteger(policy.maxAgeMs) ||
    policy.maxAgeMs <= 0 ||
    !Number.isSafeInteger(eventLimit) ||
    eventLimit < 1 ||
    eventLimit > 5000 ||
    (policy.maxFutureSkewMs !== undefined &&
      (!Number.isSafeInteger(policy.maxFutureSkewMs) ||
        policy.maxFutureSkewMs < 0))
  ) {
    throw new Error('INVALID_CONSUMER_RUNTIME_EVIDENCE_POLICY');
  }
}

function nextStage(stage: ConsumerCutoverStage): ConsumerCutoverStage | null {
  const index = ORDER.indexOf(stage);
  return index >= 0 && index < ORDER.length - 1
    ? ORDER[index + 1]!
    : null;
}

const terminal = (event: DataAccessEvent) =>
  event.phase === 'SUCCEEDED' ||
  event.phase === 'DENIED' ||
  event.phase === 'FAILED';

function sortEvents(events: readonly DataAccessEvent[]) {
  return [...events].sort((a, b) =>
    Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
    b.eventId.localeCompare(a.eventId)
  );
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function approvedRelease(event: DataAccessEvent): ApprovedReleaseEvidence | null {
  const result = event.result;
  const projectionId = event.resource.projectionId;
  if (
    event.phase !== 'SUCCEEDED' ||
    !projectionId ||
    !result?.releaseId ||
    !result.manifestId ||
    !validDigest(result.inputDigest) ||
    !validDigest(result.digest)
  ) {
    return null;
  }
  return {
    projectionId,
    releaseId: result.releaseId,
    manifestId: result.manifestId,
    inputDigest: result.inputDigest,
    dataDigest: result.digest,
    observedAt: event.occurredAt
  };
}

function gatewayObservation(
  events: readonly DataAccessEvent[],
  source: GatewaySource,
  policy: ConsumerRuntimeEvidencePolicy
): ConsumerRuntimeObservation {
  const relevant = sortEvents(events.filter((event) =>
    event.mode === 'READ' &&
    event.clientId === source.clientId &&
    event.operation === source.operation
  ));

  if (!relevant.length) {
    return {
      source: 'GATEWAY',
      state: 'UNOBSERVED',
      clientId: source.clientId,
      operation: source.operation,
      eventId: null,
      operationId: null,
      occurredAt: null,
      ageMs: null,
      reasonCode: null,
      approvedRelease: null,
      observedClientIds: [],
      blockers: ['RUNTIME_CONSUMER_READ_NOT_OBSERVED']
    };
  }

  const byOperation = new Map<string, DataAccessEvent[]>();
  for (const event of relevant) {
    const rows = byOperation.get(event.operationId) ?? [];
    rows.push(event);
    byOperation.set(event.operationId, rows);
  }

  const latest = relevant[0]!;
  const sameOperation = byOperation.get(latest.operationId) ?? [];
  let selected = latest;
  if (latest.phase === 'STARTED') {
    const completed = sortEvents(sameOperation.filter(terminal))[0];
    if (!completed) {
      return {
        source: 'GATEWAY',
        state: 'INCOMPLETE',
        clientId: source.clientId,
        operation: source.operation,
        eventId: latest.eventId,
        operationId: latest.operationId,
        occurredAt: latest.occurredAt,
        ageMs: Math.max(0, Date.parse(policy.assessedAt) - Date.parse(latest.occurredAt)),
        reasonCode: null,
        approvedRelease: null,
        observedClientIds: [],
        blockers: ['LATEST_RUNTIME_OPERATION_INCOMPLETE']
      };
    }
    selected = completed;
  } else if (!terminal(selected)) {
    selected = sortEvents(relevant.filter(terminal))[0] ?? selected;
  }

  const assessedAt = Date.parse(policy.assessedAt);
  const occurredAt = Date.parse(selected.occurredAt);
  const skew = policy.maxFutureSkewMs ?? 0;
  const ageMs = Math.max(0, assessedAt - occurredAt);

  if (occurredAt > assessedAt + skew) {
    return {
      source: 'GATEWAY',
      state: 'FUTURE',
      clientId: source.clientId,
      operation: source.operation,
      eventId: selected.eventId,
      operationId: selected.operationId,
      occurredAt: selected.occurredAt,
      ageMs,
      reasonCode: selected.reasonCode ?? null,
      approvedRelease: null,
      observedClientIds: [],
      blockers: ['RUNTIME_CONSUMER_READ_FROM_FUTURE']
    };
  }
  if (ageMs > policy.maxAgeMs) {
    return {
      source: 'GATEWAY',
      state: 'STALE',
      clientId: source.clientId,
      operation: source.operation,
      eventId: selected.eventId,
      operationId: selected.operationId,
      occurredAt: selected.occurredAt,
      ageMs,
      reasonCode: selected.reasonCode ?? null,
      approvedRelease: null,
      observedClientIds: [],
      blockers: ['RUNTIME_CONSUMER_READ_STALE']
    };
  }

  if (selected.phase === 'DENIED') {
    return {
      source: 'GATEWAY',
      state: 'DENIED',
      clientId: source.clientId,
      operation: source.operation,
      eventId: selected.eventId,
      operationId: selected.operationId,
      occurredAt: selected.occurredAt,
      ageMs,
      reasonCode: selected.reasonCode ?? null,
      approvedRelease: null,
      observedClientIds: [],
      blockers: [
        `RUNTIME_CONSUMER_READ_DENIED:${selected.reasonCode ?? 'UNKNOWN'}`
      ]
    };
  }

  if (selected.phase === 'FAILED') {
    return {
      source: 'GATEWAY',
      state: 'FAILED',
      clientId: source.clientId,
      operation: source.operation,
      eventId: selected.eventId,
      operationId: selected.operationId,
      occurredAt: selected.occurredAt,
      ageMs,
      reasonCode: selected.reasonCode ?? null,
      approvedRelease: null,
      observedClientIds: [],
      blockers: [
        `RUNTIME_CONSUMER_READ_FAILED:${selected.reasonCode ?? 'UNKNOWN'}`
      ]
    };
  }

  const release = approvedRelease(selected);
  if (!release) {
    return {
      source: 'GATEWAY',
      state: 'FAILED',
      clientId: source.clientId,
      operation: source.operation,
      eventId: selected.eventId,
      operationId: selected.operationId,
      occurredAt: selected.occurredAt,
      ageMs,
      reasonCode: 'INCOMPLETE_RELEASE_EVIDENCE',
      approvedRelease: null,
      observedClientIds: [],
      blockers: ['RUNTIME_CONSUMER_RELEASE_EVIDENCE_INCOMPLETE']
    };
  }

  return {
    source: 'GATEWAY',
    state: 'SUCCEEDED',
    clientId: source.clientId,
    operation: source.operation,
    eventId: selected.eventId,
    operationId: selected.operationId,
    occurredAt: selected.occurredAt,
    ageMs,
    reasonCode: null,
    approvedRelease: release,
    observedClientIds: [],
    blockers: []
  };
}

function observationFor(
  registration: ConsumerSwitchRegistration,
  events: readonly DataAccessEvent[],
  policy: ConsumerRuntimeEvidencePolicy
): ConsumerRuntimeObservation {
  const source = sourceFor(registration.consumerId);
  if (source.kind === 'GATEWAY') {
    return gatewayObservation(events, source, policy);
  }
  if (source.kind === 'WHITELABEL_AGGREGATE') {
    const observedClientIds = [...new Set(
      events
        .filter((event) =>
          event.mode === 'READ' &&
          event.operation === 'READ_CONSUMER_CATALOG' &&
          event.clientId.startsWith('whitelabel-')
        )
        .map((event) => event.clientId)
    )].sort();
    return {
      source: source.kind,
      state: 'AGGREGATE_REQUIRES_IDENTITIES',
      clientId: null,
      operation: 'READ_CONSUMER_CATALOG',
      eventId: null,
      operationId: null,
      occurredAt: null,
      ageMs: null,
      reasonCode: null,
      approvedRelease: null,
      observedClientIds,
      blockers: ['WHITELABEL_AGGREGATE_REQUIRES_ALL_REGISTERED_IDENTITIES']
    };
  }
  if (source.kind === 'SHEET_DELIVERY_EVIDENCE') {
    return {
      source: source.kind,
      state: 'SEPARATE_EVIDENCE_SOURCE',
      clientId: null,
      operation: null,
      eventId: null,
      operationId: null,
      occurredAt: null,
      ageMs: null,
      reasonCode: null,
      approvedRelease: null,
      observedClientIds: [],
      blockers: []
    };
  }
  return {
    source: source.kind,
    state: 'NOT_IMPLEMENTED',
    clientId: null,
    operation: null,
    eventId: null,
    operationId: null,
    occurredAt: null,
    ageMs: null,
    reasonCode: null,
    approvedRelease: null,
    observedClientIds: [],
    blockers: ['RUNTIME_CONSUMER_GATEWAY_NOT_IMPLEMENTED']
  };
}

function applyRuntimeEvidence(
  staticEvidence: ConsumerCutoverEvidence,
  runtime: ConsumerRuntimeObservation
): ConsumerCutoverEvidence {
  if (runtime.state !== 'SUCCEEDED' || !runtime.approvedRelease) {
    return structuredClone(staticEvidence);
  }
  return {
    ...structuredClone(staticEvidence),
    authenticationVerified: true,
    freepassReadVerified: true,
    approvedRelease: structuredClone(runtime.approvedRelease)
  };
}

export function buildConsumerRuntimeEvidenceReport(
  events: readonly DataAccessEvent[],
  policy: ConsumerRuntimeEvidencePolicy
): ConsumerRuntimeEvidenceReport {
  assertPolicy(policy);
  const eventLimit = policy.eventLimit ?? 1000;
  const consumers = CONSUMER_SWITCH_REGISTRY.map((registration) => {
    const runtime = observationFor(registration, events, policy);
    const effectiveEvidence = applyRuntimeEvidence(
      registration.evidence,
      runtime
    );
    const next = nextStage(registration.stage);
    let transition: ConsumerSwitchDecision | null = null;
    if (next) {
      transition = evaluateConsumerCutover(
        { ...registration, evidence: effectiveEvidence },
        next
      );
      if (
        sourceFor(registration.consumerId).kind === 'GATEWAY' &&
        next !== 'OBSERVE' &&
        runtime.state !== 'SUCCEEDED'
      ) {
        transition.allowed = false;
        transition.blockers = [
          ...new Set([...transition.blockers, ...runtime.blockers])
        ];
      }
    }

    return {
      consumerId: registration.consumerId,
      stage: registration.stage,
      nextStage: next,
      staticEvidence: structuredClone(registration.evidence),
      runtime,
      effectiveEvidence,
      nextTransition: transition
    };
  });

  return {
    contractVersion: CONSUMER_RUNTIME_EVIDENCE_CONTRACT_VERSION,
    generatedAt: policy.assessedAt,
    eventWindow: {
      maxAgeMs: policy.maxAgeMs,
      maxFutureSkewMs: policy.maxFutureSkewMs ?? 0,
      eventLimit
    },
    consumers
  };
}

export async function readConsumerRuntimeEvidence(
  reader: DataAccessEventReader,
  policy: ConsumerRuntimeEvidencePolicy
) {
  assertPolicy(policy);
  const events = await reader.listRecentDataAccessEvents(policy.eventLimit ?? 1000);
  return buildConsumerRuntimeEvidenceReport(events, policy);
}
