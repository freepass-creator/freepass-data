import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { assessFreshness } from '../src/application/source-freshness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreCycleCommands, encodeFields, decodeFields, nativeCycleFields, statusKindOf, rawTitleBackfillFields, priceDigest } from '../src/infra/source-cycle-firestore.js';
import { sourceUid, f05NativeCapture, aicaNativeCapture, aicaNativePlugin, ironNativeCapture, plateUidPlugin } from '../src/adapters/source-cycle-native.js';
import { sourceCyclePlugin, decisionWithdrawnPlugin, AICA_SCOPES } from '../src/adapters/source-cycle-plugins.js';
import { sharedSheetChannels, sharedSheetChannelOf, sharedSheetHeaders } from '../src/adapters/shared-sheet-source.js';
import { planSourceCycle, applySourceCycle } from '../src/application/source-cycle.js';
import { runSourceCycle, runUnattendedSourceCycle } from '../src/jobs/source-cycle.js';
import { fileCycleControl } from '../src/adapters/source-cycle-control.js';
import { createSourceCycleRuntime, runtimeCli, collectorObservationPlugin, refreshF05SourceObservations, runUnattended } from '../src/runtime/source-cycle-runtime.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';
import { ingestSharedSheetObservedRows } from '../src/jobs/ingest-shared-sheet-canonical.js';
import { emptyCycleState } from '../src/ports/source-cycle.js';
import { stableDigest } from '../src/shared/stable-digest.js';
const time = '2026-10-13T00:00:00.000Z', now = Date.parse(time), source = 'SYNTHETIC';
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true }); });
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), 'source-cycle-runtime-')); dirs.push(dir); return dir; };
const product = (uid = '00가1001') => ({ record: { sourceId: source, uid, plate: uid,
        vehicleText: '합성 원문', status: { raw: '게시', saleAvailable: true }, terms: [{ months: 12,
                monthlyRent: { state: 'KNOWN', value: 100 }, deposit: { state: 'ZERO', value: 0 }, mileage: '20000km', raw: {} }],
        raw: { source: 'synthetic', source_tab: 'test', source_row: 2 }, observedAt: time, vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] },
    listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null });
