export const VEHICLE_REFERENCE_SCHEMA = 'freepass-vehicle-reference/v1' as const;

export type VehicleReferenceVariant = {
  modelYear?: number | null;
  powertrain?: string | null;
  fuelType?: string | null;
  drivetrain?: string | null;
  seats?: number | null;
  trim?: string | null;
  attributes?: Record<string, unknown>;
};

export type VehicleReferenceRecord = {
  maker: string;
  series: string;
  model: string;
  generation?: string | null;
  phase?: string | null;
  fromYear?: number | null;
  toYear?: number | null;
  aliases?: string[];
  sourceIds?: Record<string, string | number>;
  attributes?: Record<string, unknown>;
  variants?: VehicleReferenceVariant[];
};

export type VehicleReferenceDataset = {
  schema: typeof VEHICLE_REFERENCE_SCHEMA;
  observedAt: string;
  revision?: string | null;
  provenanceRef: string;
  records: VehicleReferenceRecord[];
};

export type NormalizedVehicleReferenceRecord = {
  identityKey: string;
  maker: string;
  series: string;
  model: string;
  generation: string | null;
  phase: string | null;
  fromYear: number | null;
  toYear: number | null;
  aliases: string[];
  sourceIds: Record<string, string>;
  attributes: Record<string, unknown>;
  variants: Array<{
    modelYear: number | null;
    powertrain: string | null;
    fuelType: string | null;
    drivetrain: string | null;
    seats: number | null;
    trim: string | null;
    attributes: Record<string, unknown>;
  }>;
};

export type NormalizedVehicleReferenceDataset = {
  schema: typeof VEHICLE_REFERENCE_SCHEMA;
  observedAt: string;
  revision: string | null;
  provenanceRefHash: string;
  records: NormalizedVehicleReferenceRecord[];
};
