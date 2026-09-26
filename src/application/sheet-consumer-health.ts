import {
  assessLatestSheetConsumerCutover,
  type SheetEvidenceFreshnessPolicy,
  type SheetEvidenceFreshnessDecision
} from './sheet-delivery-evidence.js';
import type { SheetDeliveryEvidenceStore } from '../ports/catalog-store.js';
import {
  findConsumerSwitch,
  type ConsumerCutoverStage,
  type ConsumerSwitchDecision
} from '../domain/consumer-cutover.js';
import type {
  SheetConsumerId,
  SheetWorkbook,
  StoredSheetDeliveryEvidence
} from '../domain/consumer-delivery.js';

export const SHEET_CONSUMER_HEALTH_CONTRACT_VERSION =
  'sheet-consumer-health-v1' as const;
export const SHEET_CONSUMER_HEALTH_SCHEMA_VERSION = '1.0.0' as const;

export type SheetConsumerHealthStatus = 'HEALTHY' | 'DEGRADED' | 'BLOCKED';

type SheetEvidenceSummary = {
  receiptId: string | null;
  evidenceDigest: string | null;
  releaseAuthority: 'LEGACY_VERIFIED_BRIDGE' | 'CANONICAL_ACTIVE' | null;
  projectionId: string | null;
  releaseId: string | null;
  manifestId: string | null;
  publicationHandoffHash: string | null;
  publicationCompletedAt: string | null;
  recordedAt: string | null;
  freepassReadVerified: boolean;
  productionReadbackVerified: boolean;
  freshness: SheetEvidenceFreshnessDecision | null;
};

export type SheetConsumerHealthEntry = {
  consumerId: SheetConsumerId;
  workbook: SheetWorkbook;
  status: SheetConsumerHealthStatus;
  currentStage: ConsumerCutoverStage;
  nextStage: ConsumerCutoverStage | null;
  evidence: SheetEvidenceSummary;
  nextTransition: ConsumerSwitchDecision | null;
  blockers: string[];
};

export type SheetConsumerHealthReport = {
  contractVersion: typeof SHEET_CONSUMER_HEALTH_CONTRACT_VERSION;
  schemaVersion: typeof SHEET_CONSUMER_HEALTH_SCHEMA_VERSION;
  generatedAt: string;
  status: SheetConsumerHealthStatus;
  freshnessPolicy: {
    maxAgeMs: number;
    maxFutureSkewMs: number;
  };
  consumers: SheetConsumerHealthEntry[];
};

const SHEET_CONSUMERS = [
  { consumerId: 'google-sheets-f01', workbook: 'F01' },
  { consumerId: 'google-sheets-f86', workbook: 'F86' }
] as const;

const STAGES: ConsumerCutoverStage[] = [
  'LEGACY_DIRECT',
  'OBSERVE',
  'SHADOW_READ',
  'PARITY_VERIFIED',
  'FREEPASS_DATA_READ'
];

function nextStage(stage: ConsumerCutoverStage): ConsumerCutoverStage | null {
  const index = STAGES.indexOf(stage);
  return index >= 0 && index < STAGES.length - 1
    ? STAGES[index + 1]!
    : null;
}

function reportStatus(values: SheetConsumerHealthStatus[]): SheetConsumerHealthStatus {
  if (values.includes('BLOCKED')) return 'BLOCKED';
  if (values.includes('DEGRADED')) return 'DEGRADED';
  return 'HEALTHY';
}

function evidenceSummary(
  record: StoredSheetDeliveryEvidence | null,
  freshness: SheetEvidenceFreshnessDecision | null,
  freepassReadVerified: boolean,
  productionReadbackVerified: boolean
): SheetEvidenceSummary {
  return {
    receiptId: record?.receiptId ?? null,
    evidenceDigest: record?.evidenceDigest ?? null,
    releaseAuthority: record?.receipt.releaseAuthority ?? null,
    projectionId: record?.receipt.approvedRelease.projectionId ?? null,
    releaseId: record?.receipt.approvedRelease.releaseId ?? null,
    manifestId: record?.receipt.approvedRelease.manifestId ?? null,
    publicationHandoffHash: record?.receipt.publicationHandoffHash ?? null,
    publicationCompletedAt: record?.receipt.publicationCompletedAt ?? null,
    recordedAt: record?.recordedAt ?? null,
    freepassReadVerified,
    productionReadbackVerified,
    freshness
  };
}

function consumerStatus(input: {
  record: StoredSheetDeliveryEvidence | null;
  freshness: SheetEvidenceFreshnessDecision | null;
  nextTransition: ConsumerSwitchDecision | null;
}): SheetConsumerHealthStatus {
  if (!input.record || !input.freshness || input.freshness.status === 'HOLD') {
    return 'BLOCKED';
  }
  if (input.nextTransition && !input.nextTransition.allowed) {
    return 'BLOCKED';
  }
  return input.record.receipt.releaseAuthority === 'CANONICAL_ACTIVE'
    ? 'HEALTHY'
    : 'DEGRADED';
}

export async function readSheetConsumerHealth(
  store: SheetDeliveryEvidenceStore,
  freshnessPolicy: SheetEvidenceFreshnessPolicy
): Promise<SheetConsumerHealthReport> {
  if (!Number.isFinite(Date.parse(freshnessPolicy.assessedAt))) {
    throw new Error('INVALID_SHEET_CONSUMER_HEALTH_ASSESSED_AT');
  }

  const consumers: SheetConsumerHealthEntry[] = [];
  for (const target of SHEET_CONSUMERS) {
    const registration = findConsumerSwitch(target.consumerId);
    if (!registration) {
      throw new Error('SHEET_CONSUMER_REGISTRATION_MISSING');
    }
    const next = nextStage(registration.stage);
    const assessed = await assessLatestSheetConsumerCutover(
      store,
      registration,
      next ?? registration.stage,
      freshnessPolicy
    );

    const transition = next ? assessed.decision : null;
    const blockers = [
      ...(assessed.freshness?.blockers ?? []),
      ...(transition?.blockers ?? [])
    ];
    const status = consumerStatus({
      record: assessed.record,
      freshness: assessed.freshness,
      nextTransition: transition
    });

    consumers.push({
      consumerId: target.consumerId,
      workbook: target.workbook,
      status,
      currentStage: registration.stage,
      nextStage: next,
      evidence: evidenceSummary(
        assessed.record,
        assessed.freshness,
        assessed.registration.evidence.freepassReadVerified,
        assessed.registration.evidence.productionReadbackVerified
      ),
      nextTransition: transition ? structuredClone(transition) : null,
      blockers: [...new Set(blockers)]
    });
  }

  return {
    contractVersion: SHEET_CONSUMER_HEALTH_CONTRACT_VERSION,
    schemaVersion: SHEET_CONSUMER_HEALTH_SCHEMA_VERSION,
    generatedAt: freshnessPolicy.assessedAt,
    status: reportStatus(consumers.map((item) => item.status)),
    freshnessPolicy: {
      maxAgeMs: freshnessPolicy.maxAgeMs,
      maxFutureSkewMs: freshnessPolicy.maxFutureSkewMs ?? 0
    },
    consumers
  };
}
