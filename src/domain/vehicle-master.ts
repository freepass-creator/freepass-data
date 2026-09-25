import { stableDigest } from '../shared/stable-digest.js';

export const VEHICLE_MASTER_SCHEMA_VERSION = '1.0.0';

export type VehicleMasterStatus =
  | 'ACTIVE'
  | 'HOLD'
  | 'HISTORICAL'
  | 'DISCONTINUED';

export type VehicleMasterNodeType =
  | 'MAKE'
  | 'MODEL'
  | 'GENERATION'
  | 'PHASE'
  | 'MODEL_YEAR'
  | 'POWERTRAIN'
  | 'VARIANT'
  | 'TRIM'
  | 'BASE_ITEM'
  | 'OPTION'
  | 'PACKAGE'
  | 'OPTION_GROUP'
  | 'COLOR';

export type VehicleMasterRuleType =
  | 'REQUIRES'
  | 'EXCLUDES'
  | 'ONE_OF'
  | 'AT_LEAST_ONE'
  | 'MAX_SELECTION'
  | 'INCLUDES'
  | 'PRICE_OVERRIDE'
  | 'AVAILABLE_IF'
  | 'UNAVAILABLE_IF';

export type VehicleMasterRuleEffect = 'VALID' | 'INVALID' | 'UNKNOWN';

export type VehicleMasterEntityRefs = Record<string, string | null>;

export type VehicleMasterTemporal = {
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
};

export type VehicleMasterRecordMeta = VehicleMasterTemporal & {
  schemaVersion: typeof VEHICLE_MASTER_SCHEMA_VERSION;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sourceEvidenceIds: string[];
  contentHash: string;
};

export type VehicleMasterNode = VehicleMasterRecordMeta & {
  id: string;
  nodeType: VehicleMasterNodeType;
  status: VehicleMasterStatus;
  canonicalName: string;
  parentId?: string | null;
  refs: VehicleMasterEntityRefs;
  aliases: string[];
  attributes: Record<string, unknown>;
};

export type VehicleMasterCompatibilityRule = VehicleMasterRecordMeta & {
  id: string;
  subjectId: string;
  ruleType: VehicleMasterRuleType;
  targetIds: string[];
  scope: VehicleMasterEntityRefs;
  condition: Record<string, unknown> | null;
  effect: VehicleMasterRuleEffect;
  priority: number;
};

export type VehicleMasterPriceRevision = VehicleMasterRecordMeta & {
  id: string;
  targetId: string;
  priceType: 'BASE' | 'OPTION' | 'PACKAGE' | 'COLOR' | 'ADJUSTMENT';
  amount: number;
  currency: 'KRW';
  sourceDocumentIds: string[];
};

export type VehicleMasterSourceDocument = VehicleMasterTemporal & {
  sourceDocumentId: string;
  sourceType:
    | 'MANUFACTURER_OFFICIAL'
    | 'PUBLIC_CERTIFIED'
    | 'STRUCTURED_PROVIDER'
    | 'DANAWA'
    | 'CARNOON'
    | 'CARISYOU'
    | 'WIKICAR'
    | 'MARKET_LISTING'
    | 'MANUAL'
    | 'OTHER';
  sourceName: string;
  sourceUrl: string | null;
  publishedAt: string | null;
  observedAt: string;
  storagePath: string;
  sha256: string;
  mimeType: string | null;
  metadata: Record<string, unknown>;
  contentHash: string;
};

export type VehicleMasterPipelineKind =
  | 'RAW_RECORD'
  | 'NORMALIZED_RECORD'
  | 'CANDIDATE_FACT'
  | 'EVIDENCE_SET'
  | 'REVISION_CANDIDATE'
  | 'PROMOTION_RESULT'
  | 'CHANGE_EVENT';

export type VehicleMasterPipelineRecord = {
  recordId: string;
  kind: VehicleMasterPipelineKind;
  sourceDocumentId?: string | null;
  entityId?: string | null;
  observedAt: string;
  payload: Record<string, unknown>;
  contentHash: string;
};

