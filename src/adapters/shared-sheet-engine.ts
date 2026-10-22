import { buildSharedSheetBatch, sharedSheetCaptureDigest, sharedSheetHeaders, type SharedSheetCapture } from './shared-sheet-source.js';
import { normalizeSharedSheet, sharedSheetStatusPolicy } from './normalize-shared-sheet.js';
import { isAssignedPlate, plateIdentityKey } from '../domain/vehicle-plate.js';
import type { RawRecord } from '../domain/source.js';
import type { SourceAmount, SourceEngine, SourceProductRecord, SourceRead, SourceRowHold } from '../domain/source-engine.js';
import { classifyReadError, sourceProductKey, validateSourceRecord } from '../domain/source-engine.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { VehicleIdentityRefiner } from '../ports/source-cycle.js';
import { SPEC_FORMAT_RULES } from '../domain/source-spec-validation.js';
import { canonicalFuel } from '../domain/fuel-alias.js';
import type { SourceVehicleFacts } from '../domain/source-vehicle-facts.js';
import { sheetPhotoLinksOf } from '../domain/sheet-photo-link.js';
import { sheetIdentityOf } from '../domain/sheet-identity.js';
import { sheetFactsOf } from '../domain/sheet-facts.js';

/** 시트 제원 전달 옵션(기본 꺼짐): sheetSpec=true 인 공급사만 정규화기가 이미 읽은 차 한 대 사실을 raw.spec 으로 넘긴다(켜기는 운영 env). */
export type SharedSheetSpecOptions = { sheetSpec?: boolean };
const SHEET_COLOR_UNRESOLVED = /^(?:-|모름|미정|미확인|확인\s*필요|협의)$/;
const ELECTRIC_FUELS: ReadonlySet<string> = new Set(['전기', '수소']);
/** 정규화기가 KNOWN 으로 읽은 연료·주행거리·인승·배기량·최초등록일과 외장·내장 색상 원문을 기존 제원 키로 낸다.
 * 연식은 여기서 만들지 않는다(기존 연식 게이트만). 형식 규칙(SPEC_FORMAT_RULES)·연료 별칭(canonicalFuel)을 통과한 값만, 전기·수소는 배기량 제외,
 * 연식·최초등록 모순 행은 최초등록일을 넘기지 않는다. 빈 칸에만 쓰는 것은 기존 쓰기 경로(sourceSpecFillFields·sourceSpecRefillFields)가 맡는다. */
export function sharedSheetSpecFacts(facts: SourceVehicleFacts['fields'] | undefined, issues: readonly string[],
  text: (header: string) => string, vehicleText: string): Record<string, string> {
  const out: Record<string, string> = {};
  const known = (key: string) => facts?.[key]?.state === 'KNOWN' ? facts[key]!.value : null;
  const put = (key: string, value: string | null) => { if (value && SPEC_FORMAT_RULES[key]?.(value)) out[key] = value; };
  const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  // 정규화기가 연료를 KNOWN 으로 읽지 못해도(예: FCEV·전기차 같은 공통 별칭표의 표기) 시트 연료 칸 원문을 공통 별칭표(canonicalFuel)로 한 번 더 판정한다 — 아이카 경로와 같은 결과.
  const fuel = known('fuel');
  const fuelText = typeof fuel === 'string' ? fuel : (text('연료') || null);
  put('fuel_type', fuelText ? canonicalFuel(fuelText, vehicleText) : null);
  put('mileage', integer(known('mileageKm')));
  put('seats', integer(known('seats')));
  if (!ELECTRIC_FUELS.has(out.fuel_type ?? '')) put('engine_cc', integer(known('displacementCc')));
  const registration = known('firstRegistration');
  if (!issues.includes('YEAR_REGISTRATION_MISMATCH')) put('first_registration_date', typeof registration === 'string' ? registration : null);
  for (const [key, header] of [['ext_color', '외부색상'], ['int_color', '내부색상']] as const) {
    const value = text(header);
    if (!SHEET_COLOR_UNRESOLVED.test(value)) put(key, value);
  }
  return out;
}

