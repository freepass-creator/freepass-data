import { sharedSheetChannels, sharedSheetCaptureDigest, buildSharedSheetBatch, sharedSheetHeaders, type SharedSheetCapture, type SheetCell,
  type SupplierEnteredRecord, type SheetCorrection } from './shared-sheet-source.js';
import { decodeErp5Value, inspectErp5Capture, type Erp5SourceCapture } from './erp5-source-capture.js';
import { plateIdentityKey, isAssignedPlate } from '../domain/vehicle-plate.js';
import { stableDigest } from '../shared/stable-digest.js';
import spec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };

export type SheetsBatchGet = { spreadsheetId?: string; valueRanges?: Array<{ range?: string; values?: unknown[][] }> };
/** spreadsheets.get?fields=… — the tab grid sizes that prove each returned range covered the whole tab. */
export type SheetsGridMeta = { spreadsheetId?: string; sheets?: Array<{ properties?: { title?: string; gridProperties?: { rowCount?: number } } }> };
export const SHEETS_GRID_META_FIELDS = 'spreadsheetId,sheets.properties(title,gridProperties(rowCount))';
const WIDTH = sharedSheetHeaders.length;
const LAST_COLUMN = (n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; })(WIDTH);
export const sharedSheetTabs = (): string[] => [...new Set(sharedSheetChannels.map(x => x.tab))];
export const sharedSheetCaptureRanges = () => sharedSheetTabs().map(t => `'${t.replace(/'/g, "''")}'!A1:${LAST_COLUMN}`);

/** Date columns whose display format may hide the year (입고일자 mm-dd · 최초등록일 yy-mm-dd): the capture keeps their real
 * value as YYYY-MM-DD so the RAW of record never loses information to a display choice. */
const DATE_COLUMNS = Object.entries(spec.valueFormats as Record<string, { kind?: string }>).filter(([, f]) => f.kind === 'date')
  .map(([h]) => sharedSheetHeaders.indexOf(h)).filter(i => i >= 0);
/** Serial (days since 1899-12-30, a fraction is the time of day) → YYYY-MM-DD; null when not a usable date (1900~2099). */
export const serialToIsoDate = (v: unknown): string | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000);
  return d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2099 ? d.toISOString().slice(0, 10) : null;
};
/** A displayed number shows the same real value, to the precision it shows: «12,345km» · «77.4kWh» · «2021» · «15%» ·
 * 회계식 0 «-» · 음수 «-1,000» / «(1,000)» · 지수 «1.23E+05». */
export const displayMatchesValue = (shown: string, v: number | boolean): boolean => {
  if (typeof v === 'boolean') return shown.trim().toUpperCase() === String(v).toUpperCase();
  const s = shown.trim();
  if (!/\d/.test(s)) return /^[^0-9]*-[^0-9]*$/.test(s) && v === 0; // 회계식 0
  const target = s.includes('%') ? v * 100 : v;
  if (!Number.isFinite(target)) return false;
  // 부호를 먼저 정한다 — 숫자를 감싼 괄호(통화 기호가 밖에 있어도) 또는 첫 숫자 앞의 «-». 지수·일반 숫자에 같이 쓴다.
  const sign = /\([^()]*\d[^()]*\)/.test(s) || /^[^0-9]*-/.test(s) ? -1 : 1;
  // 허용 오차는 보이는 자릿수의 반 칸(유효숫자 기준)뿐 — 고정 오차를 더하지 않는다(«1E-10» 이 0 과 같다고 통과하지 않게).
  // 부동소수 반올림 찌꺼기만 반 칸의 1e-9 배만큼 너그럽게(값 크기에 비례해 넓히지 않는다).
  const near = (shownValue: number, halfStep: number) =>
    Number.isFinite(shownValue) && Math.abs(shownValue - target) <= halfStep * (1 + 1e-9)
    && (target === 0 || shownValue === 0 || Math.sign(shownValue) === Math.sign(target));
  // 가수는 «1.23»·«5.»·«.5» 모두(앞 소수점을 버리지 않는다).
  const sci = /(\d+(?:\.(\d*))?|\.(\d+))E([+-]?\d+)/i.exec(s.replace(/,/g, ''));
  if (sci) return near(sign * Number(sci[0]), 0.5 * 10 ** (Number(sci[4]) - (sci[2] ?? sci[3] ?? '').length));
  const t = s.replace(/[^0-9.]/g, ''), n = Number(t);
  if (!Number.isFinite(n)) return false;
  const decimals = (t.split('.')[1] ?? '').length;
  // 일반 표시는 시트처럼 «0 에서 먼 쪽 반올림»으로 보이는 자릿수에 맞춰 같은지 본다(«1» ↔ 1.5 는 «2» 라 다르다).
  // 한계: «0.###» 처럼 뒤 0 을 생략하는 형식은 보이는 자릿수가 형식의 최대 자릿수보다 적을 수 있어(77.4 ↔ 77.44 처럼)
  // 표시만으로는 가릴 수 없다 — 두 읽기 사이 변경은 앞뒤 실제 값 동일 검사(sameReads)와 줄마다 글자 칸 대조가 막는다.
  const scale = 10 ** decimals, shownNumber = sign * n;
  const scaled = Math.abs(target) * scale, frac = scaled - Math.floor(scaled);
  const rounded = Math.sign(target) * (Math.abs(frac - 0.5) <= Math.min(Math.max(scaled, 1) * Number.EPSILON * 4, 1e-6) ? Math.floor(scaled) + 1 : Math.round(scaled)) / scale; // 곱셈 찌꺼기(몇 ULP)만 .5 로 본다
  return Math.abs(rounded - shownNumber) <= 1e-9 / scale && (target === 0 || shownNumber === 0 || Math.sign(shownNumber) === Math.sign(target));
};

