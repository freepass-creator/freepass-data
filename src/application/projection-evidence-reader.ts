import type {
  ActiveProjectionEvidenceSnapshot
} from '../domain/projection-evidence.js';
import type {
  ProjectionEvidenceSnapshotStore,
  ProjectionStore
} from '../ports/catalog-store.js';

export type ActiveProjectionEvidenceObservation = {
  projectionId: string;
  release: ProjectionRelease<ErpPublicProduct> | null;
  manifest: ProjectionReleaseManifest | null;
  lineage: ProjectionFieldLineageRecord[];
  consistency: 'ATOMIC' | 'PARTIAL_MULTI_READ';
};

export async function readActiveProjectionEvidence(
  projections: Pick<
    ProjectionStore,
    'getActive' | 'getManifest' | 'listProjectionLineage'
  > & Partial<ProjectionEvidenceSnapshotStore>,
  projectionId: string
): Promise<ActiveProjectionEvidenceObservation> {
  if (typeof projections.getActiveEvidenceSnapshot === 'function') {
    const snapshot: ActiveProjectionEvidenceSnapshot =
      await projections.getActiveEvidenceSnapshot(projectionId);
    return snapshot;
  }

  const release = await projections.getActive(projectionId);
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
