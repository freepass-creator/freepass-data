import spec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };
import type { SourceIntakeBatch } from '../domain/source-intake.js';
import { plateIdentityKey, isAssignedPlate } from '../domain/vehicle-plate.js';
import { stableDigest } from '../shared/stable-digest.js';

export type SheetCell = string | number | boolean | null;
export type SharedSheetCapture = {
  schema: 'shared-sheet-capture/v1'; spreadsheetId: string; layoutVersion: string;
  readTime: string; revision?: string; digest?: string;
  /** values includes the exact header and every row, including blank rows; trailing cells padded by capturer. */
  tabs: Array<{ title: string; readTime: string; complete: true; rowCount: number; values: SheetCell[][] }>;
};
export const SHARED_SHEET_SPEC_DIGEST = stableDigest(spec);
export const sharedSheetHeaders: readonly string[] = spec.inputHeaders;
export const sharedSheetChannels = spec.supplierChannels.sharedInputSheet;
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(v) && Number.isFinite(Date.parse(v));
export function sharedSheetCaptureDigest(capture: SharedSheetCapture) {
  const { digest: _, ...body } = capture;
  return stableDigest(body);
}
/** Local JSON only: no Sheet API, inferred company, prices or hidden-tab fallback. */
export function buildSharedSheetBatch(input: unknown): SourceIntakeBatch {
  const c = input as SharedSheetCapture;
  const fail = (): never => { throw new Error('INVALID_SHARED_SHEET_CAPTURE'); };
  if (!c || c.schema !== 'shared-sheet-capture/v1' || typeof c.spreadsheetId !== 'string' || !c.spreadsheetId.trim() ||
      c.layoutVersion !== spec.layoutVersion || !timestamp(c.readTime) || !Array.isArray(c.tabs) ||
      (!c.revision && !c.digest) || (c.revision !== undefined && (typeof c.revision !== 'string' || !c.revision.trim()))) fail();
  const digest = sharedSheetCaptureDigest(c);
  if (c.digest !== undefined && c.digest !== digest) fail();
  const titles = [...new Set(sharedSheetChannels.map(x => x.tab))];
  if (c.tabs.length !== titles.length || new Set(c.tabs.map(t => t.title)).size !== titles.length) fail();
  const sourceId = `shared-sheet:${stableDigest(c.spreadsheetId).slice(0, 24)}`;
  const records: SourceIntakeBatch['records'] = [];
  const identities = new Set<string>();
  for (const tab of c.tabs) {
    if (!titles.includes(tab.title) || !timestamp(tab.readTime) || Date.parse(tab.readTime) < Date.parse(c.readTime) ||
        Date.parse(tab.readTime) - Date.parse(c.readTime) > 30 * 60 * 1000 || tab.complete !== true ||
        !Array.isArray(tab.values) || !Number.isSafeInteger(tab.rowCount) || tab.rowCount !== tab.values.length ||
        stableDigest(tab.values[0]) !== stableDigest(sharedSheetHeaders)) fail();
    for (let index = 1; index < tab.values.length; index++) {
      const values = tab.values[index]!;
      if (!Array.isArray(values) || values.length !== 74 || values.some(v => v !== null &&
          typeof v !== 'string' && typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v)))) fail();
      if (values.every(v => v === '' || v === null)) continue;
      const company = String(values[0] ?? '').trim();
      const supplier = sharedSheetChannels.find(x => x.tab === tab.title && x.companyName === company);
      // Placeholders such as 「신차」 are not vehicle identities: keep RAW by position and let normalization HOLD the row.
      const plate = isAssignedPlate(values[4]) ? plateIdentityKey(values[4]) : '';
      const rowDigest = stableDigest(values);
      const sourceRecordId = supplier && plate ? stableDigest([supplier.code, plate]) : stableDigest([tab.title, index, rowDigest]);
      if (identities.has(sourceRecordId)) throw new Error('DUPLICATE_SHARED_SHEET_IDENTITY');
      identities.add(sourceRecordId);
      records.push({ sourceRecordId, sourceFingerprint: stableDigest({ rowDigest, supplierCode: supplier?.code ?? null }),
        payload: { values: structuredClone(values), tab: tab.title, row: index + 1, readTime: tab.readTime,
          spreadsheetId: c.spreadsheetId, revision: c.revision ?? null, captureDigest: digest, rowDigest,
          supplierCode: supplier?.code ?? null } });
    }
  }
  if (Math.min(...c.tabs.map(t => Date.parse(t.readTime))) !== Date.parse(c.readTime)) fail();
  return { laneId: 'PRODUCT_VEHICLE', source: { sourceId, kind: 'GOOGLE_SHEET', displayName: 'Shared supplier input',
      expectedFreshnessSeconds: 1800 }, observedAt: c.readTime, sourceRevision: c.revision ?? digest, checksum: digest,
    coverage: { mode: 'FULL', completeness: 'COMPLETE', scope: 'shared-input:15-tabs:18-codes' }, records };
}
