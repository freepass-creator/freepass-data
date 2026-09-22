import { describe, expect, it } from 'vitest';
import { captureIancarSource, inspectIancarCapture, IANCAR_SHEET_TABS } from '../src/adapters/iancar-source-capture.js';

const transport = (rateCoverageComplete = true, complete = true) => ({
  async readErp() { return { sourceRevision: 'erp:r1', observedAt: '2026-09-22T07:00:00Z', collectionComplete: complete,
    vehicles: [{ vehicleNo: 'private-1' }], rateQuotes: rateCoverageComplete ? [{ vehicleNo: 'private-1', months: 24, rent: 1 }] : [],
    rateCoverageComplete, raw: { source: 'synthetic', vehicles: [{ vehicleNo: 'private-1' }] } }; },
  async readSheetTab(tab: typeof IANCAR_SHEET_TABS[number]) { return { sourceRevision: `sheet:${tab.gid}`,
    observedAt: '2026-09-22T07:00:01Z', collectionComplete: complete, rowCount: 1, rawCsv: '차량번호\nprivate-1' }; }
});

describe('Iancar two-source capture', () => {
  it('preserves independent ERP and both Sheet originals with a digest', async () => {
    const capture = await captureIancarSource(transport());
    expect(capture.erp.raw).toEqual({ source: 'synthetic', vehicles: [{ vehicleNo: 'private-1' }] });
    expect(capture.sheet.tabs.map(tab => tab.title)).toEqual(['이안카', '이안카 재렌트']);
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
});
