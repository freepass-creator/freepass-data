import type {
  VehicleSelectorAction,
  VehicleSelectorActionState,
  VehicleSelectorAxis,
  VehicleSelectorFinalizationDecision,
  VehicleSelectorFinalizationReason,
  VehicleSelectorNoResultReason,
  VehicleSelectorResult,
  VehicleSelectionReceiptRevalidationDecision,
  VehicleSelectionReceiptRevalidationReason,
} from '../domain/vehicle-selector.js';

export const VEHICLE_FINDER_UI_SCHEMA = 'freepass.vehicle-finder.ui/v1' as const;

export type VehicleFinderPresentation = 'GUIDED' | 'SEARCH_FILTER';
export type VehicleFinderCoverage = 'COMPLETE' | 'PARTIAL';

export type VehicleFinderUiFacet = {
  axis: string;
  label: string;
  options: Array<{
    key: string;
    label: string;
    count?: number;
  }>;
};

export type VehicleFinderUiFact = {
  label: string;
  value?: string | number | null;
  unknown: boolean;
};

export type VehicleFinderCandidateDisplay = {
  label: string;
  pathText: string;
  nodeTypeLabel: string;
  listLines?: string[];
  facts: VehicleFinderUiFact[];
  evidenceIds: string[];
  sources?: Array<{ id: string; label?: string }>;
  freshness?: { code: string; label: string };
  confidenceLabel?: string;
};

export type VehicleFinderPresenterInput = {
  result: VehicleSelectorResult;
  presentation: VehicleFinderPresentation;
  observation: {
    id: string;
    observedAt: string;
    coverage: VehicleFinderCoverage;
  };
  facets: VehicleFinderUiFacet[];
  displayByRecordId: Readonly<Record<string, VehicleFinderCandidateDisplay>>;
  hasMore?: boolean;
  excludedUnknownFacetCount?: number;
};

export type VehicleFinderUiSnapshot = {
  schemaVersion: typeof VEHICLE_FINDER_UI_SCHEMA;
  mode: VehicleSelectorResult['mode'];
  presentation: VehicleFinderPresentation;
  guidance: {
    resolutionStatus: VehicleSelectorResult['guidance']['resolutionStatus'];
    suggestedNextAxis: VehicleSelectorAxis | null;
    noResultReason: VehicleSelectorNoResultReason | null;
    noResultTitle: string | null;
    noResultMessage: string | null;
    selectableCount: number;
    inspectOnlyCount: number;
    blockedCount: number;
  };
  observationId: string;
  observedAt: string;
  coverage: VehicleFinderCoverage;
  total: number;
  hasMore: boolean;
  excludedUnknownFacetCount?: number;
  facets: VehicleFinderUiFacet[];
  groups: Array<{
    id: string;
    scope: VehicleSelectorResult['groups'][number]['scope'];
    label: string;
    context: string | null;
    representativeId: string;
    memberIds: string[];
    candidateCount: number;
    selectableCount: number;
    inspectOnlyCount: number;
    blockedCount: number;
    expandable: boolean;
    suggestedDrilldownAxis: VehicleSelectorAxis | null;
    suggestedDrilldownLabel: string | null;
    drilldowns: Array<{
      axis: VehicleSelectorAxis;
      label: string | null;
      selectableCandidateCount: number;
      unknownValueCount: number;
      options: Array<{
        id: string | null;
        label: string;
        value: number | null;
        count: number;
      }>;
    }>;
  }>;
  items: Array<{
    id: string;
    label: string;
    pathText: string;
    nodeTypeLabel: string;
    state: {
      code: VehicleSelectorActionState;
      label: string;
      tone: 'ok' | 'warn' | 'bad';
    };
    action: {
      code: VehicleSelectorAction;
      label: string;
      reasons: string[];
      reasonDetails: Array<{
        code: string;
        title: string;
        message: string;
        nextStep: string;
      }>;
    };
    unresolved: {
      axes: Array<{
        code: VehicleSelectorAxis;
        label: string | null;
      }>;
      searchTokenCount: number;
    };
    listLines?: string[];
    facts: VehicleFinderUiFact[];
    evidenceIds: string[];
    sources?: Array<{ id: string; label?: string }>;
    freshness?: { code: string; label: string };
    confidenceLabel?: string;
    selectable: boolean;
  }>;
};

