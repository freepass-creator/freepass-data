import type {
  ErpPublicProduct,
  ProjectionProduct,
  ProjectionRelease
} from '../domain/catalog.js';
import type {
  ActiveProjectionEvidenceSnapshot,
  ProjectionFieldLineageRecord,
  ProjectionReleaseManifest
} from '../domain/projection-evidence.js';
import type {
  ProjectionEvidenceSnapshotStore,
  ProjectionStore
} from '../ports/catalog-store.js';

export type ActiveProjectionEvidenceObservation<T extends ProjectionProduct = ErpPublicProduct> = {
  projectionId: string;
  release: ProjectionRelease<T> | null;
  manifest: ProjectionReleaseManifest | null;
  lineage: ProjectionFieldLineageRecord[];
  consistency: 'ATOMIC' | 'PARTIAL_MULTI_READ';
};

export async function readActiveProjectionEvidence<T extends ProjectionProduct = ErpPublicProduct>(
  projections: Pick<
    ProjectionStore,
    'getActive' | 'getManifest' | 'listProjectionLineage'
  > & Partial<ProjectionEvidenceSnapshotStore>,
  projectionId: string
): Promise<ActiveProjectionEvidenceObservation<T>> {
  if (typeof projections.getActiveEvidenceSnapshot === 'function') {
    const snapshot = await projections.getActiveEvidenceSnapshot(projectionId);
    return snapshot as ActiveProjectionEvidenceSnapshot<T>;
  }

  const release = await projections.getActive(projectionId) as ProjectionRelease<T> | null;
  if (!release) {
    return {
      projectionId,
      release: null,
      manifest: null,
      lineage: [],
      consistency: 'PARTIAL_MULTI_READ'
    };
  }

  const [manifest, lineage] = await Promise.all([
    projections.getManifest(release.releaseId),
    projections.listProjectionLineage(release.releaseId)
  ]);

  return {
    projectionId,
    release,
    manifest,
    lineage,
    consistency: 'PARTIAL_MULTI_READ'
  };
}
