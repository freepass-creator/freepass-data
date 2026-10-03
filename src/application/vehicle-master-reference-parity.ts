import { stableDigest } from '../shared/stable-digest.js';
import { canonicalVehicleMakerName } from '../domain/vehicle-maker-name.js';

export type VehicleNameReferenceRow = {
  maker: string;
  model: string;
  subModel: string;
  yearStart?: string | null;
  yearEnd?: string | null;
};

export type LegacyVehicleMasterNameRow = VehicleNameReferenceRow & {
  id: string;
  generationCode?: string | null;
};

export type LegacyVehicleProductNameRow = {
  id: string;
  plateNumber: string;
  maker: string;
  model: string;
  subModel: string;
};

export type VehicleNameParityIssueCode =
  | 'REFERENCE_NAME_MISMATCH'
  | 'GENERATION_CODE_SUFFIX_DRIFT'
  | 'GENERATION_CODE_SUFFIX_TIME_MISMATCH'
  | 'PRODUCT_USES_DRIFTED_MASTER_NAME'
  | 'PRODUCT_REFERENCE_NAME_MISMATCH';

export type VehicleNameParityIssue = {
  code: VehicleNameParityIssueCode;
  severity: 'ERROR' | 'HOLD';
  entityKind: 'MASTER' | 'PRODUCT';
  entityId: string;
  maker: string;
  model: string;
  actualSubModel: string;
  expectedSubModels: string[];
  suggestedSubModel: string | null;
  relatedMasterId?: string;
};

export type VehicleNameParityReport = {
  status: 'PASS' | 'FAIL';
  digest: string;
  counts: {
    referenceRows: number;
    masterRows: number;
    productRows: number;
    exactMasters: number;
    outOfReferenceScopeMasters: number;
    errors: number;
    holds: number;
    affectedProducts: number;
  };
  issues: VehicleNameParityIssue[];
};

const text = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const key = (maker: string, model: string, subModel = '') =>
  [canonicalVehicleMakerName(maker), model, subModel].map(text).join('\u001f');

