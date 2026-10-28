import { classifyReadError, type SourceEngine, type SourceFamily, type SourceProductRecord, type SourceRead } from '../domain/source-engine.js';
import { sharedSheetEngine } from './shared-sheet-engine.js';
import { ERP5_INVENTORY_STATUS_KINDS, PROVIDER_AVAILABLE_STATUS_LABELS, isContractedStatus } from '../domain/erp5-inventory-status.js';
const KNOWN_SALE_STATUS: ReadonlySet<string> = new Set([...Object.keys(ERP5_INVENTORY_STATUS_KINDS), ...PROVIDER_AVAILABLE_STATUS_LABELS, '배차문의', '수리중']);
/** 공급사 시트(F05 차량상태·아이카 배차상태)의 «판매 끝» 표기: 판매 불가로 읽는다(인도완료 = 출고완료와 같은 인도 끝, 판매완료 = 팔림).
 * 뜻이 갈리는 «취소»·«진행중» 은 넣지 않는다 — 모르는 값으로 남아 STATUS_UNKNOWN 보류·회차 경고(STATUS_UNKNOWN_EXPOSED)로 드러난다(결정 필요). */
export const SHEET_NOT_SELLABLE_STATUS: ReadonlySet<string> = new Set(['출고불가', '출고완료', '인도완료', '판매완료']);
import { sharedSheetChannels, type SharedSheetCapture } from './shared-sheet-source.js';
import { IancarOneApiError, type IancarOneListCapture } from './iancar-one-api.js';
import type { CycleRead } from '../ports/source-cycle.js';
import { stableIancarPayload } from './iancar-stable-facts.js';

export type CycleSourceKind = 'F05' | 'AICA' | 'IANCAR' | 'IRON' | 'AUTOPLUS' | 'SONOGONG' | 'DECISION' | 'FILE';
export type CycleSourceDefinition = {
  sourceId: string; kind: CycleSourceKind; scopes: string[]; maxDowngradeRatio: number;
};
export const AICA_SCOPES = ['장기특별이벤트', '신차선출고', '중고재렌트', '월렌트'] as const;
export const CYCLE_FAMILIES: Record<CycleSourceKind, SourceFamily> = {
  F05: 'SHARED_SHEET', AICA: 'AICA', IANCAR: 'IANCAR', IRON: 'OTHER', AUTOPLUS: 'OTHER', SONOGONG: 'OTHER', DECISION: 'OTHER', FILE: 'OTHER',
};
/** Transport/converter outputs from existing collectors. UID must be an upstream stable key;
 * no row-number or plate fallback. Scope names are config, never guessed from legacy products. */
export type CycleCapture = {
  observedAt: string; synced_at?: string;
  complete: boolean; completedScopes: string[]; visibilityComplete: boolean;
  rows: Array<{ scope: string; record: SourceProductRecord; hiddenTab?: boolean; hiddenByUser?: boolean; hiddenByFilter?: boolean }>;
  heldCount: number;
  observationOnlyCount?: number;
  heldReasons?: string[];
  /** complete=false 일 때 왜 불완전한지(안전한 대문자 코드). UPSTREAM_STALE 은 상류 원천이 갱신되지 않은 것이라 회차 실패로 세지 않는다. */
  incompleteReason?: string;
  /** 읽기는 정상이지만 사람이 알아야 할 안전한 대문자 코드(예: ARIKA_HEADER_INFERRED:<탭>). 회차 요약에 붙는다. */
  notes?: string[];
};
export interface CyclePlugin<T = unknown> extends SourceEngine<T> {
  read(): Promise<CycleRead<T>>;
  observationOnly?: boolean;
  observationCountOfRead?(read: SourceRead<T>): number;
  sourceId: string; family: SourceFamily; maxDowngradeRatio: number; downgradeFloor?: number;
  /** 원천에 없는 노출 문서를 내릴 때 남기는 사유. 기본은 SOURCE_ABSENT, 대표 지시 공급사는 DECISION_WITHDRAWN. */
  absenceReason?: string;
  /** 대표 결정으로 노출하지 않는 상품 구분(CycleConfig.decisionWithdrawnProductTypes). */
  decisionWithdrawnProductTypes?: readonly string[];
  /** 이번 한 회차 한정 신규 편입 상한 상향(최초 대량 편입). 원천 잠금 안에서 «적용 전에» 표식을 원자적으로 기록해 소진시키고(claimEnrollCapOnce), 기록 실패 시 올리지 않는다. */
  enrollCapOnce?: number; enrollCapOnceMarker?: string;
  optionsRewriteCap?: number;
  specValidation?: boolean;
  syncedAt?: () => Promise<string | null>;
  syncedAtOfRead?(read: SourceRead<T>): string | null;
}
/** Ports reuse F05/sharedSheetRecords, ONE full-facts, homepage and ERP4 collector output.
 * Reads are injected: importing this module neither authenticates nor contacts a provider. */