const ACTION_STATE_PRESENTATION: Record<
  VehicleSelectorActionState,
  { label: string; tone: 'ok' | 'warn' | 'bad' }
> = {
  ACTIVE: { label: '사용 가능', tone: 'ok' },
  UNKNOWN: { label: '확인 필요', tone: 'warn' },
  HOLD: { label: '보류', tone: 'bad' },
};

const ACTION_PRESENTATION: Record<VehicleSelectorAction, string> = {
  SELECT: '선택 가능',
  INSPECT_ONLY: '확인만 가능',
  BLOCKED: '선택 차단',
};

const ACTION_REASON_PRESENTATION: Record<
  string,
  { title: string; message: string; nextStep: string }
> = {
  IDENTITY_PARTIAL: {
    title: '차량 식별 정보가 일부 미확정입니다',
    message: 'F가 이 후보의 식별 상태를 PARTIAL로 판정했습니다.',
    nextStep: '차종·세대·연식·트림 등 식별 근거를 추가로 확인해 주세요.',
  },
  UNRESOLVED_SELECTION: {
    title: '선택 조건과 비교할 값이 일부 미확인입니다',
    message: 'F가 입력 조건 중 하나 이상을 이 후보의 현재 자료로 확정하지 못했습니다.',
    nextStep: '미확인 조건의 근거를 확인하거나 해당 조건을 비워 다시 비교해 주세요.',
  },
  UNRESOLVED_SEARCH: {
    title: '검색어 일부가 이 후보 자료에서 확인되지 않습니다',
    message: 'F가 검색어 일부를 직접 확인할 수 없는 상태로 판정했습니다.',
    nextStep: '검색어를 줄이거나 후보의 상세 근거를 확인해 주세요.',
  },
  LIFECYCLE_HOLD: {
    title: '차량 상태가 HOLD입니다',
    message: 'F가 이 후보의 lifecycle을 HOLD로 판정했습니다.',
    nextStep: '활성화 근거가 확인되기 전에는 선택하지 마세요.',
  },
  IDENTITY_HOLD: {
    title: '차량 식별 상태가 HOLD입니다',
    message: 'F가 이 후보의 identity 상태를 HOLD로 판정했습니다.',
    nextStep: '식별 정보 정합성이 해소되기 전에는 선택하지 마세요.',
  },
};

function presentActionReason(code: string) {
  const known = ACTION_REASON_PRESENTATION[code];
  return {
    code,
    title: known?.title ?? '추가 확인이 필요한 상태입니다',
    message: known?.message ?? 'F가 이 후보에 추가 확인 사유를 반환했습니다.',
    nextStep: known?.nextStep ?? '상세 근거와 원본 상태를 확인해 주세요.',
  };
}

const NO_RESULT_PRESENTATION: Record<
  VehicleSelectorNoResultReason,
  { title: string; message: string }
> = {
  UNRECOGNIZED_SEARCH: {
    title: '검색어를 해석하지 못했습니다',
    message: '현재 차량 마스터에서 확인되는 표현으로 검색어를 바꿔 다시 확인해 주세요.',
  },
  INSUFFICIENT_DATA: {
    title: '자료가 부족해 후보를 확정할 수 없습니다',
    message: '조건과 양립할 수 있는 자료가 충분하지 않습니다. 모르는 조건을 비워 두거나 다른 조건으로 확인해 주세요.',
  },
  HOLD_ONLY: {
    title: '보류 상태 후보만 확인됩니다',
    message: '현재 조건과 맞는 후보가 있지만 선택 가능한 상태가 아닙니다. 상세 근거를 확인해 주세요.',
  },
  OUT_OF_SCOPE: {
    title: '현재 모드 범위 밖의 후보만 확인됩니다',
    message: '신차/중고차 구분을 바꾸거나 조건을 조정해 다시 확인해 주세요.',
  },
  IMPOSSIBLE_COMBINATION: {
    title: '함께 성립하는 조건을 찾지 못했습니다',
    message: '입력한 조건 조합과 일치하는 후보가 없습니다. 일부 조건을 해제해 다시 확인해 주세요.',
  },
};

