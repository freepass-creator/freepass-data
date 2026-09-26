import {
  readConsumerHealth,
  type ConsumerHealthEntry,
  type ConsumerHealthPolicy,
  type ConsumerHealthReport
} from './consumer-health.js';
import {
  CONSUMER_SWITCH_REGISTRY,
  type ConsumerCutoverStage
} from '../domain/consumer-cutover.js';
import type { DataAccessEventReader } from '../ports/data-access.js';
import type { SheetDeliveryEvidenceStore } from '../ports/catalog-store.js';

export const CONSUMER_READINESS_CONTRACT_VERSION =
  'consumer-readiness-v1' as const;
export const CONSUMER_READINESS_SCHEMA_VERSION = '1.0.0' as const;

export type ConsumerReadinessState =
  | 'READY_FOR_NEXT_STAGE'
  | 'HOLD'
  | 'FINAL';

export type ConsumerRequiredAction =
  | 'IMPLEMENT_CONSUMER_CONTRACT'
  | 'PROVISION_CONSUMER_AUTH'
  | 'VERIFY_LEGACY_READ'
  | 'VERIFY_FREEPASS_READ'
  | 'VERIFY_PARITY'
  | 'VERIFY_FALLBACK'
  | 'VERIFY_PRODUCTION_READBACK'
  | 'VERIFY_APPROVED_RELEASE'
  | 'GENERATE_RUNTIME_READ_EVIDENCE'
  | 'FIX_RUNTIME_AUTHENTICATION'
  | 'FIX_RUNTIME_READ'
  | 'REFRESH_RUNTIME_EVIDENCE'
  | 'FIX_EVIDENCE_CLOCK'
  | 'COMPLETE_RUNTIME_OPERATION'
  | 'VERIFY_WHITELABEL_IDENTITIES'
  | 'RECORD_SHEET_DELIVERY_EVIDENCE'
  | 'REVIEW_STATIC_HOLD';

export type ConsumerReadinessEntry = {
  consumerId: string;
  project: string;
  currentStage: ConsumerCutoverStage;
  nextStage: ConsumerCutoverStage | null;
  readiness: ConsumerReadinessState;
  transitionAllowed: boolean | null;
  healthStatus: ConsumerHealthEntry['status'];
  evidenceSource: ConsumerHealthEntry['evidence']['source'];
  evidenceState: string;
  evidenceAgeMs: number | null;
  releaseId: string | null;
  missingEvidence: string[];
  blockers: string[];
  staticHoldReasons: string[];
  requiredActions: ConsumerRequiredAction[];
};

export type ConsumerReadinessReport = {
  contractVersion: typeof CONSUMER_READINESS_CONTRACT_VERSION;
  schemaVersion: typeof CONSUMER_READINESS_SCHEMA_VERSION;
  generatedAt: string;
  counts: {
    readyForNextStage: number;
    hold: number;
    final: number;
  };
  readyTransitions: Array<{
    consumerId: string;
    from: ConsumerCutoverStage;
    to: ConsumerCutoverStage;
  }>;
  consumers: ConsumerReadinessEntry[];
};

const registrationById = () =>
  new Map(
    CONSUMER_SWITCH_REGISTRY.map((registration) => [
      registration.consumerId,
      registration
    ])
  );

function missingEvidence(blockers: readonly string[]) {
  return blockers
    .filter((blocker) => blocker.startsWith('missing evidence: '))
    .map((blocker) => blocker.slice('missing evidence: '.length))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
}

function actionForEvidence(key: string): ConsumerRequiredAction | null {
  switch (key) {
    case 'contractReady':
      return 'IMPLEMENT_CONSUMER_CONTRACT';
    case 'authenticationVerified':
      return 'PROVISION_CONSUMER_AUTH';
    case 'legacyReadVerified':
      return 'VERIFY_LEGACY_READ';
    case 'freepassReadVerified':
      return 'VERIFY_FREEPASS_READ';
    case 'parityVerified':
      return 'VERIFY_PARITY';
    case 'fallbackVerified':
      return 'VERIFY_FALLBACK';
    case 'productionReadbackVerified':
      return 'VERIFY_PRODUCTION_READBACK';
    case 'approvedRelease':
      return 'VERIFY_APPROVED_RELEASE';
    default:
      return null;
  }
}