export function sourceCyclePlugin(def: CycleSourceDefinition, readCapture: () => Promise<CycleCapture>,
  clock = () => new Date().toISOString(), syncedAt?: () => Promise<string | null>): CyclePlugin<CycleCapture> {
  if (!def.sourceId || !CYCLE_FAMILIES[def.kind] || !def.scopes.length || new Set(def.scopes).size !== def.scopes.length ||
      (def.kind === 'AICA' && AICA_SCOPES.some(s => !def.scopes.includes(s)))) throw new Error('CYCLE_SOURCE_CONFIG_INVALID');
  return {
    sourceId: def.sourceId, family: CYCLE_FAMILIES[def.kind], maxDowngradeRatio: def.maxDowngradeRatio,
    ...(syncedAt ? { syncedAt } : {}),
    observationCountOfRead: read => read.raw?.observationOnlyCount ?? 0,
    syncedAtOfRead: read => read.raw?.synced_at ?? null,
    async read(): Promise<CycleRead<CycleCapture>> {
      const attemptedAt = clock();
      try {
        const raw = await readCapture();
        if (!Array.isArray(raw.rows) || !Array.isArray(raw.completedScopes) || !Number.isSafeInteger(raw.heldCount) ||
            raw.heldCount < 0 || raw.heldCount > 100_000 || !Number.isFinite(Date.parse(raw.observedAt)))
          return { raw: null, attemptedAt, observedAt: null, complete: false, error: 'SCHEMA_INVALID' };
        const complete = raw.complete === true && def.scopes.every(s => raw.completedScopes.includes(s)) &&
          (!['F05', 'AICA'].includes(def.kind) || raw.visibilityComplete === true);
        return { raw, attemptedAt, observedAt: raw.observedAt, complete, error: complete ? null : 'PARTIAL',
          ...(!complete && raw.incompleteReason ? { detail: raw.incompleteReason } : {}) };
      } catch (e) {
        const { error, detail } = classifyReadError(e);
        return { raw: null, complete: false, attemptedAt, observedAt: null, error, detail,
          ...(def.kind === 'IANCAR' && e instanceof IancarOneApiError && e.clockDiagnostic ? { clockDiagnostic: e.clockDiagnostic } : {}) };
      }
    },
    toRecords(read) {
      const records: SourceProductRecord[] = [], held: Array<{ row: number; reasons: string[] }> = [];
      if (!read.raw) return { records, held };
      for (let i = 0; i < read.raw.heldCount; i++) held.push({ row: 0, reasons: [read.raw.heldReasons?.[i] ?? 'UPSTREAM_ROW_HOLD'] });
      for (const [i, row] of read.raw.rows.entries()) {
        if (!def.scopes.includes(row.scope) || row.scope === '종합') continue;
        if (row.record.sourceId !== def.sourceId) { held.push({ row: i + 1, reasons: ['SOURCE_MISMATCH'] }); continue; }
        // 필터로 가려진 행(hiddenByFilter)은 공유 «보기» 상태라 데이터로 읽는다(숨김 판정에 쓰지 않는다).
        if (def.kind === 'AICA' && (row.hiddenTab || row.hiddenByUser)) { held.push({ row: i + 1, reasons: ['ROW_HIDDEN_BY_USER'] }); continue; }
        const r = structuredClone(row.record), provided = r.status.raw.trim();
        // «계약중» 계열(대표 2026-10-14): 모든 원천에서 원문을 «계약중» 으로 통일 — 판매 가능(선점 표시 노출), 공급사 표기는 raw.provider_status.
        // 엔진 작성 계약중 판정(engineWroteContracted)이 원문 «계약중» 을 보므로 표시만이 아니라 원문을 바꾼다. 출고불가·판매완료만 내린다.
        const contracted = def.kind !== 'AUTOPLUS' && def.kind !== 'SONOGONG' && def.kind !== 'FILE' && isContractedStatus(provided);
        if (contracted && provided !== '계약중') { r.status.raw = '계약중'; r.raw = { ...r.raw, provider_status: provided }; }
        const status = contracted ? '계약중' : provided;
        // Presence is kept even for excluded rows: explicit not-sellable is distinct from absence.
        switch (def.kind) {
          case 'F05':
            // 모르는 상태값은 판매 가능으로 추정하지 않는다(null → STATUS_UNKNOWN 보류). 알려진 값 = 검토된 어휘 + 공급사 표기(배차문의·수리중).
            r.status.saleAvailable = read.raw.visibilityComplete !== true ? null :
              row.hiddenTab || row.hiddenByUser || SHEET_NOT_SELLABLE_STATUS.has(status) ? false : KNOWN_SALE_STATUS.has(status) ? true : null;
            break;
          case 'AICA':
            r.status.saleAvailable = SHEET_NOT_SELLABLE_STATUS.has(status) ? false : KNOWN_SALE_STATUS.has(status) ? true : null;
            // Preserve the provider spelling in status.raw; expose its common label as evidence.
            r.raw = { ...r.raw, sourceCycleDisplayStatus: status === '배차문의' ? '출고협의' : status === '수리중' ? '상품화중' : status };
            break;
          // 요금 사실 보류 차(raw.iancar_fact_hold)는 판매 가능 여부를 모른다(null): 기존 문서는 계획이 STATUS_UNKNOWN 으로 그대로 두고(부재 하향도 안 됨),
          // 새 차는 노출 없이 번호·차명만 편입된다. 틀린 요금은 쓰지 않는다(요금 항은 플러그인이 비운다).
          case 'IANCAR': r.status.saleAvailable = typeof r.raw.iancar_fact_hold === 'string' ? null : ['AVAILABLE', 'PREPARING', '계약중'].includes(status); break;
          // 옛 사이트맵 캡처는 게시/비게시, 홈피 상세 어댑터(SOURCE_CYCLE_IRON_HOMEPAGE=1)는 즉시출고·출고가능·출고협의·출고불가 를 이미 판정해 넘긴다
          // (전에는 «게시» 만 판매 가능이라 홈피 모드의 출고가능 차까지 전부 판매 불가로 내려갔다).
          // 어댑터가 모르는/섞인 배지로 보류(null)한 상태는 그대로 null(STATUS_UNKNOWN) — 판매 불가로 바꿔 기존 노출을 내리지도, 판매 가능으로 추정하지도 않는다.
          case 'IRON': r.status.saleAvailable = status === '게시' ? true : ['비게시', '출고불가', '판매완료', '출고완료'].includes(status) ? false :
            r.status.saleAvailable === true ? true : r.status.saleAvailable === false ? false : null; break;
          // These collectors already provide normalized status, never infer it from old catalog values.
          case 'AUTOPLUS': case 'SONOGONG': case 'FILE': break;
        }
        records.push(r);
      }
      return { records, held };
    },
  };
}

