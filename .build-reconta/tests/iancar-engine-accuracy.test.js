import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectIancarOneFullFacts, IANCAR_ONE_API_ORIGIN } from '../src/adapters/iancar-one-api.js';
import { iancarCyclePlugin } from '../src/adapters/source-cycle-plugins.js';
import { plateUidPlugin } from '../src/adapters/source-cycle-native.js';
import { runSourceCycle } from '../src/jobs/source-cycle.js';
import { emptyCycleState, planSourceCycle, applySourceCycle } from '../src/application/source-cycle.js';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields, sheetSpecFields, legacyObservedAt, iancarVehicleIdFields, LEGACY_NO_OBSERVATION } from '../src/infra/source-cycle-firestore.js';
import { stableDigest } from '../src/shared/stable-digest.js';
// 이안카(RP031) 엔진 경로 정확도(대표 2026-10-14 «데이터만큼은 정확하게 갖고 와야 된다»). 모든 값은 합성이다.
const config = { baseUrl: IANCAR_ONE_API_ORIGIN, apiKey: 'synthetic-key-never-real' };
const synced = '2026-10-01T00:00:00.000Z';
const rate = (over = {}) => ({ rental_period: 24, monthly_rate: 500000, deposit: 700000,
    contracted_mileage: 20000, mileage_period: 'year', currency: 'KRW', vat_included: true, contract_conditions: { version: 'synthetic-v1' }, ...over });
const row = (id, plate, extra = {}) => ({ vehicle_id: id, plate_number: plate, inventory_status: 'AVAILABLE',
    available: true, available_from: null, synced_at: synced, stale: false, name: `합성 ${id}`, ...extra });
