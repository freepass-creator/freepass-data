import type { CatalogStore, ProjectionStore } from '../ports/catalog-store.js';

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
  | 'ACTIVE_RELEASE_PRODUCT_COUNT_MISMATCH'
  | 'ACTIVE_RELEASE_OFFER_COUNT_MISMATCH'
  | 'ACTIVE_RELEASE_EVIDENCE_COUNT_MISMATCH';

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
    };
  };
  coverage: {
    evaluated: Array<
      'CANONICAL_VALIDATION'
      | 'REFERENTIAL_INTEGRITY'
      | 'ACTIVE_PROJECTION_EVIDENCE'
    >;
    notEvaluated: Array<
      'SOURCE_FRESHNESS'
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
  'ACTIVE_RELEASE_PRODUCT_COUNT_MISMATCH',
  'ACTIVE_RELEASE_OFFER_COUNT_MISMATCH',
  'ACTIVE_RELEASE_EVIDENCE_COUNT_MISMATCH'
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

  let manifestId: string | null = null;
  let manifestPresent = false;
  let productCount: number | null = null;
  let expectedEvidenceCount: number | null = null;
  let actualEvidenceCount: number | null = null;

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
    } else {
      manifestPresent = true;
      expectedEvidenceCount = manifest.fieldEvidenceCount;

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
        actualEvidenceCount
      }
    },
    coverage: {
      evaluated: [
        'CANONICAL_VALIDATION',
        'REFERENTIAL_INTEGRITY',
        'ACTIVE_PROJECTION_EVIDENCE'
      ],
      notEvaluated: [
        'SOURCE_FRESHNESS',
        'SOURCE_TO_CANONICAL_PARITY',
        'CONSUMER_MIGRATION_STATE'
      ]
    },
    issues: sortedIssues
  };
}
