import { describe, expect, it } from 'vitest';
import type { Offer, Policy, Product, VehicleAsset, VehicleModel } from '../src/domain/catalog.js';
import type { EntityRevisionRecord } from '../src/domain/history.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { buildAdminCatalogProjection } from '../src/application/admin-catalog.js';
import { verifyProjectionReleaseIntegrity } from '../src/shared/projection-integrity.js';

const actor = { id: 'test', kind: 'SERVICE' as const };
const now = '2026-09-25T00:00:00.000Z';
const meta = {
  schemaVersion: '1.0.0', revision: 1, validationStatus: 'VALID' as const,
  createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor, lineageId: 'lin-test',
};

function fixtures() {
  const model: VehicleModel = {
    ...meta, id: 'vm-1', maker: '현대', model: '싼타페', generation: '5세대',
    subModel: 'MX5', trim: '캘리그래피', fuel: '하이브리드', drive: 'AWD',
    seats: 6, displayName: '현대 싼타페 MX5 캘리그래피',
  };
  const asset: VehicleAsset = {
    ...meta, id: 'va-1', vehicleModelId: model.id, status: 'AVAILABLE',
    plateNumber: '123하4567', vin: 'VIN-1', odometerKm: 21000,
  };
  const product: Product = {
    ...meta, id: 'prd-1', vehicleModelId: model.id, vehicleAssetId: asset.id,
    commercialType: 'USED_RENT', status: 'ACTIVE', displayName: model.displayName,
  };
  const policy: Policy = {
    ...meta, id: 'policy-a', kind: 'OTHER', version: '2026-09',
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    facts: { basic_driver_age: 21, deposit_card_payment: true, pay_method: ['CARD','TRANSFER'] },
  };
  const offer: Offer = {
    ...meta, id: 'offer-a', productId: product.id, supplierId: 'supplier-a',
    status: 'ACTIVE', policyId: policy.id,
    priceTerms: [{
      termKey: '36_2만', termMonths: 36,
      monthlyRent: { amount: 920000, currency: 'KRW' },
      deposit: { amount: 0, currency: 'KRW' }, depositState: 'ZERO',
      mileageLimitKmPerYear: 20000,
    }, {
      termKey: '48_2만', termMonths: 48,
      monthlyRent: { amount: 850000, currency: 'KRW' },
      depositState: 'UNKNOWN', mileageLimitKmPerYear: 20000,
    }],
  };
  return { model, asset, product, policy, offer };
}

const revision = (
  entityType: EntityRevisionRecord['entityType'],
  entityId: string,
  snapshot: unknown,
): EntityRevisionRecord => ({
  revisionRecordId: `rev-${entityType}-${entityId}`,
  entityType, entityId, revision: 1, previousRevision: null, snapshot,
  actor, reason: 'test fixture', origin: 'MIGRATION', commandId: 'cmd-test', occurredAt: now,
});

async function seeded(mutator?: (f: ReturnType<typeof fixtures>) => void) {
  const store = new MemoryDataStore();
  const f = fixtures();
  mutator?.(f);
  await store.seed({
    vehicleModels: [f.model], vehicleAssets: [f.asset], products: [f.product],
    offers: [f.offer], policies: [f.policy],
    revisionHistory: [
      revision('vehicle_model', f.model.id, f.model),
      revision('vehicle_asset', f.asset.id, f.asset),
      revision('product', f.product.id, f.product),
      revision('offer', f.offer.id, f.offer),
      revision('policy', f.policy.id, f.policy),
    ],
  });
  return { store, f };
}

describe('Admin Catalog projection on current release evidence', () => {
  it('preserves unknown deposit, VIN, typed policy and passes manifest/digest/lineage integrity', async () => {
    const { store } = await seeded();
    const release = await buildAdminCatalogProjection(store, store, now);
    expect(release.projectionId).toBe('admin-catalog');
    expect(release.status).toBe('ACTIVE');
    const row = release.data[0]!;
    expect(row.vehicleAsset?.vin).toBe('VIN-1');
    expect(row.offers[0]?.priceTerms[1]?.depositState).toBe('UNKNOWN');
    expect(row.offers[0]?.policyState).toBe('COMPLETE');
    expect(row.offers[0]?.policyValues).toContainEqual({
      policyId: 'basic_driver_age', type: 'NUMBER', value: 21,
    });
    const manifest = await store.getManifest(release.releaseId);
    const lineage = await store.listProjectionLineage(release.releaseId);
    expect(manifest).not.toBeNull();
    expect(verifyProjectionReleaseIntegrity(release, manifest!, lineage).valid).toBe(true);
  });

  it('marks missing policy explicitly without converting it to a complete policy', async () => {
    const { store, f } = await seeded((x) => { x.offer.policyId = undefined; });
    const release = await buildAdminCatalogProjection(store, store, now);
    const offer = release.data[0]?.offers[0];
    expect(offer?.policyState).toBe('MISSING');
    expect(offer?.policyValues).toEqual([]);
    expect(offer?.invalidPolicyFactRefs).toEqual([]);
    expect(f.offer.policyId).toBeUndefined();
  });

  it('marks known numeric policy text invalid rather than coercing it', async () => {
    const { store } = await seeded((x) => { x.policy.facts = { basic_driver_age: '만 21세 이상' }; });
    const release = await buildAdminCatalogProjection(store, store, now);
    expect(release.data[0]?.offers[0]?.policyState).toBe('INVALID');
    expect(release.data[0]?.offers[0]?.invalidPolicyFactRefs).toEqual(['policy-a:basic_driver_age']);
  });

  it('refuses to activate an empty Admin release', async () => {
    const { store } = await seeded((x) => { x.product.status = 'HOLD'; });
    await expect(buildAdminCatalogProjection(store, store, now))
      .rejects.toThrow('cannot activate an empty release');
    expect(await store.getActive('admin-catalog')).toBeNull();
  });

  it('reuses an equivalent ACTIVE Admin release instead of replacing evidence identity', async () => {
    const { store } = await seeded();
    const first = await buildAdminCatalogProjection(store, store, now);
    const second = await buildAdminCatalogProjection(store, store, '2026-09-25T00:01:00.000Z');
    expect(second.releaseId).toBe(first.releaseId);
  });
});
