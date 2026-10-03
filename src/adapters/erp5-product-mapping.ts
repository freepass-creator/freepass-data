import type { CatalogCandidate } from '../domain/catalog-candidate.js';
import type { CommercialType } from '../domain/catalog.js';
import { stableDigest } from '../shared/stable-digest.js';
import { assessDepositEvidence, hasConflictingPaidDeposit } from '../domain/deposit-evidence.js';
import { resolveErp5InventoryStatus } from '../domain/erp5-inventory-status.js';
import { isStrictKoreanPlate } from '../domain/vehicle-plate.js';

export const ERP5_PRODUCT_MAPPER_VERSION = 'erp5-product-mapping/5';

/**
 * 정책이 회사의 기본을 확정한다 — 상품에 안 적힌 값은 여기서 읽는다.
 * 정책이 전혀 없을 때만 회사 공통 기본값으로 떨어진다.
 */
export const ERP5_DEFAULT_ANNUAL_MILEAGE_KM = 30000;
export const ERP5_DEFAULT_BASIC_DRIVER_AGE = 26;

export type Erp5PolicyFacts = {
  policyCode?: string;
  companyId?: string;
  annualMileageKm?: number;
  basicDriverAge?: number;
};

/** 같은 캡처에서 읽은 정책 사실. 상품 한 건을 매핑할 때 곁에 둔다. */
export type Erp5MappingContext = { policies?: Erp5PolicyFacts[] };

export type Erp5MileageResolution = {
  km: number;
  /** 어디서 온 값인지 — 기본값으로 떨어진 것을 "원천이 그렇다"로 읽으면 안 된다. */
  source: 'PRICE_KEY' | 'POLICY_CODE' | 'COMPANY_SOLE_POLICY' | 'DEFAULT';
};

/**
 * 주행거리 사슬. 가격 키에 적혀 있으면 그것이 우선이고(오토플러스 방식),
 * 없으면 그 차의 정책이, 정책 코드가 없으면 회사 정책이 하나뿐일 때 그것이,
 * 그마저 없으면 회사 공통 기본값이 답이다.
 */
export function resolveErp5Mileage(
  explicitKm: number | undefined,
  policyCode: string | undefined,
  companyId: string | undefined,
  policies: Erp5PolicyFacts[] = []
): Erp5MileageResolution {
  if (explicitKm !== undefined) return { km: explicitKm, source: 'PRICE_KEY' };
  if (policyCode) {
    // 코드만 맞아서는 안 된다 — 그 회사의 차가 그 회사의 정책을 따라야 한다.
    const matched = policies.find(p => p.policyCode === policyCode
      && (!companyId || !p.companyId || p.companyId === companyId));
    if (matched?.annualMileageKm !== undefined) return { km: matched.annualMileageKm, source: 'POLICY_CODE' };
  }
  if (companyId) {
    const mine = policies.filter(p => p.companyId === companyId && p.annualMileageKm !== undefined);
    if (mine.length === 1) return { km: mine[0]!.annualMileageKm!, source: 'COMPANY_SOLE_POLICY' };
  }
  return { km: ERP5_DEFAULT_ANNUAL_MILEAGE_KM, source: 'DEFAULT' };
}

/**
 * 가격 키를 읽는다. `36` · `36_2만` · `36_인수형` 세 꼴이 있다.
 * 인수형은 그것을 운영하는 회사의 «별도 상품»이므로 기간 축과 섞지 않고 따로 표시한다.
 */
export function parseErp5PriceKey(key: string):
  { months: number; mileageKm?: number; settlement: 'RETURN' | 'BUYOUT' } | undefined {
  const buyout = /^([1-9]\d*)_인수형$/.exec(key);
  if (buyout) return { months: Number(buyout[1]), settlement: 'BUYOUT' };
  const parsed = /^([1-9]\d*)(?:_([1-9]\d*)만)?$/.exec(key);
  if (!parsed) return undefined;
  const months = Number(parsed[1]);
  if (!Number.isSafeInteger(months) || months <= 0) return undefined;
  if (!parsed[2]) return { months, settlement: 'RETURN' };
  const km = Number(parsed[2]) * 10000;
  return Number.isSafeInteger(km) ? { months, mileageKm: km, settlement: 'RETURN' } : undefined;
}
export const ERP5_PRODUCT_SOURCE = 'freepasserp5/firestore/products';
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
export type Erp5ProductInput = {
  projectId: 'freepasserp5'; collection: 'products'; documentId: string;
  sourceRevision: string; observedAt: string; data: ObjectValue;
};
type MappedCommercialType = CommercialType | 'OPLUS_SUBSCRIPTION';
export type Erp5ProductMapping = {
  status: 'MAPPED_FOR_REVIEW' | 'HOLD';
  canonicalWriteAuthorized: false;
  mapperVersion: typeof ERP5_PRODUCT_MAPPER_VERSION;
  sourceId: typeof ERP5_PRODUCT_SOURCE;
  raw: Erp5ProductInput;
  candidate: Omit<CatalogCandidate, 'commercialType'> & { commercialType?: MappedCommercialType };
  inventory: { vehicleStatusRaw: Json; statusRaw: Json; statusKindRaw: Json; listableRaw: Json };
  fieldSources: Record<string, string[]>;
};

