import { KiaOfficialPriceParser } from './kia-official-price-parser.js';
import { CarnoonVehicleParser } from './carnoon-vehicle-parser.js';
import { CarisyouHistoricalParser } from './carisyou-historical-parser.js';
import { DanawaVehicleParser } from './danawa-vehicle-parser.js';
import type { VehicleMasterSourceParser } from '../ports/vehicle-master-source-parser.js';

export function createVehicleMasterSourceParsers(): VehicleMasterSourceParser[] {
  return [
    new KiaOfficialPriceParser(),
    new CarnoonVehicleParser(),
    new CarisyouHistoricalParser(),
    new DanawaVehicleParser(),
  ];
}
