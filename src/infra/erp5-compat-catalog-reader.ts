import { createHash } from 'node:crypto';
import { Compute } from 'google-auth-library';
import { getFirestore, type QuerySnapshot, type Firestore } from 'firebase-admin/firestore';
import { createFirestoreSourceStore } from './source-firestore-store.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { CENTRAL_FIREBASE_PROJECT_ID, getTargetFirebaseApp } from './firebase-target.js';
import { depositEvidenceInputFromProduct, depositStatusLabel, hasConflictingPaidDeposit, normalizeErp5CompatibilityInteger, parseErp5CompatibilityPriceKey, readIancarPublishedDeposit, resolveDepositWithRuleNote } from '../domain/deposit-evidence.js';
import { logRouteError } from '../shared/route-error-log.js';
import { plateIdentityKey, isAssignedPlate } from '../domain/vehicle-plate.js';
import { hasVehiclePhotoVerification } from '../domain/consumer-output-contract.js';

import { isPublicIancarPhotoProduct, createVehiclePhotoReader, validateVehiclePhotoMedia, type ApprovedPhotoReader, type VehiclePhotoReadFailureObserver } from '../domain/consumer-output-contract.js';
export { isPublicIancarPhotoProduct, createVehiclePhotoReader, isApprovedVehiclePhotoProduct, VEHICLE_PHOTO_CACHE_TTL_MS } from '../domain/consumer-output-contract.js';
export type { ApprovedPhotoReader } from '../domain/consumer-output-contract.js';
type Rec = Record<string, unknown>;

/** Internal stored facts only: no fee engine, source fetch, public projection or identity inference. */
export function selectStoredProducts(products: Record<string, Rec>, policies: Record<string, Rec>,
  partners: Record<string, Rec>, search: Record<string, string> = {}, photoProjection?: (product: Rec) => unknown,
  registeredNames?: (supplierId: string) => readonly string[]) {
  const allowed = ['productId', 'supplierId', 'supplierName', 'vehicleName', 'plate'];
  for (const [key, value] of Object.entries(search))
    if (!allowed.includes(key) || typeof value !== 'string' || !value.trim()) throw new Error('INVALID_PRODUCT_SEARCH');
  if (search.plate && !isAssignedPlate(search.plate)) throw new Error('PLATE_NOT_ASSIGNED');
  const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
  // Remove legal designators only, not business words or arbitrary substrings.
  const nameKey = (v: unknown) => text(v).normalize('NFKC').replace(/\s+/g, '').toLowerCase()
    .replace(/^(?:\(주\)|주식회사)/, '').replace(/(?:\(주\)|주식회사)$/, '');
  return Object.entries(products).flatMap(([productId, product]) => {
    const supplierId = text(product.provider_company_code) || null;
    // Existing partner records are name authority; do not promote a display-code fallback.
    const suppliers = Object.entries(partners).filter(([id, p]) => supplierId &&
      [id, p.partner_code, p.company_code, p.provider_company_code, p.id].includes(supplierId));
    const supplierName = suppliers.length === 1 ? text(suppliers[0]![1].partner_name) || text(suppliers[0]![1].company_name) || text(suppliers[0]![1].name) || null : null;
    if (search.productId && search.productId.trim() !== productId) return [];
    if (search.supplierId && search.supplierId.trim() !== supplierId) return [];
    const supplierNames = [supplierName, ...(supplierId ? registeredNames?.(supplierId) ?? [] : [])].filter(Boolean);
    if (search.supplierName && !supplierNames.some(name => nameKey(search.supplierName) === nameKey(name))) return [];
    if (search.plate && plateIdentityKey(search.plate) !== plateIdentityKey(product.car_number)) return [];
    if (search.vehicleName && !nameKey([product.maker, product.model, product.sub_model, product.trim_name].filter(Boolean).join(' ')).includes(nameKey(search.vehicleName))) return [];
    const policyCode = text(product.policy_code);
    const sameCode = Object.entries(policies).filter(([id, p]) => policyCode && (id === policyCode || p.policy_code === policyCode));
    const company = (p: Rec) => text(p.companyId) || text(p.provider_company_code);
    const exactPolicies = supplierId ? sameCode.filter(([, p]) => company(p) === supplierId) : [];
    const linkedPolicies = exactPolicies.length ? exactPolicies : sameCode.filter(([, p]) => !company(p));
    const fields = ['maker', 'model', 'sub_model', 'trim_name', 'fuel_type', 'engine_cc', 'drive_type', 'seats',
      'car_number', 'vehicle_uid', 'vehicle_status', 'status', 'listable', 'product_type', 'price', 'deposit_note',
      'options', 'ext_color', 'int_color', 'year', 'mileage', 'first_registration_date', 'annual_mileage',
      'vehicle_class', 'engine_type', 'transmission', 'usage', 'accident_history', 'battery_capacity'];
    return [{ productId, representationKind: 'LEGACY_PRODUCT' as const, supplierId, supplierName,
      supplierNameEvidence: { state: supplierName ? 'KNOWN' : 'UNKNOWN', reasonCode: supplierName ? null : 'PARTNER_NAME_NOT_UNIQUE_OR_MISSING' },
      facts: Object.fromEntries(fields.map(k => [k, product[k] ?? null])),
      factStates: Object.fromEntries(fields.map(k => [k, { state: product[k] == null || product[k] === ''
        || (Array.isArray(product[k]) && product[k].length === 0) ? 'UNKNOWN' : 'STORED',
        reasonCode: product[k] == null || product[k] === '' || (Array.isArray(product[k]) && product[k].length === 0)
          ? 'STORED_FIELD_NOT_OBSERVED' : null }])),
      plateEvidence: { state: isAssignedPlate(product.car_number) ? 'KNOWN' : 'UNKNOWN',
        reasonCode: isAssignedPlate(product.car_number) ? null : 'ASSIGNED_PLATE_NOT_OBSERVED' },
      priceEvidence: { state: product.price && typeof product.price === 'object' && !Array.isArray(product.price)
        && Object.keys(product.price).length ? 'STORED' : 'UNKNOWN', reasonCode: product.price && typeof product.price === 'object'
        && !Array.isArray(product.price) && Object.keys(product.price).length ? null : 'STORED_PRICE_TERMS_NOT_OBSERVED' },
      policy: linkedPolicies.length === 1 ? { id: linkedPolicies[0]![0], data: linkedPolicies[0]![1] } : null,
      policyEvidence: { state: linkedPolicies.length === 1 ? 'KNOWN' : 'UNKNOWN', reasonCode: linkedPolicies.length === 1 ? null : 'POLICY_NOT_UNIQUE_OR_MISSING' },
      photos: { state: hasVehiclePhotoVerification(product) ? 'STORED_REVIEWED_REFS' : 'UNKNOWN',
        existingProjection: photoProjection ? photoProjection(product) : null,
        count: hasVehiclePhotoVerification(product) ? (product.photo_original_refs as unknown[]).length : null,
        references: hasVehiclePhotoVerification(product) ? (product.photo_original_refs as Rec[]).map((ref, index) => ({
          productId, index, referenceKind: 'STORED_REVIEW_METADATA', readerMethod: null,
          servingIndex: Number.isInteger(ref.servingIndex) ? ref.servingIndex : null,
          representative: typeof ref.representative === 'boolean' ? ref.representative : null,
          mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : null,
        })) : null,
        suppliedFields: Object.fromEntries(['photo_link', 'tica_link', 'image_urls', 'image_url'].map(k => [k, {
          state: product[k] == null || product[k] === '' || (Array.isArray(product[k]) && !product[k].length) ? 'UNKNOWN' : 'STORED_UNVERIFIED',
          reasonCode: 'USE_EXISTING_PHOTO_PROJECTION_FOR_ACCESS',
        }])),
        reasonCode: hasVehiclePhotoVerification(product) ? null : 'PHOTO_REVIEW_REFS_UNVERIFIED', bytesVerified: false,
        servingState: 'NOT_AUTHORIZED_FOR_THIS_INTERNAL_READER', servingReasonCode: 'PHOTO_SERVING_CONSUMER_GRANT_REQUIRED' },
    }];
  });
}

