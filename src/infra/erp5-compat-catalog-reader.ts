import { getFirestore, type QuerySnapshot } from 'firebase-admin/firestore';
import { CENTRAL_FIREBASE_PROJECT_ID, getTargetFirebaseApp } from './firebase-target.js';
import { assessDepositEvidence, depositStatusLabel, hasConflictingPaidDeposit } from '../domain/deposit-evidence.js';
import { readIancarPublishedDeposit } from '../domain/deposit-evidence.js';

type Rec = Record<string, unknown>;

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
    const evidence = product.provider_company_code === 'RP031' ? readIancarPublishedDeposit(product, key, now)
      : assessDepositEvidence({ supplierId: product.provider_company_code, productType: product.product_type,
      note: product.deposit_note, depositFree: product.deposit_free, sourceAmount: row.deposit,
      hasPositivePaidDeposit: paid });
    return [key, { ...row, deposit: evidence.amount, depositState: evidence.state,
      depositStatusLabel: depositStatusLabel(evidence.state, row.deposit, product.deposit_note),
      depositEvidenceReason: evidence.reason }];
  })) };
}

/**
 * Transitional read-only bridge.
 *
 * The consumer never receives Firebase credentials or collection paths. This reader keeps
 * the legacy document shape behind FreePass Data while canonical projections are completed.
 * It must never become a write API or a fallback around the canonical release gate.
 */
export function isPublicIancarPhotoProduct(product: Record<string, unknown> | undefined): boolean {
  return !!product && product.provider_company_code === 'RP031' && product.listable === true
    && !product._deleted && !product.deletedAt && !product.publication_withdrawal
    && ['가용', '선점'].includes(String(product.status_kind))
    && typeof product.iancar_one_vehicle_id === 'string' && !!product.iancar_one_vehicle_id.trim()
    && typeof product.car_number === 'string' && !!product.car_number.trim();
}

export class FirestoreCatalogCompatibilityReader {
  private readonly db = getFirestore(getTargetFirebaseApp());
  constructor(private readonly photoReader?: (vehicleId: string, plate: string, index?: number) => Promise<{ count: number; bytes: Buffer | null; contentType: string }>) {}

  /** Product identity is resolved here, never accepted as an arbitrary provider path from a caller. */
  async readIancarPhoto(consumerId: string, productId: string, index?: number) {
    if (!(consumerId === 'erp-com' || /^whitelabel-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(consumerId)))
      throw new Error('IANCAR_PHOTO_CONSUMER_FORBIDDEN');
    if (!productId || productId.length > 200 || /[\/\u0000-\u001f\u007f]/.test(productId)
      || (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || index >= 200)))
      throw new Error('IANCAR_PHOTO_REQUEST_INVALID');
    const doc = await this.db.collection('products').doc(productId).get();
    const product = doc.data();
    if (!isPublicIancarPhotoProduct(product))
      throw new Error('IANCAR_PHOTO_NOT_FOUND');
    if (!this.photoReader) throw new Error('IANCAR_PHOTO_READER_UNAVAILABLE');
    return this.photoReader(product!.iancar_one_vehicle_id, product!.car_number, index);
  }

  async read(consumerId: string): Promise<CatalogCompatibilitySnapshot> {
    if (!allowedConsumer(consumerId)) throw new Error('CATALOG_COMPAT_CONSUMER_NOT_ALLOWED');

    const wantsAdminMaster = consumerId === 'freepass-admin-catalog';
    const wantsErpPresentation = consumerId === 'erp-com' || consumerId.startsWith('whitelabel-');

    const requests = [
      ['products', this.db.collection('products').get()],
      ['policy', this.db.collection('policy').get()],
      ...(wantsErpPresentation
        ? [
            ['partner', this.db.collection('partner').get()] as const,
            ['user', this.db.collection('user').get()] as const,
          ]
        : []),
      ...(wantsAdminMaster
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
  }

  async readKakaoReferenceSource(consumerId: string) {
    if (consumerId !== 'kakao-ops') throw new Error('KAKAO_REFERENCE_CONSUMER_NOT_ALLOWED');
    return this.readReferenceProducts(consumerId);
  }

  async readInternalAiReferenceSource(consumerId: string) {
    if (!/^internal-ai-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(consumerId)) throw new Error('INTERNAL_AI_CONSUMER_NOT_ALLOWED');
    return this.readReferenceProducts(consumerId);
  }

  private async readReferenceProducts(consumerId: string) {
    const products = await this.db.collection('products').get();
    return {
      consumerId,
      products: asMap(products),
      observedAt: new Date().toISOString(),
    };
  }
}

export function createFirestoreCatalogCompatibilityReader(photoReader?: ConstructorParameters<typeof FirestoreCatalogCompatibilityReader>[0]) {
  return new FirestoreCatalogCompatibilityReader(photoReader);
}
