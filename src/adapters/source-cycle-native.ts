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
/** 번호도 시트 UID 도 없는 행의 안정 키(대표 10-04/10-14 «번호 없는 것도 같이 만들어 놔라»): «공급사·탭·차량을 설명하는 칸(요금·상태 제외)» 지문 + 같은 지문의 탭 안 출현 순번.
 * 요금·상태는 지문에 넣지 않는다 — 요금만 바뀐 같은 행은 같은 문서여야 한다. 번호가 생기면 같은 지문의 문서에 번호를 채운다(계획의 지문 브리지). */
const FINGERPRINT_HEADERS = ['상품구분', '제조사', '모델', '세부모델', '세부트림', '외부색상', '내부색상', '연식', '배기량', '연료', '차명 원문', '최초등록일', '입고일자'];
export function rowFingerprint(source: string, tab: string, row: readonly unknown[], headers: readonly unknown[]): string | null {
  const parts = FINGERPRINT_HEADERS.map(h => { const i = headers.indexOf(h); return i < 0 ? '' : String(row[i] ?? '').replace(/\s+/g, ' ').trim().toUpperCase(); });
  // 차량을 특정할 최소 정보: 모델·세부모델·차명 원문 중 하나는 있어야 한다(전부 비면 지문을 만들지 않는다 → 기존대로 보류).
  const hasName = ['모델', '세부모델', '차명 원문'].some(h => { const i = headers.indexOf(h); return i >= 0 && String(row[i] ?? '').trim() !== ''; });
  return hasName ? stableDigest([source, tab, parts]).slice(0, 16) : null;
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
  const copy = structuredClone(capture), holds: string[] = [], positions = new Map<string, { scope: string; row: number; cells: unknown[]; headers: unknown[]; fp: string | null }>();
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
    // 행별 키: 번호 → 시트 UID → (없으면) 지문#순번. 순번은 같은 지문의 탭 안 출현 순서(원천 행 위치는 이 순번으로만 보조 키가 된다).
    const rowKeys: Array<{ uid: string | null; fp: string | null }> = [];
    const fpCount = new Map<string, number>();
    for (let i = 0; i < tab.values.length; i++) {
      const r = tab.values[i]!;
      const sup = i === 0 ? undefined : sharedSheetChannelOf(tab.title, r[0]);
      const hid = m?.properties?.hidden || grid?.rowMetadata?.[i]?.hiddenByUser || grid?.rowMetadata?.[i]?.hiddenByFilter;
      if (i === 0 || !sup || sup.code !== source || hid || tab.title === '종합' || r.every(c => c === '' || c === null)) { rowKeys.push({ uid: null, fp: null }); continue; }
      const base = sourceUid(r[plateIndex], originalHeaders.includes('UID') ? r[uidIndex] : null);
      const fp = rowFingerprint(source, tab.title, r, originalHeaders);
      if (base) { rowKeys.push({ uid: base, fp }); continue; }
      if (!fp) { rowKeys.push({ uid: null, fp: null }); continue; }
      const n = (fpCount.get(fp) ?? 0) + 1; fpCount.set(fp, n);
      rowKeys.push({ uid: `FP-${source}-${fp}-${n}`, fp });
    }
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
      const rowUid = rowKeys[i]?.uid ?? null;
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
      const uid = rowKeys[i]?.uid ?? null;
      const notChosen = !!uid && !conflictingUids.has(uid) && chosen.get(uid)?.index !== i;
      if (!uid || seen.has(uid) || conflictingUids.has(uid) || notChosen) {
        holds.push(!uid ? 'UID_REQUIRED' : conflictingUids.has(uid) ? 'DUPLICATE_UID_CONFLICT' : 'DUPLICATE_UID_SUSPECT');
        tab.values[i] = Array(tab.values[0]!.length).fill(''); continue;
      }
      seen.add(uid); row[uidIndex] = uid;
      positions.set(uid, { scope: tab.title, row: i + 1, cells: original, headers: originalHeaders, fp: rowKeys[i]?.fp ?? null });
    }
  }
  copy.digest = sharedSheetCaptureDigest(copy);
  const engine = sharedSheetEngine(async () => copy);
  const converted = engine.toRecords({ raw: copy, observedAt: copy.readTime, attemptedAt: copy.readTime, complete, error: null });
  return { observedAt: capture.readTime, complete, completedScopes: complete ? scopes : [], visibilityComplete: complete,
    heldCount: holds.length + converted.held.length, heldReasons: [...holds, ...converted.held.map(h => h.reasons.join(','))],
    rows: converted.records.map(record => { const pos = positions.get(record.uid)!;
      return { scope: pos.scope, record: { ...record, raw: { cells: pos.cells, headers: pos.headers, source: 'shared-sheet',
        source_tab: pos.scope, source_row: pos.row, sheet_uid: record.plate ? null : record.uid,
        ...productTypeFromCell(pos.headers, pos.cells, '상품구분'),
        ...(pos.fp ? { row_fingerprint: pos.fp } : {}) } } }; }) };
}
/** 원천 자기 칸의 상품 구분 값이 중앙 어휘와 «정확히» 같을 때만 raw.product_type 으로 낸다(추정·변환 없음: 어휘 밖이면 비워 두어 «없음» 으로 남긴다). */
const PRODUCT_TYPE_VOCABULARY = new Set(['신차렌트', '중고렌트', '재렌트', '신차구독', '중고구독', '재구독', '오공구독', '픽업구독', '오플구독']);
export function productTypeFromCell(headers: readonly unknown[], cells: readonly unknown[], header: string): { product_type?: string } {
  const at = headers.findIndex(h => String(h ?? '').trim() === header);
  const value = at >= 0 && typeof cells[at] === 'string' ? (cells[at] as string).trim() : '';
  return PRODUCT_TYPE_VOCABULARY.has(value) ? { product_type: value } : {};
}
export type AicaTable = { title: string; values: unknown[][] };
/** SPEC3B: explicit native headers; RAW cells remain unchanged. No vehicle-master inference. */
export function aicaNativeCapture(tables: AicaTable[], observedAt: string, meta?: Visibility): CycleCapture {
  const rows: CycleCapture['rows'] = [], completedScopes: string[] = [], monthlyHolds: string[] = [], unparseableMonthlyUids = new Set<string>();
  let visibilityComplete = true, observationOnlyCount = 0;
  const notes: string[] = [];
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
    // 첫 칸(배차상태) 머리글만 비어 있고 나머지 머리글이 같은 시트 다른 탭의 표준 머리글과 «순서·개수까지» 같으면 첫 칸을 «배차상태» 로 간주한다.
    // 그 밖의 어떤 불일치도 기존대로 탭 전체 보류다. 공급사 시트는 고치지 않으며 경고 코드를 남긴다(2026-10-14 «장기특별이벤트» 탭 A1 공백 31대 실측).
    if (title !== '월렌트' && headers[0] === '' && headers.length > 1) {
      const reference = AICA_SCOPES.filter(s => s !== title && s !== '월렌트').map(s => tables.find(t => t.title === s)?.values[0]?.map(v => String(v).trim()))
        .find(h => h && h[0] === '배차상태' && h.length === headers.length && h.slice(1).every((v, i) => v === headers[i + 1]));
      if (reference) { headers[0] = '배차상태'; table.values[0]![0] = '배차상태'; notes.push(`ARIKA_HEADER_INFERRED:${title}`); }
    }
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
          source_row: index + 2, product_group: 'LONG_TERM', ...productTypeFromCell(headers, cells, '구분'),
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
    completedScopes, visibilityComplete, rows: keptRows, heldCount: monthlyHolds.length, heldReasons: monthlyHolds, observationOnlyCount,
    ...(notes.length ? { notes } : {}) };
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
