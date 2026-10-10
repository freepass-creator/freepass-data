import spec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };
import type { CatalogCandidate } from '../domain/catalog-candidate.js';
import type { CommercialType, PriceTerm } from '../domain/catalog.js';
import type { SourceVehicleFacts } from '../domain/source-vehicle-facts.js';
import type { RawRecord, NormalizedCandidateRecord } from '../domain/source.js';
import type { FieldLineageRecord } from '../domain/lineage.js';
import { plateIdentityKey, isAssignedPlate } from '../domain/vehicle-plate.js';
import { chooseVehicleIdentity, indexVehicleMaster, VEHICLE_IDENTITY_RULE_VERSION, type IdentityChoice, type VehicleIdentity, type VehicleMasterRecord } from '../domain/vehicle-identity-resolution.js';
import { stableDigest } from '../shared/stable-digest.js';
import { assessDepositEvidence, depositEvidenceInputFromProduct } from '../domain/deposit-evidence.js';
export const SHARED_SHEET_RULE_VERSION = 'shared-sheet-normalizer/4';
export type SharedSheetMasterEvidence = { records: VehicleMasterRecord[]; snapshotDigest: string; readAt: string };
/** AI 상황실 2026-10-04 (대표): every car is stored. The sheet status text is kept as-is; it only decides sale exposure.
 * assetStatus is the reviewed physical-state mapping; an unlisted status is HOLD, never guessed. */
/** Own-key lookup only: inherited names (constructor, __proto__) are never a registered status. */
export const sharedSheetStatusPolicy = (status: unknown) =>
  typeof status === 'string' && Object.hasOwn(SHARED_SHEET_STATUS_POLICY, status) ? SHARED_SHEET_STATUS_POLICY[status]! : null;
