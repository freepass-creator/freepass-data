import { stableDigest } from '../shared/stable-digest.js';
import {
  VEHICLE_REFERENCE_SCHEMA,
  type NormalizedVehicleReferenceDataset,
  type NormalizedVehicleReferenceRecord,
} from '../domain/vehicle-reference.js';

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`VEHICLE_REFERENCE_INVALID:${field}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`VEHICLE_REFERENCE_INVALID:${field}`);
  }
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function nullableText(value: unknown, field: string): string | null {
  return value == null || value === '' ? null : text(value, field);
}

function year(value: unknown, field: string): number | null {
  if (value == null || value === '') return null;
  if (!Number.isInteger(value) || Number(value) < 1900 || Number(value) > 2200) {
    throw new Error(`VEHICLE_REFERENCE_INVALID:${field}`);
  }
  return Number(value);
}

function seats(value: unknown, field: string): number | null {
  if (value == null || value === '') return null;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 100) {
    throw new Error(`VEHICLE_REFERENCE_INVALID:${field}`);
  }
  return Number(value);
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  return value == null ? {} : object(value, field);
}

function normalizeAliases(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`VEHICLE_REFERENCE_INVALID:${field}`);
  return [...new Set(value.map((item, index) => text(item, `${field}[${index}]`)))].sort();
}

function normalizeSourceIds(value: unknown, field: string): Record<string, string> {
  if (value == null) return {};
  const raw = object(value, field);
  const entries = Object.entries(raw).map(([key, child]) => {
    if (typeof child !== 'string' && typeof child !== 'number') {
      throw new Error(`VEHICLE_REFERENCE_INVALID:${field}.${key}`);
    }
    return [text(key, `${field}.key`), String(child).trim()] as const;
  }).filter(([, child]) => child.length > 0);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeVariants(value: unknown, field: string): NormalizedVehicleReferenceRecord['variants'] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`VEHICLE_REFERENCE_INVALID:${field}`);
  return value.map((item, index) => {
    const row = object(item, `${field}[${index}]`);
    return {
      modelYear: year(row.modelYear, `${field}[${index}].modelYear`),
      powertrain: nullableText(row.powertrain, `${field}[${index}].powertrain`),
      fuelType: nullableText(row.fuelType, `${field}[${index}].fuelType`),
      drivetrain: nullableText(row.drivetrain, `${field}[${index}].drivetrain`),
      seats: seats(row.seats, `${field}[${index}].seats`),
      trim: nullableText(row.trim, `${field}[${index}].trim`),
      attributes: plainObject(row.attributes, `${field}[${index}].attributes`),
    };
  }).sort((a, b) => stableDigest(a).localeCompare(stableDigest(b)));
}

export function normalizeVehicleReferenceDataset(input: unknown): NormalizedVehicleReferenceDataset {
  const root = object(input, 'root');
  if (root.schema !== VEHICLE_REFERENCE_SCHEMA) throw new Error('VEHICLE_REFERENCE_INVALID:schema');
  const observedAt = text(root.observedAt, 'observedAt');
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('VEHICLE_REFERENCE_INVALID:observedAt');
  const provenanceRef = text(root.provenanceRef, 'provenanceRef');
  if (!Array.isArray(root.records) || root.records.length === 0) {
    throw new Error('VEHICLE_REFERENCE_INVALID:records');
  }

  const byIdentity = new Map<string, NormalizedVehicleReferenceRecord>();
  root.records.forEach((item, index) => {
    const row = object(item, `records[${index}]`);
    const maker = text(row.maker, `records[${index}].maker`);
    const series = text(row.series, `records[${index}].series`);
    const model = text(row.model, `records[${index}].model`);
    const generation = nullableText(row.generation, `records[${index}].generation`);
    const phase = nullableText(row.phase, `records[${index}].phase`);
    const fromYear = year(row.fromYear, `records[${index}].fromYear`);
    const toYear = year(row.toYear, `records[${index}].toYear`);
    if (fromYear !== null && toYear !== null && fromYear > toYear) {
      throw new Error(`VEHICLE_REFERENCE_INVALID:records[${index}].yearRange`);
    }

    const identityKey = stableDigest({ maker, series, model, generation, phase });
    const normalized: NormalizedVehicleReferenceRecord = {
      identityKey,
      maker,
      series,
      model,
      generation,
      phase,
      fromYear,
      toYear,
      aliases: normalizeAliases(row.aliases, `records[${index}].aliases`),
      sourceIds: normalizeSourceIds(row.sourceIds, `records[${index}].sourceIds`),
      attributes: plainObject(row.attributes, `records[${index}].attributes`),
      variants: normalizeVariants(row.variants, `records[${index}].variants`),
    };
    const current = byIdentity.get(identityKey);
    if (current && stableDigest(current) !== stableDigest(normalized)) {
      throw new Error(`VEHICLE_REFERENCE_CONFLICT:${identityKey}`);
    }
    byIdentity.set(identityKey, normalized);
  });

  return {
    schema: VEHICLE_REFERENCE_SCHEMA,
    observedAt,
    revision: root.revision == null ? null : text(root.revision, 'revision'),
    provenanceRefHash: stableDigest(provenanceRef),
    records: [...byIdentity.values()].sort((a, b) =>
      a.maker.localeCompare(b.maker) ||
      a.series.localeCompare(b.series) ||
      a.model.localeCompare(b.model)
    ),
  };
}
