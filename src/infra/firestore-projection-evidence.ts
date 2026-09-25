import type { Firestore } from 'firebase-admin/firestore';
import type { ErpPublicProduct, ProjectionRelease } from '../domain/catalog.js';
import type {
  ActiveProjectionEvidenceSnapshot,
  ProjectionFieldLineageRecord,
  ProjectionReleaseManifest
} from '../domain/projection-evidence.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';

export function assertFirestoreReleaseId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^rel_[a-zA-Z0-9-]+$/.test(value)) {
    throw new Error('Invalid release identity');
  }
}

function assertReleaseDocumentIdentity(
  release: ProjectionRelease<ErpPublicProduct>,
  releaseId: string
) {
  if (release.releaseId !== releaseId) {
    throw new Error('Release pointer identity mismatch');
  }
}

export async function readFirestoreActiveProjection(
  db: Firestore,
  projectionId: string
): Promise<ProjectionRelease<ErpPublicProduct> | null> {
  const pointer = await db.collection(FIRESTORE_COLLECTIONS.projection.active)
    .doc(projectionId)
    .get();
  if (!pointer.exists) return null;

  const releaseId: unknown = pointer.get('releaseId');
  assertFirestoreReleaseId(releaseId);

  const releaseSnap = await db.collection(FIRESTORE_COLLECTIONS.projection.releases)
    .doc(releaseId)
    .get();
  if (!releaseSnap.exists) return null;

  const release = releaseSnap.data() as ProjectionRelease<ErpPublicProduct>;
  assertReleaseDocumentIdentity(release, releaseId);
  return release;
}

export async function readFirestoreProjectionManifest(
  db: Firestore,
  releaseId: string
): Promise<ProjectionReleaseManifest | null> {
  assertFirestoreReleaseId(releaseId);
  const manifestSnap = await db.collection(FIRESTORE_COLLECTIONS.projection.manifests)
    .doc(releaseId)
    .get();
  return manifestSnap.exists
    ? manifestSnap.data() as ProjectionReleaseManifest
    : null;
}

export async function readFirestoreProjectionLineage(
  db: Firestore,
  releaseId: string
): Promise<ProjectionFieldLineageRecord[]> {
  assertFirestoreReleaseId(releaseId);
  const snap = await db.collection(FIRESTORE_COLLECTIONS.projection.lineage)
    .where('releaseId', '==', releaseId)
    .get();
  return snap.docs.map(
    (doc) => doc.data() as ProjectionFieldLineageRecord
  );
}

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
    assertFirestoreReleaseId(releaseId);

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
    if (release) assertReleaseDocumentIdentity(release, releaseId);

    return {
      projectionId,
      release,
      manifest: manifestSnap.exists
        ? manifestSnap.data() as ProjectionReleaseManifest
        : null,
      lineage: evidenceSnap.docs.map(
        (doc) => doc.data() as ProjectionFieldLineageRecord
      ),
      consistency: 'ATOMIC' as const
    };
  });
}
