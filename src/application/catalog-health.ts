import type { CatalogStore, ProjectionEvidenceSnapshotStore, ProjectionStore } from '../ports/catalog-store.js';
import { stableDigest } from '../shared/stable-digest.js';
import { readActiveProjectionEvidence } from './projection-evidence-reader.js';
import { verifyProjectionReleaseIntegrity } from '../shared/projection-integrity.js';

export type CatalogHealthStatus = 'HEALTHY' | 'DEGRADED' | 'BLOCKED';
export type CatalogHealthCheckStatus = 'PASS' | 'WARN' | 'FAIL';
export type CatalogHealthIssueSeverity = 'WARNING' | 'ERROR';
export type CatalogHealthEntityType =
  | 'vehicle_model'
  | 'vehicle_asset'
  | 'product'
  | 'offer'
  | 'policy'
  | 'projection';

export const CATALOG_DATA_HEALTH_CONTRACT_VERSION =
  'catalog-data-health-v1' as const;
export const CATALOG_DATA_HEALTH_SCHEMA_VERSION = '1.0.0' as const;

export const CATALOG_HEALTH_EVALUATED_DIMENSIONS = [
  'CANONICAL_VALIDATION',
  'CANONICAL_REVISION_INTEGRITY',
  'REFERENTIAL_INTEGRITY',
  'ACTIVE_PROJECTION_METADATA',
  'ACTIVE_PROJECTION_DATA_PAYLOAD_DIGEST',
  'ACTIVE_PROJECTION_CANONICAL_INPUT_DIGEST',
  'ACTIVE_PROJECTION_INPUT_PARITY',
  'PROJECTION_LINEAGE_CONTENT_INTEGRITY'
] as const;

export const CATALOG_HEALTH_NOT_EVALUATED_DIMENSIONS = [
  'PROJECTION_LINEAGE_CONTENT_INTEGRITY',
  'CONSISTENT_SNAPSHOT',
  'SOURCE_FRESHNESS',
  'SOURCE_TO_CANONICAL_PARITY',
  'CONSUMER_MIGRATION_STATE'
] as const;

export type CatalogHealthEvaluatedDimension =
  typeof CATALOG_HEALTH_EVALUATED_DIMENSIONS[number];
export type CatalogHealthNotEvaluatedDimension =
  typeof CATALOG_HEALTH_NOT_EVALUATED_DIMENSIONS[number];

export const CATALOG_HEALTH_ISSUE_CODES = [
  'INVALID_CANONICAL_ENTITY',
  'MISSING_ASSET_VEHICLE_MODEL',
  'MISSING_PRODUCT_VEHICLE_MODEL',
  'MISSING_PRODUCT_VEHICLE_ASSET',
  'MISSING_OFFER_PRODUCT',
  'MISSING_OFFER_POLICY',
  'NO_ACTIVE_RELEASE',
  'ACTIVE_RELEASE_STATUS_INVALID',
  'ACTIVE_RELEASE_MANIFEST_MISSING',
  'ACTIVE_RELEASE_MANIFEST_ID_MISMATCH',
  'ACTIVE_RELEASE_INPUT_DIGEST_MISMATCH',
  'ACTIVE_RELEASE_DATA_DIGEST_MISMATCH',
  'ACTIVE_RELEASE_CANONICAL_INPUT_DIGEST_MISMATCH',
  'ACTIVE_RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH',
  'ACTIVE_RELEASE_PRODUCT_COUNT_MISMATCH',
  'ACTIVE_RELEASE_OFFER_COUNT_MISMATCH',
  'ACTIVE_RELEASE_EVIDENCE_COUNT_MISMATCH',
  'ACTIVE_RELEASE_LINEAGE_DIGEST_MISSING',
  'ACTIVE_RELEASE_LINEAGE_CONTENT_DIGEST_MISMATCH',
  'ACTIVE_RELEASE_RELEASE_ID_MISMATCH',
  'ACTIVE_RELEASE_PROJECTION_ID_MISMATCH',
  'ACTIVE_RELEASE_SCHEMA_VERSION_MISMATCH',
  'ACTIVE_RELEASE_CANONICAL_REVISION_MISMATCH',
  'ACTIVE_RELEASE_CANONICAL_INPUT_MISSING',
  'ACTIVE_RELEASE_CANONICAL_INPUT_STALE',
  'ACTIVE_RELEASE_CANONICAL_INPUT_AHEAD',
  'ACTIVE_RELEASE_CANONICAL_INPUT_VALIDATION_MISMATCH',
  'CANONICAL_REVISION_SNAPSHOT_MISSING',
  'CANONICAL_REVISION_SNAPSHOT_DRIFT',
  'ACTIVE_RELEASE_CHANGED_DURING_OBSERVATION',
] as const;

