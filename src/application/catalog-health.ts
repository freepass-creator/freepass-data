import type { CatalogStore, ProjectionStore } from '../ports/catalog-store.js';
import { stableDigest, stableRecordSetDigest } from '../shared/stable-digest.js';

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

export type CatalogHealthIssueCode =
  | 'INVALID_CANONICAL_ENTITY'
  | 'MISSING_ASSET_VEHICLE_MODEL'
  | 'MISSING_PRODUCT_VEHICLE_MODEL'
  | 'MISSING_PRODUCT_VEHICLE_ASSET'
  | 'MISSING_OFFER_PRODUCT'
  | 'MISSING_OFFER_POLICY'
  | 'NO_ACTIVE_RELEASE'
  | 'ACTIVE_RELEASE_STATUS_INVALID'
  | 'ACTIVE_RELEASE_MANIFEST_MISSING'
  | 'ACTIVE_RELEASE_MANIFEST_ID_MISMATCH'
  | 'ACTIVE_RELEASE_INPUT_DIGEST_MISMATCH'
  | 'ACTIVE_RELEASE_DATA_DIGEST_MISMATCH'
  | 'ACTIVE_RELEASE_CANONICAL_INPUT_DIGEST_MISMATCH'
  | 'ACTIVE_RELEASE_DATA_PAYLOAD_DIGEST_MISMATCH'
  | 'ACTIVE_RELEASE_PRODUCT_COUNT_MISMATCH'
  | 'ACTIVE_RELEASE_OFFER_COUNT_MISMATCH'
  | 'ACTIVE_RELEASE_EVIDENCE_COUNT_MISMATCH'
  | 'ACTIVE_RELEASE_LINEAGE_DIGEST_MISSING'
  | 'ACTIVE_RELEASE_LINEAGE_CONTENT_DIGEST_MISMATCH';

export type CatalogHealthIssue = {
  code: CatalogHealthIssueCode;
  severity: CatalogHealthIssueSeverity;
  entityType: CatalogHealthEntityType;
  entityId?: string;
  message: string;
};

