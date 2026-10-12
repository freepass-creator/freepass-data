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
      const uid = sourceUid(r.plate, r.raw.sheet_uid);
      if (!uid) { result.held.push({ row: 0, reasons: ['UID_REQUIRED', 'UNASSIGNED_PLATE'] }); continue; }
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
  let complete = true;
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
      if (!supplier || supplier.code !== source || hidden || tab.title === '종합' || row.every(c => c === '' || c === null)) {
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
/** Native A/B/C columns are pinned; prices are identified by explicit period headers, never positions guessed from another sheet. */
export function aicaNativeCapture(tables: AicaTable[], observedAt: string): CycleCapture {
  const rows: CycleCapture['rows'] = []; let heldCount = 0;
  const completedScopes: string[] = [];
  for (const title of AICA_SCOPES) {
    const table = tables.find(t => t.title === title), headers = table?.values[0]?.map(v => String(v).trim());
    if (!table || !headers || headers[0] !== '배차상태' || headers[1] !== '구분' || headers[2] !== '차량번호') continue;
    completedScopes.push(title);
    for (const [index, cells] of table.values.slice(1).entries()) {
      if (cells.every(v => v === '' || v === null)) continue;
      const get = (header: string) => cells[headers.indexOf(header)];
      const plate = isAssignedPlate(cells[2]) ? plateIdentityKey(cells[2]) : null;
      const terms = headers.flatMap((header, column) => {
        const match = /^(\d+)개월$/.exec(header); if (!match || cells[column] === '' || cells[column] == null) return [];
        const deposit = get(`${match[1]}개월 보증금`) ?? get('보증금');
        return [{ months: Number(match[1]), monthlyRent: amount(cells[column]), deposit: amount(deposit === '무보증' ? 0 : deposit),
          mileage: typeof get('연주행') === 'string' ? String(get('연주행')) : null, raw: { rent: cells[column], deposit: deposit ?? null } }];
      });
      rows.push({ scope: title, record: { sourceId: 'RP004', uid: sourceUid(plate, get('UID')) ?? '', plate,
        vehicleText: String(get('차명 원문') ?? get('차명') ?? ''), status: { raw: String(cells[0] ?? ''), saleAvailable: null },
        terms, observedAt, raw: { cells, headers, sheet_uid: get('UID') ?? null, source: 'aica-sheet', source_tab: title,
          source_row: index + 2, product_group: title === '월렌트' ? 'MONTHLY' : 'LONG_TERM' }, vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] } });
    }
  }
  return { observedAt, complete: completedScopes.length === AICA_SCOPES.length, completedScopes, visibilityComplete: true, rows, heldCount };
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
