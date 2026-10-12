import type { SourceEngine, SourceFamily, SourceProductRecord, SourceRead } from '../domain/source-engine.js';
import { sharedSheetEngine } from './shared-sheet-engine.js';
import { sharedSheetChannels, type SharedSheetCapture } from './shared-sheet-source.js';
import type { IancarOneListCapture } from './iancar-one-api.js';

export type CycleSourceKind = 'F05' | 'AICA' | 'IANCAR' | 'IRON' | 'AUTOPLUS' | 'SONOGONG';
export type CycleSourceDefinition = {
  sourceId: string; kind: CycleSourceKind; scopes: string[]; maxDowngradeRatio: number;
};
export const AICA_SCOPES = ['장기특별이벤트', '신차선출고', '중고재렌트', '월렌트'] as const;
export const CYCLE_FAMILIES: Record<CycleSourceKind, SourceFamily> = {
  F05: 'SHARED_SHEET', AICA: 'AICA', IANCAR: 'IANCAR', IRON: 'OTHER', AUTOPLUS: 'OTHER', SONOGONG: 'OTHER',
};
/** Transport/converter outputs from existing collectors. UID must be an upstream stable key;
 * no row-number or plate fallback. Scope names are config, never guessed from legacy products. */
export type CycleCapture = {
  observedAt: string; synced_at?: string;
  complete: boolean; completedScopes: string[]; visibilityComplete: boolean;
  rows: Array<{ scope: string; record: SourceProductRecord; hiddenTab?: boolean; hiddenByUser?: boolean; hiddenByFilter?: boolean }>;
  heldCount: number;
};
export interface CyclePlugin<T = unknown> extends SourceEngine<T> {
  sourceId: string; family: SourceFamily; maxDowngradeRatio: number;
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
    syncedAtOfRead: read => read.raw?.synced_at ?? null,
    async read(): Promise<SourceRead<CycleCapture>> {
      const attemptedAt = clock();
      try {
        const raw = await readCapture();
        if (!Array.isArray(raw.rows) || !Array.isArray(raw.completedScopes) || !Number.isSafeInteger(raw.heldCount) ||
            raw.heldCount < 0 || raw.heldCount > 100_000 || !Number.isFinite(Date.parse(raw.observedAt)))
          return { raw: null, attemptedAt, observedAt: null, complete: false, error: 'SCHEMA_INVALID' };
        const complete = raw.complete === true && def.scopes.every(s => raw.completedScopes.includes(s)) &&
          (def.kind !== 'F05' || raw.visibilityComplete === true);
        return { raw, attemptedAt, observedAt: raw.observedAt, complete, error: complete ? null : 'PARTIAL' };
      } catch (e) {
        const text = e instanceof Error ? e.message : '';
        return { raw: null, complete: false, attemptedAt, observedAt: null,
          error: /429/.test(text) ? 'RATE_LIMITED' : /403|401/.test(text) ? 'AUTH_FAILED' : 'READ_FAILED' };
      }
    },
    toRecords(read) {
      const records: SourceProductRecord[] = [], held: Array<{ row: number; reasons: string[] }> = [];
      if (!read.raw) return { records, held };
      for (let i = 0; i < read.raw.heldCount; i++) held.push({ row: 0, reasons: ['UPSTREAM_ROW_HOLD'] });
      for (const [i, row] of read.raw.rows.entries()) {
        if (!def.scopes.includes(row.scope) || row.scope === '종합') continue;
        if (row.record.sourceId !== def.sourceId) { held.push({ row: i + 1, reasons: ['SOURCE_MISMATCH'] }); continue; }
        const r = structuredClone(row.record), status = r.status.raw.trim();
        // Presence is kept even for excluded rows: explicit not-sellable is distinct from absence.
        switch (def.kind) {
          case 'F05':
            r.status.saleAvailable = read.raw.visibilityComplete !== true ? null : !row.hiddenTab && !row.hiddenByUser &&
              !row.hiddenByFilter && status !== '출고불가';
            break;
          case 'AICA':
            r.status.saleAvailable = ['배차가능', '배차문의', '수리중'].includes(status);
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
    return { observedAt: capture.syncedAt, synced_at: capture.syncedAt, complete: full,
      completedScopes: full ? ['ONE_FULL_FACTS'] : [], visibilityComplete: true, rows, heldCount: 0 };
  }, clock, syncedAt);
}
