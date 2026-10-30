export type SourceLineageStage =
  | 'RAW_TO_NORMALIZED'
  | 'NORMALIZED_TO_CANONICAL';

export type ProjectionLineageStage = 'CANONICAL_TO_PROJECTION';

export type LineageStage =
  | SourceLineageStage
  | ProjectionLineageStage;

export type LineageValueRef = {
  fieldPath: string;
  value: unknown;
};

export type FieldLineageRecord = {
  lineageRecordId: string;
  lineageId: string;
  stage: SourceLineageStage;
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

  /**
   * 실행 독립 fee lineage를 처음 만든 run의 감사 메타다.
   * 재사용 비교에서는 이 두 필드와 기존 runId/observedAt만 제외한다.
   */
  createdRunId?: string;
  createdObservedAt?: string;
};