export type SheetCycleVisibility = {
  complete: boolean;
  tabs: Array<{ title: string; hidden: boolean; coveredRows: number; hiddenRows: number[] }>;
};
/** F05 conversion reuses the phase-one engine/normalizer, including ZERO/UNKNOWN and UID HOLD.
 * Visibility must come from the same capture window. Hidden row positions are metadata only,
 * never used as product identities. Missing tabs/metadata cannot prove supplier absence. */
export function sharedSheetCyclePlugin(sourceId: string, maxDowngradeRatio: number,
  read: () => Promise<{ capture: SharedSheetCapture; visibility: SheetCycleVisibility }>, clock?: () => string) {
  const scopes = [...new Set(sharedSheetChannels.filter(c => c.code === sourceId).map(c => c.tab))];
  return sourceCyclePlugin({ sourceId, kind: 'F05', scopes, maxDowngradeRatio }, async () => {
    const input = await read();
    const engine = sharedSheetEngine(async () => input.capture, clock);
    const result = await engine.read(), converted = engine.toRecords(result);
    const metadataComplete = input.visibility.complete && scopes.every(scope => {
      const tab = input.capture.tabs.find(t => t.title === scope), meta = input.visibility.tabs.find(t => t.title === scope);
      return !!tab && !!meta && meta.coveredRows >= tab.rowCount;
    });
    const rows: CycleCapture['rows'] = [];
    let heldCount = converted.held.length;
    for (const record of converted.records.filter(r => r.sourceId === sourceId)) {
      const matches = input.capture.tabs.flatMap(tab => {
        if (!scopes.includes(tab.title)) return [];
        const uid = tab.values[0]?.indexOf('UID') ?? -1;
        return uid < 0 ? [] : tab.values.flatMap((cells, index) => index > 0 && cells[uid] === record.uid ? [{ tab, row: index + 1 }] : []);
      });
      if (matches.length !== 1) { heldCount++; continue; }
      const match = matches[0]!, meta = input.visibility.tabs.find(t => t.title === match.tab.title);
      rows.push({ scope: match.tab.title, record, hiddenTab: meta?.hidden === true,
        hiddenByUser: meta?.hiddenRows.includes(match.row) === true });
    }
    return { observedAt: result.observedAt ?? input.capture.readTime, complete: result.complete,
      completedScopes: result.complete ? scopes : [], visibilityComplete: metadataComplete, rows, heldCount };
  }, clock);
}

