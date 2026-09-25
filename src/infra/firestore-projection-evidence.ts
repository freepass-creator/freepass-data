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

function assertReleaseIdentity(
  release: ProjectionRelease<ErpPublicProduct>,
  releaseId: string,
  projectionId?: string
) {
  if (
    release.releaseId !== releaseId ||
    (projectionId !== undefined && release.projectionId !== projectionId)
  ) {
    throw new Error('Release pointer identity mismatch');
  }
}

function assertManifestIdentity(
  manifest: ProjectionReleaseManifest,
  releaseId: string,
  projectionId?: string
) {
  if (
    manifest.releaseId !== releaseId ||
    (projectionId !== undefined && manifest.projectionId !== projectionId)
  ) {
    throw new Error('Projection manifest identity mismatch');
  }
}

function assertLineageIdentity(
  lineage: readonly ProjectionFieldLineageRecord[],
  releaseId: string,
  projectionId?: string
) {
  if (lineage.some(
    (record) =>
      record.releaseId !== releaseId ||
      (projectionId !== undefined && record.projectionId !== projectionId) ||
      record.stage !== 'CANONICAL_TO_PROJECTION'
  )) {
    throw new Error('Projection lineage identity mismatch');
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
  assertReleaseIdentity(release, releaseId, projectionId);
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
  if (!manifestSnap.exists) return null;

  const manifest = manifestSnap.data() as ProjectionReleaseManifest;
  assertManifestIdentity(manifest, releaseId);
  return manifest;
}

export async function readFirestoreProjectionLineage(
  db: Firestore,
  releaseId: string,
  projectionId?: string
): Promise<ProjectionFieldLineageRecord[]> {
  assertFirestoreReleaseId(releaseId);
  const snap = await db.collection(FIRESTORE_COLLECTIONS.projection.lineage)
    .where('releaseId', '==', releaseId)
    .get();
  const lineage = snap.docs.map(
    (doc) => doc.data() as ProjectionFieldLineageRecord
  );
  assertLineageIdentity(lineage, releaseId, projectionId);
  return lineage;
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
    if (release) assertReleaseIdentity(release, releaseId, projectionId);

    const manifest = manifestSnap.exists
      ? manifestSnap.data() as ProjectionReleaseManifest
      : null;
    if (manifest) assertManifestIdentity(manifest, releaseId, projectionId);

    const lineage = evidenceSnap.docs.map(
      (doc) => doc.data() as ProjectionFieldLineageRecord
    );
    assertLineageIdentity(lineage, releaseId, projectionId);

    return {
      projectionId,
      release,
      manifest,
      lineage,
      consistency: 'ATOMIC' as const
    };
  });
}
