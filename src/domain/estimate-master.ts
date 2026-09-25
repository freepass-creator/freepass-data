export const ESTIMATE_NEWCAR_MASTER_CONTRACT = 'estimate-newcar-master/v1';
export const ESTIMATE_NEWCAR_MASTER_PROJECTION_ID = 'estimate-newcar-master';

export type EstimateMasterMoney = { amount: number; currency: 'KRW' };
export type EstimateMasterOption = {
  optionId: string | null;
  name: string;
  price: EstimateMasterMoney;
  requires: string[];
  excludes: string[];
  exclusiveGroupId?: string | null;
};
export type EstimateMasterColor = {
  colorId: string | null;
  name: string;
  code?: string | null;
  price: EstimateMasterMoney;
};
export type EstimateNewcarMasterRecord = {
  productId: string;
  vehicleModelId: string | null;
  modelYearId: string | null;
  trimId: string | null;
  powertrainId: string | null;
  maker: string;
  model: string;
  modelYear: number | null;
  trimName: string;
  powertrainName: string;
  basePrice: EstimateMasterMoney;
  options: EstimateMasterOption[];
  exteriorColors: EstimateMasterColor[];
  interiorColors: EstimateMasterColor[];
  configuration: {
    drivetrain: string | null;
    seats: number | null;
    bodyConfiguration: string | null;
  };
  status: 'ACTIVE' | 'HOLD';
  holdReasons?: string[];
};

export type EstimateMasterSemanticIssue = {
  code: string;
  productId?: string;
  field?: string;
  detail?: string;
};

const duplicateValues = (values: string[]) => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dup.add(value);
    seen.add(value);
  }
  return [...dup].sort();
};

export function validateEstimateMasterSemantics(
  records: readonly EstimateNewcarMasterRecord[]
): EstimateMasterSemanticIssue[] {
  const issues: EstimateMasterSemanticIssue[] = [];

  for (const id of duplicateValues(records.map((record) => record.productId))) {
    issues.push({ code: 'DUPLICATE_PRODUCT_ID', detail: id });
  }
  for (const id of duplicateValues(records.map((record) => record.trimId).filter((id): id is string => Boolean(id)))) {
    issues.push({ code: 'DUPLICATE_TRIM_ID', detail: id });
  }

  for (const record of records) {
    const optionIds = record.options.map((option) => option.optionId).filter((id): id is string => Boolean(id));
    const optionSet = new Set(optionIds);
    for (const id of duplicateValues(optionIds)) {
      issues.push({ code: 'DUPLICATE_OPTION_ID', productId: record.productId, field: 'options', detail: id });
    }

    for (const option of record.options) {
      if (!option.optionId) {
        if (record.status === 'ACTIVE') {
          issues.push({ code: 'ACTIVE_OPTION_ID_REQUIRED', productId: record.productId, field: 'options' });
        }
        continue;
      }
      for (const requiredId of option.requires) {
        if (!optionSet.has(requiredId)) {
          issues.push({
            code: 'OPTION_REQUIRES_UNKNOWN',
            productId: record.productId,
            field: option.optionId,
            detail: requiredId
          });
        }
        if (requiredId === option.optionId) {
          issues.push({
            code: 'OPTION_REQUIRES_SELF',
            productId: record.productId,
            field: option.optionId
          });
        }
      }
      for (const excludedId of option.excludes) {
        if (!optionSet.has(excludedId)) {
          issues.push({
            code: 'OPTION_EXCLUDES_UNKNOWN',
            productId: record.productId,
            field: option.optionId,
            detail: excludedId
          });
        }
        if (excludedId === option.optionId) {
          issues.push({
            code: 'OPTION_EXCLUDES_SELF',
            productId: record.productId,
            field: option.optionId
          });
        }
        if (option.requires.includes(excludedId)) {
          issues.push({
            code: 'OPTION_REQUIRES_EXCLUDES_CONFLICT',
            productId: record.productId,
            field: option.optionId,
            detail: excludedId
          });
        }
      }
    }

    for (const [field, colors] of [
      ['exteriorColors', record.exteriorColors],
      ['interiorColors', record.interiorColors]
    ] as const) {
      for (const id of duplicateValues(colors.map((color) => color.colorId).filter((id): id is string => Boolean(id)))) {
        issues.push({ code: 'DUPLICATE_COLOR_ID', productId: record.productId, field, detail: id });
      }
    }

    if (record.status === 'ACTIVE') {
      for (const [field, value] of [
        ['vehicleModelId', record.vehicleModelId],
        ['modelYearId', record.modelYearId],
        ['trimId', record.trimId],
        ['powertrainId', record.powertrainId],
      ] as const) {
        if (!value) issues.push({ code: 'ACTIVE_STABLE_ID_REQUIRED', productId: record.productId, field });
      }
      if (typeof record.modelYear !== 'number' || !Number.isInteger(record.modelYear)) {
        issues.push({ code: 'ACTIVE_MODEL_YEAR_REQUIRED', productId: record.productId, field: 'modelYear' });
      }
      if (record.exteriorColors.some((color) => !color.colorId)) {
        issues.push({ code: 'ACTIVE_COLOR_ID_REQUIRED', productId: record.productId, field: 'exteriorColors' });
      }
      if (record.interiorColors.some((color) => !color.colorId)) {
        issues.push({ code: 'ACTIVE_COLOR_ID_REQUIRED', productId: record.productId, field: 'interiorColors' });
      }
      if (!record.exteriorColors.length) {
        issues.push({ code: 'ACTIVE_EXTERIOR_COLOR_REQUIRED', productId: record.productId, field: 'exteriorColors' });
      }
      if (!record.interiorColors.length) {
        issues.push({ code: 'ACTIVE_INTERIOR_COLOR_REQUIRED', productId: record.productId, field: 'interiorColors' });
      }
      if (record.holdReasons?.length) {
        issues.push({ code: 'ACTIVE_RECORD_HAS_HOLD_REASON', productId: record.productId, field: 'holdReasons' });
      }
    }

    if (record.status === 'HOLD' && !record.holdReasons?.length) {
      issues.push({ code: 'HOLD_REASON_REQUIRED', productId: record.productId, field: 'holdReasons' });
    }
  }

  return issues;
}
