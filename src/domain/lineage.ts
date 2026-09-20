export type LineageStage =
  | 'RAW_TO_NORMALIZED'
  | 'NORMALIZED_TO_CANONICAL'
  | 'CANONICAL_TO_PROJECTION';

export type LineageValueRef = {
  fieldPath: string;
  value: unknown;
};

export type FieldLineageRecord = {
  lineageRecordId: string;
  lineageId: string;
  stage: LineageStage;
  parentLineageRecordId?: string | null;

  runId: string;
  sourceId: string;
  sourceRecordId: string;
  sourceFingerprint: string;
  observedAt: string;

  source: LineageValueRef;
  normalized?: {
    candidateId: string;
    fieldPath: string;
    value: unknown;
  } | null;
  canonical?: {
    entityType: string;
    entityId: string;
    revision: number;
    fieldPath: string;
    value: unknown;
  } | null;
  projection?: {
    projectionId: string;
    releaseId: string;
    fieldPath: string;
    value: unknown;
  } | null;

  transformId: string;
  transformVersion: string;
};
