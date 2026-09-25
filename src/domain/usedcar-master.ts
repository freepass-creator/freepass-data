import { stableDigest } from '../shared/stable-digest.js';

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

const text = (value: string | null | undefined) =>
  (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[^0-9a-z가-힣.+-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const compact = (value: string | null | undefined) =>
  text(value).replace(/\s+/g, '');

const uniqueSorted = (values: readonly string[]) =>
  [...new Set(values.filter(Boolean))].sort();

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
  return (
    Boolean(text(query.searchText)) ||
    Boolean(text(query.maker)) ||
    Boolean(text(query.model)) ||
    Boolean(text(query.generation)) ||
    Boolean(text(query.phase)) ||
    query.modelYear != null ||
    Boolean(text(query.powertrain)) ||
    Boolean(text(query.trim)) ||
    Boolean(text(query.fuelType)) ||
    Boolean(text(query.drivetrain)) ||
    query.seats != null
  );
}

function matchTextField(
  queryValue: string | null | undefined,
  recordValue: string | null,
  field: string,
  matched: string[],
  unresolved: string[]
): { rejected: boolean; score: number } {
  const q = compact(queryValue);
  if (!q) return { rejected: false, score: 0 };
  const r = compact(recordValue);
  if (!r) {
    unresolved.push(field);
    return { rejected: false, score: 0 };
  }
  if (r.includes(q) || q.includes(r)) {
    matched.push(field);
    return { rejected: false, score: 20 };
  }
  return { rejected: true, score: 0 };
}

function matchNumberField(
  queryValue: number | null | undefined,
  recordValue: number | null,
  field: string,
  matched: string[],
  unresolved: string[]
): { rejected: boolean; score: number } {
  if (queryValue == null) return { rejected: false, score: 0 };
  if (recordValue == null) {
    unresolved.push(field);
    return { rejected: false, score: 0 };
  }
  if (recordValue === queryValue) {
    matched.push(field);
    return { rejected: false, score: 20 };
  }
  return { rejected: true, score: 0 };
}

export function searchUsedcarMaster(
  records: readonly UsedcarMasterRecord[],
  query: UsedcarMasterQuery
): UsedcarMasterCandidate[] {
  if (!nonEmptyQuery(query)) {
    throw new Error('USEDCAR_MASTER_QUERY_REQUIRED');
  }

  const candidates: UsedcarMasterCandidate[] = [];

  for (const record of records) {
    const matchedFields: string[] = [];
    const unresolvedFields: string[] = [];
    let score = 0;
    let rejected = false;

    const checks = [
      matchTextField(query.maker, record.maker, 'maker', matchedFields, unresolvedFields),
      matchTextField(query.model, record.model, 'model', matchedFields, unresolvedFields),
      matchTextField(query.generation, record.generationName, 'generation', matchedFields, unresolvedFields),
      matchTextField(query.phase, record.phaseName, 'phase', matchedFields, unresolvedFields),
      matchNumberField(query.modelYear, record.modelYear, 'modelYear', matchedFields, unresolvedFields),
      matchTextField(query.powertrain, record.powertrainName, 'powertrain', matchedFields, unresolvedFields),
      matchTextField(query.trim, record.trimName, 'trim', matchedFields, unresolvedFields),
      matchTextField(query.fuelType, record.configuration.fuelType, 'fuelType', matchedFields, unresolvedFields),
      matchTextField(query.drivetrain, record.configuration.drivetrain, 'drivetrain', matchedFields, unresolvedFields),
      matchNumberField(query.seats, record.configuration.seats, 'seats', matchedFields, unresolvedFields),
    ];

    for (const check of checks) {
      if (check.rejected) {
        rejected = true;
        break;
      }
      score += check.score;
    }
    if (rejected) continue;

    const tokens = text(query.searchText).split(' ').filter(Boolean);
    if (tokens.length) {
      const haystack = text([
        record.maker,
        record.model,
        record.generationName ?? '',
        record.phaseName ?? '',
        record.modelYear == null ? '' : String(record.modelYear),
        record.powertrainName ?? '',
        record.trimName ?? '',
        record.configuration.fuelType ?? '',
        record.configuration.drivetrain ?? '',
        record.configuration.seats == null ? '' : String(record.configuration.seats),
        ...record.aliases,
      ].join(' '));

      let textMatched = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) textMatched += 1;
      }
      if (textMatched === 0) continue;
      score += textMatched * 5;
      matchedFields.push('searchText');
      if (textMatched < tokens.length) unresolvedFields.push('searchText');
    }

    const completeness = [
      record.vehicleModelId,
      record.generationId,
      record.phaseId,
      record.modelYearId,
      record.powertrainId,
      record.variantId,
      record.trimId,
    ].filter(Boolean).length;
    score += completeness;

    candidates.push({
      record,
      score,
      matchedFields: uniqueSorted(matchedFields),
      unresolvedFields: uniqueSorted(unresolvedFields),
    });
  }

  return candidates.sort((a, b) =>
    b.score - a.score ||
    b.matchedFields.length - a.matchedFields.length ||
    a.unresolvedFields.length - b.unresolvedFields.length ||
    a.record.recordId.localeCompare(b.record.recordId)
  );
}
