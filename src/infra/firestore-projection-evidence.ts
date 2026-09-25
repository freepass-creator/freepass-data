import type { Firestore } from 'firebase-admin/firestore';
import type { ErpPublicProduct, ProjectionRelease } from '../domain/catalog.js';
import type {
  ActiveProjectionEvidenceSnapshot,
  ProjectionFieldLineageRecord,
  ProjectionReleaseManifest
} from '../domain/projection-evidence.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';

const validReleaseId = (value: unknown): value is string =>
  typeof value === 'string' && /^rel_[a-zA-Z0-9-]+$/.test(value);

export async function readFirestoreActiveProjectionEvidence(
  db: Firestore,
  projectionId: string
): Promise<ActiveProjectionEvidenceSnapshot> {
  const activeRef = db.collection(FIRESTORE_COLLECTIONS.projection.active).doc(projectionId);

  return db.runTransaction(async (tx) => {
    const activeSnap = await tx.get(activeRef);
    if (!activeSnap.exists) {
      return {
        projectionId,
        release: null,
        manifest: null,
        lineage: [],
        consistency: 'ATOMIC' as const
      };
    }

    const releaseId: unknown = activeSnap.get('releaseId');
    if (!validReleaseId(releaseId)) {
      throw new Error('Invalid release pointer');
    }

    const releaseRef = db.collection(FIRESTORE_COLLECTIONS.projection.releases).doc(releaseId);
    const manifestRef = db.collection(FIRESTORE_COLLECTIONS.projection.manifests).doc(releaseId);
    const evidenceQuery = db.collection(FIRESTORE_COLLECTIONS.projection.lineage)
      .where('releaseId', '==', releaseId);

    const releaseSnap = await tx.get(releaseRef);
    const manifestSnap = await tx.get(manifestRef);
    const evidenceSnap = await tx.get(evidenceQuery);

    const release = releaseSnap.exists
      ? releaseSnap.data() as ProjectionRelease<ErpPublicProduct>
      : null;
    if (
      release &&
      (release.releaseId !== releaseId || release.projectionId !== projectionId)
    ) {
      throw new Error('Release pointer identity mismatch');
    }

    const manifest = manifestSnap.exists
      ? manifestSnap.data() as ProjectionReleaseManifest
      : null;
    if (
      manifest &&
      (manifest.releaseId !== releaseId || manifest.projectionId !== projectionId)
    ) {
      throw new Error('Projection manifest identity mismatch');
    }

    const lineage = evidenceSnap.docs.map(
      (doc) => doc.data() as ProjectionFieldLineageRecord
    );
    if (lineage.some(
      (record) =>
        record.releaseId !== releaseId ||
        record.projectionId !== projectionId ||
        record.stage !== 'CANONICAL_TO_PROJECTION'
    )) {
      throw new Error('Projection lineage identity mismatch');
    }

    return {
      projectionId,
      release,
      manifest,
      lineage,
      consistency: 'ATOMIC' as const
    };
  });
}