export type CatalogHealthIssueCode =
  typeof CATALOG_HEALTH_ISSUE_CODES[number];

export type CatalogHealthIssue = {
  code: CatalogHealthIssueCode;
  severity: CatalogHealthIssueSeverity;
  entityType: CatalogHealthEntityType;
  entityId?: string;
  message: string;
};

export type CatalogHealthReport = {
  contractVersion: typeof CATALOG_DATA_HEALTH_CONTRACT_VERSION;
  schemaVersion: typeof CATALOG_DATA_HEALTH_SCHEMA_VERSION;
  scope: 'catalog-v1';
  generatedAt: string;
  status: CatalogHealthStatus;
  observation: {
    readAt: string;
    consistency: 'PARTIAL_MULTI_READ';
    partialObservation: true;
    canonicalRevisionRange: {
      min: number | null;
      max: number | null;
    };
    activeReleaseCanonicalRevision: number | null;
    startActiveReleaseId: string | null;
    endActiveReleaseId: string | null;
    activeReleaseStable: boolean;
    projectionEvidenceConsistency: 'ATOMIC' | 'PARTIAL_MULTI_READ';
    note: string;
  };
  counts: {
    vehicleModels: number;
    vehicleAssets: number;
    products: number;
    offers: number;
    policies: number;
    invalidCanonicalEntities: number;
  };
  checks: {
    canonicalValidation: {
      status: CatalogHealthCheckStatus;
      invalidEntityCount: number;
    };
    canonicalRevisionIntegrity: {
      status: CatalogHealthCheckStatus;
      missingSnapshotCount: number;
      driftCount: number;
    };
    referentialIntegrity: {
      status: CatalogHealthCheckStatus;
      issueCount: number;
    };
    activeInputParity: {
      status: CatalogHealthCheckStatus;
      missingCount: number;
      staleRevisionCount: number;
      aheadRevisionCount: number;
      validationMismatchCount: number;
    };
    activeProjection: {
      status: CatalogHealthCheckStatus;
      projectionId: 'erp-public';
      activeReleaseId: string | null;
      releaseStatus: string | null;
      manifestId: string | null;
      manifestPresent: boolean;
      productCount: number | null;
      expectedEvidenceCount: number | null;
      actualEvidenceCount: number | null;
      dataPayloadDigest: {
        stored: string | null;
        recomputed: string | null;
        status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
      };
      canonicalInputDigest: {
        stored: string | null;
        recomputed: string | null;
        status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
      };
      lineageContentIntegrity: {
        stored: string | null;
        recomputed: string | null;
        status: 'PASS' | 'FAIL' | 'NOT_EVALUATED' | 'NOT_APPLICABLE';
        reason: string;
      };
    };
  };
  coverage: {
    evaluated: CatalogHealthEvaluatedDimension[];
    notEvaluated: CatalogHealthNotEvaluatedDimension[];
  };
  issues: CatalogHealthIssue[];
};

type CatalogHealthCatalogStore = Pick<
  CatalogStore,
  | 'listVehicleModels'
  | 'listVehicleAssets'
  | 'listProducts'
  | 'listOffers'
  | 'listPolicies'
  | 'listRevisionHistory'
>;

type CatalogHealthProjectionStore = Pick<
  ProjectionStore,
  'getActive' | 'getManifest' | 'listProjectionLineage'
> & Partial<ProjectionEvidenceSnapshotStore>;

const referentialIssueCodes = new Set<CatalogHealthIssueCode>([
  'MISSING_ASSET_VEHICLE_MODEL',
  'MISSING_PRODUCT_VEHICLE_MODEL',
  'MISSING_PRODUCT_VEHICLE_ASSET',
  'MISSING_OFFER_PRODUCT',
  'MISSING_OFFER_POLICY'
]);

