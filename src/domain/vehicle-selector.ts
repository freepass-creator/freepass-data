export const VEHICLE_SELECTOR_CONTRACT = 'vehicle-selector/v1';

export type VehicleSelectorMode = 'NEW_CAR' | 'USED_CAR';

export type VehicleSelectorAxis =
  | 'maker'
  | 'model'
  | 'generation'
  | 'phase'
  | 'modelYear'
  | 'powertrain'
  | 'fuelType'
  | 'drivetrain'
  | 'seats'
  | 'trim';

export type VehicleSelectorIdentityStatus = 'RESOLVED' | 'PARTIAL' | 'HOLD';
export type VehicleSelectorLifecycle =
  | 'CURRENT'
  | 'HISTORICAL'
  | 'DISCONTINUED'
  | 'HOLD';

export type VehicleSelectorTextValue = {
  id: string | null;
  label: string | null;
};

export type VehicleSelectorNumberValue = {
  id: string | null;
  label: string | null;
  value: number | null;
};

export type VehicleSelectorRecord = {
  recordId: string;
  lifecycle: VehicleSelectorLifecycle;
  identityStatus: VehicleSelectorIdentityStatus;
  maker: VehicleSelectorTextValue;
  model: VehicleSelectorTextValue;
  generation: VehicleSelectorTextValue;
  phase: VehicleSelectorTextValue;
  modelYear: VehicleSelectorNumberValue;
  powertrain: VehicleSelectorTextValue;
  fuelType: VehicleSelectorTextValue;
  drivetrain: VehicleSelectorTextValue;
  seats: VehicleSelectorNumberValue;
  trim: VehicleSelectorTextValue;
  aliases: string[];
};

export type VehicleSelectorSelection = {
  makerId?: string | null;
  maker?: string | null;
  modelId?: string | null;
  model?: string | null;
  generationId?: string | null;
  generation?: string | null;
  phaseId?: string | null;
  phase?: string | null;
  modelYearId?: string | null;
  modelYear?: number | null;
  powertrainId?: string | null;
  powertrain?: string | null;
  fuelType?: string | null;
  drivetrain?: string | null;
  seats?: number | null;
  trimId?: string | null;
  trim?: string | null;
};

export type VehicleSelectorRequest = {
  mode: VehicleSelectorMode;
  searchText?: string | null;
  selection?: VehicleSelectorSelection;
  includeHold?: boolean;
};

export type VehicleSelectorCandidate = {
  record: VehicleSelectorRecord;
  score: number;
  matchedAxes: VehicleSelectorAxis[];
  unresolvedAxes: VehicleSelectorAxis[];
  selectable: boolean;
};

export type VehicleSelectorFacetOption = {
  id: string | null;
  label: string;
  value: number | null;
  count: number;
};

export type VehicleSelectorGuidance = {
  candidateCount: number;
  selectableCount: number;
  resolvedRecordId: string | null;
  singletonAxes: VehicleSelectorAxis[];
  ambiguousAxes: VehicleSelectorAxis[];
  suggestedNextAxis: VehicleSelectorAxis | null;
};

export type VehicleSelectorResult = {
  mode: VehicleSelectorMode;
  candidates: VehicleSelectorCandidate[];
  facets: Record<VehicleSelectorAxis, VehicleSelectorFacetOption[]>;
  guidance: VehicleSelectorGuidance;
};

export type VehicleSelectorUxPreset = {
  mode: VehicleSelectorMode;
  presentation: 'GUIDED' | 'SEARCH_FILTER';
  searchFirst: boolean;
  preferredAxisOrder: VehicleSelectorAxis[];
  hiddenByDefault: VehicleSelectorAxis[];
  allowArbitraryAxisEntry: true;
  collapseSingletonAxes: true;
  revealHiddenWhenAmbiguous: true;
};

export const VEHICLE_SELECTOR_UX_PRESETS: Record<
  VehicleSelectorMode,
  VehicleSelectorUxPreset
> = {
  NEW_CAR: {
    mode: 'NEW_CAR',
    presentation: 'GUIDED',
    searchFirst: false,
    preferredAxisOrder: [
      'maker',
      'model',
      'powertrain',
      'drivetrain',
      'seats',
      'trim',
    ],
    hiddenByDefault: ['generation', 'phase', 'modelYear', 'fuelType'],
    allowArbitraryAxisEntry: true,
    collapseSingletonAxes: true,
    revealHiddenWhenAmbiguous: true,
  },
  USED_CAR: {
    mode: 'USED_CAR',
    presentation: 'SEARCH_FILTER',
    searchFirst: true,
    preferredAxisOrder: [
      'model',
      'modelYear',
      'generation',
      'phase',
      'powertrain',
      'fuelType',
      'drivetrain',
      'seats',
      'trim',
      'maker',
    ],
    hiddenByDefault: [],
    allowArbitraryAxisEntry: true,
    collapseSingletonAxes: true,
    revealHiddenWhenAmbiguous: true,
  },
};

const AXES: VehicleSelectorAxis[] = [
  'maker',
  'model',
  'generation',
  'phase',
  'modelYear',
  'powertrain',
  'fuelType',
  'drivetrain',
  'seats',
  'trim',
];

