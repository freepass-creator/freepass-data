import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { captureIancarSource, inspectIancarCapture, IANCAR_SHEET_TABS } from '../src/adapters/iancar-source-capture.js';

const transport = (rateCoverageComplete = true, complete = true) => ({
  async readErp() { return { sourceRevision: 'erp:r1', observedAt: '2026-09-22T07:00:00Z', collectionComplete: complete,
    parserVersion: 'synthetic-parser/1', vehicles: [{ vehicleNo: 'private-1' }],
    rateQuotes: rateCoverageComplete ? [{ vehicleNo: 'private-1', months: 24, rent: 1 }] : [],
    rateCoverageComplete, raw: { source: 'synthetic', vehicles: [{ vehicleNo: 'private-1' }] } }; },
  async readSheetTab(tab: typeof IANCAR_SHEET_TABS[number]) { return { sourceRevision: `sheet:${tab.gid}`,
    observedAt: '2026-09-22T07:00:01Z', collectionComplete: complete, rowCount: 1, rawCsv: '차량번호\nprivate-1' }; }
});

describe('Iancar two-source capture', () => {
  it('preserves independent ERP and both Sheet originals with a digest', async () => {
    const capture = await captureIancarSource(transport());
    expect(capture.erp.raw).toEqual({ source: 'synthetic', vehicles: [{ vehicleNo: 'private-1' }] });
    expect(capture.sheet.tabs.map(tab => tab.title)).toEqual(['이안카', '이안카 재렌트']);
    expect(capture.crossSourceConsistency).toBe('NON_ATOMIC');
    expect(capture.erp.rawDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(capture.sheet.tabs[0]?.rawCsv).toContain('private-1');
    expect(inspectIancarCapture(capture)).toMatchObject({ status: 'READY_FOR_MAPPING_REVIEW', canonicalWriteAuthorized: false });
  });
  it('detects any mutation of preserved source evidence', async () => {
    const capture = await captureIancarSource(transport());
    capture.erp.vehicles.push({ vehicleNo: 'changed' });
    expect(() => inspectIancarCapture(capture)).toThrow('IANCAR_CAPTURE_DIGEST_MISMATCH');
  });
  it('preserves incomplete evidence but holds mapping and price activation', async () => {
    expect(inspectIancarCapture(await captureIancarSource(transport(false, false)))).toMatchObject({
      status: 'HOLD', coverageComplete: false, pricingComplete: false, cutoverAuthorized: false
    });
  });
  it('keeps coverage and pricing holds independent', async () => {
    expect(inspectIancarCapture(await captureIancarSource(transport(false, true)))).toMatchObject({
      status: 'HOLD', coverageComplete: true, pricingComplete: false,
      remaining: ['ERP_RATE_COVERAGE_INCOMPLETE', 'NO_CANONICAL_WRITE_OR_CONSUMER_CUTOVER']
    });
  });
  it('fails the entire capture when either Sheet tab fails', async () => {
    const base = transport();
    await expect(captureIancarSource({ ...base, async readSheetTab(tab) {
      if (tab.gid === '126495265') throw new Error('synthetic sheet failure');
      return base.readSheetTab(tab);
    } })).rejects.toThrow('synthetic sheet failure');
  });
  it('rejects unsupported non-JSON ERP values instead of silently losing them', async () => {
    const base = transport();
    await expect(captureIancarSource({ ...base, async readErp() {
      return { ...(await base.readErp()), raw: { bad: undefined } } as never;
    } })).rejects.toThrow('INVALID_IANCAR_ERP_CAPTURE');
  });
  it('rejects non-plain ERP objects whose JSON representation could hide derivation changes', async () => {
    const base = transport();
    await expect(captureIancarSource({ ...base, async readErp() {
      return { ...(await base.readErp()), raw: new Date('2026-09-22T07:00:00Z') } as never;
    } })).rejects.toThrow('INVALID_IANCAR_ERP_CAPTURE');
  });
  it('persists once under the fixed private root and verifies the readback digest', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'iancar-capture-test-'));
    try {
      vi.resetModules();
      vi.doMock('node:os', () => ({ homedir: () => fakeHome }));
      const isolated = await import('../src/adapters/iancar-source-capture.js');
      const capture = await isolated.captureIancarSource(transport());
      const saved = await isolated.persistIancarCapture(capture);
      expect(saved.capturePath.startsWith(join(fakeHome, '.codex', 'private'))).toBe(true);
      expect(JSON.parse(await readFile(saved.capturePath, 'utf8')).digest).toBe(capture.digest);
    } finally {
      vi.doUnmock('node:os');
      vi.resetModules();
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