/** 대표 지시로 판매 목록에서 내린 공급사(contracts/withdrawn-suppliers.v1.json). 원천이 «없다»가 아니라 «내리라는 결정»이므로
 * 완전한 빈 원천으로 읽고 사유를 DECISION_WITHDRAWN 으로 남긴다. 다른 쓰기 주체가 다시 올려도 다음 회차에 다시 내린다. */
export function decisionWithdrawnPlugin(sourceId: string, clock: () => string = () => new Date().toISOString()) {
  const plugin = sourceCyclePlugin({ sourceId, kind: 'DECISION', scopes: ['decision'], maxDowngradeRatio: 1 }, async () => ({
    observedAt: clock(), complete: true, completedScopes: ['decision'], visibilityComplete: true, rows: [], heldCount: 0 }), clock);
  plugin.absenceReason = 'DECISION_WITHDRAWN';
  return plugin;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** 실제 달력 검증(윤년 포함): «YYYY-MM» 또는 «YYYY-MM-DD». 2026-99-99·2026-02-31·2025-02-29 는 최초등록일로 확정하지 않는다(Codex #644 ②). */
export function validCalendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12) return false;
  if (m[3] === undefined) return true;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  const day = Number(m[3]);
  return day >= 1 && day <= days;
}

/** Read an existing ONE full-facts result. No second API client; PREPARING is a sellable source
 * state by SPEC2 even when provider `available` is false. Missing rates remain UNKNOWN/HOLD. */
