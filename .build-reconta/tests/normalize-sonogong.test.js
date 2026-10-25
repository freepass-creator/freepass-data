import { describe, expect, it } from 'vitest';
import { ingestRawSourceBatch, prepareRawSourceBatch } from '../src/application/ingest-raw-source.js';
import { sonogongNormalizer, truncateSonogongRent, SONOGONG_RENT_TRUNCATE_UNIT, SONOGONG_RENT_RULE } from '../src/adapters/normalize-sonogong.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';
const observedAt = '2026-10-12T00:00:00.000Z';
const identity = ['FAKE_MAKER', 'FAKE_MODEL', 'FAKE_SUBMODEL', ''];
const master = (extra = {}) => ({
    records: [{ masterId: 'fake-master', trimId: 'fake-trim', names: identity,
            aliases: identity.map(value => [value]), specs: { fuel: '가솔린', displacementCc: 1999 },
            modelYearStart: 2024, modelYearEnd: 2026, ...extra }],
    readAt: observedAt, snapshotDigest: 'fake-master-digest',
});
const estimate = (extra = {}) => ({
    estimateType: 'SUBSCRIBE_RETURN', creditType: 'LOW', monthly12: '410000',
    monthly24: 420000, securityDepositAmount: 1000000, ...extra,
});
const payload = (id, plate = '900가0000', bucket = 'LOW_SONOKONG') => ({
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
const batch = (records) => ({
    laneId: 'PRODUCT_VEHICLE',
    source: { sourceId: 'supplier:RP012:sonogong-original-api', kind: 'API', displayName: 'synthetic sonogong' },
    observedAt, sourceRevision: 'sonogong-raw/1:fixture', checksum: 'a'.repeat(64),
    coverage: { mode: 'FULL', completeness: 'COMPLETE' },
    records,
});
const normalizeOne = (input) => {
    const raw = prepareRawSourceBatch(batch([{ sourceRecordId: `${input.bucket}:fake-id`, payload: input }])).rawRecords[0];
    return sonogongNormalizer(master())(raw);
};
describe('Sonogong RAW to candidate normalizer', () => {
    it('normalizes fabricated subscription return terms, money strings, vehicle facts and lineage without mutating RAW', () => {
        const original = payload('fake-id');
        const before = structuredClone(original);
        const normalized = normalizeOne(original);
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
            detail: { ...payload('rent-id', '900허0000').detail, estimates: [estimate({ estimateType: 'RENT_RETURN' })] } });
        expect(normalized.record.candidate.providerCompanyCode).toBe('RP012');
        expect(normalized.record.candidate.sourceRecordId).toBe('LOW_SONOKONG_DAILY:fake-id');
    });
    it('marks zero deposit without waiver evidence UNKNOWN and rejects the candidate', () => {
        const normalized = normalizeOne({ ...payload('zero-id'),
            detail: { ...payload('zero-id').detail, estimates: [estimate({ securityDepositAmount: '0' })] } });
        expect(normalized.record.status).toBe('REJECTED');
        expect(normalized.record.candidate.priceTerms[0]?.depositState).toBe('UNKNOWN');
        expect(normalized.record.candidate.issues.join('|')).toContain('DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE');
    });
    it('holds vehicle identity conflicts through the Data master resolver', () => {
        const raw = prepareRawSourceBatch(batch([{ sourceRecordId: 'LOW_SONOKONG:conflict',
                payload: { ...payload('conflict'), list: { ...payload('conflict').list, groupName2: 'OTHER_MODEL' } } }])).rawRecords[0];
        const normalized = sonogongNormalizer(master())(raw);
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
        const first = normalizeOne(payload('same-id', '900가0000', 'LOW_SONOKONG'));
        const second = normalizeOne(payload('same-id', '900가0000', 'LOW_TCAR'));
        expect(first.record.sourceRecordId).not.toBe(second.record.sourceRecordId);
        expect(first.record.candidateId).not.toBe(second.record.candidateId);
    });
    it('treats electric-car displacement 0 and vehicle price 0 as absent, not as known values or hold reasons', () => {
        const base = payload('ev-id');
        const normalized = normalizeOne({ ...base, list: { ...base.list, engineDisplacement: 0 },
            detail: { ...base.detail, saleAmt: 0 } });
        const fields = normalized.record.candidate.vehicleFacts.fields;
        expect(fields.displacementCc).toMatchObject({ value: null, state: 'MISSING' });
        expect(fields.vehiclePrice).toMatchObject({ value: null, state: 'MISSING' });
        expect(normalized.record.candidate.issues).not.toContain('INVALID_DISPLACEMENT_CC');
        expect(normalized.record.candidate.issues).not.toContain('INVALID_VEHICLE_PRICE');
    });
    it('unifies fuel spelling but never guesses hybrid kind from an ambiguous combined label', () => {
        const fuel = (carFuel) => {
            const base = payload('fuel-id');
            return normalizeOne({ ...base, list: { ...base.list, carFuel } }).record.candidate;
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
                    estimate({ estimateType: 'SUBSCRIBE_RETURN', monthly12: 999000 })
                ] } });
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
        const normalized = normalizeOne({ ...base, detail: { ...base.detail, firstRegistrationDate: '2025-02-30' } });
        expect(normalized.record.candidate.vehicleFacts?.fields.firstRegistration).toMatchObject({ value: null, state: 'REVIEW_REQUIRED' });
        expect(normalized.record.candidate.issues).toContain('INVALID_FIRST_REGISTRATION');
    });
    it('holds a candidate whose list and detail are not the same vehicle and attaches no detail money', () => {
        const base = payload('id-mismatch', '900가0000');
        const differentPlate = normalizeOne({ ...base, detail: { ...base.detail, carNumber: '900나1111' } }).record.candidate;
        expect(differentPlate.issues).toContain('IDENTITY_MISMATCH');
        expect(differentPlate.priceTerms).toEqual([]);
        const sameVinDifferent = normalizeOne({ ...base, list: { ...base.list, vin: 'FAKEVIN0000000001' },
            detail: { ...base.detail, vin: 'FAKEVIN0000000002' } }).record;
        expect(sameVinDifferent.candidate.issues).toContain('IDENTITY_MISMATCH');
        expect(sameVinDifferent.candidate.priceTerms).toEqual([]);
        expect(sameVinDifferent.status).toBe('REJECTED');
        const noDetailPlate = normalizeOne({ ...base, detail: { ...base.detail, carNumber: undefined } }).record.candidate;
        expect(noDetailPlate.issues).toContain('NO_DETAIL_IDENTITY');
        expect(noDetailPlate.priceTerms).toEqual([]);
        const allMatch = normalizeOne({ ...base, list: { ...base.list, vin: 'fakevin0000000001' },
            detail: { ...base.detail, vin: 'FAKEVIN0000000001' } }).record;
        expect(allMatch.candidate.issues).not.toContain('IDENTITY_MISMATCH');
        expect(allMatch.status).toBe('VALID');
    });
    it('on identity hold carries no fact or lineage derived from the other vehicle detail', () => {
        const base = payload('id-mix', '900가0000');
        const otherDetail = { ...base.detail, carNumber: '900나1111', saleAmt: '77,777,000', firstRegistrationDate: '2019-07-07',
            images: [{ sortOrder: 1, imageUrl: 'https://example.invalid/other.jpg' }], carDescription: 'OTHER_VEHICLE_TEXT',
            options: ['OTHER_OPTION'] };
        const normalized = normalizeOne({ ...base, detail: otherDetail });
        const fields = normalized.record.candidate.vehicleFacts.fields;
        for (const key of ['vehiclePrice', 'firstRegistration', 'photoUrlPresence', 'rawPolicyOptionReference']) {
            const field = fields[key];
            expect(field === undefined || (field.value === null && field.state !== 'KNOWN')).toBe(true);
        }
        expect(normalized.record.candidate.priceTerms).toEqual([]);
        const dump = JSON.stringify([normalized.record, normalized.lineage]);
        for (const leak of ['77777000', '77,777,000', '2019-07-07', 'other.jpg', 'OTHER_VEHICLE_TEXT', 'OTHER_OPTION']) {
            expect(dump).not.toContain(leak);
        }
        expect(normalized.record.status).toBe('REJECTED');
    });
});
describe('손오공 대여료 천원 미만 절사(대표 2026-10-19)', () => {
    it('규칙: 929,381 → 929,000 · 1,000,999 → 1,000,000 · 딱 떨어지는 값은 그대로 · 천원 미만 양수는 0 원으로 바꾸지 않는다', () => {
        expect(SONOGONG_RENT_TRUNCATE_UNIT).toBe(1000);
        expect(truncateSonogongRent(929381)).toBe(929000);
        expect(truncateSonogongRent(1000999)).toBe(1000000);
        expect(truncateSonogongRent(929000)).toBe(929000);
        expect(truncateSonogongRent(1000000)).toBe(1000000);
        expect(truncateSonogongRent(0)).toBe(0);
        expect(truncateSonogongRent(999)).toBeNull();
        expect(truncateSonogongRent(-1)).toBeNull();
        expect(truncateSonogongRent(1.5)).toBeNull();
    });
    it('정리값만 절사하고 원문은 그대로 — 계보에 원문 값·정리값·절사 규칙을 함께 남긴다, 보증금 원문은 바꾸지 않는다', () => {
        const original = payload('fake-id');
        original.detail.estimates = [estimate({ monthly12: '929,381', monthly24: 1000999, monthly36: 929000, securityDepositAmount: 2787000 })];
        const before = structuredClone(original);
        const normalized = normalizeOne(original);
        expect(normalized.record.candidate.priceTerms.map(term => [term.termKey, term.monthlyRent.amount, term.deposit?.amount]))
            .toEqual([['m12', 929000, 2787000], ['m24', 1000000, 2787000], ['m36', 929000, 2787000]]);
        expect(original).toEqual(before);
        const rent = (key) => normalized.lineage.find(item => item.normalized?.fieldPath === `priceTerms.${key}.monthlyRent.amount`);
        expect([rent('m12').source.value, rent('m12').normalized?.value, rent('m12').transformId]).toEqual([929381, 929000, SONOGONG_RENT_RULE]);
        expect([rent('m24').source.value, rent('m24').normalized?.value]).toEqual([1000999, 1000000]);
        expect([rent('m36').source.value, rent('m36').normalized?.value]).toEqual([929000, 929000]);
    });
    it('천원 미만 양수 대여료는 0 원 확정이 아니라 읽을 수 없는 값으로 보류한다', () => {
        const original = payload('fake-id');
        original.detail.estimates = [estimate({ monthly12: 500, monthly24: 420000 })];
        const normalized = normalizeOne(original);
        expect(normalized.record.candidate.priceTerms.map(term => [term.termKey, term.monthlyRent.amount])).toEqual([['m24', 420000]]);
        expect(normalized.record.candidate.issues).toContain('MONTHLY_RENT_INVALID:m12');
    });
});
