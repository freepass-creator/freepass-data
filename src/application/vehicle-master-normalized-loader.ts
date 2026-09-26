import type {
  VehicleMasterParsedBaseItem,
  VehicleMasterParsedCondition,
  VehicleMasterParsedOption,
  VehicleMasterParsedOptionKind,
  VehicleMasterParsedTrim,
} from '../domain/vehicle-master-source.js';
import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';
import type {
  VehicleMasterParsedSourceRecord,
} from './vehicle-master-reconcile.js';

const OPTION_KINDS = new Set<VehicleMasterParsedOptionKind>([
  'OPTION',
  'COLOR',
  'SEATS',
  'DRIVETRAIN',
  'ACCESSORY',
]);

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
  }
  return value.trim();
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, field);
}

function integer(value: unknown, field: string, min = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < min) {
    throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
  }
  return Number(value);
}

function nullableInteger(value: unknown, field: string, min = 0): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, field, min);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
  }
  return value.map((item, index) => text(item, `${field}[${index}]`));
}

function parseConditions(value: unknown, field: string): VehicleMasterParsedCondition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
  }
  return value.map((item, index) => {
    const row = object(item, `${field}[${index}]`);
    const relation = text(row.relation, `${field}[${index}].relation`);
    if (relation !== 'REQUIRES' && relation !== 'EXCLUDES') {
      throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}[${index}].relation`);
    }
    return {
      relation,
      targetLabel: text(row.targetLabel, `${field}[${index}].targetLabel`),
      raw: text(row.raw, `${field}[${index}].raw`),
    };
  });
}

function parseOption(value: unknown, field: string): VehicleMasterParsedOption {
  const row = object(value, field);
  const kindValue = row.kind === undefined ? 'OPTION' : text(row.kind, `${field}.kind`);
  if (!OPTION_KINDS.has(kindValue as VehicleMasterParsedOptionKind)) {
    throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}.kind`);
  }
  const price = row.price === null || row.price === undefined
    ? null
    : integer(row.price, `${field}.price`);

  const option: VehicleMasterParsedOption = {
    name: text(row.name, `${field}.name`),
    kind: kindValue as VehicleMasterParsedOptionKind,
    price,
    sourceText: typeof row.sourceText === 'string' ? row.sourceText : '',
  };
  if (row.note !== undefined && row.note !== null) {
    option.note = text(row.note, `${field}.note`);
  }
  const conditions = parseConditions(row.conditions, `${field}.conditions`);
  if (conditions.length) option.conditions = conditions;
  if (row.packageItems !== undefined) {
    option.packageItems = stringArray(row.packageItems, `${field}.packageItems`);
  }
  return option;
}

function parseBaseItemDetails(value: unknown, field: string): VehicleMasterParsedBaseItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
  }
  return value.map((item, index) => {
    const row = object(item, `${field}[${index}]`);
    return {
      category: nullableText(row.category, `${field}[${index}].category`),
      name: text(row.name, `${field}[${index}].name`),
      sourceText: typeof row.sourceText === 'string' ? row.sourceText : '',
    };
  });
}

function parseTrimPayload(value: unknown, field: string): VehicleMasterParsedTrim {
  const row = object(value, field);
  if (row.currency !== 'KRW') {
    throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}.currency`);
  }
  const optionsRaw = row.options;
  if (!Array.isArray(optionsRaw)) {
    throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}.options`);
  }

  const parsed: VehicleMasterParsedTrim = {
    maker: text(row.maker, `${field}.maker`),
    model: text(row.model, `${field}.model`),
    modelYear: integer(row.modelYear, `${field}.modelYear`, 1900),
    powertrainName: text(row.powertrainName, `${field}.powertrainName`),
    seats: nullableInteger(row.seats, `${field}.seats`, 1),
    drivetrain: nullableText(row.drivetrain, `${field}.drivetrain`),
    trimName: text(row.trimName, `${field}.trimName`),
    fuelType: nullableText(row.fuelType, `${field}.fuelType`),
    basePrice: integer(row.basePrice, `${field}.basePrice`),
    currency: 'KRW',
    effectiveFrom: nullableText(row.effectiveFrom, `${field}.effectiveFrom`),
    baseItems: stringArray(row.baseItems, `${field}.baseItems`),
    baseItemDetails: parseBaseItemDetails(row.baseItemDetails, `${field}.baseItemDetails`),
    options: optionsRaw.map((item, index) => parseOption(item, `${field}.options[${index}]`)),
    sourceText:
      typeof row.sourceTextExcerpt === 'string' ? row.sourceTextExcerpt : '',
  };

  if (parsed.effectiveFrom && !Number.isFinite(Date.parse(parsed.effectiveFrom))) {
    throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}.effectiveFrom`);
  }
  return parsed;
}

export async function loadNormalizedVehicleMasterTrimRecords(
  store: VehicleMasterStore,
  sourceDocumentIds: readonly string[]
): Promise<VehicleMasterParsedSourceRecord[]> {
  const rows: VehicleMasterParsedSourceRecord[] = [];
  for (const sourceDocumentId of [...new Set(sourceDocumentIds)].sort()) {
    const source = await store.getSourceDocument(sourceDocumentId);
    if (!source) {
      throw new Error(`VEHICLE_MASTER_SOURCE_DOCUMENT_NOT_FOUND:${sourceDocumentId}`);
    }

    const records = await store.listPipelineRecords('NORMALIZED_RECORD', sourceDocumentId);
    for (const record of records) {
      if (record.payload.recordKind !== 'TRIM') continue;
      rows.push({
        sourceDocumentId,
        record: parseTrimPayload(record.payload.record, `${record.recordId}.record`),
      });
    }
  }

  if (!rows.length) throw new Error('VEHICLE_MASTER_NORMALIZED_TRIMS_NOT_FOUND');
  return rows;
}
