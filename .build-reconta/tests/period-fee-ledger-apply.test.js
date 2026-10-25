import { describe, expect, it } from 'vitest';
import { applyPeriodFeeLedgerPlan, rollbackPeriodFeeLedgerSnapshot, } from '../src/application/apply-period-fee-ledger.js';
import { planPeriodFeeLedger } from '../src/application/period-fee-ledger-plan.js';
import { periodFeeRunDocumentKey } from '../src/infra/firestore-layout.js';
import { stableDigest } from '../src/shared/stable-digest.js';
const observedAt = '2026-10-12T00:00:00.000Z';
const FIRESTORE_DOCUMENT_LIMIT_BYTES = 1_048_576;
const product = (overrides = {}) => ({
    provider_company_code: 'RP013',
    provider_name: 'TEST-FAKE-SUPPLIER',
    vehicle_uid: 'TEST-FAKE-ASSET-001',
    car_number: 'TEST-FAKE-PLATE-0001',
    product_type: '중고렌트',
    price: { '36': { rent: 800000, deposit: 1000000 } },
    ...overrides,
});
class MemoryPeriodFeeStore {
    ledger = new Map();
    history = new Map();
    runs = new Map();
    lock = null;
    forbiddenWriteAttempt = false;
    corruptReadback = false;
    changeActiveDuringReadback = null;
    failAfterLedgerCreates = null;
    failDeleteAfter = Number.POSITIVE_INFINITY;
    failRestore = false;
    setSnapshotRunCalls = 0;
    createLedgerCalls = 0;
    createHistoryCalls = 0;
    activateCalls = 0;
    hijackLockBeforeNextActivation = false;
    assertDocumentSize(value) {
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > FIRESTORE_DOCUMENT_LIMIT_BYTES) {
            throw new Error('FIRESTORE_DOCUMENT_TOO_LARGE');
        }
    }
    assertSnapshotWriteGuard(guard) {
        if (!this.lock || this.lock.ownerId !== guard.lockOwnerId || this.lock.leaseExpiresAt <= guard.checkedAt) {
            throw new Error('LOCK_LOST');
        }
    }
    async acquireSnapshotWriteLock(ownerId, acquiredAt, leaseExpiresAt) {
        if (this.lock && this.lock.ownerId !== ownerId && this.lock.leaseExpiresAt > acquiredAt)
            throw new Error('LOCK_HELD');
        this.lock = { ownerId, acquiredAt, leaseExpiresAt };
        return {
            schemaVersion: 'period-fee-snapshot-write-lock/v1',
            lockId: '_apply_lock',
            ...this.lock,
        };
    }
    async renewSnapshotWriteLock(ownerId, leaseExpiresAt, checkedAt = observedAt) {
        if (!this.lock || this.lock.ownerId !== ownerId || this.lock.leaseExpiresAt <= checkedAt)
            throw new Error('LOCK_LOST');
        this.lock = { ...this.lock, leaseExpiresAt };
    }
    async releaseSnapshotWriteLock(ownerId) {
        if (this.lock?.ownerId === ownerId)
            this.lock = null;
    }
    async getLedgerDocument(documentKey) {
        return this.ledger.get(documentKey) ?? null;
    }
    async createLedgerDocument(documentKey, row, digest) {
        const stored = { digest, data: structuredClone(row) };
        this.assertDocumentSize({ ...row, digest });
        this.ledger.set(documentKey, stored);
        this.createLedgerCalls += 1;
        if (this.failAfterLedgerCreates !== null && this.createLedgerCalls >= this.failAfterLedgerCreates) {
            throw new Error('TEST_LEDGER_CREATE_INTERRUPTED');
        }
    }
    async listLedgerDocumentsByRunIdPrefix(runId, pageSize = 500) {
        const lower = `${runId}__`;
        const upper = `${runId}__\uf8ff`;
        const all = [...this.ledger.entries()]
            .filter(([documentKey]) => documentKey >= lower && documentKey < upper)
            .sort(([a], [b]) => a.localeCompare(b));
        const pages = [];
        for (let index = 0; index < all.length; index += pageSize) {
            pages.push(...all.slice(index, index + pageSize).map(([documentKey, stored]) => ({ documentKey, ...stored })));
        }
        return pages;
    }
    async getProductChangeHistoryDocument(documentKey) {
        return this.history.get(documentKey) ?? null;
    }
    async createProductChangeHistoryDocument(documentKey, row, digest) {
        if (!documentKey.includes('__'))
            throw new Error('TEST_HISTORY_KEY_INVALID');
        const existing = this.history.get(documentKey);
        if (existing) {
            if (existing.digest !== digest)
                throw new Error('DOCUMENT_ID_COLLISION');
            return;
        }
        this.createHistoryCalls += 1;
        this.assertDocumentSize({ ...row, digest });
        this.history.set(documentKey, { digest, data: structuredClone(row) });
    }
    async listProductChangeHistoryDocumentsByRunIdPrefix(runId, pageSize = 500) {
        const lower = `${runId}__`;
        const upper = `${runId}__\uf8ff`;
        const all = [...this.history.entries()]
            .filter(([documentKey]) => documentKey >= lower && documentKey < upper)
            .sort(([a], [b]) => a.localeCompare(b));
        const pages = [];
        for (let index = 0; index < all.length; index += pageSize) {
            pages.push(...all.slice(index, index + pageSize).map(([documentKey, stored]) => ({ documentKey, ...stored })));
        }
        return pages;
    }
    async getSnapshotRun(runId) {
        return this.runs.get(runId) ?? null;
    }
    async getActiveSnapshotRun(snapshotId) {
        const active = [...this.runs.values()].filter(run => run.snapshotId === snapshotId && run.active);
        if (active.length > 1)
            throw new Error('TEST_ACTIVE_RUN_NOT_UNIQUE');
        return active[0] ?? null;
    }
    async getLatestSupersededSnapshotRun(snapshotId, excludeRunId) {
        return [...this.runs.values()]
            .filter(run => run.snapshotId === snapshotId && run.status === 'SUPERSEDED' && run.runId !== excludeRunId)
            .sort((a, b) => Date.parse(b.activatedAt ?? '') - Date.parse(a.activatedAt ?? ''))[0] ?? null;
    }
    async setSnapshotRun(runId, run, guard) {
        if (guard)
            this.assertSnapshotWriteGuard(guard);
        this.setSnapshotRunCalls += 1;
        const existing = this.runs.get(runId);
        if (run.status === 'PREPARED'
            && existing
            && (existing.status !== 'PREPARED' || existing.planDigest !== run.planDigest)) {
            throw new Error('PERIOD_FEE_RUN_STATE_CONFLICT');
        }
        if (guard && existing && existing.planDigest !== run.planDigest)
            throw new Error('RUN_STATE_CHANGED');
        if (guard && run.status === 'ROLLING_BACK' && (!existing || !['ACTIVE', 'PREPARED', 'ROLLING_BACK'].includes(existing.status))) {
            throw new Error('RUN_STATE_CHANGED');
        }
        if (guard && run.status === 'ROLLBACK_PARTIAL_UNEXPECTED' && (!existing || existing.status !== 'ROLLING_BACK'))
            throw new Error('RUN_STATE_CHANGED');
        if (guard && run.status === 'FAILED' && (!existing || existing.status !== 'ROLLING_BACK'))
            throw new Error('RUN_STATE_CHANGED');
        if (guard && run.status === 'ROLLED_BACK' && (!existing || existing.status !== 'INACTIVE'))
            throw new Error('RUN_STATE_CHANGED');
        this.assertDocumentSize(run);
        this.runs.set(runId, structuredClone(run));
    }
    async activateSnapshotRun(runId, run, guard) {
        if (this.hijackLockBeforeNextActivation) {
            this.hijackLockBeforeNextActivation = false;
            this.lock = { ownerId: 'TEST-FAKE-OTHER-OWNER', acquiredAt: observedAt, leaseExpiresAt: '2026-10-12T00:30:00.000Z' };
            const prepared = this.runs.get(runId);
            if (prepared)
                this.runs.set(runId, { ...prepared, status: 'ROLLED_BACK', active: false, activatedAt: null });
        }
        this.assertSnapshotWriteGuard(guard);
        this.activateCalls += 1;
        const target = this.runs.get(runId);
        if (!target || target.status !== 'PREPARED' || target.planDigest !== run.planDigest)
            throw new Error('RUN_STATE_CHANGED');
        const actualPreviousActiveRunId = [...this.runs.entries()]
            .find(([id, existing]) => id !== runId && existing.snapshotId === run.snapshotId && existing.active)?.[0] ?? null;
        this.runs.set(runId, { ...structuredClone(run), previousActiveRunId: actualPreviousActiveRunId });
        if (actualPreviousActiveRunId && actualPreviousActiveRunId !== runId) {
            const previous = this.runs.get(actualPreviousActiveRunId);
            if (previous)
                this.runs.set(actualPreviousActiveRunId, { ...previous, status: 'SUPERSEDED', active: false });
        }
    }
    async restoreSnapshotRunActive(runId, expectedPlanDigest, expectedCurrentActiveRunId, guard) {
        this.assertSnapshotWriteGuard(guard);
        if (this.failRestore)
            throw new Error('TEST_RESTORE_INTERRUPTED');
        const run = this.runs.get(runId);
        if (!run || run.planDigest !== expectedPlanDigest || run.status !== 'SUPERSEDED') {
            throw new Error('TEST_RESTORE_RUN_MISMATCH');
        }
        const active = [...this.runs.entries()].filter(([, existing]) => existing.snapshotId === run.snapshotId && existing.active);
        if (active.length > 1)
            throw new Error('TEST_ACTIVE_RUN_NOT_UNIQUE');
        if ((active[0]?.[0] ?? null) !== expectedCurrentActiveRunId)
            throw new Error('ROLLBACK_SUPERSEDED_BY_NEWER_ACTIVE');
        for (const [id, existing] of this.runs) {
            if (existing.snapshotId === run.snapshotId && existing.active && id !== runId) {
                this.runs.set(id, { ...existing, status: 'SUPERSEDED', active: false });
            }
        }
        this.runs.set(runId, { ...run, status: 'ACTIVE', active: true });
    }
    async readLedgerRows(snapshotId, runId) {
        const run = this.runs.get(runId);
        if (!run)
            throw new Error('PERIOD_FEE_READBACK_RUN_NOT_FOUND');
        if (!run.rowContentDigest || !run.historyContentDigest)
            throw new Error('LEDGER_READ_INCONSISTENT');
        const rowDocs = await this.listLedgerDocumentsByRunIdPrefix(runId, 500);
        const filtered = rowDocs
            .filter(item => item.data.snapshotId === snapshotId)
            .map(item => item.data);
        const result = this.corruptReadback
            ? filtered.map((row, index) => index === 0
                ? { ...row, monthlyRent: { ...row.monthlyRent, amount: row.monthlyRent.amount + 1 } }
                : row)
            : filtered;
        if (this.changeActiveDuringReadback) {
            for (const [id, existing] of this.runs) {
                if (existing.snapshotId === snapshotId && existing.active)
                    this.runs.set(id, { ...existing, status: 'SUPERSEDED', active: false });
            }
            this.runs.set(this.changeActiveDuringReadback.runId, structuredClone(this.changeActiveDuringReadback));
            this.changeActiveDuringReadback = null;
        }
        const reread = this.runs.get(runId);
        if (run?.active && (!reread || !reread.active || reread.status !== 'ACTIVE'))
            throw new Error('LEDGER_READ_INCONSISTENT');
        const keys = rowDocs.map(item => item.documentKey).sort((a, b) => a.localeCompare(b));
        const actualContentDigest = digestKeyPairs(rowDocs.map(item => ({ documentKey: item.documentKey, digest: item.digest })));
        if (result.length !== run.rowCount || stableDigest(keys) !== run.rowKeysDigest)
            throw new Error('LEDGER_READ_INCONSISTENT');
        if (actualContentDigest !== run.rowContentDigest)
            throw new Error('LEDGER_READ_INCONSISTENT');
        return result;
    }
    async markSnapshotRunInactive(runId, guard) {
        this.assertSnapshotWriteGuard(guard);
        const existing = this.runs.get(runId);
        this.runs.set(runId, { ...(existing ?? {
                schemaVersion: 'period-fee-snapshot-run/v1',
                runId,
                snapshotId: runId,
                planDigest: '',
                previousActiveRunId: null,
                preparedAt: observedAt,
                rowCount: 0,
                rowKeysDigest: stableDigest([]),
                rowContentDigest: stableDigest([]),
                readyRowCount: 0,
                holdNoUidCount: 0,
                historyRowCount: 0,
                historyKeysDigest: stableDigest([]),
                historyContentDigest: stableDigest([]),
                readbackSampleCount: 0,
                readbackDigest: null,
            }), status: 'INACTIVE', active: false, activatedAt: null });
    }
    async deleteLedgerRowsByDigest(documentDigests, guard) {
        this.assertSnapshotWriteGuard(guard);
        let count = 0;
        for (const target of documentDigests) {
            const stored = this.ledger.get(target.documentKey);
            if (stored?.digest === target.digest) {
                this.ledger.delete(target.documentKey);
                count += 1;
                if (count >= this.failDeleteAfter)
                    throw new Error('TEST_DELETE_INTERRUPTED');
            }
        }
        return count;
    }
    async forbiddenWrite() {
        this.forbiddenWriteAttempt = true;
        throw new Error('FORBIDDEN_WRITE');
    }
}
const makePlan = (products = { p1: product() }) => planPeriodFeeLedger({ products, policies: {}, referenceInputs: {} }, { clock: () => new Date(observedAt) });
const runIdFor = (plan) => `${plan.snapshotId}__${plan.planDigest.slice(0, 24)}`;
const storageKeyFor = (plan, row) => periodFeeRunDocumentKey(runIdFor(plan), row.documentKey);
const historyStorageKeyFor = (plan, row) => periodFeeRunDocumentKey(runIdFor(plan), [row.productKey, row.snapshotId, row.fieldPath, stableDigest(row).slice(0, 24)].join('__'));
const digestKeyPairs = (pairs) => stableDigest(pairs.map(pair => [pair.documentKey, pair.digest]).sort(([a], [b]) => a.localeCompare(b)));
const withPlanDigest = (plan) => ({
    ...plan,
    planDigest: stableDigest({
        snapshotId: plan.snapshotId,
        rows: plan.rows,
        history: plan.history,
        baselines: plan.baselines,
    }),
});
const planWithReadyRows = (count, keyLength = 24) => {
    const base = makePlan();
    const row = base.rows[0];
    const rows = Array.from({ length: count }, (_, index) => ({
        ...structuredClone(row),
        documentKey: `TEST-FAKE-${String(index).padStart(5, '0')}-${'K'.repeat(Math.max(0, keyLength - 16))}`,
        vehicleUid: `TEST-FAKE-ASSET-${String(index).padStart(5, '0')}`,
        assetId: `TEST-FAKE-ASSET-${String(index).padStart(5, '0')}`,
        plateLookupKey: `TEST-FAKE-PLATE-${String(index).padStart(5, '0')}`,
        plateLast4ForReport: String(index).padStart(4, '0').slice(-4),
    }));
    return withPlanDigest({ ...base, rows, history: [], baselines: { productStates: {} } });
};
describe('period fee ledger apply', () => {
    it('dry-runs with zero writes when approval env is absent at the application boundary', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        const result = await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: false });
        expect(result).toMatchObject({ status: 'DRY_RUN', writesEnabled: false, counts: { ledgerCreated: 0, activeMarked: 0, historyCreated: 0 } });
        // 시험 실행도 적용 시 만들 baseline 이력 건수를 보여야 한다(적용 결과와 불일치 방지).
        expect(result.counts.plannedHistoryRows).toBeGreaterThan(0);
        expect(store.ledger.size).toBe(0);
        expect(store.history.size).toBe(0);
        expect(store.runs.size).toBe(0);
    });
    it('rejects a digest mismatch before writing anything', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: 'wrong', writeApproved: true }))
            .rejects.toThrow('PERIOD_FEE_PLAN_DIGEST_MISMATCH');
        expect(store.ledger.size).toBe(0);
    });
    it('rejects a second apply or rollback while the snapshot write lock is held', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await store.acquireSnapshotWriteLock('TEST-FAKE-OWNER', observedAt, '2099-01-01T00:00:00.000Z');
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('LOCK_HELD');
        await expect(rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('LOCK_HELD');
        expect(store.ledger.size).toBe(0);
    });
    it('uses a per-execution apply lock owner so the same plan cannot re-enter an active lease', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await store.acquireSnapshotWriteLock(`apply:${runIdFor(plan)}`, observedAt, '2099-01-01T00:00:00.000Z');
        await expect(applyPeriodFeeLedgerPlan(store, plan, {
            expectedDigest: plan.planDigest,
            writeApproved: true,
            now: () => new Date(observedAt),
        })).rejects.toThrow('LOCK_HELD');
        expect(store.ledger.size).toBe(0);
    });
    it('acquires the snapshot write lock after the previous lease expires', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await store.acquireSnapshotWriteLock('TEST-FAKE-OLD-OWNER', '2026-10-11T23:00:00.000Z', '2026-10-11T23:15:00.000Z');
        const result = await applyPeriodFeeLedgerPlan(store, plan, {
            expectedDigest: plan.planDigest,
            writeApproved: true,
            now: () => new Date(observedAt),
        });
        expect(result).toMatchObject({ status: 'APPLIED', counts: { activeMarked: 1 } });
        expect(store.lock).toBeNull();
    });
    it('keeps existing ACTIVE when a resumed apply lost its expired lock and another owner rolled back its PREPARED run', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const second = makePlan({ p1: product({ price: { '36': { rent: 810000, deposit: 1000000 } } }) });
        store.hijackLockBeforeNextActivation = true;
        store.activateCalls = 0;
        await expect(applyPeriodFeeLedgerPlan(store, second, {
            expectedDigest: second.planDigest,
            writeApproved: true,
            now: () => new Date(observedAt),
        })).rejects.toThrow('LOCK_LOST');
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ACTIVE', active: true });
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLED_BACK', active: false });
        expect(store.activateCalls).toBe(0);
    });
    it('rejects every run-state transition when the write lock owner differs or the lease expired', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const runId = runIdFor(plan);
        const active = store.runs.get(runId);
        const wrongOwner = { lockOwnerId: 'TEST-FAKE-WRONG-OWNER', checkedAt: observedAt };
        await store.acquireSnapshotWriteLock('TEST-FAKE-RIGHT-OWNER', observedAt, '2026-10-12T00:15:00.000Z');
        await expect(store.setSnapshotRun(runId, { ...active, status: 'ROLLING_BACK', active: false }, wrongOwner))
            .rejects.toThrow('LOCK_LOST');
        await expect(store.activateSnapshotRun(runId, { ...active, status: 'ACTIVE', active: true }, wrongOwner))
            .rejects.toThrow('LOCK_LOST');
        await expect(store.restoreSnapshotRunActive(runId, active.planDigest, runId, wrongOwner))
            .rejects.toThrow('LOCK_LOST');
        await expect(store.markSnapshotRunInactive(runId, wrongOwner))
            .rejects.toThrow('LOCK_LOST');
        await expect(store.deleteLedgerRowsByDigest([{ documentKey: storageKeyFor(plan, plan.rows[0]), digest: stableDigest(plan.rows[0]) }], wrongOwner))
            .rejects.toThrow('LOCK_LOST');
        await expect(store.renewSnapshotWriteLock('TEST-FAKE-WRONG-OWNER', '2026-10-12T00:30:00.000Z', observedAt))
            .rejects.toThrow('LOCK_LOST');
        const expired = { lockOwnerId: 'TEST-FAKE-RIGHT-OWNER', checkedAt: '2026-10-12T00:16:00.000Z' };
        await expect(store.setSnapshotRun(runId, { ...active, status: 'ROLLING_BACK', active: false }, expired))
            .rejects.toThrow('LOCK_LOST');
        await expect(store.renewSnapshotWriteLock('TEST-FAKE-RIGHT-OWNER', '2026-10-12T00:30:00.000Z', expired.checkedAt))
            .rejects.toThrow('LOCK_LOST');
        expect(store.runs.get(runId)).toMatchObject({ status: 'ACTIVE', active: true });
        expect(store.ledger.has(storageKeyFor(plan, plan.rows[0]))).toBe(true);
    });
    it('does not write HOLD_NO_UID rows but reports them', async () => {
        const plan = makePlan({ ok: product(), noUid: product({ vehicle_uid: undefined, assetId: undefined }) });
        const store = new MemoryPeriodFeeStore();
        const result = await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        expect(result.counts).toMatchObject({ plannedRows: 2, readyRows: 1, holdNoUidRows: 1, ledgerCreated: 1, activeMarked: 1 });
        expect([...store.ledger.values()].every(row => row.data.vehicleUid)).toBe(true);
    });
    it('writes evidenceScope and verifies it during readback', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const storedFirst = [...store.ledger.values()].map(item => item.data);
        expect(storedFirst).toHaveLength(1);
        expect(storedFirst[0].evidenceScope).toBe('BASELINE_NOT_CONTRACT_EVIDENCE');
        const second = planPeriodFeeLedger({
            products: { p1: product({ price: { '36': { rent: 810000, deposit: 1000000 } } }) },
            policies: {},
            referenceInputs: {},
            previousSnapshot: { rows: first.rows, productStates: first.baselines.productStates },
        }, { clock: () => new Date('2026-10-13T00:00:00.000Z') });
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        const readRows = await store.readLedgerRows(second.snapshotId, runIdFor(second));
        expect(readRows).toHaveLength(1);
        expect(readRows[0].evidenceScope).toBe('OBSERVED_AT_SNAPSHOT');
        expect(store.runs.get(runIdFor(second))?.readbackDigest).toBeTruthy();
    });
    it('is idempotent for same document digests and refuses conflicting documents', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const callsBefore = {
            setSnapshotRunCalls: store.setSnapshotRunCalls,
            createLedgerCalls: store.createLedgerCalls,
            createHistoryCalls: store.createHistoryCalls,
            activateCalls: store.activateCalls,
        };
        const runBefore = structuredClone(store.runs.get(runIdFor(plan)));
        const second = await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        expect(second.counts).toMatchObject({ ledgerCreated: 0, ledgerSkippedSameDigest: 1, activeMarked: 0 });
        expect({
            setSnapshotRunCalls: store.setSnapshotRunCalls,
            createLedgerCalls: store.createLedgerCalls,
            createHistoryCalls: store.createHistoryCalls,
            activateCalls: store.activateCalls,
        }).toEqual(callsBefore);
        expect(store.runs.get(runIdFor(plan))).toEqual(runBefore);
        expect(store.runs.get(runIdFor(plan))).toMatchObject({
            rowCount: 1,
            rowKeysDigest: stableDigest([storageKeyFor(plan, plan.rows[0])]),
        });
        const row = plan.rows[0];
        store.ledger.set(storageKeyFor(plan, row), { digest: stableDigest({ stale: true }), data: row });
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('PERIOD_FEE_LEDGER_DOCUMENT_DIGEST_CONFLICT');
    });
    it('stores distinct long-key product change histories without truncation collisions', async () => {
        const longProductKey = `TEST-FAKE-${'PRODUCT-'.repeat(40)}`;
        const base = makePlan();
        const history = [
            {
                schemaVersion: 'product-change-history/v1',
                productKey: longProductKey,
                kind: 'RENT',
                fieldPath: 'priceTerms.monthlyRent',
                before: { amount: 700000 },
                after: { amount: 710000 },
                changedAtKst: '2026-10-12',
                snapshotId: base.snapshotId,
                sourceObservationRef: null,
            },
            {
                schemaVersion: 'product-change-history/v1',
                productKey: longProductKey,
                kind: 'DEPOSIT',
                fieldPath: 'priceTerms.deposit',
                before: { amount: 0 },
                after: { amount: 1000000 },
                changedAtKst: '2026-10-12',
                snapshotId: base.snapshotId,
                sourceObservationRef: null,
            },
        ];
        const plan = withPlanDigest({ ...base, history });
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const keys = [...store.history.keys()];
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
        expect(keys.every(key => key.includes('__sha256_'))).toBe(true);
    });
    it('fails when an existing history document ID has a different digest', async () => {
        const base = makePlan();
        const history = [{
                schemaVersion: 'product-change-history/v1',
                productKey: `TEST-FAKE-${'PRODUCT-'.repeat(40)}`,
                kind: 'RENT',
                fieldPath: 'priceTerms.monthlyRent',
                before: { amount: 700000 },
                after: { amount: 710000 },
                changedAtKst: '2026-10-12',
                snapshotId: base.snapshotId,
                sourceObservationRef: null,
            }];
        const plan = withPlanDigest({ ...base, history });
        const store = new MemoryPeriodFeeStore();
        store.history.set(historyStorageKeyFor(plan, history[0]), {
            digest: stableDigest({ TEST: 'FAKE-DIFFERENT-CONTENT' }),
            data: {},
        });
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('DOCUMENT_ID_COLLISION');
        expect([...store.runs.values()].some(run => run.active)).toBe(false);
    });
    it('does not mark ACTIVE when history readback is missing', async () => {
        const base = makePlan();
        const history = [{
                schemaVersion: 'product-change-history/v1',
                productKey: 'TEST-FAKE-PRODUCT',
                kind: 'RENT',
                fieldPath: 'priceTerms.monthlyRent',
                before: { amount: 700000 },
                after: { amount: 710000 },
                changedAtKst: '2026-10-12',
                snapshotId: base.snapshotId,
                sourceObservationRef: null,
            }];
        const plan = withPlanDigest({ ...base, history });
        const store = new MemoryPeriodFeeStore();
        const original = store.listProductChangeHistoryDocumentsByRunIdPrefix.bind(store);
        store.listProductChangeHistoryDocumentsByRunIdPrefix = async (runId, pageSize) => {
            const rows = await original(runId, pageSize);
            return store.createHistoryCalls > 0 ? rows.filter(row => row.documentKey !== historyStorageKeyFor(plan, history[0])) : rows;
        };
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('LEDGER_READ_INCONSISTENT');
        expect(store.runs.get(runIdFor(plan))).toMatchObject({ status: 'PREPARED', active: false });
    });
    it('rejects a stored same-run digest conflict before rewriting ACTIVE evidence', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const runId = runIdFor(plan);
        store.runs.set(runId, { ...store.runs.get(runId), planDigest: 'TEST-FAKE-DIFFERENT-DIGEST' });
        const callsBefore = store.setSnapshotRunCalls;
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('PERIOD_FEE_RUN_DIGEST_CONFLICT');
        expect(store.setSnapshotRunCalls).toBe(callsBefore);
        expect(store.runs.get(runId)).toMatchObject({ status: 'ACTIVE', active: true, previousActiveRunId: null });
    });
    it('does not mark ACTIVE when readback mismatches', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        store.corruptReadback = true;
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('PERIOD_FEE_READBACK_ROW_MISMATCH');
        expect(store.runs.get(runIdFor(plan))).toMatchObject({ status: 'PREPARED', active: false });
    });
    it('records a first-snapshot baseline and append-only history rows', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        expect([...store.history.values()].some(row => row.data.kind === 'BASELINE')).toBe(true);
        const second = planPeriodFeeLedger({
            products: { p1: product({ price: { '36': { rent: 850000, deposit: 1000000 } } }) },
            policies: {},
            referenceInputs: {},
            previousSnapshot: { rows: first.rows, productStates: first.baselines.productStates },
        }, { clock: () => new Date('2026-10-13T00:00:00.000Z') });
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        expect([...store.history.values()].some(row => row.data.kind === 'RENT')).toBe(true);
        expect([...store.history.keys()].every(key => key.startsWith(`${runIdFor(first)}__`) || key.startsWith(`${runIdFor(second)}__`))).toBe(true);
    });
    it('reads only the ACTIVE run ledger rows through the run prefix', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const second = makePlan({ p1: product({ price: { '36': { rent: 810000, deposit: 1000000 } } }) });
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        const active = await store.getActiveSnapshotRun(second.snapshotId);
        const activeRows = await store.readLedgerRows(second.snapshotId, active.runId);
        expect(active).toMatchObject({ runId: runIdFor(second), active: true });
        expect(activeRows).toHaveLength(1);
        expect(activeRows[0]).toEqual(second.rows[0]);
        expect(store.ledger.has(storageKeyFor(first, first.rows[0]))).toBe(true);
        expect(store.ledger.has(storageKeyFor(second, second.rows[0]))).toBe(true);
    });
    it('keeps the run document below the Firestore size limit for 13,339 owned rows with long keys', async () => {
        const plan = planWithReadyRows(13_339, 190);
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true, sampleSize: 3 });
        const run = store.runs.get(runIdFor(plan));
        expect(Buffer.byteLength(JSON.stringify(run), 'utf8')).toBeLessThan(FIRESTORE_DOCUMENT_LIMIT_BYTES);
        expect(run).not.toHaveProperty('rowKeys');
        expect(run).not.toHaveProperty('plannedCreateKeys');
        expect(run).not.toHaveProperty('createdDocumentKeys');
        expect(run).toMatchObject({ rowCount: 13_339, rowKeysDigest: stableDigest(plan.rows.map(row => storageKeyFor(plan, row)).sort()) });
    }, 60_000);
    it('keeps document ID prefix reads inside the exact run boundary', async () => {
        const store = new MemoryPeriodFeeStore();
        const row = makePlan().rows[0];
        store.ledger.set('runA__001', { digest: 'a', data: row });
        store.ledger.set('runA2__001', { digest: 'b', data: row });
        expect((await store.listLedgerDocumentsByRunIdPrefix('runA')).map(item => item.documentKey)).toEqual(['runA__001']);
    });
    it('fails readback when prefix row count or key digest disagrees with the run manifest', async () => {
        const plan = planWithReadyRows(2);
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const run = store.runs.get(runIdFor(plan));
        store.runs.set(runIdFor(plan), { ...run, rowCount: 3 });
        await expect(store.readLedgerRows(plan.snapshotId, runIdFor(plan))).rejects.toThrow('LEDGER_READ_INCONSISTENT');
        store.runs.set(runIdFor(plan), { ...run, rowKeysDigest: stableDigest(['TEST-FAKE-WRONG']) });
        await expect(store.readLedgerRows(plan.snapshotId, runIdFor(plan))).rejects.toThrow('LEDGER_READ_INCONSISTENT');
    });
    it('rolls back only rows owned by the run ID prefix', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const row = plan.rows[0];
        store.ledger.set(`${runIdFor(plan)}2__foreign`, { digest: stableDigest(row), data: row });
        const result = await rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        expect(result.deletedRows).toBe(1);
        expect(store.ledger.has(`${runIdFor(plan)}2__foreign`)).toBe(true);
    });
    it('rolls back by deleting only documents the run actually created', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const result = await rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        expect(result).toMatchObject({ status: 'ROLLED_BACK', inactiveRuns: 1, deletedRows: 1 });
        expect(store.runs.get(runIdFor(plan))).toMatchObject({ status: 'ROLLED_BACK', active: false });
        expect(store.ledger.size).toBe(0);
    });
    it('does not delete a planned prefix row whose digest changed and leaves rollback PARTIAL', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const key = storageKeyFor(plan, plan.rows[0]);
        const changed = {
            ...plan.rows[0],
            monthlyRent: { ...plan.rows[0].monthlyRent, amount: plan.rows[0].monthlyRent.amount + 1 },
        };
        store.ledger.set(key, { digest: stableDigest(changed), data: changed });
        await expect(rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toMatchObject({
            message: 'ROLLBACK_PARTIAL_UNEXPECTED',
            result: { status: 'ROLLBACK_PARTIAL_UNEXPECTED', deletedRows: 0, unexpectedRows: { count: 1, digestMismatch: [key] } },
        });
        expect(store.ledger.has(key)).toBe(true);
        expect(store.runs.get(runIdFor(plan))).toMatchObject({ status: 'ROLLBACK_PARTIAL_UNEXPECTED', active: false });
    });
    it('does not delete an unplanned prefix row and leaves rollback PARTIAL without restoring the previous run', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const second = makePlan({
            p1: product(),
            p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }),
        });
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        const unexpectedKey = `${runIdFor(second)}__TEST-FAKE-UNPLANNED`;
        store.ledger.set(unexpectedKey, { digest: 'u', data: second.rows[0] });
        await expect(rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
            .rejects.toMatchObject({
            message: 'ROLLBACK_PARTIAL_UNEXPECTED',
            result: { status: 'ROLLBACK_PARTIAL_UNEXPECTED', deletedRows: 2, unexpectedRows: { count: 1, planMissing: [unexpectedKey] } },
        });
        expect(store.ledger.has(unexpectedKey)).toBe(true);
        expect(store.ledger.has(storageKeyFor(second, second.rows[0]))).toBe(false);
        expect(store.ledger.has(storageKeyFor(second, second.rows[1]))).toBe(false);
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLBACK_PARTIAL_UNEXPECTED', active: false });
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'SUPERSEDED', active: false });
        expect(await store.getActiveSnapshotRun(first.snapshotId)).toBeNull();
    });
    it('persists row count and key digest before row creation so interrupted apply can be rolled back', async () => {
        const plan = makePlan({ p1: product(), p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }) });
        const store = new MemoryPeriodFeeStore();
        store.failAfterLedgerCreates = 1;
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('TEST_LEDGER_CREATE_INTERRUPTED');
        const run = store.runs.get(runIdFor(plan));
        expect(run).toMatchObject({ status: 'PREPARED', active: false });
        expect(run).toMatchObject({
            rowCount: 2,
            rowKeysDigest: stableDigest(plan.rows.map(row => storageKeyFor(plan, row)).sort()),
        });
        store.failAfterLedgerCreates = null;
        const result = await rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        expect(result.deletedRows).toBe(1);
        expect(store.ledger.size).toBe(0);
        expect(store.runs.get(runIdFor(plan))).toMatchObject({ status: 'ROLLED_BACK', active: false });
    });
    it('keeps ownership when retrying a digest-identical planned row created before an interrupted apply', async () => {
        const plan = makePlan({ p1: product(), p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }) });
        const store = new MemoryPeriodFeeStore();
        store.failAfterLedgerCreates = 1;
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('TEST_LEDGER_CREATE_INTERRUPTED');
        store.failAfterLedgerCreates = null;
        const result = await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        expect(result.counts).toMatchObject({ ledgerCreated: 1, ledgerSkippedSameDigest: 1, activeMarked: 1 });
        const run = store.runs.get(runIdFor(plan));
        expect(run).toMatchObject({
            rowCount: 2,
            rowKeysDigest: stableDigest(plan.rows.map(row => storageKeyFor(plan, row)).sort()),
        });
        expect(store.ledger.size).toBe(2);
    });
    it('does not delete another run owned document that is outside this run ID prefix', async () => {
        const plan = makePlan({ p1: product(), p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }) });
        const store = new MemoryPeriodFeeStore();
        store.failAfterLedgerCreates = 1;
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('TEST_LEDGER_CREATE_INTERRUPTED');
        store.failAfterLedgerCreates = null;
        const foreignRow = plan.rows[1];
        store.ledger.set(foreignRow.documentKey, { digest: stableDigest(foreignRow), data: foreignRow });
        const result = await rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        expect(result.deletedRows).toBe(1);
        expect(store.ledger.has(plan.rows[0].documentKey)).toBe(false);
        expect(store.ledger.has(foreignRow.documentKey)).toBe(true);
    });
    it('refuses rollback of a superseded history-only run and deletes zero shared ledger rows', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const history = [{
                schemaVersion: 'product-change-history/v1',
                productKey: 'p1',
                kind: 'STATUS',
                fieldPath: 'status',
                before: 'TEST-FAKE-BEFORE',
                after: 'TEST-FAKE-AFTER',
                changedAtKst: '2026-10-12',
                snapshotId: first.snapshotId,
                sourceObservationRef: null,
            }];
        const secondBase = { ...first, history };
        const second = {
            ...secondBase,
            planDigest: stableDigest({
                snapshotId: secondBase.snapshotId,
                rows: secondBase.rows,
                history: secondBase.history,
                baselines: secondBase.baselines,
            }),
        };
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        await expect(rollbackPeriodFeeLedgerSnapshot(store, first, { expectedDigest: first.planDigest, writeApproved: true }))
            .rejects.toThrow('RUN_NOT_REAPPLICABLE');
        expect(store.ledger.size).toBe(2);
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'SUPERSEDED', active: false });
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ACTIVE', active: true });
    });
    it('keeps PREPARED rollback rows isolated from another ACTIVE run prefix', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        store.failAfterLedgerCreates = 1;
        await expect(applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true }))
            .rejects.toThrow('TEST_LEDGER_CREATE_INTERRUPTED');
        store.failAfterLedgerCreates = null;
        const history = [{
                schemaVersion: 'product-change-history/v1',
                productKey: 'p1',
                kind: 'STATUS',
                fieldPath: 'status',
                before: 'TEST-FAKE-BEFORE',
                after: 'TEST-FAKE-AFTER',
                changedAtKst: '2026-10-12',
                snapshotId: first.snapshotId,
                sourceObservationRef: null,
            }];
        const secondBase = { ...first, history };
        const second = {
            ...secondBase,
            planDigest: stableDigest({
                snapshotId: secondBase.snapshotId,
                rows: secondBase.rows,
                history: secondBase.history,
                baselines: secondBase.baselines,
            }),
        };
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        const result = await rollbackPeriodFeeLedgerSnapshot(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        expect(result).toMatchObject({ status: 'ROLLED_BACK', deletedRows: 1, keptSharedByActiveRows: 0 });
        expect(store.ledger.has(storageKeyFor(first, first.rows[0]))).toBe(false);
        expect(store.ledger.has(storageKeyFor(second, second.rows[0]))).toBe(true);
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ROLLED_BACK', active: false });
        expect(store.runs.get(runIdFor(second))).toMatchObject({
            status: 'ACTIVE',
            active: true,
            rowCount: 1,
            rowKeysDigest: stableDigest([storageKeyFor(second, second.rows[0])]),
        });
    });
    it('rejects reapply of a superseded run', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const history = [{
                schemaVersion: 'product-change-history/v1',
                productKey: 'p1',
                kind: 'STATUS',
                fieldPath: 'status',
                before: 'TEST-FAKE-BEFORE',
                after: 'TEST-FAKE-AFTER',
                changedAtKst: '2026-10-12',
                snapshotId: first.snapshotId,
                sourceObservationRef: null,
            }];
        const secondBase = { ...first, history };
        const second = {
            ...secondBase,
            planDigest: stableDigest({
                snapshotId: secondBase.snapshotId,
                rows: secondBase.rows,
                history: secondBase.history,
                baselines: secondBase.baselines,
            }),
        };
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        await expect(applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true }))
            .rejects.toThrow('RUN_NOT_REAPPLICABLE');
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'SUPERSEDED', active: false });
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ACTIVE', active: true });
    });
    it('refuses previous run restore when its row digest readback is missing and keeps current ACTIVE', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const second = makePlan({
            p1: product(),
            p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }),
        });
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        store.ledger.delete(storageKeyFor(first, first.rows[0]));
        await expect(rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
            .rejects.toThrow('LEDGER_READ_INCONSISTENT');
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ACTIVE', active: true });
        expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ runId: runIdFor(second) });
        expect(store.ledger.has(storageKeyFor(second, second.rows[1]))).toBe(true);
    });
    it('rolls back an active history-only run without deleting shared ledger rows and restores the previous run', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const history = [{
                schemaVersion: 'product-change-history/v1',
                productKey: 'p1',
                kind: 'STATUS',
                fieldPath: 'status',
                before: 'TEST-FAKE-BEFORE',
                after: 'TEST-FAKE-AFTER',
                changedAtKst: '2026-10-12',
                snapshotId: first.snapshotId,
                sourceObservationRef: null,
            }];
        const secondBase = { ...first, history };
        const second = {
            ...secondBase,
            planDigest: stableDigest({
                snapshotId: secondBase.snapshotId,
                rows: secondBase.rows,
                history: secondBase.history,
                baselines: secondBase.baselines,
            }),
        };
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        const result = await rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        expect(result).toMatchObject({ status: 'ROLLED_BACK', deletedRows: 1 });
        expect(store.ledger.size).toBe(1);
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLED_BACK', active: false });
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ACTIVE', active: true });
    });
    it('resumes rollback after delete interruption and restores the previous ACTIVE run', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const second = makePlan({
            p1: product(),
            p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }),
        });
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        store.failDeleteAfter = 1;
        await expect(rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
            .rejects.toThrow('TEST_DELETE_INTERRUPTED');
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLING_BACK', active: false, previousActiveRunId: runIdFor(first) });
        store.failDeleteAfter = Number.POSITIVE_INFINITY;
        const result = await rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        expect(result).toMatchObject({ status: 'ROLLED_BACK', deletedRows: 1 });
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ACTIVE', active: true });
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLED_BACK', active: false });
        expect(store.ledger.has(storageKeyFor(second, second.rows[1]))).toBe(false);
        expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ runId: runIdFor(first) });
    });
    it('stops a resumed rollback when a newer ACTIVE run exists', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const second = makePlan({
            p1: product(),
            p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }),
        });
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        store.failDeleteAfter = 1;
        await expect(rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
            .rejects.toThrow('TEST_DELETE_INTERRUPTED');
        store.failDeleteAfter = Number.POSITIVE_INFINITY;
        const third = makePlan({ p1: product({ price: { '36': { rent: 830000, deposit: 1000000 } } }) });
        await applyPeriodFeeLedgerPlan(store, third, { expectedDigest: third.planDigest, writeApproved: true });
        await expect(rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
            .rejects.toThrow('ROLLBACK_SUPERSEDED_BY_NEWER_ACTIVE');
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'FAILED', active: false });
        expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ runId: runIdFor(third) });
    });
    it('resumes rollback after restore interruption and keeps an ACTIVE run available', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const history = [{
                schemaVersion: 'product-change-history/v1',
                productKey: 'p1',
                kind: 'STATUS',
                fieldPath: 'status',
                before: 'TEST-FAKE-BEFORE',
                after: 'TEST-FAKE-AFTER',
                changedAtKst: '2026-10-12',
                snapshotId: first.snapshotId,
                sourceObservationRef: null,
            }];
        const secondBase = { ...first, history };
        const second = {
            ...secondBase,
            planDigest: stableDigest({
                snapshotId: secondBase.snapshotId,
                rows: secondBase.rows,
                history: secondBase.history,
                baselines: secondBase.baselines,
            }),
        };
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        store.failRestore = true;
        await expect(rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
            .rejects.toThrow('TEST_RESTORE_INTERRUPTED');
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLING_BACK', active: false, previousActiveRunId: runIdFor(first) });
        store.failRestore = false;
        const result = await rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        expect(result).toMatchObject({ status: 'ROLLED_BACK', deletedRows: 0 });
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ACTIVE', active: true });
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLED_BACK', active: false });
        expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ runId: runIdFor(first) });
    });
    it('stores a same-day changed run in separate documents without conflicting with the existing ACTIVE rows', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const second = makePlan({ p1: product({ price: { '36': { rent: 810000, deposit: 1000000 } } }) });
        const result = await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        expect(result).toMatchObject({ status: 'APPLIED', counts: { ledgerCreated: 1 } });
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'SUPERSEDED', active: false });
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ACTIVE', active: true });
        expect(store.ledger.has(storageKeyFor(first, first.rows[0]))).toBe(true);
        expect(store.ledger.has(storageKeyFor(second, second.rows[0]))).toBe(true);
        expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ planDigest: second.planDigest });
    });
    it('keeps the existing ACTIVE run when readback fails for a new run', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const second = planPeriodFeeLedger({
            products: { p1: product({ price: { '36': { rent: 810000, deposit: 1000000 } } }) },
            policies: {},
            referenceInputs: {},
            previousSnapshot: { rows: [], productStates: {} },
        }, { clock: () => new Date('2026-10-13T00:00:00.000Z') });
        store.corruptReadback = true;
        await expect(applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
            .rejects.toThrow('PERIOD_FEE_READBACK_ROW_MISMATCH');
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'PREPARED', active: false });
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ACTIVE', active: true });
        expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ planDigest: first.planDigest });
    });
    it('activates the new run and supersedes the previous active run only after readback', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const history = [{
                schemaVersion: 'product-change-history/v1',
                productKey: 'p1',
                kind: 'STATUS',
                fieldPath: 'status',
                before: 'TEST-FAKE-BEFORE',
                after: 'TEST-FAKE-AFTER',
                changedAtKst: '2026-10-12',
                snapshotId: first.snapshotId,
                sourceObservationRef: null,
            }];
        const secondBase = { ...first, history };
        const second = {
            ...secondBase,
            planDigest: stableDigest({
                snapshotId: secondBase.snapshotId,
                rows: secondBase.rows,
                history: secondBase.history,
                baselines: secondBase.baselines,
            }),
        };
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'SUPERSEDED', active: false });
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ACTIVE', active: true });
        expect([...store.runs.values()].filter(run => run.snapshotId === second.snapshotId && run.active)).toHaveLength(1);
    });
    it('records previousActiveRunId from the actual ACTIVE inside activation', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const second = makePlan({ p1: product({ price: { '36': { rent: 820000, deposit: 1000000 } } }) });
        const staleRun = {
            schemaVersion: 'period-fee-snapshot-run/v1',
            runId: runIdFor(second),
            snapshotId: second.snapshotId,
            planDigest: second.planDigest,
            status: 'ACTIVE',
            active: true,
            previousActiveRunId: 'TEST-FAKE-STALE-RUN',
            preparedAt: observedAt,
            activatedAt: observedAt,
            rowCount: 0,
            rowKeysDigest: stableDigest([]),
            rowContentDigest: stableDigest([]),
            readyRowCount: 0,
            holdNoUidCount: 0,
            historyRowCount: 0,
            historyKeysDigest: stableDigest([]),
            historyContentDigest: stableDigest([]),
            readbackSampleCount: 0,
            readbackDigest: null,
        };
        store.runs.set(runIdFor(second), { ...staleRun, status: 'PREPARED', active: false, activatedAt: null });
        await store.acquireSnapshotWriteLock('TEST-FAKE-ACTIVATOR', observedAt, '2099-01-01T00:00:00.000Z');
        await store.activateSnapshotRun(runIdFor(second), staleRun, {
            lockOwnerId: 'TEST-FAKE-ACTIVATOR',
            checkedAt: observedAt,
        });
        expect(store.runs.get(runIdFor(second))).toMatchObject({ previousActiveRunId: runIdFor(first), active: true });
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'SUPERSEDED', active: false });
    });
    it('does not let a stale PREPARED write overwrite a run that already became ACTIVE', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const active = store.runs.get(runIdFor(plan));
        await expect(store.setSnapshotRun(runIdFor(plan), {
            ...active,
            status: 'PREPARED',
            active: false,
            activatedAt: null,
        })).rejects.toThrow('PERIOD_FEE_RUN_STATE_CONFLICT');
        expect(store.runs.get(runIdFor(plan))).toMatchObject({ status: 'ACTIVE', active: true });
    });
    it('restores the previous ACTIVE when rollback starts from PREPARED with activation history', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const second = makePlan({
            p1: product(),
            p2: product({ vehicle_uid: 'TEST-FAKE-ASSET-002', car_number: 'TEST-FAKE-PLATE-0002' }),
        });
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        const secondRun = store.runs.get(runIdFor(second));
        store.runs.set(runIdFor(second), {
            ...secondRun,
            status: 'PREPARED',
            active: false,
            activatedAt: observedAt,
            previousActiveRunId: runIdFor(first),
        });
        const result = await rollbackPeriodFeeLedgerSnapshot(store, second, {
            expectedDigest: second.planDigest,
            writeApproved: true,
        });
        expect(result).toMatchObject({ status: 'ROLLED_BACK', deletedRows: 2 });
        expect(store.runs.get(runIdFor(first))).toMatchObject({ status: 'ACTIVE', active: true });
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ROLLED_BACK', active: false });
    });
    it('fails ACTIVE ledger reads when rows disappear or ACTIVE changes during the read', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        store.ledger.delete(storageKeyFor(plan, plan.rows[0]));
        await expect(store.readLedgerRows(plan.snapshotId, runIdFor(plan))).rejects.toThrow('LEDGER_READ_INCONSISTENT');
        const freshStore = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(freshStore, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        freshStore.changeActiveDuringReadback = {
            ...freshStore.runs.get(runIdFor(plan)),
            runId: 'TEST-FAKE-NEWER-ACTIVE',
            planDigest: 'TEST-FAKE-NEWER-DIGEST',
            previousActiveRunId: runIdFor(plan),
            status: 'ACTIVE',
            active: true,
        };
        await expect(freshStore.readLedgerRows(plan.snapshotId, runIdFor(plan))).rejects.toThrow('LEDGER_READ_INCONSISTENT');
    });
    it('rejects restoring a previous run when only the row content changed under the same document ID', async () => {
        const first = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, first, { expectedDigest: first.planDigest, writeApproved: true });
        const second = makePlan({ p1: product({ price: { '36': { rent: 820000, deposit: 1000000 } } }) });
        await applyPeriodFeeLedgerPlan(store, second, { expectedDigest: second.planDigest, writeApproved: true });
        const key = storageKeyFor(first, first.rows[0]);
        const changed = {
            ...first.rows[0],
            monthlyRent: { ...first.rows[0].monthlyRent, amount: first.rows[0].monthlyRent.amount + 1 },
        };
        store.ledger.set(key, { digest: stableDigest(changed), data: changed });
        await expect(rollbackPeriodFeeLedgerSnapshot(store, second, { expectedDigest: second.planDigest, writeApproved: true }))
            .rejects.toThrow('LEDGER_READ_INCONSISTENT');
        expect(store.runs.get(runIdFor(second))).toMatchObject({ status: 'ACTIVE', active: true });
        expect(await store.getActiveSnapshotRun(first.snapshotId)).toMatchObject({ runId: runIdFor(second) });
    });
    it('fails ACTIVE reapply when only product_change_history content changed under the same document ID', async () => {
        const history = [{
                schemaVersion: 'product-change-history/v1',
                productKey: 'p1',
                kind: 'STATUS',
                fieldPath: 'status',
                before: 'TEST-FAKE-BEFORE',
                after: 'TEST-FAKE-AFTER',
                changedAtKst: '2026-10-12',
                snapshotId: makePlan().snapshotId,
                sourceObservationRef: null,
            }];
        const base = { ...makePlan(), history };
        const plan = withPlanDigest(base);
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const key = historyStorageKeyFor(plan, history[0]);
        const changed = { ...history[0], after: 'TEST-FAKE-CHANGED-AFTER' };
        store.history.set(key, { digest: stableDigest(changed), data: changed });
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('LEDGER_READ_INCONSISTENT');
    });
    it('fail-closes old run documents that do not have content digests', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const run = store.runs.get(runIdFor(plan));
        const oldRun = { ...run };
        delete oldRun.rowContentDigest;
        delete oldRun.historyContentDigest;
        store.runs.set(runIdFor(plan), oldRun);
        await expect(store.readLedgerRows(plan.snapshotId, runIdFor(plan))).rejects.toThrow('LEDGER_READ_INCONSISTENT');
        await expect(applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('LEDGER_READ_INCONSISTENT');
    });
    it('refuses rollback when the stored run digest does not match and deletes zero rows', async () => {
        const plan = makePlan();
        const store = new MemoryPeriodFeeStore();
        await applyPeriodFeeLedgerPlan(store, plan, { expectedDigest: plan.planDigest, writeApproved: true });
        const runId = runIdFor(plan);
        store.runs.set(runId, { ...store.runs.get(runId), planDigest: 'TEST-FAKE-DIFFERENT-DIGEST' });
        await expect(rollbackPeriodFeeLedgerSnapshot(store, plan, { expectedDigest: plan.planDigest, writeApproved: true }))
            .rejects.toThrow('PERIOD_FEE_ROLLBACK_RUN_DIGEST_MISMATCH');
        expect(store.ledger.size).toBe(1);
        expect(store.runs.get(runId)).toMatchObject({ status: 'ACTIVE', active: true });
    });
    it('keeps the store interface limited to the allowed internal collections', async () => {
        const store = new MemoryPeriodFeeStore();
        await expect(store.forbiddenWrite()).rejects.toThrow('FORBIDDEN_WRITE');
        expect(store.forbiddenWriteAttempt).toBe(true);
    });
});