const year = (value?: string | null) => {
  const match = text(value ?? '').match(/^(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
};

const overlaps = (left: VehicleNameReferenceRow, right: VehicleNameReferenceRow) => {
  const leftStart = year(left.yearStart) ?? Number.NEGATIVE_INFINITY;
  const leftEnd = year(left.yearEnd) ?? Number.POSITIVE_INFINITY;
  const rightStart = year(right.yearStart) ?? Number.NEGATIVE_INFINITY;
  const rightEnd = year(right.yearEnd) ?? Number.POSITIVE_INFINITY;
  return leftStart <= rightEnd && rightStart <= leftEnd;
};

const stripGenerationSuffix = (subModel: string, generationCode?: string | null) => {
  const name = text(subModel);
  const code = text(generationCode ?? '');
  if (!code || name.length <= code.length) return null;
  const suffix = ` ${code}`;
  return name.toLocaleUpperCase('en-US').endsWith(suffix.toLocaleUpperCase('en-US'))
    ? name.slice(0, -suffix.length).trim()
    : null;
};

const issueSort = (a: VehicleNameParityIssue, b: VehicleNameParityIssue) =>
  a.entityKind.localeCompare(b.entityKind) ||
  a.entityId.localeCompare(b.entityId) ||
  a.code.localeCompare(b.code);

export function auditVehicleNameReferenceParity(input: {
  referenceRows: readonly VehicleNameReferenceRow[];
  masterRows: readonly LegacyVehicleMasterNameRow[];
  productRows?: readonly LegacyVehicleProductNameRow[];
}): VehicleNameParityReport {
  const referenceRows = input.referenceRows.map((row) => ({
    ...row,
    maker: text(row.maker),
    model: text(row.model),
    subModel: text(row.subModel),
  }));
  const exactReference = new Set(referenceRows.map((row) => key(row.maker, row.model, row.subModel)));
  const referenceByModel = new Map<string, VehicleNameReferenceRow[]>();
  for (const row of referenceRows) {
    const modelKey = key(row.maker, row.model);
    const rows = referenceByModel.get(modelKey) ?? [];
    rows.push(row);
    referenceByModel.set(modelKey, rows);
  }

  const issues: VehicleNameParityIssue[] = [];
  const masterIssueByName = new Map<string, VehicleNameParityIssue>();
  const masterIdByName = new Map<string, string>();
  let exactMasters = 0;
  let outOfReferenceScopeMasters = 0;

  for (const master of input.masterRows) {
    const maker = text(master.maker);
    const model = text(master.model);
    const actualSubModel = text(master.subModel);
    masterIdByName.set(key(maker, model, actualSubModel), master.id);
    if (exactReference.has(key(maker, model, actualSubModel))) {
      exactMasters += 1;
      continue;
    }

    const candidates = referenceByModel.get(key(maker, model));
    if (!candidates?.length) {
      outOfReferenceScopeMasters += 1;
      continue;
    }

    const stripped = stripGenerationSuffix(actualSubModel, master.generationCode);
    const strippedCandidates = stripped
      ? candidates.filter((row) => key(row.maker, row.model, row.subModel) === key(maker, model, stripped))
      : [];
    const timeCompatible = strippedCandidates.some((row) => overlaps(master, row));
    const code: VehicleNameParityIssueCode = strippedCandidates.length
      ? timeCompatible
        ? 'GENERATION_CODE_SUFFIX_DRIFT'
        : 'GENERATION_CODE_SUFFIX_TIME_MISMATCH'
      : 'REFERENCE_NAME_MISMATCH';
    const issue: VehicleNameParityIssue = {
      code,
      severity: code === 'GENERATION_CODE_SUFFIX_DRIFT' ? 'ERROR' : 'HOLD',
      entityKind: 'MASTER',
      entityId: master.id,
      maker,
      model,
      actualSubModel,
      expectedSubModels: [...new Set(candidates.map((row) => row.subModel))].sort(),
      suggestedSubModel: code === 'GENERATION_CODE_SUFFIX_DRIFT' ? stripped : null,
    };
    issues.push(issue);
    masterIssueByName.set(key(maker, model, actualSubModel), issue);
  }

  let affectedProducts = 0;
  for (const product of input.productRows ?? []) {
    const productKey = key(product.maker, product.model, product.subModel);
    if (exactReference.has(productKey)) continue;
    const candidates = referenceByModel.get(key(product.maker, product.model));
    if (!candidates?.length) continue;
    const masterIssue = masterIssueByName.get(productKey);
    affectedProducts += 1;
    const relatedMasterId = masterIssue?.entityId ?? masterIdByName.get(productKey);
    issues.push({
      code: masterIssue ? 'PRODUCT_USES_DRIFTED_MASTER_NAME' : 'PRODUCT_REFERENCE_NAME_MISMATCH',
      severity: masterIssue?.severity ?? 'HOLD',
      entityKind: 'PRODUCT',
      entityId: product.plateNumber || product.id,
      maker: text(product.maker),
      model: text(product.model),
      actualSubModel: text(product.subModel),
      expectedSubModels: masterIssue?.expectedSubModels ?? [...new Set(candidates.map((row) => row.subModel))].sort(),
      suggestedSubModel: masterIssue?.suggestedSubModel ?? null,
      ...(relatedMasterId ? { relatedMasterId } : {}),
    });
  }

  issues.sort(issueSort);
  const errors = issues.filter((issue) => issue.severity === 'ERROR').length;
  const holds = issues.length - errors;
  const counts = {
    referenceRows: referenceRows.length,
    masterRows: input.masterRows.length,
    productRows: input.productRows?.length ?? 0,
    exactMasters,
    outOfReferenceScopeMasters,
    errors,
    holds,
    affectedProducts,
  };
  return {
    status: issues.length ? 'FAIL' : 'PASS',
    digest: stableDigest({ counts, issues }),
    counts,
    issues,
  };
}
