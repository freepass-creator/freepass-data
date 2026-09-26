import type { VehicleMasterParseResult } from '../domain/vehicle-master-source.js';

export type VehicleMasterParseInput = {
  sourceDocumentId: string;
  sourceUrl: string | null;
  contentType: string | null;
  bytes: Buffer;
};

export interface VehicleMasterSourceParser {
  readonly parserId: string;
  readonly parserVersion: string;
  canParse(input: VehicleMasterParseInput): boolean;
  parse(input: VehicleMasterParseInput): VehicleMasterParseResult;
}
