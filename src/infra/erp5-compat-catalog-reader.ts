import { createHash } from 'node:crypto';
import { Compute } from 'google-auth-library';
import { getFirestore, type QuerySnapshot } from 'firebase-admin/firestore';
import { CENTRAL_FIREBASE_PROJECT_ID, getTargetFirebaseApp } from './firebase-target.js';
import { depositEvidenceInputFromProduct, depositStatusLabel, hasConflictingPaidDeposit, normalizeErp5CompatibilityInteger, parseErp5CompatibilityPriceKey, readIancarPublishedDeposit, resolveDepositWithRuleNote } from '../domain/deposit-evidence.js';

import { createVehiclePhotoReader, validateVehiclePhotoMedia, type ApprovedPhotoReader } from '../domain/consumer-output-contract.js';
export { createVehiclePhotoReader, isApprovedVehiclePhotoProduct, VEHICLE_PHOTO_CACHE_TTL_MS } from '../domain/consumer-output-contract.js';
export type { ApprovedPhotoReader } from '../domain/consumer-output-contract.js';
type Rec = Record<string, unknown>;

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
export function isPublicIancarPhotoProduct(product: Record<string, unknown> | undefined): boolean {
  return !!product && product.provider_company_code === 'RP031' && product.listable === true
    && !product._deleted && !product.deletedAt && !product.publication_withdrawal
    && ['가용', '선점'].includes(String(product.status_kind))
    && typeof product.iancar_one_vehicle_id === 'string' && !!product.iancar_one_vehicle_id.trim()
    && typeof product.car_number === 'string' && !!product.car_number.trim();
}

export class FirestoreCatalogCompatibilityReader {
  private readonly db = getFirestore(getTargetFirebaseApp());
  constructor(photoReader?: (vehicleId: string, plate: string, index?: number) => Promise<{ count: number; bytes: Buffer | null; contentType: string }>,
    approvedPhotoReader?: ApprovedPhotoReader) {
    this.readVehiclePhoto = createVehiclePhotoReader(async productId => (await this.db.collection('products').doc(productId).get()).data(), {
      eligible: isPublicIancarPhotoProduct,
      connection: product => createHash('sha256').update(JSON.stringify([product.provider_company_code, product.iancar_one_vehicle_id, product.car_number])).digest('hex'),
      read: async (product, index) => {
        if (!photoReader) throw new Error('VEHICLE_PHOTO_READER_UNAVAILABLE');
        // ONE has no approved hash: iancarOnePhotoIds verifies supplier vehicle ID and plate ownership.
        return photoReader(product.iancar_one_vehicle_id as string, product.car_number as string, index);
      },
    }, approvedPhotoReader);
  }
  readonly readVehiclePhoto: ReturnType<typeof createVehiclePhotoReader>;

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
}

export function createFirestoreCatalogCompatibilityReader(photoReader?: ConstructorParameters<typeof FirestoreCatalogCompatibilityReader>[0], approvedPhotoReader?: ApprovedPhotoReader) {
  return new FirestoreCatalogCompatibilityReader(photoReader, approvedPhotoReader);
}