/** Explicit opt-in only. Compute uses the runtime service account, never local user ADC/gws.
 * No Drive listing, export, sharing, folder discovery, retries or runtime auto-registration.
 * Vehicle identity, approval, hash and revocation remain in createVehiclePhotoReader.
 */
export function createApprovedDrivePhotoReader(options: {
  token?: () => Promise<string>;
  fetchImpl?: typeof fetch;
} = {}): ApprovedPhotoReader {
  const auth = options.token ? undefined : new Compute({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const token = options.token ?? (async () => (await auth!.getAccessToken()).token ?? '');
  const transport = options.fetchImpl ?? fetch;
  return async ref => {
    // Snapshot the exact approved ID before async work; never interpret URLs/shortcuts.
    const fileId = ref.driveFileId;
    const mediaType = ref.mediaType;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(fileId)) throw new Error('VEHICLE_PHOTO_REQUEST_INVALID');
    try {
      const bearer = await token();
      if (!bearer || /[\r\n]/.test(bearer)) throw new Error();
      const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
      const request = async (query: string) => {
        const response = await transport(`${url}?${query}`, { method: 'GET', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${bearer}` } });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(response.status === 404 ? 'VEHICLE_PHOTO_NOT_FOUND' : 'VEHICLE_PHOTO_UNAVAILABLE');
        }
        return response;
      };
      const metadata = await (await request('fields=id,mimeType,size,trashed&supportsAllDrives=true')).json() as Rec;
      const size = typeof metadata.size === 'string' && /^\d+$/.test(metadata.size) ? Number(metadata.size) : NaN;
      if (metadata.id !== fileId || metadata.trashed !== false || metadata.mimeType !== mediaType
        || validateVehiclePhotoMedia(metadata.mimeType, size)) throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
      const response = await request('alt=media&supportsAllDrives=true');
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
      const length = response.headers.get('content-length');
      if (contentType !== mediaType || (length !== null && (!/^\d+$/.test(length) || Number(length) !== size))) {
        await response.body?.cancel();
        throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
      const chunks: Buffer[] = [];
      let received = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          received += part.value.byteLength;
          if (received > size || validateVehiclePhotoMedia(contentType, received)) throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
          chunks.push(Buffer.from(part.value));
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks, received);
      if (received !== size || validateVehiclePhotoMedia(contentType, received, bytes)) throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
      return { bytes, contentType: mediaType };
    } catch (error) {
      // Never expose SDK/transport response bodies, URLs, credentials or upstream diagnostics.
      throw new Error(error instanceof Error && error.message === 'VEHICLE_PHOTO_NOT_FOUND'
        ? 'VEHICLE_PHOTO_NOT_FOUND' : 'VEHICLE_PHOTO_UNAVAILABLE');
    }
  };
}

/** Reuse the bound Data target and read-only transaction; no alternate transport or writer. */
export async function readVehicleMasterSnapshot() {
  const db = getFirestore(getTargetFirebaseApp());
  return db.runTransaction(async tx => {
    const masters = await tx.get(db.collection('vehicle_master'));
    const trims = await tx.get(db.collection('vehicle_trim_master'));
    const documents = (q: QuerySnapshot) => q.docs.map(d => ({ id: d.id, data: jsonSafe(d.data()) as Rec }));
    const body = { readAt: masters.readTime.toDate().toISOString(), masters: documents(masters), trims: documents(trims) };
    if (!masters.readTime.isEqual(trims.readTime)) throw new Error('VEHICLE_MASTER_NON_ATOMIC_READ');
    return { source: 'freepasserp5/vehicle_master+vehicle_trim_master' as const, complete: true as const, ...body,
      digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  }, { readOnly: true });
}

export type CatalogCompatibilitySnapshot = {
  schema: 'freepass-data.catalog-compat/v1';
  data: {
    products: Record<string, Rec>;
    policies: Record<string, Rec>;
    partners?: Record<string, Rec>;
    users?: Record<string, Rec>;
    vehicleMaster?: Record<string, Rec>;
  };
  meta: {
    consumerId: string;
    authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE';
    sourceProject: typeof CENTRAL_FIREBASE_PROJECT_ID;
    observedAt: string;
    collectionCounts: Record<string, number>;
    depositEvidenceVersion: 'catalog-compat-deposit/1';
  };
};

export type CatalogCompatibilityReadCollection = 'products' | 'policy' | 'partner' | 'user' | 'vehicle_master';

/** A bounded fact selection, not a complete catalog or a publication decision. */
export type CatalogCompatibilityProductSnapshot = Omit<CatalogCompatibilitySnapshot, 'data' | 'meta'> & {
  data: Pick<CatalogCompatibilitySnapshot['data'], 'products' | 'policies' | 'partners'>;
  meta: CatalogCompatibilitySnapshot['meta'] & {
    selection: 'SINGLE_PRODUCT';
    readScope: 'SINGLE_PRODUCT';
    selectedProductId: string;
    readAt: string;
    readTimeExact: { seconds: number; nanoseconds: number };
    documentVersions: {
      product: { id: string; updateTime: string; updateTimeExact: { seconds: number; nanoseconds: number } };
      policies: Array<{ id: string; updateTime: string; updateTimeExact: { seconds: number; nanoseconds: number } }>;
      partners: Array<{ id: string; updateTime: string; updateTimeExact: { seconds: number; nanoseconds: number } }>;
    };
    linkedFacts: {
      policy: { state: 'KNOWN' | 'UNKNOWN'; reasonCode: string | null };
      partner: { state: 'KNOWN' | 'UNKNOWN'; reasonCode: string | null };
    };
  };
};

export class CatalogCompatibilityProductReadError extends Error {
  constructor(readonly code: 'PRODUCT_NOT_FOUND' | 'PRODUCT_SELECTION_UNAVAILABLE' | 'INVALID_PRODUCT_SELECTION',
    readonly statusCode: 400 | 404 | 503) {
    super(code);
    this.name = 'CatalogCompatibilityProductReadError';
  }
}

export const SINGLE_PRODUCT_FACT_FIELDS = Object.freeze([
  '_key', 'product_code', 'provider_company_code', 'partner_code', 'provider_name', 'partner_name', 'deposit_note', 'policy_id', 'policy_code',
  '_deleted', 'deletedAt', 'status', 'vehicle_status', 'status_kind', 'listable', 'publication_withdrawal',
  'car_number', 'vehicle_uid', 'maker', 'model', 'sub_model', 'trim_name', 'trim_extra', 'variant',
  'fuel_type', 'engine_type', 'engine_cc', 'drive_type', 'transmission', 'vehicle_class', 'product_type',
  'year', 'seats', 'mileage', 'annual_mileage', 'ext_color', 'int_color', 'first_registration_date',
  'price', 'iancar_phase_one',
] as const);

export const SINGLE_POLICY_FACT_FIELDS = ['_key', 'policy_code', 'companyId', 'provider_company_code',
  'policy_name', 'policy_type', 'payment_method', 'payment_timing', 'basic_driver_age',
  'driver_age_lowering', 'driver_age_upper_limit', 'license_period', 'personal_driver_scope',
  'business_driver_scope', 'insurance_included', 'deposit_installment', 'deposit_card_payment',
  'rental_card_payment', 'maintenance_service', 'credit_grade'] as const;
export const SINGLE_PARTNER_FACT_FIELDS = ['_key', 'partner_code', 'company_code', 'provider_company_code',
  'partner_name', 'company_name', 'name', 'brand_name', 'alias'] as const;

/** Transport safety only. Price-key meaning and eligibility remain in the caller's existing parser. */
export const isSingleProductPriceKey = (key: string): boolean => key.length > 0 && key.length <= 80
  && !['__proto__', 'constructor', 'prototype'].includes(key)
  && !/[\u0000-\u001f\u007f]|https?:\/\/|<[^>]*>|AIza|ya29\./i.test(key);

export const SINGLE_PRODUCT_PRICE_FIELDS = ['rent', 'deposit', 'depositState', 'deposit_state',
  'depositStatusLabel', 'depositEvidenceReason', 'depositEvidenceBasis', 'depositRuleDifference'] as const;

const selectionUnavailable = (): never => { throw new CatalogCompatibilityProductReadError('PRODUCT_SELECTION_UNAVAILABLE', 503); };
const selectedDocId = (value: unknown): string | undefined => {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 200 || value.trim() !== value || /[\/\u0000-\u001f\u007f]/.test(value)) return selectionUnavailable();
  return value;
};
const boundedScalar = (value: unknown): unknown => {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string' && value.length <= 300 && !/[\u0000-\u001f\u007f]|https?:\/\/|AIza|ya29\./i.test(value)) return value;
  return selectionUnavailable();
};
const pickSelectedFacts = (record: Rec, fields: readonly string[]): Rec => Object.fromEntries(fields
  .filter(field => Object.hasOwn(record, field))
  .map(field => [field, boundedScalar(record[field])]));

/** Uses the existing target and transaction; no collection scan, alias inference or publication decision. */
export async function readSingleProductCompatibility(db: Firestore, consumerId: string, productId: string,
  readCollections: ReadonlySet<CatalogCompatibilityReadCollection>): Promise<CatalogCompatibilityProductSnapshot> {
  if (!(consumerId === 'erp-com' || /^whitelabel-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(consumerId))) return selectionUnavailable();
  if (!productId || productId.length > 200 || productId.trim() !== productId || /[\/\u0000-\u001f\u007f]/.test(productId)) throw new CatalogCompatibilityProductReadError('INVALID_PRODUCT_SELECTION', 400);
  if (!readCollections.has('products')) return selectionUnavailable();
  const layout = FIRESTORE_COLLECTIONS.legacyAdminWorkflow;
  return db.runTransaction(async tx => {
    const product = await tx.get(db.collection(layout.products).doc(productId));
    if (!product.exists) throw new CatalogCompatibilityProductReadError('PRODUCT_NOT_FOUND', 404);
    const raw = product.data()!;
    const readAt = product.readTime && new Date(product.readTime.toMillis()).toISOString();
    const version = product.updateTime && new Date(product.updateTime.toMillis()).toISOString();
    if (product.id !== productId || !readAt || !version) return selectionUnavailable();
    if (raw._key != null && raw._key !== '' && raw._key !== productId) return selectionUnavailable();
    const policyCode = selectedDocId(raw.policy_code);
    const explicitPolicyId = selectedDocId(raw.policy_id);
    if (policyCode && explicitPolicyId && policyCode !== explicitPolicyId) return selectionUnavailable();
    const policyId = policyCode ?? explicitPolicyId;
    const providerCode = selectedDocId(raw.provider_company_code);
    const partnerCode = selectedDocId(raw.partner_code);
    if (providerCode && partnerCode && providerCode !== partnerCode) return selectionUnavailable();
    const partnerId = providerCode ?? partnerCode;
    const linked = async (kind: 'policy' | 'partner', id: string | undefined, collection: string, fields: readonly string[]) => {
      if (!id) return { rows: {}, versions: [], evidence: { state: 'UNKNOWN' as const, reasonCode: `${kind.toUpperCase()}_REFERENCE_NOT_OBSERVED` } };
      if (!readCollections.has(kind)) return selectionUnavailable();
      const doc = await tx.get(db.collection(collection).doc(id));
      if (!doc.readTime || !doc.readTime.isEqual(product.readTime)) return selectionUnavailable();
      if (!doc.exists) return { rows: {}, versions: [], evidence: { state: 'UNKNOWN' as const, reasonCode: `${kind.toUpperCase()}_NOT_OBSERVED` } };
      const updateTime = doc.updateTime && new Date(doc.updateTime.toMillis()).toISOString();
      if (!updateTime || doc.id !== id) return selectionUnavailable();
      const facts = doc.data()!;
      const codes = kind === 'policy' ? ['policy_code'] : ['partner_code', 'company_code', 'provider_company_code'];
      if (codes.some(code => facts[code] != null && facts[code] !== '' && facts[code] !== id)) return selectionUnavailable();
      return { rows: { [id]: { ...pickSelectedFacts(doc.data()!, fields), _key: id } },
        versions: [{ id, updateTime, updateTimeExact: { seconds: doc.updateTime!.seconds, nanoseconds: doc.updateTime!.nanoseconds } }], evidence: { state: 'KNOWN' as const, reasonCode: null } };
    };
    const policy = await linked('policy', policyId, layout.policies, SINGLE_POLICY_FACT_FIELDS);
    const partner = await linked('partner', partnerId, layout.partners, SINGLE_PARTNER_FACT_FIELDS);
    const compatible = withCompatibilityDepositEvidence(raw, readAt);
    const selected = pickSelectedFacts(compatible, SINGLE_PRODUCT_FACT_FIELDS.filter(f => f !== 'price' && f !== 'iancar_phase_one' && f !== '_key'));
    if (Object.hasOwn(compatible, 'price')) {
      if (compatible.price === null) selected.price = null;
      else {
        if (!compatible.price || typeof compatible.price !== 'object' || Array.isArray(compatible.price) || Object.keys(compatible.price).length > 200) return selectionUnavailable();
        selected.price = Object.fromEntries(Object.entries(compatible.price as Rec).map(([key, row]) => {
          if (!isSingleProductPriceKey(key) || !row || typeof row !== 'object' || Array.isArray(row)) return selectionUnavailable();
          const value = row as Rec;
          const result = pickSelectedFacts(value, SINGLE_PRODUCT_PRICE_FIELDS.filter(field => field !== 'depositEvidenceBasis' && field !== 'depositRuleDifference'));
          for (const [field, allowed] of [ ['depositEvidenceBasis', ['field', 'text', 'source', 'at']],
            ['depositRuleDifference', ['ruleAmount', 'ruleCode', 'differs']] ] as const) {
            if (!Object.hasOwn(value, field)) continue;
            if (!value[field] || typeof value[field] !== 'object' || Array.isArray(value[field])) return selectionUnavailable();
            result[field] = pickSelectedFacts(value[field] as Rec, allowed);
          }
          return [key, result];
        }));
      }
    }
    if (Object.hasOwn(raw, 'iancar_phase_one')) {
      const phase = raw.iancar_phase_one;
      if (phase === null) selected.iancar_phase_one = null;
      else {
        if (!phase || typeof phase !== 'object' || Array.isArray(phase)) return selectionUnavailable();
        const p = phase as Rec;
        const result = pickSelectedFacts(p, ['policyStage']);
        if (Object.hasOwn(p, 'priceAliases')) {
          if (!p.priceAliases || typeof p.priceAliases !== 'object' || Array.isArray(p.priceAliases) || Object.keys(p.priceAliases).length > 200) return selectionUnavailable();
          result.priceAliases = Object.fromEntries(Object.entries(p.priceAliases as Rec).map(([key, value]) => {
            if (!isSingleProductPriceKey(key)) return selectionUnavailable();
            if (typeof value !== 'string' || !isSingleProductPriceKey(value)) return selectionUnavailable();
            return [key, value];
          }));
        }
        selected.iancar_phase_one = result;
      }
    }
    const snapshot: CatalogCompatibilityProductSnapshot = {
      schema: 'freepass-data.catalog-compat/v1', data: { products: { [productId]: { ...selected, _key: productId } }, policies: policy.rows, partners: partner.rows },
      meta: { consumerId, authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE', sourceProject: CENTRAL_FIREBASE_PROJECT_ID,
        observedAt: readAt, readAt, readTimeExact: { seconds: product.readTime.seconds, nanoseconds: product.readTime.nanoseconds }, collectionCounts: { products: 1, policies: policy.versions.length, partners: partner.versions.length },
        depositEvidenceVersion: 'catalog-compat-deposit/1', selection: 'SINGLE_PRODUCT', readScope: 'SINGLE_PRODUCT', selectedProductId: productId,
        documentVersions: { product: { id: productId, updateTime: version, updateTimeExact: { seconds: product.updateTime!.seconds, nanoseconds: product.updateTime!.nanoseconds } }, policies: policy.versions, partners: partner.versions },
        linkedFacts: { policy: policy.evidence, partner: partner.evidence } },
    };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) return selectionUnavailable();
    return snapshot;
  }, { readOnly: true });
}

export type CatalogCompatibilityReaderOptions = {
  readCollections?: readonly CatalogCompatibilityReadCollection[];
  photoReadFailureObserver?: VehiclePhotoReadFailureObserver;
};

const jsonSafe = (value: unknown): unknown => {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const candidate = value as { toMillis?: () => number; path?: unknown };
    if (typeof candidate.toMillis === 'function') {
      try { return candidate.toMillis(); } catch { /* continue */ }
    }
    if (typeof candidate.path === 'string' && Object.keys(value as object).length <= 8) {
      return candidate.path;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonSafe(item)])
    );
  }
  return String(value);
};

const asMap = (snapshot: QuerySnapshot): Record<string, Rec> => Object.fromEntries(
  snapshot.docs.map((doc) => [
    doc.id,
    { ...(jsonSafe(doc.data()) as Rec), _key: doc.id },
  ])
);

const allowedConsumer = (consumerId: string) =>
  consumerId === 'erp-com' ||
  consumerId === 'freepass-admin-catalog' ||
  /^whitelabel-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(consumerId);

/** Response derivation only. UNKNOWN never retains an apparently confirmed numeric amount. */
export function withCompatibilityDepositEvidence(product: Rec, now = new Date().toISOString()): Rec {
  const price = product.price;
  if (!price || typeof price !== 'object' || Array.isArray(price)) return { ...product };
  const paid = hasConflictingPaidDeposit(price);
  return { ...product, price: Object.fromEntries(Object.entries(price).map(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [key, value];
    const row = value as Rec;
    const parsed = parseErp5CompatibilityPriceKey(key);
    const evidence = product.provider_company_code === 'RP031' ? readIancarPublishedDeposit(product, key, now)
      : resolveDepositWithRuleNote(depositEvidenceInputFromProduct(product, row.deposit, {
      termMonths: parsed?.months, monthlyRent: normalizeErp5CompatibilityInteger(row.rent), hasPositivePaidDeposit: paid }));
    const { depositEvidenceBasis: _staleDepositEvidenceBasis, ...rowWithoutStaleBasis } = row;
    const depositEvidenceBasis = 'depositEvidenceBasis' in evidence ? evidence.depositEvidenceBasis : undefined;
    return [key, { ...rowWithoutStaleBasis, deposit: evidence.amount, depositState: evidence.state,
      depositStatusLabel: depositStatusLabel(evidence.state, row.deposit, product.deposit_note),
      depositEvidenceReason: evidence.reason,
      ...('depositRuleDifference' in evidence ? { depositRuleDifference: evidence.depositRuleDifference } : {}),
      ...(evidence.state === 'ZERO' && depositEvidenceBasis ? { depositEvidenceBasis } : {}) }];
  })) };
}

/**
 * Transitional read-only bridge.
 *
 * The consumer never receives Firebase credentials or collection paths. This reader keeps
 * the legacy document shape behind FreePass Data while canonical projections are completed.
 * It must never become a write API or a fallback around the canonical release gate.
 */

export class FirestoreCatalogCompatibilityReader {
  private readonly db = getFirestore(getTargetFirebaseApp());
  readonly sourceStore = createFirestoreSourceStore();
  private readonly readCollections: ReadonlySet<CatalogCompatibilityReadCollection>;
  constructor(photoReader?: (vehicleId: string, plate: string, index?: number, fresh?: boolean) => Promise<import('../domain/consumer-output-contract.js').VehiclePhotoRead>,
    approvedPhotoReader?: ApprovedPhotoReader, options: CatalogCompatibilityReaderOptions = {}) {
    this.readCollections = new Set(options.readCollections ?? ['products', 'policy', 'partner', 'user', 'vehicle_master']);
    this.readVehiclePhoto = createVehiclePhotoReader(async productId => (await this.db.collection('products').doc(productId).get()).data(), {
      eligible: isPublicIancarPhotoProduct,
      connection: product => createHash('sha256').update(JSON.stringify([product.provider_company_code, product.iancar_one_vehicle_id, product.car_number])).digest('hex'),
      read: async (product, index, fresh) => {
        if (!photoReader) throw new Error('VEHICLE_PHOTO_READER_UNAVAILABLE');
        // Identity and source bytes are supplied here; reviewed ONE binding/hash checks stay in Domain.
        return photoReader(product.iancar_one_vehicle_id as string, product.car_number as string, index, fresh);
      },
    }, approvedPhotoReader, undefined, options.photoReadFailureObserver);
  }
  readonly readVehiclePhoto: ReturnType<typeof createVehiclePhotoReader>;

  readProductCompat(consumerId: string, productId: string): Promise<CatalogCompatibilityProductSnapshot> {
    return readSingleProductCompatibility(this.db, consumerId, productId, this.readCollections);
  }

  /** Shared internal consumer entrypoint. Current-source rows stay separate from saved products. */
  async readStoredProducts(consumerId: string, search: Record<string, string> = {}, photoProjection?: (product: Rec) => unknown,
    registeredNames?: (supplierId: string) => readonly string[]) {
    if (!['kakao-ops', 'freepass-admin-catalog'].includes(consumerId) && !/^internal-ai-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(consumerId))
      throw new Error('STORED_INTERNAL_CONSUMER_NOT_ALLOWED');
    selectStoredProducts({}, {}, {}, search); // Validate before network reads.
    const C = FIRESTORE_COLLECTIONS;
    const saved = await this.db.runTransaction(async tx => {
      const [products, policies, partners, ledger, offers] = await Promise.all([
        tx.get(this.db.collection(C.legacyAdminWorkflow.products)),
        tx.get(this.db.collection(C.legacyAdminWorkflow.policies)),
        tx.get(this.db.collection(C.legacyAdminWorkflow.partners)),
        tx.get(this.db.collection(C.periodFees.ledger)),
        tx.get(this.db.collection(C.catalog.offers)),
      ]);
      const rows = selectStoredProducts(asMap(products), asMap(policies), asMap(partners), search, photoProjection, registeredNames);
      return { rows: rows.map(row => ({ ...row,
        // Only exact saved product IDs may connect economics; never join by plate/name/code pattern.
        storedOffers: offers.docs.filter(d => d.get('productId') === row.productId).map(d => jsonSafe(d.data())),
        offerEvidence: { state: offers.docs.some(d => d.get('productId') === row.productId) ? 'STORED' : 'UNKNOWN',
          reasonCode: offers.docs.some(d => d.get('productId') === row.productId) ? null : 'CATALOG_OFFER_EXACT_PRODUCT_LINK_NOT_OBSERVED' },
        // No deployed ACTIVE-head contract has been verified. Preserve historical stored rows without selecting today's fees.
        storedLedgerRows: ledger.docs.filter(d => d.get('productId') === row.productId).map(d => jsonSafe(d.data())),
        currentFeeEvidence: { state: 'UNKNOWN', reasonCode: ledger.size ? 'PERIOD_FEE_ACTIVE_HEAD_UNVERIFIED' : 'PERIOD_FEE_LEDGER_NOT_OBSERVED' },
      })), readAt: products.readTime.toDate().toISOString(),
        ledgerRows: ledger.docs.map(d => jsonSafe(d.data())),
        counts: { products: products.size, policies: policies.size, partners: partners.size, ledgerRows: ledger.size, offers: offers.size } };
    }, { readOnly: true });
    return { authority: 'STORED_FACTS' as const, publicationDecision: 'HOLD' as const, consumerId,
      products: saved.rows,
      ledgerRows: saved.ledgerRows,
      diagnostics: { queryOutcome: saved.rows.length ? 'MATCHES' : 'NOT_OBSERVED',
        supplierSearchResolution: search.supplierName && new Set(saved.rows.map(row => row.supplierId).filter(Boolean)).size > 1
          ? 'HOLD_AMBIGUOUS_REGISTERED_NAME' : 'EXACT_REGISTERED_OR_LEGAL_NAME',
        emptyDoesNotProveAbsence: true, representation: 'LEGACY_PRODUCT',
        unresolvedSupplierNames: saved.rows.filter(row => row.supplierName === null).length,
        currentLedgerVerified: false },
      meta: { readAt: saved.readAt, counts: saved.counts, snapshotConsistency: 'PRODUCT_POLICY_PARTNER_LEDGER_TRANSACTION' },
    };
  }

  async read(consumerId: string): Promise<CatalogCompatibilitySnapshot> {
    if (!allowedConsumer(consumerId)) throw new Error('CATALOG_COMPAT_CONSUMER_NOT_ALLOWED');

    try {
      const wantsAdminMaster = consumerId === 'freepass-admin-catalog';
      const wantsErpPresentation = consumerId === 'erp-com' || consumerId.startsWith('whitelabel-');

      const requests = [
        ...(this.readCollections.has('products') ? [['products', this.db.collection('products').get()] as const] : []),
        ...(this.readCollections.has('policy') ? [['policy', this.db.collection('policy').get()] as const] : []),
        ...(wantsErpPresentation && this.readCollections.has('partner')
          ? [
              ['partner', this.db.collection('partner').get()] as const,
            ]
          : []),
        ...(wantsErpPresentation && this.readCollections.has('user')
          ? [
              ['user', this.db.collection('user').get()] as const,
            ]
          : []),
        ...(wantsAdminMaster && this.readCollections.has('vehicle_master')
          ? [['vehicle_master', this.db.collection('vehicle_master').get()] as const]
          : []),
      ] as const;

      const resolved = await Promise.all(
        requests.map(async ([name, query]) => [name, await query] as const)
      );
      const byName = new Map<string, QuerySnapshot>(resolved.map(([name, snapshot]) => [name, snapshot]));
      const get = (name: string) => byName.get(name);

      const products = get('products');
      const policies = get('policy');
      if (!products || !policies) throw new Error('CATALOG_COMPAT_REQUIRED_COLLECTION_MISSING');

      const collectionCounts = Object.fromEntries(
        resolved.map(([name, snapshot]) => [name, snapshot.size])
      );
      const observedAt = new Date().toISOString();

      return {
        schema: 'freepass-data.catalog-compat/v1',
        data: {
          products: Object.fromEntries(Object.entries(asMap(products)).map(([id, product]) => [id, withCompatibilityDepositEvidence(product, observedAt)])),
          policies: asMap(policies),
          ...(get('partner') ? { partners: asMap(get('partner')!) } : {}),
          ...(get('user') ? { users: asMap(get('user')!) } : {}),
          ...(get('vehicle_master') ? { vehicleMaster: asMap(get('vehicle_master')!) } : {}),
        },
        meta: {
          consumerId,
          authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE',
          sourceProject: CENTRAL_FIREBASE_PROJECT_ID,
          observedAt,
          collectionCounts,
          depositEvidenceVersion: 'catalog-compat-deposit/1',
        },
      };
    } catch (error) {
      logRouteError('erp5-compat-catalog-reader', 'compat_reader_read', error);
      throw error;
    }
  }

  async readKakaoReferenceSource(consumerId: string, options?: { sourceScope: 'LISTABLE' | 'COLLECTED' }) {
    if (consumerId !== 'kakao-ops') throw new Error('KAKAO_REFERENCE_CONSUMER_NOT_ALLOWED');
    return this.readReferenceProducts(consumerId, options);
  }

  async readInternalAiReferenceSource(consumerId: string, options?: { sourceScope: 'LISTABLE' | 'COLLECTED' }) {
    if (!/^internal-ai-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(consumerId)) throw new Error('INTERNAL_AI_CONSUMER_NOT_ALLOWED');
    return this.readReferenceProducts(consumerId, options);
  }

  private async readReferenceProducts(consumerId: string, options?: { sourceScope: 'LISTABLE' | 'COLLECTED' }) {
    const [products, policies, masterRead] = await Promise.all([
      this.db.collection('products').get(), this.db.collection('policy').get(),
      readVehicleMasterSnapshot().then(vehicleMasterSnapshot => ({ vehicleMasterSnapshot, vehicleMasterReadState: 'AVAILABLE' as const }))
        .catch(() => ({ vehicleMasterSnapshot: null, vehicleMasterReadState: 'UNAVAILABLE' as const })),
    ]);
    return {
      consumerId,
      products: asMap(products),
      policies: asMap(policies),
      ...masterRead,
      observedAt: new Date().toISOString(),
    };
  }

  async readTrustScorecardInput() {
    const C = FIRESTORE_COLLECTIONS;
    const [
      compat,
      masterSnapshot,
      legacyPolicies,
      vehicleModels,
      vehicleAssets,
      catalogProducts,
      catalogOffers,
      sourceDefinitions,
      sourceHeads,
    ] = await Promise.all([
      this.read('freepass-admin-catalog'),
      readVehicleMasterSnapshot(),
      this.db.collection('policy').get(),
      this.db.collection(C.catalog.vehicleModels).get(),
      this.db.collection(C.catalog.vehicleAssets).get(),
      this.db.collection(C.catalog.products).get(),
      this.db.collection(C.catalog.offers).get(),
      this.db.collection(C.source.definitions).get(),
      this.db.collection(C.source.heads).get(),
    ]);
    const sourceHeadById = new Map(sourceHeads.docs.map((doc) => [doc.id, jsonSafe(doc.data()) as Rec]));
    const sourceFreshness = sourceDefinitions.docs.map((doc) => {
      const definition = jsonSafe(doc.data()) as Rec;
      const head = sourceHeadById.get(doc.id);
      const expected = definition.expectedFreshnessSeconds;
      return {
        sourceId: String(definition.sourceId ?? doc.id),
        expectedFreshnessSeconds: Number.isSafeInteger(expected) ? expected as number : null,
        observedAt: typeof head?.observedAt === 'string' ? head.observedAt : null,
        acceptedAt: typeof head?.acceptedAt === 'string' ? head.acceptedAt : null,
      };
    });
    return {
      readAt: compat.meta.observedAt,
      legacyProducts: compat.data.products,
      legacyPolicies: asMap(legacyPolicies),
      legacyVehicleMasterRows: Object.entries(compat.data.vehicleMaster ?? {}).map(([id, row]) => ({
        id,
        maker: String(row.maker ?? ''),
        model: String(row.model ?? ''),
        subModel: String(row.sub_model ?? row.subModel ?? ''),
        generationCode: typeof row.generationCode === 'string' ? row.generationCode : null,
        yearStart: typeof row.yearStart === 'string' ? row.yearStart : null,
        yearEnd: typeof row.yearEnd === 'string' ? row.yearEnd : null,
      })),
      vehicleReferenceRows: masterSnapshot.trims.map((row) => ({
        maker: String(row.data.maker ?? ''),
        model: String(row.data.model ?? ''),
        subModel: String(row.data.sub_model ?? row.data.subModel ?? ''),
        yearStart: typeof row.data.yearStart === 'string' ? row.data.yearStart : null,
        yearEnd: typeof row.data.yearEnd === 'string' ? row.data.yearEnd : null,
      })),
      canonical: {
        vehicleModels: vehicleModels.docs.map((doc) => jsonSafe(doc.data())),
        vehicleAssets: vehicleAssets.docs.map((doc) => jsonSafe(doc.data())),
        products: catalogProducts.docs.map((doc) => jsonSafe(doc.data())),
        offers: catalogOffers.docs.map((doc) => jsonSafe(doc.data())),
      },
      sourceFreshness,
    };
  }
}

export function createFirestoreCatalogCompatibilityReader(photoReader?: ConstructorParameters<typeof FirestoreCatalogCompatibilityReader>[0], approvedPhotoReader?: ApprovedPhotoReader, options?: CatalogCompatibilityReaderOptions) {
  return new FirestoreCatalogCompatibilityReader(photoReader, approvedPhotoReader, options);
}
