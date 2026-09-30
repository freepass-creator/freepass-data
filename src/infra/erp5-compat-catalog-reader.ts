import { getFirestore, type QuerySnapshot } from 'firebase-admin/firestore';
import { CENTRAL_FIREBASE_PROJECT_ID, getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { stableDigest } from '../shared/stable-digest.js';

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

/**
 * Transitional read-only bridge.
 *
 * The consumer never receives Firebase credentials or collection paths. This reader keeps
 * the legacy document shape behind FreePass Data while canonical projections are completed.
 * It must never become a write API or a fallback around the canonical release gate.
 */
export class FirestoreCatalogCompatibilityReader {
  private readonly db = getFirestore(getTargetFirebaseApp());
  constructor(private readonly fees: {
    build: (source: Rec) => Rec & { priceTerms: { supplierBillingFee: { state: string }; channelPayoutFee: { state: string } }[] };
    project: (source: Rec, internal: boolean) => Rec;
  }) {}

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

    return {
      schema: 'freepass-data.catalog-compat/v1',
      data: {
        products: Object.fromEntries(Object.entries(asMap(products)).map(([id, data]) =>
          [id, this.fees.project(data, wantsAdminMaster)])),
        policies: asMap(policies),
        ...(get('partner') ? { partners: asMap(get('partner')!) } : {}),
        ...(get('user') ? { users: asMap(get('user')!) } : {}),
        ...(get('vehicle_master') ? { vehicleMaster: asMap(get('vehicle_master')!) } : {}),
      },
      meta: {
        consumerId,
        authority: 'FREEPASS_DATA_COMPATIBILITY_BRIDGE',
        sourceProject: CENTRAL_FIREBASE_PROJECT_ID,
        observedAt: new Date().toISOString(),
        collectionCounts,
      },
    };
  }

  async readKakaoReferenceSource(consumerId: string) {
    if (consumerId !== 'kakao-ops') throw new Error('KAKAO_REFERENCE_CONSUMER_NOT_ALLOWED');
    const products = await this.db.collection('products').get();
    return {
      consumerId,
      products: asMap(products),
      observedAt: new Date().toISOString(),
    };
  }

  async materializePeriodFees(apply: boolean) {
    // Independent review found source fingerprint feedback. Do not backfill source
    // documents until canonical Offer persistence/ownership is resolved.
    if (apply) throw new Error('HOLD_PERIOD_FEES_CANONICAL_STORAGE_REVIEW');
    if (process.env.FIREBASE_PROJECT_ID !== CENTRAL_FIREBASE_PROJECT_ID || process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('PERIOD_FEES_TARGET_MISMATCH');
    }
    const snapshot = await this.db.collection(FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products).get();
    const canonicalOfferCount = (await this.db.collection(FIRESTORE_COLLECTIONS.catalog.offers).count().get()).data().count;
    if (snapshot.empty) throw new Error('PERIOD_FEES_SOURCE_EMPTY');
    const rows = snapshot.docs.map((doc) => ({ doc, value: this.fees.build(doc.data()) }));
    const changed = rows.filter(({ doc, value }) => stableDigest(doc.data().internalPeriodFees ?? null) !== stableDigest(value));
    const states: Record<string, number> = {};
    for (const row of rows) for (const term of row.value.priceTerms) {
      const state = `${term.supplierBillingFee.state}/${term.channelPayoutFee.state}`;
      states[state] = (states[state] ?? 0) + 1;
    }
    return { mode: 'DRY_RUN', canonicalOfferCount, productCount: rows.length, changedCount: changed.length,
      written: 0, termCount: rows.reduce((sum, row) => sum + row.value.priceTerms.length, 0), states, backupPath: null };
  }
}

export function createFirestoreCatalogCompatibilityReader(fees: ConstructorParameters<typeof FirestoreCatalogCompatibilityReader>[0]) {
  return new FirestoreCatalogCompatibilityReader(fees);
}
