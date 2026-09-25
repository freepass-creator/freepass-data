import type {
  ProjectionProduct,
  ProjectionRelease
} from '../domain/catalog.js';
import type {
  ProjectionFieldLineageRecord,
  ProjectionReleaseManifest
} from '../domain/projection-evidence.js';
import { stableDigest, stableRecordSetDigest } from './stable-digest.js';

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
  | 'EVIDENCE_DIGEST_MISMATCH'
  | 'EVIDENCE_RELEASE_ID_MISMATCH'
  | 'EVIDENCE_PROJECTION_ID_MISMATCH'
  | 'EVIDENCE_STAGE_MISMATCH'
  | 'EVIDENCE_RECORD_ID_DUPLICATE';

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

export function verifyProjectionReleaseIntegrity<T extends ProjectionProduct>(
  release: ProjectionRelease<T>,
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
  if (lineage.some((item) => item.releaseId !== release.releaseId)) {
    failures.push('EVIDENCE_RELEASE_ID_MISMATCH');
  }
  if (lineage.some((item) => item.projectionId !== release.projectionId)) {
    failures.push('EVIDENCE_PROJECTION_ID_MISMATCH');
  }
  if (lineage.some((item) => item.stage !== 'CANONICAL_TO_PROJECTION')) {
    failures.push('EVIDENCE_STAGE_MISMATCH');
  }
  if (new Set(lineage.map((item) => item.lineageRecordId)).size !== lineage.length) {
    failures.push('EVIDENCE_RECORD_ID_DUPLICATE');
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


export class ProjectionIntegrityError extends Error {
  constructor(readonly failures: ProjectionIntegrityFailureCode[]) {
    super(`Projection release integrity failed: ${failures.join(', ')}`);
  }
}

export function assertProjectionReleaseIntegrity<T extends ProjectionProduct>(
  release: ProjectionRelease<T>,
  manifest: ProjectionReleaseManifest,
  lineage: readonly ProjectionFieldLineageRecord[]
): ProjectionIntegrityResult {
  const result = verifyProjectionReleaseIntegrity(release, manifest, lineage);
  if (!result.valid) {
    throw new ProjectionIntegrityError(result.failures);
  }
  return result;
}
