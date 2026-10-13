import { sharedSheetEngine } from './shared-sheet-engine.js';
import { sharedSheetChannels, sharedSheetCaptureDigest, type SharedSheetCapture } from './shared-sheet-source.js';
import { sourceCyclePlugin, AICA_SCOPES, type CycleCapture, type CyclePlugin } from './source-cycle-plugins.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import type { SourceAmount, SourceProductRecord } from '../domain/source-engine.js';

const amount = (v: unknown): SourceAmount => v === 0 ? { state: 'ZERO', value: 0 } : typeof v === 'number' && Number.isSafeInteger(v) && v > 0
  ? { state: 'KNOWN', value: v } : { state: 'UNKNOWN', value: null };
export function sourceUid(plate: unknown, sheetUid?: unknown): string | null {
  if (isAssignedPlate(plate)) return plateIdentityKey(plate);
  return typeof sheetUid === 'string' && sheetUid.trim() ? sheetUid.trim() : null;
}
/** SPEC3 supersedes the phase-one identity policy only at the runtime boundary. */
export function plateUidPlugin<T>(plugin: CyclePlugin<T>): CyclePlugin<T> {
  return { ...plugin, toRecords(read) {
    const result = plugin.toRecords(read), seen = new Set<string>(), records: SourceProductRecord[] = [];
    for (const r of result.records) {
      const uid = r.sourceId === 'RP004' && r.raw.product_group === 'MONTHLY_RENT'
        ? r.uid : sourceUid(r.plate, r.raw.sheet_uid);
      if (!uid) { result.held.push({ row: 0, reasons: r.raw.product_group === 'MONTHLY_RENT'
        ? ['MONTHLY_MODEL_REQUIRED'] : ['UID_REQUIRED', 'UNASSIGNED_PLATE'] }); continue; }
      if (seen.has(uid)) { result.held.push({ row: 0, reasons: ['DUPLICATE_UID_SUSPECT'] }); continue; }
      seen.add(uid); records.push({ ...r, uid });
    }
    return { records, held: result.held };
  } };
}
export type Visibility = { sheets?: Array<{ properties?: { title?: string; hidden?: boolean; gridProperties?: { rowCount?: number } };
  data?: Array<{ startRow?: number; rowMetadata?: Array<{ hiddenByUser?: boolean; hiddenByFilter?: boolean }> }> }> };
