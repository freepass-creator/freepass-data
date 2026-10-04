import { describe, expect, it } from 'vitest';
import { captureFromBatchGet as rawCapture, serialToIsoDate, displayMatchesValue, sharedSheetTabs, sharedSheetCaptureRanges, SHEETS_GRID_META_FIELDS, type SheetsBatchGet, type SheetsGridMeta } from '../src/adapters/shared-sheet-capture.js';
import { readSheetsBatchGet, readSheetsMetadata } from '../src/infra/shared-sheet-capture-reader.js';
const ROWS = 1000;
const META = (): SheetsGridMeta => ({ spreadsheetId: ID, sheets: sharedSheetTabs().map(title => ({ properties: { title, gridProperties: { rowCount: ROWS } } })) });
// 글자만 있는 시험 자료는 실제 값 조회도 같은 글자다 — 같은 자료를 앞뒤 실제 값 조회로도 넣는다.
const captureFromBatchGet = (id: string, raw: SheetsBatchGet, t: string) => rawCapture(id, raw, META(), t, raw, raw);
const readSharedSheetCapture = async (id: string, ports: { accessToken: () => Promise<string>; now: () => string; fetcher: typeof fetch }) =>
  (async (raw: SheetsBatchGet) => rawCapture(id, raw, await readSheetsMetadata(id, SHEETS_GRID_META_FIELDS, ports) as SheetsGridMeta, ports.now(), raw, raw))(
    await readSheetsBatchGet(id, sharedSheetCaptureRanges(), ports) as SheetsBatchGet);
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
    expect(() => rawCapture(ID, b, { ...META(), spreadsheetId: 'other' }, T, b, b)).toThrow('SHARED_SHEET_CAPTURE_WRONG_SPREADSHEET');
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
    const c = rawCapture(ID, shownBatch, META(), T, realBatch, realBatch);
    const row = c.tabs.find(t => t.title === ch.tab)!.values[1]!;
    expect(row[at('입고일자')]).toBe('2026-08-12');
    expect(row[at('최초등록일')]).toBe('20-07');
    expect(row[at('연식')]).toBe('2021');
    // 실제 값 조회가 없으면(파일 입력 경로 포함) 연도 없는 값을 박제하지 않게 멈춘다.
    expect(() => (rawCapture as (...a: unknown[]) => unknown)(ID, shownBatch, META(), T)).toThrow('SHARED_SHEET_CAPTURE_SERIALS_REQUIRED');
    // 글자로 적힌 날짜는 실제 값과 보이는 값이 같은 글자여야 한다(«20-07» ↔ «21-07» 이면 멈춤).
    const textOff = [...real]; textOff[at('최초등록일')] = '21-07';
    expect(() => rawCapture(ID, shownBatch, META(), T, batch({ [ch.tab]: [textOff] }), batch({ [ch.tab]: [textOff] }))).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    const wrong = { ...realBatch, valueRanges: realBatch.valueRanges.map((r, i) => i === 0 ? { ...r, range: 'x!A1:BV1' } : r) };
    expect(() => rawCapture(ID, shownBatch, META(), T, wrong, wrong)).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    // 두 번 읽는 사이 바뀐 시트: 줄 수가 다르거나, 같은 자리에 다른 차가 오거나, 날짜가 보이는 값과 다르면 멈춘다.
    const extraRow = batch({ [ch.tab]: [real, real] });
    expect(() => rawCapture(ID, shownBatch, META(), T, extraRow, extraRow)).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    const otherCar = [...real]; otherCar[4] = '34나5678';
    expect(() => rawCapture(ID, shownBatch, META(), T, batch({ [ch.tab]: [otherCar] }), batch({ [ch.tab]: [otherCar] }))).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    const otherDate = [...real]; otherDate[at('입고일자')] = 46247;
    expect(() => rawCapture(ID, shownBatch, META(), T, batch({ [ch.tab]: [otherDate] }), batch({ [ch.tab]: [otherDate] }))).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    // 연도가 보이는 형식(yy-mm-dd)도 맞춰 본다; 시각이 붙은 값(소수)은 그날 날짜로, 머리줄은 그대로.
    const fullShown = [...shown]; fullShown[at('최초등록일')] = '20-07-03';
    const fullReal = [...real]; fullReal[at('최초등록일')] = 44015; fullReal[at('입고일자')] = 46246.5;
    const row2 = rawCapture(ID, batch({ [ch.tab]: [fullShown] }), META(), T, batch({ [ch.tab]: [fullReal] }), batch({ [ch.tab]: [fullReal] })).tabs.find(t => t.title === ch.tab)!.values;
    expect(row2[1]![at('최초등록일')]).toBe('2020-07-03');
    expect(row2[1]![at('입고일자')]).toBe('2026-08-12');
    expect(row2[0]![at('입고일자')]).toBe('입고일자');
    // 숫자인데 날짜로 못 읽는 값(2100년 이후)은 연도를 잃지 않게 멈춘다.
    const farReal = [...real]; farReal[at('입고일자')] = 80000;
    expect(() => rawCapture(ID, shownBatch, META(), T, batch({ [ch.tab]: [farReal] }), batch({ [ch.tab]: [farReal] }))).toThrow('SHARED_SHEET_CAPTURE_DATE_UNREADABLE');
    // 숫자 칸도 보이는 값이 같은 실제 값을 가리켜야 한다(«2021» ↔ 2020 이면 멈춤).
    const numOff = [...real]; numOff[at('연식')] = 2020;
    expect(() => rawCapture(ID, shownBatch, META(), T, batch({ [ch.tab]: [numOff] }), batch({ [ch.tab]: [numOff] }))).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    // 월/일/연 표시도 같은 날이면 통과한다.
    const usShown = [...shown]; usShown[at('최초등록일')] = '7/3/2020';
    expect(rawCapture(ID, batch({ [ch.tab]: [usShown] }), META(), T, batch({ [ch.tab]: [fullReal] }), batch({ [ch.tab]: [fullReal] })).tabs.find(t => t.title === ch.tab)!.values[1]![at('최초등록일')]).toBe('2020-07-03');
    // 보이는 값은 어떤 읽기로든 실제 날짜와 어긋나지 않으면 된다(일/월/연 · 연-월만 · 두 자리 연도 끝) — 그 사이 변경은
    // 앞뒤 실제 값 조회가 같다는 것으로 따로 막는다. 어떤 읽기로도 안 맞는 날은 멈춘다.
    for (const ok of ['3/7/2020', '07-03-20', '20-07', '2020-07']) {
      const v = [...shown]; v[at('최초등록일')] = ok;
      expect(rawCapture(ID, batch({ [ch.tab]: [v] }), META(), T, batch({ [ch.tab]: [fullReal] }), batch({ [ch.tab]: [fullReal] })).tabs.find(t => t.title === ch.tab)!.values[1]![at('최초등록일')]).toBe('2020-07-03');
    }
    for (const bad of ['3/8/2020', '21-07', '20-08-03']) {
      const v = [...shown]; v[at('최초등록일')] = bad;
      expect(() => rawCapture(ID, batch({ [ch.tab]: [v] }), META(), T, batch({ [ch.tab]: [fullReal] }), batch({ [ch.tab]: [fullReal] }))).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    }
    // 글자 칸이 다르면(같은 회사·같은 번호라도) 멈춘다.
    const otherText = [...real]; otherText[at('비고')] = '다른 차';
    expect(() => rawCapture(ID, shownBatch, META(), T, batch({ [ch.tab]: [otherText] }), batch({ [ch.tab]: [otherText] }))).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
    // 날짜 말고 글자가 모두 같은 두 줄(«미정» 둘)도 줄 위치로 짝지어 제 날짜(연도 포함)를 받는다.
    const twinA = [...real], twinB = [...real]; twinB[at('입고일자')] = 45881;
    const dup = rawCapture(ID, batch({ [ch.tab]: [shown, shown] }), META(), T, batch({ [ch.tab]: [twinB, twinA] }), batch({ [ch.tab]: [twinB, twinA] })).tabs.find(t => t.title === ch.tab)!.values;
    expect(dup[1]![at('입고일자')]).toBe('2025-08-12');
    expect(dup[2]![at('입고일자')]).toBe('2026-08-12');
    // 연식 숫자만 다른 두 줄: 같은 순서면 줄 위치로 짝짓고, 표시값과 실제 값의 줄 순서가 다르면(되돌린 정렬) 멈춘다.
    const yA = [...real], yB = [...real]; yB[at('연식')] = 2019; yB[at('입고일자')] = 45881;
    const sA = [...shown], sB = [...shown]; sA[at('연식')] = '2021'; sB[at('연식')] = '2019';
    const yr = rawCapture(ID, batch({ [ch.tab]: [sB, sA] }), META(), T, batch({ [ch.tab]: [yB, yA] }), batch({ [ch.tab]: [yB, yA] })).tabs.find(t => t.title === ch.tab)!.values;
    expect([yr[1]![at('입고일자')], yr[2]![at('입고일자')]]).toEqual(['2025-08-12', '2026-08-12']);
    expect(() => rawCapture(ID, batch({ [ch.tab]: [sA, sB] }), META(), T, batch({ [ch.tab]: [yB, yA] }), batch({ [ch.tab]: [yB, yA] }))).toThrow('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
  });
  it('stops when anything changed between the serial reads before and after the displayed read, and counts what it did', () => {
    const ch = sharedSheetChannels[0]!, H = sharedSheetHeaders, at = (h: string) => H.indexOf(h);
    const shown = Array.from({ length: H.length }, () => '' as unknown); shown[0] = ch.companyName; shown[4] = '12가3456';
    shown[at('입고일자')] = '08-12'; shown[at('연식')] = '2021';
    const real = [...shown]; real[at('입고일자')] = 46246; real[at('연식')] = 2021;
    const S = batch({ [ch.tab]: [shown] }), R = batch({ [ch.tab]: [real] });
    // 연도만 바뀐 날짜(같은 08-12, 다른 해)·숫자 칸만 바뀐 것·줄이 하나 더 생긴 것 — 표시값으로는 못 잡아도 앞뒤 실제 값이 달라 멈춘다.
    const yearOnly = [...real]; yearOnly[at('입고일자')] = 45881;
    const numOnly = [...real]; numOnly[at('연식')] = 2020;
    for (const after of [batch({ [ch.tab]: [yearOnly] }), batch({ [ch.tab]: [numOnly] }), batch({ [ch.tab]: [real, real] })])
      expect(() => rawCapture(ID, S, META(), T, R, after)).toThrow('SHARED_SHEET_CAPTURE_CHANGED_DURING_READ');
    expect(() => (rawCapture as (...a: unknown[]) => unknown)(ID, S, META(), T, R)).toThrow('SHARED_SHEET_CAPTURE_SERIALS_REQUIRED');
    // 바꾼 날짜 수를 센다 — 글자가 똑같은 두 줄도 둘 다 바꾼다.
    const stats = { datesFromSerial: 0 };
    const twin = batch({ [ch.tab]: [real, real] });
    rawCapture(ID, batch({ [ch.tab]: [shown, shown] }), META(), T, twin, twin, stats);
    expect(stats).toEqual({ datesFromSerial: 2 });
  });
});

