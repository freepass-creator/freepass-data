import spec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };
import type { CatalogCandidate } from '../domain/catalog-candidate.js';
import type { CommercialType, PriceTerm } from '../domain/catalog.js';
import type { SourceVehicleFacts } from '../domain/source-vehicle-facts.js';
import type { RawRecord, NormalizedCandidateRecord } from '../domain/source.js';
import type { FieldLineageRecord } from '../domain/lineage.js';
import { stableDigest } from '../shared/stable-digest.js';
import { plateIdentityKey, isAssignedPlate } from '../domain/vehicle-plate.js';
import {
  chooseVehicleIdentity,
  indexVehicleMaster,
  VEHICLE_IDENTITY_RULE_VERSION,
  type IdentityChoice,
  type VehicleIdentity,
  type VehicleIdentitySpecs,
  type VehicleMasterRecord,
} from '../domain/vehicle-identity-resolution.js';
import {
  assessDepositEvidence,
  depositEvidenceInputFromProduct,
  normalizeErp5CompatibilityInteger,
} from '../domain/deposit-evidence.js';
import { classifySonokongRecord } from '../domain/consumer-output-contract.js';

export const SONOGONG_RULE_VERSION = 'sonogong-normalizer/1';
export type SonogongMasterEvidence = { records: VehicleMasterRecord[]; snapshotDigest: string; readAt: string };
export type SonogongNormalized = { record: NormalizedCandidateRecord; lineage: FieldLineageRecord[] };

