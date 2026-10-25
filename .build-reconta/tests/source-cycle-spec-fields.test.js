import { describe, expect, it } from 'vitest';
import { planSourceCycle } from '../src/application/source-cycle.js';
import { compactRaw, compactRecord } from '../src/domain/source-engine.js';
import { nativeCycleFields } from '../src/infra/source-cycle-firestore.js';
// 값은 전부 합성. 차 한 대 사실(raw.spec)이 새 문서 칸까지 실제 값으로 가는지, 옛 digest 저장 문서는 일괄 UPDATE 되지 않는지.
const time = '2026-10-14T00:00:00.000Z', now = Date.parse(time) + 1000;
const config = { sourceId: 'RP006', family: 'OTHER', maxDowngradeRatio: 0.5 };
const spec = { year: '2024', fuel_type: '가솔린', ext_color: '흰색', mileage: '12000', first_registration_date: '2024-03' };
const record = (uid, s = spec) => ({ sourceId: 'RP006', uid, plate: uid, vehicleText: '합성 차종',
    status: { raw: '출고가능', saleAvailable: true }, observedAt: time, vehicleHold: [],
    raw: { source: 'ironrentcar-web', images: ['https://ironrentcar.com/a.jpg'], spec: s },
    terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: 700000 }, deposit: { state: 'ZERO', value: 0 }, mileage: null, raw: {} }] });
const evidence = (records) => ({ records, complete: true, observedAt: time, heldCount: 0 });
/** 옛 엔진이 저장한 형태: raw.spec 전체가 digest. */
const legacyStored = (r) => ({ record: { ...compactRecord(r), raw: compactRaw(r.raw) }, listable: true,
    locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null });
describe('raw.spec → 새 문서 사실 칸(연식·연료·색상·주행거리)', () => {
    it('a newly enrolled document gets year/fuel/color/mileage from the real spec', () => {
        const { plan } = planSourceCycle(config, evidence([record('12가3456')]), { products: [], complete: true }, now);
        expect(plan.entries.map(e => e.kind)).toEqual(['ENROLL']);
        const fields = nativeCycleFields(plan.entries[0].after);
        expect(fields).toMatchObject({ year: '2024', fuel_type: '가솔린', ext_color: '흰색', mileage: '12000', first_registration_date: '2024-03' });
        // 저장 기록에도 spec 은 실제 값(이후 되읽기·재비교 기준). 큰 값(사진 목록)은 계속 digest.
        expect(fields.source_cycle_record.raw.spec).toEqual(spec);
        expect(fields.source_cycle_record.raw.images).toHaveProperty('__digest');
    });
    it('an existing document stored with the digest-form spec and the same spec is unchanged (no mass UPDATE)', () => {
        const r = record('12가3456');
        const stored = legacyStored(r);
        expect(stored.record.raw.spec).toHaveProperty('__digest');
        const { plan } = planSourceCycle(config, evidence([r]), { products: [stored], complete: true }, now);
        expect(plan.entries).toEqual([]);
        // 새 형태(실제 값)로 저장된 문서도 같다.
        const fresh = { ...stored, record: compactRecord(r) };
        expect(planSourceCycle(config, evidence([r]), { products: [fresh], complete: true }, now).plan.entries).toEqual([]);
    });
    it('a changed spec is still detected as a change against the digest-form stored record', () => {
        const stored = legacyStored(record('12가3456'));
        const { plan } = planSourceCycle(config, evidence([record('12가3456', { ...spec, ext_color: '검정' })]), { products: [stored], complete: true }, now);
        expect(plan.entries.map(e => e.kind)).toEqual(['UPDATE']);
        // 기존 문서에는 사실 칸을 쓰지 않는다(새 문서에만).
        expect(nativeCycleFields(plan.entries[0].after, { car_number: '12가3456' })).not.toHaveProperty('ext_color');
    });
    it('a large or nested spec still compacts to a digest (document size guard unchanged), and compaction is idempotent', () => {
        const big = compactRecord({ ...record('12가3456'), raw: { spec: { nested: { a: 1 } } } });
        expect(big.raw.spec).toHaveProperty('__digest');
        expect(compactRecord(compactRecord(record('12가3456')))).toEqual(compactRecord(record('12가3456')));
    });
});