function normalize(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[^0-9a-z가-힣.+-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compact(value: string | null | undefined) {
  return normalize(value).replace(/\s+/g, '');
}

function hasText(value: string | null | undefined) {
  return Boolean(compact(value));
}

function allowedByMode(
  record: VehicleSelectorRecord,
  request: VehicleSelectorRequest
) {
  if (request.mode === 'NEW_CAR') {
    return (
      record.lifecycle === 'CURRENT' &&
      record.identityStatus === 'RESOLVED'
    );
  }

  if (request.includeHold === false) {
    return record.lifecycle !== 'HOLD' && record.identityStatus !== 'HOLD';
  }
  return true;
}

function textAxis(record: VehicleSelectorRecord, axis: VehicleSelectorAxis) {
  if (axis === 'modelYear' || axis === 'seats') return null;
  return record[axis];
}

function numberAxis(record: VehicleSelectorRecord, axis: VehicleSelectorAxis) {
  if (axis !== 'modelYear' && axis !== 'seats') return null;
  return record[axis];
}

function selectionForAxis(
  selection: VehicleSelectorSelection,
  axis: VehicleSelectorAxis
) {
  switch (axis) {
    case 'maker':
      return { id: selection.makerId, label: selection.maker };
    case 'model':
      return { id: selection.modelId, label: selection.model };
    case 'generation':
      return { id: selection.generationId, label: selection.generation };
    case 'phase':
      return { id: selection.phaseId, label: selection.phase };
    case 'modelYear':
      return { id: selection.modelYearId, value: selection.modelYear };
    case 'powertrain':
      return { id: selection.powertrainId, label: selection.powertrain };
    case 'fuelType':
      return { label: selection.fuelType };
    case 'drivetrain':
      return { label: selection.drivetrain };
    case 'seats':
      return { value: selection.seats };
    case 'trim':
      return { id: selection.trimId, label: selection.trim };
  }
}

function axisSelected(selection: VehicleSelectorSelection, axis: VehicleSelectorAxis) {
  const selected = selectionForAxis(selection, axis);
  return (
    ('id' in selected && hasText(selected.id)) ||
    ('label' in selected && hasText(selected.label)) ||
    ('value' in selected && selected.value != null)
  );
}

function matchesAxis(
  record: VehicleSelectorRecord,
  selection: VehicleSelectorSelection,
  axis: VehicleSelectorAxis
): { matched: boolean; unresolved: boolean; rejected: boolean } {
  const selected = selectionForAxis(selection, axis);
  if (!axisSelected(selection, axis)) {
    return { matched: false, unresolved: false, rejected: false };
  }

  const textValue = textAxis(record, axis);
  const numberValue = numberAxis(record, axis);

  if ('id' in selected && hasText(selected.id)) {
    const actualId = textValue?.id ?? numberValue?.id ?? null;
    if (!actualId) return { matched: false, unresolved: true, rejected: false };
    if (actualId !== selected.id) return { matched: false, unresolved: false, rejected: true };
  }

  if ('label' in selected && hasText(selected.label)) {
    const actual = compact(textValue?.label);
    const expected = compact(selected.label);
    if (!actual) return { matched: false, unresolved: true, rejected: false };
    if (!(actual.includes(expected) || expected.includes(actual))) {
      return { matched: false, unresolved: false, rejected: true };
    }
  }

  if ('value' in selected && selected.value != null) {
    const actual = numberValue?.value ?? null;
    if (actual == null) return { matched: false, unresolved: true, rejected: false };
    if (actual !== selected.value) return { matched: false, unresolved: false, rejected: true };
  }

  return { matched: true, unresolved: false, rejected: false };
}

function searchableText(record: VehicleSelectorRecord) {
  return normalize([
    record.maker.label,
    record.model.label,
    record.generation.label,
    record.phase.label,
    record.modelYear.label,
    record.modelYear.value == null ? null : String(record.modelYear.value),
    record.powertrain.label,
    record.fuelType.label,
    record.drivetrain.label,
    record.seats.label,
    record.seats.value == null ? null : String(record.seats.value),
    record.trim.label,
    ...record.aliases,
  ].filter(Boolean).join(' '));
}

function matchesSearchText(record: VehicleSelectorRecord, searchText: string | null | undefined) {
  const tokens = normalize(searchText).split(' ').filter(Boolean);
  if (!tokens.length) return { matched: 0, partial: false, rejected: false };

  const haystack = searchableText(record);
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  if (!matched) return { matched: 0, partial: false, rejected: true };
  return { matched, partial: matched < tokens.length, rejected: false };
}

function matchesSelection(
  record: VehicleSelectorRecord,
  request: VehicleSelectorRequest,
  ignoreAxis?: VehicleSelectorAxis
) {
  if (!allowedByMode(record, request)) return false;
  const selection = request.selection ?? {};

  for (const axis of AXES) {
    if (axis === ignoreAxis) continue;
    if (matchesAxis(record, selection, axis).rejected) return false;
  }

  return !matchesSearchText(record, request.searchText).rejected;
}

function facetOption(record: VehicleSelectorRecord, axis: VehicleSelectorAxis) {
  const textValue = textAxis(record, axis);
  if (textValue) {
    if (!textValue.label) return null;
    return {
      id: textValue.id,
      label: textValue.label,
      value: null,
    };
  }
  const numberValue = numberAxis(record, axis);
  if (!numberValue || (numberValue.value == null && !numberValue.label)) return null;
  return {
    id: numberValue.id,
    label: numberValue.label ?? String(numberValue.value),
    value: numberValue.value,
  };
}

function buildFacets(
  records: readonly VehicleSelectorRecord[],
  request: VehicleSelectorRequest
): Record<VehicleSelectorAxis, VehicleSelectorFacetOption[]> {
  return Object.fromEntries(AXES.map((axis) => {
    const counts = new Map<string, VehicleSelectorFacetOption>();
    for (const record of records) {
      if (!matchesSelection(record, request, axis)) continue;
      const option = facetOption(record, axis);
      if (!option) continue;
      const key = JSON.stringify([option.id, option.label, option.value]);
      const current = counts.get(key);
      counts.set(key, {
        ...option,
        count: (current?.count ?? 0) + 1,
      });
    }
    return [
      axis,
      [...counts.values()].sort((a, b) =>
        (a.value ?? Number.MAX_SAFE_INTEGER) - (b.value ?? Number.MAX_SAFE_INTEGER) ||
        a.label.localeCompare(b.label)
      ),
    ];
  })) as Record<VehicleSelectorAxis, VehicleSelectorFacetOption[]>;
}

function axisOptionCount(
  candidates: readonly VehicleSelectorCandidate[],
  axis: VehicleSelectorAxis
) {
  const values = new Set<string>();
  for (const candidate of candidates) {
    const option = facetOption(candidate.record, axis);
    if (!option) continue;
    values.add(JSON.stringify([option.id, option.label, option.value]));
  }
  return values.size;
}

function buildGuidance(
  candidates: readonly VehicleSelectorCandidate[],
  request: VehicleSelectorRequest
): VehicleSelectorGuidance {
  const selection = request.selection ?? {};
  const singletonAxes: VehicleSelectorAxis[] = [];
  const ambiguousAxes: VehicleSelectorAxis[] = [];

  for (const axis of AXES) {
    if (axisSelected(selection, axis)) continue;
    const count = axisOptionCount(candidates, axis);
    if (count === 1) singletonAxes.push(axis);
    if (count > 1) ambiguousAxes.push(axis);
  }

  const selectable = candidates.filter((candidate) => candidate.selectable);
  const preset = VEHICLE_SELECTOR_UX_PRESETS[request.mode];
  const suggestedNextAxis =
    preset.preferredAxisOrder.find((axis) => ambiguousAxes.includes(axis)) ?? null;

  return {
    candidateCount: candidates.length,
    selectableCount: selectable.length,
    resolvedRecordId:
      candidates.length === 1 && candidates[0]?.selectable
        ? candidates[0].record.recordId
        : null,
    singletonAxes,
    ambiguousAxes,
    suggestedNextAxis,
  };
}

export function selectVehicles(
  records: readonly VehicleSelectorRecord[],
  request: VehicleSelectorRequest
): VehicleSelectorResult {
  const selection = request.selection ?? {};
  const candidates: VehicleSelectorCandidate[] = [];

  for (const record of records) {
    if (!allowedByMode(record, request)) continue;

    const matchedAxes: VehicleSelectorAxis[] = [];
    const unresolvedAxes: VehicleSelectorAxis[] = [];
    let rejected = false;
    let score = 0;

    for (const axis of AXES) {
      const result = matchesAxis(record, selection, axis);
      if (result.rejected) {
        rejected = true;
        break;
      }
      if (result.matched) {
        matchedAxes.push(axis);
        score += 20;
      }
      if (result.unresolved) unresolvedAxes.push(axis);
    }
    if (rejected) continue;

    const search = matchesSearchText(record, request.searchText);
    if (search.rejected) continue;
    score += search.matched * 5;
    if (search.partial) score -= 2;

    const completeness = AXES.filter((axis) => {
      const textValue = textAxis(record, axis);
      if (textValue) return Boolean(textValue.id || textValue.label);
      const numberValue = numberAxis(record, axis);
      return Boolean(numberValue && (numberValue.id || numberValue.value != null));
    }).length;
    score += completeness;

    candidates.push({
      record,
      score,
      matchedAxes,
      unresolvedAxes,
      selectable:
        record.identityStatus === 'RESOLVED' &&
        record.lifecycle !== 'HOLD',
    });
  }

  candidates.sort((a, b) =>
    b.score - a.score ||
    b.matchedAxes.length - a.matchedAxes.length ||
    a.unresolvedAxes.length - b.unresolvedAxes.length ||
    a.record.recordId.localeCompare(b.record.recordId)
  );

  return {
    mode: request.mode,
    candidates,
    facets: buildFacets(records, request),
    guidance: buildGuidance(candidates, request),
  };
}
