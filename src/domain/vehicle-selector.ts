import { stableDigest } from '../shared/stable-digest.js';

export const VEHICLE_SELECTOR_CONTRACT = 'vehicle-selector/v1';
export const VEHICLE_SELECTION_RECEIPT_CONTRACT = 'vehicle-selection-receipt/v1';

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
  ranking: {
    directSearchMatches: number;
    aliasOnlySearchMatches: number;
    exactSearchMatches: number;
    specificityScore: number;
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

export type VehicleSelectorCandidateGroupScope =
  | 'MODEL'
  | 'MODEL_GENERATION'
  | 'UNRESOLVED_IDENTITY';

export type VehicleSelectorGroupDrilldownAxis = {
  axis: VehicleSelectorAxis;
  options: VehicleSelectorFacetOption[];
  selectableCandidateCount: number;
  unknownValueCount: number;
  largestBucketCount: number;
  discriminationScore: number;
};

export type VehicleSelectorCandidateGroup = {
  groupId: string;
  scope: VehicleSelectorCandidateGroupScope;
  maker: VehicleSelectorTextValue;
  model: VehicleSelectorTextValue;
  generation: VehicleSelectorTextValue;
  representativeRecordId: string;
  memberRecordIds: string[];
  candidateCount: number;
  selectableCount: number;
  inspectOnlyCount: number;
  blockedCount: number;
  expandable: boolean;
  drilldownAxes: VehicleSelectorGroupDrilldownAxis[];
  suggestedDrilldownAxis: VehicleSelectorAxis | null;
};

export type VehicleSelectorResult = {
  mode: VehicleSelectorMode;
  candidates: VehicleSelectorCandidate[];
  groups: VehicleSelectorCandidateGroup[];
  facets: Record<VehicleSelectorAxis, VehicleSelectorFacetOption[]>;
  guidance: VehicleSelectorGuidance;
};

export type VehicleSelectorSelectionReconciliation = {
  selection: VehicleSelectorSelection;
  clearedAxes: VehicleSelectorAxis[];
  result: VehicleSelectorResult;
};

export type VehicleSelectorGroupTransitionReason =
  | 'GROUP_NOT_FOUND'
  | 'UNRESOLVED_GROUP_IDENTITY'
  | 'DRILLDOWN_AXIS_NOT_AVAILABLE'
  | 'DRILLDOWN_OPTION_NOT_AVAILABLE';

export type VehicleSelectorGroupTransition = {
  status: 'APPLIED' | 'REJECTED';
  reason: VehicleSelectorGroupTransitionReason | null;
  sourceGroupId: string;
  sourceCandidateCount: number | null;
  selection: VehicleSelectorSelection;
  clearedAxes: VehicleSelectorAxis[];
  activeGroupId: string | null;
  beforeCandidateCount: number;
  afterCandidateCount: number;
  beforeGroupCount: number;
  afterGroupCount: number;
  result: VehicleSelectorResult;
};

export type VehicleSelectorFinalizationReason =
  | 'CANDIDATE_NOT_FOUND'
  | 'AMBIGUOUS_CANDIDATES'
  | 'NON_ACTIVE_CANDIDATE'
  | 'UNRESOLVED_REQUEST'
  | 'MISSING_RECORD_ID'
  | 'MISSING_MAKER'
  | 'MISSING_MODEL_ID'
  | 'MISSING_MODEL'
  | 'MISSING_MODEL_YEAR_ID'
  | 'MISSING_MODEL_YEAR'
  | 'MISSING_POWERTRAIN_ID'
  | 'MISSING_POWERTRAIN'
  | 'MISSING_TRIM_ID'
  | 'MISSING_TRIM'
  | 'MISSING_GENERATION_ID'
  | 'MISSING_GENERATION'
  | 'MISSING_PHASE_ID'
  | 'MISSING_PHASE'
  | 'MODE_SCOPE_MISMATCH';

export type VehicleSelectorFinalizationDecision = {
  status: 'APPROVED' | 'HOLD';
  recordId: string | null;
  reasons: VehicleSelectorFinalizationReason[];
  result: VehicleSelectorResult;
};

export type VehicleSelectionSnapshot = {
  mode: VehicleSelectorMode;
  searchText: string | null;
  selection: VehicleSelectorSelection;
  includeHold: boolean | null;
  record: VehicleSelectorRecord;
};

export type VehicleSelectionReceipt = {
  contractVersion: typeof VEHICLE_SELECTION_RECEIPT_CONTRACT;
  selectorContract: typeof VEHICLE_SELECTOR_CONTRACT;
  receiptId: string;
  issuedAt: string;
  snapshotDigest: string;
  receiptDigest: string;
  snapshot: VehicleSelectionSnapshot;
};

export type VehicleSelectionReceiptIssue = {
  status: 'ISSUED' | 'HOLD';
  reasons: VehicleSelectorFinalizationReason[];
  receipt: VehicleSelectionReceipt | null;
  result: VehicleSelectorResult;
};

export type VehicleSelectionReceiptRevalidationReason =
  | 'RECEIPT_FROM_FUTURE'
  | 'RECEIPT_STALE'
  | 'CURRENT_RECORD_NOT_FOUND'
  | 'CURRENT_RECORD_CHANGED'
  | 'CURRENT_RECORD_NOT_FINALIZABLE'
  | 'CURRENT_REQUEST_NO_LONGER_MATCHES';

export type VehicleSelectionReceiptRevalidationPolicy = {
  assessedAt: string;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
};

export type VehicleSelectionReceiptRevalidationDecision = {
  status: 'CURRENT' | 'RESELECT_REQUIRED';
  reasons: VehicleSelectionReceiptRevalidationReason[];
  receiptId: string;
  recordId: string;
  ageMs: number;
  snapshotRecordDigest: string;
  currentRecordDigest: string | null;
  currentRecordChanged: boolean;
  result: VehicleSelectorResult | null;
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

const SEARCH_AXIS_SPECIFICITY: Record<VehicleSelectorAxis, number> = {
  maker: 10,
  model: 30,
  generation: 40,
  phase: 45,
  modelYear: 50,
  powertrain: 60,
  fuelType: 55,
  drivetrain: 50,
  seats: 50,
  trim: 70,
};

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

    const labelMatches =
      axis === 'trim' || axis === 'fuelType'
        ? actual === expected
        : actual.includes(expected);

    if (!labelMatches) {
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

function termExactlyMatchesToken(term: string, token: string) {
  const normalized = normalize(term);
  const normalizedToken = normalize(token);
  if (!normalized || !normalizedToken) return false;
  return (
    normalized === normalizedToken ||
    compact(normalized) === compact(normalizedToken)
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
  let matched = 0;
  let unresolved = 0;
  let directSearchMatches = 0;
  let aliasOnlySearchMatches = 0;
  let exactSearchMatches = 0;
  let specificityScore = 0;

  const result = (rejected: boolean) => ({
    matched,
    unresolved,
    partial: unresolved > 0,
    rejected,
    ranking: {
      directSearchMatches,
      aliasOnlySearchMatches,
      exactSearchMatches,
      specificityScore,
    },
  });

  if (!context.tokens.length) return result(false);

  for (const intent of context.tokens) {
    const directAxes = intent.axes.filter((axis) =>
      tokenMatchesAxis(record, axis, intent.token)
    );
    const aliasMatched = tokenMatchesAlias(record, intent.token);

    if (directAxes.length || aliasMatched) {
      matched += 1;

      if (directAxes.length) {
        directSearchMatches += 1;
        specificityScore += Math.max(
          ...directAxes.map((axis) => SEARCH_AXIS_SPECIFICITY[axis])
        );
        if (
          directAxes.some((axis) =>
            axisTerms(record, axis).some((term) =>
              termExactlyMatchesToken(term, intent.token)
            )
          )
        ) {
          exactSearchMatches += 1;
        }
      } else {
        aliasOnlySearchMatches += 1;
      }
      continue;
    }

    if (!intent.axes.length && !intent.aliasKnown) {
      return result(true);
    }

    if (intent.axes.length) {
      const knownRelevantAxes = intent.axes.filter((axis) => axisKnown(record, axis));
      if (!knownRelevantAxes.length) {
        unresolved += 1;
        continue;
      }
    }

    return result(true);
  }

  return result(false);
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

const GROUP_DRILLDOWN_ORDER: Record<
  VehicleSelectorMode,
  VehicleSelectorAxis[]
> = {
  NEW_CAR: [
    'powertrain',
    'drivetrain',
    'seats',
    'modelYear',
    'phase',
    'fuelType',
    'trim',
  ],
  USED_CAR: [
    'modelYear',
    'phase',
    'powertrain',
    'fuelType',
    'drivetrain',
    'seats',
    'trim',
  ],
};

function groupDrilldownAxes(
  members: readonly VehicleSelectorCandidate[],
  mode: VehicleSelectorMode
): VehicleSelectorGroupDrilldownAxis[] {
  const selectable = members.filter((candidate) => candidate.action === 'SELECT');
  const preferred = GROUP_DRILLDOWN_ORDER[mode];

  const axes = preferred.flatMap((axis) => {
    const counts = new Map<string, VehicleSelectorFacetOption>();
    let unknownValueCount = 0;

    for (const candidate of selectable) {
      const option = facetOption(candidate.record, axis);
      if (!option) {
        unknownValueCount += 1;
        continue;
      }
      const key = JSON.stringify([option.id, option.label, option.value]);
      const current = counts.get(key);
      counts.set(key, {
        ...option,
        count: (current?.count ?? 0) + 1,
      });
    }

    const options = [...counts.values()].sort((a, b) =>
      (a.value ?? Number.MAX_SAFE_INTEGER) - (b.value ?? Number.MAX_SAFE_INTEGER) ||
      a.label.localeCompare(b.label)
    );

    if (options.length < 2) return [];

    const largestBucketCount = Math.max(...options.map((option) => option.count));
    const discriminationScore = Math.max(
      0,
      selectable.length - (largestBucketCount + unknownValueCount)
    );

    return [{
      axis,
      options,
      selectableCandidateCount: selectable.length,
      unknownValueCount,
      largestBucketCount,
      discriminationScore,
    }];
  });

  const orderIndex = new Map(preferred.map((axis, index) => [axis, index]));
  return axes.sort((a, b) => {
    const aTrim = a.axis === 'trim' ? 1 : 0;
    const bTrim = b.axis === 'trim' ? 1 : 0;
    return (
      aTrim - bTrim ||
      b.discriminationScore - a.discriminationScore ||
      (orderIndex.get(a.axis) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndex.get(b.axis) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

function groupIdentityKey(
  record: VehicleSelectorRecord,
  mode: VehicleSelectorMode
) {
  const modelId = record.model.id;

  if (!modelId) {
    return {
      key: `unresolved:${record.recordId}`,
      scope: 'UNRESOLVED_IDENTITY' as const,
    };
  }

  if (mode === 'NEW_CAR') {
    return {
      key: `model:${encodeURIComponent(modelId)}`,
      scope: 'MODEL' as const,
    };
  }

  const generationId = record.generation.id;
  if (!generationId) {
    return {
      key: `unresolved:${record.recordId}`,
      scope: 'UNRESOLVED_IDENTITY' as const,
    };
  }

  return {
    key: `model-generation:${encodeURIComponent(modelId)}:${encodeURIComponent(generationId)}`,
    scope: 'MODEL_GENERATION' as const,
  };
}

function buildCandidateGroups(
  candidates: readonly VehicleSelectorCandidate[],
  mode: VehicleSelectorMode
): VehicleSelectorCandidateGroup[] {
  const groups = new Map<
    string,
    {
      scope: VehicleSelectorCandidateGroupScope;
      members: VehicleSelectorCandidate[];
    }
  >();

  for (const candidate of candidates) {
    const identity = groupIdentityKey(candidate.record, mode);
    const current = groups.get(identity.key);
    if (current) {
      current.members.push(candidate);
    } else {
      groups.set(identity.key, {
        scope: identity.scope,
        members: [candidate],
      });
    }
  }

  return [...groups.entries()].map(([groupId, group]) => {
    const representative = group.members[0]!;
    const drilldownAxes = groupDrilldownAxes(group.members, mode);
    return {
      groupId,
      scope: group.scope,
      maker: structuredClone(representative.record.maker),
      model: structuredClone(representative.record.model),
      generation: structuredClone(representative.record.generation),
      representativeRecordId: representative.record.recordId,
      memberRecordIds: group.members.map((candidate) => candidate.record.recordId),
      candidateCount: group.members.length,
      selectableCount: group.members.filter(
        (candidate) => candidate.action === 'SELECT'
      ).length,
      inspectOnlyCount: group.members.filter(
        (candidate) => candidate.action === 'INSPECT_ONLY'
      ).length,
      blockedCount: group.members.filter(
        (candidate) => candidate.action === 'BLOCKED'
      ).length,
      expandable: group.members.length > 1,
      drilldownAxes,
      suggestedDrilldownAxis: drilldownAxes[0]?.axis ?? null,
    };
  });
}

function finalizationReasonsForRecord(
  record: VehicleSelectorRecord,
  mode: VehicleSelectorMode
): VehicleSelectorFinalizationReason[] {
  const reasons: VehicleSelectorFinalizationReason[] = [];

  if (!hasText(record.recordId)) reasons.push('MISSING_RECORD_ID');
  if (!hasText(record.maker.label)) reasons.push('MISSING_MAKER');
  if (!hasText(record.model.id)) reasons.push('MISSING_MODEL_ID');
  if (!hasText(record.model.label)) reasons.push('MISSING_MODEL');
  if (!hasText(record.modelYear.id)) reasons.push('MISSING_MODEL_YEAR_ID');
  if (!Number.isInteger(record.modelYear.value)) reasons.push('MISSING_MODEL_YEAR');
  if (!hasText(record.powertrain.id)) reasons.push('MISSING_POWERTRAIN_ID');
  if (!hasText(record.powertrain.label)) reasons.push('MISSING_POWERTRAIN');
  if (!hasText(record.trim.id)) reasons.push('MISSING_TRIM_ID');
  if (!hasText(record.trim.label)) reasons.push('MISSING_TRIM');

  if (mode === 'NEW_CAR') {
    if (
      record.lifecycle !== 'CURRENT' ||
      record.identityStatus !== 'RESOLVED'
    ) {
      reasons.push('MODE_SCOPE_MISMATCH');
    }
  } else {
    if (!hasText(record.generation.id)) reasons.push('MISSING_GENERATION_ID');
    if (!hasText(record.generation.label)) reasons.push('MISSING_GENERATION');
    if (!hasText(record.phase.id)) reasons.push('MISSING_PHASE_ID');
    if (!hasText(record.phase.label)) reasons.push('MISSING_PHASE');
    if (
      record.lifecycle === 'HOLD' ||
      record.identityStatus !== 'RESOLVED'
    ) {
      reasons.push('MODE_SCOPE_MISMATCH');
    }
  }

  return [...new Set(reasons)];
}

function finalizationReasonsForCandidate(
  candidate: VehicleSelectorCandidate,
  mode: VehicleSelectorMode
): VehicleSelectorFinalizationReason[] {
  const reasons = finalizationReasonsForRecord(candidate.record, mode);

  if (candidate.action !== 'SELECT' || candidate.actionState !== 'ACTIVE') {
    reasons.unshift('NON_ACTIVE_CANDIDATE');
  }
  if (
    candidate.unresolvedAxes.length > 0 ||
    candidate.search.unresolvedTokens > 0
  ) {
    reasons.unshift('UNRESOLVED_REQUEST');
  }

  return [...new Set(reasons)];
}

function candidateFinalizable(
  candidate: VehicleSelectorCandidate,
  mode: VehicleSelectorMode
) {
  return finalizationReasonsForCandidate(candidate, mode).length === 0;
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
    candidates.length === 1 &&
    candidates[0] &&
    candidateFinalizable(candidates[0], request.mode)
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
      ranking: search.ranking,
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
    b.matchedAxes.length - a.matchedAxes.length ||
    b.ranking.directSearchMatches - a.ranking.directSearchMatches ||
    b.ranking.exactSearchMatches - a.ranking.exactSearchMatches ||
    b.ranking.specificityScore - a.ranking.specificityScore ||
    a.ranking.aliasOnlySearchMatches - b.ranking.aliasOnlySearchMatches ||
    a.search.unresolvedTokens - b.search.unresolvedTokens ||
    a.unresolvedAxes.length - b.unresolvedAxes.length ||
    b.score - a.score ||
    a.record.recordId.localeCompare(b.record.recordId)
  );

  const facets = buildFacets(records, request, searchContext);
  const groups = buildCandidateGroups(candidates, request.mode);

  return {
    mode: request.mode,
    candidates,
    groups,
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

function assignGroupIdentity(
  selection: VehicleSelectorSelection,
  group: VehicleSelectorCandidateGroup
) {
  if (
    group.scope === 'UNRESOLVED_IDENTITY' ||
    !hasText(group.maker.label) ||
    !group.model.id ||
    !hasText(group.model.label)
  ) {
    return false;
  }

  clearSelectionAxis(selection, 'maker');
  if (group.maker.id) selection.makerId = group.maker.id;
  selection.maker = group.maker.label;
  selection.modelId = group.model.id;
  selection.model = group.model.label;

  if (group.scope === 'MODEL_GENERATION') {
    if (!group.generation.id || !hasText(group.generation.label)) {
      return false;
    }
    selection.generationId = group.generation.id;
    selection.generation = group.generation.label;
  }

  return true;
}

function assignDrilldownOption(
  selection: VehicleSelectorSelection,
  axis: VehicleSelectorAxis,
  option: VehicleSelectorFacetOption
) {
  clearSelectionAxis(selection, axis);

  switch (axis) {
    case 'maker':
      selection.makerId = option.id;
      selection.maker = option.label;
      break;
    case 'model':
      selection.modelId = option.id;
      selection.model = option.label;
      break;
    case 'generation':
      selection.generationId = option.id;
      selection.generation = option.label;
      break;
    case 'phase':
      selection.phaseId = option.id;
      selection.phase = option.label;
      break;
    case 'modelYear':
      selection.modelYearId = option.id;
      selection.modelYear = option.value;
      break;
    case 'powertrain':
      selection.powertrainId = option.id;
      selection.powertrain = option.label;
      break;
    case 'fuelType':
      selection.fuelType = option.label;
      break;
    case 'drivetrain':
      selection.drivetrain = option.label;
      break;
    case 'seats':
      selection.seats = option.value;
      break;
    case 'trim':
      selection.trimId = option.id;
      selection.trim = option.label;
      break;
  }
}

function sameFacetOption(
  left: VehicleSelectorFacetOption,
  right: VehicleSelectorFacetOption
) {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.value === right.value
  );
}

function rejectedGroupTransition(
  before: VehicleSelectorResult,
  selection: VehicleSelectorSelection,
  groupId: string,
  reason: VehicleSelectorGroupTransitionReason
): VehicleSelectorGroupTransition {
  const group = before.groups.find((item) => item.groupId === groupId) ?? null;
  return {
    status: 'REJECTED',
    reason,
    sourceGroupId: groupId,
    sourceCandidateCount: group?.candidateCount ?? null,
    selection: structuredClone(selection),
    clearedAxes: [],
    activeGroupId: null,
    beforeCandidateCount: before.candidates.length,
    afterCandidateCount: before.candidates.length,
    beforeGroupCount: before.groups.length,
    afterGroupCount: before.groups.length,
    result: before,
  };
}

export function applyVehicleGroupSelection(
  records: readonly VehicleSelectorRecord[],
  request: Omit<VehicleSelectorRequest, 'selection'>,
  currentSelection: VehicleSelectorSelection,
  groupId: string
): VehicleSelectorGroupTransition {
  const before = selectVehicles(records, {
    ...request,
    selection: currentSelection,
  });
  const group = before.groups.find((item) => item.groupId === groupId);

  if (!group) {
    return rejectedGroupTransition(
      before,
      currentSelection,
      groupId,
      'GROUP_NOT_FOUND'
    );
  }

  const nextSelection: VehicleSelectorSelection = { ...currentSelection };
  if (!assignGroupIdentity(nextSelection, group)) {
    return rejectedGroupTransition(
      before,
      currentSelection,
      groupId,
      'UNRESOLVED_GROUP_IDENTITY'
    );
  }

  const reconciled = reconcileVehicleSelection(
    records,
    request,
    nextSelection,
    ['maker', 'model', 'generation']
  );
  const activeGroup = reconciled.result.groups.find(
    (item) => item.groupId === groupId
  ) ?? null;

  return {
    status: 'APPLIED',
    reason: null,
    sourceGroupId: groupId,
    sourceCandidateCount: group.candidateCount,
    selection: reconciled.selection,
    clearedAxes: reconciled.clearedAxes,
    activeGroupId: activeGroup?.groupId ?? null,
    beforeCandidateCount: before.candidates.length,
    afterCandidateCount: reconciled.result.candidates.length,
    beforeGroupCount: before.groups.length,
    afterGroupCount: reconciled.result.groups.length,
    result: reconciled.result,
  };
}

export function applyVehicleGroupDrilldown(
  records: readonly VehicleSelectorRecord[],
  request: Omit<VehicleSelectorRequest, 'selection'>,
  currentSelection: VehicleSelectorSelection,
  groupId: string,
  axis: VehicleSelectorAxis,
  option: VehicleSelectorFacetOption
): VehicleSelectorGroupTransition {
  const before = selectVehicles(records, {
    ...request,
    selection: currentSelection,
  });
  const group = before.groups.find((item) => item.groupId === groupId);

  if (!group) {
    return rejectedGroupTransition(
      before,
      currentSelection,
      groupId,
      'GROUP_NOT_FOUND'
    );
  }

  if (group.scope === 'UNRESOLVED_IDENTITY') {
    return rejectedGroupTransition(
      before,
      currentSelection,
      groupId,
      'UNRESOLVED_GROUP_IDENTITY'
    );
  }

  const drilldown = group.drilldownAxes.find((item) => item.axis === axis);
  if (!drilldown) {
    return rejectedGroupTransition(
      before,
      currentSelection,
      groupId,
      'DRILLDOWN_AXIS_NOT_AVAILABLE'
    );
  }

  const offered = drilldown.options.find((item) => sameFacetOption(item, option));
  if (!offered) {
    return rejectedGroupTransition(
      before,
      currentSelection,
      groupId,
      'DRILLDOWN_OPTION_NOT_AVAILABLE'
    );
  }

  const nextSelection: VehicleSelectorSelection = { ...currentSelection };
  if (!assignGroupIdentity(nextSelection, group)) {
    return rejectedGroupTransition(
      before,
      currentSelection,
      groupId,
      'UNRESOLVED_GROUP_IDENTITY'
    );
  }
  assignDrilldownOption(nextSelection, axis, offered);

  const reconciled = reconcileVehicleSelection(
    records,
    request,
    nextSelection,
    ['maker', 'model', 'generation', axis]
  );
  const activeGroup = reconciled.result.groups.find(
    (item) => item.groupId === groupId
  ) ?? null;

  return {
    status: 'APPLIED',
    reason: null,
    sourceGroupId: groupId,
    sourceCandidateCount: group.candidateCount,
    selection: reconciled.selection,
    clearedAxes: reconciled.clearedAxes,
    activeGroupId: activeGroup?.groupId ?? null,
    beforeCandidateCount: before.candidates.length,
    afterCandidateCount: reconciled.result.candidates.length,
    beforeGroupCount: before.groups.length,
    afterGroupCount: reconciled.result.groups.length,
    result: reconciled.result,
  };
}

export function finalizeVehicleSelection(
  records: readonly VehicleSelectorRecord[],
  request: VehicleSelectorRequest,
  recordId?: string | null
): VehicleSelectorFinalizationDecision {
  const result = selectVehicles(records, request);

  let candidate: VehicleSelectorCandidate | undefined;

  if (hasText(recordId)) {
    candidate = result.candidates.find(
      (item) => item.record.recordId === recordId
    );
    if (!candidate) {
      return {
        status: 'HOLD',
        recordId: null,
        reasons: ['CANDIDATE_NOT_FOUND'],
        result,
      };
    }
  } else {
    if (result.candidates.length !== 1) {
      return {
        status: 'HOLD',
        recordId: null,
        reasons: result.candidates.length > 1
          ? ['AMBIGUOUS_CANDIDATES']
          : ['CANDIDATE_NOT_FOUND'],
        result,
      };
    }
    candidate = result.candidates[0];
  }

  const reasons = finalizationReasonsForCandidate(candidate!, request.mode);
  return {
    status: reasons.length ? 'HOLD' : 'APPROVED',
    recordId: reasons.length ? null : candidate!.record.recordId,
    reasons,
    result,
  };
}

function normalizedSelectionSnapshot(
  selection: VehicleSelectorSelection | undefined
) {
  const snapshot: VehicleSelectorSelection = {};
  for (const axis of AXES) {
    if (!selection || !axisSelected(selection, axis)) continue;
    const selected = selectionForAxis(selection, axis);
    switch (axis) {
      case 'maker':
        if ('id' in selected && selected.id !== undefined) snapshot.makerId = selected.id;
        if ('label' in selected && selected.label !== undefined) snapshot.maker = selected.label;
        break;
      case 'model':
        if ('id' in selected && selected.id !== undefined) snapshot.modelId = selected.id;
        if ('label' in selected && selected.label !== undefined) snapshot.model = selected.label;
        break;
      case 'generation':
        if ('id' in selected && selected.id !== undefined) snapshot.generationId = selected.id;
        if ('label' in selected && selected.label !== undefined) snapshot.generation = selected.label;
        break;
      case 'phase':
        if ('id' in selected && selected.id !== undefined) snapshot.phaseId = selected.id;
        if ('label' in selected && selected.label !== undefined) snapshot.phase = selected.label;
        break;
      case 'modelYear':
        if ('id' in selected && selected.id !== undefined) snapshot.modelYearId = selected.id;
        if ('value' in selected && selected.value !== undefined) snapshot.modelYear = selected.value;
        break;
      case 'powertrain':
        if ('id' in selected && selected.id !== undefined) snapshot.powertrainId = selected.id;
        if ('label' in selected && selected.label !== undefined) snapshot.powertrain = selected.label;
        break;
      case 'fuelType':
        if ('label' in selected && selected.label !== undefined) snapshot.fuelType = selected.label;
        break;
      case 'drivetrain':
        if ('label' in selected && selected.label !== undefined) snapshot.drivetrain = selected.label;
        break;
      case 'seats':
        if ('value' in selected && selected.value !== undefined) snapshot.seats = selected.value;
        break;
      case 'trim':
        if ('id' in selected && selected.id !== undefined) snapshot.trimId = selected.id;
        if ('label' in selected && selected.label !== undefined) snapshot.trim = selected.label;
        break;
    }
  }
  return snapshot;
}

function receiptUnsigned(
  receipt: Omit<VehicleSelectionReceipt, 'receiptDigest'>
) {
  return {
    contractVersion: receipt.contractVersion,
    selectorContract: receipt.selectorContract,
    receiptId: receipt.receiptId,
    issuedAt: receipt.issuedAt,
    snapshotDigest: receipt.snapshotDigest,
    snapshot: receipt.snapshot,
  };
}

export function issueVehicleSelectionReceipt(
  records: readonly VehicleSelectorRecord[],
  request: VehicleSelectorRequest,
  issuedAt: string,
  recordId?: string | null
): VehicleSelectionReceiptIssue {
  if (!Number.isFinite(Date.parse(issuedAt))) {
    throw new Error('INVALID_VEHICLE_SELECTION_RECEIPT_ISSUED_AT');
  }

  const decision = finalizeVehicleSelection(records, request, recordId);
  if (decision.status !== 'APPROVED' || !decision.recordId) {
    return {
      status: 'HOLD',
      reasons: [...decision.reasons],
      receipt: null,
      result: decision.result,
    };
  }

  const candidate = decision.result.candidates.find(
    (item) => item.record.recordId === decision.recordId
  );
  if (!candidate) {
    throw new Error('APPROVED_VEHICLE_SELECTION_CANDIDATE_MISSING');
  }

  const snapshot: VehicleSelectionSnapshot = {
    mode: request.mode,
    searchText: hasText(request.searchText) ? normalize(request.searchText) : null,
    selection: normalizedSelectionSnapshot(request.selection),
    includeHold: request.includeHold ?? null,
    record: structuredClone(candidate.record),
  };
  const snapshotDigest = stableDigest(snapshot);
  const receiptId = `vehicle_selection_${stableDigest({
    contractVersion: VEHICLE_SELECTION_RECEIPT_CONTRACT,
    selectorContract: VEHICLE_SELECTOR_CONTRACT,
    issuedAt,
    snapshotDigest,
  })}`;

  const unsigned: Omit<VehicleSelectionReceipt, 'receiptDigest'> = {
    contractVersion: VEHICLE_SELECTION_RECEIPT_CONTRACT,
    selectorContract: VEHICLE_SELECTOR_CONTRACT,
    receiptId,
    issuedAt,
    snapshotDigest,
    snapshot,
  };
  const receipt: VehicleSelectionReceipt = {
    ...unsigned,
    receiptDigest: stableDigest(unsigned),
  };

  return {
    status: 'ISSUED',
    reasons: [],
    receipt,
    result: decision.result,
  };
}

export function assertVehicleSelectionReceipt(
  receipt: VehicleSelectionReceipt
) {
  if (receipt.contractVersion !== VEHICLE_SELECTION_RECEIPT_CONTRACT) {
    throw new Error('UNSUPPORTED_VEHICLE_SELECTION_RECEIPT_CONTRACT');
  }
  if (receipt.selectorContract !== VEHICLE_SELECTOR_CONTRACT) {
    throw new Error('VEHICLE_SELECTION_SELECTOR_CONTRACT_MISMATCH');
  }
  if (!Number.isFinite(Date.parse(receipt.issuedAt))) {
    throw new Error('INVALID_VEHICLE_SELECTION_RECEIPT_ISSUED_AT');
  }

  const snapshotDigest = stableDigest(receipt.snapshot);
  if (
    !/^[a-f0-9]{64}$/.test(receipt.snapshotDigest) ||
    snapshotDigest !== receipt.snapshotDigest
  ) {
    throw new Error('VEHICLE_SELECTION_SNAPSHOT_DIGEST_MISMATCH');
  }

  const expectedReceiptId = `vehicle_selection_${stableDigest({
    contractVersion: receipt.contractVersion,
    selectorContract: receipt.selectorContract,
    issuedAt: receipt.issuedAt,
    snapshotDigest: receipt.snapshotDigest,
  })}`;
  if (receipt.receiptId !== expectedReceiptId) {
    throw new Error('VEHICLE_SELECTION_RECEIPT_ID_MISMATCH');
  }

  const expectedReceiptDigest = stableDigest(receiptUnsigned(receipt));
  if (
    !/^[a-f0-9]{64}$/.test(receipt.receiptDigest) ||
    expectedReceiptDigest !== receipt.receiptDigest
  ) {
    throw new Error('VEHICLE_SELECTION_RECEIPT_DIGEST_MISMATCH');
  }

  if (receipt.snapshot.record.recordId === '' ||
      receipt.snapshot.record.recordId == null) {
    throw new Error('VEHICLE_SELECTION_RECEIPT_RECORD_ID_MISSING');
  }

  return true;
}

function selectionRelevantRecordSnapshot(record: VehicleSelectorRecord) {
  return {
    recordId: record.recordId,
    lifecycle: record.lifecycle,
    identityStatus: record.identityStatus,
    maker: record.maker,
    model: record.model,
    generation: record.generation,
    phase: record.phase,
    modelYear: record.modelYear,
    powertrain: record.powertrain,
    fuelType: record.fuelType,
    drivetrain: record.drivetrain,
    seats: record.seats,
    trim: record.trim,
  };
}

function assertReceiptRevalidationPolicy(
  policy: VehicleSelectionReceiptRevalidationPolicy
) {
  if (
    !Number.isFinite(Date.parse(policy.assessedAt)) ||
    (policy.maxAgeMs !== undefined &&
      (!Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs <= 0)) ||
    (policy.maxFutureSkewMs !== undefined &&
      (!Number.isSafeInteger(policy.maxFutureSkewMs) ||
        policy.maxFutureSkewMs < 0))
  ) {
    throw new Error('INVALID_VEHICLE_SELECTION_RECEIPT_REVALIDATION_POLICY');
  }
}

export function revalidateVehicleSelectionReceipt(
  receipt: VehicleSelectionReceipt,
  currentRecords: readonly VehicleSelectorRecord[],
  policy: VehicleSelectionReceiptRevalidationPolicy
): VehicleSelectionReceiptRevalidationDecision {
  assertVehicleSelectionReceipt(receipt);
  assertReceiptRevalidationPolicy(policy);

  const assessedAt = Date.parse(policy.assessedAt);
  const issuedAt = Date.parse(receipt.issuedAt);
  const skew = policy.maxFutureSkewMs ?? 0;
  const ageMs = Math.max(0, assessedAt - issuedAt);
  const reasons: VehicleSelectionReceiptRevalidationReason[] = [];

  if (issuedAt > assessedAt + skew) {
    reasons.push('RECEIPT_FROM_FUTURE');
  }
  if (policy.maxAgeMs !== undefined && ageMs > policy.maxAgeMs) {
    reasons.push('RECEIPT_STALE');
  }

  const recordId = receipt.snapshot.record.recordId;
  const currentRecord = currentRecords.find(
    (record) => record.recordId === recordId
  ) ?? null;

  const snapshotRecordDigest = stableDigest(
    selectionRelevantRecordSnapshot(receipt.snapshot.record)
  );

  if (!currentRecord) {
    reasons.push('CURRENT_RECORD_NOT_FOUND');
    return {
      status: 'RESELECT_REQUIRED',
      reasons,
      receiptId: receipt.receiptId,
      recordId,
      ageMs,
      snapshotRecordDigest,
      currentRecordDigest: null,
      currentRecordChanged: true,
      result: null,
    };
  }

  const currentRecordDigest = stableDigest(
    selectionRelevantRecordSnapshot(currentRecord)
  );
  const currentRecordChanged = currentRecordDigest !== snapshotRecordDigest;
  if (currentRecordChanged) {
    reasons.push('CURRENT_RECORD_CHANGED');
  }

  if (
    finalizationReasonsForRecord(
      currentRecord,
      receipt.snapshot.mode
    ).length > 0
  ) {
    reasons.push('CURRENT_RECORD_NOT_FINALIZABLE');
  }

  const request: VehicleSelectorRequest = {
    mode: receipt.snapshot.mode,
    searchText: receipt.snapshot.searchText,
    selection: structuredClone(receipt.snapshot.selection),
    ...(receipt.snapshot.includeHold == null
      ? {}
      : { includeHold: receipt.snapshot.includeHold }),
  };
  const result = selectVehicles(currentRecords, request);
  const stillMatches = result.candidates.some(
    (candidate) => candidate.record.recordId === recordId
  );

  if (!stillMatches) {
    reasons.push('CURRENT_REQUEST_NO_LONGER_MATCHES');
  }

  return {
    status: reasons.length ? 'RESELECT_REQUIRED' : 'CURRENT',
    reasons: [...new Set(reasons)],
    receiptId: receipt.receiptId,
    recordId,
    ageMs,
    snapshotRecordDigest,
    currentRecordDigest,
    currentRecordChanged,
    result,
  };
}


