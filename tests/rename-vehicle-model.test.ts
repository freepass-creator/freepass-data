import { describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { renameVehicleModel } from '../src/application/rename-vehicle-model.js';
import { applyVehicleModelRenamePlan, validateVehicleModelRenamePlan, type VehicleModelRenamePlan } from '../src/jobs/rename-vehicle-models.js';

const t = '2026-10-04T00:00:00.000Z';
const svc = { id: 'service:freepass-data', kind: 'SERVICE' as const };
async function seeded() {
  const store = new MemoryDataStore();
  await store.seed({
    catalogWriterOwnership: { scope: 'catalog', revision: 1, mode: 'EXCLUSIVE', primaryWriterId: svc.id, allowedWriterIds: [svc.id], previousWriterIds: [],
      effectiveAt: t, updatedAt: t, updatedBy: svc, reason: 'test' },
    vehicleModels: [{ id: 'vm1', maker: '기아', model: '카니발', subModel: '더 뉴 카니발 KA4', trim: '9인승 프레스티지',
      displayName: '기아 카니발 더 뉴 카니발 KA4 9인승 프레스티지', revision: 1, createdAt: t, updatedAt: t, createdBy: svc, updatedBy: svc } as never],
    products: [{ id: 'p1', vehicleModelId: 'vm1', commercialType: 'USED_RENT', status: 'ACTIVE', displayName: '기아 카니발 더 뉴 카니발 KA4 9인승 프레스티지',
      revision: 1, createdAt: t, updatedAt: t, createdBy: svc, updatedBy: svc } as never],
  });
  return store;
}
const plan = (over: Partial<VehicleModelRenamePlan['items'][number]> = {}): VehicleModelRenamePlan => ({ schema: 'vehicle-model-rename-plan/v1', reason: 'F03 2차',
  items: [{ vehicleModelId: 'vm1', expectedRevision: 1, trim: '프레스티지', products: [{ productId: 'p1', expectedRevision: 1 }], evidence: '원문: 9인승 프레스티지', ...over }] });

describe('rename shared VehicleModel to F03 name', () => {
  it('renames trim, follows product displayName, records revision/audit/receipt and is idempotent', async () => {
    const store = await seeded();
    const p = plan(); const { planDigest } = validateVehicleModelRenamePlan(p);
    expect(await applyVehicleModelRenamePlan(store, p, planDigest)).toEqual({ renamed: 1, readbackOk: true });
    const model = await store.getVehicleModel('vm1');
    expect(model).toMatchObject({ trim: '프레스티지', revision: 2, displayName: '기아 카니발 더 뉴 카니발 KA4 프레스티지' });
    expect(await store.getProduct('p1')).toMatchObject({ displayName: '기아 카니발 더 뉴 카니발 KA4 프레스티지', revision: 2 });
    expect(await applyVehicleModelRenamePlan(store, p, planDigest)).toEqual({ renamed: 1, readbackOk: true });
    expect((await store.getVehicleModel('vm1'))!.revision).toBe(2);
  });
  it('rejects stale revisions, foreign products, missing evidence and non-exclusive writers', async () => {
    const store = await seeded();
    await expect(applyVehicleModelRenamePlan(store, plan({ expectedRevision: 9 }), 'd')).rejects.toThrow();
    await expect(applyVehicleModelRenamePlan(store, plan({ products: [{ productId: 'nope', expectedRevision: 1 }] }), 'd')).rejects.toThrow();
    expect(() => validateVehicleModelRenamePlan(plan({ evidence: '' }))).toThrow();
    await expect(renameVehicleModel(store, { commandId: 'c', idempotencyKey: 'i', vehicleModelId: 'vm1', expectedRevision: 1, trim: '프레스티지',
      products: [], reason: 'r', actor: { id: 'service:freepass-admin', kind: 'SERVICE' } })).rejects.toThrow();
    expect((await store.getVehicleModel('vm1'))!.trim).toBe('9인승 프레스티지');
  });
});
