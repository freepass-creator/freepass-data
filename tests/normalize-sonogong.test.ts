import { describe, expect, it } from 'vitest';
import { ingestRawSourceBatch, prepareRawSourceBatch } from '../src/application/ingest-raw-source.js';
import { sonogongNormalizer } from '../src/adapters/normalize-sonogong.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';
import type { SourceIntakeBatch } from '../src/domain/source-intake.js';
import type { RawRecord } from '../src/domain/source.js';
import type { VehicleMasterRecord } from '../src/domain/vehicle-identity-resolution.js';

const observedAt = '2026-10-12T00:00:00.000Z';
const identity = ['FAKE_MAKER', 'FAKE_MODEL', 'FAKE_SUBMODEL', ''] as const;
const master = (extra: Partial<VehicleMasterRecord> = {}) => ({
  records: [{ masterId: 'fake-master', trimId: 'fake-trim', names: identity,
    aliases: identity.map(value => [value]), specs: { fuel: '가솔린', displacementCc: 1999 },
    modelYearStart: 2024, modelYearEnd: 2026, ...extra }],
  readAt: observedAt, snapshotDigest: 'fake-master-digest',
});
const estimate = (extra: Record<string, unknown> = {}) => ({
  estimateType: 'SUBSCRIBE_RETURN', creditType: 'LOW', monthly12: '410000',
  monthly24: 420000, securityDepositAmount: 1000000, ...extra,
});
const payload = (id: string, plate = '900가0000', bucket = 'LOW_SONOKONG') => ({
  bucket,
  list: { id, carNumber: plate, carName: 'FAKE_MODEL TEXT', groupName4: identity[0],
    groupName2: identity[1], groupName1: identity[2], carFuel: '가솔린',
    engineDisplacement: '2,000', mileage: '12,345', carManufactureDate: '2025',
    webVisibility: true, contractAvailable: true, hasActiveContract: false },
  detail: { id, carNumber: plate, firstRegistrationDate: '2025-01-02', saleAmt: '12,345,000',
    estimates: [estimate()], images: [{ sortOrder: 2, imageUrl: 'https://example.invalid/fake-2.jpg' },
      { sortOrder: 1, imageUrl: 'https://example.invalid/fake-1.jpg' }],
    carDescription: 'synthetic description', options: ['synthetic option'] },
  detailResponse: { success: true },
});
const batch = (records: SourceIntakeBatch['records']): SourceIntakeBatch => ({
  laneId: 'PRODUCT_VEHICLE',
  source: { sourceId: 'supplier:RP012:sonogong-original-api', kind: 'API', displayName: 'synthetic sonogong' },
  observedAt, sourceRevision: 'sonogong-raw/1:fixture', checksum: 'a'.repeat(64),
  coverage: { mode: 'FULL', completeness: 'COMPLETE' },
  records,
});
const normalizeOne = (input: Record<string, unknown>) => {
  const raw = prepareRawSourceBatch(batch([{ sourceRecordId: `${input.bucket}:fake-id`, payload: input }])).rawRecords[0] as RawRecord;
  return sonogongNormalizer(master())(raw);
};