export function iancarCyclePlugin(maxDowngradeRatio: number, read: () => Promise<IancarOneListCapture>,
  clock?: () => string, syncedAt?: () => Promise<string | null>, opts: { stableFacts?: boolean } = {}) {
  return sourceCyclePlugin({ sourceId: 'RP031', kind: 'IANCAR', scopes: ['ONE_FULL_FACTS'], maxDowngradeRatio }, async () => {
    const capture = await read();
    const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    const amount = (v: unknown): import('../domain/source-engine.js').SourceAmount => v === 0 ? { state: 'ZERO', value: 0 } :
      typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? { state: 'KNOWN', value: v } : { state: 'UNKNOWN', value: null };
    const full = capture.factScope === 'FULL_FACTS' && capture.readyForRawIngest && !capture.stale &&
      capture.issues.length === 0 && capture.records.length === capture.total;
    // 불완전한 읽기(목록 단계 실패 PAGINATION_TOTAL_MISMATCH·SYNC_TIME_DRIFT·PAGINATION_METADATA_DRIFT, 끝 목록 불일치 등)는 행을 내지 않는다.
    // 목록 단계에서 멈춘 수집은 요금을 읽지 않아 행을 내면 원천 원문 계층(source_raw)에 «요금 없음(terms=[])»이 전 차량에 덮인다.
    const heldReasons: string[] = [];
    const rows = !full ? [] : capture.records.flatMap(item => {
      // 값 지문 안정화(iancar-stable-facts, 기본 꺼짐): 관측 시각·자격 URL 을 뺀 payload 를 원문으로 삼아 저장·비교 모두 같은 규칙을 쓴다.
      const raw = opts.stableFacts ? stableIancarPayload(item.payload) : item.payload, detail = object(object(raw.detail).data);
      // 번호로 문서를 특정할 수 없는 차(식별 보류)는 행을 내지 않고 보류로만 센다 — 어느 문서인지 모르므로 이 회차의 부재 하향은 유보된다.
      if (item.hold?.identity) { heldReasons.push(item.hold.code); return []; }
      // 요금 사실 보류 차는 행(번호·상태·차명)은 내되 요금 항은 비운다. 보류 사유는 값 계열이라 다른 차의 부재 하향을 막지 않는다(jobs VALUE_CLASS_HOLDS).
      const factHold = item.hold && !item.hold.identity ? item.hold.code : null;
      if (factHold) heldReasons.push(factHold);
      const rates = factHold ? [] : object(raw.rates).data;
      const pick = (key: string): unknown => raw[key] ?? detail[key];
      // 차 한 대 사실(옛 발행기와 같은 원천 칸: year·fuel·color·mileage). 시트 원천과 같은 키(raw.spec)로 둔다 — 제조사·모델은 식별 칸에 쓰지 않고
      // 원문(raw.manufacturer·raw.model·raw.name)으로만 남는다(식별 승격이 정한다).
      const spec: Record<string, string> = {};
      const year = pick('year');
      if ((typeof year === 'number' && Number.isSafeInteger(year) && year >= 1900 && year <= 2100) || (typeof year === 'string' && /^(19|20)\d{2}$/.test(year.trim()))) spec.year = String(year).trim();
      const fuel = pick('fuel'), color = pick('color'), mileage = pick('mileage'), registered = pick('first_registration_date');
      if (typeof fuel === 'string' && fuel.trim()) spec.fuel_type = fuel.trim();
      if (typeof color === 'string' && color.trim()) spec.ext_color = color.trim();
      if (typeof mileage === 'number' && Number.isSafeInteger(mileage) && mileage >= 0) spec.mileage = String(mileage);
      if (typeof registered === 'string' && validCalendarDate(registered.trim())) spec.first_registration_date = registered.trim();
      const plate = typeof raw.plate_number === 'string' && raw.plate_number.trim() ? raw.plate_number.replace(/\s/g, '') : null;
      const record: SourceProductRecord = { sourceId: 'RP031', uid: item.vehicleId, plate,
        vehicleText: typeof detail.name === 'string' ? detail.name : '',
        status: { raw: String(raw.inventory_status ?? ''), saleAvailable: null },
        // 원문에 이미 spec 이 있으면 파생값으로 덮지 않는다(Codex #644 ①): 파생값은 원문에 «없는 칸만» 채우고 원문 값·추가 필드는 그대로 남긴다.
        observedAt: capture.syncedAt, raw: { ...structuredClone(raw), ...(Object.keys(spec).length || isPlainObject(raw.spec)
          ? { spec: { ...spec, ...(isPlainObject(raw.spec) ? structuredClone(raw.spec) : {}) } } : {}),
          ...(factHold ? { iancar_fact_hold: factHold } : {}) }, vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'],
        terms: (Array.isArray(rates) ? rates : []).map(value => {
          const rate = object(value);
          return { months: typeof rate.rental_period === 'number' ? rate.rental_period : 0,
            monthlyRent: amount(rate.currency === 'KRW' && rate.vat_included === true ? rate.monthly_rate : null),
            deposit: amount(rate.currency === 'KRW' && rate.vat_included === true ? rate.deposit : null),
            mileage: typeof rate.contracted_mileage === 'number' && ['month', 'year'].includes(String(rate.mileage_period))
              ? `${rate.contracted_mileage}km/${rate.mileage_period}` : null, raw: structuredClone(rate) };
        }) };
      return [{ scope: 'ONE_FULL_FACTS', record }];
    });
    // 불완전한 이유: 상류 목록이 오래됐으면(공급사 갱신 정지) 우리 쪽 실패가 아니다. 그 밖은 첫 이슈 코드를 그대로 남긴다.
    const stale = capture.stale || capture.issues.some(i => /SOURCE_STALE|FRESHNESS_EXCEEDED/.test(i));
    const incompleteReason = full ? undefined : stale ? 'UPSTREAM_STALE' :
      capture.issues.find(i => /^[A-Z][A-Z0-9_]{2,63}$/.test(i)) ?? (capture.factScope !== 'FULL_FACTS' ? 'NOT_FULL_FACTS' : 'RECORD_COUNT_MISMATCH');
    return { observedAt: capture.syncedAt, synced_at: capture.syncedAt, complete: full,
      completedScopes: full ? ['ONE_FULL_FACTS'] : [], visibilityComplete: true, rows, heldCount: heldReasons.length,
      ...(heldReasons.length ? { heldReasons } : {}), ...(incompleteReason ? { incompleteReason } : {}),
      // 상세·가용 캐시(#724)를 쓴 회차는 재사용 대수를 요약에 남긴다(운영 검증용 — 값 없음 = 캐시 꺼짐).
      ...(capture.detailsCached !== undefined || opts.stableFacts ? { notes: [
        ...(capture.detailsCached !== undefined ? [`IANCAR_DETAIL_CACHED:${capture.detailsCached}`] : []),
        ...(opts.stableFacts ? ['IANCAR_STABLE_FACTS:1'] : [])] } : {}) };
  }, clock, syncedAt);
}
