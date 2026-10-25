import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sharedSheetEngine, legacyCapture } from '../adapters/shared-sheet-engine.js';
import { assertCurrentSharedSheetSource, sharedSheetHeaders, sharedSheetChannels } from '../adapters/shared-sheet-source.js';
import { sharedSheetStatusPolicy } from '../adapters/normalize-shared-sheet.js';
import { sourceSaleAvailable } from '../domain/source-engine.js';
import { captureSharedSheetReadOnly } from './capture-shared-sheet.js';
import { planSharedSheetCanonical } from './ingest-shared-sheet-canonical.js';
import { MemoryDataStore } from '../infra/memory-store.js';
import { applySourceRecords } from '../application/source-engine.js';
/** No second capture implementation. Live execution is intentionally not exposed by this offline CLI. */
export const createLiveSharedSheetEngine = (id) => sharedSheetEngine(() => {
    assertCurrentSharedSheetSource(id);
    return captureSharedSheetReadOnly(id);
});
/** Environment approval is a separate input from the plan; there is no default approval. */
export const applyApprovedSourcePlan = (commands, plan, digest, now) => applySourceRecords(commands, plan, { apply: true, digest, approval: process.env.FREEPASS_SOURCE_ENGINE_APPROVED_DIGEST ?? '', now });
export const F05_EXPECTED_AVAILABLE = Object.freeze({
    '빌린카': 30, '우리캐피탈': 13, '스타': 13, 'KH': 11, '경진': 9, '웰릭스': 6,
    '제이앤제이': 6, '에코': 5, '렌트존': 4, '리더스': 3, '센트로': 2, '퍼시픽': 1,
});
export async function dryRunSharedSheetEngine(capture, now = Date.now()) {
    const engine = sharedSheetEngine(async () => capture);
    const read = await engine.read();
    if (!read.complete || !read.raw)
        return { mode: 'DRY_RUN', writes: 0, status: 'HOLD', error: read.error, complete: false };
    const normalized = engine.toRecords(read), { legacy, batch } = legacyCapture(capture);
    const suppliers = Object.fromEntries(sharedSheetChannels.map(c => [c.code, 0]));
    for (const item of batch.records) {
        const cells = item.payload.values;
        if (typeof item.payload.supplierCode === 'string' && sharedSheetStatusPolicy(cells[sharedSheetHeaders.indexOf('차량상태')])?.exposure === 'VISIBLE')
            suppliers[item.payload.supplierCode] = (suppliers[item.payload.supplierCode] ?? 0) + 1;
    }
    // Run the original prospective canonical planner as a separate diagnostic. It does not write.
    // Missing master / legacy identity HOLD is not permission to manufacture a new binding.
    const legacyPlan = await planSharedSheetCanonical(new MemoryDataStore(), legacy, 'memory');
    const sourceAvailable = Object.values(suppliers).reduce((a, b) => a + b, 0);
    const tabCounts = {};
    for (const channel of sharedSheetChannels)
        tabCounts[channel.tab] = (tabCounts[channel.tab] ?? 0) + (suppliers[channel.code] ?? 0);
    const supplierComparison = Object.entries(F05_EXPECTED_AVAILABLE).map(([tab, expected]) => ({
        tab, expected, actual: tabCounts[tab] ?? null, delta: tabCounts[tab] === undefined ? null : tabCounts[tab] - expected,
    }));
    return { mode: 'DRY_RUN', writes: 0, status: normalized.held.length || normalized.records.some(r => r.vehicleHold.length) ? 'PARTIAL_HOLD' : 'READY_FOR_REVIEW',
        complete: true, observedAt: capture.readTime, sourceAvailable, suppliers,
        expectedSourceAvailable: 103, countDelta: sourceAvailable - 103, supplierComparison,
        comparison: 'COUNT_ONLY_NOT_ID_PARITY', uidRecords: normalized.records.length, held: normalized.held.length,
        holdReasons: normalized.held.reduce((out, h) => {
            for (const reason of h.reasons)
                out[reason] = (out[reason] ?? 0) + 1;
            return out;
        }, {}),
        freshConditionRecords: normalized.records.filter(r => sourceSaleAvailable(r, 'SHARED_SHEET', now)).length,
        vehicleReviewRecords: normalized.records.filter(r => r.vehicleHold.length).length,
        legacyCanonicalHeld: legacyPlan.report.heldVehicles, planDigest: legacyPlan.report.planDigest };
}
export async function main(args = process.argv.slice(2)) {
    if (args.length !== 2 || args[0] !== '--capture' || !args[1])
        throw new Error('OFFLINE_CAPTURE_REQUIRED');
    const result = await dryRunSharedSheetEngine(JSON.parse(await readFile(args[1], 'utf8')));
    console.log(JSON.stringify(result));
    if (result.status === 'HOLD')
        process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(() => { console.log(JSON.stringify({ mode: 'DRY_RUN', status: 'HOLD', writes: 0, reason: 'OFFLINE_CAPTURE_INVALID' })); process.exitCode = 1; });
}