export type VehicleMasterResolverFeedback = {
  feedbackId: string;
  assetId?: string | null;
  rawInputHash: string;
  candidateIds: string[];
  selectedEntityId: string | null;
  resolutionStatus: 'RESOLVED' | 'LIKELY' | 'AMBIGUOUS' | 'UNRESOLVED';
  reason: string;
  resolvedBy: string;
  resolvedAt: string;
  contentHash: string;
};

export type VehicleMasterWriteResult = 'CREATED' | 'UNCHANGED' | 'UPDATED';

const PREFIX: Record<VehicleMasterNodeType, string> = {
  MAKE: 'make',
  MODEL: 'model',
  GENERATION: 'gen',
  PHASE: 'phase',
  MODEL_YEAR: 'my',
  POWERTRAIN: 'pt',
  VARIANT: 'variant',
  TRIM: 'trim',
  BASE_ITEM: 'base',
  OPTION: 'opt',
  PACKAGE: 'pkg',
  OPTION_GROUP: 'og',
  COLOR: 'color',
};

const cleanText = (value: string, field: string) => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`VEHICLE_MASTER_INVALID:${field}`);
  return normalized;
};

const assertRevision = (revision: number) => {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('VEHICLE_MASTER_INVALID:revision');
  }
};

const assertTime = (value: string | null | undefined, field: string) => {
  if (value == null) return;
  if (!Number.isFinite(Date.parse(value))) throw new Error(`VEHICLE_MASTER_INVALID:${field}`);
};

const assertTemporal = (value: VehicleMasterTemporal) => {
  assertTime(value.effectiveFrom, 'effectiveFrom');
  assertTime(value.effectiveTo, 'effectiveTo');
  if (
    value.effectiveFrom &&
    value.effectiveTo &&
    Date.parse(value.effectiveFrom) >= Date.parse(value.effectiveTo)
  ) {
    throw new Error('VEHICLE_MASTER_INVALID:effectiveRange');
  }
};

const assertSha256 = (value: string, field: string) => {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`VEHICLE_MASTER_INVALID:${field}`);
};

const uniqueSorted = (values: readonly string[]) =>
  [...new Set(values.map((value) => cleanText(value, 'id')))].sort();

export function deterministicVehicleMasterId(
  nodeType: VehicleMasterNodeType,
  identity: Record<string, unknown>
): string {
  if (!identity || !Object.keys(identity).length) {
    throw new Error('VEHICLE_MASTER_IDENTITY_REQUIRED');
  }
  return `${PREFIX[nodeType]}_${stableDigest({ nodeType, identity }).slice(0, 24)}`;
}

export function deterministicVehicleMasterRecordId(
  namespace: string,
  identity: Record<string, unknown>
): string {
  return `${cleanText(namespace, 'namespace')}_${stableDigest(identity).slice(0, 24)}`;
}

export function sealVehicleMasterNode(
  input: Omit<VehicleMasterNode, 'schemaVersion' | 'contentHash'>
): VehicleMasterNode {
  assertRevision(input.revision);
  assertTemporal(input);
  assertTime(input.createdAt, 'createdAt');
  assertTime(input.updatedAt, 'updatedAt');

  const record = {
    ...input,
    id: cleanText(input.id, 'id'),
    canonicalName: cleanText(input.canonicalName, 'canonicalName'),
    aliases: uniqueSorted(input.aliases),
    sourceEvidenceIds: uniqueSorted(input.sourceEvidenceIds),
    schemaVersion: VEHICLE_MASTER_SCHEMA_VERSION,
  } satisfies Omit<VehicleMasterNode, 'contentHash'>;

  return { ...record, contentHash: stableDigest(record) };
}

