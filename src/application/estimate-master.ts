import {
  type EstimateMasterColor,
  type EstimateMasterMoney,
  type EstimateMasterOption,
  type EstimateNewcarMasterRecord,
  validateEstimateMasterSemantics,
} from '../domain/estimate-master.js';

export type EstimateMasterCandidate = {
  productId: string;
  vehicleModelId?: string | null;
  modelYearId?: string | null;
  trimId?: string | null;
  powertrainId?: string | null;
  maker: string;
  model: string;
  modelYear?: number | null;
  trimName: string;
  powertrainName: string;
  basePrice: EstimateMasterMoney;
  options?: EstimateMasterOption[];
  exteriorColors?: EstimateMasterColor[];
  interiorColors?: EstimateMasterColor[];
  configuration?: {
    drivetrain?: string | null;
    seats?: number | null;
    bodyConfiguration?: string | null;
  };
  holdReasons?: string[];
};

function text(value: unknown, field: string) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`ESTIMATE_MASTER_CANDIDATE_INVALID:${field}`);
  return normalized;
}

function nullableId(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function money(value: EstimateMasterMoney, field: string): EstimateMasterMoney {
  if (!value || value.currency !== 'KRW' || !Number.isSafeInteger(value.amount) || value.amount < 0) {
    throw new Error(`ESTIMATE_MASTER_CANDIDATE_INVALID:${field}`);
  }
  return { amount: value.amount, currency: 'KRW' };
}

function normalizeOption(option: EstimateMasterOption): EstimateMasterOption {
  return {
    optionId: nullableId(option?.optionId),
    name: text(option?.name, 'option.name'),
    price: money(option?.price, 'option.price'),
    requires: [...new Set((option?.requires || []).map((id) => text(id, 'option.requires')))].sort(),
    excludes: [...new Set((option?.excludes || []).map((id) => text(id, 'option.excludes')))].sort(),
    exclusiveGroupId: nullableId(option?.exclusiveGroupId),
  };
}

function normalizeColor(color: EstimateMasterColor): EstimateMasterColor {
  return {
    colorId: nullableId(color?.colorId),
    name: text(color?.name, 'color.name'),
    code: nullableId(color?.code),
    price: money(color?.price, 'color.price'),
  };
}

function uniqueReasons(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

/**
 * Converts reviewed source/canonical facts into the Estimate projection record.
 * Missing evidence is represented as HOLD; this builder never synthesizes stable IDs
 * or a model year from labels, current date, UI hashes, sequence numbers or defaults.
 */
export function buildEstimateNewcarMasterRecord(
  candidate: EstimateMasterCandidate
): EstimateNewcarMasterRecord {
  const reasons = [...(candidate.holdReasons || []).map((reason) => text(reason, 'holdReason'))];

  const vehicleModelId = nullableId(candidate.vehicleModelId);
  const modelYearId = nullableId(candidate.modelYearId);
  const trimId = nullableId(candidate.trimId);
  const powertrainId = nullableId(candidate.powertrainId);
  const modelYear = candidate.modelYear == null ? null : Number(candidate.modelYear);

  if (!vehicleModelId) reasons.push('VEHICLE_MODEL_ID_UNVERIFIED');
  if (!modelYearId) reasons.push('MODEL_YEAR_ID_UNVERIFIED');
  if (!trimId) reasons.push('TRIM_ID_UNVERIFIED');
  if (!powertrainId) reasons.push('POWERTRAIN_ID_UNVERIFIED');
  const validModelYear = typeof modelYear === 'number' &&
    Number.isInteger(modelYear) && modelYear >= 1900 && modelYear <= 2200;
  if (!validModelYear) reasons.push('MODEL_YEAR_UNVERIFIED');

  const options = (candidate.options || []).map(normalizeOption);
  const exteriorColors = (candidate.exteriorColors || []).map(normalizeColor);
  const interiorColors = (candidate.interiorColors || []).map(normalizeColor);

  if (options.some((option) => !option.optionId)) reasons.push('OPTION_ID_UNVERIFIED');
  if (exteriorColors.some((color) => !color.colorId) ||
      interiorColors.some((color) => !color.colorId)) reasons.push('COLOR_ID_UNVERIFIED');
  if (!exteriorColors.length) reasons.push('EXTERIOR_COLOR_UNAVAILABLE');
  if (!interiorColors.length) reasons.push('INTERIOR_COLOR_UNAVAILABLE');

  const seats = candidate.configuration?.seats == null ? null : Number(candidate.configuration.seats);
  if (seats !== null && (!Number.isSafeInteger(seats) || seats < 1)) {
    throw new Error('ESTIMATE_MASTER_CANDIDATE_INVALID:configuration.seats');
  }

  let record: EstimateNewcarMasterRecord = {
    productId: text(candidate.productId, 'productId'),
    vehicleModelId,
    modelYearId,
    trimId,
    powertrainId,
    maker: text(candidate.maker, 'maker'),
    model: text(candidate.model, 'model'),
    modelYear: validModelYear ? modelYear : null,
    trimName: text(candidate.trimName, 'trimName'),
    powertrainName: text(candidate.powertrainName, 'powertrainName'),
    basePrice: money(candidate.basePrice, 'basePrice'),
    options,
    exteriorColors,
    interiorColors,
    configuration: {
      drivetrain: nullableId(candidate.configuration?.drivetrain),
      seats,
      bodyConfiguration: nullableId(candidate.configuration?.bodyConfiguration),
    },
    status: reasons.length ? 'HOLD' : 'ACTIVE',
    holdReasons: uniqueReasons(reasons),
  };

  let semanticIssues = validateEstimateMasterSemantics([record]);
  if (semanticIssues.length) {
    record = {
      ...record,
      status: 'HOLD',
      holdReasons: uniqueReasons([
        ...(record.holdReasons || []),
        ...semanticIssues.map((issue) => issue.code),
      ]),
    };
    semanticIssues = validateEstimateMasterSemantics([record]);
  }

  // Remaining issues here indicate a programmer/schema error rather than a business HOLD.
  const recordedHoldReasons = new Set(record.holdReasons || []);
  const nonHoldRepresentationIssues = semanticIssues.filter(
    (issue) => issue.code !== 'HOLD_REASON_REQUIRED' && !recordedHoldReasons.has(issue.code)
  );
  if (nonHoldRepresentationIssues.length) {
    throw new Error(
      `ESTIMATE_MASTER_RECORD_INVALID:${nonHoldRepresentationIssues.map((issue) => issue.code).join(',')}`
    );
  }

  return Object.freeze({
    ...record,
    options: Object.freeze(record.options.map((option) => Object.freeze(option))) as unknown as EstimateMasterOption[],
    exteriorColors: Object.freeze(record.exteriorColors.map((color) => Object.freeze(color))) as unknown as EstimateMasterColor[],
    interiorColors: Object.freeze(record.interiorColors.map((color) => Object.freeze(color))) as unknown as EstimateMasterColor[],
    holdReasons: Object.freeze([...(record.holdReasons || [])]) as unknown as string[],
  });
}

export function buildEstimateNewcarMaster(
  candidates: readonly EstimateMasterCandidate[]
): EstimateNewcarMasterRecord[] {
  const records = candidates.map(buildEstimateNewcarMasterRecord);
  const issues = validateEstimateMasterSemantics(records);
  if (issues.length) {
    throw new Error(`ESTIMATE_MASTER_SET_INVALID:${issues.map((issue) => issue.code).join(',')}`);
  }
  return records;
}
