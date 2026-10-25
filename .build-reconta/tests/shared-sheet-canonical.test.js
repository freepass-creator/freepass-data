process.env.FREEPASS_SHEET_F04_ID = 'test-sheet-f04';
import { createHash } from 'node:crypto';
import { verifiedMasterRecords } from '../src/adapters/vehicle-identity-inputs.js';
import { describe, expect, it, vi } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { MemorySourceStore } from '../src/infra/source-memory-store.js';
import { buildSharedSheetBatch, SHARED_SHEET_SPEC_DIGEST, sharedSheetChannels, sharedSheetHeaders, sharedSheetCaptureDigest } from '../src/adapters/shared-sheet-source.js';
import { normalizeSharedSheet } from '../src/adapters/normalize-shared-sheet.js';
import { prepareRawSourceBatch } from '../src/application/ingest-raw-source.js';
import { ingestSharedSheetObservedRows, planSharedSheetCanonical, runSharedSheetCanonical, preflightSharedSheetApply, writePrivateArtifact, assertSharedSheetPlan, assertReviewedSharedSheetRun, assertReviewedPlanGeneration, assertLiveSharedSheetMatches, main as ingestMain } from '../src/jobs/ingest-shared-sheet-canonical.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { queryCanonicalByPlate, queryCanonicalProducts, queryFirestoreByPlate, main as queryMain } from '../src/jobs/query-canonical-by-plate.js';
import { stableDigest, stableRecordSetDigest, stableValue } from '../src/shared/stable-digest.js';
it('checks the actual Linux Actions producer collation before accepting preserved digests', () => {
    if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true')
        return;
    expect(new Intl.Collator().resolvedOptions().locale).toBe('en-US');
    const keys = ['a', 'A', 'z', 'Z', '가', '나', 'é', 'e\u0301', 'Rec-2', 'rec-1'];
    for (const a of keys)
        for (const b of keys) {
            expect(a.localeCompare(b, 'en-US')).toBe(a.localeCompare(b));
        }
});
it('preserves producer digests when Windows and CI default collations differ', () => {
    const compare = String.prototype.localeCompare;
    const value = { z: 0, 가: { a: 1, 나: 2 }, a: 3 };
    const records = [{ lineageRecordId: '가', value }, { lineageRecordId: 'z', value }];
    let defaultLocale = 'en-US';
    const mock = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (other, locales, options) {
        return compare.call(this, other, locales ?? defaultLocale, options);
    });
    try {
        const expected = { value: stableDigest(value), records: stableRecordSetDigest(records) };
        defaultLocale = 'ko-KR';
        expect(compare.call('가', 'z', 'en-US')).not.toBe(compare.call('가', 'z', 'ko-KR'));
        expect(stableDigest(value)).toBe(expected.value);
        expect(stableRecordSetDigest(records)).toBe(expected.records);
        expect(Object.keys(stableValue(value))).toEqual(['a', 'z', '가']);
    }
    finally {
        mock.mockRestore();
    }
});
function masterSnapshot() {
    const names = { maker: '시험제조사', model: '시험모델', sub_model: '시험세부모델' };
    const body = { readAt: new Date().toISOString(), masters: [{ id: 'master', data: names }],
        trims: [{ id: 'trim', data: { ...names, master_id: 'master', trim: '시험트림', fuel: '하이브리드', engine_cc: 1234, drivetrain: 'AWD', seats: 5, model_year_start: '2026', model_year_end: '현재' } }] };
    return { source: 'freepasserp5/vehicle_master+vehicle_trim_master', complete: true, ...body,
        digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
function masterEvidence(snapshot = masterSnapshot()) {
    return { records: verifiedMasterRecords(snapshot), readAt: snapshot.readAt, snapshotDigest: snapshot.digest };
}
const time = '2026-10-04T00:00:00.000Z';
function row(company, overrides = {}) {
    const data = { 회사명: company, 차량번호: 'TEST-FAKE-001', 차량상태: '출고가능', 상품구분: '중고렌트',
        제조사: '시험제조사', 모델: '시험모델', 세부모델: '시험세부모델', 세부트림: '시험트림', 연식: '26MY',
        최초등록일: '26.04', 연료: 'HEV', 주행거리: '1,234km', 배기량: '1,234cc', 인승: '5', 구동방식: 'AWD',
        단기보증: 101, 장기보증: 202, '1개월': 303, '12개월': 404, '24개월': 505, ...overrides };
    return sharedSheetHeaders.map(h => data[h] ?? '');
}
function capture(overrides = {}, company = '웰릭스') {
    const channel = sharedSheetChannels.find(x => x.companyName === company);
    return { schema: 'shared-sheet-capture/v1', spreadsheetId: 'synthetic-sheet', layoutVersion: '2026-10-04-no-account',
        readTime: time, vehicleMasterSnapshot: masterSnapshot(), revision: 'synthetic-revision-1', tabs: [...new Set(sharedSheetChannels.map(x => x.tab))].map(title => {
            const values = [[...sharedSheetHeaders], ...(title === channel.tab ? [row(company, overrides)] : [])];
            return { title, readTime: time, complete: true, rowCount: values.length, values };
        }) };
}
function normalized(c = capture()) { return normalizeSharedSheet(prepareRawSourceBatch(buildSharedSheetBatch(c)).rawRecords[0], masterEvidence(c.vehicleMasterSnapshot)); }
async function stores() {
    const store = new MemoryDataStore();
    await store.seed({ catalogWriterOwnership: { scope: 'catalog', revision: 1, mode: 'EXCLUSIVE', primaryWriterId: 'service:freepass-data',
            allowedWriterIds: ['service:freepass-data'], previousWriterIds: [], effectiveAt: time, updatedAt: time,
            updatedBy: { id: 'service:freepass-data', kind: 'SERVICE' }, reason: 'synthetic ownership' } });
    // Both production ports share firestore-layout; mirror that shared physical layout in this test only.
    class SharedMemorySource extends MemorySourceStore {
        async completeRun(input) {
            const result = await super.completeRun(input);
            const run = (await this.getRun(input.runId));
            const head = await this.getSourceHead(run.sourceId);
            await store.seed({ sourceRuns: [run], ...(head ? { sourceHeads: [head] } : {}),
                candidates: await this.listCandidates(run.runId), rawRecords: await this.listRaw(run.runId), lineage: await this.listLineage(run.runId) });
            return result;
        }
    }
    return { store, source: new SharedMemorySource() };
}
async function apply(s, c = capture()) {
    const p = await planSharedSheetCanonical(s.store, c, 'synthetic-target');
    const result = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
        plan: p.plan, expectedPlanDigest: p.report.planDigest });
    return { ...p, result };
}
function later(c) {
    c.readTime = '2026-10-04T00:15:00.000Z';
    c.revision = 'synthetic-revision-2';
    for (const t of c.tabs)
        t.readTime = c.readTime;
    return c;
}
describe('same F05 producer source observations without physical Canonical commands', () => {
    const fresh = (overrides = {}) => {
        const c = capture({ '1개월': 300000, '12개월': 400000, '24개월': 500000, ...overrides });
        delete c.revision;
        c.readTime = new Date(Date.now() - 2000).toISOString();
        for (const t of c.tabs)
            t.readTime = c.readTime;
        c.digest = sharedSheetCaptureDigest(c);
        const live = structuredClone(c);
        live.readTime = new Date(Date.now() - 1000).toISOString();
        for (const t of live.tabs)
            t.readTime = live.readTime;
        live.digest = sharedSheetCaptureDigest(live);
        return { target: 'memory', capture: c, liveCapture: live };
    };
    it('keeps unnumbered rejected rows, known prices and facts in the accepted head', async () => {
        const source = new MemorySourceStore();
        const input = fresh({ 차량번호: '신차', 세부트림: '' });
        const result = await ingestSharedSheetObservedRows(source, input);
        expect(result).toMatchObject({ status: 'SOURCE_HEAD_VERIFIED', rawRows: 1, candidateRows: 1, heldCandidateRows: 1, canonicalWrites: 0, publicationDecision: 'HOLD_PRESERVED' });
        const raw = await source.listRaw(result.runId), candidates = await source.listCandidates(result.runId);
        expect(raw[0].payload.values).toEqual(input.capture.tabs.find(t => t.title === '웰릭스').values[1]);
        expect(candidates[0].status).toBe('REJECTED');
        expect(candidates[0].candidate.priceTerms).toHaveLength(3);
        expect(candidates[0].candidate.vehicleFacts.fields.fuel).toMatchObject({ value: '하이브리드', state: 'KNOWN' });
        expect(await source.getSourceHead(result.sourceId)).toMatchObject({ runId: result.runId, observedAt: input.capture.readTime });
        const replay = await ingestSharedSheetObservedRows(source, input);
        expect(replay.runId).toBe(result.runId);
        expect(await source.listRaw(replay.runId)).toHaveLength(1);
    });
    it('stores registered exclusive-tab supplier provenance without filling its blank source cell or releasing identity HOLD', async () => {
        const source = new MemorySourceStore(), input = fresh({ 회사명: '', 제조사: '', 모델: '', 세부모델: '', 세부트림: '' });
        const before = structuredClone(input.capture);
        const result = await ingestSharedSheetObservedRows(source, input);
        const [raw] = await source.listRaw(result.runId), [candidate] = await source.listCandidates(result.runId);
        expect(raw.payload).toMatchObject({ supplierCode: 'RP013', supplierCodeBasis: 'REGISTERED_EXCLUSIVE_TAB_OWNER', supplierRegistryDigest: SHARED_SHEET_SPEC_DIGEST });
        expect(raw.payload.values[0]).toBe('');
        expect(candidate.candidate.providerCompanyCode).toBe('RP013');
        expect(candidate.candidate.priceTerms).toHaveLength(3);
        expect(candidate.status).toBe('REJECTED');
        expect(result.publicationDecision).toBe('HOLD_PRESERVED');
        expect(input.capture).toEqual(before);
    });
    it('rejects source drift and stale evidence before starting a durable run', async () => {
        const source = new MemorySourceStore(), begin = vi.spyOn(source, 'beginRun');
        const changed = fresh();
        changed.liveCapture.tabs.find(t => t.title === '웰릭스').values[1][0] = '변경';
        changed.liveCapture.digest = sharedSheetCaptureDigest(changed.liveCapture);
        await expect(ingestSharedSheetObservedRows(source, changed)).rejects.toThrow('LIVE_SHARED_SHEET_CHANGED_REPLAN_REQUIRED');
        const stale = fresh();
        stale.liveCapture.readTime = new Date(Date.now() - 130000).toISOString();
        for (const t of stale.liveCapture.tabs)
            t.readTime = stale.liveCapture.readTime;
        stale.liveCapture.digest = sharedSheetCaptureDigest(stale.liveCapture);
        await expect(ingestSharedSheetObservedRows(source, stale)).rejects.toThrow();
        expect(begin).not.toHaveBeenCalled();
        const old = fresh();
        old.capture.readTime = new Date(Date.now() - 130000).toISOString();
        for (const t of old.capture.tabs)
            t.readTime = old.capture.readTime;
        old.capture.digest = sharedSheetCaptureDigest(old.capture);
        await expect(ingestSharedSheetObservedRows(source, old)).rejects.toThrow('SHARED_SOURCE_CAPTURE_STALE');
        expect(begin).not.toHaveBeenCalled();
    });
    it('fails readback instead of claiming that dropped source rows are fresh', async () => {
        class BrokenReadback extends MemorySourceStore {
            async listCandidates() { return []; }
        }
        await expect(ingestSharedSheetObservedRows(new BrokenReadback(), fresh())).rejects.toThrow('SHARED_SOURCE_READBACK_MISMATCH');
    });
    it('stores known row facts while missing master authority keeps identity on HOLD', async () => {
        const source = new MemorySourceStore(), input = fresh();
        delete input.capture.vehicleMasterSnapshot;
        delete input.liveCapture.vehicleMasterSnapshot;
        input.capture.digest = sharedSheetCaptureDigest(input.capture);
        input.liveCapture.digest = sharedSheetCaptureDigest(input.liveCapture);
        const result = await ingestSharedSheetObservedRows(source, input);
        expect(result).toMatchObject({ status: 'SOURCE_HEAD_VERIFIED', heldCandidateRows: 1, masterEvidenceState: 'UNAVAILABLE_OR_UNVERIFIED', canonicalWrites: 0 });
        const candidate = (await source.listCandidates(result.runId))[0];
        expect(candidate.candidate.priceTerms).toHaveLength(3);
        expect(candidate.candidate.vehicleFacts.fields.maker.value).toBeNull();
        expect(candidate.candidate.issues).toContain('VEHICLE_MASTER_SNAPSHOT_REQUIRED');
    });
    it('advances the existing head for a newer observation and preserves the old RAW history', async () => {
        const source = new MemorySourceStore(), first = await ingestSharedSheetObservedRows(source, fresh({ 차량번호: '123가4567' }));
        const next = fresh({ 차량번호: '123가4567', '12개월': 606000 });
        next.capture.readTime = new Date(Date.now() - 500).toISOString();
        for (const t of next.capture.tabs)
            t.readTime = next.capture.readTime;
        next.liveCapture.readTime = new Date(Date.now() - 100).toISOString();
        for (const t of next.liveCapture.tabs)
            t.readTime = next.liveCapture.readTime;
        next.capture.digest = sharedSheetCaptureDigest(next.capture);
        next.liveCapture.digest = sharedSheetCaptureDigest(next.liveCapture);
        const second = await ingestSharedSheetObservedRows(source, next);
        expect(second.runId).not.toBe(first.runId);
        expect(await source.getSourceHead(second.sourceId)).toMatchObject({ runId: second.runId, observedAt: next.capture.readTime });
        expect(await source.listRaw(first.runId)).toHaveLength(1);
        const raw = (await source.listRaw(second.runId))[0];
        expect(raw.firstObservedAt).toBe(first.observedAt);
        expect((await source.listCandidates(second.runId))[0].candidate.priceTerms.find(t => t.termMonths === 12).monthlyRent.amount).toBe(606000);
    });
    it('uses the same native rent guard and preserves suspicious amounts only in RAW', async () => {
        const source = new MemorySourceStore(), input = fresh({ '12개월': 48000 });
        const result = await ingestSharedSheetObservedRows(source, input);
        const candidate = (await source.listCandidates(result.runId))[0].candidate;
        expect(candidate.priceTerms.some(t => t.termMonths === 12)).toBe(false);
        expect(candidate.issues).toContain('RENT_REVIEW_REQUIRED');
        expect((await source.listRaw(result.runId))[0].payload.values[sharedSheetHeaders.indexOf('12개월')]).toBe(48000);
    });
});
describe('shared sheet local source to Canonical', () => {
    it('searches products by supplier and name without requiring a vehicle number and preserves every stored fact', async () => {
        const s = await stores();
        await apply(s);
        const product = (await s.store.listProducts())[0];
        const offer = (await s.store.listOffers())[0];
        const newProduct = { ...product, id: 'test:new-product', vehicleAssetId: null, commercialType: 'NEW_RENT' };
        const newOffer = { ...offer, id: 'test:new-offer', productId: newProduct.id };
        await s.store.seed({ products: [newProduct], offers: [newOffer] });
        const before = stableDigest({ products: await s.store.listProducts(), offers: await s.store.listOffers() });
        const result = await queryCanonicalProducts(s.store, { supplierName: '웰릭스', vehicleName: '시험모델' });
        expect(result.matchedProducts).toBe(2);
        const row = result.results.find(x => x.productId === newProduct.id);
        expect(row.vehicleAsset).toBeNull();
        expect(row.product).toEqual(newProduct);
        expect(row.offer).toEqual(newOffer);
        expect(row.terms).toHaveLength(3);
        expect(row.photos).toMatchObject({ state: 'UNKNOWN', count: null, references: null });
        expect(row.unknownFields).toContain('photos');
        expect((await queryCanonicalProducts(s.store, { productId: newProduct.id })).matchedProducts).toBe(1);
        expect((await queryCanonicalProducts(s.store, { supplierName: '없는공급사' })).matchedProducts).toBe(0);
        expect((await queryCanonicalProducts(s.store, { plate: 'TEST-FAKE-001', supplierName: '웰릭스' })).matchedProducts).toBe(1);
        expect(stableDigest({ products: await s.store.listProducts(), offers: await s.store.listOffers() })).toBe(before);
    });
    it('keeps a stored product visible when offer and vehicle links are unconfirmed', async () => {
        const s = await stores();
        await apply(s);
        const product = (await s.store.listProducts())[0];
        await s.store.seed({ products: [{ ...product, id: 'test:unconfirmed', vehicleModelId: 'test:missing', vehicleAssetId: null }] });
        const result = await queryCanonicalProducts(s.store, { productId: 'test:unconfirmed' });
        expect(result.matchedProducts).toBe(1);
        expect(result.results[0]).toMatchObject({ offer: null, vehicleModel: null, policy: null, terms: [] });
        expect(result.results[0].priceTermsState).toBe('UNKNOWN');
        const filtered = await queryCanonicalProducts(s.store, { supplierName: '없는공급사' });
        expect(filtered.supplierTermResolved).toBe(false);
        expect(filtered.unresolvedSupplierProducts).toBe(1);
        expect(result.results[0].unknownFields).toEqual(expect.arrayContaining(['vehicleModel', 'offer', 'photos', 'priceTerms']));
        await expect(queryCanonicalProducts(s.store, { vehicleName: ' ' })).rejects.toThrow('INVALID_PRODUCT_SEARCH');
        await expect(queryCanonicalProducts(s.store, { unrecognized: 'test' })).rejects.toThrow('INVALID_PRODUCT_SEARCH');
    });
    it('resolves registered suppliers even when their active sheet tab is absent', async () => {
        const s = await stores();
        await apply(s);
        const offer = (await s.store.listOffers())[0];
        await s.store.seed({ offers: [{ ...offer, supplierId: 'RP011' }] });
        const result = await queryCanonicalProducts(s.store, { supplierName: '연카' });
        expect(result.supplierTermResolved).toBe(true);
        expect(result.matchedProducts).toBe(1);
    });
    it.each([
        { state: 'UNKNOWN', tampered: false }, { state: 'NOT_APPLICABLE', tampered: false },
        { state: 'UNKNOWN', tampered: true }, { state: 'NOT_APPLICABLE', tampered: true },
    ])('preserves unresolved $state and rejects readback mutation: $tampered', async ({ state, tampered }) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const offer = (await s.store.listOffers())[0];
            const fee = { state, amount: null, calculation: null, ruleId: null,
                sourceRefs: [], reasonCode: 'test:original-unresolved' };
            offer.internalEconomicsTerms[0].channelPayoutFee = structuredClone(fee);
            await s.store.seed({ offers: [offer] });
            const p = await planSharedSheetCanonical(s.store, later(capture({ '1개월': 777 })), 'synthetic-target', undefined, false, true);
            if (tampered) {
                const readOffer = s.store.getOffer.bind(s.store);
                const readReceipt = s.store.getReviewedSourceChangeReceipt.bind(s.store);
                vi.spyOn(s.store, 'getOffer').mockImplementation(async (id) => {
                    const current = await readOffer(id);
                    if (current && await readReceipt(p.plan.entries[0].change.idempotencyKey))
                        current.internalEconomicsTerms[0].channelPayoutFee = { state: 'KNOWN',
                            amount: { amount: 123, currency: 'KRW' }, calculation: { kind: 'FIXED', amount: { amount: 123, currency: 'KRW' } },
                            ruleId: 'test:injected-rule', policyId: 'test:injected-policy', sourceRefs: ['test:injected-source'] };
                    return current;
                });
            }
            const result = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
                plan: p.plan, expectedPlanDigest: p.report.planDigest });
            expect(result.report).toMatchObject({ status: tampered ? 'HOLD' : 'APPLIED',
                reconciliation: { readbackMismatches: tampered ? 1 : 0 } });
            expect((await s.store.listOffers())[0].internalEconomicsTerms[0].channelPayoutFee).toEqual(fee);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it.each(['unchanged', 'amount', 'rate', 'base', 'vat', 'total', 'source', 'policy', 'rule'])('verifies the exact vehicle-price fee snapshot after rent refresh: %s', async (scenario) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const offer = (await s.store.listOffers())[0];
            const fee = { state: 'KNOWN', amount: { currency: 'KRW', amount: 300000 },
                calculation: { kind: 'RATE', base: 'VEHICLE_PRICE', rate: 0.01 },
                ruleId: 'test:confirmed-vehicle-rule', policyId: 'test:confirmed-policy', sourceRefs: ['test:confirmed-source'] };
            offer.internalEconomicsTerms[0].channelPayoutFee = structuredClone(fee);
            await s.store.seed({ offers: [offer] });
            const p = await planSharedSheetCanonical(s.store, later(capture({ '1개월': 777 })), 'synthetic-target', undefined, false, true);
            if (scenario !== 'unchanged') {
                const readOffer = s.store.getOffer.bind(s.store);
                const readReceipt = s.store.getReviewedSourceChangeReceipt.bind(s.store);
                vi.spyOn(s.store, 'getOffer').mockImplementation(async (id) => {
                    const current = await readOffer(id);
                    if (current && await readReceipt(p.plan.entries[0].change.idempotencyKey)) {
                        const changed = current.internalEconomicsTerms[0].channelPayoutFee;
                        if (scenario === 'amount')
                            changed.amount.amount++;
                        if (scenario === 'rate' && changed.calculation?.kind === 'RATE')
                            changed.calculation.rate = 0.02;
                        if (scenario === 'base' && changed.calculation?.kind === 'RATE')
                            changed.calculation.base = 'MONTHLY_RENT_X_TERM';
                        if (scenario === 'vat')
                            changed.vatAmount = 123;
                        if (scenario === 'total')
                            changed.totalAmount = 123;
                        if (scenario === 'source')
                            changed.sourceRefs = ['test:changed-source'];
                        if (scenario === 'policy')
                            changed.policyId = 'test:changed-policy';
                        if (scenario === 'rule')
                            changed.ruleId = 'test:changed-rule';
                    }
                    return current;
                });
            }
            const result = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
                plan: p.plan, expectedPlanDigest: p.report.planDigest });
            expect(result.report).toMatchObject({ status: scenario === 'unchanged' ? 'APPLIED' : 'HOLD',
                reconciliation: { readbackMismatches: scenario === 'unchanged' ? 0 : 1 } });
            expect((await s.store.listOffers())[0].internalEconomicsTerms[0].channelPayoutFee).toEqual(fee);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('records a fresh unchanged observation without changing product or offer revisions', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const before = stableDigest({ products: await s.store.listProducts(), offers: await s.store.listOffers() });
            const p = await planSharedSheetCanonical(s.store, later(capture()), 'synthetic-target', undefined, false, true);
            const result = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
                plan: p.plan, expectedPlanDigest: p.report.planDigest });
            expect(result.report).toMatchObject({ status: 'APPLIED', committed: 0, noChange: 1 });
            expect(stableDigest({ products: await s.store.listProducts(), offers: await s.store.listOffers() })).toBe(before);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('pins the operational refresh decision and rejects fence tampering before RAW intake', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const p = await planSharedSheetCanonical(s.store, later(capture()), 'synthetic-target', undefined, false, true);
            const tampered = structuredClone(p.plan);
            tampered.entries[0].change.operationalRefresh.maxObservationAgeSeconds = 1800;
            await expect(runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
                plan: tampered, expectedPlanDigest: p.report.planDigest })).rejects.toThrow();
            expect(await s.source.getRun(p.plan.runId)).toBeNull();
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('routes scheduled status and rent refresh through the pinned operational writer', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const c = later(capture({ 차량상태: '출고불가', '1개월': 777 }));
            const p = await planSharedSheetCanonical(s.store, c, 'synthetic-target', undefined, false, true);
            expect(p.plan.operationalRefresh).toBe(true);
            expect(p.plan.entries[0].action).toBe('CHANGE');
            expect(p.plan.entries[0].change.operationalRefresh).toMatchObject({ maxObservationAgeSeconds: 3600 });
            const result = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
                plan: p.plan, expectedPlanDigest: p.report.planDigest });
            expect(result.report).toMatchObject({ status: 'APPLIED' });
            expect((await s.store.listProducts())[0].status).toBe('HOLD');
            expect((await s.store.listOffers())[0].priceTerms.find(x => x.termMonths === 1).monthlyRent.amount).toBe(777);
            expect((await s.store.listOffers())[0].internalEconomicsTerms.find(x => x.termMonths === 1).supplierBillingFee.amount.amount).toBe(39);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('rejects an operational observation older than the operational observation limit (3600 s; the sealed master no longer expires in flight) without changing Canonical', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const before = stableDigest(await s.store.listOffers());
            const p = await planSharedSheetCanonical(s.store, later(capture({ '1개월': 777 })), 'synthetic-target', undefined, false, true);
            vi.setSystemTime(new Date('2026-10-04T01:15:01.000Z'));
            const result = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
                plan: p.plan, expectedPlanDigest: p.report.planDigest });
            expect(result.report).toMatchObject({ status: 'PARTIAL_HOLD', committed: 0, held: 1 });
            expect(JSON.stringify(result.report)).toMatch(/REVIEWED_SOURCE_CHANGE_REJECTED/);
            expect(stableDigest(await s.store.listOffers())).toBe(before);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('refreshes status/rent when stored source facts differ only by normalizer ruleVersion, but still holds a real fact change', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const asset = (await s.store.listVehicleAssets())[0];
            const old = structuredClone(asset);
            old.sourceVehicleFacts.ruleVersion = 'shared-sheet-normalizer/0';
            for (const [key, fact] of Object.entries(old.sourceVehicleFacts.fields))
                if (key !== 'supplierStatus')
                    fact.ruleVersion = 'shared-sheet-normalizer/0';
            delete old.sourceVehicleFacts.fields.vehicleIdentitySource;
            await s.store.seed({ vehicleAssets: [old] });
            const p = await planSharedSheetCanonical(s.store, later(capture({ '1개월': 777 })), 'synthetic-target', undefined, false, true);
            const r1 = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
                plan: p.plan, expectedPlanDigest: p.report.planDigest });
            expect(r1.report).toMatchObject({ committed: 1, held: 0 });
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('readback compares an unchanged-rent term with its pre-run economics, not a recompute under a newer fee policy', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const offer = structuredClone((await s.store.listOffers())[0]);
            const older = structuredClone(offer.internalEconomicsTerms);
            for (const t of offer.internalEconomicsTerms)
                for (const side of ['supplierBillingFee', 'channelPayoutFee']) {
                    if (t[side]?.sourceRefs)
                        t[side].sourceRefs = [...t[side].sourceRefs, 'older-policy-evidence'];
                }
            await s.store.seed({ offers: [offer] });
            const p = await planSharedSheetCanonical(s.store, later(capture({ '1개월': 777 })), 'synthetic-target', undefined, false, true);
            const r = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
                plan: p.plan, expectedPlanDigest: p.report.planDigest });
            expect(r.report.reconciliation?.readbackMismatches ?? 0).toBe(0);
            expect(older).toBeDefined();
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('holds, at plan time, a vehicle whose refresh also changes an odometer, instead of aborting the apply run', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const p = await planSharedSheetCanonical(s.store, later(capture({ '1개월': 777, 주행거리: '99,999km' })), 'synthetic-target', undefined, false, true);
            const entry = p.plan.entries[0];
            expect(entry.action).toBe('HOLD');
            expect(entry.reasons).toContain('OPERATIONAL_REFRESH_UNSUPPORTED_CHANGE:SOURCE_ODOMETER_CHANGE');
            expect(entry.change).toBeUndefined();
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('operational refresh applies a plausible odometer increase together with status/rent and updates the asset', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const p = await planSharedSheetCanonical(s.store, later(capture({ '1개월': 777, 주행거리: '5,000km' })), 'synthetic-target', undefined, false, true);
            expect(p.plan.entries[0].action).toBe('CHANGE');
            const r = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true, plan: p.plan, expectedPlanDigest: p.report.planDigest });
            expect(r.report).toMatchObject({ committed: 1, held: 0 });
            expect((await s.store.listVehicleAssets())[0].odometerKm).toBe(5000);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('operational refresh holds an odometer decrease at plan time (anomaly) and leaves the stored value', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const p = await planSharedSheetCanonical(s.store, later(capture({ '1개월': 777, 주행거리: '900km' })), 'synthetic-target', undefined, false, true);
            expect(p.plan.entries[0].action).toBe('HOLD');
            expect(p.plan.entries[0].reasons).toContain('OPERATIONAL_REFRESH_UNSUPPORTED_CHANGE:SOURCE_ODOMETER_CHANGE');
            expect((await s.store.listVehicleAssets())[0].odometerKm).toBe(1234);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('preserves human rent through the actual scheduled plan and apply path', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-04T00:15:00.000Z'));
        try {
            const s = await stores();
            await apply(s);
            const offer = (await s.store.listOffers())[0];
            const edited = structuredClone(offer);
            edited.priceTerms[0].monthlyRent.amount = 999;
            await s.store.seed({ offers: [edited] });
            const c = later(capture({ '1개월': 777 }));
            const p = await planSharedSheetCanonical(s.store, c, 'synthetic-target', undefined, false, true);
            const result = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
                plan: p.plan, expectedPlanDigest: p.report.planDigest });
            expect(result.report).toMatchObject({ status: 'PARTIAL_HOLD', committed: 0, held: 1 });
            expect(result.report).toHaveProperty('rejectedByCode');
            expect(result.report).toHaveProperty('rejectedByReason');
            expect((await s.store.getOffer(offer.id)).priceTerms[0].monthlyRent.amount).toBe(999);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('pins color refinement in the reviewed plan and persists its candidate facts through existing intake', async () => {
        const s = await stores(), c = capture({ 외부색상: '흰색', 내부색상: '검정' });
        const normal = await planSharedSheetCanonical(s.store, c, 'synthetic-target');
        expect(normal.plan.ruleVersion).toBe('shared-sheet-normalizer/7');
        const p = await planSharedSheetCanonical(s.store, c, 'synthetic-target', undefined, true);
        expect(p.plan.ruleVersion).toBe('shared-sheet-normalizer/8');
        expect(p.plan.includeSupplierColors).toBe(true);
        const applied = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
            plan: p.plan, expectedPlanDigest: p.report.planDigest });
        expect(applied.report).toMatchObject({ status: 'APPLIED' });
        const assets = await s.store.listVehicleAssets();
        expect(assets[0].sourceVehicleFacts.fields.exteriorColor).toMatchObject({ state: 'KNOWN', value: '흰색' });
        const candidates = await s.source.listCandidates(p.plan.runId);
        expect(candidates[0].candidate.vehicleFacts.fields.exteriorColor).toMatchObject({ state: 'KNOWN', value: '흰색' });
        const changed = { ...p.plan };
        delete changed.includeSupplierColors;
        await expect(runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
            plan: changed, expectedPlanDigest: stableDigest(changed) })).rejects.toThrow('SHARED_SHEET_PLAN_REQUIRED_OR_CHANGED');
    });
    it('does not rewrite completed v5 source candidates with color v6', async () => {
        const s = await stores(), c = capture({ 외부색상: '흰색' });
        await apply(s, c);
        await expect(planSharedSheetCanonical(s.store, c, 'synthetic-target', undefined, true))
            .rejects.toThrow('SUPPLIER_COLOR_REFINEMENT_REQUIRES_NEW_SOURCE_RUN');
        const old = await s.source.listCandidates(prepareRawSourceBatch(buildSharedSheetBatch(c)).runId);
        expect(old[0].candidate.vehicleFacts.fields.exteriorColor).toBeUndefined();
        const fresh = await planSharedSheetCanonical(s.store, later(capture({ 외부색상: '흰색' })), 'synthetic-target', undefined, true);
        expect(fresh.plan.ruleVersion).toBe('shared-sheet-normalizer/8');
    });
    it.each([0, '0', '', '미확인', '협의'])('holds short deposit %j without inventing zero; preserves long-term evidence', value => {
        const n = normalized(capture({ 단기보증: value }));
        expect(n.record.candidate.priceTerms.filter(t => t.termMonths <= 12).every(t => t.depositState === 'UNKNOWN' && !t.deposit)).toBe(true);
        expect(n.record.candidate.priceTerms.find(t => t.termMonths === 24)?.deposit?.amount).toBe(202);
        expect(n.record.status).toBe('REJECTED');
    });
    it('does not waive forbidden supplier deposits, including explicit waiver text', () => {
        const raw = prepareRawSourceBatch(buildSharedSheetBatch(capture({ 단기보증: '무보증' }))).rawRecords[0];
        raw.payload.supplierCode = 'RP012';
        expect(normalizeSharedSheet(raw).record.candidate.priceTerms[0].depositState).toBe('UNKNOWN');
    });
    it('creates only supplied periods and maps short/long deposits exactly', () => {
        const n = normalized(capture({ '6개월': '-', '36개월': '불가', '48개월': '' }));
        expect(n.record.candidate.priceTerms.map(x => [x.termMonths, x.deposit?.amount])).toEqual([[1, 101], [12, 101], [24, 202]]);
        expect(n.suppliedTerms).toBe(3);
    });
    it('preserves overlapping master/year/deposit HOLDs by source row and term without borrowing long deposit', () => {
        const c = capture({ 단기보증: '', 연식: '24MY' });
        const raw = prepareRawSourceBatch(buildSharedSheetBatch(c)).rawRecords[0];
        const before = structuredClone(raw);
        const evidence = masterEvidence();
        evidence.records.push({ ...structuredClone(evidence.records[0]), trimId: 'another-immutable-trim' });
        const n = normalizeSharedSheet(raw, evidence);
        expect(n.record.status).toBe('REJECTED');
        expect(n.record.candidate.issues).toEqual(expect.arrayContaining([
            'IDENTITY_NOT_UNIQUE_MASTER', 'YEAR_REGISTRATION_MISMATCH',
            'DEPOSIT_REVIEW_REQUIRED:m12:MISSING_DEPOSIT_AMOUNT',
        ]));
        expect(n.record.sourceRecordId).toBe(raw.sourceRecordId);
        expect(n.record.candidate.priceTerms.find(t => t.termKey === 'm12')).toMatchObject({ depositState: 'UNKNOWN' });
        expect(n.record.candidate.priceTerms.find(t => t.termKey === 'm12')).not.toHaveProperty('deposit');
        expect(n.record.candidate.priceTerms.find(t => t.termKey === 'm24')).toMatchObject({
            depositState: 'KNOWN', deposit: { amount: 202, currency: 'KRW' },
        });
        expect(n.lineage.find(l => l.normalized?.fieldPath === 'priceTerms.m12.depositState')).toMatchObject({
            sourceRecordId: raw.sourceRecordId, source: { value: '' }, normalized: { value: 'UNKNOWN' },
        });
        expect(raw).toEqual(before);
    });
    it('normalizes model year, month precision, specs and explicit zero', () => {
        const n = normalized(capture({ 단기보증: '무보증', 배터리용량: '77.7kWh', 구동방식: 'FWD' }));
        const f = n.record.candidate.vehicleFacts.fields;
        expect(f.modelYear.value).toBe(2026);
        expect(f.firstRegistration.value).toBe('2026-04');
        expect(f.displacementCc.value).toBe(1234);
        expect(f.batteryKwh.value).toBe(77.7);
        expect(f.drive.value).toBe('2WD');
        expect(n.record.candidate.priceTerms[0].depositState).toBe('ZERO');
    });
    it('keeps both supplier colors as distinct source facts with cell lineage and immutable RAW', () => {
        const c = capture({ 외부색상: '  펄 화이트  ', 내부색상: '블랙/브라운' });
        const raw = prepareRawSourceBatch(buildSharedSheetBatch(c)).rawRecords[0];
        const before = structuredClone(raw);
        const n = normalizeSharedSheet(raw, masterEvidence(), { includeSupplierColors: true });
        expect(n.record.candidate.vehicleFacts.fields.exteriorColor).toMatchObject({ value: '펄 화이트', state: 'KNOWN', evidence: '펄 화이트' });
        expect(n.record.candidate.vehicleFacts.fields.interiorColor).toMatchObject({ value: '블랙/브라운', state: 'KNOWN' });
        expect(n.lineage.find(l => l.normalized?.fieldPath === 'vehicleFacts.fields.exteriorColor')).toMatchObject({
            source: { value: '  펄 화이트  ' }, normalized: { value: { value: '펄 화이트', state: 'KNOWN' } }
        });
        expect(raw).toEqual(before);
    });
    it('does not borrow exterior color for empty interior color or guess a review placeholder', () => {
        const c = capture({ 외부색상: '확인 필요', 내부색상: '' });
        const raw = prepareRawSourceBatch(buildSharedSheetBatch(c)).rawRecords[0];
        const n = normalizeSharedSheet(raw, masterEvidence(), { includeSupplierColors: true });
        expect(n.record.candidate.vehicleFacts.fields.exteriorColor).toMatchObject({ value: null, state: 'REVIEW_REQUIRED' });
        expect(n.record.candidate.vehicleFacts.fields.interiorColor).toMatchObject({ value: null, state: 'MISSING' });
        expect(n.record.candidate.issues).not.toContain('INVALID_EXTERIORCOLOR');
        expect(n.record.status).toBe('VALID');
        const old = normalizeSharedSheet(raw, masterEvidence());
        expect(old.record.candidate.vehicleFacts.ruleVersion).toBe('shared-sheet-normalizer/7');
        expect(old.record.candidate.vehicleFacts.fields).not.toHaveProperty('exteriorColor');
    });
    // 소수 칸 표시 형식 «0.###"kWh"»는 정수를 «22.kWh»로 보인다(2026-10-04 서식 통일) — 같은 값. 점 두 개·글자는 여전히 거부.
    it.each([['22.kWh', 22], ['54.kWh', 54], ['77.4kWh', 77.4], ['84kWh', 84]])('battery %s → %s', (shown, value) => expect(normalized(capture({ 배터리용량: shown })).record.candidate.vehicleFacts.fields.batteryKwh.value).toBe(value));
    it.each(['22..kWh', '.5kWh', '약 70kWh'])('battery %s stays invalid', shown => expect(JSON.stringify(normalized(capture({ 배터리용량: shown })))).toContain('INVALID_BATTERYKWH'));
    it.each(['26년식', '2026'])('accepts explicit year %s', value => expect(normalized(capture({ 연식: value })).record.candidate.vehicleFacts.fields.modelYear.value).toBe(2026));
    it('distinguishes company codes inside a shared tab', () => {
        const c = capture({}, '빌린카'), tab = c.tabs.find(x => x.title === '빌린카');
        tab.values.push(row('엘씨'));
        tab.rowCount++;
        const records = buildSharedSheetBatch(c).records;
        expect(records.map(x => x.payload.supplierCode)).toEqual(['RP021', 'PT-0026']);
        expect(records[0].sourceRecordId).not.toBe(records[1].sourceRecordId);
    });
    it('preserves all RAW cells without mutation and pins read time/revision/digest', async () => {
        const c = capture({ 비고: ' SYNTHETIC RAW ONLY ' });
        const before = structuredClone(c);
        const s = await stores();
        const p = await apply(s, c);
        expect(c).toEqual(before);
        const raw = (await s.source.listRaw(p.plan.runId))[0];
        expect(raw.payload.values).toEqual(c.tabs[0].values[1]);
        expect(raw.payload.rowDigest).toBe(stableDigest(raw.payload.values));
        expect(raw.observedAt).toBe(time);
        expect(raw.sourceRevision).toBe('synthetic-revision-1');
        await expect(s.source.appendRaw(raw)).rejects.toThrow('immutable');
        const f = (await s.store.listVehicleAssets())[0].sourceVehicleFacts;
        expect(f.fields.modelYear.evidence).toBe('26MY');
        expect((await s.store.listLineageByStage('NORMALIZED_TO_CANONICAL')).some(x => x.canonical?.fieldPath === 'sourceVehicleFacts')).toBe(true);
    });
    it('dry-run performs zero writes on either supplied store', async () => {
        const s = await stores();
        const tx = vi.spyOn(s.store, 'transact');
        const mutations = ['upsertSource', 'beginRun', 'appendRaw', 'appendCandidate', 'appendLineage', 'completeRun', 'failRun'];
        const spies = mutations.map(m => vi.spyOn(s.source, m));
        const result = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', capture: capture() });
        expect(result.report).toMatchObject({ writes: 0, reconciliation: { suppliedTerms: 3, economicsTerms: 3, equal: true } });
        expect(tx).not.toHaveBeenCalled();
        for (const spy of spies)
            expect(spy).not.toHaveBeenCalled();
        expect(JSON.stringify(result.report)).not.toContain('TEST-FAKE');
    });
    it('commits economics for every term; unresolved fee is null, not zero', async () => {
        const s = await stores();
        const p = await apply(s, capture({ '6개월': 600 }));
        expect(p.result.report).toMatchObject({ status: 'APPLIED', committed: 1 });
        const offer = (await s.store.listOffers())[0];
        expect(offer.internalEconomicsTerms).toHaveLength(offer.priceTerms.length);
        const unknown = offer.internalEconomicsTerms.flatMap(x => [x.supplierBillingFee, x.channelPayoutFee]).filter(x => x.state === 'UNKNOWN');
        expect(unknown.length).toBeGreaterThan(0);
        expect(unknown.every(x => x.amount === null)).toBe(true);
    });
    it('replays exact plan without new Canonical revisions, RAW or audit', async () => {
        const s = await stores();
        const p = await apply(s);
        const before = { audits: s.store.audits.length, revisions: (await s.store.listRevisionHistory()).length, raws: (await s.source.listRaw(p.plan.runId)).length };
        const again = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true, plan: p.plan, expectedPlanDigest: p.report.planDigest });
        expect(again.report).toMatchObject({ status: 'APPLIED', committed: 0, noChange: 1 });
        expect({ audits: s.store.audits.length, revisions: (await s.store.listRevisionHistory()).length, raws: (await s.source.listRaw(p.plan.runId)).length }).toEqual(before);
    });
    it('holds a later displacement contradiction without changing saved facts or economics', async () => {
        const s = await stores();
        const first = await apply(s);
        const next = await apply(s, later(capture({ '12개월': 606, 배기량: '1,235cc' })));
        expect(next.plan.entries[0].action).toBe('HOLD');
        expect((await s.store.listOffers())[0].revision).toBe(1);
        expect((await s.store.listVehicleAssets())[0].sourceVehicleFacts.fields.displacementCc.value).toBe(1234);
        expect((await s.store.listVehicleAssets())[0].sourceFirstRunId).toBe(first.plan.runId);
        expect((await s.source.listRaw(first.plan.runId))[0].payload.values).toEqual(capture().tabs[0].values[1]);
    });
    it('a later status change (even HOLD→HOLD with a different asset state) is held, not silently diverged', async () => {
        const s = await stores();
        await apply(s, capture({ 차량상태: '상품화중' }));
        const next = await planSharedSheetCanonical(s.store, later(capture({ 차량상태: '계약중' })), 'synthetic-target');
        expect(next.plan.entries[0]).toMatchObject({ action: 'HOLD', reasons: expect.arrayContaining(['STATUS_CHANGE_REQUIRES_REVIEW']) });
    });
    it('two sources racing on the same plate: the second CREATE meets the plate asset inside the transaction', async () => {
        const s = await stores();
        const other = { ...capture(), spreadsheetId: 'synthetic-sheet-2' };
        const p1 = await planSharedSheetCanonical(s.store, capture(), 'synthetic-target');
        const p2 = await planSharedSheetCanonical(s.store, other, 'synthetic-target');
        expect(p1.plan.entries[0].create.decision.vehicleAsset.id).toBe(p2.plan.entries[0].create.decision.vehicleAsset.id);
        await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true, plan: p1.plan, expectedPlanDigest: p1.report.planDigest });
        const second = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true, plan: p2.plan, expectedPlanDigest: p2.report.planDigest })
            .catch((e) => ({ error: e.message }));
        expect(second).toEqual({ error: 'SHARED_SHEET_PLAN_STALE' });
        expect(await s.store.listVehicleAssets()).toHaveLength(1);
    });
    it('never creates a second asset for a plate that already has one (even without offers)', async () => {
        const s = await stores();
        await s.store.seed({ vehicleAssets: [{ id: 'va_existing', vehicleModelId: 'vm_existing', status: 'AVAILABLE', plateNumber: 'TEST-FAKE-001',
                    revision: 1, createdAt: time, updatedAt: time }] });
        const p = await planSharedSheetCanonical(s.store, capture(), 'synthetic-target');
        expect(p.plan.entries[0]).toMatchObject({ action: 'HOLD', reasons: expect.arrayContaining(['EXISTING_ASSET_REQUIRES_REVIEW']) });
    });
    it('HOLDs refinement order violations and preserves missing upstream cells', async () => {
        const c = capture({ 모델: '' });
        const n = normalized(c);
        expect(n.record.candidate.issues).toContain('REFINEMENT_ORDER_VIOLATION');
        expect(n.record.candidate.subModel).toBeUndefined();
        expect(n.record.candidate.trimName).toBeUndefined();
        const s = await stores();
        const p = await apply(s, c);
        expect(p.result.report).toMatchObject({ status: 'PARTIAL_HOLD', held: 1 });
        expect(await s.store.listOffers()).toHaveLength(0);
        expect(await s.source.listRaw(p.plan.runId)).toHaveLength(1);
    });
    it.each([{ 최초등록일: '26.02.30' }, { 최초등록일: '24.04' }, { '12개월': '협의' }, { 단기보증: '10~20' }])('HOLDs ambiguous values without guessing', data => {
        expect(normalized(capture(data)).record.status).toBe('REJECTED');
    });
    it('rejects missing tabs, reordered headers and wrong digest; a malformed row is quarantined, not the batch', () => {
        const a = capture();
        a.tabs.pop();
        expect(() => buildSharedSheetBatch(a)).toThrow();
        const b = capture();
        b.tabs[0].values[0].reverse();
        expect(() => buildSharedSheetBatch(b)).toThrow();
        const c = capture();
        c.tabs[0].values[1].pop();
        c.tabs[0].values.push(row('웰릭스', { 차량번호: 'TEST-FAKE-009' }));
        c.tabs[0].rowCount++;
        c.digest = sharedSheetCaptureDigest(c);
        const rc = prepareRawSourceBatch(buildSharedSheetBatch(c)).rawRecords.map(r => normalizeSharedSheet(r));
        expect(rc.map(x => x.record.candidate.issues.includes('ROW_SHAPE_INVALID')).sort()).toEqual([false, true]);
        const d = capture();
        d.digest = 'wrong';
        expect(() => buildSharedSheetBatch(d)).toThrow();
        const e = capture();
        delete e.revision;
        e.digest = sharedSheetCaptureDigest(e);
        expect(buildSharedSheetBatch(e).records).toHaveLength(1);
    });
    it('quarantines every row of a duplicate supplier/plate identity and keeps the rest', () => {
        const c = capture();
        c.tabs[0].values.push(row('웰릭스', { 차량번호: ' test-fake-001 ' }), row('웰릭스', { 차량번호: 'TEST-FAKE-002' }));
        c.tabs[0].rowCount += 2;
        c.digest = sharedSheetCaptureDigest(c);
        const batch = buildSharedSheetBatch(c);
        expect(new Set(batch.records.map(r => r.sourceRecordId)).size).toBe(3);
        const issues = prepareRawSourceBatch(batch).rawRecords.map(r => normalizeSharedSheet(r)).map(x => x.record.candidate.issues.includes('DUPLICATE_IDENTITY'));
        expect(issues.filter(Boolean)).toHaveLength(2);
        expect(issues).toHaveLength(3);
    });
    it('stores every sheet status; only 출고가능/즉시출고 are exposed, an unlisted status is held', async () => {
        for (const [status, product, asset] of [['출고가능', 'ACTIVE', 'AVAILABLE'], ['출고불가', 'HOLD', 'RESERVED'], ['상품화중', 'HOLD', 'MAINTENANCE']]) {
            const s = await stores();
            const p = await planSharedSheetCanonical(s.store, capture({ 차량상태: status }), 'synthetic-target');
            expect(p.plan.entries[0]).toMatchObject({ action: 'CREATE', create: { decision: { productStatus: product, vehicleAsset: { status: asset } } } });
        }
        const s = await stores();
        for (const unlisted of ['알수없음', 'constructor', '__proto__', 'toString']) {
            const held = await planSharedSheetCanonical(s.store, capture({ 차량상태: unlisted }), 'synthetic-target');
            expect(held.plan.entries[0].action).toBe('HOLD');
        }
    });
    it('rejects missing/tampered plans and ownership before intake', async () => {
        const s = await stores();
        const begin = vi.spyOn(s.source, 'beginRun');
        await expect(runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true })).rejects.toThrow();
        const p = await planSharedSheetCanonical(s.store, capture(), 'synthetic-target');
        p.plan.entries[0].create.decision.supplierId = 'FAKE-CODE';
        await expect(runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true, plan: p.plan, expectedPlanDigest: stableDigest(p.plan) })).rejects.toThrow('PLAN_STALE');
        const p2 = await planSharedSheetCanonical(s.store, capture(), 'synthetic-target');
        await s.store.seed({ catalogWriterOwnership: null });
        await expect(runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true, plan: p2.plan, expectedPlanDigest: p2.report.planDigest })).rejects.toThrow('EXCLUSIVE_WRITER');
        expect(begin).not.toHaveBeenCalled();
    });
    it('HOLDs period shape changes through existing structural review', async () => {
        const s = await stores();
        await apply(s);
        const p = await planSharedSheetCanonical(s.store, later(capture({ '36개월': 707 })), 'synthetic-target');
        expect(p.plan.entries[0].action).toBe('HOLD');
    });
    it('query returns saved values using reads only', async () => {
        const s = await stores();
        await apply(s);
        const tx = vi.spyOn(s.store, 'transact');
        const result = await queryCanonicalByPlate(s.store, ' test-fake-001 ');
        expect(result.matchedAssets).toBe(1);
        expect(result.results[0].terms).toHaveLength(3);
        expect(result.results[0].vehicle.facts.fields.modelYear.value).toBe(2026);
        expect(tx).not.toHaveBeenCalled();
        expect(result).toMatchObject({ authority: 'STORED_CANONICAL', schema: 'freepass-data.internal-canonical-query/v1' });
        expect(result.results[0]).toHaveProperty('offerId');
    });
    it('direct query refuses stale stored economics without recalculating or writing', async () => {
        const s = await stores();
        await apply(s);
        const offer = (await s.store.listOffers())[0];
        offer.internalEconomicsTerms[0].monthlyRent = { amount: 999999, currency: 'KRW' };
        await s.store.seed({ offers: [offer] });
        const tx = vi.spyOn(s.store, 'transact');
        const result = await queryCanonicalByPlate(s.store, 'TEST-FAKE-001');
        expect(result.results[0].terms[0].supplierBillingFee).toMatchObject({ state: 'UNKNOWN', amount: null,
            vatAmount: null, totalAmount: null, reasonCode: 'MONTHLY_RENT_MISMATCH', status: 'UNCONFIRMED' });
        expect(result.results[0].terms[0].channelPayoutFee.amount).toBeNull();
        expect(tx).not.toHaveBeenCalled();
    });
    it('rejects unsafe direct CLI configuration and empty identity before Firebase access', async () => {
        await expect(queryFirestoreByPlate('')).rejects.toThrow('PLATE_REQUIRED');
        await expect(queryMain(['--direct', '--memory', '--plate-file', 'synthetic', '--local-output', 'synthetic']))
            .rejects.toThrow('DIRECT_FIRESTORE_REQUIRED');
        await expect(queryMain(['--direct', '--firestore', '--plate-file', 'synthetic']))
            .rejects.toThrow('LOCAL_INPUT_OUTPUT_REQUIRED');
    });
    it('preserves older stored fee terms with optional price basis absent', async () => {
        const s = await stores();
        await apply(s);
        const offer = (await s.store.listOffers())[0];
        delete offer.internalEconomicsTerms[0].termMonths;
        delete offer.internalEconomicsTerms[0].monthlyRent;
        await s.store.seed({ offers: [offer] });
        const result = await queryCanonicalByPlate(s.store, 'TEST-FAKE-001');
        expect(result.results[0].feeContract).toBe('internal-fee-lookup/v1');
        expect(result.results[0].terms[0].supplierBillingFee.reasonCode).not.toBe('MONTHLY_RENT_MISMATCH');
        expect(result.results[0].terms[0].supplierBillingFee.reasonCode).not.toBe('TERM_MONTHS_MISMATCH');
    });
    it('keeps first observation from a previously held RAW row', async () => {
        const s = await stores();
        await apply(s, capture({ 세부트림: '' }));
        const next = await apply(s, later(capture()));
        expect(next.result.report).toMatchObject({ status: 'APPLIED' });
        expect((await s.source.listRaw(next.plan.runId))[0].firstObservedAt).toBe(time);
        expect((await s.store.listVehicleAssets())[0].sourceFirstObservedAt).toBe(time);
    });
    it('keeps RAW observation history through absence and reappearance without deletion', async () => {
        const s = await stores();
        await apply(s);
        const empty = later(capture());
        empty.tabs[0].values.pop();
        empty.tabs[0].rowCount--;
        await apply(s, empty);
        const c = later(capture());
        c.readTime = '2026-10-04T00:30:00.000Z';
        c.revision = 'synthetic-revision-3';
        for (const tab of c.tabs)
            tab.readTime = c.readTime;
        const p = await apply(s, c);
        expect((await s.source.listRaw(p.plan.runId))[0].firstObservedAt).toBe(time);
        expect(await s.store.listOffers()).toHaveLength(1);
    });
    it('rejects stale expectedRevision before RAW intake', async () => {
        const s = await stores();
        await apply(s);
        const p = await planSharedSheetCanonical(s.store, later(capture({ '12개월': 808 })), 'synthetic-target');
        const offer = (await s.store.listOffers())[0];
        await s.store.seed({ offers: [{ ...offer, revision: offer.revision + 1 }] });
        const begin = vi.spyOn(s.source, 'beginRun');
        await expect(runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
            plan: p.plan, expectedPlanDigest: p.report.planDigest })).rejects.toThrow('PLAN_STALE');
        expect(begin).not.toHaveBeenCalled();
    });
    it('checks planned ownership inside the Canonical transaction', async () => {
        const s = await stores();
        const original = s.store.transact.bind(s.store);
        vi.spyOn(s.store, 'transact').mockImplementationOnce(async (fn) => {
            const ownership = (await s.store.getCatalogWriterOwnership());
            await s.store.seed({ catalogWriterOwnership: { ...ownership, revision: 2, mode: 'SHARED_MIGRATION' } });
            return original(fn);
        });
        const result = await apply(s);
        expect(result.result.report).toMatchObject({ status: 'HOLD', reason: 'CANONICAL_COMMAND_REJECTED' });
        expect(await s.store.listOffers()).toHaveLength(0);
    });
    it('resumes a partial commit only with the same immutable plan and receipts', async () => {
        const s = await stores();
        const c = capture();
        c.tabs[0].values.push(row('웰릭스', { 차량번호: 'TEST-FAKE-002' }));
        c.tabs[0].rowCount++;
        const original = s.store.transact.bind(s.store);
        let calls = 0;
        const spy = vi.spyOn(s.store, 'transact').mockImplementation(async (fn) => {
            if (++calls === 2)
                throw new Error('SYNTHETIC_TRANSIENT');
            return original(fn);
        });
        const first = await apply(s, c);
        expect(first.result.report).toMatchObject({ status: 'HOLD', committed: 1 });
        spy.mockRestore();
        const retry = await runSharedSheetCanonical(s.store, s.source, { target: 'synthetic-target', apply: true,
            plan: first.plan, expectedPlanDigest: first.report.planDigest });
        expect(retry.report).toMatchObject({ status: 'APPLIED', committed: 1, noChange: 1,
            reconciliation: { stage: 'CANONICAL_READBACK', suppliedTerms: 6, storedTerms: 6, equal: true } });
        expect(await s.store.listOffers()).toHaveLength(2);
    });
    it('a later run that re-plans from fresh capture after a partial commit writes only the missing vehicle (no duplicates)', async () => {
        // 매일 박제는 부분 실패 뒤 «새 캡처 → 새 계획 → 적용» 으로 다시 돈다(이전 계획을 재사용하지 않는다) — #418 의 재시도 안전 근거.
        const s = await stores();
        const c = capture();
        c.tabs[0].values.push(row('웰릭스', { 차량번호: 'TEST-FAKE-002' }));
        c.tabs[0].rowCount++;
        const original = s.store.transact.bind(s.store);
        let calls = 0;
        const spy = vi.spyOn(s.store, 'transact').mockImplementation(async (fn) => {
            if (++calls === 2)
                throw new Error('SYNTHETIC_TRANSIENT');
            return original(fn);
        });
        const first = await apply(s, c);
        expect(first.result.report).toMatchObject({ status: 'HOLD', committed: 1 });
        spy.mockRestore();
        const offersAfterFirst = (await s.store.listOffers()).map(o => o.id).sort();
        expect(offersAfterFirst).toHaveLength(1);
        const second = await apply(s, c); // fresh plan from the same capture
        expect(second.result.report).toMatchObject({ status: 'APPLIED', committed: 1, noChange: 1 });
        const offersAfterSecond = (await s.store.listOffers()).map(o => o.id).sort();
        expect(offersAfterSecond).toHaveLength(2);
        expect(offersAfterSecond).toContain(offersAfterFirst[0]); // 이미 쓴 제안은 그대로(새 id·새 revision 없음)
        expect(new Set(offersAfterSecond).size).toBe(offersAfterSecond.length);
        const third = await apply(s, c); // 한 번 더: 아무것도 새로 쓰지 않는다
        expect(third.result.report).toMatchObject({ status: 'APPLIED', committed: 0, noChange: 2 });
        expect(await s.store.listOffers()).toHaveLength(2);
    });
    it('HOLDs explicit identity review labels without inferring a downstream trim', () => {
        const c = normalized(capture({ 세부모델: '확인 필요' })).record.candidate;
        expect(c.issues).toContain('VEHICLE_IDENTITY_REVIEW_REQUIRED');
        expect(c.trimName).toBeUndefined();
    });
    it('extracts only an explicit transmission phrase', () => {
        expect(normalized(capture({ '옵션 원문': '변속기: DCT; 합성 시험' })).record.candidate.vehicleFacts.fields.transmission.value).toBe('DCT');
        expect(normalized(capture({ '옵션 원문': '고급 자동 옵션' })).record.candidate.vehicleFacts.fields.transmission.value).toBeNull();
    });
    it('preserves tab-specific read times and rejects capture skew', () => {
        const c = capture();
        c.tabs[0].readTime = '2026-10-04T00:01:00.000Z';
        expect(buildSharedSheetBatch(c).records[0].payload.readTime).toBe(c.tabs[0].readTime);
        c.tabs[0].readTime = '2026-10-04T01:01:00.000Z';
        expect(() => buildSharedSheetBatch(c)).toThrow();
    });
    it('does not silently retain a previously known fact after source removal', async () => {
        const s = await stores();
        await apply(s);
        const p = await planSharedSheetCanonical(s.store, later(capture({ 연료: '' })), 'synthetic-target');
        expect(p.plan.entries[0].reasons).toContain('MISSING_PREVIOUSLY_KNOWN_FACT_REQUIRES_REVIEW');
        expect(p.plan.entries[0].action).toBe('HOLD');
    });
    it('does not create a duplicate supplier/plate through a second source', async () => {
        const s = await stores();
        await apply(s);
        const c = capture();
        c.spreadsheetId = 'synthetic-other-sheet';
        const p = await planSharedSheetCanonical(s.store, c, 'synthetic-target');
        expect(p.plan.entries[0].reasons).toContain('EXISTING_IDENTITY_REQUIRES_SOURCE_LINK');
        expect(p.plan.entries[0].action).toBe('HOLD');
    });
});
describe('shared sheet apply/output guards (Codex review)', () => {
    it('preflight rejects an apply without a reviewed plan before any store call', async () => {
        const store = new MemoryDataStore();
        const spy = vi.spyOn(store, 'getCatalogWriterOwnership');
        await expect(preflightSharedSheetApply(store, undefined, undefined, 'memory')).rejects.toThrow('SHARED_SHEET_PLAN_REQUIRED_OR_CHANGED');
        expect(spy).not.toHaveBeenCalled();
    });
    it('private output refuses this repository even when cwd is elsewhere, and accepts a temp dir', async () => {
        const cwd = process.cwd();
        const outside = await mkdtemp(join(tmpdir(), 'fp-private-'));
        try {
            process.chdir(outside);
            await expect(writePrivateArtifact(resolve(cwd, 'plan-leak.json'), {})).rejects.toThrow('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT');
            await expect(writePrivateArtifact(resolve(cwd, 'src', 'plan-leak.json'), {})).rejects.toThrow('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT');
            await expect(writePrivateArtifact(join(outside, 'plan.json'), { ok: true })).resolves.toBeUndefined();
        }
        finally {
            process.chdir(cwd);
        }
    });
});
it('requires a freshly re-read master before production apply and rejects changed content before ingestion', async () => {
    const s = await stores(), c = capture(), p = await planSharedSheetCanonical(s.store, c, 'freepasserp5');
    const spy = vi.spyOn(s.source, 'completeRun');
    await expect(runSharedSheetCanonical(s.store, s.source, { target: 'freepasserp5', apply: true,
        plan: p.plan, expectedPlanDigest: p.report.planDigest })).rejects.toThrow('CURRENT_VEHICLE_MASTER_REQUIRED_BEFORE_APPLY');
    const changed = structuredClone(c.vehicleMasterSnapshot);
    changed.trims[0].data.trim = '다른 트림';
    changed.digest = createHash('sha256').update(JSON.stringify({ readAt: changed.readAt, masters: changed.masters, trims: changed.trims })).digest('hex');
    await expect(runSharedSheetCanonical(s.store, s.source, { target: 'freepasserp5', apply: true,
        plan: p.plan, expectedPlanDigest: p.report.planDigest, currentVehicleMasterSnapshot: changed }))
        .rejects.toThrow('VEHICLE_MASTER_CHANGED_REPLAN_REQUIRED');
    expect(spy).not.toHaveBeenCalled();
});
it('does not fill names when an offline capture has no master evidence', async () => {
    const c = capture();
    delete c.vehicleMasterSnapshot;
    const p = await planSharedSheetCanonical(new MemoryDataStore(), c, 'synthetic-target');
    expect(p.plan.entries.every(x => x.action === 'HOLD' && x.reasons.includes('VEHICLE_MASTER_SNAPSHOT_REQUIRED'))).toBe(true);
});
describe('reviewed shared-sheet selection and live upstream fences', () => {
    const pin = 'a'.repeat(40);
    const selected = () => ({ runId: '123', attempt: '1', generation: '456', digest: 'b'.repeat(64), sourcePin: pin, executionPin: pin,
        run: { id: 123, run_attempt: 1, head_sha: pin, head_branch: 'main', event: 'workflow_dispatch', status: 'completed',
            conclusion: 'success', path: '.github/workflows/shared-sheet-daily.yml', display_title: 'shared-sheet-daily dry-run' } });
    it('accepts only the exact completed main dry-run and exact generation', () => {
        expect(() => assertReviewedSharedSheetRun(selected())).not.toThrow();
        expect(() => assertReviewedPlanGeneration('456', '456', '456')).not.toThrow();
        for (const args of [['456', '457', '456'], ['456', '456', '457'], ['../456', '456', '456']])
            expect(() => assertReviewedPlanGeneration(args[0], args[1], args[2])).toThrow('REVIEWED_PLAN_GENERATION_CHANGED');
    });
    it.each(['runId', 'attempt', 'generation', 'digest', 'sourcePin', 'executionPin'])('rejects changed or malformed %s', key => {
        const input = selected();
        input[key] = key === 'executionPin' ? 'c'.repeat(40) : '../bad';
        expect(() => assertReviewedSharedSheetRun(input)).toThrow('REVIEWED_SHARED_SHEET_RUN_NOT_PINNED');
    });
    it.each(['id', 'run_attempt', 'head_sha', 'head_branch', 'event', 'status', 'conclusion', 'path', 'display_title'])('rejects a source run with changed %s', key => {
        const input = selected();
        Object.assign(input.run, { [key]: typeof input.run[key] === 'number' ? 2 : 'changed' });
        expect(() => assertReviewedSharedSheetRun(input)).toThrow('REVIEWED_SHARED_SHEET_RUN_NOT_PINNED');
    });
    const liveNow = (c) => {
        const live = structuredClone(c);
        delete live.digest;
        live.readTime = new Date().toISOString();
        for (const tab of live.tabs)
            tab.readTime = live.readTime;
        live.vehicleMasterSnapshot = masterSnapshot();
        live.digest = sharedSheetCaptureDigest(live);
        return live;
    };
    it('allows observation-only changes but never rewrites the reviewed capture or master timestamp', async () => {
        const s = await stores(), c = capture();
        c.supplierEntered = [{ supplierCode: 'RP013', plate: 'TEST-FAKE-001', source: 'ERP5_PRODUCTS_SOURCE_TEXT', sourceRef: 'test-source', observedAt: time, values: { rent: 303 } }];
        const { plan } = await planSharedSheetCanonical(s.store, c, 'synthetic-target'), before = stableDigest(plan);
        const live = liveNow(c);
        live.supplierEntered[0].observedAt = live.readTime;
        live.digest = sharedSheetCaptureDigest(live);
        expect(() => assertLiveSharedSheetMatches(plan, live)).not.toThrow();
        expect(stableDigest(plan)).toBe(before);
    });
    it.each(['row', 'ERP', 'supplement', 'master', 'coverage'])('refuses live %s drift before any store call', async (kind) => {
        const s = await stores(), c = capture(), { plan } = await planSharedSheetCanonical(s.store, c, 'synthetic-target');
        const live = liveNow(c), spy = vi.spyOn(s.store, 'getCatalogWriterOwnership');
        if (kind === 'row')
            live.tabs[0].values[0][0] = 'changed';
        if (kind === 'ERP')
            live.supplierEntered = [{ supplierCode: 'RP013', plate: 'TEST-FAKE-001', source: 'ERP5_PRODUCTS_SOURCE_TEXT', sourceRef: 'changed', observedAt: live.readTime, values: { rent: 0 } }];
        if (kind === 'supplement')
            live.corrections = [{ supplierCode: 'RP013', plate: 'TEST-FAKE-001', at: live.readTime, column: '1개월', before: 303, after: 0, source: 'test' }];
        if (kind === 'master')
            live.vehicleMasterSnapshot.trims[0].data.trim = 'changed';
        if (kind === 'coverage')
            live.tabs.pop();
        live.digest = sharedSheetCaptureDigest(live);
        expect(() => assertLiveSharedSheetMatches(plan, live)).toThrow();
        expect(spy).not.toHaveBeenCalled();
    });
    it('refuses stale/future recapture and digest tampering', async () => {
        const s = await stores(), c = capture(), { plan } = await planSharedSheetCanonical(s.store, c, 'synthetic-target');
        const live = liveNow(c);
        expect(() => assertLiveSharedSheetMatches(plan, live, Date.parse(live.readTime) + 120001)).toThrow('LIVE_SHARED_SHEET_CAPTURE_STALE');
        expect(() => assertLiveSharedSheetMatches(plan, live, Date.parse(live.readTime) - 1)).toThrow('LIVE_SHARED_SHEET_CAPTURE_STALE');
        live.digest = '0'.repeat(64);
        expect(() => assertLiveSharedSheetMatches(plan, live)).toThrow('INVALID_SHARED_SHEET_CAPTURE');
    });
    it('rejects reusing the approved capture as live evidence and retains an explicit source revision fence', async () => {
        const s = await stores(), c = liveNow(capture()), { plan } = await planSharedSheetCanonical(s.store, c, 'synthetic-target');
        expect(() => assertLiveSharedSheetMatches(plan, structuredClone(c))).toThrow('LIVE_SHARED_SHEET_RECAPTURE_REQUIRED');
        const live = structuredClone(c);
        delete live.digest;
        live.readTime = new Date(Date.parse(c.readTime) + 1).toISOString();
        for (const t of live.tabs)
            t.readTime = live.readTime;
        live.revision = 'different-source-revision';
        live.digest = sharedSheetCaptureDigest(live);
        expect(() => assertLiveSharedSheetMatches(plan, live, Date.parse(live.readTime))).toThrow('LIVE_SHARED_SHEET_CHANGED_REPLAN_REQUIRED');
    });
    it('requires live evidence even on a replay; refusal happens before plan file read or any write runtime', async () => {
        await expect(ingestMain(['--firestore', '--apply', '--plan', 'missing-plan.json', '--expected-plan-digest', 'b'.repeat(64)]))
            .rejects.toThrow('APPLY_REQUIRES_LIVE_SOURCE_RECAPTURE');
    });
    it('does not renew an expired sealed master merely because current master content is unchanged', async () => {
        const s = await stores(), c = capture(), { plan } = await planSharedSheetCanonical(s.store, c, 'synthetic-target');
        const master = plan.capture.vehicleMasterSnapshot;
        const oldTime = master.readAt, digest = stableDigest(plan);
        vi.useFakeTimers();
        try {
            vi.setSystemTime(Date.parse(oldTime) + 300001);
            expect(() => assertSharedSheetPlan(plan, digest, plan.target)).toThrow('Active Data vehicle master snapshot required');
            expect(master.readAt).toBe(oldTime);
            expect(stableDigest(plan)).toBe(digest);
        }
        finally {
            vi.useRealTimers();
        }
    });
    it('keeps a sealed master usable in flight after the entry fence (long apply), but never when incomplete or digest-changed', async () => {
        const s = await stores(), c = capture(), { plan, report } = await planSharedSheetCanonical(s.store, c, 'synthetic-target');
        const master = plan.capture.vehicleMasterSnapshot;
        const digest = stableDigest(plan);
        vi.useFakeTimers();
        try {
            vi.setSystemTime(Date.parse(master.readAt) + 20 * 60_000);
            expect(() => assertSharedSheetPlan(plan, digest, plan.target)).toThrow('Active Data vehicle master snapshot required');
            expect(() => assertSharedSheetPlan(plan, digest, plan.target, true)).not.toThrow();
            await expect(preflightSharedSheetApply(s.store, plan, report.planDigest, 'synthetic-target')).resolves.toBeInstanceOf(Set);
        }
        finally {
            vi.useRealTimers();
        }
        const broken = structuredClone(plan);
        broken.capture.vehicleMasterSnapshot.complete = false;
        expect(() => assertSharedSheetPlan(broken, stableDigest(broken), broken.target, true)).toThrow();
    });
    it('rechecks stored head and all revisions in the read-only preflight before opening audited writes', async () => {
        const s = await stores();
        await apply(s);
        const c = later(capture({ '1개월': 777 })), p = await planSharedSheetCanonical(s.store, c, 'synthetic-target');
        const write = vi.spyOn(s.store, 'transact');
        const current = (await s.store.listOffers())[0];
        await s.store.seed({ offers: [{ ...current, revision: current.revision + 1 }] });
        await expect(preflightSharedSheetApply(s.store, p.plan, p.report.planDigest, 'synthetic-target')).rejects.toThrow('SHARED_SHEET_PLAN_STALE');
        await s.store.seed({ offers: [current] });
        const head = (await s.store.getSourceHead(prepareRawSourceBatch(buildSharedSheetBatch(c)).sourceId));
        await s.store.seed({ sourceHeads: [{ ...head, runId: 'different-approved-run' }] });
        await expect(preflightSharedSheetApply(s.store, p.plan, p.report.planDigest, 'synthetic-target')).rejects.toThrow('SHARED_SHEET_HEAD_CHANGED');
        expect(write).not.toHaveBeenCalled();
    });
    it('a same-run replay must preserve the exact checkpoint, not merely the run ID', async () => {
        const s = await stores(), p = await apply(s), sourceId = prepareRawSourceBatch(buildSharedSheetBatch(p.plan.capture)).sourceId;
        const head = (await s.store.getSourceHead(sourceId));
        await s.store.seed({ sourceHeads: [{ ...head, checkpoint: { ...head.checkpoint, checksum: 'changed' } }] });
        const write = vi.spyOn(s.store, 'transact');
        await expect(preflightSharedSheetApply(s.store, p.plan, p.report.planDigest, 'synthetic-target'))
            .rejects.toThrow('SHARED_SHEET_REPLAY_HEAD_EVIDENCE_CHANGED');
        expect(write).not.toHaveBeenCalled();
    });
});
describe('safeErrorCode', () => {
    it('공개 로그에는 고정 대문자 코드나 오류 클래스 이름만 낸다', async () => {
        const { safeErrorCode } = await import('../src/jobs/ingest-shared-sheet-canonical.js');
        expect(safeErrorCode(new Error('VEHICLE_MASTER_CHANGED_REPLAN_REQUIRED'))).toBe('VEHICLE_MASTER_CHANGED_REPLAN_REQUIRED');
        expect(safeErrorCode(new Error('provider said 12가3456 failed'))).toBe('UNCODED_Error');
        expect(safeErrorCode(new TypeError('x'))).toBe('UNCODED_TypeError');
        expect(safeErrorCode(new Error('HOLD: Active Data vehicle master snapshot required'))).toBe('VEHICLE_MASTER_SNAPSHOT_STALE_OR_INCOMPLETE');
        expect(safeErrorCode(new Error('HOLD: some other free text 12가3456'))).toBe('UNCODED_Error');
        expect(safeErrorCode('boom')).toBe('UNCODED');
    });
});
describe('commandFailureDetail', () => {
    it('exposes only a closed vocabulary, never message text or identifiers', async () => {
        const { commandFailureDetail } = await import('../src/jobs/ingest-shared-sheet-canonical.js');
        const d = commandFailureDetail(Object.assign(new Error('Document projects/x/documents/offers/secret-id already exists'), { code: 6 }), 'CREATE');
        expect(d).toEqual({ commandKind: 'CREATE', errorClass: 'Error', errorCode: '6', category: 'ALREADY_EXISTS' });
        expect(JSON.stringify(d)).not.toContain('secret-id');
        expect(commandFailureDetail(new Error('something odd 12345'), 'CHANGE').category).toBe('UNCLASSIFIED');
        expect(commandFailureDetail('not an error', 'UNKNOWN')).toMatchObject({ errorClass: 'NonError' });
    });
});
describe('reviewedRejectionReason', () => {
    it('maps only fixed reviewed-command messages; unknown text stays UNLISTED and is never echoed', async () => {
        const { reviewedRejectionReason } = await import('../src/jobs/ingest-shared-sheet-canonical.js');
        expect(reviewedRejectionReason(new Error('Existing rent diverges from the last source observation; preserve human input'))).toBe('EXISTING_RENT_DIVERGES');
        expect(reviewedRejectionReason(new Error('Candidate not found: secret-id'))).toBe('UNLISTED');
    });
});