export function sealVehicleMasterCompatibilityRule(
  input: Omit<VehicleMasterCompatibilityRule, 'schemaVersion' | 'contentHash'>
): VehicleMasterCompatibilityRule {
  assertRevision(input.revision);
  assertTemporal(input);
  assertTime(input.createdAt, 'createdAt');
  assertTime(input.updatedAt, 'updatedAt');
  if (!Number.isSafeInteger(input.priority)) {
    throw new Error('VEHICLE_MASTER_INVALID:priority');
  }

  const targetIds = uniqueSorted(input.targetIds);
  if (!targetIds.length && !['AVAILABLE_IF', 'UNAVAILABLE_IF'].includes(input.ruleType)) {
    throw new Error('VEHICLE_MASTER_INVALID:ruleTargets');
  }
  if (targetIds.includes(input.subjectId)) {
    throw new Error('VEHICLE_MASTER_INVALID:selfRule');
  }

  const record = {
    ...input,
    id: cleanText(input.id, 'id'),
    subjectId: cleanText(input.subjectId, 'subjectId'),
    targetIds,
    sourceEvidenceIds: uniqueSorted(input.sourceEvidenceIds),
    schemaVersion: VEHICLE_MASTER_SCHEMA_VERSION,
  } satisfies Omit<VehicleMasterCompatibilityRule, 'contentHash'>;

  return { ...record, contentHash: stableDigest(record) };
}

export function sealVehicleMasterPriceRevision(
  input: Omit<VehicleMasterPriceRevision, 'schemaVersion' | 'contentHash'>
): VehicleMasterPriceRevision {
  assertRevision(input.revision);
  assertTemporal(input);
  assertTime(input.createdAt, 'createdAt');
  assertTime(input.updatedAt, 'updatedAt');
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
    throw new Error('VEHICLE_MASTER_INVALID:amount');
  }

  const record = {
    ...input,
    id: cleanText(input.id, 'id'),
    targetId: cleanText(input.targetId, 'targetId'),
    sourceEvidenceIds: uniqueSorted(input.sourceEvidenceIds),
    sourceDocumentIds: uniqueSorted(input.sourceDocumentIds),
    schemaVersion: VEHICLE_MASTER_SCHEMA_VERSION,
  } satisfies Omit<VehicleMasterPriceRevision, 'contentHash'>;

  return { ...record, contentHash: stableDigest(record) };
}

export function sealVehicleMasterSourceDocument(
  input: Omit<VehicleMasterSourceDocument, 'contentHash'>
): VehicleMasterSourceDocument {
  assertTemporal(input);
  assertTime(input.observedAt, 'observedAt');
  assertTime(input.publishedAt, 'publishedAt');
  assertSha256(input.sha256, 'sha256');
  if (!input.storagePath.trim()) throw new Error('VEHICLE_MASTER_STORAGE_PATH_REQUIRED');

  const record = {
    ...input,
    sourceDocumentId: cleanText(input.sourceDocumentId, 'sourceDocumentId'),
    sourceName: cleanText(input.sourceName, 'sourceName'),
    storagePath: cleanText(input.storagePath, 'storagePath'),
    sha256: input.sha256.toLowerCase(),
  };

  return { ...record, contentHash: stableDigest(record) };
}

export function sealVehicleMasterPipelineRecord(
  input: Omit<VehicleMasterPipelineRecord, 'contentHash'>
): VehicleMasterPipelineRecord {
  assertTime(input.observedAt, 'observedAt');
  const record = {
    ...input,
    recordId: cleanText(input.recordId, 'recordId'),
  };
  return { ...record, contentHash: stableDigest(record) };
}

export function sealVehicleMasterResolverFeedback(
  input: Omit<VehicleMasterResolverFeedback, 'contentHash'>
): VehicleMasterResolverFeedback {
  assertTime(input.resolvedAt, 'resolvedAt');
  assertSha256(input.rawInputHash, 'rawInputHash');
  const record = {
    ...input,
    feedbackId: cleanText(input.feedbackId, 'feedbackId'),
    candidateIds: uniqueSorted(input.candidateIds),
    reason: cleanText(input.reason, 'reason'),
    resolvedBy: cleanText(input.resolvedBy, 'resolvedBy'),
  };
  return { ...record, contentHash: stableDigest(record) };
}
