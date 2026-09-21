import { createHash } from 'node:crypto';
import type { CatalogCandidate } from '../domain/catalog-candidate.js';
import type { CommercialType } from '../domain/catalog.js';

export const ERP5_PRODUCT_MAPPER_VERSION = 'erp5-product-mapping/1';
export const ERP5_PRODUCT_SOURCE = 'freepasserp5/firestore/products';
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
export type Erp5ProductInput = {
  projectId: 'freepasserp5'; collection: 'products'; documentId: string;
  sourceRevision: string; observedAt: string; data: ObjectValue;
};
type MappedCommercialType = CommercialType | 'OGONG_SUBSCRIPTION';
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
function stable(x: Json): Json {
  if (Array.isArray(x)) return x.map(stable);
  if (object(x)) return Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k]!)]));
  return x;
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
  '오공구독': 'OGONG_SUBSCRIPTION', '픽업구독': 'PICKUP_SUBSCRIPTION'
};
const inventoryKinds: Record<string, string> = {
  '즉시출고': '가용', '출고가능': '가용', '출고협의': '협의',
  '상품화중': '준비', '차량검수': '준비', '계약중': '선점', '출고불가': '불가'
};
const has = (x: ObjectValue, k: string) => Object.hasOwn(x, k);
const present = (x: Json | undefined) => x !== undefined && x !== null && x !== '';

/** Pure private preparation. Throws on invalid source envelope; never imports Firebase/runtime. */
export function mapErp5Product(input: unknown): Erp5ProductMapping {
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
    sourceFingerprint: createHash('sha256').update(JSON.stringify(stable(d))).digest('hex'),
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
  const validPlate = /^(?:[가-힣]{2})?\d{2,3}[가-힣]\d{4}$/.test(candidate.carNumber ?? '');
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
  if (commercialType === 'OGONG_SUBSCRIPTION') issue('CATALOG_COMMERCIAL_TYPE_EXTENSION_REQUIRED');
  if (['OGONG_SUBSCRIPTION', 'PICKUP_SUBSCRIPTION'].includes(commercialType ?? '') && supplier !== 'RP012') {
    issue('SUBSCRIPTION_SUPPLIER_REVIEW_REQUIRED');
  }
  // Independent bucket evidence confirms RP012 type; never recategorize to repair conflicts.
  if (d.provider_company_code === 'RP012') {
    const plate = candidate.carNumber ?? '';
    const rentalPlate = /[하허호]\d{4}$/.test(plate);
    const expected = d.source_bucket === 'TCAR_EXTERNAL' ? 'PICKUP_SUBSCRIPTION'
      : d.source_bucket === 'SON_NO_KONG' && validPlate ? (rentalPlate ? 'USED_RENT' : 'OGONG_SUBSCRIPTION') : null;
    if (!validPlate || !expected) issue('SONOGONG_CLASSIFICATION_EVIDENCE_MISSING');
    else if (commercialType !== expected) issue('SONOGONG_CLASSIFICATION_CONFLICT');
  }
  const vehicleStatus = candidate.vehicleStatusRaw;
  if (!vehicleStatus || !Object.hasOwn(inventoryKinds, vehicleStatus)) issue('UNREVIEWED_VEHICLE_STATUS');
  else {
    if (d.listable !== (vehicleStatus !== '출고불가')) issue('INVENTORY_LISTABLE_CONFLICT');
    if (d.status_kind !== inventoryKinds[vehicleStatus]) issue('INVENTORY_STATUS_KIND_CONFLICT');
  }
  if (typeof d.listable !== 'boolean') issue('UNKNOWN_LISTABLE');
  if (present(d._deleted) && d._deleted !== false && d._deleted !== 0) issue('DELETION_MARKER_REVIEW_REQUIRED');
  if (present(d.deletedAt) || (typeof d.status === 'string' && d.status.trim().toLowerCase() === 'deleted')) {
    issue('DELETION_MARKER_REVIEW_REQUIRED');
  }

  // These axes cannot be represented by the current Catalog PriceTerm without loss.
  // Even placeholder deposit=0 must stay UNKNOWN if a rule/alternate quote exists.
  const complex = ['deposit_note', 'offer_terms', 'adapter_pricing', 'rent_variants', 'rentVariants',
    'deposit', 'pricing_rules', 'quotes']
    .filter(k => has(d, k) && present(d[k]));
  for (const field of complex) issue(`PRICING_SEMANTICS_REVIEW_REQUIRED:${field}`);
  if (has(d, 'currency') && d.currency !== 'KRW') issue('UNSUPPORTED_CURRENCY');
  if (present(d.policy_code)) issue('POLICY_LINK_REVIEW_REQUIRED');
  if (!object(d.price) || Object.keys(d.price).length === 0) issue('MISSING_PRICE_TERMS');
  else for (const [sourceKey, terms] of Object.entries(d.price)) {
    const match = /^([1-9]\d*)(?:_([1-9]\d*)만)?$/.exec(sourceKey);
    const months = match ? integer(match[1]) : undefined;
    const km = match?.[2] ? Number(match[2]) * 10000 : undefined;
    if (!months || (km !== undefined && !Number.isSafeInteger(km))) { issue('UNSUPPORTED_PRICE_KEY'); continue; }
    if (!object(terms)) { issue('INVALID_PRICE_OBJECT'); continue; }
    const amount = integer(terms.rent);
    if (amount === undefined) { issue('INVALID_RENT'); continue; }
    if (Object.keys(terms).some(k => !['rent', 'deposit', 'fee', 'commission', 'fee_memo'].includes(k))) {
      issue('UNMAPPED_PRICE_FIELDS');
    }
    const privateTerms = ['fee', 'commission', 'fee_memo'].filter(k => has(terms, k) && present(terms[k]));
    if (privateTerms.length) issue('PRIVATE_PRICE_TERMS_REVIEW_REQUIRED');
    const depositAmount = complex.length || privateTerms.length ? undefined : integer(terms.deposit);
    if (depositAmount === undefined) issue('UNKNOWN_DEPOSIT');
    if (km === undefined) issue('UNKNOWN_MILEAGE_LIMIT');
    const termKey = `source:${sourceKey}`;
    candidate.priceTerms.push({
      termKey, termMonths: months, monthlyRent: { amount, currency: 'KRW' },
      deposit: depositAmount === undefined ? null : { amount: depositAmount, currency: 'KRW' },
      depositState: depositAmount === undefined ? 'UNKNOWN' : depositAmount === 0 ? 'ZERO' : 'KNOWN',
      ...(km !== undefined ? { mileageLimitKmPerYear: km } : {})
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
