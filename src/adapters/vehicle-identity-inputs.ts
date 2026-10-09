import { decodeErp5Value, inspectErp5Capture, type Erp5SourceCapture } from './erp5-source-capture.js';
import { plateIdentityKey, isAssignedPlate } from '../domain/vehicle-plate.js';
import type { VehicleIdentity, VehicleMasterRecord, VehicleMasterReference } from '../domain/vehicle-identity-resolution.js';
import { stableDigest } from '../shared/stable-digest.js';
// @ts-expect-error Existing pure planner has no TypeScript declaration.
import { vehicleMasterSnapshotRows } from '../../scripts/supplier-input-sheet.mjs';
export type VehicleMasterSnapshot = {
  source: 'freepasserp5/vehicle_master+vehicle_trim_master'; complete: true; readAt: string; digest: string;
  masters: Array<{ id: string; data: Record<string, unknown> }>;
  trims: Array<{ id: string; data: Record<string, unknown> }>;
};
export type VehicleIdentityInputs = {
  schema: 'vehicle-identity-inputs/v2'; master: VehicleMasterSnapshot;
  data: Array<{ plate: string; identity: VehicleIdentity }>; dataReadTime: string; dataDigest: string;
};
export function verifiedMasterRecords(master: VehicleMasterSnapshot, now = Date.now()): VehicleMasterRecord[] {
  return vehicleMasterSnapshotRows(master, now).records;
}
/** Check the immutable pair itself; matching display names or a reference_vm_ hash is not proof. */
export function verifiedVehicleMasterReference(master: VehicleMasterSnapshot,
  ids: Pick<VehicleMasterRecord, 'masterId' | 'trimId'>, now = Date.now()): VehicleMasterReference |
  { state: 'HOLD'; reason: 'MASTER_TRIM_PAIR_NOT_VERIFIED' } {
  const records = verifiedMasterRecords(master, now);
  if (records.filter(record => record.masterId === ids.masterId && record.trimId === ids.trimId).length !== 1) {
    return { state: 'HOLD', reason: 'MASTER_TRIM_PAIR_NOT_VERIFIED' };
  }
  return { state: 'KNOWN', authority: 'FREEPASS_DATA_VEHICLE_MASTER', identityKind: 'FIRESTORE_DOCUMENT_ID',
    masterId: ids.masterId, trimId: ids.trimId, snapshotDigest: master.digest, readAt: master.readAt };
}
/** Existing plate values are evidence; contradictory rows are excluded, never silently deduplicated. */
export function dataIdentitiesFromErp5(capture: Erp5SourceCapture): VehicleIdentityInputs['data'] {
  const byPlate = new Map<string, VehicleIdentity | null>();
  const field = (doc: { fields?: Record<string, unknown> }, key: string) => {
    try { const value = decodeErp5Value(doc.fields?.[key] ?? { nullValue: null }); return typeof value === 'string' ? value.trim() : ''; }
    catch { return ''; }
  };
  for (const doc of capture.collections.products.documents as Array<{ fields?: Record<string, unknown> }>) {
    const plateRaw = field(doc, 'car_number');
    if (!isAssignedPlate(plateRaw)) continue;
    const plate = plateIdentityKey(plateRaw);
    const identity: VehicleIdentity = [field(doc, 'maker'), field(doc, 'model'), field(doc, 'sub_model'), field(doc, 'trim_name')];
    if (!identity[0] || !identity[1]) continue;
    const seen = byPlate.get(plate);
    byPlate.set(plate, seen === undefined ? identity : seen && seen.join('|') === identity.join('|') ? seen : null);
  }
  return [...byPlate].filter((entry): entry is [string, VehicleIdentity] => entry[1] !== null)
    .map(([plate, identity]) => ({ plate, identity })).sort((a, b) => a.plate.localeCompare(b.plate));
}
export function verifiedErp5CaptureFromJson(json: unknown): Erp5SourceCapture {
  inspectErp5Capture(json as Erp5SourceCapture);
  return json as Erp5SourceCapture;
}
export function buildVehicleIdentityInputs(master: VehicleMasterSnapshot, capture: Erp5SourceCapture): VehicleIdentityInputs {
  verifiedMasterRecords(master);
  const data = dataIdentitiesFromErp5(capture);
  const result: VehicleIdentityInputs = { schema: 'vehicle-identity-inputs/v2', master,
    data, dataReadTime: capture.readTime, dataDigest: stableDigest(data) };
  assertVehicleIdentityInputs(result);
  return result;
}
export function assertVehicleIdentityInputs(value: unknown, now = Date.now()): asserts value is VehicleIdentityInputs {
  const v = value as VehicleIdentityInputs;
  if (!v || v.schema !== 'vehicle-identity-inputs/v2' || !Array.isArray(v.data) ||
      stableDigest(v.data) !== v.dataDigest) throw new Error('VEHICLE_IDENTITY_INPUTS_INVALID');
  verifiedMasterRecords(v.master, now);
  const age = now - Date.parse(v.dataReadTime), plates = new Set<string>();
  if (!Number.isFinite(age) || age < -1000 || age > 300000) throw new Error('VEHICLE_IDENTITY_DATA_STALE');
  for (const row of v.data) {
    if (!row || typeof row.plate !== 'string' || !isAssignedPlate(row.plate) ||
        row.plate !== plateIdentityKey(row.plate) || plates.has(row.plate) ||
        !Array.isArray(row.identity) || row.identity.length !== 4 || row.identity.some(x => typeof x !== 'string')) {
      throw new Error('VEHICLE_IDENTITY_INPUTS_INVALID');
    }
    plates.add(row.plate);
  }
}