const bucketForClassifier = (bucket: string) => bucket === 'LOW_TCAR' ? 'TCAR_EXTERNAL' : 'SON_NO_KONG';
const termMonths = [12, 24, 36, 48, 60] as const;
const allowedEstimateTypes = new Set(['SUBSCRIBE_RETURN', 'SUBSCRIBE_BUYOUT', 'RENT_RETURN', 'RENT_BUYOUT']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
const compact = (value: unknown) => text(value).replace(/\s+/g, '');
const int = (value: unknown) => normalizeErp5CompatibilityInteger(value);
/** 전기차 배기량 0·차량가격 0 은 «값 없음» 표시다 — 알려진 값도, 보류 사유도 아니다(내부 정합 대조에서 확인). */
/** 공통 시트와 같은 연료 허용 목록·별칭. «가솔린+전기» 는 하이브리드/플러그인을 뜻으로 가를 수 없어 추정하지 않는다(보류). */
const fuelAliases: Record<string, string> = { HEV: '하이브리드', PHEV: '플러그인하이브리드', EV: '전기', 휘발유: '가솔린', 경유: '디젤' };
const fuelName = (value: unknown): string | null => {
  const t = text(value);
  if (!t) return null;
  if ((spec.dropdowns['연료'] as string[]).includes(t)) return t;
  return fuelAliases[t.toUpperCase()] ?? (t === 'lpg' ? 'LPG' : null);
};
const zeroAsAbsent = (value: unknown) => value === 0 || value === '0' ? undefined : value;

export const sonogongNormalizer = (master?: SonogongMasterEvidence) => (raw: RawRecord): SonogongNormalized | null => {
  if (raw.sourceRecordId.startsWith('evidence:list:') || raw.payload.evidenceKind === 'LIST_PAGE') return null;
  const payload = raw.payload;
  const list = object(payload.list) ? payload.list : {};
  const detail = object(payload.detail) ? payload.detail : {};
  const bucket = text(payload.bucket);
  const issues: string[] = [];
  const facts: SourceVehicleFacts = { ruleVersion: SONOGONG_RULE_VERSION, fields: {}, reasons: [] };
  const fact = (key: string, value: unknown, evidence: unknown, state: 'KNOWN' | 'MISSING' | 'REVIEW_REQUIRED', reasons: string[] = []) => {
    const normalizedValue = value === null || value === undefined || typeof value === 'string' || typeof value === 'number'
      ? value ?? null : JSON.stringify(value);
    facts.fields[key] = { value: normalizedValue, state, evidence: evidence == null ? '' : typeof evidence === 'string' ? evidence : JSON.stringify(evidence), ruleVersion: SONOGONG_RULE_VERSION, reasons };
    issues.push(...reasons);
  };
  const parseFact = (key: string, evidence: unknown, parse: (value: unknown) => unknown, reason: string) => {
    const present = evidence !== undefined && evidence !== null && evidence !== '';
    const value = present ? parse(evidence) : null;
    fact(key, value, evidence, !present ? 'MISSING' : value === undefined || value === null ? 'REVIEW_REQUIRED' : 'KNOWN',
      present && (value === undefined || value === null) ? [reason] : []);
    return value;
  };

  const plate = plateIdentityKey(list.carNumber);
  if (!plate) issues.push('PLATE_MISSING');
  else if (!isAssignedPlate(plate)) issues.push('PLATE_NOT_ASSIGNED');
  const modelYear = parseFact('modelYear', list.carManufactureDate, value => {
    const m = text(value).match(/^(?:19|20)?(\d{2})/);
    if (!m) return null;
    const y = Number(m[0].length === 2 ? `20${m[0]}` : m[0]);
    return Number.isSafeInteger(y) ? y : null;
  }, 'INVALID_MODEL_YEAR');
  const firstRegistration = parseFact('firstRegistration', detail.firstRegistrationDate, value => {
    const rawValue = text(value);
    const m = rawValue.match(/^(\d{4})[-./]?(\d{2})[-./]?(\d{2})/);
    if (!m) return null;
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(`${iso}T00:00:00Z`);  // 2025-02-30 같은 없는 날짜는 거른다
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
  }, 'INVALID_FIRST_REGISTRATION');
  parseFact('fuel', list.carFuel, fuelName, 'FUEL_UNRESOLVED');
  parseFact('displacementCc', zeroAsAbsent(list.engineDisplacement), int, 'INVALID_DISPLACEMENT_CC');
  parseFact('mileageKm', list.mileage, int, 'INVALID_MILEAGE_KM');
  parseFact('vehiclePrice', zeroAsAbsent(detail.saleAmt), int, 'INVALID_VEHICLE_PRICE');
  fact('supplierStatus', {
    webVisibility: list.webVisibility ?? null,
    contractAvailable: list.contractAvailable ?? null,
    hasActiveContract: list.hasActiveContract ?? null,
  }, { webVisibility: list.webVisibility ?? null, contractAvailable: list.contractAvailable ?? null, hasActiveContract: list.hasActiveContract ?? null },
  'KNOWN');  // 원문 보존만 — 노출 판정은 별도 정책, 보류 사유로 삼지 않는다
  const images = Array.isArray(detail.images) ? detail.images.filter(object) : [];
  const imageUrls = images.map(image => ({ sortOrder: image.sortOrder ?? null, imageUrl: image.imageUrl ?? null }))
    .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0));
  fact('photoUrlPresence', { count: imageUrls.filter(x => typeof x.imageUrl === 'string' && x.imageUrl.trim()).length,
    hasUrls: imageUrls.some(x => typeof x.imageUrl === 'string' && x.imageUrl.trim()) }, { count: imageUrls.length }, 'KNOWN');
  fact('rawPolicyOptionReference', 'RAW_ONLY', { carDescriptionPresent: !!text(detail.carDescription), optionsPresent: Array.isArray(detail.options) && detail.options.length > 0 }, 'KNOWN');

  const specs: VehicleIdentitySpecs = {};
  if (facts.fields.fuel?.state === 'KNOWN' && typeof facts.fields.fuel.value === 'string') specs.fuel = facts.fields.fuel.value;
  if (facts.fields.displacementCc?.state === 'KNOWN' && typeof facts.fields.displacementCc.value === 'number') specs.displacementCc = facts.fields.displacementCc.value;
  if (typeof modelYear === 'number') specs.modelYear = modelYear;
  const sheetIdentity = [text(list.groupName4), text(list.groupName2), text(list.groupName1), ''] as VehicleIdentity;
  const rawName = text(list.carName);
  let choice: IdentityChoice = master ? chooseVehicleIdentity(indexVehicleMaster(master.records), {
    sheet: sheetIdentity, data: null, raw: rawName,
    firstRegistration: typeof firstRegistration === 'string' ? firstRegistration : '',
    modelYear: text(list.carManufactureDate), specs,
  }) : { pick: 'HOLD', identity: null, dataIdentity: null, notes: ['VEHICLE_MASTER_SNAPSHOT_REQUIRED'] };
  facts.fields.vehicleIdentitySource = { value: choice.pick === 'HOLD' ? null : 'FREEPASS_DATA',
    state: choice.pick === 'HOLD' ? 'REVIEW_REQUIRED' : 'KNOWN',
    evidence: JSON.stringify({ source: sheetIdentity, rawName, data: choice.dataIdentity, notes: choice.notes, snapshotDigest: master?.snapshotDigest ?? null }),
    ruleVersion: VEHICLE_IDENTITY_RULE_VERSION, reasons: choice.pick === 'HOLD' ? ['VEHICLE_IDENTITY_DATA_CONFLICT'] : [] };
  if (choice.pick === 'HOLD') issues.push('VEHICLE_IDENTITY_DATA_CONFLICT', ...choice.notes);
  for (const [index, key] of ['maker', 'model', 'subModel', 'trimName'].entries()) {
    const value = choice.pick === 'HOLD' ? null : choice.identity?.[index] ?? null;
    facts.fields[key] = { value, state: value ? 'KNOWN' : choice.pick === 'HOLD' ? 'REVIEW_REQUIRED' : 'MISSING',
      evidence: sheetIdentity[index] ?? '', ruleVersion: VEHICLE_IDENTITY_RULE_VERSION, reasons: choice.pick === 'HOLD' ? choice.notes : [] };
  }

  if (!['LOW_SONOKONG_DAILY', 'LOW_SONOKONG', 'LOW_TCAR'].includes(bucket)) issues.push('UNKNOWN_BUCKET');
  const classification = classifySonokongRecord({ bucket: bucketForClassifier(bucket), plateNumber: plate });
  let commercialType: CommercialType | undefined;
  if (classification.status === 'CLASSIFIED') {
    commercialType = classification.commercialType;
  } else issues.push(classification.reason);

  const priceTerms: PriceTerm[] = [];
  const estimates = Array.isArray(detail.estimates) ? detail.estimates.filter(object) : [];
  for (const estimate of estimates) {
    if (estimate.creditType !== 'LOW') continue;
    if (!allowedEstimateTypes.has(text(estimate.estimateType))) {
      issues.push('ESTIMATE_TYPE_UNSUPPORTED');
      continue;
    }
    for (const months of termMonths) {
      const rentRaw = estimate[`monthly${months}`];
      if (rentRaw === undefined || rentRaw === null || rentRaw === '') continue;
      const monthlyRent = int(rentRaw);
      if (monthlyRent === undefined) { issues.push(`MONTHLY_RENT_INVALID:m${months}`); continue; }
      const depositEvidence = assessDepositEvidence(depositEvidenceInputFromProduct({
        provider_company_code: 'RP012',
        product_type: commercialType === 'USED_RENT' ? '중고렌트' : '오공구독',
      }, estimate.securityDepositAmount, { termMonths: months, monthlyRent }));
      if (depositEvidence.state === 'UNKNOWN') issues.push(`DEPOSIT_REVIEW_REQUIRED:m${months}:${depositEvidence.reason}`);
      if (depositEvidence.state === 'UNKNOWN' && (estimate.securityDepositAmount === 0 || estimate.securityDepositAmount === '0'))
        issues.push('DEPOSIT_ZERO_WITHOUT_TEXT_EVIDENCE');
      // 반납형·인수형은 같은 기간이 함께 온다 — 키를 갈라야 계보 ID 가 겹치지 않는다(astra P1). 같은 키가 또 오면 덮지 않고 보류.
      const termKey = `m${months}${text(estimate.estimateType).endsWith('_BUYOUT') ? '_buyout' : ''}`;
      if (priceTerms.some(term => term.termKey === termKey)) { issues.push(`DUPLICATE_ESTIMATE_TERM:${termKey}`); continue; }
      priceTerms.push({ termKey, termMonths: months, monthlyRent: { amount: monthlyRent, currency: 'KRW' },
        depositState: depositEvidence.state, ...(depositEvidence.amount !== null ? { deposit: { amount: depositEvidence.amount, currency: 'KRW' as const } } : {}) });
    }
  }
  if (!priceTerms.length) issues.push('NO_PRICE_TERMS');
  // 차량가액(vehiclePrice)은 선택 사실 칸일 뿐 수수료 계산에 연결하지 않는다(손오공 수수료는 기간별 — 대표 10-12).
  facts.reasons = [...new Set(issues)];

  const candidate: CatalogCandidate = { sourceRecordId: raw.sourceRecordId, sourceFingerprint: raw.sourceFingerprint,
    firstObservedAt: raw.firstObservedAt ?? raw.observedAt, ...(raw.firstRunId === undefined ? { firstRunId: raw.runId } : raw.firstRunId ? { firstRunId: raw.firstRunId } : {}),
    ...(isAssignedPlate(plate) ? { carNumber: plate } : {}), priceTerms, providerCompanyCode: 'RP012',
    ...(commercialType ? { commercialType } : {}), vehicleFacts: facts, issues: facts.reasons };
  for (const [key, target] of Object.entries({ maker: 'maker', model: 'model', subModel: 'subModel', trimName: 'trimName', fuel: 'fuelType', mileageKm: 'mileageKm' })) {
    const value = facts.fields[key]?.value;
    if (value !== null && value !== undefined) Object.assign(candidate, { [target]: value });
  }
  const candidateId = `candidate_${stableDigest([raw.rawRecordId, SONOGONG_RULE_VERSION]).slice(0, 40)}`;
  const record: NormalizedCandidateRecord = { candidateId, runId: raw.runId, sourceId: raw.sourceId,
    sourceRecordId: raw.sourceRecordId, sourceFingerprint: raw.sourceFingerprint, status: facts.reasons.length ? 'REJECTED' : 'VALID', candidate };
  const lineage: FieldLineageRecord[] = [];
  const add = (path: string, value: unknown, fieldPath: string) => lineage.push({
    lineageRecordId: `lin_${stableDigest([candidateId, path])}`, lineageId: candidateId, stage: 'RAW_TO_NORMALIZED',
    runId: raw.runId, sourceId: raw.sourceId, sourceRecordId: raw.sourceRecordId, sourceFingerprint: raw.sourceFingerprint,
    observedAt: raw.observedAt, source: { fieldPath, value }, normalized: { candidateId, fieldPath: path, value },
    transformId: 'sonogong-api', transformVersion: SONOGONG_RULE_VERSION,
  });
  for (const key of ['carNumber', 'providerCompanyCode', 'commercialType', 'maker', 'model', 'subModel', 'trimName', 'fuelType', 'mileageKm', 'vehicleFacts'] as const) {
    const value = candidate[key];
    if (value !== undefined) add(key, value, key === 'vehicleFacts' ? 'payload' : 'payload.list/detail');
  }
  for (const term of priceTerms) {
    add(`priceTerms.${term.termKey}.monthlyRent.amount`, term.monthlyRent.amount, `detail.estimates[].monthly${term.termMonths}`);
    add(`priceTerms.${term.termKey}.depositState`, term.depositState, 'detail.estimates[].securityDepositAmount');
    if (term.deposit) add(`priceTerms.${term.termKey}.deposit.amount`, term.deposit.amount, 'detail.estimates[].securityDepositAmount');
  }
  return { record, lineage };
};
