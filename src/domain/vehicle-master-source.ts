export type VehicleMasterParsedCondition = {
  relation: 'REQUIRES' | 'EXCLUDES';
  targetLabel: string;
  raw: string;
};

export type VehicleMasterParsedOptionKind =
  | 'OPTION'
  | 'COLOR'
  | 'SEATS'
  | 'DRIVETRAIN'
  | 'ACCESSORY';

export type VehicleMasterParsedOption = {
  name: string;
  kind?: VehicleMasterParsedOptionKind;
  price: number | null;
  note?: string | null;
  conditions?: VehicleMasterParsedCondition[];
  packageItems?: string[];
  sourceText: string;
};

export type VehicleMasterParsedBaseItem = {
  category: string | null;
  name: string;
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
  baseItemDetails?: VehicleMasterParsedBaseItem[];
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
