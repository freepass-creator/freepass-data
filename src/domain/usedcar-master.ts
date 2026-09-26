import { stableDigest } from '../shared/stable-digest.js';
import {
  selectVehicles,
  type VehicleSelectorRecord,
  type VehicleSelectorSelection,
} from './vehicle-selector.js';

export const USEDCAR_MASTER_CONTRACT = 'usedcar-master/v1';
export const USEDCAR_MASTER_PROJECTION_ID = 'usedcar-master';

export type UsedcarMasterLifecycleStatus =
  | 'CURRENT'
  | 'HISTORICAL'
  | 'DISCONTINUED'
  | 'HOLD';

export type UsedcarMasterIdentityStatus = 'RESOLVED' | 'PARTIAL' | 'HOLD';

export type UsedcarMasterMoney = {
  amount: number;
  currency: 'KRW';
};

export type UsedcarMasterPriceFact = {
  priceRevisionId: string;
  amount: number;
  currency: 'KRW';
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceDocumentIds: string[];
};

export type UsedcarMasterRecord = {
  recordId: string;
  vehicleModelId: string | null;
  generationId: string | null;
  phaseId: string | null;
  modelYearId: string | null;
  powertrainId: string | null;
  variantId: string | null;
  trimId: string | null;

  maker: string;
  model: string;
  generationName: string | null;
  phaseName: string | null;
  modelYear: number | null;
  powertrainName: string | null;
  trimName: string | null;

  configuration: {
    fuelType: string | null;
    drivetrain: string | null;
    seats: number | null;
  };

  aliases: string[];
  originalBasePriceHistory: UsedcarMasterPriceFact[];
  lifecycleStatus: UsedcarMasterLifecycleStatus;
  identityStatus: UsedcarMasterIdentityStatus;
  holdReasons: string[];
  sourceEvidenceIds: string[];
};

export type UsedcarMasterQuery = {
  searchText?: string | null;
  maker?: string | null;
  model?: string | null;
  generation?: string | null;
  phase?: string | null;
  modelYear?: number | null;
  powertrain?: string | null;
  trim?: string | null;
  fuelType?: string | null;
  drivetrain?: string | null;
  seats?: number | null;
};

export type UsedcarMasterCandidate = {
  record: UsedcarMasterRecord;
  score: number;
  matchedFields: string[];
  unresolvedFields: string[];
};

export type UsedcarMasterSemanticIssue = {
  code: string;
  recordId?: string;
  field?: string;
  detail?: string;
};

export function usedcarMasterRecordId(trimId: string | null, fallbackIdentity: unknown) {
  return trimId
    ? `used_${trimId}`
    : `used_partial_${stableDigest(fallbackIdentity).slice(0, 24)}`;
}

export function validateUsedcarMasterSemantics(
  records: readonly UsedcarMasterRecord[]
): UsedcarMasterSemanticIssue[] {
  const issues: UsedcarMasterSemanticIssue[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    if (seen.has(record.recordId)) {
      issues.push({ code: 'DUPLICATE_RECORD_ID', recordId: record.recordId });
    }
    seen.add(record.recordId);

    const dependencyPairs: Array<[keyof UsedcarMasterRecord, keyof UsedcarMasterRecord]> = [
      ['generationId', 'vehicleModelId'],
      ['phaseId', 'generationId'],
      ['modelYearId', 'phaseId'],
      ['powertrainId', 'modelYearId'],
      ['variantId', 'powertrainId'],
      ['trimId', 'variantId'],
    ];
    for (const [child, parent] of dependencyPairs) {
      if (record[child] && !record[parent]) {
        issues.push({
          code: 'IDENTITY_PARENT_REQUIRED',
          recordId: record.recordId,
          field: String(child),
          detail: String(parent),
        });
      }
    }

    if (record.identityStatus === 'RESOLVED') {
      for (const [field, value] of [
        ['vehicleModelId', record.vehicleModelId],
        ['generationId', record.generationId],
        ['phaseId', record.phaseId],
        ['modelYearId', record.modelYearId],
        ['powertrainId', record.powertrainId],
        ['variantId', record.variantId],
        ['trimId', record.trimId],
      ] as const) {
        if (!value) {
          issues.push({
            code: 'RESOLVED_STABLE_ID_REQUIRED',
            recordId: record.recordId,
            field,
          });
        }
      }
      if (!Number.isInteger(record.modelYear)) {
        issues.push({
          code: 'RESOLVED_MODEL_YEAR_REQUIRED',
          recordId: record.recordId,
          field: 'modelYear',
        });
      }
    }

    if (record.identityStatus === 'HOLD' && !record.holdReasons.length) {
      issues.push({
        code: 'HOLD_REASON_REQUIRED',
        recordId: record.recordId,
        field: 'holdReasons',
      });
    }

    for (const price of record.originalBasePriceHistory) {
      if (!Number.isSafeInteger(price.amount) || price.amount < 0) {
        issues.push({
          code: 'INVALID_ORIGINAL_BASE_PRICE',
          recordId: record.recordId,
          field: price.priceRevisionId,
        });
      }
    }
  }

  return issues;
}