function runtimeActions(entry: ConsumerHealthEntry): ConsumerRequiredAction[] {
  if (entry.evidence.source === 'WHITELABEL_AGGREGATE') {
    return ['VERIFY_WHITELABEL_IDENTITIES'];
  }
  if (entry.evidence.source === 'NOT_IMPLEMENTED') {
    return ['IMPLEMENT_CONSUMER_CONTRACT'];
  }
  if (entry.evidence.source === 'SHEET_DELIVERY') {
    if (!entry.evidence.receiptId) {
      return ['RECORD_SHEET_DELIVERY_EVIDENCE'];
    }
    if (entry.evidence.state === 'HOLD') {
      return ['REFRESH_RUNTIME_EVIDENCE'];
    }
    return [];
  }

  switch (entry.evidence.state) {
    case 'UNOBSERVED':
      return ['GENERATE_RUNTIME_READ_EVIDENCE'];
    case 'DENIED':
      return ['FIX_RUNTIME_AUTHENTICATION'];
    case 'FAILED':
      return ['FIX_RUNTIME_READ'];
    case 'STALE':
      return ['REFRESH_RUNTIME_EVIDENCE'];
    case 'FUTURE':
      return ['FIX_EVIDENCE_CLOCK'];
    case 'INCOMPLETE':
      return ['COMPLETE_RUNTIME_OPERATION'];
    default:
      return [];
  }
}

function requiredActions(
  entry: ConsumerHealthEntry,
  missing: readonly string[],
  contractReady: boolean
): ConsumerRequiredAction[] {
  const actions: ConsumerRequiredAction[] = [];
  if (!contractReady) actions.push('IMPLEMENT_CONSUMER_CONTRACT');
  for (const key of missing) {
    const action = actionForEvidence(key);
    if (action) actions.push(action);
  }
  actions.push(...runtimeActions(entry));

  if (
    entry.staticHoldReasons.length > 0 &&
    entry.nextTransition &&
    !entry.nextTransition.allowed &&
    entry.blockers.some((blocker) => blocker.startsWith('HOLD: '))
  ) {
    actions.push('REVIEW_STATIC_HOLD');
  }

  return [...new Set(actions)];
}

function readinessOf(
  entry: ConsumerHealthEntry,
  contractReady: boolean
): ConsumerReadinessState {
  if (entry.currentStage === 'FREEPASS_DATA_READ') {
    return entry.status === 'HEALTHY' ? 'FINAL' : 'HOLD';
  }
  if (!contractReady) return 'HOLD';
  if (entry.evidence.source === 'NOT_IMPLEMENTED') return 'HOLD';
  return entry.nextTransition?.allowed === true &&
    entry.status !== 'BLOCKED'
    ? 'READY_FOR_NEXT_STAGE'
    : 'HOLD';
}

export function buildConsumerReadiness(
  health: ConsumerHealthReport
): ConsumerReadinessReport {
  const registrations = registrationById();

  const consumers = health.consumers.map((entry) => {
    if (!registrations.has(entry.consumerId)) {
      throw new Error('CONSUMER_READINESS_REGISTRATION_MISSING');
    }
    const registration = registrations.get(entry.consumerId)!;
    const missing = missingEvidence(entry.blockers);
    const readiness = readinessOf(
      entry,
      registration.evidence.contractReady
    );
    return {
      consumerId: entry.consumerId,
      project: entry.project,
      currentStage: entry.currentStage,
      nextStage: entry.nextStage,
      readiness,
      transitionAllowed: entry.nextTransition?.allowed ?? null,
      healthStatus: entry.status,
      evidenceSource: entry.evidence.source,
      evidenceState: entry.evidence.state,
      evidenceAgeMs: entry.evidence.ageMs,
      releaseId: entry.evidence.releaseId,
      missingEvidence: missing,
      blockers: [...entry.blockers],
      staticHoldReasons: [...entry.staticHoldReasons],
      requiredActions: readiness === 'FINAL'
        ? []
        : requiredActions(
            entry,
            missing,
            registration.evidence.contractReady
          )
    } satisfies ConsumerReadinessEntry;
  });

  if (consumers.length !== CONSUMER_SWITCH_REGISTRY.length) {
    throw new Error('CONSUMER_READINESS_COVERAGE_MISMATCH');
  }

  const readyTransitions = consumers.flatMap((entry) =>
    entry.readiness === 'READY_FOR_NEXT_STAGE' && entry.nextStage
      ? [{
          consumerId: entry.consumerId,
          from: entry.currentStage,
          to: entry.nextStage
        }]
      : []
  );

  return {
    contractVersion: CONSUMER_READINESS_CONTRACT_VERSION,
    schemaVersion: CONSUMER_READINESS_SCHEMA_VERSION,
    generatedAt: health.generatedAt,
    counts: {
      readyForNextStage: consumers.filter(
        (entry) => entry.readiness === 'READY_FOR_NEXT_STAGE'
      ).length,
      hold: consumers.filter((entry) => entry.readiness === 'HOLD').length,
      final: consumers.filter((entry) => entry.readiness === 'FINAL').length
    },
    readyTransitions,
    consumers
  };
}

export async function readConsumerReadiness(
  accessEvents: DataAccessEventReader,
  sheetStore: SheetDeliveryEvidenceStore,
  policy: ConsumerHealthPolicy
) {
  const health = await readConsumerHealth(accessEvents, sheetStore, policy);
  return buildConsumerReadiness(health);
}
