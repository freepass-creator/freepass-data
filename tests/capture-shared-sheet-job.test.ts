import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharedSheetTabs } from '../src/adapters/shared-sheet-capture.js';
import { sharedSheetChannels, sharedSheetHeaders } from '../src/adapters/shared-sheet-source.js';

// 온라인 경로의 시트 읽기를 가짜로 바꾼다 — 차례대로 준비한 응답을 돌려준다.
const reads: unknown[] = [];
vi.mock('../src/infra/shared-sheet-capture-reader.js', () => ({
  readSheetsMetadata: async () => META(),
  readSheetsBatchGet: async () => { if (!reads.length) throw new Error('NO_MORE_READS'); return reads.shift(); },
}));
const { main } = await import('../src/jobs/capture-shared-sheet.js');

const ID = 'synthetic_spreadsheet_id_0001', ROWS = 1000;
const META = () => ({ spreadsheetId: ID, sheets: sharedSheetTabs().map(title => ({ properties: { title, gridProperties: { rowCount: ROWS } } })) });
const ch = sharedSheetChannels[0]!, at = (h: string) => sharedSheetHeaders.indexOf(h);
const row = (date: unknown) => { const r = Array.from({ length: sharedSheetHeaders.length }, () => '' as unknown); r[0] = ch.companyName; r[4] = '12가3456'; r[at('입고일자')] = date; return r; };
const batch = (date: unknown) => ({ spreadsheetId: ID, valueRanges: sharedSheetTabs().map(t => ({ range: `'${t}'!A1:BV${ROWS}`, values: [[...sharedSheetHeaders], ...(t === ch.tab ? [row(date)] : [])] })) });
let dir = '';
const fresh = async () => { dir = await mkdtemp(join(tmpdir(), 'capture-job-')); return join(dir, 'capture.json'); };
afterEach(async () => { vi.useRealTimers(); reads.length = 0; if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

describe('capture-shared-sheet job: no output unless every check passes', () => {
  it('local input without both serial reads stops before writing anything', async () => {
    const out = await fresh(), shown = join(dir, 'shown.json'), meta = join(dir, 'meta.json'), serial = join(dir, 'serial.json');
    await writeFile(shown, JSON.stringify(batch('08-12'))); await writeFile(meta, JSON.stringify(META())); await writeFile(serial, JSON.stringify(batch(46246)));
    for (const extra of [[], ['--from-batchget-serials', serial]]) {
      await expect(main(['--spreadsheet', ID, '--out', out, '--from-batchget', shown, '--grid-meta', meta, '--read-time', '2026-10-04T13:00:00.000Z', ...extra]))
        .rejects.toThrow('SHARED_SHEET_CAPTURE_SERIALS_REQUIRED');
      expect(existsSync(out)).toBe(false);
    }
  });
  it('online: re-reads after a change during the read, then writes the stable capture with the year kept', async () => {
    vi.useFakeTimers();
    const out = await fresh();
    reads.push(batch(46246), batch('08-12'), batch(45881), batch(46246), batch('08-12'), batch(46246));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = main(['--spreadsheet', ID, '--out', out]);
    await vi.advanceTimersByTimeAsync(30_000);
    await run;
    expect(reads).toHaveLength(0);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).datesFromSerial).toBe(1);
    log.mockRestore();
  });
  it('online: a number cell whose display disagrees with its real value (both serial reads equal) stops after retries and writes nothing', async () => {
    vi.useFakeTimers();
    const out = await fresh();
    const withYear = (b: ReturnType<typeof batch>, year: unknown) => { const r = b.valueRanges.find(x => x.values.length > 1)!.values[1]!; r[at('연식')] = year; return b; };
    for (let i = 0; i < 3; i++) reads.push(withYear(batch(46246), 2020), withYear(batch('08-12'), '2021'), withYear(batch(46246), 2020));
    const run = main(['--spreadsheet', ID, '--out', out]);
    const settled = expect(run).rejects.toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
    expect(existsSync(out)).toBe(false);
  });
  it('online: still changing after three tries → stops with a fixed code and writes nothing', async () => {
    vi.useFakeTimers();
    const out = await fresh();
    for (let i = 0; i < 3; i++) reads.push(batch(46246), batch('08-12'), batch(46247 + i));
    const run = main(['--spreadsheet', ID, '--out', out]);
    const settled = expect(run).rejects.toThrow('SHARED_SHEET_CAPTURE_CHANGED_DURING_READ');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
    expect(reads).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  });
});
