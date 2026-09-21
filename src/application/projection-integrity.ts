import type {
  ErpPublicProduct,
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
import { stableDigest, stableRecordSetDigest } from '../shared/stable-digest.js';

export type ProjectionIntegrityFailureCode =
  | 'RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH'
  | 'MANIFEST_DATA_DIGEST_MISMATCH'
  | 'MANIFEST_CANONICAL_INPUT_DIGEST_MISMATCH'
  | 'RELEASE_INPUT_DIGEST_MISMATCH'
  | 'MANIFEST_ID_MISMATCH'
  | 'RELEASE_ID_MISMATCH'
  | 'PROJECTION_ID_MISMATCH'
  | 'SCHEMA_VERSION_MISMATCH'
  | 'PRODUCT_COUNT_MISMATCH'
  | 'OFFER_COUNT_MISMATCH'
  | 'CANONICAL_REVISION_MISMATCH'
  | 'EVIDENCE_COUNT_MISMATCH'
  | 'EVIDENCE_DIGEST_MISSING'
  | 'EVIDENCE_DIGEST_MISMATCH';

export type ProjectionIntegrityResult = {
  valid: boolean;
  failures: ProjectionIntegrityFailureCode[];
  dataDigest: {
    stored: string;
    manifest: string;
    recomputed: string;
  };
  canonicalInputDigest: {
    stored: string;
    manifest: string;
    recomputed: string;
  };
  lineageDigest: {
    stored: string | null;
    recomputed: string;
  };
  counts: {
    products: number;
    offers: number;
    evidence: number;
  };
  canonicalRevision: number;
};

export function verifyProjectionReleaseIntegrity(
  release: ProjectionRelease<ErpPublicProduct>,
  manifest: ProjectionReleaseManifest,
  lineage: readonly ProjectionFieldLineageRecord[]
): ProjectionIntegrityResult {
  const failures: ProjectionIntegrityFailureCode[] = [];
  const recomputedDataDigest = stableDigest(release.data);
  const recomputedCanonicalInputDigest = stableDigest(manifest.canonicalInputs);
  const recomputedLineageDigest = stableRecordSetDigest(lineage);
  const offerCount = release.data.reduce(
    (sum, product) => sum + product.offers.length,
    0
  );
  const canonicalRevision = Math.max(
    0,
    ...manifest.canonicalInputs.map((item) => item.revision)
  );

  if (recomputedDataDigest !== release.dataDigest) {
    failures.push('RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH');
  }
  if (manifest.dataDigest !== release.dataDigest) {
    failures.push('MANIFEST_DATA_DIGEST_MISMATCH');
  }
  if (recomputedCanonicalInputDigest !== manifest.inputDigest) {
    failures.push('MANIFEST_CANONICAL_INPUT_DIGEST_MISMATCH');
  }
  if (manifest.inputDigest !== release.inputDigest) {
    failures.push('RELEASE_INPUT_DIGEST_MISMATCH');
  }
  if (manifest.manifestId !== release.manifestId) {
    failures.push('MANIFEST_ID_MISMATCH');
  }
  if (manifest.releaseId !== release.releaseId) {
    failures.push('RELEASE_ID_MISMATCH');
  }
  if (manifest.projectionId !== release.projectionId) {
    failures.push('PROJECTION_ID_MISMATCH');
  }
  if (manifest.schemaVersion !== release.schemaVersion) {
    failures.push('SCHEMA_VERSION_MISMATCH');
  }
  if (manifest.productCount !== release.data.length) {
    failures.push('PRODUCT_COUNT_MISMATCH');
  }
  if (manifest.offerCount !== offerCount) {
    failures.push('OFFER_COUNT_MISMATCH');
  }
  if (release.canonicalRevision !== canonicalRevision) {
    failures.push('CANONICAL_REVISION_MISMATCH');
  }
  if (manifest.fieldEvidenceCount !== lineage.length) {
    failures.push('EVIDENCE_COUNT_MISMATCH');
  }
  if (!manifest.fieldEvidenceDigest) {
    failures.push('EVIDENCE_DIGEST_MISSING');
  } else if (manifest.fieldEvidenceDigest !== recomputedLineageDigest) {
    failures.push('EVIDENCE_DIGEST_MISMATCH');
  }

  return {
    valid: failures.length === 0,
    failures,
    dataDigest: {
      stored: release.dataDigest,
      manifest: manifest.dataDigest,
      recomputed: recomputedDataDigest
    },
    canonicalInputDigest: {
      stored: release.inputDigest,
      manifest: manifest.inputDigest,
      recomputed: recomputedCanonicalInputDigest
    },
    lineageDigest: {
      stored: manifest.fieldEvidenceDigest ?? null,
      recomputed: recomputedLineageDigest
    },
    counts: {
      products: release.data.length,
      offers: offerCount,
      evidence: lineage.length
    },
    canonicalRevision
  };
}

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
