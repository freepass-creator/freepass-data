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

export type VehicleSelectorActionState = 'ACTIVE' | 'UNKNOWN' | 'HOLD';
export type VehicleSelectorAction = 'SELECT' | 'INSPECT_ONLY' | 'BLOCKED';

export type VehicleSelectorCandidate = {
  record: VehicleSelectorRecord;
  score: number;
  matchedAxes: VehicleSelectorAxis[];
  unresolvedAxes: VehicleSelectorAxis[];
  search: {
    matchedTokens: number;
    unresolvedTokens: number;
  };
  actionState: VehicleSelectorActionState;
  action: VehicleSelectorAction;
  actionReasons: string[];
  selectable: boolean;
};

export type VehicleSelectorFacetOption = {
  id: string | null;
  label: string;
  value: number | null;
  count: number;
};

export type VehicleSelectorResolutionStatus =
  | 'OPEN'
  | 'AMBIGUOUS'
  | 'PARTIAL_UNKNOWN'
  | 'RESOLVED'
  | 'NO_RESULT'
  | 'IMPOSSIBLE';

export type VehicleSelectorNoResultReason =
  | 'UNRECOGNIZED_SEARCH'
  | 'INSUFFICIENT_DATA'
  | 'HOLD_ONLY'
  | 'OUT_OF_SCOPE'
  | 'IMPOSSIBLE_COMBINATION';

export type VehicleSelectorNoResultEvidence = {
  unrecognizedSearchTokens: string[];
  unrecognizedAxes: VehicleSelectorAxis[];
  unknownCompatibleCount: number;
  holdCompatibleCount: number;
  outOfScopeCompatibleCount: number;
};

