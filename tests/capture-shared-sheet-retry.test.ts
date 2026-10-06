import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharedSheetTabs } from '../src/adapters/shared-sheet-capture.js';
import { sharedSheetChannels, sharedSheetHeaders } from '../src/adapters/shared-sheet-source.js';

// 시트 읽기를 가짜로: 준비한 응답(또는 오류)을 차례로 돌려준다. 시험 자료는 합성값이다.
const reads: Array<unknown> = [];
vi.mock('../src/infra/shared-sheet-capture-reader.js', () => ({
  readSheetsMetadata: async () => META(),
  readSheetsBatchGet: async () => { const next = reads.shift(); if (next instanceof Error) throw next; if (!next) throw new Error('NO_MORE_READS'); return next; },
}));
const { main } = await import('../src/jobs/capture-shared-sheet.js');

const ID = 'synthetic_spreadsheet_id_0001', ROWS = 1000;
const META = () => ({ spreadsheetId: ID, sheets: sharedSheetTabs().map(title => ({ properties: { title, gridProperties: { rowCount: ROWS } } })) });
const ch = sharedSheetChannels[0]!, at = (h: string) => sharedSheetHeaders.indexOf(h);
const row = (date: unknown) => { const r = Array.from({ length: sharedSheetHeaders.length }, () => '' as unknown); r[0] = ch.companyName; r[4] = '12가3456'; r[at('입고일자')] = date; return r; };
const batch = (date: unknown) => ({ spreadsheetId: ID, valueRanges: sharedSheetTabs().map(t => ({ range: `'${t}'!A1:BV${ROWS}`, values: [[...sharedSheetHeaders], ...(t === ch.tab ? [row(date)] : [])] })) });
let dir = '';
afterEach(async () => { vi.useRealTimers(); reads.length = 0; if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

describe('capture-shared-sheet: transient sheet read errors are retried before any write', () => {
  it('a read timeout (SHARED_SHEET_READ_UNKNOWN) or 503 is read again after 30 seconds and the capture succeeds', async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'capture-retry-'));
    const out = join(dir, 'capture.json');
    reads.push(new Error('SHARED_SHEET_READ_UNKNOWN'), new Error('SHARED_SHEET_HTTP_503'), batch(46246), batch('08-12'), batch(46246));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = main(['--spreadsheet', ID, '--out', out]);
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    expect(existsSync(out)).toBe(true);
    log.mockRestore();
  });
  it('a non-transient error (403) stops at once and writes nothing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'capture-retry-'));
    const out = join(dir, 'capture.json');
    reads.push(new Error('SHARED_SHEET_HTTP_403'));
    await expect(main(['--spreadsheet', ID, '--out', out])).rejects.toThrow('SHARED_SHEET_HTTP_403');
    expect(existsSync(out)).toBe(false);
  });
  it('three transient failures in a row stop with the read error and write nothing', async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'capture-retry-'));
    const out = join(dir, 'capture.json');
    reads.push(new Error('SHARED_SHEET_READ_UNKNOWN'), new Error('SHARED_SHEET_READ_UNKNOWN'), new Error('SHARED_SHEET_READ_UNKNOWN'));
    const run = main(['--spreadsheet', ID, '--out', out]);
    const settled = expect(run).rejects.toThrow('SHARED_SHEET_READ_UNKNOWN');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
    expect(existsSync(out)).toBe(false);
  });
});
