import { buildSharedSheetBatch, sharedSheetCaptureDigest, sharedSheetHeaders, type SharedSheetCapture } from './shared-sheet-source.js';
import { normalizeSharedSheet, sharedSheetStatusPolicy } from './normalize-shared-sheet.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import type { RawRecord } from '../domain/source.js';
import type { SourceAmount, SourceEngine, SourceProductRecord, SourceRead, SourceRowHold } from '../domain/source-engine.js';
import { classifyReadError, sourceProductKey, validateSourceRecord } from '../domain/source-engine.js';
import { stableDigest } from '../shared/stable-digest.js';

/** Capture transport is injected from capture-shared-sheet; no second Sheets client.
 * UID is an actual captured cell. No position/plate-based fallback, no UID sheet writes.
 * An extra UID header may occur anywhere; legacy captures remain readable but UID-HOLD.
 */
export function sharedSheetEngine(readCapture: () => Promise<SharedSheetCapture>, now = () => new Date().toISOString()): SourceEngine<SharedSheetCapture> {
  return {
    async read() {
      const attemptedAt = now();
      try {
        const raw = await readCapture();
        // Schema errors must not mark a failed whole-source read complete.
        legacyCapture(raw);
        return { raw, attemptedAt, observedAt: raw.readTime, complete: true, error: null };
      } catch (e) {
        const message = e instanceof Error ? e.message : '';
        const classified = classifyReadError(e);
        const error = /429/.test(message) ? 'RATE_LIMITED' : /401|403|AUTH/.test(message) ? 'AUTH_FAILED' :
          /CAPTURE|SCHEMA/.test(message) ? 'SCHEMA_INVALID' : 'READ_FAILED';
        return { raw: null, attemptedAt, observedAt: null, complete: false, error,
          ...(error === 'READ_FAILED' && classified.detail ? { detail: classified.detail } : {}) };
      }
    },
    toRecords: sharedSheetRecords,
  };
}
export function legacyCapture(capture: SharedSheetCapture) {
  if (capture.digest && sharedSheetCaptureDigest(capture) !== capture.digest) throw new Error('INVALID_SHARED_SHEET_CAPTURE');
  const legacy = structuredClone(capture);
  for (const tab of legacy.tabs) {
    const header = tab.values[0]!;
    const indexes = header.flatMap((v, i) => v === 'UID' ? [i] : []);
    if (indexes.length > 1) throw new Error('INVALID_SHARED_SHEET_CAPTURE');
    if (indexes.length) tab.values = tab.values.map(row => row.filter((_, i) => i !== indexes[0]));
  }
  legacy.digest = sharedSheetCaptureDigest(legacy);
  return { legacy, batch: buildSharedSheetBatch(legacy) };
}
export function sharedSheetRecords(read: SourceRead<SharedSheetCapture>) {
  const held: SourceRowHold[] = [], records: SourceProductRecord[] = [];
  if (!read.raw) return { records, held };
  const capture = read.raw;
  const { batch } = legacyCapture(capture);
  for (const [i, item] of batch.records.entries()) {
    const p = item.payload, row = Number(p.row);
    const tab = capture.tabs.find(t => t.title === p.tab)!;
    const uidColumn = tab.values[0]!.indexOf('UID');
    const uidCell = uidColumn < 0 ? null : tab.values[row - 1]?.[uidColumn];
    if (typeof uidCell !== 'string' || !uidCell.trim()) { held.push({ row, reasons: ['UID_REQUIRED'] }); continue; }
    if (typeof p.supplierCode !== 'string' || p.quarantine === 'ROW_SHAPE_INVALID') {
      held.push({ row, reasons: ['ROW_IDENTITY_OR_SHAPE_INVALID'] }); continue;
    }
    const raw: RawRecord = { rawRecordId: `offline:${i}`, runId: 'offline', sourceId: batch.source.sourceId,
      sourceRecordId: item.sourceRecordId, sourceFingerprint: stableDigest(p), observedAt: String(p.readTime), payload: p };
    // Reuse the existing term/deposit and master-HOLD rules; do not borrow legacy supplements.
    const normalized = normalizeSharedSheet(raw);
    const cells = p.values as unknown[];
    const cell = (h: string) => cells[sharedSheetHeaders.indexOf(h)] ?? null;
    const text = (h: string) => String(cell(h) ?? '').trim();
    const amount = (state: string, value: number | undefined): SourceAmount => state === 'ZERO' && value === 0 ? { state: 'ZERO', value: 0 } :
      state === 'KNOWN' && value !== undefined && value > 0 ? { state: 'KNOWN', value } : { state: 'UNKNOWN', value: null };
    const r: SourceProductRecord = { sourceId: p.supplierCode, uid: uidCell.trim(),
      plate: isAssignedPlate(cell('차량번호')) ? plateIdentityKey(cell('차량번호')) : null,
      vehicleText: text('차명 원문'), status: { raw: text('차량상태'), saleAvailable: sharedSheetStatusPolicy(text('차량상태'))?.exposure === 'VISIBLE'
        ? true : sharedSheetStatusPolicy(text('차량상태')) ? false : null },
      terms: normalized.record.candidate.priceTerms.map(t => ({ months: t.termMonths,
        monthlyRent: amount(t.monthlyRent.amount === 0 ? 'ZERO' : 'KNOWN', t.monthlyRent.amount), deposit: amount(t.depositState, t.deposit?.amount),
        mileage: text('연주행') || null, raw: { rent: cell(`${t.termMonths}개월`), shortDeposit: cell('단기보증'), longDeposit: cell('장기보증'), mileage: cell('연주행') } })),
      observedAt: String(p.readTime), raw: { cells: structuredClone(tab.values[row - 1]), headers: [...tab.values[0]!] },
      vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] };
    // An invalid supplied period must not disappear from an otherwise apparently valid bundle.
    if (normalized.suppliedTerms !== r.terms.length) r.terms.push({ months: 0, monthlyRent: { state: 'UNKNOWN', value: null },
      deposit: { state: 'UNKNOWN', value: null }, mileage: null, raw: {} });
    records.push(r);
    const reasons = validateSourceRecord(r);
    if (p.quarantine === 'DUPLICATE_IDENTITY' || p.quarantine === 'PLATE_ON_MULTIPLE_SUPPLIERS') reasons.push('DUPLICATE_PLATE_SUSPECT');
    if (reasons.length) held.push({ row, reasons });
  }
  const counts = new Map<string, number>();
  for (const r of records) counts.set(sourceProductKey(r), (counts.get(sourceProductKey(r)) ?? 0) + 1);
  return { records: records.filter(r => {
    if (counts.get(sourceProductKey(r)) === 1) return true;
    held.push({ row: 0, reasons: ['DUPLICATE_UID'] }); return false;
  }), held };
}