describe('collector: one bad vehicle no longer fails the whole RP031 cycle', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T00:01:00.000Z')); });
    afterEach(() => vi.useRealTimers());
    it('holds identity and rate-fact problems per vehicle, reads the rest, and never fetches details for unidentifiable plates', async () => {
        const rows = [
            row('V1', '123가4567'), row('V2', 'bad-plate'), row('V3', '125가4567'), row('V4', '126가4567'),
            row('V5', '127가4567'), row('V6', '128가4567'), row('V7', '129가4567'), row('V8', '129가 4567'),
        ];
        const rates = { V1: [rate()], V3: [rate({ monthly_rate: 50000 })], V4: [],
            V5: [rate(), rate()], V6: [rate({ contract_conditions: {} })] };
        const paths = [];
        const fetcher = (async (input) => {
            const path = new URL(String(input)).pathname;
            paths.push(path);
            if (path === '/v1/vehicles')
                return Response.json({ success: true, data: rows, pagination: { page: 1, page_size: 100, total: rows.length }, synced_at: synced, stale: false });
            const id = path.split('/')[3], vehicle = rows.find(r => r.vehicle_id === id);
            if (path.endsWith('/rates'))
                return Response.json({ success: true, updated_at: '2026-09-26T00:00:00Z', data: rates[id] ?? [rate()] });
            return Response.json({ success: true, data: vehicle });
        });
        const capture = await collectIancarOneFullFacts(config, fetcher);
        expect(capture).toMatchObject({ readyForRawIngest: true, issues: [], total: 8 });
        expect(Object.fromEntries(capture.records.map(r => [r.vehicleId, r.hold ?? null]))).toEqual({
            V1: null, V2: { code: 'IANCAR_ONE_PLATE_IDENTITY_REQUIRES_REVIEW', identity: true },
            V3: { code: 'IANCAR_ONE_RATE_FACT_REQUIRES_REVIEW', identity: false }, V4: { code: 'IANCAR_ONE_RATES_EMPTY', identity: false },
            V5: { code: 'IANCAR_ONE_DUPLICATE_RATE', identity: false }, V6: { code: 'IANCAR_ONE_RATE_FACT_REQUIRES_REVIEW', identity: false },
            V7: { code: 'IANCAR_ONE_DUPLICATE_PLATE', identity: true }, V8: { code: 'IANCAR_ONE_DUPLICATE_PLATE', identity: true }
        });
        for (const id of ['V2', 'V7', 'V8'])
            expect(paths.some(p => p.startsWith(`/v1/vehicles/${id}`))).toBe(false);
        expect(paths.filter(p => p === '/v1/vehicles/V1/rates')).toHaveLength(1);
    });
    it('a broken rates envelope is still a transport failure for the whole cycle', async () => {
        const rows = [row('V1', '123가4567')];
        const fetcher = (async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/vehicles')
                return Response.json({ success: true, data: rows, pagination: { page: 1, page_size: 100, total: 1 }, synced_at: synced, stale: false });
            if (path.endsWith('/rates'))
                return Response.json({ success: false, updated_at: '2026-09-26T00:00:00Z', data: [] });
            return Response.json({ success: true, data: rows[0] });
        });
        await expect(collectIancarOneFullFacts(config, fetcher)).rejects.toThrow('INVALID_IANCAR_ONE_RATES_RESPONSE');
    });
});
// ── plugin + runner ──────────────────────────────────────────────────────────
const cycleTime = '2026-10-14T03:00:00.000Z', cycleNow = Date.parse('2026-10-14T03:02:00.000Z');
function oneCapture(items, over = {}) {
    return { version: 'iancar-one-api/1', capturedAt: cycleTime, origin: 'synthetic', syncedAt: cycleTime, stale: false, total: items.length, pages: 1,
        sourceDigest: 'synthetic', issues: [], readyForRawIngest: true, factScope: 'FULL_FACTS',
        records: items.map(i => ({ vehicleId: i.id, fingerprint: i.id, ...(i.hold ? { hold: i.hold } : {}),
            payload: { vehicle_id: i.id, plate_number: i.plate, inventory_status: 'AVAILABLE', available: true, ...i.extra,
                detail: { data: { vehicle_id: i.id, name: `합성 ${i.id}` } }, rates: { data: i.rates ?? [rate()] } } })), ...over };
}
const stored = (plate, rent = 400000, observedAt = '2026-10-14T01:00:00.000Z') => ({ listable: true, locked_by_contract: false,
    publication_withdrawal: null, publication_withdrawal_prior: null, record: { sourceId: 'RP031', uid: plate, plate, vehicleText: '합성',
        status: { raw: 'AVAILABLE', saleAvailable: true }, observedAt, raw: { vehicle_id: `old-${plate}` }, vehicleHold: [],
        terms: [{ months: 24, monthlyRent: { state: 'KNOWN', value: rent }, deposit: { state: 'KNOWN', value: 700000 }, mileage: '20000km/year', raw: {} }] } });
