import { randomUUID } from 'node:crypto';
import { stableDigest, stableRecordSetDigest } from '../shared/stable-digest.js';
import { readActiveProjectionEvidence } from './projection-evidence-reader.js';
import { verifyProjectionReleaseIntegrity } from '../shared/projection-integrity.js';
import { buildProjectionEvidenceContext } from './catalog.js';
import type {
  AdminCatalogProduct,
  AdminPolicyValue,
  Offer,
  Policy,
  ProjectionRelease,
} from '../domain/catalog.js';
import type { CatalogStore, ProjectionStore } from '../ports/catalog-store.js';
import type { ProjectionReleaseManifest } from '../domain/projection-evidence.js';

const MONEY_KEYS = new Set([
  'mileage_upcharge_per_10000km',
  'additional_driver_cost',
  'age_lowering_cost',
  'succession_fee',
  'own_damage_min_deductible',
  'own_damage_max_deductible',
  'self_body_deductible',
  'property_deductible',
  'injury_deductible',
  'over_mileage_rate_domestic',
  'over_mileage_rate_imported',
  'over_mileage_rate_per_km',
]);
const PERCENT_KEYS = new Set([
  'early_termination_rate_under1y',
  'early_termination_rate_over1y',
  'own_damage_repair_ratio',
  'late_fee_rate',
]);
const NUMBER_KEYS = new Set([
  'accident_termination_count',
  'deposit_return_days',
  'auto_terminate_overdue_days',
  'basic_driver_age',
  'driver_age_lowering',
  'driver_age_upper_limit',
  'annual_mileage',
  'max_annual_mileage',
]);
const BOOL_KEYS = new Set([
  'deposit_card_payment',
  'deposit_installment',
  'succession_allowed',
  'maintenance_service',
  'insurance_included',
]);

function activeOffer(offer: Offer, now: string) {
  if (offer.status !== 'ACTIVE' || offer.validationStatus === 'INVALID') return false;
  if (offer.validFrom && offer.validFrom > now) return false;
  if (offer.validUntil && offer.validUntil <= now) return false;
  return true;
}

function activePolicy(policy: Policy, now: string) {
  if (policy.validationStatus === 'INVALID') return false;
  if (policy.effectiveFrom && policy.effectiveFrom > now) return false;
  if (policy.effectiveTo && policy.effectiveTo <= now) return false;
  return true;
}

function typedFact(
  policyId: string,
  key: string,
  raw: unknown,
): { value?: AdminPolicyValue; invalid?: string } {
  const ref = policyId + ':' + key;
  if (BOOL_KEYS.has(key)) {
    return typeof raw === 'boolean'
      ? { value: { policyId: key, type: 'BOOLEAN', value: raw } }
      : { invalid: ref };
  }
  if (MONEY_KEYS.has(key)) {
    return typeof raw === 'number' && Number.isFinite(raw)
      ? { value: { policyId: key, type: 'MONEY', value: raw } }
      : { invalid: ref };
  }
  if (PERCENT_KEYS.has(key)) {
    return typeof raw === 'number' && Number.isFinite(raw)
      ? { value: { policyId: key, type: 'PERCENTAGE', value: raw } }
      : { invalid: ref };
  }
  if (NUMBER_KEYS.has(key)) {
    return typeof raw === 'number' && Number.isFinite(raw)
      ? { value: { policyId: key, type: 'NUMBER', value: raw } }
      : { invalid: ref };
  }
  if (typeof raw === 'boolean') return { value: { policyId: key, type: 'BOOLEAN', value: raw } };
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: { policyId: key, type: 'NUMBER', value: raw } };
  if (typeof raw === 'string') return { value: { policyId: key, type: 'TEXT', value: raw } };
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
    return { value: { policyId: key, type: 'MULTI_SELECT', value: [...raw] } };
  }
  return { invalid: ref };
}

