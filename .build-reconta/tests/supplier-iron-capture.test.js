import { describe, expect, it, vi } from 'vitest';
import { captureIron, ironCaptureCommand, parseIronTargetsJson } from '../src/jobs/collect-iron.js';
const target = { id: 'fixture-id-1', url: 'https://ironrentcar.com/vehicles/fixture-id-1', plate: 'PRIVATE-PLATE-001' };
const observedAt = '2026-10-03T00:00:00.000Z';
const html = '<main><h1 class="product-detail-title">fixture</h1><dl><dt>차량번호</dt><dd>PRIVATE-PLATE-001</dd></dl><div class="product-detail-rent-row"><dt>48</dt><dd>1</dd></div><div class="product-detail-price-block--deposit">보증금 원문</div><div class="product-detail-gallery"><img src="https://ironrentcar.com/a.jpg"></div></main>';
function readyBatch() {
    return {
        laneId: 'PRODUCT_VEHICLE',
        source: { sourceId: 'supplier:RP006:iron-original-html', kind: 'API', displayName: 'fixture', expectedFreshnessSeconds: null },
        observedAt,
        sourceRevision: 'fixture-revision',
        checksum: 'a'.repeat(64),
        coverage: { mode: 'FULL', completeness: 'COMPLETE', scope: 'fixture' },
        records: [{ sourceRecordId: 'fixture-id-1', sourceFingerprint: 'b'.repeat(64), payload: { hiddenPlate: target.plate } }],
    };
}
function evidence(status, issues) {
    return { adapterId: 'iron-html', supplierCode: 'RP006', scope: 'inventory', capturedAt: observedAt,
        observedAt, recordCount: 1, status, issues,
        canonicalWriteAuthorized: false, publicationAuthorized: false, retirementAuthorized: false };
}
describe('Iron capture command', () => {
    it('rejects raw ingest without explicit approval before collecting', async () => {
        const fetchDetail = vi.fn();
        const ingestRawBatch = vi.fn();
        await expect(captureIron({ targets: [target], applyRaw: true, approved: false }, { fetchDetail, ingestRawBatch }))
            .rejects.toThrow('IRON_RAW_APPROVAL_REQUIRED');
        expect(fetchDetail).not.toHaveBeenCalled();
        expect(ingestRawBatch).not.toHaveBeenCalled();
    });
    it('rejects invalid or empty target lists from IRON_TARGETS_JSON', async () => {
        expect(() => parseIronTargetsJson(undefined)).toThrow('IRON_TARGETS_INVALID');
        expect(() => parseIronTargetsJson('[]')).toThrow('IRON_TARGETS_INVALID');
        expect(() => parseIronTargetsJson('[{"id":"x","url":"https://evil.test/vehicles/x","plate":"p"}]'))
            .toThrow('IRON_TARGETS_INVALID');
        await expect(ironCaptureCommand([], { IRON_TARGETS_JSON: '{' })).rejects.toThrow('IRON_TARGETS_INVALID');
    });
    it('does not ingest in read-only mode', async () => {
        const fetchDetail = vi.fn().mockResolvedValue({ html, observedAt, revision: 'fixture-revision' });
        const ingestRawBatch = vi.fn();
        const report = await captureIron({ targets: [target], applyRaw: false, approved: false }, { fetchDetail, ingestRawBatch });
        expect(report.counts.records).toBe(1);
        expect(report.issues.length).toBeGreaterThan(0);
        expect(fetchDetail).toHaveBeenCalledTimes(1);
        expect(ingestRawBatch).not.toHaveBeenCalled();
    });
    it('does not ingest when evidence is not RAW_READY', async () => {
        const batch = readyBatch();
        const collect = vi.fn(async (_adapter) => ({
            batch,
            evidence: evidence('HOLD', ['IRON_TERMS_UNKNOWN']),
        }));
        const ingestRawBatch = vi.fn();
        await expect(captureIron({ targets: [target], applyRaw: true, approved: true }, { collect, ingestRawBatch }))
            .rejects.toThrow('IRON_RAW_SOURCE_HOLD');
        expect(ingestRawBatch).not.toHaveBeenCalled();
    });
    it('ingests once when approved and evidence is RAW_READY', async () => {
        const batch = readyBatch();
        const collect = vi.fn(async (_adapter) => ({
            batch,
            evidence: evidence('RAW_READY', []),
        }));
        const ingestRawBatch = vi.fn();
        const report = await captureIron({ targets: [target], applyRaw: true, approved: true }, { collect, ingestRawBatch });
        expect(report).toEqual({ counts: { records: 1 }, digest: 'a'.repeat(64), issues: [] });
        expect(ingestRawBatch).toHaveBeenCalledTimes(1);
        expect(ingestRawBatch).toHaveBeenCalledWith(batch);
    });
    it('does not expose vehicle plates in output', async () => {
        const batch = readyBatch();
        const collect = vi.fn(async (_adapter) => ({
            batch,
            evidence: evidence('RAW_READY', []),
        }));
        const report = await captureIron({ targets: [target], applyRaw: false, approved: false }, { collect });
        expect(JSON.stringify(report)).not.toContain(target.plate);
    });
});