function memory(initial) {
    const data = new Map(initial.map(p => [p.record.uid, structuredClone(p)]));
    const backups = new Map();
    const raw = [];
    const commands = {
        async list() { return { complete: true, products: structuredClone([...data.values()]) }; },
        async read(_s, uid) { return structuredClone(data.get(uid) ?? null); },
        async backup(key, value) { backups.set(key, structuredClone(value)); },
        async readBackup(key) { return structuredClone(backups.get(key) ?? null); },
        async compareAndApply(digest, after) {
            if (stableDigest(data.get(after.record.uid) ?? null) !== digest)
                throw Error('CAS_CONFLICT');
            data.set(after.record.uid, structuredClone(after));
        },
        async storeRaw(input) { raw.push({ records: structuredClone([...input.records]), held: input.held.length, complete: input.complete }); return { stored: input.records.length, absentMarked: 0 }; },
    };
    return { commands, data, raw };
}
function control() {
    let state = emptyCycleState();
    const ctrl = { async acquire() { return async () => { }; }, async load() { return structuredClone(state); },
        async save(_id, s) { state = structuredClone(s); }, async heartbeat() { }, async alert() { } };
    return { ctrl, state: () => state };
}
const plugin = (capture) => plateUidPlugin(iancarCyclePlugin(0.9, async () => capture, () => cycleTime));
describe('RP031 per-vehicle holds in the cycle', () => {
    it('rate-fact holds protect only that vehicle: its document is untouched, absent vehicles are still downgraded, new held vehicles enroll unlisted', async () => {
        const m = memory([stored('123가4567'), stored('125가4567'), stored('199가9999'), stored('198가9999')]);
        const { ctrl, state } = control();
        const capture = oneCapture([{ id: 'V1', plate: '123가4567' }, { id: 'V3', plate: '125가4567', hold: { code: 'IANCAR_ONE_RATE_FACT_REQUIRES_REVIEW', identity: false }, rates: [rate({ monthly_rate: 50000 })] },
            { id: 'V4', plate: '126가4567', hold: { code: 'IANCAR_ONE_RATES_EMPTY', identity: false }, rates: [] }]);
        const result = await runSourceCycle(plugin(capture), m.commands, ctrl, { autoApprove: true, now: () => cycleNow });
        expect(result.status).toBe('APPLIED');
        expect(result.plan.warnings).not.toContain('ABSENCE_DOWNGRADE_SKIPPED');
        // 보류 차의 기존 문서: 가격·노출 그대로(틀린 50,000원이 쓰이지 않는다)
        expect(m.data.get('125가4567')).toEqual(stored('125가4567'));
        // 부재 차는 내려간다(보류 한 대가 다른 차의 부재 하향을 막지 않는다)
        expect(m.data.get('199가9999')).toMatchObject({ listable: false, publication_withdrawal: { reason: 'SOURCE_ABSENT' } });
        expect(m.data.get('198가9999')).toMatchObject({ listable: false });
        // 새 보류 차: 번호만 편입, 노출 안 함, 요금 항 없음
        expect(m.data.get('126가4567')).toMatchObject({ listable: false, record: { terms: [], status: { saleAvailable: false } } });
        expect(m.data.get('123가4567')).toMatchObject({ listable: true, record: { terms: [{ monthlyRent: { value: 500000 } }] } });
        expect(state().heldReasons).toMatchObject({ IANCAR_ONE_RATE_FACT_REQUIRES_REVIEW: 1, IANCAR_ONE_RATES_EMPTY: 1 });
    });
    it('identity holds (unidentifiable plate) still update the other vehicles but skip absence downgrades for that cycle', async () => {
        const m = memory([stored('123가4567'), stored('199가9999')]);
        const { ctrl, state } = control();
        const capture = oneCapture([{ id: 'V1', plate: '123가4567' }, { id: 'V2', plate: 'bad', hold: { code: 'IANCAR_ONE_PLATE_IDENTITY_REQUIRES_REVIEW', identity: true } }]);
        const result = await runSourceCycle(plugin(capture), m.commands, ctrl, { autoApprove: true, now: () => cycleNow });
        expect(result.status).toBe('APPLIED');
        expect(result.plan.warnings).toContain('ABSENCE_DOWNGRADE_SKIPPED');
        expect(m.data.get('199가9999').listable).toBe(true);
        expect(m.data.get('123가4567').record.terms[0].monthlyRent.value).toBe(500000);
        expect(state().heldReasons).toMatchObject({ IANCAR_ONE_PLATE_IDENTITY_REQUIRES_REVIEW: 1 });
    });
    it.each(['IANCAR_ONE_PAGINATION_TOTAL_MISMATCH', 'IANCAR_ONE_SYNC_TIME_DRIFT', 'IANCAR_ONE_PAGINATION_METADATA_DRIFT'])('list-stage failure %s never stores terms=[] rows in source_raw and writes nothing', async (issue) => {
        const m = memory([stored('123가4567')]);
        const capture = oneCapture([{ id: 'V1', plate: '123가4567' }], { readyForRawIngest: false, issues: [issue] });
        for (const r of capture.records) {
            delete r.payload.rates;
            delete r.payload.detail;
        }
        const result = await runSourceCycle(plugin(capture), m.commands, control().ctrl, { autoApprove: true, now: () => cycleNow });
        expect(result.status).toBe('HOLD');
        expect(m.raw.every(r => r.records.length === 0)).toBe(true);
        expect(m.data.get('123가4567')).toEqual(stored('123가4567'));
    });
});
describe('RP031 record facts', () => {
    it('normalizes the plate, carries ONE spec facts under the sheet spec keys and keeps maker/model only as raw names', async () => {
        const capture = oneCapture([{ id: 'V1', plate: ' 123가 4567 ', extra: { manufacturer: '합성제조사', model: '합성모델', year: 2023, fuel: '가솔린', color: '흰색', mileage: 12000 } }]);
        const p = plugin(capture), read = await p.read();
        const [record] = p.toRecords(read).records;
        expect(record.plate).toBe('123가4567');
        expect(record.raw.spec).toEqual({ year: '2023', fuel_type: '가솔린', ext_color: '흰색', mileage: '12000' });
        expect(record.raw).toMatchObject({ manufacturer: '합성제조사', model: '합성모델' });
        expect(sheetSpecFields(record.raw.spec)).toEqual({ year: '2023', fuel_type: '가솔린', ext_color: '흰색', mileage: '12000' });
        const fields = nativeCycleFields({ record: record, listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null });
        expect(fields).toMatchObject({ car_number: '123가4567', maker: '', model: '', year: '2023', fuel_type: '가솔린', ext_color: '흰색', mileage: '12000',
            iancar_one_vehicle_id: 'V1' });
    });
    it('ignores implausible spec values instead of inventing them', async () => {
        const capture = oneCapture([{ id: 'V1', plate: '123가4567', extra: { year: 'unknown', mileage: -1, fuel: '', color: 7 } }]);
        const p = plugin(capture);
        expect(p.toRecords(await p.read()).records[0].raw.spec).toBeUndefined();
    });
});
describe('RP031 supplier vehicle id (iancar_one_vehicle_id)', () => {
    const rec = (vehicleId) => ({ ...stored('123가4567').record, raw: { vehicle_id: vehicleId }, observedAt: cycleTime });
    it('fills when missing, keeps when equal, and holds (never overwrites) a different stored id for the same plate', () => {
        expect(iancarVehicleIdFields(rec('V1'), {})).toEqual({ iancar_one_vehicle_id: 'V1' });
        expect(iancarVehicleIdFields(rec('V1'), { iancar_one_vehicle_id: '' })).toEqual({ iancar_one_vehicle_id: 'V1' });
        expect(iancarVehicleIdFields(rec('V1'), { iancar_one_vehicle_id: 'V1' })).toEqual({ iancar_one_vehicle_id: 'V1' });
        expect(iancarVehicleIdFields(rec('V2'), { iancar_one_vehicle_id: 'V1' })).toEqual({ iancar_one_vehicle_id_conflict: { observed: 'V2', at: cycleTime } });
        expect(iancarVehicleIdFields(rec('V1'), { iancar_one_vehicle_id: 'V1', iancar_one_vehicle_id_conflict: { observed: 'V2' } }))
            .toEqual({ iancar_one_vehicle_id: 'V1', iancar_one_vehicle_id_conflict: null });
        expect(iancarVehicleIdFields({ ...rec('V1'), sourceId: 'RP012' }, {})).toEqual({});
        expect(iancarVehicleIdFields({ ...rec('V1'), raw: {} }, {})).toEqual({});
    });
});
// ── Firestore 명령 포트(합성 REST) ─────────────────────────────────────────────
const dirs = [];
afterEach(async () => { for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true }); });
function fakeFirestore(initial) {
    const docs = new Map();
    let clock = Date.parse('2026-10-14T02:30:00.000Z');
    const name = (uid) => `projects/synthetic-test/databases/(default)/documents/products/${uid}`;
    for (const d of initial)
        docs.set(d.id, { name: name(d.id), updateTime: d.updateTime, fields: encodeFields(d.fields) });
    const masked = (fields, paths) => {
        const out = {};
        for (const path of paths) {
            const [head, ...rest] = path.replace(/`/g, '').split('.');
            if (!(head in fields))
                continue;
            if (!rest.length) {
                out[head] = fields[head];
                continue;
            }
            const inner = fields[head]?.mapValue?.fields?.[rest[0]];
            if (inner !== undefined)
                out[head] = { mapValue: { fields: { ...(out[head]?.mapValue?.fields ?? {}), [rest[0]]: inner } } };
        }
        return out;
    };
    const fetcher = (async (input, init = {}) => {
        const url = new URL(String(input)), uid = decodeURIComponent(url.pathname.split('/').at(-1));
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        if (!init.method || init.method === 'GET') {
            let result = uid === 'products' ? { documents: [...docs.values()] } : docs.get(uid);
            if (!result)
                return new Response('{}', { status: 404 });
            result = structuredClone(result);
            const paths = url.searchParams.getAll('mask.fieldPaths');
            if (uid === 'products' && paths.length)
                for (const d of result.documents)
                    d.fields = masked(d.fields ?? {}, paths);
            return Response.json(result);
        }
        const current = docs.get(uid);
        if (url.searchParams.get('currentDocument.exists') === 'false' ? !!current : current?.updateTime !== url.searchParams.get('currentDocument.updateTime'))
            return new Response('{}', { status: 412 });
        const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
        const after = { name: name(uid), updateTime: new Date(clock += 1000).toISOString(), fields };
        docs.set(uid, after);
        return Response.json(after);
    });
    return { docs, fetcher };
}
async function setup(initial) {
    const dir = await mkdtemp(join(tmpdir(), 'iancar-accuracy-'));
    dirs.push(dir);
    const fake = fakeFirestore(initial);
    const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
        supplierDefaults: { RP031: { provider_name: '합성이안카', policy_code: 'SYNTHETIC_POLICY' } } });
    return { commands, fake };
}
const sourceRecord = (plate, vehicleId, rent = 500000) => ({ sourceId: 'RP031', uid: plate, plate, vehicleText: '합성',
    status: { raw: 'AVAILABLE', saleAvailable: true }, observedAt: cycleTime, raw: { vehicle_id: vehicleId }, vehicleHold: [],
    terms: [{ months: 24, monthlyRent: { state: 'KNOWN', value: rent }, deposit: { state: 'KNOWN', value: 700000 }, mileage: '20000km/year', raw: {} }] });
const cycle = async (commands, records) => {
    const built = planSourceCycle({ sourceId: 'RP031', family: 'IANCAR', maxDowngradeRatio: 1 }, { records, observedAt: cycleTime, heldCount: 0, complete: true }, await commands.list('RP031'), cycleNow);
    return { built, applied: await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now: cycleNow }) };
};
describe('RP031 engine writes through the Firestore port', () => {
    it('backfills iancar_one_vehicle_id on an engine-written listed document that lacks it, then stops rewriting', async () => {
        const before = { record: sourceRecord('123가4567', 'V1'), listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null };
        const engineDoc = { ...nativeCycleFields(before), provider_name: '합성이안카' };
        delete engineDoc.iancar_one_vehicle_id; // #639 이전 엔진이 만든 문서 모양
        const { commands, fake } = await setup([{ id: '123가4567', fields: engineDoc, updateTime: '2026-10-14T02:00:00.000Z' }]);
        expect((await commands.list('RP031')).products[0].rewriteReasons).toEqual(['IANCAR_VEHICLE_ID']);
        const first = await cycle(commands, [sourceRecord('123가4567', 'V1')]);
        expect(first.built.plan.entries.map(e => e.kind)).toEqual(['UPDATE']);
        expect(first.applied).toMatchObject({ status: 'APPLIED', verified: 1 });
        expect(decodeFields(fake.docs.get('123가4567').fields).iancar_one_vehicle_id).toBe('V1');
        expect((await cycle(commands, [sourceRecord('123가4567', 'V1')])).built.plan.entries).toEqual([]);
    });
    it('new engine documents carry the supplier vehicle id', async () => {
        const { commands, fake } = await setup([]);
        expect((await cycle(commands, [sourceRecord('123가4567', 'V9')])).applied).toMatchObject({ status: 'APPLIED', verified: 1 });
        expect(decodeFields(fake.docs.get('123가4567').fields)).toMatchObject({ iancar_one_vehicle_id: 'V9', car_number: '123가4567' });
    });
    it('legacy RP031 documents use the old publisher source time, not a later photo/policy updateTime, so the engine can take ownership', async () => {
        const legacy = { provider_company_code: 'RP031', provider_name: '합성이안카', car_number: '123가4567', car_name: '합성', listable: true, status: '출고가능',
            status_kind: '가용', vehicle_status: '출고가능', iancar_one_vehicle_id: 'V1', price: { '24': { rent: 450000, deposit: 700000 } },
            iancar_phase_one: { sourceSyncedAt: '2026-10-14T01:00:00.000Z', terms: [{ big: 'x'.repeat(50) }] } };
        // 사진·정책 쓰기가 원천 시각 이후 updateTime 을 밀어 놓은 상태(원천 cycleTime 03:00 보다 늦다)
        const { commands, fake } = await setup([{ id: '123가4567', fields: legacy, updateTime: '2026-10-14T05:00:00.000Z' }]);
        const products = (await commands.list('RP031')).products;
        expect(products[0].record.observedAt).toBe('2026-10-14T01:00:00.000Z');
        const { built, applied } = await cycle(commands, [sourceRecord('123가4567', 'V1')]);
        expect(built.plan.entries.map(e => e.kind)).toEqual(['UPDATE']);
        expect(applied).toMatchObject({ status: 'APPLIED', verified: 1 });
        expect(decodeFields(fake.docs.get('123가4567').fields)).toMatchObject({ iancar_one_vehicle_id: 'V1', price: { '24': { rent: 500000 } } });
    });
    it('a same-plate document bound to a different supplier id keeps its id and records the conflict', async () => {
        const legacy = { provider_company_code: 'RP031', provider_name: '합성이안카', car_number: '123가4567', car_name: '합성', listable: true, status: '출고가능',
            status_kind: '가용', vehicle_status: '출고가능', iancar_one_vehicle_id: 'OLD', _direct_ingest_at: Date.parse('2026-10-14T01:00:00.000Z') };
        const { commands, fake } = await setup([{ id: '123가4567', fields: legacy, updateTime: '2026-10-14T05:00:00.000Z' }]);
        expect((await cycle(commands, [sourceRecord('123가4567', 'NEW')])).applied).toMatchObject({ status: 'APPLIED', verified: 1 });
        expect(decodeFields(fake.docs.get('123가4567').fields)).toMatchObject({ iancar_one_vehicle_id: 'OLD', iancar_one_vehicle_id_conflict: { observed: 'NEW', at: cycleTime } });
    });
    it('legacy observation baseline: phase time, then _direct_ingest_at, else no observation; other suppliers unchanged', () => {
        expect(legacyObservedAt({ provider_company_code: 'RP031', iancar_phase_one: { sourceSyncedAt: '2026-10-14T01:00:00Z' }, _direct_ingest_at: 1 }, '2026-10-14T05:00:00Z'))
            .toBe('2026-10-14T01:00:00.000Z');
        expect(legacyObservedAt({ provider_company_code: 'RP031', _direct_ingest_at: Date.parse('2026-10-14T00:30:00Z') }, '2026-10-14T05:00:00Z'))
            .toBe('2026-10-14T00:30:00.000Z');
        expect(legacyObservedAt({ provider_company_code: 'RP031' }, '2026-10-14T05:00:00Z')).toBe(LEGACY_NO_OBSERVATION);
        expect(legacyObservedAt({ provider_company_code: 'RP031', source_observed_at: '2026-10-14T02:00:00.000Z' }, '2026-10-14T05:00:00Z')).toBe('2026-10-14T02:00:00.000Z');
        expect(legacyObservedAt({ provider_company_code: 'RP012' }, '2026-10-14T05:00:00Z')).toBe('2026-10-14T05:00:00Z');
    });
});
