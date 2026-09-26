import {
  VEHICLE_SELECTOR_UX_PRESETS,
  selectVehicles,
  type VehicleSelectorAxis,
  type VehicleSelectorFacetOption,
  type VehicleSelectorMode,
  type VehicleSelectorRecord,
  type VehicleSelectorResult,
  type VehicleSelectorSelection,
} from '../domain/vehicle-selector.js';

export const VEHICLE_FINDER_UI_SCHEMA = 'freepass.vehicle-finder.ui/v1';

export type VehicleFinderReadInput = {
  mode: VehicleSelectorMode;
  query?: string | null;
  filters?: Record<string, string>;
};

export type VehicleFinderObservation = {
  observationId: string;
  observedAt: string;
  coverage: 'COMPLETE' | 'PARTIAL';
  evidenceByRecordId?: Record<string, string[]>;
  sourcesByRecordId?: Record<string, Array<{ id: string; label?: string | null }>>;
  freshnessByRecordId?: Record<string, { code: string; label: string }>;
  confidenceByRecordId?: Record<string, string>;
};

export type VehicleFinderReaderDependencies = {
  loadRecords(mode: VehicleSelectorMode): Promise<readonly VehicleSelectorRecord[]>;
  loadObservation(mode: VehicleSelectorMode): Promise<VehicleFinderObservation>;
};

type FacetTokenPayload = {
  v: 1;
  axis: VehicleSelectorAxis;
  id: string | null;
  label: string;
  value: number | null;
};

const AXIS_LABELS: Record<VehicleSelectorAxis, string> = {
  maker: '제조사',
  model: '모델',
  generation: '세대',
  phase: '변경형',
  modelYear: '연식',
  powertrain: '파워트레인',
  fuelType: '연료',
  drivetrain: '구동',
  seats: '인승',
  trim: '트림',
};

const FACT_AXES: VehicleSelectorAxis[] = [
  'modelYear',
  'generation',
  'phase',
  'powertrain',
  'fuelType',
  'drivetrain',
  'seats',
  'trim',
];

const NO_RESULT_LABELS: Record<string, string> = {
  UNRECOGNIZED_SEARCH: '검색어를 확인할 수 없음',
  INSUFFICIENT_DATA: '확인 가능한 정보가 부족함',
  HOLD_ONLY: '보류 후보만 확인됨',
  OUT_OF_SCOPE: '현재 모드 범위 밖 후보',
  IMPOSSIBLE_COMBINATION: '조건 조합과 일치하는 후보 없음',
};

function assertText(value: unknown, code: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function encodeFacetToken(axis: VehicleSelectorAxis, option: VehicleSelectorFacetOption) {
  const payload: FacetTokenPayload = {
    v: 1,
    axis,
    id: option.id,
    label: option.label,
    value: option.value,
  };
  return 'vf1.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeFacetToken(axis: string, token: string): FacetTokenPayload {
  if (!token.startsWith('vf1.')) throw new Error('INVALID_VEHICLE_FINDER_FILTER_TOKEN');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token.slice(4), 'base64url').toString('utf8'));
  } catch {
    throw new Error('INVALID_VEHICLE_FINDER_FILTER_TOKEN');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('INVALID_VEHICLE_FINDER_FILTER_TOKEN');
  }
  const typed = payload as Partial<FacetTokenPayload>;
  if (
    typed.v !== 1 ||
    typed.axis !== axis ||
    typeof typed.label !== 'string' ||
    !typed.label.trim() ||
    (typed.id !== null && typeof typed.id !== 'string') ||
    (typed.value !== null && typeof typed.value !== 'number')
  ) {
    throw new Error('INVALID_VEHICLE_FINDER_FILTER_TOKEN');
  }
  return typed as FacetTokenPayload;
}

function selectionFromFilters(filters: Record<string, string>): VehicleSelectorSelection {
  const selection: VehicleSelectorSelection = {};
  for (const [axis, token] of Object.entries(filters)) {
    const decoded = decodeFacetToken(axis, token);
    switch (decoded.axis) {
      case 'maker':
        selection.makerId = decoded.id;
        selection.maker = decoded.label;
        break;
      case 'model':
        selection.modelId = decoded.id;
        selection.model = decoded.label;
        break;
      case 'generation':
        selection.generationId = decoded.id;
        selection.generation = decoded.label;
        break;
      case 'phase':
        selection.phaseId = decoded.id;
        selection.phase = decoded.label;
        break;
      case 'modelYear':
        selection.modelYearId = decoded.id;
        selection.modelYear = decoded.value;
        break;
      case 'powertrain':
        selection.powertrainId = decoded.id;
        selection.powertrain = decoded.label;
        break;
      case 'fuelType':
        selection.fuelType = decoded.label;
        break;
      case 'drivetrain':
        selection.drivetrain = decoded.label;
        break;
      case 'seats':
        selection.seats = decoded.value;
        break;
      case 'trim':
        selection.trimId = decoded.id;
        selection.trim = decoded.label;
        break;
    }
  }
  return selection;
}

function textValue(record: VehicleSelectorRecord, axis: VehicleSelectorAxis) {
  if (axis === 'modelYear' || axis === 'seats') {
    const value = record[axis];
    return value.label ?? (value.value == null ? null : String(value.value));
  }
  return record[axis].label;
}

