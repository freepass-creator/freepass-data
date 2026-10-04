import { describe, expect, it } from 'vitest';
import { captureFromBatchGet as rawCapture, sharedSheetTabs, sharedSheetCaptureRanges, SHEETS_GRID_META_FIELDS, type SheetsBatchGet, type SheetsGridMeta } from '../src/adapters/shared-sheet-capture.js';
import { readSheetsBatchGet, readSheetsMetadata } from '../src/infra/shared-sheet-capture-reader.js';
const ROWS = 1000;
const META = (): SheetsGridMeta => ({ spreadsheetId: ID, sheets: sharedSheetTabs().map(title => ({ properties: { title, gridProperties: { rowCount: ROWS } } })) });
const captureFromBatchGet = (id: string, raw: SheetsBatchGet, t: string) => rawCapture(id, raw, META(), t);
const readSharedSheetCapture = async (id: string, ports: { accessToken: () => Promise<string>; now: () => string; fetcher: typeof fetch }) =>
  rawCapture(id, await readSheetsBatchGet(id, sharedSheetCaptureRanges(), ports) as SheetsBatchGet,
    await readSheetsMetadata(id, SHEETS_GRID_META_FIELDS, ports) as SheetsGridMeta, ports.now());
import { buildSharedSheetBatch, sharedSheetChannels, sharedSheetHeaders } from '../src/adapters/shared-sheet-source.js';
import { normalizeSharedSheet } from '../src/adapters/normalize-shared-sheet.js';
import { prepareRawSourceBatch } from '../src/application/ingest-raw-source.js';

const ID = 'synthetic_spreadsheet_id_0001';
const T = '2026-10-04T02:00:00.000Z';
function batch(extra: Record<string, unknown[][]> = {}) {
  return { spreadsheetId: ID, valueRanges: sharedSheetTabs().map(t => ({ range: `'${t}'!A1:BV${ROWS}`, values: [[...sharedSheetHeaders], ...(extra[t] ?? [])] })) };
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

  it('claims complete only when every returned range is the whole expected tab, in order', () => {
    const b = batch();
    const swap = { ...b, valueRanges: [b.valueRanges[1]!, b.valueRanges[0]!, ...b.valueRanges.slice(2)] };
    expect(() => captureFromBatchGet(ID, swap, T)).toThrow('SHARED_SHEET_CAPTURE_RANGE_MISMATCH');
    const partial = { ...b, valueRanges: b.valueRanges.map((r, i) => i ? r : { ...r, range: r.range.replace(`BV${ROWS}`, 'BV5') }) };
    expect(() => captureFromBatchGet(ID, partial, T)).toThrow('SHARED_SHEET_CAPTURE_RANGE_MISMATCH');
    const narrow = { ...b, valueRanges: b.valueRanges.map((r, i) => i ? r : { ...r, range: r.range.replace('BV', 'H') }) };
    expect(() => captureFromBatchGet(ID, narrow, T)).toThrow('SHARED_SHEET_CAPTURE_RANGE_MISMATCH');
    const noRange = { ...b, valueRanges: b.valueRanges.map((r, i) => i ? r : { values: r.values }) };
    expect(() => captureFromBatchGet(ID, noRange as SheetsBatchGet, T)).toThrow('SHARED_SHEET_CAPTURE_RANGE_MISMATCH');
    expect(() => rawCapture(ID, b, { ...META(), spreadsheetId: 'other' }, T)).toThrow('SHARED_SHEET_CAPTURE_WRONG_SPREADSHEET');
  });

  it('reads through one bearer-authorized batchGet and maps HTTP errors to codes', async () => {
    let seen: URL | undefined;
    const ok = await readSharedSheetCapture(ID, { accessToken: async () => 'tok', now: () => T,
      fetcher: (async (u: URL, init: RequestInit) => { seen = u; expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
        return new Response(JSON.stringify(u.pathname.endsWith(':batchGet') ? batch() : META())); }) as unknown as typeof fetch });
    expect(ok.tabs).toHaveLength(sharedSheetTabs().length);
    expect(seen!.searchParams.get('fields')).toBe(SHEETS_GRID_META_FIELDS);
    await expect(readSharedSheetCapture(ID, { accessToken: async () => 'tok', now: () => T,
      fetcher: (async () => new Response('', { status: 403 })) as unknown as typeof fetch })).rejects.toThrow('SHARED_SHEET_HTTP_403');
  });
});

