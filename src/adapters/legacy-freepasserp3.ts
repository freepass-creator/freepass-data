import { applicationDefault, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { SourceCheckpoint, SourceCoverage } from '../domain/source.js';
import { stableDigest } from '../shared/stable-digest.js';

export type LegacyProductRaw = {
  sourceId: 'freepasserp3/firestore/products';
  sourceRecordId: string;
  observedAt: string;
  fingerprint: string;
  data: Record<string, unknown>;
};

export type LegacyProductSnapshot = {
  checkpoint: SourceCheckpoint;
  coverage: SourceCoverage;
  records: LegacyProductRaw[];
};

function fingerprint(value: unknown) {
  return stableDigest(value);
}
function legacyApp() {
  const name = 'freepass-data-legacy-freepasserp3';
  if (getApps().some((app) => app.name === name)) return getApp(name);
  return initializeApp({
    credential: applicationDefault(),
    projectId: process.env.LEGACY_FREEPASSERP3_PROJECT_ID ?? 'freepasserp3'
  }, name);
}

/**
 * Read-only source adapter for the confirmed legacy Firestore collection 'products'.
 * This adapter never writes to the legacy project.
 */
export async function readLegacyProductSnapshot(
  observedAt = new Date().toISOString()
): Promise<LegacyProductSnapshot> {
  const db = getFirestore(legacyApp());
  const snap = await db.collection('products').get();
  const records = snap.docs
    .map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {
        sourceId: 'freepasserp3/firestore/products' as const,
        sourceRecordId: doc.id,
        observedAt,
        fingerprint: fingerprint(data),
        data
      };
    })
    .sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId));

  const checksum = fingerprint(records.map((x) => [x.sourceRecordId, x.fingerprint]));
  return {
    checkpoint: {
      sourceId: 'freepasserp3/firestore/products',
      checksum,
      observedAt
    },
    coverage: {
      mode: 'FULL',
      completeness: 'COMPLETE',
      scope: 'firestore:products'
    },
    records
  };
}