const projectionIssueCodes = new Set<CatalogHealthIssueCode>([
  'NO_ACTIVE_RELEASE',
  'ACTIVE_RELEASE_STATUS_INVALID',
  'ACTIVE_RELEASE_MANIFEST_MISSING',
  'ACTIVE_RELEASE_MANIFEST_ID_MISMATCH',
  'ACTIVE_RELEASE_INPUT_DIGEST_MISMATCH',
  'ACTIVE_RELEASE_DATA_DIGEST_MISMATCH',
  'ACTIVE_RELEASE_CANONICAL_INPUT_DIGEST_MISMATCH',
  'ACTIVE_RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH',
  'ACTIVE_RELEASE_PRODUCT_COUNT_MISMATCH',
  'ACTIVE_RELEASE_OFFER_COUNT_MISMATCH',
  'ACTIVE_RELEASE_EVIDENCE_COUNT_MISMATCH',
  'ACTIVE_RELEASE_LINEAGE_DIGEST_MISSING',
  'ACTIVE_RELEASE_LINEAGE_CONTENT_DIGEST_MISMATCH',
  'ACTIVE_RELEASE_RELEASE_ID_MISMATCH',
  'ACTIVE_RELEASE_PROJECTION_ID_MISMATCH',
  'ACTIVE_RELEASE_SCHEMA_VERSION_MISMATCH',
  'ACTIVE_RELEASE_CANONICAL_REVISION_MISMATCH',
  'ACTIVE_RELEASE_CANONICAL_INPUT_MISSING',
  'ACTIVE_RELEASE_CANONICAL_INPUT_STALE',
  'ACTIVE_RELEASE_CANONICAL_INPUT_AHEAD',
  'ACTIVE_RELEASE_CANONICAL_INPUT_VALIDATION_MISMATCH',
  'ACTIVE_RELEASE_CHANGED_DURING_OBSERVATION'
]);

function checkStatus(issues: CatalogHealthIssue[]): CatalogHealthCheckStatus {
  if (issues.some((issue) => issue.severity === 'ERROR')) return 'FAIL';
  if (issues.length > 0) return 'WARN';
  return 'PASS';
}

function overallStatus(issues: CatalogHealthIssue[]): CatalogHealthStatus {
  if (issues.some((issue) => issue.severity === 'ERROR')) return 'BLOCKED';
  if (issues.length > 0) return 'DEGRADED';
  return 'HEALTHY';
}

function sortIssues(issues: CatalogHealthIssue[]) {
  return issues.sort((a, b) =>
    a.code.localeCompare(b.code) ||
    a.entityType.localeCompare(b.entityType) ||
    (a.entityId ?? '').localeCompare(b.entityId ?? '')
  );
}