function fakeFirestore(initial = []) {
    const docs = new Map();
    let version = 0;
    const doc = (uid, fields) => ({ name: `projects/synthetic-test/databases/(default)/documents/products/${uid}`,
        updateTime: `${time}:${++version}`, fields });
    for (const p of initial)
        docs.set(p.record.uid, doc(p.record.uid, encodeFields({ ...nativeCycleFields(p), unrelated: { preserve: true } })));
    const calls = [];
    let conflict = false, corrupt = false, reverse = false;
    const fetcher = vi.fn(async (input, init) => {
        const url = new URL(String(input)), uid = decodeURIComponent(url.pathname.split('/').at(-1));
        const body = init.body ? JSON.parse(init.body) : null;
        // 원천 원문 계층(source_raw) 저장은 상품 쓰기가 아니다: 조회·커밋을 호출 기록에 넣지 않고 빈 결과로 답한다.
        if (init.method === 'POST' && /:(runQuery|commit)$/.test(url.pathname))
            return new Response('[]', { status: 200 });
        calls.push({ method: init.method, url, body });
        if (init.method === 'GET') {
            let result = uid === 'products' ? { documents: [...docs.values()] } : docs.get(uid);
            if (!result)
                return new Response('{}', { status: 404 });
            result = structuredClone(result);
            // 목록 읽기의 필드 마스크를 실제 Firestore 처럼 적용한다(마스크에 없는 필드는 읽기 경로에서 항상 undefined — 2026-10-14 statusKindStale 실측).
            const masked = url.searchParams.getAll('mask.fieldPaths').map(p => p.replace(/`/g, ''));
            if (uid === 'products' && masked.length)
                for (const d of result.documents) {
                    d.fields = Object.fromEntries(Object.entries(d.fields ?? {}).filter(([k]) => masked.includes(k)));
                }
            const reorder = (v) => Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object'
                ? Object.fromEntries(Object.entries(v).reverse().map(([k, child]) => [k, reorder(child)])) : v;
            return Response.json(reverse ? reorder(result) : result);
        }
        if (init.method !== 'PATCH')
            throw Error('UNEXPECTED_WRITE');
        const current = docs.get(uid);
        if (conflict || (url.searchParams.get('currentDocument.exists') === 'false' ? !!current :
            current?.updateTime !== url.searchParams.get('currentDocument.updateTime')))
            return new Response('{}', { status: 412 });
        const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
        const after = doc(uid, fields);
        docs.set(uid, after);
        if (corrupt)
            after.fields.listable = { booleanValue: false };
        return Response.json(after);
    });
    return { docs, calls, fetcher, setConflict: () => { conflict = true; }, setCorrupt: () => { corrupt = true; }, reverse: () => { reverse = true; } };
}
async function setup(initial = [], extra = {}) {
    const dir = await directory(), fake = fakeFirestore(initial);
    const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
        observationSources: ['OBSERVE'], supplierDefaults: { SYNTHETIC: { provider_name: '합성공급사', policy_code: 'SYNTHETIC_POLICY' } }, ...extra });
    return { dir, fake, commands };
}
async function prepare(commands, records = [product().record]) {
    return planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records, observedAt: time, heldCount: 0, complete: true }, await commands.list(source), now);
}
const apply = (commands, built) => applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now });
describe('Firestore REST runtime offline', () => {
    it('repairs missing provenance only for reviewed UID, using the existing CAS writer and fresh source; repeat is noop', async () => {
        const p = product('00가1001');
        p.record.raw.source = 'shared-sheet';
        const fake = fakeFirestore([p]);
        delete fake.docs.get(p.record.uid).fields.source_cycle_write;
        const dir = await directory();
        const make = (uids) => firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' },
            token: async () => 'synthetic-token', fetcher: fake.fetcher, provenanceUids: uids });
        const plan = async (commands) => planSourceCycle({ sourceId: source, family: 'SHARED_SHEET', maxDowngradeRatio: 0.5 }, { records: [p.record], observedAt: time, complete: true, heldCount: 0 }, await commands.list(source), now);
        expect((await plan(make([]))).plan.entries).toEqual([]);
        const commands = make([p.record.uid]);
        const before = structuredClone(decodeFields(fake.docs.get(p.record.uid).fields).price);
        const built = planSourceCycle({ sourceId: source, family: 'SHARED_SHEET', maxDowngradeRatio: 0.5 }, { records: [p.record], observedAt: time, complete: true, heldCount: 0 }, await commands.list(source), now);
        expect(built.plan.entries).toHaveLength(1);
        expect(built.plan.entries[0].before.rewriteReasons).toContain('SOURCE_PROVENANCE');
        // Preparation of the repair itself must not write.
        expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
        expect(before).toEqual(decodeFields(fake.docs.get(p.record.uid).fields).price);
        fake.docs.get(p.record.uid).fields.locked_by_contract = { stringValue: 'LEDGER' };
        expect((await commands.list(source)).products[0].rewriteReasons ?? []).not.toContain('SOURCE_PROVENANCE');
        delete fake.docs.get(p.record.uid).fields.locked_by_contract;
        expect(await apply(commands, await plan(commands))).toMatchObject({ status: 'APPLIED', verified: 1 });
        const stored = decodeFields(fake.docs.get(p.record.uid).fields);
        expect(stored.source_cycle_write).toMatchObject({ by: 'source-engine', at: time });
        expect(stored.price).toEqual(before);
        expect((await plan(commands)).plan.entries).toEqual([]);
    });
    it('SPEC3E enrolls independent modes from all supplier documents, including non-listable', async () => {
        const existing = ['A', 'B', 'C'].map(uid => ({ ...product(uid), listable: false }));
        const { commands, fake } = await setup(existing);
        for (const [index, uid] of ['A', 'B', 'C'].entries())
            Object.assign(fake.docs.get(uid).fields, encodeFields({ provider_name: index < 2 ? 'Mode name' : 'Other name', policy_code: index > 0 ? 'MODE_POLICY' : 'OTHER_POLICY' }));
        const built = await prepare(commands);
        expect(built.plan.entries[0].after.supplierFields).toEqual({ provider_name: 'Mode name', policy_code: 'MODE_POLICY' });
        expect(await apply(commands, built)).toMatchObject({ status: 'APPLIED', verified: 1 });
        expect(decodeFields(fake.docs.get('00가1001').fields)).toMatchObject({ provider_name: 'Mode name', policy_code: 'MODE_POLICY' });
        expect((await prepare(commands)).plan.entries).toEqual([]);
        expect(fake.calls[0].url.searchParams.getAll('mask.fieldPaths')).toEqual(expect.arrayContaining(['provider_name', 'policy_code']));
    });
    it('SPEC3E holds an unconfigured supplier without any existing name and makes no writes', async () => {
        const fake = fakeFirestore();
        const commands = firestoreCycleCommands({ directory: await directory(), env: { FIREBASE_PROJECT_ID: 'synthetic-test' },
            token: async () => 'synthetic-token', fetcher: fake.fetcher });
        const built = await prepare(commands);
        expect(built.plan).toMatchObject({ held: 1, entries: [], warnings: ['SUPPLIER_NAME_REQUIRED'] });
        expect(await apply(commands, built)).toMatchObject({ writes: 0 });
        expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
    });
    it('SPEC3E falls back to the existing supplier name configuration without inventing a policy', async () => {
        const { commands } = await setup();
        expect((await commands.list('RP004')).enrollmentSupplier).toEqual({ provider_name: '아이카', policy_code: null });
    });
    it('SPEC3E UPDATE preserves both original supplier fields and omits them from the patch', async () => {
        const { commands, fake } = await setup([product()]);
        Object.assign(fake.docs.get('00가1001').fields, encodeFields({ provider_name: 'Original name', policy_code: 'ORIGINAL_POLICY' }));
        const next = product();
        next.record.terms[0].monthlyRent = { state: 'KNOWN', value: 200 };
        const built = await prepare(commands, [next.record]);
        expect(built.plan.entries[0].kind).toBe('UPDATE');
        expect(await apply(commands, built)).toMatchObject({ status: 'APPLIED', verified: 1 });
        expect(decodeFields(fake.docs.get('00가1001').fields)).toMatchObject({ provider_name: 'Original name', policy_code: 'ORIGINAL_POLICY' });
        expect(fake.calls.find(c => c.method === 'PATCH').url.searchParams.getAll('updateMask.fieldPaths'))
            .not.toEqual(expect.arrayContaining(['provider_name']));
        expect(fake.calls.find(c => c.method === 'PATCH').body.fields).not.toHaveProperty('policy_code');
    });
    it('SPEC3E supplier mode changes invalidate an approved enrollment plan', async () => {
        const { commands, fake } = await setup([{ ...product('A'), listable: false }]);
        Object.assign(fake.docs.get('A').fields, encodeFields({ provider_name: 'Before', policy_code: 'P' }));
        const built = await prepare(commands);
        Object.assign(fake.docs.get('A').fields, encodeFields({ provider_name: 'After', policy_code: 'P' }));
        await expect(apply(commands, built)).rejects.toThrow('CYCLE_REPLAN_REQUIRED');
        expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
    });
    it('dry-run makes no PATCH or backup', async () => {
        const { commands, fake, dir } = await setup();
        const built = await prepare(commands);
        expect((await applySourceCycle(commands, built.plan, { now })).status).toBe('DRY_RUN');
        expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
        expect(await readdir(dir)).toEqual([]);
    });
    it('enrolls native fields using exists=false and verifies reversed map keys', async () => {
        const { commands, fake } = await setup();
        fake.reverse();
        const result = await apply(commands, await prepare(commands));
        expect(result).toMatchObject({ status: 'APPLIED', writes: 1, verified: 1 });
        const patch = fake.calls.find(c => c.method === 'PATCH');
        expect(patch.url.searchParams.get('currentDocument.exists')).toBe('false');
        const fields = decodeFields(fake.docs.get('00가1001').fields);
        expect(fields).toMatchObject({ car_number: '00가1001', provider_company_code: source, maker: '', model: '', vehicle_review_required: true,
            price: { '12': { rent: 100, deposit: 0 } }, source_tab: 'test', source_row: 2 });
    });
    it('updates conditions, preserves unrelated raw, then is idempotent', async () => {
        const { commands, fake } = await setup([product()]);
        const next = product();
        next.record.terms[0].monthlyRent = { state: 'KNOWN', value: 200 };
        expect((await apply(commands, await prepare(commands, [next.record]))).status).toBe('APPLIED');
        expect(decodeFields(fake.docs.get('00가1001').fields).unrelated).toEqual({ preserve: true });
        expect((await prepare(commands, [next.record])).plan.entries).toHaveLength(0);
        expect(fake.calls.find(c => c.method === 'PATCH').url.searchParams.has('currentDocument.updateTime')).toBe(true);
    });
    it('withdraws with prior, then reexposes', async () => {
        const { commands, fake } = await setup([product()]);
        expect((await apply(commands, await prepare(commands, []))).status).toBe('APPLIED');
        expect(decodeFields(fake.docs.get('00가1001').fields)).toMatchObject({ listable: false, status: '출고불가', status_kind: '불가',
            publication_withdrawal: { reason: 'SOURCE_ABSENT', deleteAuthorized: false }, publication_withdrawal_prior: { listable: true } });
        const built = await prepare(commands);
        expect(built.plan.entries[0].kind).toBe('REEXPOSE');
        expect((await apply(commands, built)).status).toBe('APPLIED');
    });
    it('backs up complete native documents and verifies immutable readback', async () => {
        const { commands, fake, dir } = await setup([product()]);
        const before = (await commands.list(source)).products[0];
        await commands.backup('key', before);
        expect(await commands.readBackup('key')).toEqual(before);
        const backup = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]), 'utf8'));
        expect(backup.document).toEqual(fake.docs.get('00가1001'));
        await expect(commands.backup('key', null)).rejects.toThrow('BACKUP_IMMUTABLE');
    });
    it('blocks backup tampering', async () => {
        const { commands, dir } = await setup([product()]);
        const before = (await commands.list(source)).products[0];
        await commands.backup('key', before);
        const file = join(dir, (await readdir(dir))[0]);
        const b = JSON.parse(await readFile(file, 'utf8'));
        b.before.listable = false;
        await writeFile(file, JSON.stringify(b));
        await expect(commands.readBackup('key')).rejects.toThrow('BACKUP_MISMATCH');
    });
    it('stops on conditional-write conflict without retry', async () => {
        const { commands, fake } = await setup();
        fake.setConflict();
        expect((await apply(commands, await prepare(commands))).status).toBe('APPLY_UNCERTAIN');
        expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
    });
    it('stops on changed readback', async () => {
        const { commands, fake } = await setup();
        fake.setCorrupt();
        expect((await apply(commands, await prepare(commands))).status).toBe('APPLY_UNCERTAIN');
    });
    it('contract-locked products never enter a plan', async () => {
        const { commands, fake } = await setup([product()]);
        fake.docs.get('00가1001').fields.locked_by_contract = { booleanValue: true };
        const built = await prepare(commands, []);
        expect(built.plan.entries).toHaveLength(0);
        expect((await apply(commands, built)).writes).toBe(0);
    });
    it('a lock arriving after backup blocks PATCH', async () => {
        const { commands, fake } = await setup([product()]);
        const before = (await commands.list(source)).products[0];
        await commands.backup('key', before);
        fake.docs.get('00가1001').fields.locked_by_contract = { booleanValue: true };
        await expect(commands.compareAndApply(stableDigest(before), product(), 'key')).rejects.toThrow('CAS_CONFLICT');
        expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
    });
    it('same document ID owned by another supplier is held in the plan (PLATE_OWNED_BY_OTHER_SUPPLIER), never a CAS conflict that halts the cycle', async () => {
        const other = product();
        other.record.sourceId = 'OTHER';
        const { commands, fake } = await setup([other]);
        const built = await prepare(commands, [product().record, product('00가1002').record]);
        expect(built.plan.entries.map(e => [e.kind, e.after.record.uid])).toEqual([['ENROLL', '00가1002']]); // 나머지 차는 진행
        expect(built.heldReasons).toEqual({ PLATE_OWNED_BY_OTHER_SUPPLIER: 1 });
        expect(built.plan.warnings).toContain('PLATE_OWNED_BY_OTHER_SUPPLIER');
        expect((await apply(commands, built)).status).toBe('APPLIED');
        expect(fake.calls.filter(c => c.method === 'PATCH').map(c => decodeURIComponent(c.url.pathname.split('/').at(-1)))).toEqual(['00가1002']);
        // REST 가드는 그대로: 계획을 우회해 쓰려 해도 남의 문서에는 쓰지 못한다.
        expect(fake.docs.get('00가1001').fields.provider_company_code).toEqual({ stringValue: 'OTHER' });
    });
    it('REST guard rejects observation-only writes', async () => {
        const { commands } = await setup();
        const p = product();
        p.record.sourceId = 'OBSERVE';
        await expect(commands.compareAndApply(stableDigest(null), p, 'key')).rejects.toThrow('OBSERVATION_ONLY');
    });
    it('rollback restores exact pre-write fields with external approval', async () => {
        const { commands, fake, dir } = await setup([product()]);
        const original = structuredClone(fake.docs.get('00가1001').fields);
        await apply(commands, await prepare(commands, []));
        const b = JSON.parse(await readFile(join(dir, (await readdir(dir)).find(f => f.endsWith('.backup.json'))), 'utf8'));
        await expect(commands.rollback(b.key, 'bad')).rejects.toThrow('ROLLBACK_APPROVAL_REQUIRED');
        expect(await commands.rollback(b.key, await commands.rollbackDigest(b.key))).toEqual({ status: 'ROLLED_BACK' });
        expect(fake.docs.get('00가1001').fields).toEqual(original);
    });
    it('rollback enrollment withdraws instead of deleting', async () => {
        const { commands, fake, dir } = await setup();
        await apply(commands, await prepare(commands));
        const b = JSON.parse(await readFile(join(dir, (await readdir(dir)).find(f => f.endsWith('.backup.json'))), 'utf8'));
        await commands.rollback(b.key, await commands.rollbackDigest(b.key));
        expect(fake.docs.size).toBe(1);
        expect(decodeFields(fake.docs.get('00가1001').fields).listable).toBe(false);
        expect(fake.calls.some(c => c.method === 'DELETE')).toBe(false);
    });
    it('rollback refuses changes after the verified receipt', async () => {
        const { commands, fake, dir } = await setup();
        await apply(commands, await prepare(commands));
        const b = JSON.parse(await readFile(join(dir, (await readdir(dir)).find(f => f.endsWith('.backup.json'))), 'utf8'));
        fake.docs.get('00가1001').fields.locked_by_contract = { booleanValue: true };
        await expect(commands.rollback(b.key, await commands.rollbackDigest(b.key))).rejects.toThrow('CAS_CONFLICT');
    });
    it('source_cycle_record cannot mask an external price change', async () => {
        const { commands, fake } = await setup([product()]);
        fake.docs.get('00가1001').fields.price = encodeFields({ price: {} }).price;
        // 목록은 가격 불일치 문서의 uid 만 표시하고, 계획이 그 문서를 쓰게 되면 막는다. 번호판 불일치·쓰기 단계(read)는 계속 DRIFT 로 던진다.
        const snap = await commands.list(source);
        expect(snap.driftHeld).toEqual(['00가1001']);
        const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records: [product().record], observedAt: time, heldCount: 0, complete: true }, snap, now);
        expect(built.plan.blockers).toContain('CATALOG_SOURCE_RECORD_DRIFT');
        await expect(commands.read(source, '00가1001')).rejects.toThrow('CATALOG_SOURCE_RECORD_DRIFT');
    });
    it('a stored full-raw record is compared in compact form, so compaction itself never causes a mass update', async () => {
        const stored = product();
        stored.record.raw = { ...stored.record.raw, rates: Array.from({ length: 5 }, () => ({ text: 'x'.repeat(5000) })) };
        const { commands } = await setup([stored]);
        const same = product();
        same.record.raw = structuredClone(stored.record.raw);
        expect((await prepare(commands, [same.record])).plan.entries).toEqual([]);
    });
    it('writes a compact record: large raw values become digests in the stored document', async () => {
        const { commands, fake } = await setup();
        const fat = product().record;
        fat.raw = { ...fat.raw, rates: Array.from({ length: 30 }, () => ({ text: 'x'.repeat(20_000) })) };
        expect((await apply(commands, await prepare(commands, [fat]))).status).toBe('APPLIED');
        const body = JSON.stringify(fake.docs.get('00가1001'));
        expect(body.length).toBeLessThan(20_000);
        expect(decodeFields(fake.docs.get('00가1001').fields)).not.toHaveProperty('source_cycle_raw');
        expect(decodeFields(fake.docs.get('00가1001').fields).source_cycle_record.raw.rates).toHaveProperty('__digest');
    });
    it('an oversize write blocks the whole plan before any backup or write (DOC_TOO_LARGE)', async () => {
        const { commands, fake, dir } = await setup([product('A1'), product('A2')]);
        const small = product('A1').record;
        small.terms[0].monthlyRent = { state: 'KNOWN', value: 111 };
        const huge = product('A2').record;
        huge.terms[0].monthlyRent = { state: 'KNOWN', value: 222 };
        // 문서에 이미 큰 비원천 필드가 붙어 있어 갱신 뒤 크기가 한도를 넘는 경우(사진 목록·정책 본문 등)
        fake.docs.get('A2').fields.attachment = encodeFields({ attachment: 'y'.repeat(950_000) }).attachment;
        const built = await prepare(commands, [small, huge]);
        await expect(apply(commands, built)).rejects.toThrow('DOC_TOO_LARGE');
        expect(fake.calls.some(c => c.method === 'PATCH')).toBe(false);
        expect(await readdir(dir)).toEqual([]); // 백업도 시작하지 않음
    });
    it('--accept-drift 는 지정 코드의 가격 보정만 받아들이고 번호판 변경과 다른 코드는 계속 DRIFT', async () => {
        const { fake, dir } = await setup([product()]);
        const mk = (acceptDrift) => firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' },
            token: async () => 'synthetic-token', fetcher: fake.fetcher, acceptDrift });
        const price = decodeFields(fake.docs.get('00가1001').fields).price;
        const corrected = Object.fromEntries(Object.entries(price).map(([m, v]) => [m, { ...v, deposit: 777000 }]));
        fake.docs.get('00가1001').fields.price = encodeFields({ price: corrected }).price;
        expect((await mk([]).list(source)).driftHeld).toEqual(['00가1001']);
        expect((await mk(['OTHER_CODE']).list(source)).driftHeld).toEqual(['00가1001']);
        const snap = await mk([source]).list(source);
        expect(snap.acceptedDrift).toEqual(['00가1001']);
        expect(snap.products[0].record.terms.every(t => t.deposit.value === 777000)).toBe(true);
        const built = planSourceCycle({ sourceId: source, family: 'OTHER', maxDowngradeRatio: 1 }, { records: [product().record], observedAt: time, heldCount: 0, complete: true }, snap, now);
        expect(built.plan.warnings.some(w => w.startsWith('DRIFT_ACCEPTED:1:'))).toBe(true);
        fake.docs.get('00가1001').fields.car_number = encodeFields({ car_number: '다른번호' }).car_number;
        await expect(mk([source]).list(source)).rejects.toThrow('CATALOG_SOURCE_RECORD_DRIFT');
    });
    it('list uses only required fields, while backup reads full document', async () => {
        const { commands, fake } = await setup([product()]);
        const before = (await commands.list(source)).products[0];
        await commands.backup('projection', before);
        expect(fake.calls[0].url.searchParams.getAll('mask.fieldPaths')).toContain('locked_by_contract');
        expect(fake.calls[1].url.searchParams.has('mask.fieldPaths')).toBe(false);
    });
    it('a changed version between list and backup aborts before write', async () => {
        const { commands, fake } = await setup([product()]);
        const before = (await commands.list(source)).products[0];
        fake.docs.get('00가1001').updateTime = 'changed';
        await expect(commands.backup('changed', before)).rejects.toThrow('BACKUP_SNAPSHOT_MISSING');
    });
    it.each([403, 429, 503])('HTTP %s is not an empty complete catalog', async (status) => {
        const commands = firestoreCycleCommands({ directory: await directory(), env: { FIREBASE_PROJECT_ID: 'synthetic-test' },
            token: async () => 'fake', fetcher: (async () => new Response('{}', { status })) });
        await expect(commands.list(source)).rejects.toThrow('FIRESTORE_REQUEST_FAILED');
    });
    it('pagination cycle is rejected rather than counting repeated documents', async () => {
        const fetcher = vi.fn(async () => Response.json({ documents: [], nextPageToken: 'repeat' }));
        const commands = firestoreCycleCommands({ directory: await directory(), env: { FIREBASE_PROJECT_ID: 'synthetic-test' },
            token: async () => 'fake', fetcher: fetcher });
        await expect(commands.list(source)).rejects.toThrow('CATALOG_PAGINATION_LOOP');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('withdrawal preserves legacy price aliases and unknown conditions', async () => {
        const { commands, fake } = await setup();
        const fields = { provider_company_code: source, car_number: '00가1001', status: '출고가능', listable: true,
            price: { '12': { rent: 100, deposit: null }, '12_extra': { rent: 200, deposit: 100 } } };
        fake.docs.set('00가1001', { name: 'projects/synthetic-test/databases/(default)/documents/products/00가1001', updateTime: time, fields: encodeFields(fields) });
        expect((await apply(commands, await prepare(commands, []))).status).toBe('APPLIED');
        expect(decodeFields(fake.docs.get('00가1001').fields).price).toEqual(fields.price);
    });
});
function sheet(rows) {
    const channel = sharedSheetChannels[0], headers = [...sharedSheetHeaders, 'UID'];
    const capture = { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-only', layoutVersion: '2026-10-04-no-account',
        readTime: time, revision: 'synthetic', tabs: [...new Set(sharedSheetChannels.map(c => c.tab))].map(title => {
            const values = [headers, ...(title === channel.tab ? rows.map(row => headers.map(h => ({ 회사명: channel.companyName,
                    차량번호: '00가1001', 차량상태: '출고가능', 상품구분: '중고렌트', '12개월': 500000, 단기보증: '무보증', 장기보증: '무보증',
                    연주행: '20000km', '차명 원문': '합성', ...row }[h] ?? ''))) : [])];
            return { title, readTime: time, complete: true, rowCount: values.length, values };
        }) };
    const visibility = { sheets: capture.tabs.map(t => ({ properties: { title: t.title, gridProperties: { rowCount: t.rowCount } },
            data: [{ startRow: 0, rowMetadata: t.values.map(() => ({})) }] })) };
    return { capture, visibility, source: channel.code };
}
describe('existing unattended F05 producer source-head stage', () => {
    const env = { SOURCE_CYCLE_UNATTENDED: '1', SOURCE_CYCLE_F05_SOURCE_ROWS: '1', SOURCE_CYCLE_SOURCES: 'F05', SOURCE_CYCLE_F05_SHEET_ID: 'synthetic-only' };
    const memoryControl = () => { let state = emptyCycleState(); return { load: async () => structuredClone(state), save: async (_key, next) => { state = structuredClone(next); } }; };
    it('stays off by default and refuses partial or mixed-source producers before acquiring the lease', async () => {
        const acquire = vi.fn();
        expect(await refreshF05SourceObservations({}, undefined, { acquire })).toBeNull();
        await expect(refreshF05SourceObservations({ ...env, SOURCE_CYCLE_SOURCES: 'F05,IRON' }, undefined, { acquire })).rejects.toThrow('EXCLUSIVE_FULL_PRODUCER');
        await expect(refreshF05SourceObservations(env, 'RP013', { acquire })).rejects.toThrow('EXCLUSIVE_FULL_PRODUCER');
        await expect(refreshF05SourceObservations({ ...env, SOURCE_CYCLE_UNATTENDED: '0' }, undefined, { acquire })).rejects.toThrow('EXCLUSIVE_FULL_PRODUCER');
        expect(acquire).not.toHaveBeenCalled();
    });
    it('calls the existing intake from the producer lease and keeps missing-master names held', async () => {
        const previous = process.env.FREEPASS_SHEET_F04_ID;
        process.env.FREEPASS_SHEET_F04_ID = 'test-sheet-f04';
        try {
            const store = new MemorySourceStore(), release = vi.fn(async () => { }), acquire = vi.fn(async () => release);
            let captures = 0;
            const capture = vi.fn(async () => { const c = sheet([{ 차량번호: '신차' }]).capture; c.readTime = new Date(Date.now() - 1000 + (++captures) * 100).toISOString(); for (const t of c.tabs) {
                t.readTime = c.readTime;
                t.values = t.values.map(r => r.slice(0, 74));
            } return c; });
            const persist = vi.fn(input => ingestSharedSheetObservedRows(store, { target: 'memory', ...input }));
            const control = memoryControl();
            const result = await refreshF05SourceObservations(env, undefined, { acquire, observedCapture: capture, control, capture, persist, master: async () => { throw Error('MASTER_UNAVAILABLE'); } });
            expect(acquire).toHaveBeenCalledWith('F05_SOURCE_ROWS');
            expect(capture).toHaveBeenCalledTimes(2);
            expect(persist).toHaveBeenCalledOnce();
            expect(release).toHaveBeenCalledOnce();
            expect(result).toMatchObject({ status: 'SOURCE_HEAD_VERIFIED', rawRows: 1, candidateRows: 1, heldCandidateRows: 1, canonicalWrites: 0 });
            expect((await store.getSourceHead(result.sourceId)).runId).toBe(result.runId);
            expect(await control.load()).toMatchObject({ stopped: false, error: null, readCount: 1 });
        }
        finally {
            if (previous === undefined)
                delete process.env.FREEPASS_SHEET_F04_ID;
            else
                process.env.FREEPASS_SHEET_F04_ID = previous;
        }
    });
    it('does not persist on capture failure and always releases its existing producer lease', async () => {
        const release = vi.fn(async () => { }), persist = vi.fn(), capture = vi.fn(async () => { throw Error('READ_FAILED'); });
        await expect(refreshF05SourceObservations(env, undefined, { acquire: async () => release, observedCapture: capture, control: memoryControl(), capture, persist })).rejects.toThrow('READ_FAILED');
        expect(release).toHaveBeenCalledOnce();
        expect(persist).not.toHaveBeenCalled();
        capture.mockClear();
        await expect(refreshF05SourceObservations(env, undefined, { acquire: async () => null, observedCapture: capture, control: memoryControl(), capture, persist })).rejects.toThrow('F05_SOURCE_ROWS_LOCKED');
        expect(capture).not.toHaveBeenCalled();
    });
    it('journals uncertainty before durable effects and blocks the next unattended retry', async () => {
        const control = memoryControl(), release = vi.fn(async () => { }), capture = async () => sheet([{}]).capture;
        const persist = vi.fn(async ({ claimEffect }) => { await claimEffect({ sourceId: 'synthetic', runId: 'intent-run', sourceDigest: 'synthetic-digest', observedAt: time }); throw Error('SHARED_SOURCE_READBACK_MISMATCH'); });
        const ports = { control, acquire: async () => release, observedCapture: capture, capture, master: async () => undefined, persist };
        await expect(refreshF05SourceObservations(env, undefined, ports)).rejects.toThrow('READBACK_MISMATCH');
        expect(await control.load()).toMatchObject({ stopped: true, error: 'APPLY_UNCERTAIN', sourceObservationIntent: { runId: 'intent-run' } });
        await expect(refreshF05SourceObservations(env, undefined, ports)).rejects.toThrow('UNCERTAIN_REQUIRES_READBACK');
        expect(persist).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledTimes(2);
    });
    it('keeps legacy product writes running while an uncertain source head stays non-green', async () => {
        const { commands, fake, dir } = await setup();
        const control = fileCycleControl(dir, async (source, state) => { await appendFile(join(dir, 'heartbeats.jsonl'), JSON.stringify({ source, ...state }) + '\n'); });
        await control.save('F05_SOURCE_ROWS', { ...emptyCycleState(), stopped: true, error: 'APPLY_UNCERTAIN' });
        const at = new Date().toISOString(), record = { ...product().record, observedAt: at };
        const plugin = sourceCyclePlugin({ sourceId: source, kind: 'IRON', scopes: ['inventory'], maxDowngradeRatio: 1 }, async () => ({ observedAt: at, complete: true, completedScopes: ['inventory'], visibilityComplete: true, heldCount: 0, rows: [{ scope: 'inventory', record }] }));
        const result = await runUnattended([], { ...env, SHEETS_TRANSPORT: 'adc', SOURCE_CYCLE_PRIVATE_DIR: dir }, [], { gwsBin: () => null, gcloudToken: async () => 'synthetic' }, () => ({ plugins: [plugin], commands, control, directory: dir, identityStatus: () => 'DISABLED', f05ObservedCapture: async () => { throw Error('MUST_NOT_RETRY_UNKNOWN_HEAD'); } }));
        expect(result.sourceObservations).toMatchObject({ status: 'APPLY_UNCERTAIN', reasonCode: 'F05_SOURCE_ROWS_UNCERTAIN_REQUIRES_READBACK' });
        expect(result.reports[0].status).toBe('APPLIED');
        expect(fake.calls.some(c => c.method === 'PATCH')).toBe(true);
        expect(result.exit).toBe(1);
        expect((await control.load('F05_SOURCE_ROWS')).error).toBe('APPLY_UNCERTAIN');
    });
});
describe('native mappings and UID', () => {
    it('uses the existing structured normalizer for a known source year when raw-name matching remains unresolved', () => {
        const s = sheet([{ 제조사: '합성', 모델: '합성모델', 세부모델: '합성세대', 세부트림: '합성트림',
                연식: 2023, 연료: '', 배기량: '', 인승: '', 구동방식: '', 최초등록일: '', '차명 원문': '원문 그대로' }]);
        const match = vi.fn(() => null);
        const sourceYearEvidence = { snapshotDigest: 'verified-snapshot', readAt: s.capture.readTime,
            records: [{ masterId: 'synthetic-master', trimId: 'synthetic-trim', names: ['합성', '합성모델', '합성세대', '합성트림'],
                    aliases: [[], [], [], []], modelYearStart: 2020, modelYearEnd: 2024 }] };
        const master = { digest: 'synthetic-master-digest', match, sourceYearEvidence, allowsYear: (id, year) => id === 'synthetic-master' && year === 2023 };
        const r = f05NativeCapture(s.source, s.capture, s.visibility, master).rows[0].record;
        expect(r.raw.spec).toEqual({ year: '2023' });
        expect(r.raw.spec_master_digest).toBe('verified-snapshot');
        expect(r.vehicleHold).toEqual(['VEHICLE_MASTER_REVIEW_REQUIRED']);
        expect(match).not.toHaveBeenCalled();
        // 2026-10-25: 검토 UID 목록 밖이어도 원천 연식은 옮기고(쓰기 경로는 빈 칸만), 마스터 근거는 목록 안 차에만 붙는다.
        for (const uids of [new Set(), new Set(['OTHER'])]) {
            const outside = f05NativeCapture(s.source, s.capture, s.visibility, { ...master, sourceYearUids: uids }).rows[0].record.raw;
            expect(outside.spec).toEqual({ year: '2023' });
            expect(outside).not.toHaveProperty('spec_master_digest');
        }
        expect(f05NativeCapture(s.source, s.capture, s.visibility, { ...master, sourceYearUids: new Set([r.uid]) }).rows[0].record.raw.spec).toEqual({ year: '2023' });
        const bad = sheet([{ 제조사: '합성', 모델: '합성모델', 세부모델: '다른세대', 세부트림: '확인필요', 연식: 2023 }]);
        // 2026-10-25 대표 «원천 값은 반드시 옮긴다»: 차종이 마스터와 안 맞아도 원천 연식은 옮기고, 마스터 근거만 붙이지 않는다.
        const badRaw = f05NativeCapture(bad.source, bad.capture, bad.visibility, master).rows[0].record.raw;
        expect(badRaw.spec).toEqual({ year: '2023' });
        expect(badRaw).not.toHaveProperty('spec_master_digest');
    });
    it('F05 preserves an explicitly supplied master-admitted year through the existing spec writer without changing RAW or identity HOLD', () => {
        const s = sheet([{ 연식: 2023, '차명 원문': '합성 원문 차종', 최초등록일: 'https://example.invalid/not-a-date' }]);
        const before = structuredClone(s.capture);
        const match = vi.fn(({ year }) => year === '2023'
            ? { maker: '합성', model: '합성', sub_model: '합성 A', trim_name: null, master_id: 'synthetic-master' } : null);
        expect(f05NativeCapture(s.source, s.capture, s.visibility).rows[0].record.raw).not.toHaveProperty('spec');
        const r = f05NativeCapture(s.source, s.capture, s.visibility, { digest: 'synthetic-master-digest', match,
            allowsYear: (id, year) => id === 'synthetic-master' && year === 2023 }).rows[0].record;
        expect(match).toHaveBeenCalledWith({ rawName: '합성 원문 차종', year: '2023' });
        expect(r.raw.spec).toEqual({ year: '2023' });
        expect(r.raw.spec_master_digest).toBe('synthetic-master-digest');
        expect(r.vehicleHold).toContain('VEHICLE_MASTER_REVIEW_REQUIRED');
        expect(s.capture).toEqual(before);
        const p = { record: r, listable: true, locked_by_contract: false,
            publication_withdrawal: null, publication_withdrawal_prior: null, fillSourceIdentity: true };
        const original = { car_number: r.plate, year: '', vehicle_spec_source_checked: true };
        const fields = nativeCycleFields(p, original, { specFillSources: new Set([s.source]) });
        expect(fields.year).toBe('2023');
        expect(fields.source_cycle_record.raw.spec).toEqual({ year: '2023' });
        expect(nativeCycleFields(p, { ...original, year: '2024' }, { specFillSources: new Set([s.source]) })).not.toHaveProperty('year');
        expect(nativeCycleFields(p, original)).not.toHaveProperty('year');
    });
    it('F05 leaves missing, malformed and registration-conflicting years in RAW; a master-conflicting year moves without master evidence (2026-10-25)', () => {
        const match = vi.fn(() => ({ maker: '합성', model: '합성', sub_model: '합성 A', trim_name: null, master_id: 'synthetic-master' }));
        const conflicting = sheet([{ 연식: 2000 }]);
        const moved = f05NativeCapture(conflicting.source, conflicting.capture, conflicting.visibility, { digest: 'synthetic-master-digest', match,
            allowsYear: (_id, year) => year === 2023 }).rows[0].record.raw;
        expect(moved.spec).toEqual({ year: '2000' });
        expect(moved).not.toHaveProperty('spec_master_id');
        match.mockClear();
        for (const row of [{ 연식: '' }, { 연식: '2023unknown' }, { 연식: 2023, 최초등록일: '2025-01' }]) {
            const s = sheet([row]);
            const r = f05NativeCapture(s.source, s.capture, s.visibility, { digest: 'synthetic-master-digest', match,
                allowsYear: (_id, year) => year === 2023 }).rows[0].record;
            expect(r.raw).not.toHaveProperty('spec');
            expect(r.raw.cells).toEqual(s.capture.tabs.find(t => t.rowCount > 1).values[1]);
        }
        expect(match.mock.calls).toEqual([]);
    });
    it('keeps an exclusive registered supplier row when its company cell is blank, preserving RAW and identity HOLD', () => {
        const s = sheet([{ 회사명: '' }]);
        expect(sharedSheetChannels.filter(c => c.tab === s.capture.tabs.find(t => t.rowCount > 1).title)).toHaveLength(1);
        const c = f05NativeCapture(s.source, s.capture, s.visibility);
        expect(c.rows).toHaveLength(1);
        expect(c.rows[0].record.sourceId).toBe(s.source);
        expect(c.rows[0].record.raw.cells[0]).toBe('');
        expect(c.rows[0].record.vehicleHold).toContain('VEHICLE_MASTER_REVIEW_REQUIRED');
        expect(c.heldReasons).not.toContain('COMPANY_UNMAPPED');
        expect(c.rows[0].record.terms[0].monthlyRent.value).toBe(500000);
        for (const tab of ['스타', '빌린카', '경진'])
            expect(sharedSheetChannelOf(tab, '')).toBeUndefined();
        expect(sharedSheetChannelOf('웰릭스', 'unregistered-company')).toBeUndefined();
        expect(sharedSheetChannelOf('unregistered-tab', '')).toBeUndefined();
    });
    it('plate wins, placeholder needs explicit UID, never row fallback', () => {
        expect(sourceUid(' TEST 1001 ', 'sheet')).toBe('TEST1001');
        expect(sourceUid('신차', 'new-one')).toBe('new-one');
        expect(sourceUid('미정')).toBeNull();
    });
    it('F05 takes first duplicate and separately holds unassigned rows', () => {
        const s = sheet([{}, {}, { 차량번호: '신차' }, { 차량번호: '신차', UID: 'NEW-A' }]);
        const c = f05NativeCapture(s.source, s.capture, s.visibility);
        // 번호도 UID 도 없는 «신차» 행은 이제 행 지문 키(FP-…)로 편입된다(대표 «번호 없는 것도 같이 만들어 놔라»)
        const uids = c.rows.map(r => r.record.uid);
        expect(uids).toHaveLength(3);
        expect(uids[0]).toBe('00가1001');
        expect(uids[1]).toMatch(/^FP-/);
        expect(uids[2]).toBe('NEW-A');
        expect(c.heldReasons).not.toContain('UID_REQUIRED');
        expect(c.heldReasons).toContain('DUPLICATE_UID_SUSPECT');
        expect(c.rows[0].record.terms[0].deposit).toEqual({ state: 'ZERO', value: 0 });
        expect(c.rows[0].record.raw.source_row).toBe(2);
    });
    it('F05 rows without plate or UID get a stable fingerprint key: a price-only change keeps the same document, identical twins get ordinals, a plate later fills the same document', () => {
        const base = { 차량번호: '신차', 모델: '아반떼', 세부트림: '프리미엄', '차명 원문': '아반떼 프리미엄' };
        const key = (rows) => { const s = sheet(rows); return f05NativeCapture(s.source, s.capture, s.visibility).rows.map(r => r.record.uid); };
        const first = key([{ ...base, '12개월': 500000 }]);
        expect(first).toHaveLength(1);
        expect(first[0]).toMatch(/^FP-/);
        expect(key([{ ...base, '12개월': 520000 }])).toEqual(first); // 요금만 바뀐 같은 행 = 같은 문서
        expect(key([{ ...base, 차량상태: '출고불가' }])).toEqual(first); // 상태만 바뀌어도 같은 문서
        const twins = key([{ ...base }, { ...base }]);
        expect(twins).toHaveLength(2);
        expect(new Set(twins).size).toBe(2); // 같은 설명의 두 행은 순번으로 구분(둘 다 편입)
        expect(key([{ ...base, 모델: '쏘나타' }])).not.toEqual(first); // 차량 설명이 다르면 다른 문서
        // 번호가 생기면: 같은 지문의 번호 없는 문서에 번호를 채운다(새 문서를 만들지 않음)
        const s = sheet([{ ...base, 차량번호: '00가7777' }]);
        const withPlate = f05NativeCapture(s.source, s.capture, s.visibility);
        expect(withPlate.rows[0].record.uid).toBe('00가7777');
        const stored = f05NativeCapture(sheet([{ ...base }]).source, sheet([{ ...base }]).capture, sheet([{ ...base }]).visibility).rows[0].record;
        const doc = { ...product(stored.uid), record: structuredClone(stored) };
        doc.record.sourceId = s.source;
        const plan = planSourceCycle({ sourceId: s.source, family: 'SHARED_SHEET', maxDowngradeRatio: 1 }, { records: withPlate.rows.map(r => r.record), complete: true, observedAt: withPlate.observedAt, heldCount: 0 }, { complete: true, products: [doc] }, now).plan;
        expect(plan.entries.map(e => [e.kind, e.after.record.uid, e.after.record.plate])).toEqual([['UPDATE', stored.uid, '00가7777']]);
        expect(plan.entries.some(e => e.kind === 'ENROLL')).toBe(false); // 새 문서 없음
    });
    it('F05 rows sharing a plate with different content are all held, never decided by row order; identical copies keep the first', () => {
        const s = sheet([{ 차량번호: '00가1001', 차량상태: '출고가능' }, { 차량번호: '00가1001', 차량상태: '출고불가' }, { 차량번호: '00가1002' }, { 차량번호: '00가1002' }]);
        const c = f05NativeCapture(s.source, s.capture, s.visibility);
        expect(c.rows.map(r => r.record.uid)).toEqual(['00가1002']); // 1001 은 상반된 두 행이라 모두 보류, 1002 는 동일 복사본이라 첫 행
        expect(c.heldReasons?.filter(r => r === 'DUPLICATE_UID_CONFLICT')).toHaveLength(2);
        expect(c.heldReasons).toContain('DUPLICATE_UID_SUSPECT');
        const swapped = sheet([{ 차량번호: '00가1001', 차량상태: '출고불가' }, { 차량번호: '00가1001', 차량상태: '출고가능' }, { 차량번호: '00가1002' }, { 차량번호: '00가1002' }]);
        expect(f05NativeCapture(swapped.source, swapped.capture, swapped.visibility).rows.map(r => r.record.uid)).toEqual(['00가1002']);
    });
    it('F05 identical copies that differ only in spacing or number formatting are not a conflict', () => {
        const s = sheet([{ 차량번호: '00가1001', '12개월': 100 }, { 차량번호: '00가1001', '12개월': '100 ', '차명 원문': ' 합성 ' }, { 차량번호: '00가1001', '12개월': ' 100', '차명 원문': '합성' }]);
        const c = f05NativeCapture(s.source, s.capture, s.visibility);
        expect(c.heldReasons).not.toContain('DUPLICATE_UID_CONFLICT');
    });
    it('F05 identical duplicates differing only in inner spacing give the same output whatever the row order', () => {
        const a = { 차량번호: '00가1001', 연주행: '20000 km' }, b = { 차량번호: '00가1001', 연주행: '20000  km' };
        const first = f05NativeCapture(sheet([a, b]).source, sheet([a, b]).capture, sheet([a, b]).visibility);
        const second = f05NativeCapture(sheet([b, a]).source, sheet([b, a]).capture, sheet([b, a]).visibility);
        expect(first.rows.map(r => r.record.terms.map(t => t.mileage))).toEqual(second.rows.map(r => r.record.terms.map(t => t.mileage)));
        expect(first.heldReasons).toContain('DUPLICATE_UID_SUSPECT');
    });
    it('F05 duplicate comparison does not equate full-width digits with ASCII (the real amount parser rejects them)', () => {
        const s = sheet([{ 차량번호: '00가1001', '12개월': '100' }, { 차량번호: '00가1001', '12개월': '１００' }]);
        const c = f05NativeCapture(s.source, s.capture, s.visibility);
        expect(c.heldReasons?.filter(r => r === 'DUPLICATE_UID_CONFLICT')).toHaveLength(2);
        expect(c.rows).toEqual([]);
    });
    it('F05 holds (never drops as absent) hiddenByUser rows', () => {
        const s = sheet([{}, { 차량번호: '00가1002' }]);
        s.visibility.sheets.find(t => t.properties.title === s.capture.tabs.find(t => t.rowCount > 1).title).data[0].rowMetadata[1].hiddenByUser = true;
        const c = f05NativeCapture(s.source, s.capture, s.visibility);
        expect(c.rows.map(r => r.record.uid)).toEqual(['00가1002']);
        expect(c.heldReasons).toEqual(['ROW_HIDDEN_BY_USER']);
        const p = product('00가1001');
        p.record.sourceId = s.source;
        const plan = planSourceCycle({ sourceId: s.source, family: 'SHARED_SHEET', maxDowngradeRatio: 1 }, { records: c.rows.map(r => r.record), complete: c.complete, observedAt: c.observedAt, heldCount: c.heldCount }, { complete: true, products: [p] }, now).plan;
        expect(plan.entries.filter(e => e.kind === 'DOWNGRADE')).toEqual([]); // 숨긴 행의 문서를 «부재» 로 내리지 않는다
    });
    it('F05 reads hiddenByFilter rows as data: a basic filter is a shared view state, not absence', () => {
        const s = sheet([{}, { 차량번호: '00가1002' }]);
        s.visibility.sheets.find(t => t.properties.title === s.capture.tabs.find(t => t.rowCount > 1).title).data[0].rowMetadata[1].hiddenByFilter = true;
        const c = f05NativeCapture(s.source, s.capture, s.visibility);
        expect(c.rows.map(r => r.record.uid)).toEqual(['00가1001', '00가1002']);
        expect(c.heldReasons).toEqual([]);
        expect(c.rows[0].record.status.raw).toBe('출고가능');
    });
    it('a visible row whose company name maps to no supplier is held, so the same vehicle is never read as absent (경진 → 경진렌트)', () => {
        const s = sheet([{ 차량번호: '00가1001' }, { 회사명: '표기가 바뀐 회사', 차량번호: '00가2002' }]);
        const c = f05NativeCapture(s.source, s.capture, s.visibility);
        expect(c.rows.map(r => r.record.uid)).toEqual(['00가1001']);
        expect(c.heldReasons).toContain('COMPANY_UNMAPPED');
        expect(c.heldCount).toBeGreaterThan(0);
        const p = product('00가2002');
        p.record.sourceId = s.source;
        const built = planSourceCycle({ sourceId: s.source, family: 'SHARED_SHEET', maxDowngradeRatio: 1 }, { records: c.rows.map(r => r.record), complete: c.complete, observedAt: c.observedAt, heldCount: c.heldCount }, { complete: true, products: [p] }, now);
        expect(built.plan.entries.filter(e => e.kind === 'DOWNGRADE')).toHaveLength(0);
        expect(built.plan.warnings).toContain('ABSENCE_DOWNGRADE_SKIPPED');
    });
    it('the approved alias maps «경진렌트» to RP015 on the 경진 tab only; RP016 and other tabs are unchanged (대표 10-13)', () => {
        expect(sharedSheetChannelOf('경진', '경진렌트')?.code).toBe('RP015');
        expect(sharedSheetChannelOf('경진', ' 경진렌트 ')?.code).toBe('RP015');
        expect(sharedSheetChannelOf('경진', '경진')?.code).toBe('RP015');
        expect(sharedSheetChannelOf('경진', '경진카')?.code).toBe('RP016');
        expect(sharedSheetChannelOf('빌린카', '경진렌트')).toBeUndefined(); // 별칭은 탭 단위로만
        expect(sharedSheetChannelOf('경진', '경진렌트카')).toBeUndefined(); // 비슷한 이름은 추론하지 않는다
        const aliased = sharedSheetChannels.filter(c => c.aliases?.length);
        expect(aliased.map(c => `${c.code}:${c.tab}`)).toEqual(['RP015:경진']);
    });
    it('an aliased row is read as the RP015 vehicle, so it is never held as unmapped nor read as absent', () => {
        const ch = sharedSheetChannels.find(c => c.code === 'RP015');
        const headers = [...sharedSheetHeaders, 'UID'];
        const row = headers.map(h => ({ 회사명: '경진렌트', 차량번호: '00가3003', 차량상태: '출고가능', 상품구분: '중고렌트', '12개월': 100,
            단기보증: '무보증', 장기보증: '무보증', 연주행: '20000km', '차명 원문': '합성' }[h] ?? ''));
        const capture = { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-only', layoutVersion: '2026-10-04-no-account',
            readTime: time, revision: 'synthetic', tabs: [...new Set(sharedSheetChannels.map(c => c.tab))].map(title => {
                const values = [headers, ...(title === ch.tab ? [row] : [])];
                return { title, readTime: time, complete: true, rowCount: values.length, values };
            }) };
        const visibility = { sheets: capture.tabs.map(t => ({ properties: { title: t.title, gridProperties: { rowCount: t.rowCount } },
                data: [{ startRow: 0, rowMetadata: t.values.map(() => ({})) }] })) };
        const c = f05NativeCapture('RP015', capture, visibility);
        expect(c.rows.map(r => r.record.uid)).toEqual(['00가3003']);
        expect(c.heldReasons ?? []).not.toContain('COMPANY_UNMAPPED');
        expect(f05NativeCapture('RP016', capture, visibility).rows).toHaveLength(0); // 같은 탭의 경진카는 이 행을 가져가지 않는다
    });
    it('hidden rows of an unmapped company do not hold the source', () => {
        const s = sheet([{ 차량번호: '00가1001' }, { 회사명: '표기가 바뀐 회사', 차량번호: '00가2002' }]);
        s.visibility.sheets.find(t => t.properties.title === s.capture.tabs.find(t => t.rowCount > 1).title).data[0].rowMetadata[2].hiddenByUser = true;
        expect(f05NativeCapture(s.source, s.capture, s.visibility).heldReasons ?? []).not.toContain('COMPANY_UNMAPPED');
    });
    it('missing row metadata makes source incomplete', () => {
        const s = sheet([{}]);
        expect(f05NativeCapture(s.source, s.capture, {}).complete).toBe(false);
    });
    it('hidden tab is excluded and never proves supplier absence', () => {
        const s = sheet([{}]);
        const metadata = s.visibility;
        metadata.sheets.find((t) => t.properties.title === s.capture.tabs.find(t => t.rowCount > 1).title).properties.hidden = true;
        const c = f05NativeCapture(s.source, s.capture, metadata);
        expect(c.rows).toHaveLength(0);
        expect(c.complete).toBe(false);
    });
    it('unassigned UID HOLD prevents absent-product downgrade', () => {
        const s = sheet([{ 차량번호: '신차', '차명 원문': '' }]), c = f05NativeCapture(s.source, s.capture, s.visibility);
        const p = product();
        p.record.sourceId = s.source;
        const built = planSourceCycle({ sourceId: s.source, family: 'SHARED_SHEET', maxDowngradeRatio: 1 }, { records: c.rows.map(r => r.record), complete: c.complete, observedAt: c.observedAt, heldCount: c.heldCount }, { complete: true, products: [p] }, now);
        expect(built.plan.entries).toHaveLength(0);
        expect(built.plan.held).toBeGreaterThan(0);
    });
    const aicaHeaders = ['배차상태', '구분', '차량번호', '차급', '차종분류', '트림', '연료', '외장', '내장', 'Km', '월렌트', '장기보증',
        '36개월', '48개월', '60개월', '옵션', '최초등록', '소비자가격', '제조사', '배기량', '연주행', '대인', '대물', '자차', '자손'];
    const aicaRow = (overrides = {}) => aicaHeaders.map(h => ({
        배차상태: '배차문의', 구분: '재렌트', 차량번호: '00가2001', 차급: '합성급', 차종분류: '합성모델', 트림: '합성트림 2WD A/T',
        연료: '합성연료', 외장: '원문 외장', 내장: '원문 내장', Km: '12,345', 월렌트: '999,999', 장기보증: '무보증',
        '36개월': '123,456', '48개월': '', '60개월': 234567, 옵션: '원문 옵션', 최초등록: '2025-01', 소비자가격: '31,234,567',
        제조사: '합성제조사', 배기량: '1,234', 연주행: '3만km', 대인: '원문 대인', 대물: '원문 대물', 자차: '원문 자차', 자손: '원문 자손',
        ...overrides
    }[h]));
    function aicaFixture(rows = [aicaRow(), aicaRow({ 차량번호: '00가2002', 장기보증: '1,234,000', 배차상태: '배차중' })]) {
        const tables = AICA_SCOPES.map((title, i) => ({ title, values: title === '월렌트' ?
                [['차종', '1개월']] : [aicaHeaders, ...(i === 0 ? rows : [])] }));
        const meta = { sheets: tables.map(t => ({ properties: { title: t.title, hidden: false, gridProperties: { rowCount: t.values.length } },
                data: [{ startRow: 0, rowMetadata: t.values.map(() => ({ hiddenByUser: false, hiddenByFilter: false })) }] })) };
        return { tables, meta };
    }
    async function aicaRead(f = aicaFixture()) {
        const capture = aicaNativeCapture(f.tables, time, f.meta);
        const plugin = aicaNativePlugin(async () => capture, 1), read = await plugin.read();
        return { capture, plugin, read, ...plugin.toRecords(read) };
    }
    it('a tab whose first header cell is blank but whose other headers equal another tab\'s standard headers is read as 배차상태 (ARIKA_HEADER_INFERRED), anything else stays held', async () => {
        // 장기특별이벤트 탭 A1 만 공백, 같은 시트의 «신차선출고» 탭은 표준 머리글 → 추론 허용
        const f = aicaFixture();
        f.tables[0].values[0] = ['', ...aicaHeaders.slice(1)];
        f.tables[1].values = [aicaHeaders];
        const inferred = await aicaRead(f);
        expect(inferred.capture.completedScopes).toContain('장기특별이벤트');
        expect(inferred.capture.notes).toEqual(['ARIKA_HEADER_INFERRED:장기특별이벤트']);
        expect(inferred.records.filter(r => r.status.saleAvailable === true).length).toBeGreaterThan(0);
        // 다른 칸이 하나라도 다르면(예: «차량번호» 가 «번호») 추론하지 않고 기존대로 탭 보류
        const g = aicaFixture();
        g.tables[0].values[0] = ['', ...aicaHeaders.slice(1).map(h => h === '차량번호' ? '번호' : h)];
        g.tables[1].values = [aicaHeaders];
        const held = await aicaRead(g);
        expect(held.capture.completedScopes).not.toContain('장기특별이벤트');
        expect(held.capture.notes).toBeUndefined();
        // 기준이 될 표준 탭이 없으면 추론하지 않는다
        const h = aicaFixture();
        h.tables[0].values[0] = ['', ...aicaHeaders.slice(1)];
        h.tables[1].values = [['', ...aicaHeaders.slice(1)]];
        h.tables[2].values = [['', ...aicaHeaders.slice(1)]];
        expect((await aicaRead(h)).capture.completedScopes).not.toContain('장기특별이벤트');
    });
    it('SPEC3D monthly numeric offers normalize identity, preserve raw and flag duplicates separately', async () => {
        const f = aicaFixture();
        f.tables[3].values = [['차종', '1개월', '비고'], [' Model a ', '345,678', '월렌트 무보증'],
            ['MODEL A', '345,678', '월렌트 무보증'], ['Model B', 500000], ['Unavailable', 'x'], ['Blank', ''], ['Empty', null],
            ['Non numeric', '무보증'], ['Invalid', -1]];
        f.meta.sheets[3].properties.gridProperties.rowCount = f.tables[3].values.length;
        f.meta.sheets[3].data[0].rowMetadata = f.tables[3].values.map(() => ({ hiddenByUser: false, hiddenByFilter: false }));
        const before = structuredClone(f), out = await aicaRead(f);
        expect(out.read.complete).toBe(true);
        expect(f).toEqual(before);
        // 읽을 수 없는 요금(-1)은 조용히 버리지 않고 보류로 센다(비어 있거나 x·무보증 표시는 제안 없음이라 보류가 아님)
        expect(out.held).toEqual([{ row: 0, reasons: ['MONTHLY_RENT_UNPARSEABLE'] }, { row: 0, reasons: ['DUPLICATE_UID_SUSPECT'] }]);
        const monthly = out.records.filter(r => r.raw.product_group === 'MONTHLY_RENT');
        expect(monthly.map(r => r.uid)).toEqual(['RP004:MONTHLY:MODELA', 'RP004:MONTHLY:MODELB']);
        expect(new Set(out.records.map(r => r.uid)).size).toBe(4);
        expect(monthly[0]).toMatchObject({ plate: null, vehicleText: ' Model a ', status: { saleAvailable: true },
            terms: [{ months: 1, monthlyRent: { value: 345678 }, deposit: { state: 'ZERO', value: 0 }, mileage: '월렌트' }] });
        expect(monthly[1].terms[0].deposit).toEqual({ state: 'UNKNOWN', value: null });
        const { commands, fake } = await setup();
        const evidence = { records: out.records, complete: true, observedAt: time, heldCount: out.held.length };
        const built = planSourceCycle(out.plugin, evidence, await commands.list('RP004'), now);
        expect(built.plan.entries).toHaveLength(4);
        expect(await apply(commands, built)).toMatchObject({ status: 'APPLIED', verified: 4 });
        expect(decodeFields(fake.docs.get('RP004:MONTHLY:MODELB').fields)).toMatchObject({
            product_group: 'MONTHLY_RENT', car_number: null, maker: '', model: '', sub_model: expect.any(String), trim_name: '', vehicle_review_required: true, vehicle_title_source: 'RAW_VEHICLE_TEXT',
            price: { '1': { rent: 500000, deposit: null, mileage: '월렌트' } }, provider_name: '아이카'
        });
        // 신규 편입은 공급사 기본값(정책 없음)으로 들어오고, 다음 회차에 공급사 기본 정책 연결 규칙(장기 2건만, 월렌트 모델 줄 제외)이 한 번 연결한다 — 그 뒤 되풀이 없음.
        const linkPlan = planSourceCycle(out.plugin, evidence, await commands.list('RP004'), now);
        expect(linkPlan.plan.entries.map(e => e.before?.rewriteReasons)).toEqual([['POLICY_LINK'], ['POLICY_LINK']]);
        expect(linkPlan.plan.entries.every(e => e.after.record.raw.product_group !== 'MONTHLY_RENT')).toBe(true);
        expect(await apply(commands, linkPlan)).toMatchObject({ status: 'APPLIED', verified: 2 });
        expect(planSourceCycle(out.plugin, evidence, await commands.list('RP004'), now).plan.entries).toEqual([]);
        const ctrl = fileCycleControl(await directory(), async () => { });
        const result = await runSourceCycle(out.plugin, commands, ctrl, { now: () => now });
        expect(result.status).toBe('DRY_RUN');
        expect(result.summary).toContain('장기 2 · 월렌트 2');
        expect(result.summary).toContain('번호미배정 0');
        // Reordering changes row provenance, never the model identity.
        f.tables[3].values = [f.tables[3].values[0], ...f.tables[3].values.slice(1).reverse()];
        expect((await aicaRead(f)).records.filter(r => r.raw.product_group === 'MONTHLY_RENT').map(r => r.uid).sort())
            .toEqual(monthly.map(r => r.uid).sort());
    });
    it('skipMonthly (대표 2026-10-23 아이카 월렌트 제외): 월렌트 상품 0건·장기 상품 그대로·범위는 완료로 센다, 끄면 기존 동작', async () => {
        const f = aicaFixture();
        f.tables[3].values = [['차종', '1개월', '비고'], ['Model A', '345,678', ''], ['Model B', -1]];
        f.meta.sheets[3].properties.gridProperties.rowCount = f.tables[3].values.length;
        f.meta.sheets[3].data[0].rowMetadata = f.tables[3].values.map(() => ({ hiddenByUser: false, hiddenByFilter: false }));
        const on = aicaNativeCapture(f.tables, time, f.meta, { skipMonthly: true });
        const off = aicaNativeCapture(f.tables, time, f.meta);
        const longOnly = (c) => c.rows.filter(r => r.record.raw.product_group !== 'MONTHLY_RENT').map(r => r.record.uid);
        expect(on.rows.filter(r => r.record.raw.product_group === 'MONTHLY_RENT')).toHaveLength(0);
        expect(on.heldCount).toBe(0);
        expect(on.complete).toBe(true);
        expect(off.rows.filter(r => r.record.raw.product_group === 'MONTHLY_RENT')).toHaveLength(1);
        expect(off.heldCount).toBe(1);
        expect(longOnly(on)).toEqual(longOnly(off));
        expect(longOnly(on)).toHaveLength(2);
        // 월렌트 탭이 아예 없어도(읽지 않음) 완전 읽기로 센다 — 탭 이름 변동이 장기 상품 회차를 막지 않는다.
        const none = aicaNativeCapture(f.tables.filter(t => t.title !== '월렌트'), time, f.meta, { skipMonthly: true });
        expect(none.complete).toBe(true);
        expect(none.rows).toHaveLength(2);
    });
    it.each(['', '  ', null, undefined])('SPEC3C creates only the populated 48-month period (blank=%s)', async (blank) => {
        const out = await aicaRead(aicaFixture([aicaRow({ '36개월': blank, '48개월': '456,789', '60개월': blank })]));
        expect(out.records[0].terms.map(t => t.months)).toEqual([48]);
        const built = planSourceCycle(out.plugin, { records: out.records, complete: out.read.complete, observedAt: time, heldCount: 0 }, { complete: true, products: [] }, now);
        expect(built.plan.held).toBe(0);
        expect(built.plan.entries.map(e => e.kind)).toEqual(['ENROLL']);
        expect(built.plan.entries[0].after.listable).toBe(true);
    });
    it('SPEC3C F05 missing tabs and partial row coverage remain incomplete', async () => {
        const s = sheet([{}]);
        const plugin = sourceCyclePlugin({ sourceId: s.source, kind: 'F05',
            scopes: [...new Set(sharedSheetChannels.filter(c => c.code === s.source).map(c => c.tab))], maxDowngradeRatio: 1 }, async () => f05NativeCapture(s.source, s.capture, s.visibility));
        const tab = s.capture.tabs.find(t => t.rowCount > 1);
        Object.assign(tab, { complete: false }); // Deliberately malformed transport fixture.
        expect((await plugin.read()).complete).toBe(false);
        tab.complete = true;
        tab.rowCount++;
        expect((await plugin.read()).complete).toBe(false);
        s.capture.tabs = s.capture.tabs.filter(t => t !== tab);
        expect((await plugin.read()).complete).toBe(false);
    });
    it.each(['AICA', 'F05'])('SPEC3C %s holds one unidentified row without blocking known-row plans', async (kind) => {
        let plugin;
        if (kind === 'AICA') {
            plugin = (await aicaRead(aicaFixture([
                aicaRow(), aicaRow({ 차량번호: '00가2002' }), aicaRow({ 차량번호: '00가2003' }),
                aicaRow({ 차량번호: '00가2004', 배차상태: '출고불가' }), aicaRow({ 차량번호: '' }),
            ]))).plugin;
        }
        else {
            const s = sheet([{}, { 차량번호: '00가2002' }, { 차량번호: '00가2003' },
                { 차량번호: '00가2004', 차량상태: '출고불가' }, { 차량번호: '신차', '차명 원문': '' }]); // 차량을 특정할 이름도 없으면 지문 키를 만들지 않고 보류
            const capture = f05NativeCapture(s.source, s.capture, s.visibility);
            plugin = sourceCyclePlugin({ sourceId: s.source, kind, scopes: capture.completedScopes, maxDowngradeRatio: 1 }, async () => capture);
        }
        const read = await plugin.read(), converted = plugin.toRecords(read);
        expect(read.complete).toBe(true);
        expect(read.error).toBeNull();
        expect(converted.held).toHaveLength(1);
        const old = converted.records.slice(1).map(record => ({ ...product(record.uid), record: structuredClone(record) }));
        old[0].record.vehicleText = 'previous facts';
        old[1].listable = false;
        old[2].record.status = { raw: '출고가능', saleAvailable: true };
        const absent = structuredClone(old[0]);
        absent.record.uid = '00가9999';
        absent.record.plate = '00가9999';
        const snapshot = { complete: true, products: [...old, absent] };
        const noWrite = vi.fn(async () => { throw Error('UNEXPECTED_WRITE'); });
        const commands = { list: async () => snapshot, read: noWrite, backup: noWrite, readBackup: noWrite, compareAndApply: noWrite };
        const ctrl = fileCycleControl(await directory(), async () => { });
        const result = await runSourceCycle(plugin, commands, ctrl, { now: () => now });
        expect(result.status).toBe('DRY_RUN');
        expect(result.summary).toContain('번호미배정 1');
        expect(result.summary).toContain('ABSENCE_DOWNGRADE_SKIPPED');
        const plan = 'plan' in result ? result.plan : null;
        expect(plan).toMatchObject({ blockers: [], warnings: ['ABSENCE_DOWNGRADE_SKIPPED'], unassignedPlateCount: 1,
            held: 1, evidence: { complete: true, unassignedPlateCount: 1 } });
        expect(plan.entries.map(e => e.kind).sort()).toEqual(['DOWNGRADE', 'ENROLL', 'REEXPOSE', 'UPDATE']);
        expect(plan.entries.filter(e => e.after.publication_withdrawal?.reason === 'SOURCE_ABSENT')).toEqual([]);
        expect(plan.entries.find(e => e.kind === 'DOWNGRADE').after.publication_withdrawal?.reason).toBe('SOURCE_NOT_SELLABLE');
        expect(await ctrl.load(plugin.sourceId)).toMatchObject({ failures: 0, error: null, lastCompleteAt: time, unassignedPlateCount: 1 });
        expect(noWrite).not.toHaveBeenCalled();
    });
    it('Aica SPEC3B maps ZERO/KNOWN, populated periods and unchanged RAW', async () => {
        const f = aicaFixture(), before = structuredClone(f), out = await aicaRead(f);
        expect(out.read.complete).toBe(true);
        expect(out.held).toEqual([]);
        expect(out.records).toHaveLength(2);
        expect(out.records[0]).toMatchObject({ uid: '00가2001', vehicleText: '합성모델 합성트림 2WD A/T',
            status: { raw: '배차문의', saleAvailable: true }, vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'],
            raw: { sourceCycleDisplayStatus: '출고협의', original: { 제조사: '합성제조사', 최초등록: '2025-01', 소비자가격: '31,234,567',
                    배기량: '1,234', 연료: '합성연료', Km: '12,345', 외장: '원문 외장', 내장: '원문 내장' } } });
        expect(out.records[0].terms.map(t => t.months)).toEqual([36, 60]);
        expect(out.records[0].terms.map(t => t.monthlyRent.value)).toEqual([123456, 234567]);
        expect(out.records[0].terms.every(t => t.deposit.state === 'ZERO' && t.deposit.value === 0 && t.mileage === '3만km')).toBe(true);
        expect(out.records[1].terms.every(t => t.deposit.state === 'KNOWN' && t.deposit.value === 1234000)).toBe(true);
        expect(out.records[0].raw.cells).toEqual(f.tables[0].values[1]);
        expect(f).toEqual(before);
        expect(nativeCycleFields({ ...product(), record: out.records[0] })).toMatchObject({
            maker: '', model: '', sub_model: out.records[0].vehicleText, trim_name: '', vehicle_review_required: true
        });
        expect(rawTitleBackfillFields({ vehicle_review_required: true, maker: '', model: '', sub_model: '', trim_name: '', car_name: 'G80 (18년식)' }))
            .toEqual({ sub_model: 'G80 (18년식)', vehicle_title_source: 'RAW_VEHICLE_TEXT' });
        expect(rawTitleBackfillFields({ vehicle_review_required: true, maker: '현대', model: '', sub_model: '', trim_name: '', car_name: 'x' })).toBeNull();
        expect(rawTitleBackfillFields({ vehicle_review_required: false, car_name: 'x' })).toBeNull();
    });
    it.each(['', '협의', null, -1, '12,34'])('Aica ambiguous deposit %s remains UNKNOWN', async (deposit) => {
        const out = await aicaRead(aicaFixture([aicaRow({ 장기보증: deposit })]));
        expect(out.records[0].terms.every(t => t.deposit.state === 'UNKNOWN' && t.deposit.value === null)).toBe(true);
    });
    it.each(['배차문의', '수리중', '배차중', '배차가능', '출고불가'])('Aica only explicit stop is unavailable: %s', async (status) => {
        const out = await aicaRead(aicaFixture([aicaRow({ 배차상태: status })]));
        expect(out.records[0].status.saleAvailable).toBe(status !== '출고불가');
        if (status === '수리중')
            expect(out.records[0].raw.sourceCycleDisplayStatus).toBe('상품화중');
    });
    it('Aica preserves legacy monthly observations outside the new typed monthly group', async () => {
        const out = await aicaRead();
        expect(out.capture.observationOnlyCount).toBe(0);
        expect(out.plugin.observationCountOfRead(out.read)).toBe(0);
        const monthly = product('MONTHLY');
        monthly.record.sourceId = 'RP004';
        monthly.record.raw.source_tab = '월렌트';
        const plan = planSourceCycle(out.plugin, { records: out.records, complete: true, observedAt: time, heldCount: 0 }, { complete: true, products: [monthly] }, now).plan;
        expect(plan.sourceCount).toBe(2);
        expect(plan.exposedBefore).toBe(0);
        expect(plan.entries.map(e => e.kind)).toEqual(['ENROLL', 'ENROLL']);
        expect(out.held).toEqual([]);
    });
    it('Aica same plate yields UPDATE then no change, never absence DOWNGRADE', async () => {
        const out = await aicaRead(), old = out.records.map(record => ({ ...product(record.uid), record: structuredClone(record) }));
        old[0].record.terms[0].monthlyRent = { state: 'KNOWN', value: 111111 };
        const evidence = { records: out.records, complete: true, observedAt: time, heldCount: 0 };
        const plan = planSourceCycle(out.plugin, evidence, { complete: true, products: old }, now).plan;
        expect(plan.held).toBe(0);
        expect(plan.blockers).toEqual([]);
        expect(plan.entries.map(e => e.kind)).toEqual(['UPDATE']);
        old[0] = plan.entries[0].after;
        expect(planSourceCycle(out.plugin, evidence, { complete: true, products: old }, now).plan.entries).toEqual([]);
    });
    it('Aica legacy Firestore monthly documents stay outside dry-run; summary separates product groups', async () => {
        const out = await aicaRead(), { commands, fake } = await setup();
        fake.docs.set('MONTHLY', { name: 'projects/synthetic-test/databases/(default)/documents/products/MONTHLY',
            updateTime: time, fields: encodeFields({ provider_company_code: 'RP004', listable: true, status: '가용',
                source: 'aica-sheet', source_tab: '월렌트', product_group: 'MONTHLY' }) });
        const ctrl = fileCycleControl(await directory(), async () => { });
        const result = await runSourceCycle(out.plugin, commands, ctrl, { now: () => now });
        expect(result.status).toBe('DRY_RUN');
        expect(result.summary).toContain('하향 0');
        expect(result.summary).toContain('장기 2 · 월렌트 0');
        expect(result.summary).toContain('번호미배정 0');
        expect((await ctrl.load('RP004')).observationOnlyCount).toBe(0);
        expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
        expect(fake.calls[0].url.searchParams.getAll('mask.fieldPaths')).toContain('source_tab');
        expect(fake.calls[0].url.searchParams.getAll('mask.fieldPaths')).toContain('`원문`');
    });
    it.each([0, 1234000])('Aica numeric deposit %s and whitespace-empty period', async (deposit) => {
        const out = await aicaRead(aicaFixture([aicaRow({ 장기보증: deposit, '48개월': '  ' })]));
        expect(out.records[0].terms.map(t => t.months)).toEqual([36, 60]);
        expect(out.records[0].terms.every(t => t.deposit.value === deposit && t.deposit.state === (deposit ? 'KNOWN' : 'ZERO'))).toBe(true);
    });
    it('Aica reads filter-hidden rows as data, holds (never drops) user-hidden rows, and hidden tabs/missing visibility/header are incomplete', async () => {
        const f = aicaFixture([aicaRow(), aicaRow({ 차량번호: '00가2002' }), aicaRow({ 차량번호: '00가2003' })]);
        f.meta.sheets[0].data[0].rowMetadata[1].hiddenByUser = true;
        f.meta.sheets[0].data[0].rowMetadata[2].hiddenByFilter = true;
        const read = await aicaRead(f);
        // 필터는 공유 «보기» 상태 — 가려진 00가2002 도 데이터다. 사용자가 숨긴 00가2001 은 읽지 않지만 보류로 세어 부재 하향을 막는다.
        expect(read.records.map(r => r.uid)).toEqual(['00가2002', '00가2003']);
        expect(read.capture.heldReasons).toEqual(['ROW_HIDDEN_BY_USER']);
        const before = { ...product('00가2001'), record: { ...product('00가2001').record, sourceId: 'RP004' } };
        const plan = planSourceCycle({ sourceId: 'RP004', family: 'AICA', maxDowngradeRatio: 1 }, { records: read.records, complete: read.read.complete, observedAt: time, heldCount: read.held.length }, { complete: true, products: [before] }, now).plan;
        expect(plan.entries.filter(e => e.kind === 'DOWNGRADE')).toEqual([]);
        expect(plan.warnings).toContain('ABSENCE_DOWNGRADE_SKIPPED');
        f.meta.sheets[0].properties.hidden = true;
        expect((await aicaRead(f)).records).toEqual([]);
        expect((await aicaRead(f)).read.complete).toBe(false);
        expect(aicaNativeCapture(f.tables, time).complete).toBe(false);
        const wrong = aicaFixture();
        wrong.tables[0].values[0] = ['wrong'];
        expect((await aicaRead(wrong)).read.complete).toBe(false);
    });
    it('Aica guidance text rows (no plate, model, trim or price) are not vehicles and do not block absence downgrades', async () => {
        const blank = Object.fromEntries(aicaHeaders.map(h => [h, '']));
        const guidance = aicaRow({ ...blank, 배차상태: '수수료 고정 50만원' });
        const priceOnly = aicaRow({ ...blank, 배차상태: '배차문의', '36개월': '123,456' }); // 요금만 있고 번호·차종이 없으면 차량 행 후보: 여전히 보류
        const f = aicaFixture([aicaRow(), guidance, priceOnly]);
        const out = await aicaRead(f);
        expect(out.records).toHaveLength(1);
        expect(out.held.flatMap(h => h.reasons)).toEqual(['UID_REQUIRED', 'UNASSIGNED_PLATE']); // 안내 행은 세지 않고 요금 행 1건만 보류
        const old = product('00가9999');
        old.record.sourceId = 'RP004';
        const onlyGuidance = await aicaRead(aicaFixture([aicaRow(), guidance]));
        expect(onlyGuidance.held).toEqual([]);
        const plan = planSourceCycle(onlyGuidance.plugin, { records: onlyGuidance.records, complete: true, observedAt: time, heldCount: 0 }, { complete: true, products: [old] }, now).plan;
        expect(plan.entries.some(e => e.kind === 'DOWNGRADE' && e.before?.record.uid === '00가9999')).toBe(true); // 사라진 차는 내려간다
    });
    it('Aica copies differing only in status/model/mileage spacing keep the first; a monthly model with any unparseable rent row is held as a whole group', async () => {
        const a = aicaRow({ 차량번호: '00가3201', 배차상태: '배차문의', 차종분류: '합성모델', 연주행: '3만km' });
        const spaced = aicaRow({ 차량번호: '00가3201', 배차상태: ' 배차문의 ', 차종분류: ' 합성모델 ', 연주행: '3만 km' });
        const copies = await aicaRead(aicaFixture([a, spaced]));
        // 연주행 '3만km' vs '3만 km' 는 공백 정리 후 같은 값이 아니므로(내부 공백 표기 차이는 항 식별 문자열이 달라짐) 보수적으로 보류될 수 있다 — 상태·차명 공백만 다른 경우는 반영
        const statusOnly = await aicaRead(aicaFixture([a, aicaRow({ 차량번호: '00가3201', 배차상태: ' 배차문의 ', 차종분류: ' 합성모델 ', 연주행: '3만km' })]));
        expect(statusOnly.records.map(r => r.uid)).toEqual(['00가3201']);
        expect(statusOnly.held.map(h => h.reasons[0])).toEqual(['DUPLICATE_UID_SUSPECT']);
        expect(copies.held.length).toBeGreaterThan(0);
        const f = aicaFixture();
        f.tables[3].values = [['차종', '1개월'], ['Model X', 500000], ['model x', '오십만원'], ['Model Y', 600000]];
        f.meta.sheets[3].properties.gridProperties.rowCount = f.tables[3].values.length;
        f.meta.sheets[3].data[0].rowMetadata = f.tables[3].values.map(() => ({ hiddenByUser: false, hiddenByFilter: false }));
        const out = await aicaRead(f);
        expect(out.records.filter(r => r.raw.product_group === 'MONTHLY_RENT').map(r => r.uid)).toEqual(['RP004:MONTHLY:MODELY']);
        expect(out.held.filter(h => h.reasons[0] === 'MONTHLY_RENT_UNPARSEABLE').length).toBe(2);
    });
    it('Aica rows sharing a plate that differ only in an option cell are also all held (raw content differs)', async () => {
        const a = aicaRow({ 차량번호: '00가3101', 옵션: '썬루프' }), b = aicaRow({ 차량번호: '00가3101', 옵션: '썬루프 없음' }), copy = aicaRow({ 차량번호: '00가3101', 옵션: ' 썬루프 ' });
        const differing = await aicaRead(aicaFixture([a, b]));
        expect(differing.records).toEqual([]);
        expect(differing.held.map(h => h.reasons[0])).toEqual(['DUPLICATE_UID_CONFLICT', 'DUPLICATE_UID_CONFLICT']);
        const identical = await aicaRead(aicaFixture([a, copy])); // 공백만 다른 복사본
        expect(identical.records.map(r => r.uid)).toEqual(['00가3101']);
        expect(identical.held.map(h => h.reasons[0])).toEqual(['DUPLICATE_UID_SUSPECT']);
    });
    it('Aica rows sharing a plate with different offers are all held, never decided by row order', async () => {
        const a = aicaRow({ 차량번호: '00가3001', 배차상태: '배차문의' }), b = aicaRow({ 차량번호: '00가3001', 배차상태: '출고불가' });
        const ok = aicaRow({ 차량번호: '00가3002' });
        const out = await aicaRead(aicaFixture([a, b, ok]));
        expect(out.records.map(r => r.uid)).toEqual(['00가3002']);
        expect(out.held.map(h => h.reasons[0])).toEqual(['DUPLICATE_UID_CONFLICT', 'DUPLICATE_UID_CONFLICT']);
        const swapped = await aicaRead(aicaFixture([b, a, ok])); // 행 순서를 바꿔도 같은 결과
        expect(swapped.records.map(r => r.uid)).toEqual(['00가3002']);
    });
    it('Aica plate-only UID, duplicate and unassigned holds protect absence', async () => {
        const f = aicaFixture([aicaRow(), aicaRow(), aicaRow({ 차량번호: '' })]);
        f.tables[0].values[0].push('UID');
        f.tables[0].values[3].push('DO_NOT_USE');
        const out = await aicaRead(f);
        expect(out.records).toHaveLength(1);
        expect(out.held.flatMap(h => h.reasons)).toEqual(['UID_REQUIRED', 'UNASSIGNED_PLATE', 'DUPLICATE_UID_SUSPECT']);
        const old = product('00가9999');
        old.record.sourceId = 'RP004';
        const plan = planSourceCycle(out.plugin, { records: out.records, complete: true, observedAt: time, heldCount: out.held.length }, { complete: true, products: [old] }, now).plan;
        expect(plan.entries.some(e => e.kind === 'DOWNGRADE')).toBe(false);
    });
    it('Iron rejects unproven homepage coverage', () => {
        expect(() => ironNativeCapture('<html/>', time)).toThrow('IRON_LIST_SCHEMA_HOLD');
        expect(() => ironNativeCapture('<script id="__NEXT_DATA__">{"props":{"pageProps":{"vehicles":[],"total":1}}}</script>', time)).toThrow('IRON_LIST_COVERAGE_HOLD');
    });
    it('Iron maps complete published inventory and plate identity', async () => {
        const html = `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { total: 1, hasNextPage: false,
                    vehicles: [{ car_number: '00가3001', car_name: '합성', published: true, price: { '12': { rent: 100, deposit: 0, mileage: '20000km' } } }] } } })}</script>`;
        const p = plateUidPlugin(sourceCyclePlugin({ sourceId: 'RP006', kind: 'IRON', scopes: ['homepage'], maxDowngradeRatio: 0.2 }, async () => ironNativeCapture(html, time)));
        expect(p.toRecords(await p.read()).records[0]).toMatchObject({ uid: '00가3001', status: { saleAvailable: true } });
    });
    it('observation plugin cannot call product commands even with apply=true', async () => {
        const base = sourceCyclePlugin({ sourceId: source, kind: 'SONOGONG', scopes: ['collector'], maxDowngradeRatio: 0.2 }, async () => ({
            observedAt: time, complete: true, completedScopes: ['collector'], visibilityComplete: true, heldCount: 0,
            rows: [{ scope: 'collector', record: product().record }]
        }));
        const { commands, fake } = await setup();
        const ctrl = fileCycleControl(await directory(), async () => { });
        const result = await runSourceCycle({ ...base, observationOnly: true }, commands, ctrl, { apply: true, now: () => now });
        expect(result).toMatchObject({ status: 'OBSERVED', writes: 0 });
        expect(fake.calls).toHaveLength(0);
    });
    it('fresh capture clock accepts approved unchanged facts; changed facts require replan', async () => {
        const { commands } = await setup();
        const built = await prepare(commands), next = product().record;
        next.observedAt = new Date(now + 1000).toISOString();
        const p = sourceCyclePlugin({ sourceId: source, kind: 'IRON', scopes: ['inventory'], maxDowngradeRatio: 1 }, async () => ({
            observedAt: next.observedAt, complete: true, completedScopes: ['inventory'], visibilityComplete: true, heldCount: 0,
            rows: [{ scope: 'inventory', record: next }]
        }));
        const result = await runSourceCycle(p, commands, fileCycleControl(await directory(), async () => { }), {
            apply: true, approvedPlan: built.plan, digest: built.digest, approval: built.digest, now: () => now + 1000
        });
        expect(result.status).toBe('APPLIED');
        next.vehicleText = 'changed';
        const rejected = await runSourceCycle(p, commands, fileCycleControl(await directory(), async () => { }), {
            apply: true, approvedPlan: built.plan, digest: built.digest, approval: built.digest, now: () => now + 1000
        });
        expect(rejected.status).toBe('HOLD');
    });
    it('runtime construction/import does not fetch or authenticate', async () => {
        const fetcher = vi.fn();
        const r = createSourceCycleRuntime({ FIREBASE_PROJECT_ID: 'synthetic-test', SOURCE_CYCLE_SOURCES: 'IANCAR,IRON',
            SOURCE_CYCLE_PRIVATE_DIR: await directory() }, fetcher);
        expect(r.plugins.filter(p => p.absenceReason !== 'DECISION_WITHDRAWN')).toHaveLength(2);
        expect(fetcher).not.toHaveBeenCalled();
    });
});
describe('ERP4 단독 수집 원천의 관측 전용 신선도 (손오공·오토플러스: 수집이 멈춰도 정상으로 보이던 결함)', () => {
    const doc = (uid, fields, updateTime) => ({
        name: `projects/synthetic-test/databases/(default)/documents/products/${uid}`, updateTime, fields: encodeFields(fields)
    });
    const row = (listable, source, status = '출고가능') => ({ provider_company_code: 'RP023', car_number: 'T1', car_name: 'x', source,
        listable, status, status_kind: listable ? '가용' : '불가', vehicle_status: status, price: { '12': { rent: 100, deposit: 0 } } });
    it('freshness evidence is the collection-step success time only: a recently edited document never makes a stalled collector look fresh (독립 검토 2026-10-14)', async () => {
        const docs = [doc('A1', row(true, 'sheet'), '2026-10-13T14:39:00Z')];
        const nowAt = Date.parse('2026-10-13T20:00:00Z');
        const observed = async (evidence) => (await collectorObservationPlugin('SONOGONG', 1, async () => docs, () => nowAt, evidence).read()).observedAt;
        expect(await observed(async () => '2026-10-13T19:30:00Z')).toBe('2026-10-13T19:30:00.000Z');
        expect(await observed(async () => '2026-10-13T10:00:00Z')).toBe('2026-10-13T10:00:00.000Z'); // 문서가 더 최근이어도 증거 시각
        expect(await observed(async () => { throw new Error('GH_UNAVAILABLE'); })).toBe('1970-01-01T00:00:00.000Z'); // 증거 못 읽음 → 신선 아님
        expect(await observed(async () => '2026-10-14T20:00:00Z')).toBe('1970-01-01T00:00:00.000Z'); // 미래 시각은 버린다
        expect(await observed(undefined)).toBe('2026-10-13T14:39:00.000Z'); // 증거 함수가 없을 때만 문서 시각
    });
    it.skip('ERP4 collection-step success time replaces a stale document time but never a newer one, and unreadable evidence falls back to documents (이전 동작, 대체됨)', async () => {
        const docs = [doc('A1', row(true, 'sheet'), '2026-10-13T14:39:00Z')];
        const nowAt = Date.parse('2026-10-13T20:00:00Z');
        const observed = async (evidence) => (await collectorObservationPlugin('SONOGONG', 1, async () => docs, () => nowAt, evidence).read()).observedAt;
        expect(await observed(async () => '2026-10-13T19:30:00Z')).toBe('2026-10-13T19:30:00.000Z'); // 쓰기 성공이 더 최근
        expect(await observed(async () => '2026-10-13T10:00:00Z')).toBe('2026-10-13T14:39:00.000Z'); // 문서가 더 최근이면 그대로
        expect(await observed(async () => { throw new Error('GH_UNAVAILABLE'); })).toBe('2026-10-13T14:39:00.000Z');
        expect(await observed(async () => '2026-10-14T20:00:00Z')).toBe('2026-10-13T14:39:00.000Z'); // 미래 시각은 버린다
        expect(await observed(undefined)).toBe('2026-10-13T14:39:00.000Z');
    });
    it('observed time is the exposed documents\' last update, not now, and every source value is counted', async () => {
        const docs = [doc('A1', row(true, 'sheet'), '2026-10-13T03:50:00Z'), doc('A2', row(true, 'website'), '2026-10-13T03:53:21Z'),
            doc('A3', row(true, 'legacy_provider_atom'), '2026-10-13T03:40:00Z'), doc('A4', row(false, 'sheet', '출고불가'), '2026-10-13T09:59:00Z')];
        const p = collectorObservationPlugin('AUTOPLUS', 1, async () => docs, () => Date.parse('2026-10-13T10:30:00Z'));
        const read = await p.read();
        expect(read.observedAt).toBe('2026-10-13T03:53:21.000Z'); // 노출 문서 최신(비노출 문서의 더 늦은 갱신은 신선도 근거가 아님)
        expect(p.toRecords(read).records.filter(r => r.status.saleAvailable === true)).toHaveLength(3); // source 값과 무관
    });
    it('a stalled collector shows up as STALE in the freshness verdict', async () => {
        const dir = await directory();
        const docs = [doc('A1', row(true, 'sheet'), '2026-10-13T03:53:21Z')];
        const p = collectorObservationPlugin('AUTOPLUS', 1, async () => docs);
        const ctrl = fileCycleControl(dir, async (source, state) => {
            await appendFile(join(dir, 'heartbeats.jsonl'), JSON.stringify({ source, ...state }) + '\n');
        });
        const result = await runSourceCycle(p, { list: async () => ({ products: [], complete: true }) }, ctrl, { now: () => Date.parse('2026-10-13T10:30:00Z') });
        expect(result).toMatchObject({ status: 'OBSERVED', writes: 0 });
        expect(result.summary).toContain('수집기 최종 갱신 2026-10-13T03:53:21.000Z');
        const beats = (await readFile(join(dir, 'heartbeats.jsonl'), 'utf8')).split('\n');
        const report = assessFreshness(beats, [], { now: Date.parse('2026-10-13T10:30:00Z'), only: ['RP023'] });
        expect(report.unhealthy).toEqual(['RP023:STALE']);
        expect(report.sources[0].ageMinutes).toBe(397);
    });
});
describe('옵션 가격 키 복원과 상류 정지 처리 (이안카 2026-10-13 실측)', () => {
    const multi = () => {
        const p = product('ONE1001');
        p.record.terms = [20000, 30000, 40000].map((km, i) => ({ months: 12, monthlyRent: { state: 'KNOWN', value: 555000 + i * 47000 },
            deposit: { state: 'ZERO', value: 0 }, mileage: `${km}km/year`, raw: {} }));
        return p;
    };
    it('rewrites a listed document that lacks the consumer-read option keys exactly once', async () => {
        const { commands, fake } = await setup();
        const p = multi();
        // 옛 배치(대표 항 키만 있고 옵션 키 없음)로 이미 쓰인 문서를 만든다
        const legacyPrice = { '12': { rent: 555000, deposit: 0, mileage: '20000km/year' } };
        const fields = { ...nativeCycleFields(p), price: legacyPrice, source_cycle_price_digest: priceDigest(legacyPrice) };
        fake.docs.set('ONE1001', { name: 'projects/synthetic-test/databases/(default)/documents/products/ONE1001', updateTime: `${time}:1`,
            fields: encodeFields(fields) });
        const first = await prepare(commands, [p.record]);
        expect(first.plan.entries.map(e => e.kind)).toEqual(['UPDATE']);
        expect((await apply(commands, first)).status).toBe('APPLIED');
        const price = decodeFields(fake.docs.get('ONE1001').fields).price;
        expect(Object.keys(price).sort()).toEqual(['12', '12_연20000km', '12_연30000km', '12_연40000km']);
        expect(price['12_연30000km']).toEqual({ rent: 602000, deposit: 0 });
        expect((await prepare(commands, [p.record])).plan.entries).toEqual([]); // 멱등: 다시 쓰지 않는다
    });
    it('rewrites an engine-owned listed document whose status_kind disagrees with its vehicle_status exactly once', async () => {
        const { commands, fake } = await setup();
        const p = product('ONE1002');
        // 예전 엔진은 표시 상태와 무관하게 «가용» 을 썼다: 상품화중 문서의 계약 값은 «준비»
        const fields = { ...nativeCycleFields(p), status: '상품화중', vehicle_status: '상품화중', status_kind: '가용' };
        fake.docs.set('ONE1002', { name: 'projects/synthetic-test/databases/(default)/documents/products/ONE1002', updateTime: `${time}:1`,
            fields: encodeFields(fields) });
        const first = await prepare(commands, [p.record]);
        expect(first.plan.entries.map(e => e.kind)).toEqual(['UPDATE']);
        expect((await apply(commands, first)).status).toBe('APPLIED');
        const written = decodeFields(fake.docs.get('ONE1002').fields);
        expect(written.vehicle_status).toBe(written.status);
        expect(written.status_kind).toBe(statusKindOf(String(written.vehicle_status), true));
        expect((await prepare(commands, [p.record])).plan.entries).toEqual([]); // 멱등: 다시 쓰지 않는다
    });
    describe('월렌트 모델 문서의 product_type (어휘 확장 합침 뒤에만: 기본 꺼짐)', () => {
        const monthly = () => { const p = product('MONTHLY1'); p.record.plate = null; p.record.raw = { ...p.record.raw, product_group: 'MONTHLY_RENT' }; return p; };
        const seed = (fake, p) => fake.docs.set('MONTHLY1', {
            name: 'projects/synthetic-test/databases/(default)/documents/products/MONTHLY1', updateTime: `${time}:1`, fields: encodeFields(nativeCycleFields(p))
        });
        it('does nothing while the flag is off', async () => {
            const { commands, fake } = await setup();
            const p = monthly();
            seed(fake, p);
            expect((await prepare(commands, [p.record])).plan.entries).toEqual([]);
        });
        it('rewrites exactly once with product_type 월렌트 and touches no other product-facing field when the flag is on', async () => {
            const { commands, fake } = await setup([], { writeMonthlyProductType: true });
            const p = monthly();
            seed(fake, p);
            const before = decodeFields(fake.docs.get('MONTHLY1').fields);
            const first = await prepare(commands, [p.record]);
            expect(first.plan.entries.map(e => e.kind)).toEqual(['UPDATE']);
            expect((await apply(commands, first)).status).toBe('APPLIED');
            const after = decodeFields(fake.docs.get('MONTHLY1').fields);
            expect(after.product_type).toBe('월렌트');
            for (const k of ['price', 'listable', 'status', 'status_kind', 'vehicle_status', 'car_number', 'provider_company_code'])
                expect(after[k]).toEqual(before[k]);
            expect((await prepare(commands, [p.record])).plan.entries).toEqual([]); // 멱등
        });
        it('never writes product_type to a long-term document even when the flag is on', async () => {
            const { commands, fake } = await setup([], { writeMonthlyProductType: true });
            const p = product('LONG1');
            fake.docs.set('LONG1', { name: 'projects/synthetic-test/databases/(default)/documents/products/LONG1', updateTime: `${time}:1`, fields: encodeFields(nativeCycleFields(p)) });
            expect((await prepare(commands, [p.record])).plan.entries).toEqual([]);
        });
    });
    it('an absence downgrade of a document whose stored record still holds full raw (written before compaction) reads back identically', async () => {
        const { commands, fake } = await setup();
        const a = product('ABS1'), b = product('ABS2');
        for (const p of [a, b])
            p.record.raw = { cells: ['가'.repeat(40), '나'.repeat(40)], headers: ['차량번호', '배차상태'], source: 'aica-sheet', source_row: 2 };
        // 압축 도입 전 엔진이 쓴 문서: source_cycle_record 에 원문 전체(raw.cells·headers)가 그대로 들어 있다.
        for (const p of [a, b])
            fake.docs.set(p.record.uid, { name: `projects/synthetic-test/databases/(default)/documents/products/${p.record.uid}`,
                updateTime: `${time}:1`, fields: encodeFields({ ...nativeCycleFields(p), source_cycle_record: p.record }) });
        const absent = await prepare(commands, [b.record]); // ABS1 이 원천에서 사라진다
        expect(absent.plan.entries.map(e => [e.kind, e.after.record.uid])).toEqual([['DOWNGRADE', 'ABS1']]);
        expect(await apply(commands, absent)).toMatchObject({ status: 'APPLIED', verified: 1, uncertain: [] });
        const stored = decodeFields(fake.docs.get('ABS1').fields);
        expect(stored).toMatchObject({ listable: false, status: '출고불가' });
        expect(JSON.stringify(stored.source_cycle_record)).not.toContain('가가가가'); // 쓴 뒤에는 압축 형태
    });
    it('an upstream that stopped refreshing is a soft hold: no failure count, no STOPPED, one alert, zero writes', async () => {
        const { commands, fake } = await setup();
        const dir = await directory();
        const alerts = [];
        const ctrl = { ...fileCycleControl(dir, async () => { }), async alert(_s, reason) { alerts.push(reason); } };
        const stale = sourceCyclePlugin({ sourceId: source, kind: 'IANCAR', scopes: ['inventory'], maxDowngradeRatio: 1 }, async () => ({
            observedAt: time, complete: false, completedScopes: [], visibilityComplete: true, rows: [], heldCount: 0, incompleteReason: 'UPSTREAM_STALE'
        }), () => time);
        for (let i = 0; i < 4; i++) {
            const r = await runSourceCycle(stale, commands, ctrl, { now: () => now + i });
            expect(r).toMatchObject({ status: 'HOLD', writes: 0 });
        }
        const state = await ctrl.load(source);
        expect(state).toMatchObject({ failures: 0, stopped: false, error: 'UPSTREAM_STALE' });
        expect(alerts).toEqual(['UPSTREAM_STALE']);
        expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
    });
    it('a detail read that outlives the upstream freshness window (DETAIL_SOURCE_DRIFT) is also a soft hold, never STOPPED', async () => {
        const { commands, fake } = await setup();
        const dir = await directory();
        const alerts = [];
        const ctrl = { ...fileCycleControl(dir, async () => { }), async alert(_s, reason) { alerts.push(reason); } };
        const drift = sourceCyclePlugin({ sourceId: source, kind: 'IANCAR', scopes: ['inventory'], maxDowngradeRatio: 1 }, async () => { throw new Error('IANCAR_ONE_DETAIL_SOURCE_DRIFT'); }, () => time);
        for (let i = 0; i < 4; i++) {
            const r = await runSourceCycle(drift, commands, ctrl, { now: () => now + i });
            expect(r).toMatchObject({ status: 'HOLD', writes: 0 });
        }
        expect(await ctrl.load(source)).toMatchObject({ failures: 0, stopped: false, error: 'IANCAR_ONE_DETAIL_SOURCE_DRIFT' });
        expect(alerts).toEqual(['IANCAR_ONE_DETAIL_SOURCE_DRIFT']);
        expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
    });
    it('other incomplete reads keep counting failures and record the safe reason', async () => {
        const { commands } = await setup();
        const alerts = [];
        const ctrl = { ...fileCycleControl(await directory(), async () => { }), async alert(_s, reason) { alerts.push(reason); } };
        const partial = sourceCyclePlugin({ sourceId: source, kind: 'IANCAR', scopes: ['inventory'], maxDowngradeRatio: 1 }, async () => ({
            observedAt: time, complete: false, completedScopes: [], visibilityComplete: true, rows: [], heldCount: 0,
            incompleteReason: 'IANCAR_ONE_ENRICHMENT_SOURCE_DRIFT'
        }), () => time);
        const r = await runSourceCycle(partial, commands, ctrl, { now: () => now });
        expect(r.status).toBe('HOLD');
        expect((await ctrl.load(source)).failures).toBe(1);
        expect(alerts).toContain('INCOMPLETE_IANCAR_ONE_ENRICHMENT_SOURCE_DRIFT');
    });
});
describe('대표 지시로 내린 공급사 (에스에이 PT-0023: 탭·공급사 입력 없음 → 엔진의 일반 부재 하향 대상이 아님)', () => {
    const sa = (uid, listable = true) => {
        const p = product(uid);
        p.record.sourceId = 'PT-0023';
        p.listable = listable;
        p.record.status.saleAvailable = listable;
        return p;
    };
    const plugin = () => decisionWithdrawnPlugin('PT-0023', () => time);
    it('is registered by the contract and read as a complete empty source with its own reason', () => {
        const r = createSourceCycleRuntime({ FIREBASE_PROJECT_ID: 'synthetic-test', SOURCE_CYCLE_SOURCES: 'IANCAR', SOURCE_CYCLE_PRIVATE_DIR: '.' }, vi.fn());
        const d = r.plugins.find(p => p.sourceId === 'PT-0023');
        expect(d.absenceReason).toBe('DECISION_WITHDRAWN');
        expect(d.maxDowngradeRatio).toBe(1);
    });
    it('withdraws every exposed document with DECISION_WITHDRAWN regardless of the ratio guard, with backups, and is idempotent', async () => {
        const { commands, fake, dir } = await setup();
        const seeded = ['SA1', 'SA2', 'SA3', 'SA4'].map(u => sa(u));
        for (const p of seeded)
            fake.docs.set(p.record.uid, { name: `projects/synthetic-test/databases/(default)/documents/products/${p.record.uid}`,
                updateTime: `${time}:${p.record.uid}`, fields: encodeFields({ ...nativeCycleFields(p), unrelated: { keep: true } }) });
        const ctrl = fileCycleControl(await directory(), async () => { });
        const result = await runUnattendedSourceCycle(plugin(), commands, ctrl, { now: () => now + 1000 });
        expect(result).toMatchObject({ stage: 'APPLY', status: 'APPLIED', writes: 4, verified: 4 });
        for (const uid of ['SA1', 'SA2', 'SA3', 'SA4']) {
            const f = decodeFields(fake.docs.get(uid).fields);
            expect(f).toMatchObject({ listable: false, status: '출고불가', unrelated: { keep: true } });
            expect(f.publication_withdrawal.reason).toBe('DECISION_WITHDRAWN');
        }
        expect((await readdir(dir)).length).toBeGreaterThan(0); // 되돌릴 백업
        const again = await runUnattendedSourceCycle(plugin(), commands, ctrl, { now: () => now + 2000 });
        expect(again).toMatchObject({ stage: 'PLAN', status: 'DRY_RUN', writes: 0 });
    });
    it('withdraws again when another writer re-exposes the supplier (재노출 방지)', async () => {
        const { commands, fake } = await setup();
        const p = sa('SA9');
        fake.docs.set('SA9', { name: 'projects/synthetic-test/databases/(default)/documents/products/SA9', updateTime: `${time}:1`,
            fields: encodeFields(nativeCycleFields(p)) });
        const ctrl = fileCycleControl(await directory(), async () => { });
        await runUnattendedSourceCycle(plugin(), commands, ctrl, { now: () => now + 1000 });
        expect(decodeFields(fake.docs.get('SA9').fields).listable).toBe(false);
        const f = decodeFields(fake.docs.get('SA9').fields); // 다른 쓰기 주체가 다시 노출
        fake.docs.set('SA9', { ...fake.docs.get('SA9'), updateTime: `${time}:2`,
            fields: encodeFields({ ...f, listable: true, status: '출고가능', status_kind: '가용', publication_withdrawal: null }) });
        const result = await runUnattendedSourceCycle(plugin(), commands, ctrl, { now: () => now + 2000 });
        expect(result).toMatchObject({ stage: 'APPLY', status: 'APPLIED', writes: 1 });
        expect(decodeFields(fake.docs.get('SA9').fields).listable).toBe(false);
    });
});
describe('unattended hourly cycle (대표 2026-10-13: 1시간 간격 무인 적용)', () => {
    const plugin = (record = product().record) => sourceCyclePlugin({ sourceId: source, kind: 'IRON', scopes: ['inventory'], maxDowngradeRatio: 1 }, async () => ({ observedAt: time, complete: true, completedScopes: ['inventory'], visibilityComplete: true, heldCount: 0,
        rows: [{ scope: 'inventory', record }] }));
    it('plans then applies in one run, and the next run has nothing to apply', async () => {
        const { commands, fake } = await setup();
        const ctrl = fileCycleControl(await directory(), async () => { });
        const first = await runUnattendedSourceCycle(plugin(), commands, ctrl, { now: () => now + 1000 });
        expect(first).toMatchObject({ stage: 'APPLY', status: 'APPLIED', writes: 1, verified: 1 });
        expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
        const second = await runUnattendedSourceCycle(plugin(), commands, ctrl, { now: () => now + 2000 });
        expect(second).toMatchObject({ stage: 'PLAN', status: 'DRY_RUN', writes: 0 });
        expect(second.summary).toContain('변경 0');
        expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
    });
    it('reads the source exactly once per cycle, so a slow source that changes mid-run cannot abort the apply (이안카 5분 읽기)', async () => {
        const { commands, fake } = await setup();
        const ctrl = fileCycleControl(await directory(), async () => { });
        let reads = 0;
        const slow = sourceCyclePlugin({ sourceId: source, kind: 'IRON', scopes: ['inventory'], maxDowngradeRatio: 1 }, async () => {
            reads++;
            const r = product().record;
            r.terms[0].monthlyRent = { state: 'KNOWN', value: 100 * reads }; // 읽을 때마다 값이 달라지는 원천
            return { observedAt: time, complete: true, completedScopes: ['inventory'], visibilityComplete: true, heldCount: 0,
                rows: [{ scope: 'inventory', record: r }] };
        });
        const result = await runUnattendedSourceCycle(slow, commands, ctrl, { now: () => now + 1000 });
        expect(reads).toBe(1);
        expect(result).toMatchObject({ stage: 'APPLY', status: 'APPLIED', writes: 1, verified: 1 });
        expect(fake.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
    });
    it('never writes when the plan is blocked', async () => {
        const { commands, fake } = await setup([product('00가1001'), product('00가1002'), product('00가1003')]);
        const strict = sourceCyclePlugin({ sourceId: source, kind: 'IRON', scopes: ['inventory'], maxDowngradeRatio: 0.1 }, async () => ({ observedAt: time, complete: true, completedScopes: ['inventory'], visibilityComplete: true, heldCount: 0, rows: [] }));
        const result = await runUnattendedSourceCycle(strict, commands, fileCycleControl(await directory(), async () => { }), { now: () => now + 1000 });
        expect(result.stage).toBe('PLAN');
        expect(result.status).toBe('HOLD');
        expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
    });
    it('observation-only sources finish at OBSERVED without product writes', async () => {
        const { commands, fake } = await setup();
        const result = await runUnattendedSourceCycle({ ...plugin(), observationOnly: true }, commands, fileCycleControl(await directory(), async () => { }), { now: () => now + 1000 });
        expect(result).toMatchObject({ stage: 'PLAN', status: 'OBSERVED', writes: 0 });
        expect(fake.calls.every(c => c.method === 'GET')).toBe(true);
    });
    it('runtime CLI refuses --unattended without the explicit env opt-in or with manual approval args', async () => {
        const env = { FIREBASE_PROJECT_ID: 'synthetic-test', SOURCE_CYCLE_SOURCES: 'IRON', SOURCE_CYCLE_PRIVATE_DIR: await directory() };
        await expect(runtimeCli(['--unattended'], env)).rejects.toThrow('UNATTENDED_NOT_ENABLED');
        await expect(runtimeCli(['--unattended', '--apply'], { ...env, SOURCE_CYCLE_UNATTENDED: '1' })).rejects.toThrow('UNATTENDED_ARGS_INVALID');
        await expect(runtimeCli(['--unattended', '--plan', 'x.json'], { ...env, SOURCE_CYCLE_UNATTENDED: '1' })).rejects.toThrow('UNATTENDED_ARGS_INVALID');
    });
});
describe('status_kind 는 표시 상태가 정한다 (발행 단계 status_kind 드리프트 33건)', () => {
    it('maps each reviewed status to its contract kind; closed is 불가; unreviewed listable keeps 가용', () => {
        expect(statusKindOf('출고가능', true)).toBe('가용');
        expect(statusKindOf('즉시출고', true)).toBe('가용');
        expect(statusKindOf('계약중', true)).toBe('선점');
        expect(statusKindOf('상품화중', true)).toBe('준비');
        expect(statusKindOf('출고협의', true)).toBe('협의');
        expect(statusKindOf('출고가능', false)).toBe('불가');
        expect(statusKindOf('배차중', true)).toBe('가용');
        expect(statusKindOf('알 수 없음', true)).toBe('불가');
    });
    it('이안카 PREPARING 은 «출고가능»(IANCAR-ONE-API 결정 대표 10-12 «출고불가 아니면 판매 가능», 전에는 상품화중으로 써서 문서와 어긋남)', () => {
        const p = product();
        p.record = { ...p.record, status: { raw: 'PREPARING', saleAvailable: true }, raw: {} };
        expect(nativeCycleFields({ ...p, listable: true })).toMatchObject({ status: '출고가능', vehicle_status: '출고가능', status_kind: '가용' });
    });
});
