import { describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { planOwnershipTransfer, runOwnershipCommand } from '../src/jobs/transfer-catalog-writer-ownership.js';
import { stableDigest } from '../src/shared/stable-digest.js';

const OWNER = { id: 'user:owner', kind: 'USER' as const };

describe('catalog writer ownership transfer job', () => {
  it('dry-run writes nothing and plans EXCLUSIVE service:freepass-data with a rollback to the before-image', async () => {
    const store = new MemoryDataStore();
    const { plan, report } = await planOwnershipTransfer(store, 'memory', OWNER, 'cutover');
    expect(report).toMatchObject({ mode: 'DRY_RUN', writes: 0, action: 'TRANSFER', storedOwnershipDocument: false,
      current: { revision: 0, mode: 'SHARED_MIGRATION' },
      next: { revision: 1, mode: 'EXCLUSIVE', primaryWriterId: 'service:freepass-data', allowedWriterIds: ['service:freepass-data'], previousWriterIds: ['service:freepass-admin'] },
      rollbackRestores: { mode: 'SHARED_MIGRATION', allowedWriterIds: ['service:freepass-data', 'service:freepass-admin'] } });
    expect(await store.getCatalogWriterOwnership()).toBeNull();
    expect(report.planDigest).toBe(stableDigest(plan));
  });

  it('apply → read-back → rollback → read-back, each guarded by the reviewed plan digest', async () => {
    const store = new MemoryDataStore();
    const { plan } = await planOwnershipTransfer(store, 'memory', OWNER, 'cutover');
    const digest = stableDigest(plan);
    await expect(runOwnershipCommand(store, 'apply', plan, 'wrong', 'memory')).rejects.toThrow('OWNERSHIP_PLAN_REQUIRED_OR_CHANGED');
    await expect(runOwnershipCommand(store, 'rollback', plan, digest, 'memory')).rejects.toThrow('OWNERSHIP_NOT_IN_PLANNED_STATE');
    const applied = await runOwnershipCommand(store, 'apply', plan, digest, 'memory', '2026-10-04T02:00:00.000Z');
    expect(applied).toMatchObject({ status: 'TRANSFERRED', readbackOk: true, readback: { revision: 1, mode: 'EXCLUSIVE' } });
    await expect(runOwnershipCommand(store, 'apply', plan, digest, 'memory')).rejects.toThrow('OWNERSHIP_CHANGED_SINCE_PLAN');
    const rolled = await runOwnershipCommand(store, 'rollback', plan, digest, 'memory', '2026-10-04T03:00:00.000Z');
    expect(rolled).toMatchObject({ status: 'ROLLED_BACK', readbackOk: true,
      readback: { revision: 2, mode: 'SHARED_MIGRATION', primaryWriterId: 'service:freepass-data', allowedWriterIds: ['service:freepass-admin', 'service:freepass-data'] } });
  });

  it('refuses a plan for another target', async () => {
    const store = new MemoryDataStore();
    const { plan } = await planOwnershipTransfer(store, 'memory', OWNER, 'cutover');
    await expect(runOwnershipCommand(store, 'apply', plan, stableDigest(plan), 'freepasserp5')).rejects.toThrow('OWNERSHIP_PLAN_REQUIRED_OR_CHANGED');
  });
});