export async function readCatalogDataHealth(
  catalog: CatalogHealthCatalogStore,
  projections: CatalogHealthProjectionStore,
  now = new Date().toISOString()
): Promise<CatalogHealthReport> {
  const [
    models,
    assets,
    products,
    offers,
    policies,
    revisionHistory,
    projectionEvidence
  ] = await Promise.all([
    catalog.listVehicleModels(),
    catalog.listVehicleAssets(),
    catalog.listProducts(),
    catalog.listOffers(),
    catalog.listPolicies(),
    catalog.listRevisionHistory(),
    readActiveProjectionEvidence(projections, 'erp-public')
  ]);
  const activeRelease = projectionEvidence.release;

  const issues: CatalogHealthIssue[] = [];
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const productsById = new Map(products.map((product) => [product.id, product]));
  const policiesById = new Map(policies.map((policy) => [policy.id, policy]));
  const currentCanonicalByKey = new Map<string, {
    revision: number;
    validationStatus: string;
    value: unknown;
  }>();
  for (const item of models) {
    currentCanonicalByKey.set(`vehicle_model|${item.id}`, {
      revision: item.revision,
      validationStatus: item.validationStatus,
      value: item
    });
  }
  for (const item of assets) {
    currentCanonicalByKey.set(`vehicle_asset|${item.id}`, {
      revision: item.revision,
      validationStatus: item.validationStatus,
      value: item
    });
  }
  for (const item of products) {
    currentCanonicalByKey.set(`product|${item.id}`, {
      revision: item.revision,
      validationStatus: item.validationStatus,
      value: item
    });
  }
  for (const item of offers) {
    currentCanonicalByKey.set(`offer|${item.id}`, {
      revision: item.revision,
      validationStatus: item.validationStatus,
      value: item
    });
  }
  for (const item of policies) {
    currentCanonicalByKey.set(`policy|${item.id}`, {
      revision: item.revision,
      validationStatus: item.validationStatus,
      value: item
    });
  }

  const revisionByKey = new Map(
    revisionHistory.map((record) => [
      `${record.entityType}|${record.entityId}|${record.revision}`,
      record
    ])
  );
  let canonicalRevisionSnapshotMissingCount = 0;
  let canonicalRevisionSnapshotDriftCount = 0;

  for (const [key, current] of currentCanonicalByKey) {
    const revisionKey = `${key}|${current.revision}`;
    const revision = revisionByKey.get(revisionKey);
    if (!revision) {
      canonicalRevisionSnapshotMissingCount += 1;
      const [entityType, entityId] = key.split('|');
      issues.push({
        code: 'CANONICAL_REVISION_SNAPSHOT_MISSING',
        severity: 'ERROR',
        entityType: (entityType ?? 'product') as CatalogHealthEntityType,
        ...(entityId ? { entityId } : {}),
        message: `Current Canonical ${key} r${current.revision} has no matching revision snapshot.`
      });
      continue;
    }
    if (stableDigest(revision.snapshot) !== stableDigest(current.value)) {
      canonicalRevisionSnapshotDriftCount += 1;
      const [entityType, entityId] = key.split('|');
      issues.push({
        code: 'CANONICAL_REVISION_SNAPSHOT_DRIFT',
        severity: 'ERROR',
        entityType: (entityType ?? 'product') as CatalogHealthEntityType,
        ...(entityId ? { entityId } : {}),
        message: `Current Canonical ${key} r${current.revision} differs from its immutable revision snapshot.`
      });
    }
  }

  const recordInvalid = (
    entityType: Exclude<CatalogHealthEntityType, 'projection'>,
    entityId: string
  ) => {
    issues.push({
      code: 'INVALID_CANONICAL_ENTITY',
      severity: 'WARNING',
      entityType,
      entityId,
      message: `${entityType} ${entityId} is INVALID and cannot be treated as healthy Canonical data.`
    });
  };

  for (const model of models) {
    if (model.validationStatus === 'INVALID') recordInvalid('vehicle_model', model.id);
  }

  for (const asset of assets) {
    if (asset.validationStatus === 'INVALID') recordInvalid('vehicle_asset', asset.id);
    if (!modelsById.has(asset.vehicleModelId)) {
      issues.push({
        code: 'MISSING_ASSET_VEHICLE_MODEL',
        severity: 'ERROR',
        entityType: 'vehicle_asset',
        entityId: asset.id,
        message: `VehicleAsset ${asset.id} references missing VehicleModel ${asset.vehicleModelId}.`
      });
    }
  }

  for (const product of products) {
    if (product.validationStatus === 'INVALID') recordInvalid('product', product.id);
    if (!modelsById.has(product.vehicleModelId)) {
      issues.push({
        code: 'MISSING_PRODUCT_VEHICLE_MODEL',
        severity: 'ERROR',
        entityType: 'product',
        entityId: product.id,
        message: `Product ${product.id} references missing VehicleModel ${product.vehicleModelId}.`
      });
    }
    if (product.vehicleAssetId && !assetsById.has(product.vehicleAssetId)) {
      issues.push({
        code: 'MISSING_PRODUCT_VEHICLE_ASSET',
        severity: 'ERROR',
        entityType: 'product',
        entityId: product.id,
        message: `Product ${product.id} references missing VehicleAsset ${product.vehicleAssetId}.`
      });
    }
  }

  for (const offer of offers) {
    if (offer.validationStatus === 'INVALID') recordInvalid('offer', offer.id);
    if (!productsById.has(offer.productId)) {
      issues.push({
        code: 'MISSING_OFFER_PRODUCT',
        severity: 'ERROR',
        entityType: 'offer',
        entityId: offer.id,
        message: `Offer ${offer.id} references missing Product ${offer.productId}.`
      });
    }
    if (offer.policyId && !policiesById.has(offer.policyId)) {
      issues.push({
        code: 'MISSING_OFFER_POLICY',
        severity: 'ERROR',
        entityType: 'offer',
        entityId: offer.id,
        message: `Offer ${offer.id} references missing Policy ${offer.policyId}.`
      });
    }
  }

  for (const policy of policies) {
    if (policy.validationStatus === 'INVALID') recordInvalid('policy', policy.id);
  }

  const canonicalRevisions = [
    ...models.map((item) => item.revision),
    ...assets.map((item) => item.revision),
    ...products.map((item) => item.revision),
    ...offers.map((item) => item.revision),
    ...policies.map((item) => item.revision)
  ];
  const canonicalRevisionRange = {
    min: canonicalRevisions.length ? Math.min(...canonicalRevisions) : null,
    max: canonicalRevisions.length ? Math.max(...canonicalRevisions) : null
  };

  let manifestId: string | null = null;
  let manifestPresent = false;
  let productCount: number | null = null;
  let expectedEvidenceCount: number | null = null;
  let actualEvidenceCount: number | null = null;
  let storedDataDigest: string | null = null;
  let recomputedDataDigest: string | null = null;
  let dataPayloadDigestStatus: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';
  let storedInputDigest: string | null = null;
  let recomputedInputDigest: string | null = null;
  let canonicalInputDigestStatus: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';
  let activeInputMissingCount = 0;
  let activeInputStaleRevisionCount = 0;
  let activeInputAheadRevisionCount = 0;
  let activeInputValidationMismatchCount = 0;
    let storedLineageDigest: string | null = null;
  let recomputedLineageDigest: string | null = null;
  let lineageContentIntegrity: {
    stored: string | null;
    recomputed: string | null;
    status: 'PASS' | 'FAIL' | 'NOT_EVALUATED' | 'NOT_APPLICABLE';
    reason: string;
  } = {
    stored: null,
    recomputed: null,
    status: 'NOT_APPLICABLE',
    reason: 'No ACTIVE release is available.'
  };

  if (!activeRelease) {
    issues.push({
      code: 'NO_ACTIVE_RELEASE',
      severity: 'WARNING',
      entityType: 'projection',
      message: 'ERP public projection has no ACTIVE release.'
    });
  } else {
    manifestId = activeRelease.manifestId;
    productCount = activeRelease.data.length;
    storedDataDigest = activeRelease.dataDigest;
    recomputedDataDigest = stableDigest(activeRelease.data);
    dataPayloadDigestStatus =
      storedDataDigest === recomputedDataDigest ? 'PASS' : 'FAIL';

    if (dataPayloadDigestStatus === 'FAIL') {
      issues.push({
        code: 'ACTIVE_RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH',
        severity: 'ERROR',
        entityType: 'projection',
        entityId: activeRelease.releaseId,
        message: 'ACTIVE release data payload does not match its stored dataDigest.'
      });
    }

    if (activeRelease.status !== 'ACTIVE') {
      issues.push({
        code: 'ACTIVE_RELEASE_STATUS_INVALID',
        severity: 'ERROR',
        entityType: 'projection',
        entityId: activeRelease.releaseId,
        message: `Active projection pointer resolved to release status ${activeRelease.status}.`
      });
    }

    const manifest = projectionEvidence.manifest;
    const lineage = projectionEvidence.lineage;
    actualEvidenceCount = lineage.length;

    if (!manifest) {
      issues.push({
        code: 'ACTIVE_RELEASE_MANIFEST_MISSING',
        severity: 'ERROR',
        entityType: 'projection',
        entityId: activeRelease.releaseId,
        message: 'ACTIVE release has no Projection Release Manifest.'
      });
      lineageContentIntegrity = {
        stored: null,
        recomputed: null,
        status: 'NOT_EVALUATED',
        reason: 'Projection lineage content cannot be authenticated without a manifest.'
      };
    } else {
      manifestPresent = true;

      for (const input of manifest.canonicalInputs) {
        const current = currentCanonicalByKey.get(
          `${input.entityType}|${input.entityId}`
        );
        if (!current) {
          activeInputMissingCount += 1;
          issues.push({
            code: 'ACTIVE_RELEASE_CANONICAL_INPUT_MISSING',
            severity: 'ERROR',
            entityType: 'projection',
            entityId: activeRelease.releaseId,
            message: `ACTIVE release input ${input.entityType} ${input.entityId} is missing from current Canonical state.`
          });
          continue;
        }
        if (current.revision > input.revision) {
          activeInputStaleRevisionCount += 1;
          issues.push({
            code: 'ACTIVE_RELEASE_CANONICAL_INPUT_STALE',
            severity: 'WARNING',
            entityType: 'projection',
            entityId: activeRelease.releaseId,
            message: `ACTIVE release input ${input.entityType} ${input.entityId} is r${input.revision}, current Canonical is newer at r${current.revision}.`
          });
        } else if (current.revision < input.revision) {
          activeInputAheadRevisionCount += 1;
          issues.push({
            code: 'ACTIVE_RELEASE_CANONICAL_INPUT_AHEAD',
            severity: 'ERROR',
            entityType: 'projection',
            entityId: activeRelease.releaseId,
            message: `ACTIVE release input ${input.entityType} ${input.entityId} is r${input.revision}, ahead of current Canonical r${current.revision}.`
          });
        }
        if (current.validationStatus !== input.validationStatus) {
          activeInputValidationMismatchCount += 1;
          issues.push({
            code: 'ACTIVE_RELEASE_CANONICAL_INPUT_VALIDATION_MISMATCH',
            severity: 'WARNING',
            entityType: 'projection',
            entityId: activeRelease.releaseId,
            message: `ACTIVE release input ${input.entityType} ${input.entityId} validationStatus ${input.validationStatus} differs from current Canonical ${current.validationStatus}.`
          });
        }
      }

      const integrity = verifyProjectionReleaseIntegrity(
        activeRelease,
        manifest,
        lineage
      );

      expectedEvidenceCount = manifest.fieldEvidenceCount;
      actualEvidenceCount = integrity.counts.evidence;
      storedDataDigest = integrity.dataDigest.stored;
      recomputedDataDigest = integrity.dataDigest.recomputed;
      dataPayloadDigestStatus = integrity.failures.includes(
        'RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH'
      ) ? 'FAIL' : 'PASS';
      storedInputDigest = integrity.canonicalInputDigest.manifest;
      recomputedInputDigest = integrity.canonicalInputDigest.recomputed;
      canonicalInputDigestStatus = (
        integrity.failures.includes('MANIFEST_CANONICAL_INPUT_DIGEST_MISMATCH') ||
        integrity.failures.includes('RELEASE_INPUT_DIGEST_MISMATCH')
      ) ? 'FAIL' : 'PASS';
      storedLineageDigest = integrity.lineageDigest.stored;
      recomputedLineageDigest = integrity.lineageDigest.recomputed;

      const addProjectionError = (
        code: CatalogHealthIssueCode,
        message: string
      ) => issues.push({
        code,
        severity: 'ERROR',
        entityType: 'projection',
        entityId: activeRelease.releaseId,
        message
      });

      for (const failure of integrity.failures) {
        switch (failure) {
          case 'RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH':
            if (!issues.some((issue) =>
              issue.code === 'ACTIVE_RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH' &&
              issue.entityId === activeRelease.releaseId
            )) {
              addProjectionError(
                'ACTIVE_RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH',
                'ACTIVE release data payload does not match its stored dataDigest.'
              );
            }
            break;
          case 'MANIFEST_DATA_DIGEST_MISMATCH':
            addProjectionError(
              'ACTIVE_RELEASE_DATA_DIGEST_MISMATCH',
              'ACTIVE release dataDigest does not match its manifest.'
            );
            break;
          case 'MANIFEST_CANONICAL_INPUT_DIGEST_MISMATCH':
            addProjectionError(
              'ACTIVE_RELEASE_CANONICAL_INPUT_DIGEST_MISMATCH',
              'Manifest canonicalInputs do not match the stored inputDigest.'
            );
            break;
          case 'RELEASE_INPUT_DIGEST_MISMATCH':
            addProjectionError(
              'ACTIVE_RELEASE_INPUT_DIGEST_MISMATCH',
              'ACTIVE release inputDigest does not match its manifest.'
            );
            break;
          case 'MANIFEST_ID_MISMATCH':
            addProjectionError(
              'ACTIVE_RELEASE_MANIFEST_ID_MISMATCH',
              `Release manifest ID ${activeRelease.manifestId} does not match stored manifest ${manifest.manifestId}.`
            );
            break;
          case 'RELEASE_ID_MISMATCH':
            addProjectionError(
              'ACTIVE_RELEASE_RELEASE_ID_MISMATCH',
              `Manifest releaseId ${manifest.releaseId} does not match ACTIVE release ${activeRelease.releaseId}.`
            );
            break;
          case 'PROJECTION_ID_MISMATCH':
            addProjectionError(
              'ACTIVE_RELEASE_PROJECTION_ID_MISMATCH',
              `Manifest projectionId ${manifest.projectionId} does not match release projectionId ${activeRelease.projectionId}.`
            );
            break;
          case 'SCHEMA_VERSION_MISMATCH':
            addProjectionError(
              'ACTIVE_RELEASE_SCHEMA_VERSION_MISMATCH',
              `Manifest schemaVersion ${manifest.schemaVersion} does not match release schemaVersion ${activeRelease.schemaVersion}.`
            );
            break;
          case 'PRODUCT_COUNT_MISMATCH':
            addProjectionError(
              'ACTIVE_RELEASE_PRODUCT_COUNT_MISMATCH',
              `Manifest productCount ${manifest.productCount} does not match release data count ${integrity.counts.products}.`
            );
            break;
          case 'OFFER_COUNT_MISMATCH':
            addProjectionError(
              'ACTIVE_RELEASE_OFFER_COUNT_MISMATCH',
              `Manifest offerCount ${manifest.offerCount} does not match release offer count ${integrity.counts.offers}.`
            );
            break;
          case 'CANONICAL_REVISION_MISMATCH':
            addProjectionError(
              'ACTIVE_RELEASE_CANONICAL_REVISION_MISMATCH',
              `ACTIVE canonicalRevision ${activeRelease.canonicalRevision} does not match manifest canonical revision ${integrity.canonicalRevision}.`
            );
            break;
          case 'EVIDENCE_COUNT_MISMATCH':
            addProjectionError(
              'ACTIVE_RELEASE_EVIDENCE_COUNT_MISMATCH',
              `Manifest fieldEvidenceCount ${manifest.fieldEvidenceCount} does not match stored lineage count ${integrity.counts.evidence}.`
            );
            break;
          case 'EVIDENCE_DIGEST_MISSING':
            lineageContentIntegrity = {
              stored: null,
              recomputed: recomputedLineageDigest,
              status: 'NOT_EVALUATED',
              reason: 'ProjectionReleaseManifest has no fieldEvidenceDigest; legacy evidence content cannot be authenticated.'
            };
            issues.push({
              code: 'ACTIVE_RELEASE_LINEAGE_DIGEST_MISSING',
              severity: 'WARNING',
              entityType: 'projection',
              entityId: activeRelease.releaseId,
              message: lineageContentIntegrity.reason
            });
            break;
          case 'EVIDENCE_DIGEST_MISMATCH':
            lineageContentIntegrity = {
              stored: storedLineageDigest,
              recomputed: recomputedLineageDigest,
              status: 'FAIL',
              reason: 'Projection lineage content does not match the manifest fieldEvidenceDigest.'
            };
            addProjectionError(
              'ACTIVE_RELEASE_LINEAGE_CONTENT_DIGEST_MISMATCH',
              lineageContentIntegrity.reason
            );
            break;
        }
      }

      if (
        !integrity.failures.includes('EVIDENCE_DIGEST_MISSING') &&
        !integrity.failures.includes('EVIDENCE_DIGEST_MISMATCH')
      ) {
        lineageContentIntegrity = {
          stored: storedLineageDigest,
          recomputed: recomputedLineageDigest,
          status: 'PASS',
          reason: 'Projection lineage content matches the manifest fieldEvidenceDigest.'
        };
      }
    }
  }

  const finalActiveRelease = await projections.getActive('erp-public');
  const startActiveReleaseId = activeRelease?.releaseId ?? null;
  const endActiveReleaseId = finalActiveRelease?.releaseId ?? null;
  const activeReleaseStable = startActiveReleaseId === endActiveReleaseId;

  if (!activeReleaseStable) {
    const changedReleaseId = endActiveReleaseId ?? startActiveReleaseId;
    issues.push({
      code: 'ACTIVE_RELEASE_CHANGED_DURING_OBSERVATION',
      severity: 'WARNING',
      entityType: 'projection',
      ...(changedReleaseId ? { entityId: changedReleaseId } : {}),
      message: `ACTIVE release changed during health observation: ${startActiveReleaseId ?? 'none'} -> ${endActiveReleaseId ?? 'none'}.`
    });
  }

  const sortedIssues = sortIssues(issues);
  const invalidIssues = sortedIssues.filter(
    (issue) => issue.code === 'INVALID_CANONICAL_ENTITY'
  );
  const canonicalRevisionIntegrityIssues = sortedIssues.filter((issue) =>
    issue.code === 'CANONICAL_REVISION_SNAPSHOT_MISSING' ||
    issue.code === 'CANONICAL_REVISION_SNAPSHOT_DRIFT'
  );
  const referentialIssues = sortedIssues.filter((issue) =>
    referentialIssueCodes.has(issue.code)
  );
  const projectionIssues = sortedIssues.filter((issue) =>
    projectionIssueCodes.has(issue.code)
  );
  const activeInputParityIssues = sortedIssues.filter((issue) =>
    issue.code === 'ACTIVE_RELEASE_CANONICAL_INPUT_MISSING' ||
    issue.code === 'ACTIVE_RELEASE_CANONICAL_INPUT_STALE' ||
    issue.code === 'ACTIVE_RELEASE_CANONICAL_INPUT_AHEAD' ||
    issue.code === 'ACTIVE_RELEASE_CANONICAL_INPUT_VALIDATION_MISMATCH'
  );

  return {
    contractVersion: CATALOG_DATA_HEALTH_CONTRACT_VERSION,
    schemaVersion: CATALOG_DATA_HEALTH_SCHEMA_VERSION,
    scope: 'catalog-v1',
    generatedAt: now,
    status: overallStatus(sortedIssues),
    observation: {
      readAt: now,
      consistency: 'PARTIAL_MULTI_READ',
      partialObservation: true,
      canonicalRevisionRange,
      activeReleaseCanonicalRevision: activeRelease?.canonicalRevision ?? null,
      startActiveReleaseId,
      endActiveReleaseId,
      activeReleaseStable,
      projectionEvidenceConsistency: projectionEvidence.consistency,
      note: activeReleaseStable
        ? 'Catalog entities, ACTIVE release, manifest, and lineage are read through separate non-transactional calls; this report is not an atomic snapshot.'
        : 'ACTIVE release changed between the opening and closing fence reads; the observation is mixed and must not be treated as a stable snapshot.'
    },
    counts: {
      vehicleModels: models.length,
      vehicleAssets: assets.length,
      products: products.length,
      offers: offers.length,
      policies: policies.length,
      invalidCanonicalEntities: invalidIssues.length
    },
    checks: {
      canonicalValidation: {
        status: checkStatus(invalidIssues),
        invalidEntityCount: invalidIssues.length
      },
      canonicalRevisionIntegrity: {
        status: checkStatus(canonicalRevisionIntegrityIssues),
        missingSnapshotCount: canonicalRevisionSnapshotMissingCount,
        driftCount: canonicalRevisionSnapshotDriftCount
      },
      referentialIntegrity: {
        status: checkStatus(referentialIssues),
        issueCount: referentialIssues.length
      },
      activeInputParity: {
        status: checkStatus(activeInputParityIssues),
        missingCount: activeInputMissingCount,
        staleRevisionCount: activeInputStaleRevisionCount,
        aheadRevisionCount: activeInputAheadRevisionCount,
        validationMismatchCount: activeInputValidationMismatchCount
      },
      activeProjection: {
        status: checkStatus(projectionIssues),
        projectionId: 'erp-public',
        activeReleaseId: activeRelease?.releaseId ?? null,
        releaseStatus: activeRelease?.status ?? null,
        manifestId,
        manifestPresent,
        productCount,
        expectedEvidenceCount,
        actualEvidenceCount,
        dataPayloadDigest: {
          stored: storedDataDigest,
          recomputed: recomputedDataDigest,
          status: dataPayloadDigestStatus
        },
        canonicalInputDigest: {
          stored: storedInputDigest,
          recomputed: recomputedInputDigest,
          status: canonicalInputDigestStatus
        },
        lineageContentIntegrity
      }
    },
    coverage: {
      evaluated: [
        'CANONICAL_VALIDATION',
        'CANONICAL_REVISION_INTEGRITY',
        'REFERENTIAL_INTEGRITY',
        'ACTIVE_PROJECTION_METADATA',
        'ACTIVE_PROJECTION_DATA_PAYLOAD_DIGEST',
        'ACTIVE_PROJECTION_CANONICAL_INPUT_DIGEST',
        'ACTIVE_PROJECTION_INPUT_PARITY',
        ...(lineageContentIntegrity.status === 'PASS' || lineageContentIntegrity.status === 'FAIL'
          ? ['PROJECTION_LINEAGE_CONTENT_INTEGRITY' as const]
          : [])
      ],
      notEvaluated: [
        ...(lineageContentIntegrity.status === 'NOT_EVALUATED'
          ? ['PROJECTION_LINEAGE_CONTENT_INTEGRITY' as const]
          : []),
        'CONSISTENT_SNAPSHOT',
        'SOURCE_FRESHNESS',
        'SOURCE_TO_CANONICAL_PARITY',
        'CONSUMER_MIGRATION_STATE'
      ]
    },
    issues: sortedIssues
  };
}