export const SHARED_SHEET_STATUS_POLICY: Record<string, { exposure: 'VISIBLE' | 'HIDDEN'; assetStatus: 'AVAILABLE' | 'RESERVED' | 'MAINTENANCE' }> = {
  '출고가능': { exposure: 'VISIBLE', assetStatus: 'AVAILABLE' },
  '즉시출고': { exposure: 'VISIBLE', assetStatus: 'AVAILABLE' },
  '출고협의': { exposure: 'HIDDEN', assetStatus: 'AVAILABLE' },
  '계약중': { exposure: 'HIDDEN', assetStatus: 'RESERVED' },
  '상품화중': { exposure: 'HIDDEN', assetStatus: 'MAINTENANCE' },
  '출고불가': { exposure: 'HIDDEN', assetStatus: 'RESERVED' },
};
const commercial: Record<string, CommercialType> = { '신차렌트': 'NEW_RENT', '중고렌트': 'USED_RENT', '신차구독': 'NEW_SUBSCRIPTION', '중고구독': 'USED_SUBSCRIPTION' };
const absentPrice = (s: string) => ['', '-', '불가'].includes(s);
function number(s: string, unit = '', decimal = false): number | null {
  const body = unit ? s.replace(new RegExp(`\\s*${unit}$`, 'i'), '') : s;
  // 소수 칸의 «0.###» 표시 형식은 정수를 «22.»처럼 끝에 점을 붙여 보인다(2026-10-04 서식 통일) — 같은 값으로 받는다.
  if (!(decimal ? /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?$/ : /^(?:\d+|\d{1,3}(?:,\d{3})+)$/).test(body)) return null;
  const n = Number(body.replaceAll(',', '').replace(/\.$/, ''));
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}
function year(s: string): number | null {
  const m = /^(\d{2}|20\d{2})(?:MY|년식)?$/i.exec(s);
  return m ? Number(m[1]) + (m[1]!.length === 2 ? 2000 : 0) : null;
}
function registration(s: string, raw: unknown): string | null {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + raw * 86400000);
    return Number.isFinite(d.getTime()) && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2099 ? d.toISOString().slice(0, 10) : null;
  }
  const m = /^(\d{2}|20\d{2})[.\-/](\d{1,2})(?:[.\-/](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]) + (m[1]!.length === 2 ? 2000 : 0), mo = Number(m[2]), d = m[3] ? Number(m[3]) : null;
  if (mo < 1 || mo > 12 || (d !== null && (d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()))) return null;
  return `${y}-${String(mo).padStart(2, '0')}${d === null ? '' : '-' + String(d).padStart(2, '0')}`;
}
/** Does not infer missing F03 cells from names or borrow another supplier's data. */
export type SharedSheetNormalized = { record: NormalizedCandidateRecord; lineage: FieldLineageRecord[]; suppliedTerms: number };
/** Vehicle identity policy for one row: sheet 4 cells, source text and dates in → DATA/SHEET/HOLD decision out. */
export type SharedSheetIdentityResolver = (row: { sheet: VehicleIdentity; plate: string; raw: string; firstRegistration: string; modelYear: string }) => IdentityChoice;
export const normalizeSharedSheet = (raw: RawRecord, master?: SharedSheetMasterEvidence): SharedSheetNormalized => normalizeSharedSheetWith(raw, undefined, master);
/** Names must resolve to the sealed active Data master. Missing or conflicting evidence remains HOLD. */
export const sharedSheetNormalizer = (identity?: SharedSheetIdentityResolver, master?: SharedSheetMasterEvidence) => (raw: RawRecord): SharedSheetNormalized => normalizeSharedSheetWith(raw, identity, master);
function normalizeSharedSheetWith(raw: RawRecord, identity?: SharedSheetIdentityResolver, master?: SharedSheetMasterEvidence): SharedSheetNormalized {
  const values = raw.payload.values as unknown[];
  const at = (header: string) => values[spec.inputHeaders.indexOf(header)];
  const text = (header: string) => String(at(header) ?? '').trim();
  const issues: string[] = [];
  const facts: SourceVehicleFacts = { ruleVersion: SHARED_SHEET_RULE_VERSION, fields: {}, reasons: [] };
  const field = (key: string, header: string, parse: (s: string) => string | number | null) => {
    const evidence = text(header), value = evidence ? parse(evidence) : null;
    const reasons = evidence && value === null ? [`INVALID_${key.toUpperCase()}`] : [];
    facts.fields[key] = { value, state: !evidence ? 'MISSING' : reasons.length ? 'REVIEW_REQUIRED' : 'KNOWN',
      evidence, ruleVersion: SHARED_SHEET_RULE_VERSION, reasons };
    issues.push(...reasons);
    return value;
  };
  const sheetIdentity = spec.vehicleMaster.refineOrder.map(h => text(h)) as unknown as VehicleIdentity;
  const row = { sheet: sheetIdentity, plate: plateIdentityKey(at('차량번호')), raw: text('차명 원문'),
    firstRegistration: text('최초등록일'), modelYear: text('연식') };
  const choice: IdentityChoice = typeof raw.payload.quarantine === 'string'
    ? { pick: 'HOLD', identity: null, dataIdentity: null, notes: ['SOURCE_QUARANTINED'] }
    : identity ? identity(row) : master ? chooseVehicleIdentity(indexVehicleMaster(master.records), { ...row, data: null })
    : { pick: 'HOLD', identity: null, dataIdentity: null, notes: ['VEHICLE_MASTER_SNAPSHOT_REQUIRED'] };
  if (choice) {
    // The sheet cells stay as evidence; the decision and the Data value are recorded beside them.
    facts.fields.vehicleIdentitySource = { value: choice.pick === 'HOLD' ? null : 'FREEPASS_DATA',
      state: choice.pick === 'HOLD' ? 'REVIEW_REQUIRED' : 'KNOWN',
      evidence: JSON.stringify({ sheet: sheetIdentity, data: choice.dataIdentity, notes: choice.notes, snapshotDigest: master?.snapshotDigest ?? null }),
      ruleVersion: VEHICLE_IDENTITY_RULE_VERSION, reasons: choice.pick === 'HOLD' ? ['VEHICLE_IDENTITY_DATA_CONFLICT'] : [] };
    if (choice.pick === 'HOLD') issues.push('VEHICLE_IDENTITY_DATA_CONFLICT', ...choice.notes);
  }
  let missing = false;
  for (const [i, h] of spec.vehicleMaster.refineOrder.entries()) {
    const key = ['maker', 'model', 'subModel', 'trimName'][i]!;
    const v = choice?.identity ? choice.identity[i]! : text(h);
    if (/확인\s*필요|미확인|미정/.test(v)) { missing = true; issues.push('VEHICLE_IDENTITY_REVIEW_REQUIRED'); }
    if (missing && v) issues.push('REFINEMENT_ORDER_VIOLATION');
    if (!v) missing = true;
    if (choice.pick === 'HOLD') {
      facts.fields[key] = { value: null, state: 'REVIEW_REQUIRED', evidence: text(h), ruleVersion: VEHICLE_IDENTITY_RULE_VERSION, reasons: choice.notes };
    } else if (choice.identity) facts.fields[key] = { value: missing ? null : v, state: missing ? 'MISSING' : 'KNOWN',
      evidence: text(h), ruleVersion: SHARED_SHEET_RULE_VERSION, reasons: [] };
    else field(key, h, s => missing ? null : s);
    if (!v) issues.push('VEHICLE_IDENTITY_INCOMPLETE');
  }
  const y = field('modelYear', '연식', year);
  const reg = field('firstRegistration', '최초등록일', s => registration(s, at('최초등록일')));
  if (typeof y === 'number' && typeof reg === 'string' && Number(reg.slice(0, 4)) !== y) issues.push('YEAR_REGISTRATION_MISMATCH');
  const fuelAliases: Record<string, string> = { HEV: '하이브리드', PHEV: '플러그인하이브리드', EV: '전기', 휘발유: '가솔린', 경유: '디젤' };
  field('fuel', '연료', s => spec.dropdowns['연료'].includes(s) ? s : fuelAliases[s.toUpperCase()] ?? null);
  field('displacementCc', '배기량', s => number(s, 'cc'));
  field('seats', '인승', s => { const n = number(s, '인승'); return n !== null && n > 0 && n <= 100 ? n : null; });
  field('drive', '구동방식', s => ['2WD', 'AWD', '4WD'].includes(s.toUpperCase()) ? s.toUpperCase() :
    ['FWD', 'RWD'].includes(s.toUpperCase()) ? '2WD' : ['4MATIC', '콰트로'].includes(s) ? 'AWD' : null);
  field('batteryKwh', '배터리용량', s => number(s, 'kWh', true));
  field('mileageKm', '주행거리', s => number(s, 'km'));
  // No transmission column: accept only an explicitly labelled supplier phrase, never infer from trim.
  facts.fields.transmission = { value: null, state: 'MISSING', evidence: '', ruleVersion: SHARED_SHEET_RULE_VERSION, reasons: [] };
  const transmissionMatches = [...text('옵션 원문').matchAll(/변속기\s*[:=]\s*(자동|수동|AT|MT|CVT|DCT)(?=$|[\s,;/])/gi)];
  if (transmissionMatches.length) {
    const options = [...new Set(transmissionMatches.map(m => m[1]!.toUpperCase()))];
    facts.fields.transmission = { value: options.length === 1 ? options[0]! : null,
      state: options.length === 1 ? 'KNOWN' : 'REVIEW_REQUIRED', evidence: transmissionMatches.map(m => m[0]).join('; '),
      ruleVersion: SHARED_SHEET_RULE_VERSION, reasons: options.length === 1 ? [] : ['TRANSMISSION_AMBIGUOUS'] };
    issues.push(...facts.fields.transmission.reasons);
  }
  const priceTerms: PriceTerm[] = [];
  let suppliedTerms = 0;
  for (const months of [1, 6, 12, 24, 36, 48, 60]) {
    const rentText = text(`${months}개월`);
    if (absentPrice(rentText)) continue;
    suppliedTerms++;
    const rent = number(rentText, '원');
    if (rent === null) { issues.push('RENT_REVIEW_REQUIRED'); continue; }
    const depositText = text(months <= 12 ? '단기보증' : '장기보증');
    const parsedDeposit = depositText === '무보증' ? 0 : number(depositText, '원');
    const evidence = assessDepositEvidence(depositEvidenceInputFromProduct({
      provider_company_code: raw.payload.supplierCode,
      product_type: text('상품구분'),
      deposit_note: depositText === '무보증' ? depositText : undefined,
      // 공통 시트 칸 글자 자체가 공급사 원문이다 — 정확히 '무보증' 일 때만 글자 근거로 인정(판정은 depositEvidenceInputFromProduct 한 곳).
      원문: { 전체: { [months <= 12 ? '단기보증' : '장기보증']: depositText } },
    }, parsedDeposit ?? depositText));
    const deposit = evidence.amount;
    if (evidence.state === 'UNKNOWN') issues.push(`DEPOSIT_REVIEW_REQUIRED:m${months}:${evidence.reason}`);
    priceTerms.push({ termKey: `m${months}`, termMonths: months, monthlyRent: { amount: rent, currency: 'KRW' },
      depositState: evidence.state,
      ...(deposit !== null ? { deposit: { amount: deposit, currency: 'KRW' as const } } : {}) });
  }
  if (!priceTerms.length) issues.push('NO_PRICE_TERMS');
  const supplier = raw.payload.supplierCode;
  if (typeof supplier !== 'string') issues.push('SUPPLIER_UNRESOLVED');
  const plate = plateIdentityKey(at('차량번호'));
  if (!plate) issues.push('PLATE_MISSING');
  else if (!isAssignedPlate(plate)) issues.push('PLATE_NOT_ASSIGNED');
  const type = commercial[text('상품구분')];
  if (!type) issues.push('COMMERCIAL_TYPE_UNRESOLVED');
  const quarantine = raw.payload.quarantine;
  if (typeof quarantine === 'string') issues.push(quarantine);
  field('supplierStatus', '차량상태', v => sharedSheetStatusPolicy(v) ? v : null);
  const candidate: CatalogCandidate = { sourceRecordId: raw.sourceRecordId, sourceFingerprint: raw.sourceFingerprint,
    firstObservedAt: raw.firstObservedAt ?? raw.observedAt,
    // null = first run unknown (older RAW history): never substitute the current run.
    ...(raw.firstRunId === undefined ? { firstRunId: raw.runId } : raw.firstRunId ? { firstRunId: raw.firstRunId } : {}),
    carNumber: plate, priceTerms, issues: [...new Set(issues)], vehicleFacts: facts,
    ...(typeof supplier === 'string' ? { providerCompanyCode: supplier } : {}), ...(type ? { commercialType: type } : {}) };
  for (const [key, fact] of Object.entries(facts.fields)) {
    const target = ({ maker: 'maker', model: 'model', subModel: 'subModel', trimName: 'trimName', fuel: 'fuelType', drive: 'driveType', seats: 'seats', mileageKm: 'mileageKm' } as Record<string, string>)[key];
    if (target && fact.value !== null) Object.assign(candidate, { [target]: fact.value });
  }
  facts.reasons = candidate.issues;
  const candidateId = `candidate_${stableDigest([raw.rawRecordId, SHARED_SHEET_RULE_VERSION]).slice(0, 40)}`;
  const record: NormalizedCandidateRecord = { candidateId, runId: raw.runId, sourceId: raw.sourceId,
    sourceRecordId: raw.sourceRecordId, sourceFingerprint: raw.sourceFingerprint,
    status: issues.length ? 'REJECTED' : 'VALID', candidate };
  const lineage: FieldLineageRecord[] = [];
  const add = (path: string, value: unknown, header: string) => lineage.push({
    lineageRecordId: `lin_${stableDigest([candidateId, path])}`, lineageId: candidateId, stage: 'RAW_TO_NORMALIZED',
    runId: raw.runId, sourceId: raw.sourceId, sourceRecordId: raw.sourceRecordId, sourceFingerprint: raw.sourceFingerprint,
    observedAt: raw.observedAt, source: { fieldPath: header === '*' ? 'values' : `values.${spec.inputHeaders.indexOf(header)}`, value: header === '*' ? structuredClone(values) : at(header) ?? null },
    normalized: { candidateId, fieldPath: path, value }, transformId: 'shared-sheet', transformVersion: SHARED_SHEET_RULE_VERSION });
  for (const [path, header] of Object.entries({ maker: '제조사', model: '모델', subModel: '세부모델', trimName: '세부트림', fuelType: '연료', driveType: '구동방식', seats: '인승', mileageKm: '주행거리', carNumber: '차량번호', providerCompanyCode: '회사명', commercialType: '상품구분', vehicleFacts: '*' })) {
    const value = candidate[path as keyof CatalogCandidate];
    if (value !== undefined) add(path, value, header);
  }
  for (const term of priceTerms) {
    const root = `priceTerms.${term.termKey}`, rentHeader = `${term.termMonths}개월`, depHeader = term.termMonths <= 12 ? '단기보증' : '장기보증';
    add(`${root}.termMonths`, term.termMonths, rentHeader);
    add(`${root}.monthlyRent.amount`, term.monthlyRent.amount, rentHeader);
    add(`${root}.depositState`, term.depositState, depHeader);
    if (term.deposit) add(`${root}.deposit.amount`, term.deposit.amount, depHeader);
  }
  return { record, lineage, suppliedTerms };
}
