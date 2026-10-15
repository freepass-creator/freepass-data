/** 마음카(RP034) 재고 파일(XLSX) → 엔진 입력 변환(순수, 쓰기 0). 대표 2026-10-14 «마춤카 데이터를 반영» · 커맨드 센터 2026-10-16 확정 규칙:
 *  - 변환 대상은 «차량번호가 있는 표»(머리글에 차량명·차량번호·출고여부)뿐이다. 번호 없는 선출고 예정 표와 머리글 없는 시트는 보고 전용(쓰기 없음).
 *  - 요금 칸 «a/b» = 보증금(a)/월렌탈료(b), 만원 단위(공급사 확인 2026-10-15 09:48: «90/90 은 보증금/월렌탈료, 만원 단위»).
 *  - 값이 «-»·빈칸이면 그 기간은 제안 없음. 숫자 하나만 있는 칸은 뜻을 모르므로 쓰지 않는다(노트). 보증금 0 은 확정 0원이 아니므로 UNKNOWN.
 *  - 출고여부 «즉시»(·«즉시(마음카)») 정확 일치만 출고가능. 날짜·그 밖의 값은 상태를 모르므로 보류(STATUS_UNKNOWN).
 *  - 수수료 규칙이 없다 → 수수료 «확인 필요»(raw.fee_state). 파일에 없는 차는 하향하지 않는다(플러그인이 부재 판정을 막음).
 * 이름·값을 지어내지 않는다: 읽을 수 없는 칸은 비우고 사유 코드를 남긴다. */
import type { SourceAmount, SourceProductRecord, SourceTerm } from '../domain/source-engine.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import type { XlsxSheet } from './xlsx-reader.js';

export const MAUMCAR_SOURCE_ID = 'RP034';
const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
const RENT_MIN = 100_000, RENT_MAX = 50_000_000, MANWON = 10_000;

export type MaumcarHold = { sheet: string; row: number; reason: string };
export type MaumcarConversion = {
  records: SourceProductRecord[];
  held: MaumcarHold[];
  duplicatePlates: string[];
  /** 보고 전용(쓰기 없음): 번호 없는 선출고 예정 줄 수, 머리글 없는 시트별 줄 수, 변환 대상 표를 찾은 시트. */
  reportOnly: { preReleaseRows: number; headerlessSheets: Array<{ sheet: string; rows: number }>; convertedSheets: string[] };
  notes: string[];
};

/** 엑셀 일련번호(1900 체계, 1899-12-30 기준) → YYYY-MM-DD. 범위(2000~2100) 밖이면 null. */
export function excelSerialDate(text: string): string | null {
  if (!/^\d{5}(?:\.\d+)?$/.test(text.trim())) return null;
  const days = Math.floor(Number(text));
  const date = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000);
  const year = date.getUTCFullYear();
  return year >= 2000 && year <= 2100 ? date.toISOString().slice(0, 10) : null;
}

const manwonToWon = (text: string): number | null => {
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const won = Math.round(Number(text) * MANWON * 1000) / 1000;
  return Number.isSafeInteger(won) && Number.isInteger(Number(text) * MANWON) ? won : null;
};

type Columns = Record<string, number>;
const headerIndex = (cells: string[]): Columns => {
  const out: Columns = {};
  cells.forEach((c, i) => { const key = clean(c); if (key && out[key] === undefined) out[key] = i; });
  return out;
};