/** 수집본의 차량번호 칸 링크 → «탭|행» 별 표준 드라이브 폴더 링크(domain/sheet-photo-link 규칙: 폴더만·한 칸 한 링크·같은 폴더가 다른 번호에 붙으면 거절).
 * 번호는 수집본 그 행의 차량번호 칸에서 읽는다(행 번호 = 시트 행, 머리글 = 1). */
export function sharedSheetPhotoLinks(capture: SharedSheetCapture) {
  const plateColumn = sharedSheetHeaders.indexOf('차량번호');
  const entries = Array.isArray(capture.plateLinks) ? capture.plateLinks.filter(x => !!x && typeof x.tab === 'string'
    && Number.isSafeInteger(x.row) && x.row >= 2 && Array.isArray(x.links)) : [];
  return sheetPhotoLinksOf(entries, (tab, row) => capture.tabs.find(t => t.title === tab)?.values[row - 1]?.[plateColumn]);
}

/** Capture transport is injected from capture-shared-sheet; no second Sheets client.
 * UID is an actual captured cell. No position/plate-based fallback, no UID sheet writes.
 * An extra UID header may occur anywhere; legacy captures remain readable but UID-HOLD.
 */
export function sharedSheetEngine(readCapture: () => Promise<SharedSheetCapture>, now = () => new Date().toISOString(),
  sourceYearMaster?: Pick<VehicleIdentityRefiner, 'digest' | 'match' | 'allowsYear' | 'sourceYearEvidence' | 'sourceYearUids'>,
  options?: SharedSheetSpecOptions): SourceEngine<SharedSheetCapture> {
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
    toRecords: read => sharedSheetRecords(read, sourceYearMaster, options),
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
export function sharedSheetRecords(read: SourceRead<SharedSheetCapture>, sourceYearMaster?: Pick<VehicleIdentityRefiner, 'digest' | 'match' | 'allowsYear' | 'sourceYearEvidence' | 'sourceYearUids'>,
  options?: SharedSheetSpecOptions) {
  const held: SourceRowHold[] = [], records: SourceProductRecord[] = [];
  if (!read.raw) return { records, held };
  const capture = read.raw;
  const { batch } = legacyCapture(capture);
  const photoLinks = sharedSheetPhotoLinks(capture).links;
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
    const normalized = normalizeSharedSheet(raw, sourceYearMaster?.sourceYearEvidence, { sourceEngineRentRules: true });
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
        // 월 대여료는 KNOWN(타당 범위 안 양수)만 들어온다 — 0 은 정규화에서 «가격 없음» 으로 빠진다(0원 가격 노출 금지).
        monthlyRent: amount('KNOWN', t.monthlyRent.amount), deposit: amount(t.depositState, t.deposit?.amount),
        mileage: text('연주행') || null, raw: { rent: cell(`${t.termMonths}개월`), shortDeposit: cell('단기보증'), longDeposit: cell('장기보증'), mileage: cell('연주행') } })),
      observedAt: String(p.readTime), raw: { cells: structuredClone(tab.values[row - 1]), headers: [...tab.values[0]!],
        ...(normalized.zeroRentTerms ? { rent_zero_terms: normalized.zeroRentTerms } : {}) },
      vehicleHold: ['VEHICLE_MASTER_REVIEW_REQUIRED'] };
    // 시트 제원(연식 제외): 켠 공급사만. 연식은 아래 기존 게이트를 통과할 때만 더한다.
    const sheetSpec = options?.sheetSpec === true ? sharedSheetSpecFacts(normalized.record.candidate.vehicleFacts?.fields,
      normalized.record.candidate.issues, text, r.vehicleText) : {};
    if (Object.keys(sheetSpec).length) r.raw.spec = sheetSpec;
    // 차량번호 칸 사진 폴더 링크(검증된 표준 폴더 링크만). 문서 photo_link 쓰기는 빈 칸에만(infra 쓰기 경로).
    const photoLink = photoLinks.get(`${p.tab}|${row}`);
    if (photoLink) r.raw.sheet_photo_link = photoLink;
    // 시트의 차종 4칸 후보(마스터 행과 정확히 일치할 때만 정제기가 쓴다).
    const sheetIdentity = sheetIdentityOf(tab.values[0], tab.values[row - 1]);
    if (sheetIdentity) r.raw.sheet_identity = sheetIdentity;
    const sheetFacts = sheetFactsOf(tab.values[0], tab.values[row - 1]);   // 구동방식·원산지 후보(검증 통과한 칸만, 원문 raw.cells 는 그대로)
    if (sheetFacts) r.raw.sheet_facts = sheetFacts;
    // Preserve the supplied year through the existing spec writer only after the active master
    // admits that exact source name/year. Names and publication HOLD remain independent.
    // Inconsistent registration/year and unsupported years remain RAW only; never infer a year.
    const sourceYear = normalized.record.candidate.vehicleFacts?.fields.modelYear;
    if (sourceYearMaster?.digest && (!sourceYearMaster.sourceYearUids || sourceYearMaster.sourceYearUids.has(r.uid))
        && sourceYear?.state === 'KNOWN' && typeof sourceYear.value === 'number' &&
        !normalized.record.candidate.issues.includes('YEAR_REGISTRATION_MISMATCH')) {
      const facts = normalized.record.candidate.vehicleFacts?.fields;
      const evidence = sourceYearMaster.sourceYearEvidence;
      const names = ['maker', 'model', 'subModel', 'trimName'].map(key => facts?.[key]);
      // Reuse the existing structured normalizer's accepted identity. The raw-name matcher is a different
      // conservative path and can reject an identity already verified from the four sheet names/specs.
      // A structured HOLD never falls back to that matcher. Product names/HOLD themselves remain unchanged.
      const ids = evidence && facts?.vehicleIdentitySource?.state === 'KNOWN' && names.every(f => f?.state === 'KNOWN')
        ? new Set(evidence.records.filter(record => record.names.every((name, index) => name === names[index]!.value)).map(record => record.masterId)) : new Set<string>();
      const matched = evidence ? ids.size === 1 ? { master_id: [...ids][0]! } : null
        : sourceYearMaster.match({ rawName: r.vehicleText, year: String(sourceYear.value) });
      if (matched && sourceYearMaster.allowsYear?.(matched.master_id, sourceYear.value) === true) {
        r.raw.spec = { ...sheetSpec, year: String(sourceYear.value) };
        r.raw.spec_master_digest = evidence?.snapshotDigest ?? sourceYearMaster.digest;
        r.raw.spec_master_id = matched.master_id;
      }
    }
    // An invalid supplied period must not disappear from an otherwise apparently valid bundle.
    if (normalized.suppliedTerms !== r.terms.length) r.terms.push({ months: 0, monthlyRent: { state: 'UNKNOWN', value: null },
      deposit: { state: 'UNKNOWN', value: null }, mileage: null, raw: {} });
    records.push(r);
    const reasons = validateSourceRecord(r);
    if (p.quarantine === 'DUPLICATE_IDENTITY' || p.quarantine === 'PLATE_ON_MULTIPLE_SUPPLIERS') reasons.push('DUPLICATE_PLATE_SUSPECT');
    // 대여료 해석 불가·타당 범위 밖은 그 사유를 보류 사유로 드러낸다(TERMS_HOLD 만으로는 «가격 없음» 과 구분되지 않는다).
    if (normalized.record.candidate.issues.includes('RENT_REVIEW_REQUIRED')) reasons.push('RENT_REVIEW_REQUIRED');
    if (reasons.length) held.push({ row, reasons });
  }
  const counts = new Map<string, number>();
  for (const r of records) counts.set(sourceProductKey(r), (counts.get(sourceProductKey(r)) ?? 0) + 1);
  return { records: records.filter(r => {
    if (counts.get(sourceProductKey(r)) === 1) return true;
    held.push({ row: 0, reasons: ['DUPLICATE_UID'] }); return false;
  }), held };
}