describe('Sonogong RAW to candidate normalizer', () => {
  it('normalizes fabricated subscription return terms, money strings, vehicle facts and lineage without mutating RAW', () => {
    const original = payload('fake-id');
    const before = structuredClone(original);
    const normalized = normalizeOne(original)!;
    expect(normalized.record.status).toBe('VALID');
    expect(normalized.record.candidate).toMatchObject({
      providerCompanyCode: 'RP012',
      carNumber: '900가0000',
      maker: identity[0],
      model: identity[1],
      subModel: identity[2],
      commercialType: 'OGONG_SUBSCRIPTION',
    });
    expect(normalized.record.candidate.priceTerms.map(term => [term.termKey, term.monthlyRent.amount, term.deposit?.amount]))
      .toEqual([['m12', 410000, 1000000], ['m24', 420000, 1000000]]);
    expect(normalized.record.candidate.vehicleFacts?.fields.vehiclePrice).toMatchObject({ value: 12345000, state: 'KNOWN' });
    expect(normalized.record.candidate.vehicleFacts?.fields.photoUrlPresence?.value).toBe(JSON.stringify({ count: 2, hasUrls: true }));
    expect(normalized.record.candidate.issues).not.toContain('CATALOG_COMMERCIAL_TYPE_EXTENSION_REQUIRED');
    // 수수료 기준·공급사 상태 노출 정책은 보류 사유가 아니다(전 차량 100% 보류 방지).
    expect(normalized.record.candidate.issues).not.toContain('FEE_BASIS_PENDING');
    expect(normalized.record.candidate.issues).not.toContain('SUPPLIER_STATUS_POLICY_UNRESOLVED');
    expect(normalized.record.candidate.vehicleFacts?.fields.feeBasis).toBeUndefined();
    expect(original).toEqual(before);
    expect(JSON.stringify(normalized.record)).not.toContain('example.invalid/fake-1.jpg');
  });

  it('keeps used-rent bucket and fake ha/heo/ho style plate as a separate candidate', () => {
    const normalized = normalizeOne({ ...payload('rent-id', '900허0000', 'LOW_SONOKONG_DAILY'),
      detail: { ...payload('rent-id', '900허0000').detail, estimates: [estimate({ estimateType: 'RENT_RETURN' })] } })!;
    expect(normalized.record.candidate.providerCompanyCode).toBe('RP012');
    expect(normalized.record.candidate.sourceRecordId).toBe('LOW_SONOKONG_DAILY:fake-id');
  });

  it('marks zero deposit without waiver evidence UNKNOWN and rejects the candidate', () => {
    const normalized = normalizeOne({ ...payload('zero-id'),
      detail: { ...payload('zero-id').detail, estimates: [estimate({ securityDepositAmount: '0' })] } })!;
    expect(normalized.record.status).toBe('REJECTED');
    expect(normalized.record.candidate.priceTerms[0]?.depositState).toBe('UNKNOWN');
    expect(normalized.record.candidate.issues.join('|')).toContain('DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE');
  });

  it('holds vehicle identity conflicts through the Data master resolver', () => {
    const raw = prepareRawSourceBatch(batch([{ sourceRecordId: 'LOW_SONOKONG:conflict',
      payload: { ...payload('conflict'), list: { ...payload('conflict').list, groupName2: 'OTHER_MODEL' } } }])).rawRecords[0]!;
    const normalized = sonogongNormalizer(master())(raw)!;
    expect(normalized.record.status).toBe('REJECTED');
    expect(normalized.record.candidate.issues).toContain('VEHICLE_IDENTITY_DATA_CONFLICT');
  });

  it('skips list-page evidence records during ingestion while retaining raw count', async () => {
    const store = new MemorySourceStore();
    const sourceBatch = batch([
      { sourceRecordId: 'LOW_SONOKONG:vehicle-one', payload: payload('vehicle-one') },
      { sourceRecordId: 'evidence:list:LOW_SONOKONG:0', payload: { evidenceKind: 'LIST_PAGE', bucket: 'LOW_SONOKONG', response: { data: [] } } },
    ]);
    const run = await ingestRawSourceBatch(store, sourceBatch, observedAt, sonogongNormalizer(master()));
    expect(run.rawCount).toBe(2);
    expect(run.candidateCount).toBe(1);
  });

  it('keeps the same fabricated car in two buckets as separate candidate IDs', () => {
    const first = normalizeOne(payload('same-id', '900가0000', 'LOW_SONOKONG'))!;
    const second = normalizeOne(payload('same-id', '900가0000', 'LOW_TCAR'))!;
    expect(first.record.sourceRecordId).not.toBe(second.record.sourceRecordId);
    expect(first.record.candidateId).not.toBe(second.record.candidateId);
  });

  it('treats electric-car displacement 0 and vehicle price 0 as absent, not as known values or hold reasons', () => {
    const base = payload('ev-id');
    const normalized = normalizeOne({ ...base, list: { ...base.list, engineDisplacement: 0 },
      detail: { ...base.detail, saleAmt: 0 } })!;
    const fields = normalized.record.candidate.vehicleFacts!.fields;
    expect(fields.displacementCc).toMatchObject({ value: null, state: 'MISSING' });
    expect(fields.vehiclePrice).toMatchObject({ value: null, state: 'MISSING' });
    expect(normalized.record.candidate.issues).not.toContain('INVALID_DISPLACEMENT_CC');
    expect(normalized.record.candidate.issues).not.toContain('INVALID_VEHICLE_PRICE');
  });

  it('unifies fuel spelling but never guesses hybrid kind from an ambiguous combined label', () => {
    const fuel = (carFuel: string) => {
      const base = payload('fuel-id');
      return normalizeOne({ ...base, list: { ...base.list, carFuel } })!.record.candidate;
    };
    expect(fuel('휘발유').vehicleFacts?.fields.fuel).toMatchObject({ value: '가솔린', state: 'KNOWN' });
    expect(fuel('경유').vehicleFacts?.fields.fuel).toMatchObject({ value: '디젤', state: 'KNOWN' });
    expect(fuel('HEV').vehicleFacts?.fields.fuel).toMatchObject({ value: '하이브리드', state: 'KNOWN' });
    expect(fuel('lpg').vehicleFacts?.fields.fuel).toMatchObject({ value: 'LPG', state: 'KNOWN' });
    const ambiguous = fuel('가솔린+전기');
    expect(ambiguous.vehicleFacts?.fields.fuel).toMatchObject({ value: null, state: 'REVIEW_REQUIRED' });
    expect(ambiguous.issues).toContain('FUEL_UNRESOLVED');
  });

  it('keeps return and buyout terms of the same month apart and flags a duplicate instead of colliding lineage', () => {
    const base = payload('multi-id');
    const normalized = normalizeOne({ ...base, detail: { ...base.detail, estimates: [
      estimate({ estimateType: 'SUBSCRIBE_RETURN', monthly12: 410000 }),
      estimate({ estimateType: 'SUBSCRIBE_BUYOUT', monthly12: 510000 }),
      estimate({ estimateType: 'SUBSCRIBE_RETURN', monthly12: 999000 })] } })!;
    const keys = normalized.record.candidate.priceTerms.map(term => term.termKey);
    expect(keys).toContain('m12');
    expect(keys).toContain('m12_buyout');
    expect(new Set(keys).size).toBe(keys.length);
    expect(normalized.record.candidate.issues).toContain('DUPLICATE_ESTIMATE_TERM:m12');
    const ids = normalized.lineage.map(item => item.lineageRecordId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects a first-registration date that does not exist on the calendar', () => {
    const base = payload('date-id');
    const normalized = normalizeOne({ ...base, detail: { ...base.detail, firstRegistrationDate: '2025-02-30' } })!;
    expect(normalized.record.candidate.vehicleFacts?.fields.firstRegistration).toMatchObject({ value: null, state: 'REVIEW_REQUIRED' });
    expect(normalized.record.candidate.issues).toContain('INVALID_FIRST_REGISTRATION');
  });

  it('holds a candidate whose list and detail are not the same vehicle and attaches no detail money', () => {
    const base = payload('id-mismatch', '900가0000');
    const differentPlate = normalizeOne({ ...base, detail: { ...base.detail, carNumber: '900나1111' } })!.record.candidate;
    expect(differentPlate.issues).toContain('IDENTITY_MISMATCH');
    expect(differentPlate.priceTerms).toEqual([]);
    const sameVinDifferent = normalizeOne({ ...base, list: { ...base.list, vin: 'FAKEVIN0000000001' },
      detail: { ...base.detail, vin: 'FAKEVIN0000000002' } })!.record;
    expect(sameVinDifferent.candidate.issues).toContain('IDENTITY_MISMATCH');
    expect(sameVinDifferent.candidate.priceTerms).toEqual([]);
    expect(sameVinDifferent.status).toBe('REJECTED');
    const noDetailPlate = normalizeOne({ ...base, detail: { ...base.detail, carNumber: undefined } })!.record.candidate;
    expect(noDetailPlate.issues).toContain('NO_DETAIL_IDENTITY');
    expect(noDetailPlate.priceTerms).toEqual([]);
    const allMatch = normalizeOne({ ...base, list: { ...base.list, vin: 'fakevin0000000001' },
      detail: { ...base.detail, vin: 'FAKEVIN0000000001' } })!.record;
    expect(allMatch.candidate.issues).not.toContain('IDENTITY_MISMATCH');
    expect(allMatch.status).toBe('VALID');
  });
});