function projectPolicy(
  offer: Offer,
  policyById: Map<string, Policy>,
  now: string,
) {
  const policyId = offer.policyId?.trim();
  if (!policyId) {
    return { policy: null, state: 'MISSING' as const, values: [] as AdminPolicyValue[], invalid: [] as string[] };
  }
  const policy = policyById.get(policyId);
  if (!policy || !activePolicy(policy, now)) {
    return { policy: policy ?? null, state: 'MISSING' as const, values: [] as AdminPolicyValue[], invalid: [] as string[] };
  }
  const values: AdminPolicyValue[] = [];
  const invalid: string[] = [];
  for (const [key, raw] of Object.entries(policy.facts)) {
    const mapped = typedFact(policy.id, key, raw);
    if (mapped.value) values.push(mapped.value);
    if (mapped.invalid) invalid.push(mapped.invalid);
  }
  values.sort((a, b) => a.policyId.localeCompare(b.policyId));
  invalid.sort();
  return {
    policy,
    state: invalid.length ? 'INVALID' as const : values.length ? 'COMPLETE' as const : 'MISSING' as const,
    values,
    invalid,
  };
}

const sortedTerms = (offer: Offer) => structuredClone(offer.priceTerms).sort((a, b) =>
  a.termMonths - b.termMonths ||
  (a.mileageLimitKmPerYear ?? -1) - (b.mileageLimitKmPerYear ?? -1) ||
  a.termKey.localeCompare(b.termKey)
);

