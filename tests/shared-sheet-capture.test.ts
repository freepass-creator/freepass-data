import { describe, expect, it } from 'vitest';
import { captureFromBatchGet, sharedSheetTabs, sharedSheetCaptureRanges, type SheetsBatchGet } from '../src/adapters/shared-sheet-capture.js';
import { readSheetsBatchGet } from '../src/infra/shared-sheet-capture-reader.js';
const readSharedSheetCapture = async (id: string, ports: { accessToken: () => Promise<string>; now: () => string; fetcher: typeof fetch }) =>
  captureFromBatchGet(id, await readSheetsBatchGet(id, sharedSheetCaptureRanges(), ports) as SheetsBatchGet, ports.now());
import { buildSharedSheetBatch, sharedSheetChannels, sharedSheetHeaders } from '../src/adapters/shared-sheet-source.js';
import { normalizeSharedSheet } from '../src/adapters/normalize-shared-sheet.js';
import { prepareRawSourceBatch } from '../src/application/ingest-raw-source.js';

const ID = 'synthetic_spreadsheet_id_0001';
const T = '2026-10-04T02:00:00.000Z';
function batch(extra: Record<string, unknown[][]> = {}) {
  return { spreadsheetId: ID, valueRanges: sharedSheetTabs().map(t => ({ values: [[...sharedSheetHeaders], ...(extra[t] ?? [])] })) };
}

describe('shared sheet capture reader', () => {
  it('pads short rows to the 74-column contract, keeps blank rows and validates the capture', () => {
    const ch = sharedSheetChannels[0]!;
    const c = captureFromBatchGet(ID, batch({ [ch.tab]: [[ch.companyName, '', '', '', '12가3456'], []] }), T);
    expect(sharedSheetCaptureRanges()).toHaveLength(sharedSheetTabs().length);
    const tab = c.tabs.find(t => t.title === ch.tab)!;
    expect(tab.rowCount).toBe(3);
    expect(tab.values.every(r => r.length === sharedSheetHeaders.length)).toBe(true);
    expect(buildSharedSheetBatch(c).records).toHaveLength(1);
  });

  it('placeholder plates (신차) are not identities: repeated rows are kept and held, not rejected as duplicates', () => {
    const ch = sharedSheetChannels[0]!;
    const c = captureFromBatchGet(ID, batch({ [ch.tab]: [[ch.companyName, '', '', '', '신차'], [ch.companyName, '', '', '', '신차']] }), T);
    const p = prepareRawSourceBatch(buildSharedSheetBatch(c));
    const issues = p.rawRecords.map(normalizeSharedSheet).map(x => x.record.candidate.issues);
    expect(issues).toHaveLength(2);
    expect(issues.every(i => i.includes('PLATE_NOT_ASSIGNED'))).toBe(true);
  });

  it('fails closed on a missing tab, a wrong spreadsheet or an over-wide row', () => {
    const b = batch();
    expect(() => captureFromBatchGet(ID, { ...b, valueRanges: b.valueRanges.slice(1) }, T)).toThrow('SHARED_SHEET_CAPTURE_INCOMPLETE');
    expect(() => captureFromBatchGet(ID, { ...b, spreadsheetId: 'other' }, T)).toThrow('SHARED_SHEET_CAPTURE_WRONG_SPREADSHEET');
    const wide = batch({ [sharedSheetTabs()[0]!]: [Array(sharedSheetHeaders.length + 1).fill('x')] });
    expect(() => captureFromBatchGet(ID, wide, T)).toThrow('SHARED_SHEET_CAPTURE_ROW_INVALID');
  });

  it('reads through one bearer-authorized batchGet and maps HTTP errors to codes', async () => {
    let seen: URL | undefined;
    const ok = await readSharedSheetCapture(ID, { accessToken: async () => 'tok', now: () => T,
      fetcher: (async (u: URL, init: RequestInit) => { seen = u; expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
        return new Response(JSON.stringify(batch())); }) as unknown as typeof fetch });
    expect(ok.tabs).toHaveLength(sharedSheetTabs().length);
    expect(seen!.searchParams.getAll('ranges')).toHaveLength(sharedSheetTabs().length);
    await expect(readSharedSheetCapture(ID, { accessToken: async () => 'tok', now: () => T,
      fetcher: (async () => new Response('', { status: 403 })) as unknown as typeof fetch })).rejects.toThrow('SHARED_SHEET_HTTP_403');
  });
});
