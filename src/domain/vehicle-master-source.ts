export type VehicleMasterParsedCondition = {
  relation: 'REQUIRES' | 'EXCLUDES';
  targetLabel: string;
  raw: string;
};

export type VehicleMasterParsedOption = {
  name: string;
  price: number | null;
  note?: string | null;
  conditions?: VehicleMasterParsedCondition[];
  sourceText: string;
};

export type VehicleMasterParsedTrim = {
  maker: string;
  model: string;
  modelYear: number;
  powertrainName: string;
  seats: number | null;
  drivetrain: string | null;
  trimName: string;
  fuelType: string | null;
  basePrice: number;
  currency: 'KRW';
  effectiveFrom?: string | null;
  baseItems: string[];
  options: VehicleMasterParsedOption[];
  sourceText: string;
};

export type VehicleMasterParseResult = {
  parserId: string;
  parserVersion: string;
  sourceDocumentId: string;
  records: VehicleMasterParsedTrim[];
  warnings: string[];
};