export function f05NativeCapture(source: string, capture: SharedSheetCapture, meta: Visibility): CycleCapture {
  const copy = structuredClone(capture), holds: string[] = [], positions = new Map<string, { scope: string; row: number; cells: unknown[]; headers: unknown[] }>();
  const scopes = [...new Set(sharedSheetChannels.filter(c => c.code === source).map(c => c.tab))];
  // Transport coverage is independent of UID/normalization holds.
  let complete = scopes.every(scope => copy.tabs.some(tab => tab.title === scope && tab.complete && tab.values.length >= tab.rowCount));
  for (const tab of copy.tabs) {
    const originalHeaders = [...tab.values[0]!], plateIndex = originalHeaders.indexOf('차량번호');
    let uidIndex = originalHeaders.indexOf('UID');
    if (uidIndex < 0) { uidIndex = tab.values[0]!.length; tab.values[0]!.push('UID'); }
    const m = meta.sheets?.find(s => s.properties?.title === tab.title);
    const grid = m?.data?.find(d => (d.startRow ?? 0) === 0);
    if (scopes.includes(tab.title) && (m?.properties?.hidden || !m || !grid || !Array.isArray(grid.rowMetadata) ||
      grid.rowMetadata.length < tab.rowCount || (m.properties?.gridProperties?.rowCount ?? 0) < tab.rowCount)) complete = false;
    const seen = new Set<string>();
    for (let i = 1; i < tab.values.length; i++) {
      const row = tab.values[i]!, original = [...row];
      const supplier = sharedSheetChannels.find(c => c.tab === tab.title && c.companyName === String(row[0] ?? '').trim());
      const hidden = m?.properties?.hidden || grid?.rowMetadata?.[i]?.hiddenByUser || grid?.rowMetadata?.[i]?.hiddenByFilter;
      const blank = row.every(c => c === '' || c === null);
      // 이 원천의 탭에 있는 보이는 데이터 행인데 회사명이 어느 공급사 코드에도 매핑되지 않으면 «없는 차량»이 아니라 «알 수 없는 행»이다.
      // 조용히 버리면 같은 차량이 부재로 오인돼 내려간다(2026-10-13 경진 → 경진렌트 표기 변경 실측). 보류로 세어 부재 하향을 막는다.
      if (!supplier && scopes.includes(tab.title) && !hidden && tab.title !== '종합' && !blank) holds.push('COMPANY_UNMAPPED');
      if (!supplier || supplier.code !== source || hidden || tab.title === '종합' || blank) {
        tab.values[i] = Array(tab.values[0]!.length).fill(''); continue;
      }
      const uid = sourceUid(row[plateIndex], originalHeaders.includes('UID') ? row[uidIndex] : null);
      if (!uid || seen.has(uid)) {
        holds.push(uid ? 'DUPLICATE_UID_SUSPECT' : 'UID_REQUIRED');
        tab.values[i] = Array(tab.values[0]!.length).fill(''); continue;
      }
      seen.add(uid); row[uidIndex] = uid;
      positions.set(uid, { scope: tab.title, row: i + 1, cells: original, headers: originalHeaders });
    }
  }
  copy.digest = sharedSheetCaptureDigest(copy);
  const engine = sharedSheetEngine(async () => copy);
  const converted = engine.toRecords({ raw: copy, observedAt: copy.readTime, attemptedAt: copy.readTime, complete, error: null });
  return { observedAt: capture.readTime, complete, completedScopes: complete ? scopes : [], visibilityComplete: complete,
    heldCount: holds.length + converted.held.length, heldReasons: [...holds, ...converted.held.map(h => h.reasons.join(','))],
    rows: converted.records.map(record => { const pos = positions.get(record.uid)!;
      return { scope: pos.scope, record: { ...record, raw: { cells: pos.cells, headers: pos.headers, source: 'shared-sheet',
        source_tab: pos.scope, source_row: pos.row, sheet_uid: record.plate ? null : record.uid } } }; }) };
}
export type AicaTable = { title: string; values: unknown[][] };
/** SPEC3B: explicit native headers; RAW cells remain unchanged. No vehicle-master inference. */
export function aicaNativeCapture(tables: AicaTable[], observedAt: string, meta?: Visibility): CycleCapture {
  const rows: CycleCapture['rows'] = [], completedScopes: string[] = [];
  let visibilityComplete = true, observationOnlyCount = 0;
  const money = (value: unknown): SourceAmount => {
    if (typeof value === 'string') {
      const text = value.trim();
      if (text === '무보증') return amount(0);
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return amount(null);
      return amount(Number(text.replaceAll(',', '')));
    }
    return amount(value);
  };
  for (const title of AICA_SCOPES) {
    const table = tables.find(t => t.title === title), headers = table?.values[0]?.map(v => String(v).trim());
    const sheet = meta?.sheets?.find(s => s.properties?.title === title);
    const grid = sheet?.data?.find(d => (d.startRow ?? 0) === 0);
    if (!table || !headers) continue;
    if (!sheet || !grid || !Array.isArray(grid.rowMetadata) || grid.rowMetadata.length < table.values.length ||
        (sheet.properties?.gridProperties?.rowCount ?? 0) < table.values.length) {
      visibilityComplete = false; continue;
    }
    if (sheet.properties?.hidden) { visibilityComplete = false; continue; }
    const required = title === '월렌트' ? ['차종', '1개월'] :
      ['배차상태', '구분', '차량번호', '차급', '차종분류', '트림', '연료', '외장', '내장', 'Km', '월렌트', '장기보증',
        '36개월', '48개월', '60개월', '옵션', '최초등록', '소비자가격', '제조사', '배기량', '연주행', '대인', '대물', '자차', '자손'];
    if (required.some(h => headers.filter(v => v === h).length !== 1)) continue;
    if (title === '월렌트' && (headers[0] !== '차종' || headers[1] !== '1개월')) continue;
    completedScopes.push(title);
    for (const [index, cells] of table.values.slice(1).entries()) {
      if (grid.rowMetadata[index + 1]?.hiddenByUser || grid.rowMetadata[index + 1]?.hiddenByFilter ||
          cells.every(v => v === '' || v == null)) continue;
      if (title === '월렌트') {
        if (typeof cells[1] === 'string' && cells[1].trim() === '무보증') continue;
        const rent = money(cells[1]), name = typeof cells[0] === 'string' ? cells[0] : '';
        if (rent.state === 'UNKNOWN') continue;
        const normalized = name.normalize('NFKC').replace(/\s+/gu, '').toUpperCase();
        const note = cells.slice(2).map(v => String(v ?? '')).join(' ');
        const deposit = note.includes('무보증') ? amount(0) : amount(null);
        rows.push({ scope: title, record: { sourceId: 'RP004', uid: normalized ? `RP004:MONTHLY:${normalized}` : '',
          plate: null, vehicleText: name, status: { raw: '출고가능', saleAvailable: true },
          terms: [{ months: 1, monthlyRent: rent, deposit, mileage: '월렌트', raw: { rent: cells[1], note,
            ...(deposit.state === 'UNKNOWN' ? { deposit_review_required: '보증금 확인 필요' } : {}) } }],
          observedAt, raw: { cells: structuredClone(cells), headers, source: 'aica-sheet', source_tab: title,
            source_row: index + 2, product_group: 'MONTHLY_RENT' }, vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] } });
        continue;
      }
      const get = (header: string) => cells[headers.indexOf(header)];
      const plate = isAssignedPlate(get('차량번호')) ? plateIdentityKey(get('차량번호')) : null;
      const deposit = get('장기보증');
      const terms = [36, 48, 60].flatMap(months => {
        const rent = get(`${months}개월`);
        // Blank periods are absent offers, not offers with an UNKNOWN rent.
        if (rent == null || (typeof rent === 'string' && ['', '-', '--', '\u2014', 'x', 'X', '\uc5c6\uc74c', 'N/A'].includes(rent.trim()))) return [];
        return [{ months, monthlyRent: typeof rent === 'string' && rent.trim() === '무보증' ? amount(null) : money(rent), deposit: money(deposit),
          mileage: typeof get('연주행') === 'string' ? String(get('연주행')) : null, raw: { rent, deposit: deposit ?? null } }];
      });
      rows.push({ scope: title, record: { sourceId: 'RP004', uid: plate ?? '', plate,
        vehicleText: [get('차종분류'), get('트림')].filter(v => v != null && v !== '').join(' '),
        status: { raw: String(get('배차상태') ?? ''), saleAvailable: null }, terms, observedAt,
        raw: { cells: structuredClone(cells), headers, sheet_uid: null, source: 'aica-sheet', source_tab: title,
          source_row: index + 2, product_group: 'LONG_TERM',
          original: Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? null])) },
        vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] } });
    }
  }
  return { observedAt, complete: visibilityComplete && completedScopes.length === AICA_SCOPES.length,
    completedScopes, visibilityComplete, rows, heldCount: 0, observationOnlyCount };
}
export const aicaNativePlugin = (read: () => Promise<CycleCapture>, ratio: number) => plateUidPlugin(sourceCyclePlugin({
  sourceId: 'RP004', kind: 'AICA', scopes: [...AICA_SCOPES], maxDowngradeRatio: ratio }, read));

