import { classifyReadError, type SourceEngine, type SourceFamily, type SourceProductRecord, type SourceRead } from '../domain/source-engine.js';
import { sharedSheetEngine } from './shared-sheet-engine.js';
import { ERP5_INVENTORY_STATUS_KINDS, PROVIDER_AVAILABLE_STATUS_LABELS } from '../domain/erp5-inventory-status.js';
const KNOWN_SALE_STATUS: ReadonlySet<string> = new Set([...Object.keys(ERP5_INVENTORY_STATUS_KINDS), ...PROVIDER_AVAILABLE_STATUS_LABELS, '배차문의', '수리중']);
import { sharedSheetChannels, type SharedSheetCapture } from './shared-sheet-source.js';
import type { IancarOneListCapture } from './iancar-one-api.js';

export type CycleSourceKind = 'F05' | 'AICA' | 'IANCAR' | 'IRON' | 'AUTOPLUS' | 'SONOGONG' | 'DECISION';
export type CycleSourceDefinition = {
  sourceId: string; kind: CycleSourceKind; scopes: string[]; maxDowngradeRatio: number;
};
export const AICA_SCOPES = ['장기특별이벤트', '신차선출고', '중고재렌트', '월렌트'] as const;
export const CYCLE_FAMILIES: Record<CycleSourceKind, SourceFamily> = {
  F05: 'SHARED_SHEET', AICA: 'AICA', IANCAR: 'IANCAR', IRON: 'OTHER', AUTOPLUS: 'OTHER', SONOGONG: 'OTHER', DECISION: 'OTHER',
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
  observationOnly?: boolean;
  observationCountOfRead?(read: SourceRead<T>): number;
  sourceId: string; family: SourceFamily; maxDowngradeRatio: number; downgradeFloor?: number;
  /** 원천에 없는 노출 문서를 내릴 때 남기는 사유. 기본은 SOURCE_ABSENT, 대표 지시 공급사는 DECISION_WITHDRAWN. */
  absenceReason?: string;
  /** 이번 한 회차 한정 신규 편입 상한 상향(최초 대량 편입). 원천 잠금 안에서 «적용 전에» 표식을 원자적으로 기록해 소진시키고(claimEnrollCapOnce), 기록 실패 시 올리지 않는다. */
  enrollCapOnce?: number; enrollCapOnceMarker?: string;
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
    async read(): Promise<SourceRead<CycleCapture>> {
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
        return { raw: null, complete: false, attemptedAt, observedAt: null, error, detail };
      }
    },
    toRecords(read) {
      const records: SourceProductRecord[] = [], held: Array<{ row: number; reasons: string[] }> = [];
      if (!read.raw) return { records, held };
      for (let i = 0; i < read.raw.heldCount; i++) held.push({ row: 0, reasons: [read.raw.heldReasons?.[i] ?? 'UPSTREAM_ROW_HOLD'] });
      for (const [i, row] of read.raw.rows.entries()) {
        if (!def.scopes.includes(row.scope) || row.scope === '종합') continue;
        if (row.record.sourceId !== def.sourceId) { held.push({ row: i + 1, reasons: ['SOURCE_MISMATCH'] }); continue; }
        if (def.kind === 'AICA' && (row.hiddenTab || row.hiddenByUser || row.hiddenByFilter)) continue;
        const r = structuredClone(row.record), status = r.status.raw.trim();
        // Presence is kept even for excluded rows: explicit not-sellable is distinct from absence.
        switch (def.kind) {
          case 'F05':
            // 모르는 상태값은 판매 가능으로 추정하지 않는다(null → STATUS_UNKNOWN 보류). 알려진 값 = 검토된 어휘 + 공급사 표기(배차문의·수리중).
            r.status.saleAvailable = read.raw.visibilityComplete !== true ? null :
              row.hiddenTab || row.hiddenByUser || row.hiddenByFilter || status === '출고불가' ? false : KNOWN_SALE_STATUS.has(status) ? true : null;
            break;
          case 'AICA':
            r.status.saleAvailable = status === '출고불가' ? false : KNOWN_SALE_STATUS.has(status) ? true : null;
            // Preserve the provider spelling in status.raw; expose its common label as evidence.
            r.raw = { ...r.raw, sourceCycleDisplayStatus: status === '배차문의' ? '출고협의' : status === '수리중' ? '상품화중' : status };
            break;
          case 'IANCAR': r.status.saleAvailable = ['AVAILABLE', 'PREPARING'].includes(status); break;
          case 'IRON': r.status.saleAvailable = status === '게시'; break;
          // These collectors already provide normalized status, never infer it from old catalog values.
          case 'AUTOPLUS': case 'SONOGONG': break;
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

/** Read an existing ONE full-facts result. No second API client; PREPARING is a sellable source
 * state by SPEC2 even when provider `available` is false. Missing rates remain UNKNOWN/HOLD. */
export function iancarCyclePlugin(maxDowngradeRatio: number, read: () => Promise<IancarOneListCapture>,
  clock?: () => string, syncedAt?: () => Promise<string | null>) {
  return sourceCyclePlugin({ sourceId: 'RP031', kind: 'IANCAR', scopes: ['ONE_FULL_FACTS'], maxDowngradeRatio }, async () => {
    const capture = await read();
    const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    const amount = (v: unknown): import('../domain/source-engine.js').SourceAmount => v === 0 ? { state: 'ZERO', value: 0 } :
      typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? { state: 'KNOWN', value: v } : { state: 'UNKNOWN', value: null };
    const full = capture.factScope === 'FULL_FACTS' && capture.readyForRawIngest && !capture.stale &&
      capture.issues.length === 0 && capture.records.length === capture.total;
    const rows = capture.records.map(item => {
      const raw = item.payload, rates = object(raw.rates).data, detail = object(object(raw.detail).data);
      const record: SourceProductRecord = { sourceId: 'RP031', uid: item.vehicleId,
        plate: typeof raw.plate_number === 'string' ? raw.plate_number : null,
        vehicleText: typeof detail.name === 'string' ? detail.name : '',
        status: { raw: String(raw.inventory_status ?? ''), saleAvailable: null },
        observedAt: capture.syncedAt, raw: structuredClone(raw), vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'],
        terms: (Array.isArray(rates) ? rates : []).map(value => {
          const rate = object(value);
          return { months: typeof rate.rental_period === 'number' ? rate.rental_period : 0,
            monthlyRent: amount(rate.currency === 'KRW' && rate.vat_included === true ? rate.monthly_rate : null),
            deposit: amount(rate.currency === 'KRW' && rate.vat_included === true ? rate.deposit : null),
            mileage: typeof rate.contracted_mileage === 'number' && ['month', 'year'].includes(String(rate.mileage_period))
              ? `${rate.contracted_mileage}km/${rate.mileage_period}` : null, raw: structuredClone(rate) };
        }) };
      return { scope: 'ONE_FULL_FACTS', record };
    });
    // 불완전한 이유: 상류 목록이 오래됐으면(공급사 갱신 정지) 우리 쪽 실패가 아니다. 그 밖은 첫 이슈 코드를 그대로 남긴다.
    const stale = capture.stale || capture.issues.some(i => /SOURCE_STALE|FRESHNESS_EXCEEDED/.test(i));
    const incompleteReason = full ? undefined : stale ? 'UPSTREAM_STALE' :
      capture.issues.find(i => /^[A-Z][A-Z0-9_]{2,63}$/.test(i)) ?? (capture.factScope !== 'FULL_FACTS' ? 'NOT_FULL_FACTS' : 'RECORD_COUNT_MISMATCH');
    return { observedAt: capture.syncedAt, synced_at: capture.syncedAt, complete: full,
      completedScopes: full ? ['ONE_FULL_FACTS'] : [], visibilityComplete: true, rows, heldCount: 0,
      ...(incompleteReason ? { incompleteReason } : {}) };
  }, clock, syncedAt);
}