function assertText(value: string, field: string) {
  if (!value.trim()) throw new Error(`INVALID_VEHICLE_FINDER_PRESENTER:${field}`);
}

function assertObservation(input: VehicleFinderPresenterInput['observation']) {
  assertText(input.id, 'observation.id');
  assertText(input.observedAt, 'observation.observedAt');
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error('INVALID_VEHICLE_FINDER_PRESENTER:observation.observedAt');
  }
}

function assertDisplay(
  display: VehicleFinderCandidateDisplay | undefined,
  recordId: string
): asserts display is VehicleFinderCandidateDisplay {
  if (!display) {
    throw new Error(`MISSING_VEHICLE_FINDER_DISPLAY:${recordId}`);
  }
  assertText(display.label, `display.${recordId}.label`);
  assertText(display.pathText, `display.${recordId}.pathText`);
  assertText(display.nodeTypeLabel, `display.${recordId}.nodeTypeLabel`);
  if (display.listLines && display.listLines.length > 2) {
    throw new Error(`INVALID_VEHICLE_FINDER_PRESENTER:display.${recordId}.listLines`);
  }
}

export function presentVehicleSelectorResult(
  input: VehicleFinderPresenterInput
): VehicleFinderUiSnapshot {
  assertObservation(input.observation);

  const noResult = input.result.guidance.noResultReason
    ? NO_RESULT_PRESENTATION[input.result.guidance.noResultReason]
    : null;

  const facetLabels = new Map(input.facets.map((facet) => [facet.axis, facet.label]));

  const items = input.result.candidates.map((candidate) => {
    const display = input.displayByRecordId[candidate.record.recordId];
    assertDisplay(display, candidate.record.recordId);
    const state = ACTION_STATE_PRESENTATION[candidate.actionState];

    return {
      id: candidate.record.recordId,
      label: display.label,
      pathText: display.pathText,
      nodeTypeLabel: display.nodeTypeLabel,
      state: {
        code: candidate.actionState,
        label: state.label,
        tone: state.tone,
      },
      action: {
        code: candidate.action,
        label: ACTION_PRESENTATION[candidate.action],
        reasons: [...candidate.actionReasons],
        reasonDetails: candidate.actionReasons.map(presentActionReason),
      },
      unresolved: {
        axes: candidate.unresolvedAxes.map((axis) => ({
          code: axis,
          label: facetLabels.get(axis) ?? null,
        })),
        searchTokenCount: candidate.search.unresolvedTokens,
      },
      ...(display.listLines ? { listLines: [...display.listLines] } : {}),
      facts: structuredClone(display.facts),
      evidenceIds: [...display.evidenceIds],
      ...(display.sources ? { sources: structuredClone(display.sources) } : {}),
      ...(display.freshness ? { freshness: { ...display.freshness } } : {}),
      ...(display.confidenceLabel
        ? { confidenceLabel: display.confidenceLabel }
        : {}),
      selectable: candidate.selectable,
    };
  });

  const groups = input.result.groups.map((group) => {
    const representative = input.displayByRecordId[group.representativeRecordId];
    assertDisplay(representative, group.representativeRecordId);

    const label =
      group.model.label?.trim() ||
      representative.label;
    const contextParts = [
      group.maker.label?.trim() || null,
      group.generation.label?.trim() || null,
    ].filter((value): value is string => Boolean(value));

    return {
      id: group.groupId,
      scope: group.scope,
      label,
      context: contextParts.length ? contextParts.join(' · ') : null,
      representativeId: group.representativeRecordId,
      memberIds: [...group.memberRecordIds],
      candidateCount: group.candidateCount,
      selectableCount: group.selectableCount,
      inspectOnlyCount: group.inspectOnlyCount,
      blockedCount: group.blockedCount,
      expandable: group.expandable,
      suggestedDrilldownAxis: group.suggestedDrilldownAxis,
      suggestedDrilldownLabel: group.suggestedDrilldownAxis
        ? facetLabels.get(group.suggestedDrilldownAxis) ?? null
        : null,
      drilldowns: group.drilldownAxes.map((drilldown) => ({
        axis: drilldown.axis,
        label: facetLabels.get(drilldown.axis) ?? null,
        selectableCandidateCount: drilldown.selectableCandidateCount,
        unknownValueCount: drilldown.unknownValueCount,
        options: drilldown.options.map((option) => ({
          id: option.id,
          label: option.label,
          value: option.value,
          count: option.count,
        })),
      })),
    };
  });

  return {
    schemaVersion: VEHICLE_FINDER_UI_SCHEMA,
    mode: input.result.mode,
    presentation: input.presentation,
    guidance: {
      resolutionStatus: input.result.guidance.resolutionStatus,
      suggestedNextAxis: input.result.guidance.suggestedNextAxis,
      noResultReason: input.result.guidance.noResultReason,
      noResultTitle: noResult?.title ?? null,
      noResultMessage: noResult?.message ?? null,
      selectableCount: input.result.guidance.selectableCount,
      inspectOnlyCount: input.result.guidance.inspectOnlyCount,
      blockedCount: input.result.guidance.blockedCount,
    },
    observationId: input.observation.id,
    observedAt: input.observation.observedAt,
    coverage: input.observation.coverage,
    total: items.length,
    hasMore: input.hasMore ?? false,
    ...(input.excludedUnknownFacetCount == null
      ? {}
      : { excludedUnknownFacetCount: input.excludedUnknownFacetCount }),
    facets: structuredClone(input.facets),
    groups,
    items,
  };
}


