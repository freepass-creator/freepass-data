import type { ErpPublicProduct, ProjectionRelease, ValidationStatus } from './catalog.js';
import type { CatalogEntityType } from './history.js';

export type ProjectionEvidenceOrigin =
  | 'SOURCE_LINEAGE'
  | 'REVISION_HISTORY';

export type ProjectionCanonicalInput = {
  entityType: CatalogEntityType;
  entityId: string;
  revision: number;
  validationStatus: ValidationStatus;
};

export type ProjectionReleaseManifest = {
  manifestId: string;
  releaseId: string;
  projectionId: string;
  schemaVersion: string;
  generatedAt: string;
  canonicalInputs: ProjectionCanonicalInput[];
  productCount: number;
  offerCount: number;
  fieldEvidenceCount: number;
  fieldEvidenceDigest?: string;
  inputDigest: string;
  dataDigest: string;
};

export type ProjectionFieldLineageRecord = {
  lineageRecordId: string;
  stage: 'CANONICAL_TO_PROJECTION';
  projectionId: string;
  releaseId: string;

  canonical: {
    entityType: CatalogEntityType;
    entityId: string;
    revision: number;
    fieldPath: string;
    value: unknown;
  };

  projection: {
    fieldPath: string;
    value: unknown;
  };

  evidenceOrigin: ProjectionEvidenceOrigin;
  parentLineageRecordId?: string | null;
  revisionRecordId?: string | null;
};

export type ProjectionEvidenceBundle = {
  release: ProjectionRelease<ErpPublicProduct>;
  manifest: ProjectionReleaseManifest;
  lineage: ProjectionFieldLineageRecord[];
};


export type ProjectionDeliveryReceipt = {
  eventId: string;
  eventType: string;
  projectionId: string;
  releaseId: string;
  inputDigest: string;
  dataDigest: string;
  targetRevision: number;
  processedAt: string;
};