const object = (x: unknown): x is ObjectValue => !!x && typeof x === 'object'
  && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x === x.trim();
function jsonValue(x: unknown): x is Json {
  if (x === null || typeof x === 'string' || typeof x === 'boolean') return true;
  if (typeof x === 'number') return Number.isFinite(x);
  if (Array.isArray(x)) return x.every(jsonValue);
  return object(x) && Object.values(x).every(jsonValue);
}
const pointer = (parts: string[]) => '/' + parts.map(p => p.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
/** Only explicit integer KRW/count values. No unit stripping, rounding, or unknown-to-zero. */
function integer(x: unknown): number | undefined {
  if (typeof x === 'number') return Number.isSafeInteger(x) && x >= 0 ? x : undefined;
  if (typeof x !== 'string' || !/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(x)) return undefined;
  const n = Number(x.replaceAll(',', ''));
  return Number.isSafeInteger(n) ? n : undefined;
}
const types: Record<string, MappedCommercialType> = {
  '신차렌트': 'NEW_RENT', '중고렌트': 'USED_RENT', '재렌트': 'USED_RENT',
  '신차구독': 'NEW_SUBSCRIPTION', '중고구독': 'USED_SUBSCRIPTION', '재구독': 'USED_SUBSCRIPTION',
  '오공구독': 'OGONG_SUBSCRIPTION', '픽업구독': 'PICKUP_SUBSCRIPTION', '오플구독': 'OPLUS_SUBSCRIPTION'
};
const has = (x: ObjectValue, k: string) => Object.hasOwn(x, k);
const present = (x: Json | undefined) => x !== undefined && x !== null && x !== '';

/** Pure private preparation. Throws on invalid source envelope; never imports Firebase/runtime. */
export function mapErp5Product(input: unknown, context: Erp5MappingContext = {}): Erp5ProductMapping {
  const policies = context.policies ?? [];
  if (!object(input) || !jsonValue(input) || input.projectId !== 'freepasserp5'
    || input.collection !== 'products' || !text(input.documentId) || input.documentId.includes('/')
    || !text(input.sourceRevision) || !text(input.observedAt)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.observedAt)
    || !Number.isFinite(Date.parse(input.observedAt))
    || new Date(input.observedAt).toISOString() !== input.observedAt || !object(input.data)) {
    throw new Error('INVALID_ERP5_PRODUCT_ENVELOPE');
  }
  const raw = structuredClone(input) as unknown as Erp5ProductInput;
  const d = raw.data;
  const issues: string[] = [];
  const fieldSources: Record<string, string[]> = {};
  const issue = (code: string) => { if (!issues.includes(code)) issues.push(code); };
  const candidate: Erp5ProductMapping['candidate'] = {
    sourceRecordId: raw.documentId,
    sourceFingerprint: stableDigest(d),
    priceTerms: [], issues
  };
  fieldSources.sourceRecordId = ['/documentId'];
  const strings = {
    productCode: 'product_code', carNumber: 'car_number', maker: 'maker', model: 'model',
    subModel: 'sub_model', trimName: 'trim_name', providerCompanyCode: 'provider_company_code',
    policyCode: 'policy_code', vehicleStatusRaw: 'vehicle_status', year: 'year',
    fuelType: 'fuel_type', driveType: 'drive_type', origin: 'origin'
  } as const;
  for (const [target, source] of Object.entries(strings)) {
    if (text(d[source])) {
      Object.assign(candidate, { [target]: d[source] });
      fieldSources[target] = [pointer(['data', source])];
    } else if (has(d, source)) issue(`INVALID_TEXT:${source}`);
  }
  for (const required of ['carNumber', 'maker', 'model', 'providerCompanyCode', 'vehicleStatusRaw'] as const) {
    if (!candidate[required]) issue(`MISSING_REQUIRED:${required}`);
  }
  const validPlate = isStrictKoreanPlate(candidate.carNumber ?? '');
  if (!validPlate) issue('INVALID_PLATE');
  const supplier = candidate.providerCompanyCode;
  if (supplier && ['RP012', 'SONOGONG'].includes(supplier.toUpperCase()) && supplier !== 'RP012') {
    issue('SUPPLIER_ALIAS_REVIEW_REQUIRED');
  }
  if (present(d.partner_code) && d.partner_code !== d.provider_company_code) issue('SUPPLIER_ALIAS_REVIEW_REQUIRED');
  if (has(d, '_key') && d._key !== raw.documentId) issue('DOCUMENT_ID_CONFLICT');
  for (const [target, source] of [['mileageKm', 'mileage'], ['seats', 'seats']] as const) {
    if (!has(d, source)) continue;
    const value = integer(d[source]);
    if (value === undefined || (target === 'seats' && value === 0)) issue(`INVALID_INTEGER:${source}`);
    else { candidate[target] = value; fieldSources[target] = [pointer(['data', source])]; }
  }
  const commercialType = text(d.product_type) && Object.hasOwn(types, d.product_type) ? types[d.product_type] : undefined;
  if (commercialType) { candidate.commercialType = commercialType; fieldSources.commercialType = ['/data/product_type']; }
  else issue('UNKNOWN_PRODUCT_TYPE');
  if (['OGONG_SUBSCRIPTION', 'OPLUS_SUBSCRIPTION'].includes(commercialType ?? '')) {
    issue('CATALOG_COMMERCIAL_TYPE_EXTENSION_REQUIRED');
  }
  if (['OGONG_SUBSCRIPTION', 'PICKUP_SUBSCRIPTION'].includes(commercialType ?? '') && supplier !== 'RP012') {
    issue('SUBSCRIPTION_SUPPLIER_REVIEW_REQUIRED');
  }
  if (commercialType === 'OPLUS_SUBSCRIPTION' && supplier !== 'RP023') issue('SUBSCRIPTION_SUPPLIER_REVIEW_REQUIRED');
  // 상품 구분은 차량마다 `product_type`에 붙어 있다(2026-09-27 확인). 예전에는 `source_bucket`으로
  // 교차검증했으나 그 필드는 현재 원천 1,659건 어디에도 없다 — 없는 증거를 기다리면 전부 멈춘다.
  // 버킷이 «있을 때»만 교차검증하고, 없으면 product_type을 그대로 믿는다.
  if (d.provider_company_code === 'RP012' && present(d.source_bucket)) {
    const plate = candidate.carNumber ?? '';
    const rentalPlate = /[하허호]\d{4}$/.test(plate);
    const expected = d.source_bucket === 'TCAR_EXTERNAL' ? 'PICKUP_SUBSCRIPTION'
      : d.source_bucket === 'SON_NO_KONG' && validPlate ? (rentalPlate ? 'USED_RENT' : 'OGONG_SUBSCRIPTION') : null;
    if (!validPlate || !expected) issue('SONOGONG_CLASSIFICATION_EVIDENCE_MISSING');
    else if (commercialType !== expected) issue('SONOGONG_CLASSIFICATION_CONFLICT');
  }
  const inventory = resolveErp5InventoryStatus(candidate.vehicleStatusRaw);
  if (!inventory.known) issue('UNREVIEWED_VEHICLE_STATUS');
  else {
    if (d.listable !== inventory.listable) issue('INVENTORY_LISTABLE_CONFLICT');
    if (d.status_kind !== inventory.statusKind) issue('INVENTORY_STATUS_KIND_CONFLICT');
  }
  if (typeof d.listable !== 'boolean') issue('UNKNOWN_LISTABLE');
  if (present(d._deleted) && d._deleted !== false && d._deleted !== 0) issue('DELETION_MARKER_REVIEW_REQUIRED');
  if (present(d.deletedAt) || (typeof d.status === 'string' && d.status.trim().toLowerCase() === 'deleted')) {
    issue('DELETION_MARKER_REVIEW_REQUIRED');
  }

  // Preserve positive per-term source amounts. Numeric zero is not waiver evidence:
  // formula-backed placeholders and missing waiver evidence remain UNKNOWN (2026-09-30).
  const complex = ['offer_terms', 'adapter_pricing', 'rent_variants', 'rentVariants',
    'deposit', 'pricing_rules', 'quotes']
    .filter(k => has(d, k) && present(d[k]));
  for (const field of complex) issue(`PRICING_SEMANTICS_REVIEW_REQUIRED:${field}`);
  if (has(d, 'currency') && d.currency !== 'KRW') issue('UNSUPPORTED_CURRENCY');
  // 정책 연결은 코드가 맞는 것만으로는 부족하다 — 그 회사의 차가 그 회사의 정책을 따라야 한다.
  const policyCode = text(d.policy_code) ? d.policy_code : undefined;
  const companyId = text(d.provider_company_code) ? d.provider_company_code : undefined;
  if (policyCode) {
    // The same code can exist for several companies; only another company's policy is a mismatch.
    const sameCode = policies.filter(p => p.policyCode === policyCode);
    const mine = sameCode.filter(p => !companyId || !p.companyId || p.companyId === companyId);
    if (!sameCode.length) issue('POLICY_LINK_NOT_FOUND');
    else if (!mine.length) issue('POLICY_LINK_COMPANY_MISMATCH');
    else if (mine.length > 1) issue('POLICY_LINK_AMBIGUOUS');
  }
  if (!object(d.price) || Object.keys(d.price).length === 0) issue('MISSING_PRICE_TERMS');
  else for (const [sourceKey, terms] of Object.entries(d.price)) {
    const parsedKey = parseErp5PriceKey(sourceKey);
    if (!parsedKey) { issue('UNSUPPORTED_PRICE_KEY'); continue; }
    const months = parsedKey.months;
    // 키에 없으면 정책이 답한다. 기본값으로 떨어진 것도 값이지만 «출처»를 남겨 구분한다.
    const mileage = resolveErp5Mileage(parsedKey.mileageKm, policyCode, companyId, policies);
    const km = mileage.km;
    if (!object(terms)) { issue('INVALID_PRICE_OBJECT'); continue; }
    const amount = integer(terms.rent);
    if (amount === undefined) { issue('INVALID_RENT'); continue; }
    if (Object.keys(terms).some(k => !['rent', 'deposit', 'fee', 'commission', 'fee_memo'].includes(k))) {
      issue('UNMAPPED_PRICE_FIELDS');
    }
    const privateTerms = ['fee', 'commission', 'fee_memo'].filter(k => has(terms, k) && present(terms[k]));
    if (privateTerms.length) issue('PRIVATE_PRICE_TERMS_REVIEW_REQUIRED');
    const depositEvidence = assessDepositEvidence({ supplierId: d.provider_company_code, productType: d.product_type,
      note: d.deposit_note, depositFree: d.deposit_free, sourceAmount: terms.deposit,
      hasPositivePaidDeposit: hasConflictingPaidDeposit(d.price) });
    const depositAmount = complex.length || privateTerms.length || depositEvidence.state === 'UNKNOWN'
      ? undefined : depositEvidence.amount ?? undefined;
    if (depositEvidence.state === 'UNKNOWN') issue(depositEvidence.reason);
    if (depositAmount === undefined) issue('UNKNOWN_DEPOSIT');
    // 기본값으로 떨어진 주행거리는 원천이 말한 값이 아니다. 지우지 말고 검토 표시를 남긴다.
    if (mileage.source === 'DEFAULT') issue('MILEAGE_FROM_COMPANY_DEFAULT');
    if (parsedKey.settlement === 'BUYOUT') issue('BUYOUT_PRODUCT_SEPARATION_REQUIRED');
    const termKey = `source:${sourceKey}`;
    candidate.priceTerms.push({
      termKey, termMonths: months, monthlyRent: { amount, currency: 'KRW' },
      deposit: depositAmount === undefined ? null : { amount: depositAmount, currency: 'KRW' },
      depositState: depositAmount === undefined ? 'UNKNOWN' : depositAmount === 0 ? 'ZERO' : 'KNOWN',
      mileageLimitKmPerYear: km
    });
    fieldSources[`priceTerms/${termKey}`] = [pointer(['data', 'price', sourceKey])];
  }
  if (!candidate.priceTerms.length) issue('NO_MAPPED_PRICE_TERMS');
  for (const field of ['vehicle_status', 'status', 'status_kind', 'listable']) {
    fieldSources[`inventory/${field}`] = [pointer(['data', field])];
  }
  return {
    status: issues.length ? 'HOLD' : 'MAPPED_FOR_REVIEW', canonicalWriteAuthorized: false,
    mapperVersion: ERP5_PRODUCT_MAPPER_VERSION, sourceId: ERP5_PRODUCT_SOURCE, raw, candidate,
    inventory: {
      vehicleStatusRaw: d.vehicle_status ?? null, statusRaw: d.status ?? null,
      statusKindRaw: d.status_kind ?? null, listableRaw: d.listable ?? null
    }, fieldSources
  };
}