export type VehicleFinderFinalizationReason = {
  code: VehicleSelectorFinalizationReason;
  title: string;
  message: string;
  nextStep: string;
};

export type VehicleFinderFinalizationReview = {
  status: VehicleSelectorFinalizationDecision['status'];
  recordId: string | null;
  canConfirm: boolean;
  reasons: VehicleFinderFinalizationReason[];
};

const FINALIZATION_REASON_PRESENTATION: Record<
  VehicleSelectorFinalizationReason,
  Omit<VehicleFinderFinalizationReason, 'code'>
> = {
  CANDIDATE_NOT_FOUND: {
    title: '선택한 후보를 현재 결과에서 찾지 못했습니다',
    message: 'F 최종화 시점의 후보 집합에 해당 recordId가 없습니다.',
    nextStep: '최신 후보를 다시 조회하고 차량을 다시 선택해 주세요.',
  },
  AMBIGUOUS_CANDIDATES: {
    title: '확정 가능한 후보가 여러 개 남아 있습니다',
    message: 'F가 단일 차량으로 확정할 수 없는 상태로 판정했습니다.',
    nextStep: '후보를 하나 직접 선택하거나 조건을 더 좁혀 주세요.',
  },
  NON_ACTIVE_CANDIDATE: {
    title: '현재 선택 가능한 ACTIVE 후보가 아닙니다',
    message: 'F가 이 후보를 SELECT 가능한 ACTIVE 상태로 인정하지 않았습니다.',
    nextStep: 'UNKNOWN/HOLD 사유와 근거를 먼저 해소해 주세요.',
  },
  UNRESOLVED_REQUEST: {
    title: '요청에 아직 미확인 조건이 남아 있습니다',
    message: 'F가 선택 조건 또는 검색어 일부를 확정하지 못했습니다.',
    nextStep: '미확인 조건을 확인하거나 해당 조건을 비운 뒤 다시 검토해 주세요.',
  },
  MISSING_RECORD_ID: {
    title: '차량 record ID가 없습니다',
    message: '최종 확정에 필요한 recordId가 비어 있습니다.',
    nextStep: '정본 차량 식별자를 확인해 주세요.',
  },
  MISSING_MAKER: {
    title: '제조사 정보가 없습니다',
    message: '최종 확정에 필요한 제조사명이 확인되지 않습니다.',
    nextStep: '제조사 식별 근거를 확인해 주세요.',
  },
  MISSING_MODEL_ID: {
    title: '모델 ID가 없습니다',
    message: '최종 확정에 필요한 모델 식별자가 없습니다.',
    nextStep: '정본 모델 ID를 확인해 주세요.',
  },
  MISSING_MODEL: {
    title: '모델명이 없습니다',
    message: '최종 확정에 필요한 모델명이 확인되지 않습니다.',
    nextStep: '모델 식별 근거를 확인해 주세요.',
  },
  MISSING_MODEL_YEAR_ID: {
    title: '연식 ID가 없습니다',
    message: '최종 확정에 필요한 연식 식별자가 없습니다.',
    nextStep: '정본 연식 ID를 확인해 주세요.',
  },
  MISSING_MODEL_YEAR: {
    title: '연식 값이 없습니다',
    message: '최종 확정에 필요한 연식 값이 확인되지 않습니다.',
    nextStep: '연식 근거를 확인해 주세요.',
  },
  MISSING_POWERTRAIN_ID: {
    title: '파워트레인 ID가 없습니다',
    message: '최종 확정에 필요한 파워트레인 식별자가 없습니다.',
    nextStep: '정본 파워트레인 ID를 확인해 주세요.',
  },
  MISSING_POWERTRAIN: {
    title: '파워트레인 정보가 없습니다',
    message: '최종 확정에 필요한 파워트레인명이 확인되지 않습니다.',
    nextStep: '파워트레인 근거를 확인해 주세요.',
  },
  MISSING_TRIM_ID: {
    title: '트림 ID가 없습니다',
    message: '최종 확정에 필요한 트림 식별자가 없습니다.',
    nextStep: '정본 트림 ID를 확인해 주세요.',
  },
  MISSING_TRIM: {
    title: '트림 정보가 없습니다',
    message: '최종 확정에 필요한 트림명이 확인되지 않습니다.',
    nextStep: '트림 근거를 확인해 주세요.',
  },
  MISSING_GENERATION_ID: {
    title: '세대 ID가 없습니다',
    message: '중고차 최종 확정에 필요한 세대 식별자가 없습니다.',
    nextStep: '정본 세대 ID를 확인해 주세요.',
  },
  MISSING_GENERATION: {
    title: '세대 정보가 없습니다',
    message: '중고차 최종 확정에 필요한 세대명이 확인되지 않습니다.',
    nextStep: '세대 식별 근거를 확인해 주세요.',
  },
  MISSING_PHASE_ID: {
    title: '변경형 ID가 없습니다',
    message: '중고차 최종 확정에 필요한 변경형 식별자가 없습니다.',
    nextStep: '정본 변경형 ID를 확인해 주세요.',
  },
  MISSING_PHASE: {
    title: '변경형 정보가 없습니다',
    message: '중고차 최종 확정에 필요한 변경형명이 확인되지 않습니다.',
    nextStep: '변경형 식별 근거를 확인해 주세요.',
  },
  MODE_SCOPE_MISMATCH: {
    title: '현재 신차/중고차 모드에서 확정할 수 없는 상태입니다',
    message: 'F가 후보의 lifecycle 또는 identity 상태가 현재 모드 확정 조건과 맞지 않는다고 판정했습니다.',
    nextStep: '차량 상태를 확인하거나 올바른 신차/중고차 모드에서 다시 선택해 주세요.',
  },
};