describe('shared sheet capture — date boundaries and displayed numbers', () => {
  it('reads serials as dates only between 1900 and 2099, a time of day kept on the same date', () => {
    expect(serialToIsoDate(1)).toBeNull();
    expect(serialToIsoDate(2)).toBe('1900-01-01');
    expect(serialToIsoDate(36525)).toBe('1999-12-31');
    expect(serialToIsoDate(36526)).toBe('2000-01-01');
    expect(serialToIsoDate(73050)).toBe('2099-12-31');
    expect(serialToIsoDate(73051)).toBeNull();
    expect(serialToIsoDate(46246.99)).toBe('2026-08-12');
    expect(serialToIsoDate('46246')).toBeNull();
    expect(serialToIsoDate(Number.NaN)).toBeNull();
  });
  it('matches a displayed number to its real value in every format the sheet may show', () => {
    for (const [shown, v] of [['12,345km', 12345], ['77.4kWh', 77.4], ['2021', 2021], ['15%', 0.15], ['12.5%', 0.125], ['-', 0], ['₩ -', 0],
      ['-1,000', -1000], ['(1,000)', -1000], ['1.23E+05', 123000], ['1.23E+05', 123456], ['1E-10', 1e-10], ['-1E-10', -1e-10], ['1.5E-10', 1.54e-10], ['.5E+03', 500], ['5.E+03', 5000], ['1000000000000000', 1000000000000000], ['(1.23E+05)', -123000], ['-1.23E+05', -123000], ['1.5E-03', 0.0015], ['₩ (1,000)', -1000], ['₩-1,000', -1000], ['0', 0], ['TRUE', true], ['false', false]] as const)
      expect(displayMatchesValue(shown, v), `${shown} ↔ ${v}`).toBe(true);
    for (const [shown, v] of [['12,345km', 12346], ['77.4kWh', 77.5], ['15%', 0.16], ['-', 1], ['(1,000)', 1000], ['1,000', -1000],
      ['1.23E+05', 124000], ['1E-10', 0], ['1E-10', -1e-10], ['-1E-10', 1e-10], ['1E309', 123], ['1E309', Infinity], ['.5E+03', 5000], ['1000000000000000', 1000000000000001], ['(1.23E+05)', 123000], ['-1.23E+05', 123000], ['₩ (1,000)', 1000], ['1.5E-03', -0.0015], ['', 0], ['TRUE', false], ['예', true]] as const)
      expect(displayMatchesValue(shown, v), `${shown} ↔ ${v}`).toBe(false);
  });
});