export async function buildAdminCatalogProjection(
  catalog: CatalogStore,
  projections: ProjectionStore,
  now = new Date().toISOString(),
): Promise<ProjectionRelease<AdminCatalogProduct>> {
  const releaseId = 'rel_admin_' + randomUUID();
  const [models, assets, products, offers, policies, sourceLineage, revisionHistory] = await Promise.all([
    catalog.listVehicleModels(),
    catalog.listVehicleAssets(),
    catalog.listProducts(),
    catalog.listOffers(),
    catalog.listPolicies(),
    catalog.listLineageByStage('NORMALIZED_TO_CANONICAL'),
    catalog.listRevisionHistory(),
  ]);

  const modelById = new Map(models.map((value) => [value.id, value]));
  const assetById = new Map(assets.map((value) => [value.id, value]));
  const policyById = new Map(policies.map((value) => [value.id, value]));
  const offersByProduct = new Map<string, Offer[]>();
  for (const offer of offers.filter((value) => activeOffer(value, now)).sort((a, b) => a.id.localeCompare(b.id))) {
    const rows = offersByProduct.get(offer.productId) ?? [];
    rows.push(offer);
    offersByProduct.set(offer.productId, rows);
  }

  const evidenceContext = buildProjectionEvidenceContext({
    releaseId,
    projectionId: 'admin-catalog',
    sourceLineage,
    revisionHistory,
  });
  const data: AdminCatalogProduct[] = [];

  for (const product of [...products].sort((a, b) => a.id.localeCompare(b.id))) {
    if (product.status !== 'ACTIVE' || product.validationStatus === 'INVALID') continue;
    const model = modelById.get(product.vehicleModelId);
    if (!model || model.validationStatus === 'INVALID') continue;
    const asset = product.vehicleAssetId ? assetById.get(product.vehicleAssetId) : undefined;
    if (product.vehicleAssetId && !asset) continue;
    if (asset && asset.status !== 'AVAILABLE') continue;

    const activeOffers = offersByProduct.get(product.id) ?? [];
    if (!activeOffers.length) continue;

    evidenceContext.requireRevision('product', product);
    evidenceContext.requireRevision('vehicle_model', model);
    if (asset) evidenceContext.requireRevision('vehicle_asset', asset);

    const productPath = `products.${product.id}`;
    for (const [fieldPath, canonicalValue, projected, projectionValue] of [
      ['id', product.id, 'productId', product.id],
      ['revision', product.revision, 'productRevision', product.revision],
      ['updatedAt', product.updatedAt, 'updatedAt', product.updatedAt],
      ['displayName', product.displayName, 'displayName', product.displayName],
      ['commercialType', product.commercialType, 'commercialType', product.commercialType],
    ] as Array<[string, unknown, string, unknown]>) {
      evidenceContext.addField({
        entityType: 'product', entityId: product.id, revision: product.revision,
        fieldPath, canonicalValue, projectionFieldPath: `${productPath}.${projected}`, projectionValue,
      });
    }

    const modelPath = `${productPath}.vehicleModel`;
    const modelFields: Array<[string, unknown]> = [
      ['id', model.id], ['maker', model.maker], ['model', model.model],
    ];
    for (const key of ['generation','subModel','trim','fuel','drive','seats'] as const) {
      if (model[key] !== undefined) modelFields.push([key, model[key]]);
    }
    for (const [fieldPath, value] of modelFields) {
      evidenceContext.addField({
        entityType: 'vehicle_model', entityId: model.id, revision: model.revision,
        fieldPath, canonicalValue: value, projectionFieldPath: `${modelPath}.${fieldPath}`, projectionValue: value,
      });
    }

    if (asset) {
      const assetPath = `${productPath}.vehicleAsset`;
      const assetFields: Array<[string, unknown]> = [['id', asset.id], ['status', asset.status]];
      for (const key of ['plateNumber','vin','odometerKm'] as const) {
        if (asset[key] !== undefined) assetFields.push([key, asset[key]]);
      }
      for (const [fieldPath, value] of assetFields) {
        evidenceContext.addField({
          entityType: 'vehicle_asset', entityId: asset.id, revision: asset.revision,
          fieldPath, canonicalValue: value, projectionFieldPath: `${assetPath}.${fieldPath}`, projectionValue: value,
        });
      }
    }

    const projectedOffers: AdminCatalogProduct['offers'] = [];
    for (const offer of activeOffers) {
      evidenceContext.requireRevision('offer', offer);
      const policy = projectPolicy(offer, policyById, now);
      if (policy.policy) evidenceContext.requireRevision('policy', policy.policy);
      const offerPath = `${productPath}.offers.${offer.id}`;
      for (const [fieldPath, canonicalValue, projected, projectionValue] of [
        ['id', offer.id, 'offerId', offer.id],
        ['revision', offer.revision, 'offerRevision', offer.revision],
        ['supplierId', offer.supplierId, 'supplierId', offer.supplierId],
      ] as Array<[string, unknown, string, unknown]>) {
        evidenceContext.addField({
          entityType: 'offer', entityId: offer.id, revision: offer.revision,
          fieldPath, canonicalValue, projectionFieldPath: `${offerPath}.${projected}`, projectionValue,
        });
      }
      if (offer.policyId !== undefined) {
        evidenceContext.addField({
          entityType: 'offer', entityId: offer.id, revision: offer.revision,
          fieldPath: 'policyId', canonicalValue: offer.policyId,
          projectionFieldPath: `${offerPath}.policyId`, projectionValue: offer.policyId,
        });
        evidenceContext.addField({
          entityType: 'offer', entityId: offer.id, revision: offer.revision,
          fieldPath: 'policyId', canonicalValue: offer.policyId,
          projectionFieldPath: `${offerPath}.policyState`, projectionValue: policy.state,
        });
      }

      if (policy.policy) {
        for (const value of policy.values) {
          const raw = policy.policy.facts[value.policyId];
          evidenceContext.addField({
            entityType: 'policy', entityId: policy.policy.id, revision: policy.policy.revision,
            fieldPath: `facts.${value.policyId}`, canonicalValue: raw,
            projectionFieldPath: `${offerPath}.policyValues.${value.policyId}.value`,
            projectionValue: value.value,
          });
        }
      }

      const terms = sortedTerms(offer);
      for (const term of terms) {
        const canonicalPrefix = `priceTerms.${term.termKey}`;
        const projectionPrefix = `${offerPath}.priceTerms.${term.termKey}`;
        const termFields: Array<[string, unknown]> = [
          ['termKey', term.termKey],
          ['termMonths', term.termMonths],
          ['monthlyRent.amount', term.monthlyRent.amount],
          ['monthlyRent.currency', term.monthlyRent.currency],
          ['depositState', term.depositState],
        ];
        if (term.deposit) {
          termFields.push(['deposit.amount', term.deposit.amount], ['deposit.currency', term.deposit.currency]);
        }
        if (term.mileageLimitKmPerYear !== undefined) {
          termFields.push(['mileageLimitKmPerYear', term.mileageLimitKmPerYear]);
        }
        for (const [suffix, value] of termFields) {
          evidenceContext.addField({
            entityType: 'offer', entityId: offer.id, revision: offer.revision,
            fieldPath: `${canonicalPrefix}.${suffix}`, canonicalValue: value,
            projectionFieldPath: `${projectionPrefix}.${suffix}`, projectionValue: value,
          });
        }
      }

      projectedOffers.push({
        offerId: offer.id,
        offerRevision: offer.revision,
        supplierId: offer.supplierId,
        ...(offer.policyId !== undefined ? { policyId: offer.policyId } : {}),
        policyState: policy.state,
        policyValues: policy.values,
        invalidPolicyFactRefs: policy.invalid,
        priceTerms: terms,
      });
    }

    data.push({
      productId: product.id,
      productRevision: product.revision,
      updatedAt: product.updatedAt,
      displayName: product.displayName,
      commercialType: product.commercialType,
      vehicleModel: {
        id: model.id, maker: model.maker, model: model.model,
        ...(model.generation !== undefined ? { generation: model.generation } : {}),
        ...(model.subModel !== undefined ? { subModel: model.subModel } : {}),
        ...(model.trim !== undefined ? { trim: model.trim } : {}),
        ...(model.fuel !== undefined ? { fuel: model.fuel } : {}),
        ...(model.drive !== undefined ? { drive: model.drive } : {}),
        ...(model.seats !== undefined ? { seats: model.seats } : {}),
      },
      ...(asset ? { vehicleAsset: {
        id: asset.id, status: asset.status,
        ...(asset.plateNumber !== undefined ? { plateNumber: asset.plateNumber } : {}),
        ...(asset.vin !== undefined ? { vin: asset.vin } : {}),
        ...(asset.odometerKm !== undefined ? { odometerKm: asset.odometerKm } : {}),
      } } : {}),
      offers: projectedOffers,
    });
  }

  if (!data.length) {
    throw new Error('Admin Catalog projection cannot activate an empty release');
  }

  const canonicalInputs = [...evidenceContext.canonicalInputs.values()].sort((a, b) =>
    a.entityType.localeCompare(b.entityType) || a.entityId.localeCompare(b.entityId) || a.revision - b.revision
  );
  const inputDigest = stableDigest(canonicalInputs);
  const dataDigest = stableDigest(data);
  const canonicalRevision = Math.max(0, ...canonicalInputs.map((item) => item.revision));

  const currentEvidence = await readActiveProjectionEvidence<AdminCatalogProduct>(projections, 'admin-catalog');
  if (
    currentEvidence.release &&
    currentEvidence.release.status === 'ACTIVE' &&
    currentEvidence.release.inputDigest === inputDigest &&
    currentEvidence.release.dataDigest === dataDigest &&
    currentEvidence.manifest
  ) {
    const integrity = verifyProjectionReleaseIntegrity(
      currentEvidence.release,
      currentEvidence.manifest,
      currentEvidence.lineage,
    );
    if (integrity.valid) return currentEvidence.release;
  }

  const fieldEvidenceDigest = stableRecordSetDigest(evidenceContext.evidence);
  const manifestId = `manifest_${releaseId}`;
  const manifest: ProjectionReleaseManifest = {
    manifestId,
    releaseId,
    projectionId: 'admin-catalog',
    schemaVersion: '1.0.0',
    generatedAt: now,
    canonicalInputs,
    productCount: data.length,
    offerCount: data.reduce((sum, product) => sum + product.offers.length, 0),
    fieldEvidenceCount: evidenceContext.evidence.length,
    fieldEvidenceDigest,
    inputDigest,
    dataDigest,
  };
  const release: ProjectionRelease<AdminCatalogProduct> = {
    releaseId,
    projectionId: 'admin-catalog',
    schemaVersion: '1.0.0',
    canonicalRevision,
    manifestId,
    inputDigest,
    dataDigest,
    status: 'BUILDING',
    generatedAt: now,
    data,
  };

  await projections.stage(release);
  await projections.stageEvidence({ manifest, lineage: evidenceContext.evidence });
  await projections.markReady(release.releaseId);
  await projections.activate(release.releaseId);
  const active = await projections.getActive<AdminCatalogProduct>('admin-catalog');
  if (!active) throw new Error('Admin Catalog projection activation failed');
  return active;
}