describe('shared sheet capture keeps the year of date cells', () => {
  it('uses the real serial value of 입고일자·최초등록일 as YYYY-MM-DD; text dates and other columns stay as displayed', () => {
    const ch = sharedSheetChannels[0]!, H = sharedSheetHeaders, at = (h: string) => H.indexOf(h);
    const shown = Array.from({ length: H.length }, () => '' as unknown); shown[0] = ch.companyName; shown[4] = '12가3456';
    shown[at('입고일자')] = '08-12'; shown[at('최초등록일')] = '20-07'; shown[at('연식')] = '2021';
    const real = [...shown]; real[at('입고일자')] = 46246; real[at('최초등록일')] = '20-07'; real[at('연식')] = 2021;
    const shownBatch = batch({ [ch.tab]: [shown] }), realBatch = batch({ [ch.tab]: [real] });
    const c = rawCapture(ID, shownBatch, META(), T, realBatch);
    const row = c.tabs.find(t => t.title === ch.tab)!.values[1]!;
    expect(row[at('입고일자')]).toBe('2026-08-12');
    expect(row[at('최초등록일')]).toBe('20-07');
    expect(row[at('연식')]).toBe('2021');
    expect(rawCapture(ID, shownBatch, META(), T).tabs.find(t => t.title === ch.tab)!.values[1]![at('입고일자')]).toBe('08-12');
    const wrong = { ...realBatch, valueRanges: realBatch.valueRanges.map((r, i) => i === 0 ? { ...r, range: 'x!A1:BV1' } : r) };
    expect(() => rawCapture(ID, shownBatch, META(), T, wrong)).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    // 두 번 읽는 사이 바뀐 시트: 줄 수가 다르거나, 같은 자리에 다른 차가 오거나, 날짜가 보이는 값과 다르면 멈춘다.
    const extraRow = batch({ [ch.tab]: [real, real] });
    expect(() => rawCapture(ID, shownBatch, META(), T, extraRow)).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    const otherCar = [...real]; otherCar[4] = '34나5678';
    expect(() => rawCapture(ID, shownBatch, META(), T, batch({ [ch.tab]: [otherCar] }))).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    const otherDate = [...real]; otherDate[at('입고일자')] = 46247;
    expect(() => rawCapture(ID, shownBatch, META(), T, batch({ [ch.tab]: [otherDate] }))).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    // 연도가 보이는 형식(yy-mm-dd)도 맞춰 본다; 머리줄과 1999 이전·소수 값은 바꾸지 않는다.
    const fullShown = [...shown]; fullShown[at('최초등록일')] = '20-07-03';
    const fullReal = [...real]; fullReal[at('최초등록일')] = 44015; fullReal[at('입고일자')] = 46246.5;
    const row2 = rawCapture(ID, batch({ [ch.tab]: [fullShown] }), META(), T, batch({ [ch.tab]: [fullReal] })).tabs.find(t => t.title === ch.tab)!.values;
    expect(row2[1]![at('최초등록일')]).toBe('2020-07-03');
    expect(row2[1]![at('입고일자')]).toBe('08-12');
    expect(row2[0]![at('입고일자')]).toBe('입고일자');
    // 월/일/연 표시도 같은 날이면 통과한다.
    const usShown = [...shown]; usShown[at('최초등록일')] = '7/3/2020';
    expect(rawCapture(ID, batch({ [ch.tab]: [usShown] }), META(), T, batch({ [ch.tab]: [fullReal] })).tabs.find(t => t.title === ch.tab)!.values[1]![at('최초등록일')]).toBe('2020-07-03');
    // 글자 칸이 다르면(같은 회사·같은 번호라도) 멈춘다.
    const otherText = [...real]; otherText[at('비고')] = '다른 차';
    expect(() => rawCapture(ID, shownBatch, META(), T, batch({ [ch.tab]: [otherText] }))).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    // 날짜 말고 글자가 모두 같은 두 줄(«미정» 둘)은 서로 바뀌어도 알 수 없으니 날짜를 바꾸지 않는다.
    const twinA = [...real], twinB = [...real]; twinB[at('입고일자')] = 45881;
    const dup = rawCapture(ID, batch({ [ch.tab]: [shown, shown] }), META(), T, batch({ [ch.tab]: [twinB, twinA] })).tabs.find(t => t.title === ch.tab)!.values;
    expect(dup[1]![at('입고일자')]).toBe('08-12');
    expect(dup[2]![at('입고일자')]).toBe('08-12');
  });
});