/** Only an explicit complete homepage listing is authoritative. Unknown HTML/schema fails closed. */
export function ironNativeCapture(html: string, observedAt: string): CycleCapture {
  const match = /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) throw new Error('IRON_LIST_SCHEMA_HOLD');
  const page = JSON.parse(match[1]!).props?.pageProps;
  if (!page || !Array.isArray(page.vehicles) || page.total !== page.vehicles.length || page.hasNextPage !== false) throw new Error('IRON_LIST_COVERAGE_HOLD');
  const rows = page.vehicles.map((v: any) => {
    if (typeof v.published !== 'boolean') throw new Error('IRON_LIST_SCHEMA_HOLD');
    return { scope: 'homepage', record: { sourceId: 'RP006', uid: '', plate: isAssignedPlate(v.car_number) ? plateIdentityKey(v.car_number) : null,
      vehicleText: typeof v.car_name === 'string' ? v.car_name : '', status: { raw: v.published ? '게시' : '비게시', saleAvailable: v.published },
      terms: Object.entries(v.price ?? {}).map(([months, raw]) => { const p = raw as any; return { months: Number(months),
        monthlyRent: amount(p.rent), deposit: amount(p.deposit), mileage: typeof p.mileage === 'string' ? p.mileage : null, raw: p }; }),
      observedAt, raw: { ...v, source: 'website' }, vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] } };
  });
  return { observedAt, complete: true, completedScopes: ['homepage'], visibilityComplete: true, rows, heldCount: 0 };
}
