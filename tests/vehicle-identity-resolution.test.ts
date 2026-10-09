import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chooseVehicleIdentity, indexVehicleMaster, type VehicleIdentity } from '../src/domain/vehicle-identity-resolution.js';
import { assertVehicleIdentityInputs, buildVehicleIdentityInputs, verifiedMasterRecords, type VehicleMasterSnapshot } from '../src/adapters/vehicle-identity-inputs.js';
import type { Erp5SourceCapture } from '../src/adapters/erp5-source-capture.js';
const names = ['현대', '쏘나타', '쏘나타 DN8', '스마트'] as const;
function snapshot(extra: Record<string, unknown> = {}): VehicleMasterSnapshot {
  const body = { readAt: new Date().toISOString(),
    masters: [{ id: 'm1', data: { maker: names[0], model: names[1], sub_model: names[2], sub_model_aliases: ['소나타 DN8'] } }],
    trims: [{ id: 't1', data: { master_id: 'm1', maker: names[0], model: names[1], sub_model: names[2], trim: names[3], trim_aliases: ['스마트 초이스'], ...extra } }] };
  return { source: 'freepasserp5/vehicle_master+vehicle_trim_master', complete: true, ...body,
    digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
function capture(): Erp5SourceCapture {
  return { readTime: new Date().toISOString(), collections: { products: { documents: [
    { fields: { car_number: { stringValue: 'TEST-FAKE-001' }, maker: { stringValue: names[0] },
      model: { stringValue: names[1] }, sub_model: { stringValue: names[2] }, trim_name: { stringValue: names[3] } } }
  ] } } } as unknown as Erp5SourceCapture;
}
const input = (sheet: VehicleIdentity, data: VehicleIdentity | null = null) =>
  ({ sheet, data, raw: '쏘나타 DN8 스마트', firstRegistration: '', modelYear: '' });
describe('one active Data master authority', () => {
  it('uses aliases for search and returns current names plus immutable IDs', () => {
    const master = indexVehicleMaster(verifiedMasterRecords(snapshot()));
    expect(chooseVehicleIdentity(master, input(['현대', '쏘나타', '소나타 DN8', '스마트 초이스'])))
      .toMatchObject({ pick: 'SHEET', identity: names, masterId: 'm1', trimId: 't1' });
  });
  it('fills a missing sheet trim from a unique current Data record', () => {
    expect(chooseVehicleIdentity(indexVehicleMaster(verifiedMasterRecords(snapshot())), input(['현대', '쏘나타', names[2], ''], names)))
      .toMatchObject({ pick: 'DATA', identity: names });
  });
  it('holds another maker/model and preserves the original evidence', () => {
    expect(chooseVehicleIdentity(indexVehicleMaster(verifiedMasterRecords(snapshot())), input(['기아', 'K5', '', ''], names)))
      .toMatchObject({ pick: 'HOLD', identity: null, notes: ['DATA_SHEET_MASTER_CONFLICT'] });
  });
  it('does not choose between different immutable IDs with the same name', () => {
    const records = verifiedMasterRecords(snapshot());
    expect(chooseVehicleIdentity(indexVehicleMaster([...records, { ...records[0]!, trimId: 't2' }]), input(names)).pick).toBe('HOLD');
  });
  it('rejects the legacy F03 authority contract', () => {
    expect(() => assertVehicleIdentityInputs({ schema: 'vehicle-identity-inputs/v1', f03: { rows: [], aliases: [] }, data: [] }))
      .toThrow('VEHICLE_IDENTITY_INPUTS_INVALID');
  });
  it('rejects stale master and Data evidence and digest tampering', () => {
    const inputs = buildVehicleIdentityInputs(snapshot(), capture());
    expect(() => assertVehicleIdentityInputs(inputs, Date.now() + 300001)).toThrow();
    expect(() => assertVehicleIdentityInputs({ ...inputs, dataReadTime: '2020-01-01' })).toThrow('VEHICLE_IDENTITY_DATA_STALE');
    expect(() => assertVehicleIdentityInputs({ ...inputs, master: { ...inputs.master, digest: 'changed' } })).toThrow();
  });
  it('does not invent basic submodel values', () => {
    expect(chooseVehicleIdentity(indexVehicleMaster(verifiedMasterRecords(snapshot())), input(['현대', '쏘나타', '기본형', names[3]])).pick).toBe('HOLD');
  });
  it('a HOLD decision produces null REVIEW_REQUIRED facts, retaining supplier strings', async () => {
    const { sharedSheetNormalizer } = await import('../src/adapters/normalize-shared-sheet.js');
    const { sharedSheetHeaders } = await import('../src/adapters/shared-sheet-source.js');
    const values = sharedSheetHeaders.map(h => ({ 제조사: '기아', 모델: 'K5', 세부모델: '원문', 세부트림: '원문', 차량번호: 'TEST-FAKE-001' } as Record<string, string>)[h] ?? '');
    const raw = { sourceId: 'synthetic', sourceRunId: 'run', sourceRecordId: 'row',
      payload: { values, supplierCode: 'RP001' } } as unknown as import('../src/domain/source.js').RawRecord;
    const resolver = () => chooseVehicleIdentity(indexVehicleMaster(verifiedMasterRecords(snapshot())), input(['기아', 'K5', '', ''], names));
    const result = sharedSheetNormalizer(resolver)(raw);
    expect(result.record.candidate.vehicleFacts?.fields.maker).toMatchObject({ value: null, state: 'REVIEW_REQUIRED', evidence: '기아' });
    expect(raw.payload.values).toEqual(values);
  });
});