function compactKnown(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function candidateLabel(record: VehicleSelectorRecord) {
  const composed = compactKnown([record.model.label, record.trim.label]).join(' · ');
  return composed || record.generation.label || record.maker.label || record.recordId;
}

function candidatePath(record: VehicleSelectorRecord) {
  return compactKnown([
    record.maker.label,
    record.model.label,
    record.generation.label,
    record.phase.label,
    record.modelYear.label,
    record.powertrain.label,
    record.trim.label,
  ]).join(' › ') || record.recordId;
}

function candidateListLines(record: VehicleSelectorRecord) {
  return [
    compactKnown([
      textValue(record, 'modelYear'),
      textValue(record, 'generation'),
      textValue(record, 'phase'),
    ]).join(' · '),
    compactKnown([
      textValue(record, 'powertrain'),
      textValue(record, 'drivetrain'),
      textValue(record, 'seats'),
    ]).join(' · '),
  ].filter(Boolean).slice(0, 2);
}

function candidateState(candidate: VehicleSelectorResult['candidates'][number]) {
  if (candidate.actionState === 'ACTIVE') {
    return { code: 'ACTIVE', label: '선택 가능', tone: 'ok' };
  }
  if (candidate.actionState === 'HOLD') {
    return { code: 'HOLD', label: '보류', tone: 'bad' };
  }
  return { code: 'UNKNOWN', label: '확인 필요', tone: 'warn' };
}

function visibleFacetAxes(
  result: VehicleSelectorResult,
  selectedAxes: ReadonlySet<string>
) {
  const preset = VEHICLE_SELECTOR_UX_PRESETS[result.mode];
  const all = Object.keys(result.facets) as VehicleSelectorAxis[];
  const order = [
    ...preset.preferredAxisOrder,
    ...all.filter((axis) => !preset.preferredAxisOrder.includes(axis)),
  ];

  return order.filter((axis) => {
    if (!preset.hiddenByDefault.includes(axis)) return true;
    if (selectedAxes.has(axis)) return true;
    return preset.revealHiddenWhenAmbiguous && result.guidance.ambiguousAxes.includes(axis);
  });
}

export function buildVehicleFinderReadModel(
  result: VehicleSelectorResult,
  observation: VehicleFinderObservation,
  filters: Record<string, string> = {}
) {
  const preset = VEHICLE_SELECTOR_UX_PRESETS[result.mode];
  const selectedAxes = new Set(Object.keys(filters));

  return {
    schemaVersion: VEHICLE_FINDER_UI_SCHEMA,
    mode: result.mode,
    presentation: preset.presentation,
    guidance: {
      resolutionStatus: result.guidance.resolutionStatus,
      suggestedNextAxis: result.guidance.suggestedNextAxis,
      noResultReason: result.guidance.noResultReason,
      noResultLabel: result.guidance.noResultReason
        ? NO_RESULT_LABELS[result.guidance.noResultReason] ?? result.guidance.noResultReason
        : null,
    },
    observationId: assertText(observation.observationId, 'VEHICLE_FINDER_OBSERVATION_ID_REQUIRED'),
    observedAt: assertText(observation.observedAt, 'VEHICLE_FINDER_OBSERVED_AT_REQUIRED'),
    coverage: observation.coverage,
    total: result.candidates.length,
    hasMore: false,
    facets: visibleFacetAxes(result, selectedAxes).map((axis) => ({
      axis,
      label: AXIS_LABELS[axis],
      options: result.facets[axis].map((option) => ({
        key: encodeFacetToken(axis, option),
        label: option.label,
        count: option.count,
      })),
    })),
    items: result.candidates.map((candidate) => {
      const recordId = candidate.record.recordId;
      const evidenceIds = observation.evidenceByRecordId?.[recordId] ?? [];
      const sources = observation.sourcesByRecordId?.[recordId] ?? [];
      return {
        id: recordId,
        label: candidateLabel(candidate.record),
        pathText: candidatePath(candidate.record),
        nodeTypeLabel:
          candidate.action === 'SELECT'
            ? '선택 후보'
            : candidate.action === 'INSPECT_ONLY'
              ? '검토 후보'
              : '보류 후보',
        state: candidateState(candidate),
        listLines: candidateListLines(candidate.record),
        facts: FACT_AXES.map((axis) => {
          const value = textValue(candidate.record, axis);
          return {
            label: AXIS_LABELS[axis],
            value,
            unknown: !value,
          };
        }),
        evidenceIds: [...evidenceIds],
        sources: sources.map((source) => ({ ...source })),
        freshness: observation.freshnessByRecordId?.[recordId],
        confidenceLabel: observation.confidenceByRecordId?.[recordId],
        selectable: candidate.selectable,
      };
    }),
  };
}

export function createVehicleFinderReader(deps: VehicleFinderReaderDependencies) {
  return async function readVehicleFinder(input: VehicleFinderReadInput) {
    const mode = input.mode;
    const filters = input.filters ?? {};
    const [records, observation] = await Promise.all([
      deps.loadRecords(mode),
      deps.loadObservation(mode),
    ]);

    const result = selectVehicles(records, {
      mode,
      searchText: input.query ?? null,
      selection: selectionFromFilters(filters),
    });

    return buildVehicleFinderReadModel(result, observation, filters);
  };
}