export function presentVehicleFinalizationDecision(
  decision: VehicleSelectorFinalizationDecision
): VehicleFinderFinalizationReview {
  return {
    status: decision.status,
    recordId: decision.recordId,
    canConfirm: decision.status === 'APPROVED' && Boolean(decision.recordId),
    reasons: decision.reasons.map((code) => ({
      code,
      ...FINALIZATION_REASON_PRESENTATION[code],
    })),
  };
}


export type VehicleFinderReceiptRevalidationReason = {
  code: VehicleSelectionReceiptRevalidationReason;
  title: string;
  message: string;
  nextStep: string;
};

export type VehicleFinderReceiptRevalidationReview = {
  status: VehicleSelectionReceiptRevalidationDecision['status'];
  receiptId: string;
  recordId: string;
  ageMs: number;
  currentRecordChanged: boolean;
  snapshotRecordDigest: string;
  currentRecordDigest: string | null;
  reasons: VehicleFinderReceiptRevalidationReason[];
};

const RECEIPT_REVALIDATION_REASON_PRESENTATION: Record<
  VehicleSelectionReceiptRevalidationReason,
  Omit<VehicleFinderReceiptRevalidationReason, 'code'>
> = {
  RECEIPT_FROM_FUTURE: {
    title: '영수증 발급시각이 현재 검증시각보다 미래입니다',
    message: 'F가 허용된 미래 시각 오차를 벗어난 receipt로 판정했습니다.',
    nextStep: '시각 기준과 receipt 발급 경로를 확인한 뒤 다시 검증해 주세요.',
  },
  RECEIPT_STALE: {
    title: '재검증 허용 기간을 지난 receipt입니다',
    message: 'F가 설정된 최대 유효 기간을 초과했다고 판정했습니다.',
    nextStep: '현재 차량 자료로 다시 선택하고 새 receipt를 발급해 주세요.',
  },
  CURRENT_RECORD_NOT_FOUND: {
    title: '현재 정본에서 차량을 찾을 수 없습니다',
    message: 'receipt의 recordId가 현재 차량 자료에 존재하지 않습니다.',
    nextStep: '현재 차량 마스터에서 후보를 다시 선택해 주세요.',
  },
  CURRENT_RECORD_CHANGED: {
    title: '확정 당시와 현재 차량 정보가 달라졌습니다',
    message: 'F가 선택 관련 차량 정보의 digest 변경을 확인했습니다.',
    nextStep: '변경된 차량 정보를 검토하고 다시 선택해 주세요.',
  },
  CURRENT_RECORD_NOT_FINALIZABLE: {
    title: '현재 차량 상태로는 다시 확정할 수 없습니다',
    message: 'F가 현재 record를 최종 선택 조건에 맞지 않는 상태로 판정했습니다.',
    nextStep: '현재 HOLD/identity/필수 식별 정보 상태를 확인해 주세요.',
  },
  CURRENT_REQUEST_NO_LONGER_MATCHES: {
    title: '현재 차량이 기존 선택 조건과 더 이상 일치하지 않습니다',
    message: 'F가 receipt에 저장된 요청으로 현재 record를 다시 찾지 못했습니다.',
    nextStep: '현재 조건과 후보를 다시 확인해 새 선택을 진행해 주세요.',
  },
};

export function presentVehicleReceiptRevalidationDecision(
  decision: VehicleSelectionReceiptRevalidationDecision
): VehicleFinderReceiptRevalidationReview {
  return {
    status: decision.status,
    receiptId: decision.receiptId,
    recordId: decision.recordId,
    ageMs: decision.ageMs,
    currentRecordChanged: decision.currentRecordChanged,
    snapshotRecordDigest: decision.snapshotRecordDigest,
    currentRecordDigest: decision.currentRecordDigest,
    reasons: decision.reasons.map((code) => ({
      code,
      ...RECEIPT_REVALIDATION_REASON_PRESENTATION[code],
    })),
  };
}
