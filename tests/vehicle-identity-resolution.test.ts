import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chooseVehicleIdentity, indexVehicleMaster, type VehicleIdentity } from '../src/domain/vehicle-identity-resolution.js';
import { assertVehicleIdentityInputs, buildVehicleIdentityInputs, verifiedMasterRecords, verifiedVehicleMasterReference, type VehicleMasterSnapshot } from '../src/adapters/vehicle-identity-inputs.js';
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
  it('publishes native ID provenance tied to the exact verified snapshot', () => {
    const master = snapshot();
    expect(verifiedVehicleMasterReference(master, { masterId: 'm1', trimId: 't1' })).toEqual({
      state: 'KNOWN', authority: 'FREEPASS_DATA_VEHICLE_MASTER', identityKind: 'FIRESTORE_DOCUMENT_ID',
      masterId: 'm1', trimId: 't1', snapshotDigest: master.digest, readAt: master.readAt,
    });
    expect(verifiedVehicleMasterReference(master, { masterId: 'reference_vm_name_hash', trimId: 't1' }))
      .toEqual({ state: 'HOLD', reason: 'MASTER_TRIM_PAIR_NOT_VERIFIED' });
    expect(verifiedVehicleMasterReference(master, { masterId: 'm1', trimId: 'other-trim' }).state).toBe('HOLD');
  });
  it('resolves an alias then attaches provenance from that same snapshot without changing source keys', () => {
    const master = snapshot();
    const source = { sourceProductId: 'synthetic-product', supplierId: 'RP001', termKey: 'source:24_2만' };
    const choice = chooseVehicleIdentity(indexVehicleMaster(verifiedMasterRecords(master)),
      input(['현대', '쏘나타', '소나타 DN8', '스마트 초이스']));
    if (choice.pick === 'HOLD') throw new Error('fixture must resolve uniquely');
    const reference = verifiedVehicleMasterReference(master, choice);
    expect({ ...source, vehicleMasterReference: reference }).toEqual({ ...source, vehicleMasterReference: {
      state: 'KNOWN', authority: 'FREEPASS_DATA_VEHICLE_MASTER', identityKind: 'FIRESTORE_DOCUMENT_ID',
      masterId: 'm1', trimId: 't1', snapshotDigest: master.digest, readAt: master.readAt,
    } });
    expect(source).toEqual({ sourceProductId: 'synthetic-product', supplierId: 'RP001', termKey: 'source:24_2만' });
  });
  it('retains native IDs after an evidenced rename while changing snapshot provenance', () => {
    const old = snapshot(), renamed = snapshot();
    renamed.masters[0]!.data.sub_model = '쏘나타 디 엣지 DN8';
    renamed.masters[0]!.data.sub_model_aliases = [names[2]];
    renamed.trims[0]!.data.sub_model = '쏘나타 디 엣지 DN8';
    const { readAt, masters, trims } = renamed;
    renamed.digest = createHash('sha256').update(JSON.stringify({ readAt, masters, trims })).digest('hex');
    const choice = chooseVehicleIdentity(indexVehicleMaster(verifiedMasterRecords(renamed)), input(names));
    expect(choice).toMatchObject({ pick: 'SHEET', masterId: 'm1', trimId: 't1' });
    expect(verifiedVehicleMasterReference(renamed, { masterId: 'm1', trimId: 't1' }))
      .toMatchObject({ state: 'KNOWN', masterId: 'm1', trimId: 't1', snapshotDigest: renamed.digest });
    expect(renamed.digest).not.toBe(old.digest);
  });
  it('does not issue verified IDs for parent drift, retirement, stale or tampered snapshots', () => {
    const drift = snapshot({ sub_model: 'unverified old name' });
    expect(() => verifiedVehicleMasterReference(drift, { masterId: 'm1', trimId: 't1' })).toThrow('HOLD');
    const retired = snapshot();
    retired.masters[0]!.data.retired = true;
    const { readAt, masters, trims } = retired;
    retired.digest = createHash('sha256').update(JSON.stringify({ readAt, masters, trims })).digest('hex');
    expect(() => verifiedVehicleMasterReference(retired, { masterId: 'm1', trimId: 't1' })).toThrow('HOLD');
    expect(() => verifiedVehicleMasterReference(snapshot(), { masterId: 'm1', trimId: 't1' }, Date.now() + 300001)).toThrow();
    expect(() => verifiedVehicleMasterReference({ ...snapshot(), digest: 'tampered' }, { masterId: 'm1', trimId: 't1' })).toThrow();
  });
  it('holds duplicate alias matches instead of publishing the first trim ID', () => {
    const master = snapshot();
    master.trims.push({ id: 't2', data: { ...master.trims[0]!.data, trim: '프리미엄' } });
    const { readAt, masters, trims } = master;
    master.digest = createHash('sha256').update(JSON.stringify({ readAt, masters, trims })).digest('hex');
    const result = chooseVehicleIdentity(indexVehicleMaster(verifiedMasterRecords(master)),
      input(['현대', '쏘나타', '소나타 DN8', '스마트 초이스']));
    expect(result).toMatchObject({ pick: 'HOLD', identity: null });
    expect(result).not.toHaveProperty('trimId');
  });
  it('excludes a drifting pair without blocking an independent valid pair or inventing an ID', () => {
    const master = snapshot();
    master.trims.push({ id: 'drifting-trim', data: { ...master.trims[0]!.data, sub_model: 'unclassified source name' } });
    const { readAt, masters, trims } = master;
    master.digest = createHash('sha256').update(JSON.stringify({ readAt, masters, trims })).digest('hex');
    expect(verifiedVehicleMasterReference(master, { masterId: 'm1', trimId: 't1' }).state).toBe('KNOWN');
    expect(verifiedVehicleMasterReference(master, { masterId: 'm1', trimId: 'drifting-trim' }).state).toBe('HOLD');
    expect(chooseVehicleIdentity(indexVehicleMaster(verifiedMasterRecords(master)),
      input(['현대', '쏘나타', 'unclassified source name', '스마트'])).pick).toBe('HOLD');
  });
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