export type CatalogHealthReport = {
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
    referentialIntegrity: {
      status: CatalogHealthCheckStatus;
      issueCount: number;
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
    evaluated: Array<
      | 'CANONICAL_VALIDATION'
      | 'REFERENTIAL_INTEGRITY'
      | 'ACTIVE_PROJECTION_METADATA'
      | 'ACTIVE_PROJECTION_DATA_PAYLOAD_DIGEST'
      | 'ACTIVE_PROJECTION_CANONICAL_INPUT_DIGEST'
      | 'PROJECTION_LINEAGE_CONTENT_INTEGRITY'
    >;
    notEvaluated: Array<
      | 'PROJECTION_LINEAGE_CONTENT_INTEGRITY'
      | 'CONSISTENT_SNAPSHOT'
      | 'SOURCE_FRESHNESS'
      | 'SOURCE_TO_CANONICAL_PARITY'
      | 'CONSUMER_MIGRATION_STATE'
    >;
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
>;

type CatalogHealthProjectionStore = Pick<
  ProjectionStore,
  'getActive' | 'getManifest' | 'listProjectionLineage'
>;

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
  'ACTIVE_RELEASE_LINEAGE_CONTENT_DIGEST_MISMATCH'
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
  const [models, assets, products, offers, policies, activeRelease] = await Promise.all([
    catalog.listVehicleModels(),
    catalog.listVehicleAssets(),
    catalog.listProducts(),
    catalog.listOffers(),
    catalog.listPolicies(),
    projections.getActive('erp-public')
  ]);

  const issues: CatalogHealthIssue[] = [];
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const productsById = new Map(products.map((product) => [product.id, product]));
  const policiesById = new Map(policies.map((policy) => [policy.id, policy]));

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

    const [manifest, lineage] = await Promise.all([
      projections.getManifest(activeRelease.releaseId),
      projections.listProjectionLineage(activeRelease.releaseId)
    ]);
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
      expectedEvidenceCount = manifest.fieldEvidenceCount;
      storedInputDigest = manifest.inputDigest;
      recomputedInputDigest = stableDigest(manifest.canonicalInputs);
      canonicalInputDigestStatus =
        storedInputDigest === recomputedInputDigest &&
        activeRelease.inputDigest === recomputedInputDigest
          ? 'PASS'
          : 'FAIL';

      if (canonicalInputDigestStatus === 'FAIL') {
        issues.push({
          code: 'ACTIVE_RELEASE_CANONICAL_INPUT_DIGEST_MISMATCH',
          severity: 'ERROR',
          entityType: 'projection',
          entityId: activeRelease.releaseId,
          message: 'Manifest canonicalInputs do not match the stored inputDigest.'
        });
      }

      if (manifest.manifestId !== activeRelease.manifestId) {
        issues.push({
          code: 'ACTIVE_RELEASE_MANIFEST_ID_MISMATCH',
          severity: 'ERROR',
          entityType: 'projection',
          entityId: activeRelease.releaseId,
          message: `Release manifest ID ${activeRelease.manifestId} does not match stored manifest ${manifest.manifestId}.`
        });
      }
      if (manifest.inputDigest !== activeRelease.inputDigest) {
        issues.push({
          code: 'ACTIVE_RELEASE_INPUT_DIGEST_MISMATCH',
          severity: 'ERROR',
          entityType: 'projection',
          entityId: activeRelease.releaseId,
          message: 'ACTIVE release inputDigest does not match its manifest.'
        });
      }
      if (manifest.dataDigest !== activeRelease.dataDigest) {
        issues.push({
          code: 'ACTIVE_RELEASE_DATA_DIGEST_MISMATCH',
          severity: 'ERROR',
          entityType: 'projection',
          entityId: activeRelease.releaseId,
          message: 'ACTIVE release dataDigest does not match its manifest.'
        });
      }
      if (manifest.productCount !== activeRelease.data.length) {
        issues.push({
          code: 'ACTIVE_RELEASE_PRODUCT_COUNT_MISMATCH',
          severity: 'ERROR',
          entityType: 'projection',
          entityId: activeRelease.releaseId,
          message: `Manifest productCount ${manifest.productCount} does not match release data count ${activeRelease.data.length}.`
        });
      }

      const releaseOfferCount = activeRelease.data.reduce(
        (sum, product) => sum + product.offers.length,
        0
      );
      if (manifest.offerCount !== releaseOfferCount) {
        issues.push({
          code: 'ACTIVE_RELEASE_OFFER_COUNT_MISMATCH',
          severity: 'ERROR',
          entityType: 'projection',
          entityId: activeRelease.releaseId,
          message: `Manifest offerCount ${manifest.offerCount} does not match release offer count ${releaseOfferCount}.`
        });
      }

      if (manifest.fieldEvidenceCount !== lineage.length) {
        issues.push({
          code: 'ACTIVE_RELEASE_EVIDENCE_COUNT_MISMATCH',
          severity: 'ERROR',
          entityType: 'projection',
          entityId: activeRelease.releaseId,
          message: `Manifest fieldEvidenceCount ${manifest.fieldEvidenceCount} does not match stored lineage count ${lineage.length}.`
        });
      }

      storedLineageDigest = manifest.fieldEvidenceDigest ?? null;
      recomputedLineageDigest = stableRecordSetDigest(lineage);

      if (!storedLineageDigest) {
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
      } else if (storedLineageDigest !== recomputedLineageDigest) {
        lineageContentIntegrity = {
          stored: storedLineageDigest,
          recomputed: recomputedLineageDigest,
          status: 'FAIL',
          reason: 'Projection lineage content does not match the manifest fieldEvidenceDigest.'
        };
        issues.push({
          code: 'ACTIVE_RELEASE_LINEAGE_CONTENT_DIGEST_MISMATCH',
          severity: 'ERROR',
          entityType: 'projection',
          entityId: activeRelease.releaseId,
          message: lineageContentIntegrity.reason
        });
      } else {
        lineageContentIntegrity = {
          stored: storedLineageDigest,
          recomputed: recomputedLineageDigest,
          status: 'PASS',
          reason: 'Projection lineage content matches the manifest fieldEvidenceDigest.'
        };
      }
    }
  }

  const sortedIssues = sortIssues(issues);
  const invalidIssues = sortedIssues.filter(
    (issue) => issue.code === 'INVALID_CANONICAL_ENTITY'
  );
  const referentialIssues = sortedIssues.filter((issue) =>
    referentialIssueCodes.has(issue.code)
  );
  const projectionIssues = sortedIssues.filter((issue) =>
    projectionIssueCodes.has(issue.code)
  );

  return {
    scope: 'catalog-v1',
    generatedAt: now,
    status: overallStatus(sortedIssues),
    observation: {
      readAt: now,
      consistency: 'PARTIAL_MULTI_READ',
      partialObservation: true,
      canonicalRevisionRange,
      activeReleaseCanonicalRevision: activeRelease?.canonicalRevision ?? null,
      note: 'Catalog entities, ACTIVE release, manifest, and lineage are read through separate non-transactional calls; this report is not an atomic snapshot.'
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
      referentialIntegrity: {
        status: checkStatus(referentialIssues),
        issueCount: referentialIssues.length
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
        'REFERENTIAL_INTEGRITY',
        'ACTIVE_PROJECTION_METADATA',
        'ACTIVE_PROJECTION_DATA_PAYLOAD_DIGEST',
        'ACTIVE_PROJECTION_CANONICAL_INPUT_DIGEST',
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