const IDENTITY_COLUMNS = ['회사명', '차량번호'].map(h => sharedSheetHeaders.indexOf(h)).filter(i => i >= 0);
/** The displayed date must not contradict the serial: whatever parts it shows (월-일 · 연-월 · 연-월-일 · 월/일/연 · 일/월/연)
 * must fit the serial date under at least one reading. This is a second guard only — that nothing changed between the
 * displayed read and the serial reads is proven by the two serial reads around it being identical (sameReads). */
const displayMatchesIso = (shown: string, iso: string): boolean => {
  const g = shown.match(/\d+/g)?.map(Number) ?? [], [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const yr = (v: number | undefined) => v === y || v === y % 100;
  if (g.length === 2) return (g[0] === m && g[1] === d) || (yr(g[0]) && g[1] === m);
  if (g.length === 3) return (yr(g[0]) && g[1] === m && g[2] === d) || (yr(g[2]) && ((g[0] === m && g[1] === d) || (g[0] === d && g[1] === m)));
  return false;
};

/** Two reads of the same ranges are identical (same ranges, same row counts, same cells — dates and numbers included).
 * Limit: a change that is made and fully undone between the two reads is not seen, and two rows identical in every
 * non-date cell that are swapped and swapped back in that window cannot be told apart. */
export const sameReads = (a: SheetsBatchGet, b: SheetsBatchGet): boolean =>
  a?.spreadsheetId === b?.spreadsheetId && JSON.stringify(a?.valueRanges ?? null) === JSON.stringify(b?.valueRanges ?? null);

/** Counts the capture reports on the side (public log: numbers only). */
export type CaptureDateStats = { datesFromSerial: number };

/** One values.batchGet response → validated capture v1. Rows are padded to the 74-column contract, blank rows kept.
 * serials (optional): the same ranges read as real values (dates as serial numbers) right BEFORE the displayed read, and
 * serialsAfter the same read right AFTER it. Both must be identical, so nothing (row order, a date's year, a number) changed
 * while the displayed values were read; only date cells take the serial value. */
export function captureFromBatchGet(spreadsheetId: string, raw: SheetsBatchGet, meta: SheetsGridMeta, readTime: string,
  serials: SheetsBatchGet, serialsAfter: SheetsBatchGet, stats?: CaptureDateStats): SharedSheetCapture {
  const tabs = sharedSheetTabs();
  if (raw?.spreadsheetId !== spreadsheetId || meta?.spreadsheetId !== spreadsheetId) throw new Error('SHARED_SHEET_CAPTURE_WRONG_SPREADSHEET');
  if (!Array.isArray(raw?.valueRanges) || raw.valueRanges.length !== tabs.length) throw new Error('SHARED_SHEET_CAPTURE_INCOMPLETE');
  // complete:true is only claimed when each returned range is exactly A1:<last column><full grid rows> of the expected tab, in order.
  const gridRows = new Map((meta.sheets ?? []).map(x => [x.properties?.title, x.properties?.gridProperties?.rowCount]));
  raw.valueRanges.forEach((r, i) => {
    const m = /^(?:'((?:[^']|'')+)'|([^'!]+))!A1:([A-Z]+)(\d+)$/.exec(r?.range ?? '');
    const title = m ? (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]) : undefined;
    const rows = gridRows.get(tabs[i]);
    if (!m || title !== tabs[i] || m[3] !== LAST_COLUMN || typeof rows !== 'number' || !Number.isSafeInteger(rows) ||
        Number(m[4]) !== rows || (r.values ?? []).length > rows) throw new Error('SHARED_SHEET_CAPTURE_RANGE_MISMATCH');
  });
  // 실제 값 조회는 모든 경로(온라인·파일)에서 필수 — 없으면 연도 없는 보이는 값을 «성공»으로 박제하게 되므로 멈춘다.
  if (!serials || !serialsAfter) throw new Error('SHARED_SHEET_CAPTURE_SERIALS_REQUIRED');
  if (serials && (serials.spreadsheetId !== spreadsheetId || !Array.isArray(serials.valueRanges) ||
      serials.valueRanges.length !== raw.valueRanges.length || serials.valueRanges.some((r, i) => r?.range !== raw.valueRanges![i]?.range)))
    throw new Error('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
  if (serials && (!serialsAfter || !sameReads(serials, serialsAfter))) throw new Error('SHARED_SHEET_CAPTURE_CHANGED_DURING_READ');
  const cell = (v: unknown): SheetCell => v === null || v === undefined ? '' :
    typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? v : (() => { throw new Error('SHARED_SHEET_CAPTURE_CELL_INVALID'); })();
  const capture: SharedSheetCapture = { schema: 'shared-sheet-capture/v1', spreadsheetId, layoutVersion: spec.layoutVersion, readTime,
    tabs: raw.valueRanges.map((range, i) => {
      const real = serials?.valueRanges?.[i]?.values ?? [];
      // 두 번 읽는 사이 줄이 지워지거나 정렬되면 다른 차의 날짜가 붙는다 — 줄 수·회사명·차량번호가 같고, 바꾸는 날짜가
      // 보이는 값(08-12 · 20-07-03)과 맞을 때만 쓴다. 하나라도 다르면 멈춘다(fail closed).
      if (serials && real.length !== (range.values ?? []).length) throw new Error('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
      // 짝은 줄 위치(같은 범위·같은 줄 번호)로 짓는다 — 앞뒤 실제 값 조회가 같다는 것이 그 사이 줄 배치가 안 바뀌었음을
      // 보장하므로, 글자가 똑같은 줄(«미정» 둘 등)도 제 줄의 날짜를 받는다(연도를 잃지 않는다).
      const values = (range.values ?? []).map((row, r) => {
        if (!Array.isArray(row) || row.length > WIDTH) throw new Error('SHARED_SHEET_CAPTURE_ROW_INVALID');
        const out = Array.from({ length: WIDTH }, (_, c) => cell(row[c]));
        if (serials && r > 0) {
          const twin = real[r] ?? [];
          for (const c of IDENTITY_COLUMNS) if (String(twin[c] ?? '').trim() !== String(row[c] ?? '').trim()) throw new Error('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
          // 날짜 말고 모든 칸이 두 조회에서 같은 값이어야 한다 — 글자는 글자 그대로, 숫자·참거짓은 보이는 값이 같은 실제 값을
          // 가리켜야 한다. 그래서 표시값 줄과 실제 값 줄이 같은 차의 같은 줄임을 줄마다 확인한다(되돌린 정렬도 잡는다).
          for (let c = 0; c < WIDTH; c++) {
            if (DATE_COLUMNS.includes(c)) continue;
            const v = twin[c], shownCell = String(row[c] ?? '');
            const same = typeof v === 'number' || typeof v === 'boolean' ? displayMatchesValue(shownCell, v) : String(v ?? '').trim() === shownCell.trim();
            if (!same) throw new Error('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
          }
          for (const c of DATE_COLUMNS) {
            // 글자로 적힌 날짜(«20-07» 등)는 원문 그대로 두되, 실제 값과 보이는 값이 같은 글자여야 한다.
            if (typeof twin[c] !== 'number') {
              if (String(twin[c] ?? '').trim() !== String(row[c] ?? '').trim()) throw new Error('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
              continue;
            }
            const iso = serialToIsoDate(twin[c]);
            // 숫자인데 날짜로 못 읽으면(범위 밖) 보이는 값으로 연도를 잃지 않게 멈춘다.
            if (!iso) throw new Error('SHARED_SHEET_CAPTURE_DATE_UNREADABLE');
            if (!displayMatchesIso(String(row[c] ?? ''), iso)) throw new Error('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
            out[c] = iso;
            if (stats) stats.datesFromSerial++;
          }
        }
        return out;
      });
      return { title: tabs[i]!, readTime, complete: true as const, rowCount: values.length, values };
    }) };
  capture.digest = sharedSheetCaptureDigest(capture);
  buildSharedSheetBatch(capture); // fail closed: header, tabs, widths, identities
  return capture;
}

/** Layer ②: products.원문 (written by the supplier-sheet collectors, never by the shared sheet) per «공급사 코드 + 차량번호»,
 * from an existing verified ERP5 capture. Records whose products disagree on 원문 are left out rather than guessed. */
export function supplierEnteredFromErp5(capture: Erp5SourceCapture): SupplierEnteredRecord[] {
  inspectErp5Capture(capture);
  const byKey = new Map<string, SupplierEnteredRecord | null>();
  for (const doc of capture.collections.products.documents as Array<{ name?: string; fields?: Record<string, unknown> }>) {
    let plate: unknown, text: unknown, supplier: unknown;
    try {
      plate = decodeErp5Value(doc.fields?.car_number ?? { nullValue: null });
      text = decodeErp5Value(doc.fields?.['원문'] ?? { nullValue: null });
      supplier = decodeErp5Value(doc.fields?.provider_company_code ?? { nullValue: null });
    } catch { continue; }
    if (!isAssignedPlate(plate) || typeof supplier !== 'string' || !supplier.trim() || !text || typeof text !== 'object' || Array.isArray(text)) continue;
    const record: SupplierEnteredRecord = { supplierCode: supplier.trim(), plate: plateIdentityKey(plate), source: 'ERP5_PRODUCTS_SOURCE_TEXT',
      sourceRef: String(doc.name ?? '').split('/').pop() ?? '', observedAt: capture.readTime, values: text as Record<string, unknown> };
    const key = `${record.supplierCode}|${record.plate}`;
    const seen = byKey.get(key);
    byKey.set(key, seen === undefined ? record : seen && stableDigest(seen.values) === stableDigest(record.values) ? seen : null);
  }
  return [...byKey.values()].filter((x): x is SupplierEnteredRecord => x !== null)
    .sort((a, b) => `${a.supplierCode}|${a.plate}`.localeCompare(`${b.supplierCode}|${b.plate}`));
}
/** Merge supplements into a capture and re-seal its digest. Only supplements whose «공급사 코드 + 차량번호» is a sheet row are kept. */
export function withSupplements(capture: SharedSheetCapture, supplierEntered: SupplierEnteredRecord[], corrections: SheetCorrection[]): SharedSheetCapture {
  const rowKeys = new Set(capture.tabs.flatMap(t => t.values.slice(1).map(r => {
    const code = sharedSheetChannels.find(x => x.tab === t.title && x.companyName === String(r[0] ?? '').trim())?.code;
    return code && isAssignedPlate(r[4]) ? `${code}|${plateIdentityKey(r[4])}` : '';
  })).filter(Boolean));
  // Validate before matching: a supplement without supplier code/plate is an error, not something to drop silently.
  for (const x of [...supplierEntered, ...corrections])
    if (!x || typeof x.supplierCode !== 'string' || !x.supplierCode.trim() || !isAssignedPlate(x.plate)) throw new Error('INVALID_SHARED_SHEET_SUPPLEMENT');
  const key = (x: { supplierCode: string; plate: string }) => `${x.supplierCode}|${plateIdentityKey(x.plate)}`;
  const keep = supplierEntered.filter(x => rowKeys.has(key(x)));
  const fixes = corrections.filter(x => rowKeys.has(key(x)));
  const out: SharedSheetCapture = { ...structuredClone(capture), ...(keep.length ? { supplierEntered: keep } : {}),
    ...(fixes.length ? { corrections: fixes } : {}) };
  delete out.digest;
  out.digest = sharedSheetCaptureDigest(out);
  buildSharedSheetBatch(out);
  return out;
}
