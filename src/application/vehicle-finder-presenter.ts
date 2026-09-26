import type {
  VehicleSelectorAction,
  VehicleSelectorActionState,
  VehicleSelectorAxis,
  VehicleSelectorNoResultReason,
  VehicleSelectorResult,
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

  const facetLabels = new Map(input.facets.map((facet) => [facet.axis, facet.label]));
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
