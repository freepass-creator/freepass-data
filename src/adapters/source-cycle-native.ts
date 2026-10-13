import { sharedSheetEngine } from './shared-sheet-engine.js';
import { sharedSheetChannels, sharedSheetChannelOf, sharedSheetCaptureDigest, type SharedSheetCapture } from './shared-sheet-source.js';
import { sourceCyclePlugin, AICA_SCOPES, type CycleCapture, type CyclePlugin } from './source-cycle-plugins.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import type { SourceAmount, SourceProductRecord } from '../domain/source-engine.js';
import { stableDigest } from '../shared/stable-digest.js';

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
    const identified: Array<{ r: SourceProductRecord; uid: string }> = [];
    for (const r of result.records) {
      const uid = r.sourceId === 'RP004' && r.raw.product_group === 'MONTHLY_RENT'
        ? r.uid : sourceUid(r.plate, r.raw.sheet_uid);
      if (!uid) { result.held.push({ row: 0, reasons: r.raw.product_group === 'MONTHLY_RENT'
        ? ['MONTHLY_MODEL_REQUIRED'] : ['UID_REQUIRED', 'UNASSIGNED_PLATE'] }); continue; }
      identified.push({ r, uid });
    }
    // 같은 UID 가 여러 행이면: 상태·가격이 모두 같은 단순 중복은 첫 행만 반영하고 나머지를 보류하고, 서로 다른 내용이면 «행 순서가
    // 노출을 정하지 않도록» 모든 행을 보류한다(같은 차에 상반된 상태·가격). 보류는 부재 하향도 막아 기존 문서는 그대로 남는다.
    // 비교는 해석된 업무 값(상태·차명·항)과 «원문 칸 전체(공백 정리)»를 함께 쓴다: 옵션·원문 칸만 달라도(raw.original 로 들어가는 값) 충돌이다.
    // 월렌트 모델명 칸(0열)은 UID 를 만드는 값이라 대소문자·공백 표기 차이는 제외한다. UID 칸은 비교하지 않는다.
    const headersOf = (r: SourceProductRecord) => (Array.isArray(r.raw?.headers) ? r.raw.headers : []) as unknown[];
    const cellsOf = (r: SourceProductRecord) => (Array.isArray(r.raw?.cells) ? r.raw.cells : []) as unknown[];
    const norm = (c: unknown) => String(c ?? '').replace(/\s+/g, ' ').trim();
    const offerOf = (r: SourceProductRecord) => stableDigest({ status: { raw: norm(r.status.raw), saleAvailable: r.status.saleAvailable },
      vehicleText: r.raw.product_group === 'MONTHLY_RENT' ? '' : norm(r.vehicleText),
      terms: r.terms.map(t => [t.months, t.monthlyRent, t.deposit, t.mileage === null ? null : norm(t.mileage)]),
      cells: cellsOf(r).map((c, i) => headersOf(r)[i] === 'UID' || (r.raw.product_group === 'MONTHLY_RENT' && i === 0) ? '' : norm(c)) });
    const byUid = new Map<string, Array<{ r: SourceProductRecord; uid: string }>>();
    for (const item of identified) (byUid.get(item.uid) ?? byUid.set(item.uid, []).get(item.uid)!).push(item);
    for (const [uid, group] of byUid) {
      const conflicting = group.length > 1 && new Set(group.map(g => offerOf(g.r))).size > 1;
      if (conflicting) { for (let i = 0; i < group.length; i++) result.held.push({ row: 0, reasons: ['DUPLICATE_UID_CONFLICT'] }); continue; }
      if (seen.has(uid)) continue;
      // 내용이 같은 복사본 중 반영할 행은 순서가 아니라 원문 칸의 사전순 최소로 정한다(순서와 무관한 출력).
      const pick = [...group].sort((x, y) => JSON.stringify(x.r.raw?.cells ?? '') < JSON.stringify(y.r.raw?.cells ?? '') ? -1 : 1)[0]!;
      seen.add(uid); records.push({ ...pick.r, uid });
      for (let i = 1; i < group.length; i++) result.held.push({ row: 0, reasons: ['DUPLICATE_UID_SUSPECT'] });
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
    // 같은 UID 가 이 탭에 여러 번 나오는데 행 내용이 다르면(상반된 상태·가격) 행 순서가 노출을 정하지 않도록 그 UID 의 모든 행을 보류한다.
    // 내용이 같은 단순 중복은 아래에서 첫 행만 반영하고 나머지를 보류한다.
    const conflictingUids = new Set<string>(), signatures = new Map<string, string>();
    // 내용이 같은 복사본 중 어느 행을 반영할지는 행 순서가 아니라 원문이 사전순으로 가장 작은 행으로 정한다(내부 공백 표기가 달라도 순서와 무관한 출력).
    const chosen = new Map<string, { index: number; raw: string }>();
    for (let i = 1; i < tab.values.length; i++) {
      const row = tab.values[i]!;
      const supplier = sharedSheetChannelOf(tab.title, row[0]);
      const hiddenRow = m?.properties?.hidden || grid?.rowMetadata?.[i]?.hiddenByUser || grid?.rowMetadata?.[i]?.hiddenByFilter;
      if (!supplier || supplier.code !== source || hiddenRow || tab.title === '종합' || row.every(c => c === '' || c === null)) continue;
      const rowUid = sourceUid(row[plateIndex], originalHeaders.includes('UID') ? row[uidIndex] : null);
      if (!rowUid) continue;
      // 의미 있는 칸만 정규화해 비교한다: 회사명(0열)·UID 칸은 제외하고 값은 공백 정리 후 문자열로 본다. 동일 복사본에서 표기 공백만
      // 달라도 충돌 보류가 되는 오탐을 막는다(숫자 100 과 '100' 도 같게 본다).
      const normalizeCell = (c: unknown) => String(c ?? '').replace(/\s+/g, ' ').trim();   // NFKC 는 쓰지 않는다: 전각 숫자는 실제 금액 파서가 거절하므로 반각과 같게 보면 행 순서에 따라 검증 결과가 달라진다
      const signature = JSON.stringify(row.map((c, column) => column === 0 || column === uidIndex ? '' : normalizeCell(c)));
      const rawKey = JSON.stringify(row.map((c, column) => column === uidIndex ? '' : String(c ?? '')));
      const pick = chosen.get(rowUid);
      if (!pick || rawKey < pick.raw) chosen.set(rowUid, { index: i, raw: rawKey });
      const prior = signatures.get(rowUid);
      if (prior === undefined) signatures.set(rowUid, signature);
      else if (prior !== signature) conflictingUids.add(rowUid);
    }
    for (let i = 1; i < tab.values.length; i++) {
      const row = tab.values[i]!, original = [...row];
      const supplier = sharedSheetChannelOf(tab.title, row[0]);
      const hidden = m?.properties?.hidden || grid?.rowMetadata?.[i]?.hiddenByUser || grid?.rowMetadata?.[i]?.hiddenByFilter;
      const blank = row.every(c => c === '' || c === null);
      // 이 원천의 탭에 있는 보이는 데이터 행인데 회사명이 어느 공급사 코드에도 매핑되지 않으면 «없는 차량»이 아니라 «알 수 없는 행»이다.
      // 조용히 버리면 같은 차량이 부재로 오인돼 내려간다(2026-10-13 경진 → 경진렌트 표기 변경 실측). 보류로 세어 부재 하향을 막는다.
      if (!supplier && scopes.includes(tab.title) && !hidden && tab.title !== '종합' && !blank) holds.push('COMPANY_UNMAPPED');
      if (!supplier || supplier.code !== source || hidden || tab.title === '종합' || blank) {
        tab.values[i] = Array(tab.values[0]!.length).fill(''); continue;
      }
      const uid = sourceUid(row[plateIndex], originalHeaders.includes('UID') ? row[uidIndex] : null);
      const notChosen = !!uid && !conflictingUids.has(uid) && chosen.get(uid)?.index !== i;
      if (!uid || seen.has(uid) || conflictingUids.has(uid) || notChosen) {
        holds.push(!uid ? 'UID_REQUIRED' : conflictingUids.has(uid) ? 'DUPLICATE_UID_CONFLICT' : 'DUPLICATE_UID_SUSPECT');
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
  const rows: CycleCapture['rows'] = [], completedScopes: string[] = [], monthlyHolds: string[] = [], unparseableMonthlyUids = new Set<string>();
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
        if (rent.state === 'UNKNOWN') {
          // 요금 칸이 비어 있거나 «없음» 류 표시면 제안이 없는 것이다. 값이 있는데 읽을 수 없으면(잘못된 금액·음수) 조용히 버리지 않고
          // 보류로 센다 — 버리면 기존 월렌트 모델이 «부재» 로 하향될 수 있다.
          const raw = cells[1];
          const marker = raw == null || (typeof raw === 'string' && ['', '-', '--', '—', 'x', 'X', '없음', 'N/A'].includes(raw.trim()));
          if (!marker) {
            monthlyHolds.push('MONTHLY_RENT_UNPARSEABLE');
            // 같은 모델(UID)에 해석 가능한 다른 행이 있어도 그 UID 그룹 전체를 보류한다(해석 실패 행이 있는데 한쪽만 통과시키지 않는다).
            const unparsedUid = (typeof cells[0] === 'string' ? cells[0] : '').normalize('NFKC').replace(/\s+/gu, '').toUpperCase();
            if (unparsedUid) unparseableMonthlyUids.add(`RP004:MONTHLY:${unparsedUid}`);
          }
          continue;
        }
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
      const vehicleText = [get('차종분류'), get('트림')].filter(v => v != null && v !== '').join(' ');
      // 차량 행이 아닌 안내 문구 행(차량번호·차종·트림·요금이 모두 비고 배차상태 칸에만 글, 예: «수수료 고정 50만원»)은 «번호 미배정 차량»이 아니다.
      // 보류로 세면 RP004 전체의 부재 하향이 막힌다(2026-10-14 5411 실측). 번호·차종·요금 중 하나라도 있으면 지금처럼 보류한다.
      const plateCell = get('차량번호');
      if (!plate && vehicleText === '' && terms.length === 0 && (plateCell == null || String(plateCell).trim() === '')) continue;
      rows.push({ scope: title, record: { sourceId: 'RP004', uid: plate ?? '', plate,
        vehicleText,
        status: { raw: String(get('배차상태') ?? ''), saleAvailable: null }, terms, observedAt,
        raw: { cells: structuredClone(cells), headers, sheet_uid: null, source: 'aica-sheet', source_tab: title,
          source_row: index + 2, product_group: 'LONG_TERM',
          original: Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? null])) },
        vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] } });
    }
  }
  // 해석 실패 행이 있는 월렌트 UID 는 해석 가능한 행이 있어도 그룹 전체를 뺀다(보류로 센다: 부재 하향도 함께 막힌다).
  const keptRows = rows.filter(row => {
    const drop = row.scope === '월렌트' && unparseableMonthlyUids.has(row.record.uid);
    if (drop) monthlyHolds.push('MONTHLY_RENT_UNPARSEABLE');
    return !drop;
  });
  return { observedAt, complete: visibilityComplete && completedScopes.length === AICA_SCOPES.length,
    completedScopes, visibilityComplete, rows: keptRows, heldCount: monthlyHolds.length, heldReasons: monthlyHolds, observationOnlyCount };
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