export type VehicleSelectorGuidance = {
  candidateCount: number;
  selectableCount: number;
  inspectOnlyCount: number;
  blockedCount: number;
  resolvedRecordId: string | null;
  resolutionStatus: VehicleSelectorResolutionStatus;
  noResultReason: VehicleSelectorNoResultReason | null;
  noResultEvidence: VehicleSelectorNoResultEvidence | null;
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

export type VehicleSelectorSelectionReconciliation = {
  selection: VehicleSelectorSelection;
  clearedAxes: VehicleSelectorAxis[];
  result: VehicleSelectorResult;
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

function clearSelectionAxis(
  selection: VehicleSelectorSelection,
  axis: VehicleSelectorAxis
) {
  switch (axis) {
    case 'maker':
      delete selection.makerId;
      delete selection.maker;
      break;
    case 'model':
      delete selection.modelId;
      delete selection.model;
      break;
    case 'generation':
      delete selection.generationId;
      delete selection.generation;
      break;
    case 'phase':
      delete selection.phaseId;
      delete selection.phase;
      break;
    case 'modelYear':
      delete selection.modelYearId;
      delete selection.modelYear;
      break;
    case 'powertrain':
      delete selection.powertrainId;
      delete selection.powertrain;
      break;
    case 'fuelType':
      delete selection.fuelType;
      break;
    case 'drivetrain':
      delete selection.drivetrain;
      break;
    case 'seats':
      delete selection.seats;
      break;
    case 'trim':
      delete selection.trimId;
      delete selection.trim;
      break;
  }
}

function selectionSubset(
  selection: VehicleSelectorSelection,
  axes: ReadonlySet<VehicleSelectorAxis>
) {
  const subset: VehicleSelectorSelection = {};
  const copy = <K extends keyof VehicleSelectorSelection>(key: K) => {
    const value = selection[key];
    if (value !== undefined) {
      subset[key] = value;
    }
  };

  for (const axis of AXES) {
    if (!axes.has(axis) || !axisSelected(selection, axis)) continue;
    switch (axis) {
      case 'maker':
        copy('makerId');
        copy('maker');
        break;
      case 'model':
        copy('modelId');
        copy('model');
        break;
      case 'generation':
        copy('generationId');
        copy('generation');
        break;
      case 'phase':
        copy('phaseId');
        copy('phase');
        break;
      case 'modelYear':
        copy('modelYearId');
        copy('modelYear');
        break;
      case 'powertrain':
        copy('powertrainId');
        copy('powertrain');
        break;
      case 'fuelType':
        copy('fuelType');
        break;
      case 'drivetrain':
        copy('drivetrain');
        break;
      case 'seats':
        copy('seats');
        break;
      case 'trim':
        copy('trimId');
        copy('trim');
        break;
    }
  }
  return subset;
}

function facetMatchesSelection(
  option: VehicleSelectorFacetOption,
  selection: VehicleSelectorSelection,
  axis: VehicleSelectorAxis
) {
  const selected = selectionForAxis(selection, axis);
  if ('id' in selected && hasText(selected.id) && option.id !== selected.id) {
    return false;
  }
  if (
    'label' in selected &&
    hasText(selected.label) &&
    !compact(option.label).includes(compact(selected.label))
  ) {
    return false;
  }
  if (
    'value' in selected &&
    selected.value != null &&
    option.value !== selected.value
  ) {
    return false;
  }
  return true;
}

function reconciliationOrder() {
  return [...AXES].reverse();
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
    if (!actual.includes(expected)) {
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

type SearchTokenIntent = {
  token: string;
  axes: VehicleSelectorAxis[];
  aliasKnown: boolean;
};

type SearchContext = {
  tokens: SearchTokenIntent[];
};

function axisTerms(record: VehicleSelectorRecord, axis: VehicleSelectorAxis) {
  const textValue = textAxis(record, axis);
  if (textValue) return [textValue.label].filter(hasText) as string[];

  const numberValue = numberAxis(record, axis);
  if (!numberValue) return [];
  return [
    numberValue.label,
    numberValue.value == null ? null : String(numberValue.value),
  ].filter(hasText) as string[];
}

function axisKnown(record: VehicleSelectorRecord, axis: VehicleSelectorAxis) {
  return axisTerms(record, axis).length > 0;
}

function termMatchesToken(term: string, token: string) {
  const normalized = normalize(term);
  const normalizedToken = normalize(token);
  if (!normalizedToken) return false;

  if (/^\d+$/.test(normalizedToken)) {
    return normalized.split(/\D+/).filter(Boolean).includes(normalizedToken);
  }

  if (/^[a-z0-9-]+$/.test(normalizedToken)) {
    return normalized
      .split(/[^a-z0-9-]+/)
      .filter(Boolean)
      .some((word) =>
        word === normalizedToken ||
        (normalizedToken.length > 1 && word.startsWith(normalizedToken))
      );
  }

  return (
    normalized.includes(normalizedToken) ||
    compact(normalized).includes(compact(normalizedToken))
  );
}

function tokenMatchesAxis(
  record: VehicleSelectorRecord,
  axis: VehicleSelectorAxis,
  token: string
) {
  return axisTerms(record, axis).some((term) => termMatchesToken(term, token));
}

function tokenMatchesAlias(record: VehicleSelectorRecord, token: string) {
  return record.aliases.some((alias) => termMatchesToken(alias, token));
}

function buildSearchContext(
  records: readonly VehicleSelectorRecord[],
  request: VehicleSelectorRequest,
  respectMode = true
): SearchContext {
  const tokens = normalize(request.searchText).split(' ').filter(Boolean);
  const allowed = respectMode
    ? records.filter((record) => allowedByMode(record, request))
    : [...records];

  return {
    tokens: tokens.map((token) => ({
      token,
      axes: AXES.filter((axis) =>
        allowed.some((record) => tokenMatchesAxis(record, axis, token))
      ),
      aliasKnown: allowed.some((record) => tokenMatchesAlias(record, token)),
    })),
  };
}

function matchesSearchText(
  record: VehicleSelectorRecord,
  context: SearchContext
) {
  if (!context.tokens.length) {
    return { matched: 0, unresolved: 0, partial: false, rejected: false };
  }

  let matched = 0;
  let unresolved = 0;

  for (const intent of context.tokens) {
    if (
      intent.axes.some((axis) => tokenMatchesAxis(record, axis, intent.token)) ||
      tokenMatchesAlias(record, intent.token)
    ) {
      matched += 1;
      continue;
    }

    if (!intent.axes.length && !intent.aliasKnown) {
      return { matched, unresolved, partial: unresolved > 0, rejected: true };
    }

    if (intent.axes.length) {
      const knownRelevantAxes = intent.axes.filter((axis) => axisKnown(record, axis));
      if (!knownRelevantAxes.length) {
        unresolved += 1;
        continue;
      }
    }

    return { matched, unresolved, partial: unresolved > 0, rejected: true };
  }

  return {
    matched,
    unresolved,
    partial: unresolved > 0,
    rejected: false,
  };
}

function matchesSelection(
  record: VehicleSelectorRecord,
  request: VehicleSelectorRequest,
  searchContext: SearchContext,
  ignoreAxis?: VehicleSelectorAxis
) {
  if (!allowedByMode(record, request)) return false;
  const selection = request.selection ?? {};

  for (const axis of AXES) {
    if (axis === ignoreAxis) continue;
    if (matchesAxis(record, selection, axis).rejected) return false;
  }

  return !matchesSearchText(record, searchContext).rejected;
}

function baseActionState(record: VehicleSelectorRecord): VehicleSelectorActionState {
  if (record.lifecycle === 'HOLD' || record.identityStatus === 'HOLD') {
    return 'HOLD';
  }
  if (record.identityStatus === 'PARTIAL') {
    return 'UNKNOWN';
  }
  return 'ACTIVE';
}

function candidateAction(
  record: VehicleSelectorRecord,
  unresolvedAxes: readonly VehicleSelectorAxis[],
  searchUnresolvedTokens: number
): {
  actionState: VehicleSelectorActionState;
  action: VehicleSelectorAction;
  reasons: string[];
} {
  const base = baseActionState(record);

  if (base === 'HOLD') {
    return {
      actionState: 'HOLD',
      action: 'BLOCKED',
      reasons: [
        ...(record.lifecycle === 'HOLD' ? ['LIFECYCLE_HOLD'] : []),
        ...(record.identityStatus === 'HOLD' ? ['IDENTITY_HOLD'] : []),
      ],
    };
  }

  if (
    base === 'UNKNOWN' ||
    unresolvedAxes.length > 0 ||
    searchUnresolvedTokens > 0
  ) {
    return {
      actionState: 'UNKNOWN',
      action: 'INSPECT_ONLY',
      reasons: [
        ...(record.identityStatus === 'PARTIAL' ? ['IDENTITY_PARTIAL'] : []),
        ...(unresolvedAxes.length > 0 ? ['UNRESOLVED_SELECTION'] : []),
        ...(searchUnresolvedTokens > 0 ? ['UNRESOLVED_SEARCH'] : []),
      ],
    };
  }

  return {
    actionState: 'ACTIVE',
    action: 'SELECT',
    reasons: [],
  };
}

function provesFacetContext(
  record: VehicleSelectorRecord,
  request: VehicleSelectorRequest,
  searchContext: SearchContext,
  ignoreAxis: VehicleSelectorAxis
) {
  if (!allowedByMode(record, request)) return false;
  if (baseActionState(record) !== 'ACTIVE') return false;
  const selection = request.selection ?? {};

  for (const axis of AXES) {
    if (axis === ignoreAxis) continue;
    const result = matchesAxis(record, selection, axis);
    if (result.rejected || result.unresolved) return false;
  }

  const search = matchesSearchText(record, searchContext);
  return !search.rejected && search.unresolved === 0;
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
  request: VehicleSelectorRequest,
  searchContext: SearchContext
): Record<VehicleSelectorAxis, VehicleSelectorFacetOption[]> {
  return Object.fromEntries(AXES.map((axis) => {
    const counts = new Map<string, VehicleSelectorFacetOption>();
    for (const record of records) {
      if (!provesFacetContext(record, request, searchContext, axis)) continue;
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

function rawRequestCompatibility(
  record: VehicleSelectorRecord,
  request: VehicleSelectorRequest,
  searchContext: SearchContext
) {
  const selection = request.selection ?? {};
  let unresolved = false;

  for (const axis of AXES) {
    const result = matchesAxis(record, selection, axis);
    if (result.rejected) {
      return { compatible: false, unresolved: false };
    }
    if (result.unresolved) unresolved = true;
  }

  const search = matchesSearchText(record, searchContext);
  if (search.rejected) {
    return { compatible: false, unresolved: false };
  }

  return {
    compatible: true,
    unresolved: unresolved || search.unresolved > 0,
  };
}

function diagnoseNoResult(
  records: readonly VehicleSelectorRecord[],
  request: VehicleSelectorRequest
): {
  reason: VehicleSelectorNoResultReason;
  evidence: VehicleSelectorNoResultEvidence;
} {
  const selection = request.selection ?? {};
  const globalSearchContext = buildSearchContext(records, request, false);
  const unrecognizedSearchTokens = globalSearchContext.tokens
    .filter((token) => !token.axes.length && !token.aliasKnown)
    .map((token) => token.token);

  const unrecognizedAxes = AXES.filter(
    (axis) =>
      axisSelected(selection, axis) &&
      !records.some((record) => matchesAxis(record, selection, axis).matched)
  );

  const compatible = records
    .map((record) => ({
      record,
      ...rawRequestCompatibility(record, request, globalSearchContext),
    }))
    .filter((entry) => entry.compatible);

  const holdCompatibleCount = compatible.filter(
    ({ record }) => baseActionState(record) === 'HOLD'
  ).length;

  const unknownCompatibleCount = compatible.filter(
    ({ record, unresolved }) =>
      baseActionState(record) === 'UNKNOWN' || unresolved
  ).length;

  const outOfScopeCompatibleCount = compatible.filter(
    ({ record }) =>
      baseActionState(record) === 'ACTIVE' &&
      !allowedByMode(record, { ...request, includeHold: true })
  ).length;

  const evidence: VehicleSelectorNoResultEvidence = {
    unrecognizedSearchTokens,
    unrecognizedAxes,
    unknownCompatibleCount,
    holdCompatibleCount,
    outOfScopeCompatibleCount,
  };

  if (unrecognizedSearchTokens.length) {
    return { reason: 'UNRECOGNIZED_SEARCH', evidence };
  }

  if (unrecognizedAxes.length) {
    return { reason: 'INSUFFICIENT_DATA', evidence };
  }

  if (outOfScopeCompatibleCount > 0) {
    return { reason: 'OUT_OF_SCOPE', evidence };
  }

  if (unknownCompatibleCount > 0) {
    return { reason: 'INSUFFICIENT_DATA', evidence };
  }

  if (holdCompatibleCount > 0) {
    return { reason: 'HOLD_ONLY', evidence };
  }

  return { reason: 'IMPOSSIBLE_COMBINATION', evidence };
}

function requestHasCriteria(request: VehicleSelectorRequest) {
  const selection = request.selection ?? {};
  return (
    AXES.some((axis) => axisSelected(selection, axis)) ||
    hasText(request.searchText)
  );
}

function buildGuidance(
  records: readonly VehicleSelectorRecord[],
  candidates: readonly VehicleSelectorCandidate[],
  facets: Record<VehicleSelectorAxis, VehicleSelectorFacetOption[]>,
  request: VehicleSelectorRequest
): VehicleSelectorGuidance {
  const selection = request.selection ?? {};
  const singletonAxes: VehicleSelectorAxis[] = [];
  const ambiguousAxes: VehicleSelectorAxis[] = [];

  for (const axis of AXES) {
    if (axisSelected(selection, axis)) continue;
    const count = facets[axis].length;
    if (count === 1) singletonAxes.push(axis);
    if (count > 1) ambiguousAxes.push(axis);
  }

  const selectable = candidates.filter((candidate) => candidate.action === 'SELECT');
  const inspectOnly = candidates.filter(
    (candidate) => candidate.action === 'INSPECT_ONLY'
  );
  const blocked = candidates.filter((candidate) => candidate.action === 'BLOCKED');
  const preset = VEHICLE_SELECTOR_UX_PRESETS[request.mode];
  const suggestedNextAxis =
    preset.preferredAxisOrder.find((axis) => ambiguousAxes.includes(axis)) ?? null;

  const resolvedRecordId =
    candidates.length === 1 && candidates[0]?.selectable
      ? candidates[0].record.recordId
      : null;

  const noResult =
    requestHasCriteria(request) && candidates.length === 0
      ? diagnoseNoResult(records, request)
      : null;

  const resolutionStatus: VehicleSelectorResolutionStatus =
    !requestHasCriteria(request)
      ? 'OPEN'
      : candidates.length === 0
        ? noResult?.reason === 'IMPOSSIBLE_COMBINATION'
          ? 'IMPOSSIBLE'
          : 'NO_RESULT'
        : resolvedRecordId
          ? 'RESOLVED'
          : candidates.some((candidate) => !candidate.selectable)
            ? 'PARTIAL_UNKNOWN'
            : 'AMBIGUOUS';

  return {
    candidateCount: candidates.length,
    selectableCount: selectable.length,
    inspectOnlyCount: inspectOnly.length,
    blockedCount: blocked.length,
    resolvedRecordId,
    resolutionStatus,
    noResultReason: noResult?.reason ?? null,
    noResultEvidence: noResult?.evidence ?? null,
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
  const searchContext = buildSearchContext(records, request);
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

    const search = matchesSearchText(record, searchContext);
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

    const interaction = candidateAction(
      record,
      unresolvedAxes,
      search.unresolved
    );

    candidates.push({
      record,
      score,
      matchedAxes,
      unresolvedAxes,
      search: {
        matchedTokens: search.matched,
        unresolvedTokens: search.unresolved,
      },
      actionState: interaction.actionState,
      action: interaction.action,
      actionReasons: interaction.reasons,
      selectable: interaction.action === 'SELECT',
    });
  }

  const actionRank: Record<VehicleSelectorAction, number> = {
    SELECT: 0,
    INSPECT_ONLY: 1,
    BLOCKED: 2,
  };

  candidates.sort((a, b) =>
    actionRank[a.action] - actionRank[b.action] ||
    b.score - a.score ||
    b.matchedAxes.length - a.matchedAxes.length ||
    a.unresolvedAxes.length - b.unresolvedAxes.length ||
    a.record.recordId.localeCompare(b.record.recordId)
  );

  const facets = buildFacets(records, request, searchContext);

  return {
    mode: request.mode,
    candidates,
    facets,
    guidance: buildGuidance(records, candidates, facets, request),
  };
}


export function reconcileVehicleSelection(
  records: readonly VehicleSelectorRecord[],
  request: Omit<VehicleSelectorRequest, 'selection'>,
  nextSelection: VehicleSelectorSelection,
  changedAxes: readonly VehicleSelectorAxis[]
): VehicleSelectorSelectionReconciliation {
  const selection: VehicleSelectorSelection = { ...nextSelection };
  const protectedAxes = new Set(changedAxes);

  const protectedSelection = selectionSubset(selection, protectedAxes);
  const protectedResult = selectVehicles(records, {
    ...request,
    selection: protectedSelection,
  });

  if (
    protectedAxes.size > 0 &&
    protectedResult.candidates.length === 0
  ) {
    return {
      selection,
      clearedAxes: [],
      result: selectVehicles(records, { ...request, selection }),
    };
  }

  const clearedAxes: VehicleSelectorAxis[] = [];

  while (true) {
    const current = selectVehicles(records, { ...request, selection });
    let cleared = false;

    for (const axis of reconciliationOrder()) {
      if (protectedAxes.has(axis) || !axisSelected(selection, axis)) continue;
      const stillValid = current.facets[axis].some((option) =>
        facetMatchesSelection(option, selection, axis)
      );
      if (stillValid) continue;

      clearSelectionAxis(selection, axis);
      clearedAxes.push(axis);
      cleared = true;
      break;
    }

    if (!cleared) {
      return {
        selection,
        clearedAxes,
        result: current,
      };
    }
  }
}