function nonEmptyQuery(query: UsedcarMasterQuery) {
  return Object.values(query).some((value) =>
    typeof value === 'string' ? Boolean(value.trim()) : value != null
  );
}

function toSelectorRecord(record: UsedcarMasterRecord): VehicleSelectorRecord {
  return {
    recordId: record.recordId,
    lifecycle: record.lifecycleStatus,
    identityStatus: record.identityStatus,
    maker: { id: null, label: record.maker },
    model: { id: record.vehicleModelId, label: record.model },
    generation: { id: record.generationId, label: record.generationName },
    phase: { id: record.phaseId, label: record.phaseName },
    modelYear: {
      id: record.modelYearId,
      label: record.modelYear == null ? null : `${record.modelYear}년형`,
      value: record.modelYear,
    },
    powertrain: { id: record.powertrainId, label: record.powertrainName },
    fuelType: { id: null, label: record.configuration.fuelType },
    drivetrain: { id: null, label: record.configuration.drivetrain },
    seats: {
      id: null,
      label: record.configuration.seats == null
        ? null
        : `${record.configuration.seats}인승`,
      value: record.configuration.seats,
    },
    trim: { id: record.trimId, label: record.trimName },
    aliases: [...record.aliases],
  };
}

export function searchUsedcarMaster(
  records: readonly UsedcarMasterRecord[],
  query: UsedcarMasterQuery
): UsedcarMasterCandidate[] {
  if (!nonEmptyQuery(query)) {
    throw new Error('USEDCAR_MASTER_QUERY_REQUIRED');
  }

  const selection: VehicleSelectorSelection = {};
  if (query.maker !== undefined) selection.maker = query.maker;
  if (query.model !== undefined) selection.model = query.model;
  if (query.generation !== undefined) selection.generation = query.generation;
  if (query.phase !== undefined) selection.phase = query.phase;
  if (query.modelYear !== undefined) selection.modelYear = query.modelYear;
  if (query.powertrain !== undefined) selection.powertrain = query.powertrain;
  if (query.fuelType !== undefined) selection.fuelType = query.fuelType;
  if (query.drivetrain !== undefined) selection.drivetrain = query.drivetrain;
  if (query.seats !== undefined) selection.seats = query.seats;
  if (query.trim !== undefined) selection.trim = query.trim;

  const byId = new Map(records.map((record) => [record.recordId, record]));
  const hasSearchText =
    typeof query.searchText === 'string' && Boolean(query.searchText.trim());
  const result = selectVehicles(
    records.map(toSelectorRecord),
    {
      mode: 'USED_CAR',
      selection,
      includeHold: true,
      ...(query.searchText !== undefined ? { searchText: query.searchText } : {}),
    }
  );

  return result.candidates.map((candidate) => {
    const record = byId.get(candidate.record.recordId)!;
    return {
      record,
      score: candidate.score,
      matchedFields: [
        ...candidate.matchedAxes,
        ...(hasSearchText && candidate.search.matchedTokens > 0
          ? ['searchText']
          : []),
      ],
      unresolvedFields: [
        ...candidate.unresolvedAxes,
        ...(candidate.search.unresolvedTokens > 0 ? ['searchText'] : []),
      ],
    };
  });
}
