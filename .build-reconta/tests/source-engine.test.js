import { describe, expect, it, vi } from 'vitest';
import { runSharedSheetCli } from '../src/jobs/ingest-shared-sheet-canonical.js';
import { sourceHeartbeat, sourceSaleAvailable, sourceProductKey, validateSourceRecord, representativeTerms, classifyReadError, compactRecord } from '../src/domain/source-engine.js';
import { applySourceRecords, planSourceRecords } from '../src/application/source-engine.js';
import { sharedSheetEngine, sharedSheetRecords } from '../src/adapters/shared-sheet-engine.js';
import { sharedSheetChannels, sharedSheetHeaders } from '../src/adapters/shared-sheet-source.js';
import { dryRunSharedSheetEngine } from '../src/jobs/source-engine-shared-sheet.js';
import { stableDigest } from '../src/shared/stable-digest.js';
const time = '2026-10-12T00:00:00.000Z', now = Date.parse(time);
function record(uid = 'synthetic-6774') {
    return { sourceId: 'SYNTHETIC', uid, plate: '12가3456', vehicleText: '합성 G90',
        status: { raw: '출고가능', saleAvailable: true }, observedAt: time, raw: {}, vehicleHold: [],
        terms: [{ months: 12, monthlyRent: { state: 'KNOWN', value: 100 }, deposit: { state: 'ZERO', value: 0 }, mileage: '연 20000km', raw: { deposit: '무보증' } }] };
}
function fakeCommands(initial = []) {
    const data = new Map(initial.map(r => [sourceProductKey(r), structuredClone(r)]));
    const backups = new Map(), order = [];
    const commands = {
        async read(sourceId, uid) { return structuredClone(data.get(sourceProductKey({ sourceId, uid })) ?? null); },
        async backup(key, before) { order.push('backup'); backups.set(key, structuredClone(before)); },
        async readBackup(key) { if (!backups.has(key))
            throw Error('MISSING'); return structuredClone(backups.get(key)); },
        async compareAndApply(beforeDigest, after) {
            const key = sourceProductKey(after);
            if (stableDigest(data.get(key) ?? null) !== beforeDigest)
                throw Error('STALE');
            order.push(after.uid);
            data.set(key, structuredClone(after));
        },
    };
    return { data, order, commands };
}
function capture(rows, uid = true) {
    const channel = sharedSheetChannels[0];
    const headers = [...sharedSheetHeaders, ...(uid ? ['UID'] : [])];
    return { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-only', layoutVersion: '2026-10-04-no-account', readTime: time,
        revision: 'synthetic', tabs: [...new Set(sharedSheetChannels.map(c => c.tab))].map(title => {
            const values = [headers, ...(title === channel.tab ? rows.map(r => headers.map(h => ({ 회사명: channel.companyName,
                    차량번호: '신차', 차량상태: '출고가능', 상품구분: '중고렌트', '12개월': 500000, 단기보증: '무보증', 장기보증: '무보증',
                    연주행: '20000km', '차명 원문': '합성 G90', ...r }[h] ?? ''))) : [])];
            return { title, readTime: time, complete: true, rowCount: values.length, values };
        }) };
}
const read = (raw) => ({ raw, complete: true, attemptedAt: time, observedAt: time, error: null });
describe('source contract and expiry', () => {
    it('returns validation errors for malformed external records without throwing', () => {
        expect(validateSourceRecord(null)).toContain('RECORD_SHAPE_INVALID');
        expect(validateSourceRecord({ ...record(), terms: [null] })).toContain('TERMS_HOLD');
        expect(validateSourceRecord({ ...record(), terms: [{ ...record().terms[0], deposit: { state: 'KNOWN', value: 0 } }] })).toContain('TERMS_HOLD');
        expect(validateSourceRecord({ ...record(), terms: [record().terms[0], record().terms[0]] })).toContain('TERMS_HOLD');
    });
    it.each([['SHARED_SHEET', 600], ['AICA', 300], ['IANCAR', 3600], ['OTHER', 1800]])('%s expires at configured age', (family, ttl) => {
        expect(sourceSaleAvailable(record(), family, now + ttl * 1000)).toBe(true);
        expect(sourceSaleAvailable(record(), family, now + ttl * 1000 + 1)).toBe(false);
    });
    it('fails closed for future time and invalid TTL while preserving permitted UNKNOWN deposit', () => {
        expect(sourceSaleAvailable(record(), 'SHARED_SHEET', now - 1)).toBe(false);
        expect(sourceSaleAvailable(record(), 'SHARED_SHEET', now, NaN)).toBe(false);
        const r = record();
        r.terms[0].deposit = { state: 'UNKNOWN', value: null };
        expect(sourceSaleAvailable(r, 'SHARED_SHEET', now)).toBe(true);
        expect(validateSourceRecord(r)).not.toContain('TERMS_HOLD');
    });
    it('does not turn a failed or partial attempt into a complete heartbeat', () => {
        const base = { runId: 'one', sourceId: 'SYNTHETIC', status: 'COMPLETED', startedAt: time,
            observedAt: time, coverage: { mode: 'FULL', completeness: 'COMPLETE' }, headStatus: 'CURRENT', rawCount: 4, candidateCount: 4, warningCount: 1 };
        const h = sourceHeartbeat('SYNTHETIC', [base, { ...base, runId: 'two', status: 'FAILED', startedAt: new Date(now + 1000).toISOString(),
                coverage: { mode: 'PARTIAL', completeness: 'INCOMPLETE' }, rawCount: 2, warningCount: 2, error: 'private provider text' }]);
        expect(h).toEqual({ lastCompleteAt: time, lastAttemptAt: new Date(now + 1000).toISOString(), readCount: 2, heldCount: 2, error: 'READ_FAILED' });
    });
});
describe('F05 adapter using existing capture/normalizer', () => {
    it('keeps four 신차 products distinct by actual UID, stable across reorder and plate changes', () => {
        const rows = [1, 2, 3, 4].map(i => ({ UID: `synthetic-new-${i}` }));
        const a = sharedSheetRecords(read(capture(rows))).records;
        const b = sharedSheetRecords(read(capture([...rows].reverse()))).records;
        expect(a).toHaveLength(4);
        expect(new Set(a.map(sourceProductKey)).size).toBe(4);
        expect(a.every(r => r.plate === null)).toBe(true);
        expect(a.map(sourceProductKey).sort()).toEqual(b.map(sourceProductKey).sort());
    });
    it('preserves explicit 무보증 as ZERO and never substitutes legacy supplement amount', () => {
        const result = sharedSheetRecords(read(capture([{ UID: 'synthetic-6774' }])));
        expect(result.records[0].terms[0].deposit).toEqual({ state: 'ZERO', value: 0 });
        expect(result.records[0].vehicleHold).toContain('VEHICLE_MASTER_REVIEW_REQUIRED');
    });
    it('marks same assigned synthetic plate as duplicate suspect, without merging UIDs', () => {
        const r = sharedSheetRecords(read(capture([{ UID: 'a', 차량번호: 'TEST-FAKE-8320' }, { UID: 'b', 차량번호: 'TEST-FAKE-8320' }])));
        expect(r.records).toHaveLength(2);
        expect(r.held.filter(h => h.reasons.includes('DUPLICATE_PLATE_SUSPECT'))).toHaveLength(2);
    });
    it('holds only missing/duplicate UIDs and never uses row positions', () => {
        expect(sharedSheetRecords(read(capture([{ UID: 'a' }], false))).held[0].reasons).toContain('UID_REQUIRED');
        const r = sharedSheetRecords(read(capture([{ UID: 'a' }, { UID: 'a' }, { UID: 'b' }])));
        expect(r.records.map(x => x.uid)).toEqual(['b']);
        expect(r.held).toHaveLength(2);
    });
    it('retains blank deposit as UNKNOWN; bad price period cannot silently disappear', () => {
        const a = sharedSheetRecords(read(capture([{ UID: 'a', 단기보증: '', 장기보증: '' }])));
        expect(a.records[0].terms[0].deposit).toEqual({ state: 'UNKNOWN', value: null });
        // «협의» 는 아이카와 같은 «그 기간 가격 없음» 낱말이다(대표 10-14): 그 기간만 빠지고 차는 판매 가능하다.
        const b = sharedSheetRecords(read(capture([{ UID: 'a', '24개월': '협의' }])));
        expect(b.records[0].terms.map(t => t.months)).toEqual([12]);
        expect(validateSourceRecord(b.records[0])).toEqual([]);
        // 읽을 수 없는 대여료는 조용히 사라지지 않는다: TERMS_HOLD + RENT_REVIEW_REQUIRED.
        const c = sharedSheetRecords(read(capture([{ UID: 'a', '24개월': '오십만' }])));
        expect(validateSourceRecord(c.records[0])).toContain('TERMS_HOLD');
        expect(c.held[0].reasons).toEqual(['TERMS_HOLD', 'RENT_REVIEW_REQUIRED']);
    });
    it.each([['HTTP_429', 'RATE_LIMITED'], ['HTTP_403', 'AUTH_FAILED'], ['timeout', 'READ_FAILED']])('marks %s incomplete', async (message, error) => {
        const r = await sharedSheetEngine(async () => { throw Error(message); }, () => time).read();
        expect(r).toMatchObject({ raw: null, complete: false, error, observedAt: null });
    });
    it('a damaged common header fails the source schema', async () => {
        const c = capture([{ UID: 'a' }]);
        c.tabs[0].values[0][0] = 'bad';
        expect(await sharedSheetEngine(async () => c).read()).toMatchObject({ complete: false, error: 'SCHEMA_INVALID' });
    });
    it('runs existing canonical planner offline and reports source counts separately from UID HOLD', async () => {
        vi.stubEnv('FREEPASS_SHEET_F04_ID', 'synthetic-f04');
        try {
            const r = await dryRunSharedSheetEngine(capture([{ UID: 'a' }, { UID: 'b' }], false), now);
            expect(r).toMatchObject({ writes: 0, sourceAvailable: 2, uidRecords: 0, held: 2, expectedSourceAvailable: 103, countDelta: -101 });
        }
        finally {
            vi.unstubAllEnvs();
        }
    });
});
describe('row reconciliation and approval boundaries', () => {
    it('dry-run writes zero and applies ZERO over old amount despite vehicle HOLD', async () => {
        const previous = record();
        previous.observedAt = new Date(now - 1000).toISOString();
        previous.terms[0].deposit = { state: 'KNOWN', value: 1500000 };
        const f = fakeCommands([previous]), incoming = record();
        incoming.vehicleHold = ['MODEL_HOLD'];
        const p = await planSourceRecords(f.commands, [incoming], 'SHARED_SHEET', now);
        expect(await applySourceRecords(f.commands, p.plan, { now })).toMatchObject({ writes: 0 });
        expect(f.order).toEqual([]);
        expect(await applySourceRecords(f.commands, p.plan, { apply: true, now, digest: p.report.planDigest, approval: p.report.planDigest })).toMatchObject({ status: 'APPLIED', writes: 1 });
        expect(f.data.get(sourceProductKey(incoming)).terms[0].deposit).toEqual({ state: 'ZERO', value: 0 });
        expect(f.order[0]).toBe('backup');
    });
    it('explicit stop takes priority despite bad terms, retains old terms and absent products', async () => {
        const old = record('stop');
        old.observedAt = new Date(now - 1000).toISOString();
        const absent = record('absent'), f = fakeCommands([old, absent]);
        const stop = record('stop');
        stop.status = { raw: '출고불가', saleAvailable: false };
        stop.terms = [];
        const p = await planSourceRecords(f.commands, [record('new'), stop], 'SHARED_SHEET', now);
        expect(p.plan.entries[0].after.uid).toBe('stop');
        expect(p.plan.entries[0].after.terms).toEqual(old.terms);
        await applySourceRecords(f.commands, p.plan, { apply: true, now, digest: p.report.planDigest, approval: p.report.planDigest });
        expect(f.data.get(sourceProductKey(absent))).toEqual(absent);
    });
    it('blocks missing approval, changed plan, expired availability, and stale original', async () => {
        const f = fakeCommands(), p = await planSourceRecords(f.commands, [record()], 'SHARED_SHEET', now);
        await expect(applySourceRecords(f.commands, p.plan, { apply: true, now, digest: p.report.planDigest })).rejects.toThrow('APPROVED_DIGEST');
        await expect(applySourceRecords(f.commands, { ...p.plan, plannedAt: now + 1 }, { apply: true, now, digest: p.report.planDigest, approval: p.report.planDigest })).rejects.toThrow('APPROVED_DIGEST');
        await expect(applySourceRecords(f.commands, p.plan, { apply: true, now: now + 600001, digest: p.report.planDigest, approval: p.report.planDigest })).rejects.toThrow('REPLAN');
        f.data.set(sourceProductKey(record()), record());
        await expect(applySourceRecords(f.commands, p.plan, { apply: true, now, digest: p.report.planDigest, approval: p.report.planDigest })).rejects.toThrow('REPLAN');
        expect(f.order).toEqual([]);
    });
    it('requires backup readback before any mutation and detects canonical readback mismatch', async () => {
        const f = fakeCommands(), p = await planSourceRecords(f.commands, [record()], 'SHARED_SHEET', now);
        f.commands.readBackup = async () => record('wrong');
        await expect(applySourceRecords(f.commands, p.plan, { apply: true, now, digest: p.report.planDigest, approval: p.report.planDigest })).rejects.toThrow('BACKUP_MISMATCH');
        expect(f.data.size).toBe(0);
        const g = fakeCommands();
        g.commands.compareAndApply = async () => { };
        expect(await applySourceRecords(g.commands, p.plan, { apply: true, now, digest: p.report.planDigest, approval: p.report.planDigest })).toMatchObject({ status: 'PARTIAL_HOLD', writes: 1 });
    });
    it('isolates per-row command rejection and continues remaining rows', async () => {
        const f = fakeCommands(), apply = f.commands.compareAndApply;
        f.commands.compareAndApply = async (before, after, key) => { if (after.uid === 'bad')
            throw Error('bad'); await apply(before, after, key); };
        const p = await planSourceRecords(f.commands, [record('bad'), record('good')], 'SHARED_SHEET', now);
        expect(await applySourceRecords(f.commands, p.plan, { apply: true, now, digest: p.report.planDigest, approval: p.report.planDigest })).toMatchObject({ status: 'PARTIAL_HOLD', writes: 1 });
        expect(f.data.has(sourceProductKey(record('good')))).toBe(true);
    });
    it('holds new unresolved vehicles, duplicate UIDs and future observations', async () => {
        const f = fakeCommands(), r = record();
        r.vehicleHold = ['MASTER_HOLD'];
        const p = await planSourceRecords(f.commands, [r, record('duplicate'), record('duplicate'), { ...record('future'), observedAt: new Date(now + 1).toISOString() }], 'SHARED_SHEET', now);
        expect(p.plan.entries).toHaveLength(0);
        expect(p.plan.held).toHaveLength(4);
    });
});
it('CLI failure emits parseable HOLD JSON instead of Unexpected end of JSON input', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { }), error = vi.spyOn(console, 'error').mockImplementation(() => { });
    const oldExit = process.exitCode;
    try {
        await runSharedSheetCli(['--apply']);
        expect(process.exitCode).toBe(1);
        expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ mode: 'APPLY', status: 'HOLD', reason: 'SHARED_SHEET_JOB_HOLD' });
    }
    finally {
        process.exitCode = oldExit;
        log.mockRestore();
        error.mockRestore();
    }
});
describe('약정거리 옵션이 여럿인 원천의 항 식별 (이안카 ONE: 개월마다 약정거리 3옵션)', () => {
    const term = (months, mileage, rent) => ({ months, mileage, raw: {},
        monthlyRent: { state: 'KNOWN', value: rent }, deposit: { state: 'ZERO', value: 0 } });
    const three = () => [12, 24].flatMap(m => [term(m, '40000km/year', 648000), term(m, '20000km/year', 555000), term(m, '30000km/year', 602000)]);
    it('same months with different contracted mileage is valid; identical months and mileage is still a duplicate', () => {
        const r = { ...record(), terms: three() };
        expect(validateSourceRecord(r)).not.toContain('TERMS_HOLD');
        expect(validateSourceRecord({ ...r, terms: [...three(), term(12, '20000km/year', 999000)] })).toContain('TERMS_HOLD');
    });
    it('the sale-price map takes the smallest annual mileage per month deterministically, not the cheapest rent', () => {
        const rep = representativeTerms(three());
        expect(rep.map(t => [t.months, t.mileage])).toEqual([[12, '20000km/year'], [24, '20000km/year']]);
        expect(representativeTerms([...three()].reverse()).map(t => t.mileage)).toEqual(['20000km/year', '20000km/year']);
        expect(representativeTerms([term(12, '2500km/month', 700000), term(12, '20000km/year', 650000)])[0].mileage).toBe('20000km/year');
        expect(representativeTerms([term(1, '월렌트', 800000)])).toHaveLength(1);
    });
});
describe('저장용 압축 레코드 (이안카 문서 1MiB 초과 사고: 요금 원본이 term.raw·record.raw·source_cycle_raw 에 중복)', () => {
    const big = { contract_conditions: 'x'.repeat(19_700), insurance: { items: Array.from({ length: 40 }, (_, i) => ({ i, text: '보장 내용 '.repeat(20) })) } };
    const full = () => ({ ...record(), raw: { source: 'iancar', source_tab: 'ONE', rates: Array.from({ length: 24 }, () => big), cells: [1, 2, 3] },
        terms: Array.from({ length: 24 }, (_, i) => ({ months: 12, mileage: `${20000 + i}km/year`, raw: { rental_period: 12, monthly_rate: 555000 + i, ...big },
            monthlyRent: { state: 'KNOWN', value: 555000 + i }, deposit: { state: 'ZERO', value: 0 } })) });
    it('keeps short scalars and typed facts, digests large raw values, and is idempotent', () => {
        const c = compactRecord(full());
        expect(c.raw.source).toBe('iancar');
        expect(c.raw.source_tab).toBe('ONE');
        expect(c.raw.rates).toEqual({ __digest: expect.stringMatching(/^[0-9a-f]{32}$/) });
        expect(c.terms[0].raw.monthly_rate).toBe(555000);
        expect(c.terms[0].raw.contract_conditions).toHaveProperty('__digest');
        expect(c.terms[3]).toMatchObject({ months: 12, mileage: '20003km/year', monthlyRent: { state: 'KNOWN', value: 555003 } });
        expect(compactRecord(c)).toEqual(c);
        expect(JSON.stringify(c).length).toBeLessThan(20_000);
        expect(JSON.stringify(full()).length).toBeGreaterThan(1_000_000);
    });
    it('a changed raw detail changes the digest, so change detection survives compaction', () => {
        const a = full(), b = full();
        b.terms[0].raw.contract_conditions = 'changed';
        expect(compactRecord(a)).not.toEqual(compactRecord(b));
    });
});
describe('읽기 오류 분류', () => {
    it('keeps 429/401/403 classes and records only safe detail for the rest', () => {
        expect(classifyReadError(Object.assign(new Error('x'), { status: 429 }))).toEqual({ error: 'RATE_LIMITED', detail: null });
        expect(classifyReadError(new Error('HTTP_403'))).toEqual({ error: 'AUTH_FAILED', detail: null });
        expect(classifyReadError(Object.assign(new Error('x'), { status: 503 }))).toEqual({ error: 'READ_FAILED', detail: 'HTTP_503' });
        expect(classifyReadError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toEqual({ error: 'READ_FAILED', detail: 'TIMEOUT' });
        expect(classifyReadError(new Error('IANCAR_ONE_DETAIL_SOURCE_DRIFT'))).toEqual({ error: 'READ_FAILED', detail: 'IANCAR_ONE_DETAIL_SOURCE_DRIFT' });
        expect(classifyReadError(new Error('secret body text'))).toEqual({ error: 'READ_FAILED', detail: null });
    });
});
describe('번호 미배정 신차는 번호 공란 문서로 만들지 않는다', () => {
    it('새 차 + 번호 없음 → 보류(UID 대기), 번호 있는 새 차는 그대로 편입', async () => {
        const f = fakeCommands();
        const noPlate = record('va-unassigned');
        noPlate.plate = null;
        const p = await planSourceRecords(f.commands, [noPlate, record('va-with-plate')], 'SHARED_SHEET', now);
        expect(p.plan.held).toEqual([{ key: sourceProductKey(noPlate), reasons: ['NEW_VEHICLE_PLATE_UNASSIGNED_UID_PENDING'] }]);
        expect(p.plan.entries.map(e => e.after.uid)).toEqual(['va-with-plate']);
        await applySourceRecords(f.commands, p.plan, { apply: true, now, digest: p.report.planDigest, approval: p.report.planDigest });
        expect(f.data.has(sourceProductKey(noPlate))).toBe(false);
    });
    it('이미 있는 번호 공란 문서의 갱신은 막지 않는다(삭제·하향 없음)', async () => {
        const existing = record('va-existing');
        existing.plate = null;
        existing.observedAt = new Date(now - 1000).toISOString();
        const f = fakeCommands([existing]), incoming = record('va-existing');
        incoming.plate = null;
        const p = await planSourceRecords(f.commands, [incoming], 'SHARED_SHEET', now);
        expect(p.plan.held).toEqual([]);
        expect(p.plan.entries).toHaveLength(1);
    });
});
