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
const serialToIsoDate = (v: unknown): string | null => {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + v * 86_400_000);
  return d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2099 ? d.toISOString().slice(0, 10) : null;
};

const IDENTITY_COLUMNS = ['회사명', '차량번호'].map(h => sharedSheetHeaders.indexOf(h)).filter(i => i >= 0);
/** The displayed date (mm-dd · yy-mm-dd · yyyy-mm-dd, any separator) must name the same month/day (and year if shown). */
const displayMatchesIso = (shown: string, iso: string): boolean => {
  const g = shown.match(/\d+/g)?.map(Number) ?? [], [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const yr = (v: number | undefined) => v === y || v === y % 100;
  if (g.length === 2) return g[0] === m && g[1] === d;
  // 연-월-일(규격) 또는 네 자리 연도가 끝에 오는 월/일/연(시트 기본 날짜 표시)만 — 일/월 순서, 두 자리 연도가 끝에 오는
  // 형식은 받지 않는다(03-07-04 를 2003-07-04 와 2004-03-07 로 겹쳐 읽지 않게).
  const digits = shown.match(/\d+/g) ?? [];
  if (g.length === 3) return (yr(g[0]) && g[1] === m && g[2] === d) || (digits[2]?.length === 4 && g[2] === y && g[0] === m && g[1] === d);
  return false;
};

/** One values.batchGet response → validated capture v1. Rows are padded to the 74-column contract, blank rows kept.
 * serials (optional): the same ranges read as real values (dates as serial numbers); only date cells use it. */
export function captureFromBatchGet(spreadsheetId: string, raw: SheetsBatchGet, meta: SheetsGridMeta, readTime: string, serials?: SheetsBatchGet): SharedSheetCapture {
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
  if (serials && (serials.spreadsheetId !== spreadsheetId || !Array.isArray(serials.valueRanges) ||
      serials.valueRanges.length !== raw.valueRanges.length || serials.valueRanges.some((r, i) => r?.range !== raw.valueRanges![i]?.range)))
    throw new Error('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
  const cell = (v: unknown): SheetCell => v === null || v === undefined ? '' :
    typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? v : (() => { throw new Error('SHARED_SHEET_CAPTURE_CELL_INVALID'); })();
  const capture: SharedSheetCapture = { schema: 'shared-sheet-capture/v1', spreadsheetId, layoutVersion: spec.layoutVersion, readTime,
    tabs: raw.valueRanges.map((range, i) => {
      const real = serials?.valueRanges?.[i]?.values ?? [];
      // 두 번 읽는 사이 줄이 지워지거나 정렬되면 다른 차의 날짜가 붙는다 — 줄 수·회사명·차량번호가 같고, 바꾸는 날짜가
      // 보이는 값(08-12 · 20-07-03)과 맞을 때만 쓴다. 하나라도 다르면 멈춘다(fail closed).
      if (serials && real.length !== (range.values ?? []).length) throw new Error('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
      // 글자 칸이 모두 같은 줄(«미정» 차 둘 등 — 숫자·날짜만 다름)은 서로 바뀌어도 알 수 없다 — 그런 줄은 날짜를 바꾸지 않고 보이는 값 그대로 둔다.
      // 열쇠는 실제 값 조회의 글자 칸만으로 만든다(숫자 칸은 표시값과 글자 그대로 비교할 수 없어 빼고).
      const textKey = (row: unknown[]) => JSON.stringify(Array.from({ length: WIDTH }, (_, c) => (DATE_COLUMNS.includes(c) || typeof row[c] !== 'string' ? '' : String(row[c]).trim())));
      const keyCount = new Map<string, number>();
      for (const row of real.slice(1)) if (Array.isArray(row)) { const k = textKey(row); keyCount.set(k, (keyCount.get(k) ?? 0) + 1); }
      const values = (range.values ?? []).map((row, r) => {
        if (!Array.isArray(row) || row.length > WIDTH) throw new Error('SHARED_SHEET_CAPTURE_ROW_INVALID');
        const out = Array.from({ length: WIDTH }, (_, c) => cell(row[c]));
        if (serials && r > 0) {
          const twin = real[r] ?? [];
          for (const c of IDENTITY_COLUMNS) if (String(twin[c] ?? '').trim() !== String(row[c] ?? '').trim()) throw new Error('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
          // 글자 칸(숫자 아닌 값)은 두 조회에서 글자 그대로 같아야 한다 — 같은 회사 «미정» 차끼리 자리가 바뀐 것도 잡는다.
          for (let c = 0; c < WIDTH; c++) {
            if (DATE_COLUMNS.includes(c) || typeof twin[c] !== 'string') continue;
            if (String(twin[c]).trim() !== String(row[c] ?? '').trim()) throw new Error('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
          }
          if ((keyCount.get(textKey(twin)) ?? 0) > 1) return out;
          for (const c of DATE_COLUMNS) {
            const iso = serialToIsoDate(twin[c]);
            if (!iso) continue;
            if (!displayMatchesIso(String(row[c] ?? ''), iso)) throw new Error('SHARED_SHEET_CAPTURE_SERIALS_MISMATCH');
            out[c] = iso;
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