export function convertMaumcarWorkbook(sheets: readonly XlsxSheet[], input: { observedAt: string; fileSha256: string }): MaumcarConversion {
  const records: SourceProductRecord[] = [], held: MaumcarHold[] = [], notes: string[] = [];
  const seen = new Set<string>(), duplicates = new Set<string>();
  const reportOnly: MaumcarConversion['reportOnly'] = { preReleaseRows: 0, headerlessSheets: [], convertedSheets: [] };
  const noteCounts = new Map<string, number>();
  const note = (code: string) => noteCounts.set(code, (noteCounts.get(code) ?? 0) + 1);

  for (const sheet of sheets) {
    let table: { header: number; columns: Columns } | null = null;
    let converted = 0, preRelease = 0, preReleaseHeader = -1;
    sheet.rows.forEach((cells, index) => {
      const columns = headerIndex(cells);
      // 새 머리글을 만나면 표가 바뀐다: 번호 있는 표(차량명+차량번호) → 변환, 번호 없는 표(차량명+보증금/60개월) → 보고 전용.
      if (columns['차량명'] !== undefined && columns['차량번호'] !== undefined) { table = { header: index, columns }; preReleaseHeader = -1; return; }
      if (columns['차량명'] !== undefined && (columns['보증금'] !== undefined || columns['60개월'] !== undefined)) { table = null; preReleaseHeader = index; return; }
      if (preReleaseHeader >= 0 && table === null) {
        if (/^\d+$/.test(clean(cells[0])) && clean(cells[1])) preRelease++;
        return;
      }
      if (!table) return;
      const col = table.columns;
      const at = (name: string) => clean(cells[col[name] ?? -1]);
      const name = at('차량명'), plateText = at('차량번호').replace(/\s+/g, '');
      const first = clean(cells[0]);
      if (!cells.some(c => clean(c))) return;
      if (/^[*※]/.test(first) || (!name && !plateText && !/^\d+$/.test(first))) { note('SEPARATOR_OR_NOTE_ROWS'); return; }
      // 번호 검증·중복 검사가 차명 검사보다 먼저다(차명이 빈 줄이 같은 번호의 중복을 가리지 않게 — Codex #670 ④).
      if (!/^\d{2,3}[가-힣]\d{4}$/.test(plateText) || !isAssignedPlate(plateText)) {
        held.push({ sheet: sheet.name, row: index + 1, reason: plateText ? 'PLATE_INVALID' : 'PLATE_MISSING' }); return;
      }
      const plate = plateIdentityKey(plateText);
      if (seen.has(plate)) { duplicates.add(plate); held.push({ sheet: sheet.name, row: index + 1, reason: 'DUPLICATE_PLATE' }); return; }
      seen.add(plate);
      if (!name) { held.push({ sheet: sheet.name, row: index + 1, reason: 'VEHICLE_NAME_MISSING' }); return; }
      const availability = at('출고여부');
      const serial = excelSerialDate(availability);
      // «즉시» 정확 일치(공급사 표기 «즉시(마음카)» 허용). «즉시 출고불가»·«즉시 마감» 같은 문구는 출고가능이 아니다(Codex #670 ①).
      if (!/^즉시(?:\s*\(마음카\))?$/.test(availability)) {
        held.push({ sheet: sheet.name, row: index + 1, reason: 'STATUS_UNKNOWN' });
        note(serial ? 'AVAILABLE_FROM_DATE_HELD' : 'STATUS_VALUE_HELD');
        return;
      }
      const terms: SourceTerm[] = [];
      for (const [header, position] of Object.entries(col)) {
        const monthsMatch = /^(\d{1,2})개월$/.exec(header);
        if (!monthsMatch) continue;
        const months = Number(monthsMatch[1]);
        const cell = clean(cells[position]);
        if (!cell || /^[-–—xX]$/.test(cell)) continue;   // 제안 없음
        const pair = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(cell);
        if (!pair) { note(/^\d+(?:\.\d+)?$/.test(cell) ? 'RENT_CELL_SINGLE_NUMBER_NOT_USED' : 'RENT_CELL_UNPARSEABLE'); continue; }
        const depositWon = manwonToWon(pair[1]!), rentWon = manwonToWon(pair[2]!);
        if (rentWon === null || rentWon < RENT_MIN || rentWon > RENT_MAX) { note('RENT_OUT_OF_RANGE'); continue; }
        let deposit: SourceAmount = { state: 'UNKNOWN', value: null };
        if (depositWon === null) note('DEPOSIT_UNPARSEABLE');
        else if (depositWon > 0) deposit = { state: 'KNOWN', value: depositWon };
        else note('DEPOSIT_ZERO_UNCONFIRMED');   // 산출 근거 없는 0 은 확정 0원이 아니다
        terms.push({ months, monthlyRent: { state: 'KNOWN', value: rentWon }, deposit, mileage: null,
          raw: { priceType: 'MAUMCAR_FILE_PAIR', unit: 'MANWON', deposit_over_rent: cell } });
      }
      const spec: Record<string, string> = {};
      const year = /^(?:19|20)\d{2}/.exec(at('년식'))?.[0];
      if (year) spec.year = year;
      if (at('연료')) spec.fuel_type = at('연료');
      if (at('색상')) spec.ext_color = at('색상');
      const mileage = at('현주행거리').replace(/,/g, '');
      if (/^\d+$/.test(mileage)) spec.mileage = mileage;
      records.push({ sourceId: MAUMCAR_SOURCE_ID, uid: plate, plate, vehicleText: name,
        status: { raw: '출고가능', saleAvailable: true }, terms, observedAt: input.observedAt,
        raw: { source: 'maumcar-file', source_file_sha256: input.fileSha256, source_tab: sheet.name, source_row: index + 1, product_type: '중고렌트',
          fee_state: 'FEE_UNCONFIRMED', provider_status: availability,
          ...(at('옵션') ? { options_text: at('옵션') } : {}), ...(at('신차가격') ? { new_car_price_manwon: at('신차가격') } : {}),
          ...(Object.keys(spec).length ? { spec } : {}) },
        vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] });
      converted++;
    });
    if (converted > 0 || sheet.rows.some(cells => { const c = headerIndex(cells); return c['차량명'] !== undefined && c['차량번호'] !== undefined; })) reportOnly.convertedSheets.push(sheet.name);
    else if (preRelease === 0 && sheet.rows.length) {
      const filled = sheet.rows.filter(cells => cells.some(c => clean(c))).length;
      if (filled) reportOnly.headerlessSheets.push({ sheet: sheet.name, rows: filled });
    }
    reportOnly.preReleaseRows += preRelease;
  }
  for (const [code, n] of [...noteCounts].sort((a, b) => a[0].localeCompare(b[0]))) notes.push(`${code}:${n}`);
  return { records, held, duplicatePlates: [...duplicates], reportOnly, notes };
}
