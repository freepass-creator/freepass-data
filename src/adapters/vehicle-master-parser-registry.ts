import { KiaOfficialPriceParser } from './kia-official-price-parser.js';
import { CarnoonVehicleParser } from './carnoon-vehicle-parser.js';
import type { VehicleMasterSourceParser } from '../ports/vehicle-master-source-parser.js';

export function createVehicleMasterSourceParsers(): VehicleMasterSourceParser[] {
  return [
    new KiaOfficialPriceParser(),
    new CarnoonVehicleParser(),
  ];
}
