import type { VehicleAsset, VehicleExternalId } from '../domain/catalog.js';
import { stableDigest } from './stable-digest.js';

export type VehicleUidMigrationProduct = Record<string, unknown>;
export type VehicleUidMigrationIdentifierSummary = {
  plateHashes: string[];
  vinHashes: string[];
  supplierVehicleIdHashes: string[];
};

const active = (id: VehicleExternalId, at: string) => id.validFrom <= at && (id.validTo === undefined || id.validTo === null || id.validTo > at);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const hash = (value: unknown) => stableDigest(value).slice(0, 12);

function fields(product: VehicleUidMigrationProduct, names: string[]) {
  return names.map(name => text(product[name])).filter(Boolean);
}

function field(product: VehicleUidMigrationProduct, names: string[]) {
  for (const name of names) {
    const value = text(product[name]);
    if (value) return value;
  }
  return undefined;
}

function uniqueValues(values: string[], normalize: (value: string) => string = value => value) {
  return [...new Set(values.map(normalize))];
}

export function vehicleUidMigrationProductIds(product: VehicleUidMigrationProduct) {
  const plateFields = ['plateNumber', 'plate_number', 'car_number', 'vehicle_number', '차량번호'];
  const vinFields = ['vin', 'VIN', 'vehicle_vin', 'vehicle_id_number', '차대번호'];
  const supplierVehicleFields = [
    'iancar_one_vehicle_id',
    'sourceVehicleId',
    'supplier_vehicle_id',
    'supplierVehicleId',
    'vehicleId',
    'vehicle_id',
    'source_vehicle_id',
    'sourceRecordId',
    'source_record_id',
    'raw_id',
    'rawId',
    'id',
  ];
  const plateValues = fields(product, plateFields);
  const vinValues = fields(product, vinFields);
  const supplierVehicleValues = fields(product, supplierVehicleFields);
  const plates = uniqueValues(plateValues);
  const vins = uniqueValues(vinValues, value => value.toUpperCase());
  const supplierVehicleIds = uniqueValues(supplierVehicleValues);
  const plate = field(product, plateFields);
  const vin = field(product, vinFields);
  const supplierCode = field(product, ['provider_company_code', 'supplierCode', 'supplier_code', 'supplierId', 'supplier_id', 'sourceSupplierId']);
  const supplierVehicleId = supplierVehicleIds[0];
  const sameKindFieldDisagreements = [
    ...(plates.length > 1 ? ['PLATE:SAME_KIND_FIELDS_DISAGREE'] : []),
    ...(vins.length > 1 ? ['VIN:SAME_KIND_FIELDS_DISAGREE'] : []),
    ...(supplierVehicleIds.length > 1 ? ['SUPPLIER_VEHICLE:SAME_KIND_FIELDS_DISAGREE'] : []),
  ];
  return { plate, plates, vin, vins, supplierCode, supplierVehicleId, supplierVehicleIds, sameKindFieldDisagreements };
}

export function summarizeVehicleUidMigrationIdentifiers(product: VehicleUidMigrationProduct): VehicleUidMigrationIdentifierSummary {
  const ids = vehicleUidMigrationProductIds(product);
  return {
    plateHashes: ids.plates.map(value => hash({ kind: 'PLATE', value })).sort(),
    vinHashes: ids.vins.map(value => hash({ kind: 'VIN', value })).sort(),
    supplierVehicleIdHashes: ids.supplierVehicleIds
      .map(value => hash({ kind: 'SUPPLIER_VEHICLE', supplierCode: ids.supplierCode?.toUpperCase() ?? '', value }))
      .sort(),
  };
}

function externalIdsForAsset(asset: VehicleAsset): VehicleExternalId[] {
  const out: VehicleExternalId[] = [];
  if (asset.plateNumber) {
    out.push({ kind: 'PLATE', value: asset.plateNumber, validFrom: asset.createdAt, source: 'vehicle-uid-migration-plan' });
  }
  if (asset.vin) {
    out.push({ kind: 'VIN', value: asset.vin.toUpperCase(), validFrom: asset.createdAt, source: 'vehicle-uid-migration-plan' });
  }
  return out;
}

export function normalizedVehicleUidMigrationAssetIdentifiers(asset: VehicleAsset, observedAt: string): VehicleExternalId[] {
  return [...(asset.externalIds ?? []), ...externalIdsForAsset(asset)]
    .map(id => ({
      ...id,
      value: id.kind === 'VIN' ? id.value.trim().toUpperCase() : id.value.trim(),
      ...(id.supplierCode ? { supplierCode: id.supplierCode.trim().toUpperCase() } : {}),
    }))
    .filter(id => id.value && active(id, observedAt));
}

export function summarizeVehicleUidMigrationAssetIdentifiers(asset: VehicleAsset, observedAt: string) {
  return stableDigest(normalizedVehicleUidMigrationAssetIdentifiers(asset, observedAt));
}
