import { describe, expect, it } from 'vitest';
import {
  deterministicVehicleMasterRecordId,
  sealVehicleMasterCompatibilityRule,
  sealVehicleMasterNode,
  sealVehicleMasterRepairReceipt,
  sealVehicleMasterSourceDocument,
  type VehicleMasterNode,
} from '../src/domain/vehicle-master.js';
import {
  canonicalPowertrainIdentity,
  canonicalTrimIdentity,
} from '../src/domain/vehicle-master-normalization.js';
import {
  auditVehicleMasterGraph,
  readVehicleMasterGraphSnapshot,
} from '../src/application/vehicle-master-graph-audit.js';
import {
  buildVehicleMasterRepairPlan,
} from '../src/application/vehicle-master-repair-plan.js';
import {
  buildVehicleMasterRepairDryRun,
  materializeVehicleMasterRepairCandidate,
} from '../src/application/vehicle-master-repair-dry-run.js';
import {
  applyVehicleMasterRepairCommand,
  VehicleMasterRepairCommandRejectedError,
  type ApplyVehicleMasterRepairCommandInput,
} from '../src/application/vehicle-master-repair-command.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import type {
  VehicleMasterRepairCommitInput,
  VehicleMasterRepairCommitResult,
} from '../src/ports/vehicle-master-store.js';
import { stableDigest } from '../src/shared/stable-digest.js';

const at = '2026-09-27T04:40:00.000Z';
const dryRunAt = '2026-09-27T04:45:00.000Z';
const committedAt = '2026-09-27T04:50:00.000Z';
const sourceId = 'official_repair_command';

type Seed = {
  make: VehicleMasterNode;
  model: VehicleMasterNode;
  generation: VehicleMasterNode;
  phase: VehicleMasterNode;
  modelYear: VehicleMasterNode;
  powertrain: VehicleMasterNode;
  variant: VehicleMasterNode;
  trim: VehicleMasterNode;
  base: VehicleMasterNode;
};

async function seedStore(
  store: MemoryVehicleMasterStore,
  options: { badFuel?: boolean; withRule?: boolean } = {}
): Promise<Seed> {
  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId: sourceId,
    sourceType: 'MANUFACTURER_OFFICIAL',
    sourceName: 'repair command fixture',
    sourceUrl: 'https://example.test/repair-command',
    publishedAt: at,
    observedAt: at,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath: 'vehicle-master/source-documents/test/repair-command.html',
    sha256: 'a'.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  }));

  const make = sealVehicleMasterNode({
    id: 'make_repair_command',
    nodeType: 'MAKE',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '기아',
    parentId: null,
    refs: {},
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const model = sealVehicleMasterNode({
    id: 'model_repair_command',
    nodeType: 'MODEL',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '쏘렌토',
    parentId: make.id,
    refs: { makeId: make.id },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const generation = sealVehicleMasterNode({
    id: 'gen_repair_command',
    nodeType: 'GENERATION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: 'MQ4',
    parentId: model.id,
    refs: { makeId: make.id, modelId: model.id },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const phase = sealVehicleMasterNode({
    id: 'phase_repair_command',
    nodeType: 'PHASE',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '더 뉴 쏘렌토',
    parentId: generation.id,
    refs: {
      makeId: make.id,
      modelId: model.id,
      generationId: generation.id,
    },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const modelYear = sealVehicleMasterNode({
    id: 'my_repair_command',
    nodeType: 'MODEL_YEAR',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '2027년형',
    parentId: phase.id,
    refs: {
      makeId: make.id,
      modelId: model.id,
      generationId: generation.id,
      phaseId: phase.id,
    },
    aliases: ['2027MY'],
    attributes: { modelYear: 2027 },
    sourceEvidenceIds: [sourceId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const powertrain = sealVehicleMasterNode({
    id: 'pt_repair_command',
    nodeType: 'POWERTRAIN',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: options.badFuel ? '1.6 하이브리드' : '2.5 가솔린 터보',
    parentId: modelYear.id,
    refs: {
      ...modelYear.refs,
      modelYearId: modelYear.id,
    },
    aliases: [],
    attributes: {
      identityKey: 'wrong',
      fuelType: options.badFuel ? 'GASOLINE' : 'GASOLINE',
    },
    sourceEvidenceIds: [sourceId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const variant = sealVehicleMasterNode({
    id: 'variant_repair_command',
    nodeType: 'VARIANT',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '5인승 2WD',
    parentId: powertrain.id,
    refs: {
      ...powertrain.refs,
      powertrainId: powertrain.id,
    },
    aliases: [],
    attributes: { seats: 5, drivetrain: '2WD' },
    sourceEvidenceIds: [sourceId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const trim = sealVehicleMasterNode({
    id: 'trim_repair_command',
    nodeType: 'TRIM',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '프레스티지',
    parentId: variant.id,
    refs: {
      ...variant.refs,
      variantId: variant.id,
    },
    aliases: [],
    attributes: { identityKey: canonicalTrimIdentity('프레스티지') },
    sourceEvidenceIds: [sourceId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const base = sealVehicleMasterNode({
    id: 'base_repair_command',
    nodeType: 'BASE_ITEM',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: 'LED 헤드램프',
    parentId: modelYear.id,
    refs: {
      makeId: make.id,
      modelId: model.id,
      generationId: generation.id,
      phaseId: phase.id,
      modelYearId: modelYear.id,
    },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });

  for (const node of [
    make,
    model,
    generation,
    phase,
    modelYear,
    powertrain,
    variant,
    trim,
    base,
  ]) {
    await store.putNode(node);
  }

  if (options.withRule) {
    const rule = sealVehicleMasterCompatibilityRule({
      id: 'rule_repair_command',
      revision: 1,
      subjectId: trim.id,
      ruleType: 'INCLUDES',
      targetIds: [base.id],
      scope: { trimId: trim.id },
      condition: { evidence: 'ok' },
      effect: 'VALID',
      priority: 10,
      sourceEvidenceIds: [sourceId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: at,
      updatedAt: at,
    });
    await store.putCompatibilityRule(rule);
  }

  return {
    make,
    model,
    generation,
    phase,
    modelYear,
    powertrain,
    variant,
    trim,
    base,
  };
}

async function buildCommand(
  store: MemoryVehicleMasterStore,
  entityKind: 'NODE' | 'RULE',
  entityId: string,
  overrides: Partial<ApplyVehicleMasterRepairCommandInput> = {}
) {
  const snapshot = await readVehicleMasterGraphSnapshot(store);
  const audit = auditVehicleMasterGraph(snapshot);
  const plan = buildVehicleMasterRepairPlan(audit);
  const dryRun = buildVehicleMasterRepairDryRun({
    snapshot,
    auditReport: audit,
    repairPlan: plan,
    observedAt: dryRunAt,
  });
  const item = dryRun.items.find(
    (candidate) =>
      candidate.entityKind === entityKind &&
      candidate.entityId === entityId
  );
  if (!item) throw new Error('TEST_DRY_RUN_ITEM_MISSING');

  return {
    input: {
      commandId: 'cmd_repair_1',
      idempotencyKey: 'idem_repair_1',
      entityKind,
      entityId,
      sourceAuditDigest: audit.digest,
      repairPlanDigest: plan.digest,
      dryRunDigest: dryRun.digest,
      dryRunObservedAt: dryRunAt,
      expectedCurrentRevision: item.currentRevision!,
      expectedBeforeContentHash: item.beforeContentHash!,
      expectedAfterContentHash: item.afterContentHash ?? 'blocked',
      committedAt,
      ...overrides,
    } satisfies ApplyVehicleMasterRepairCommandInput,
    snapshot,
    audit,
    plan,
    dryRun,
    item,
  };
}

class RacingMemoryStore extends MemoryVehicleMasterStore {
  private injected = false;

  override async commitRepair(
    input: VehicleMasterRepairCommitInput
  ): Promise<VehicleMasterRepairCommitResult> {
    if (!this.injected && input.entityKind === 'NODE') {
      this.injected = true;
      const current = await this.getNode(input.record.id);
      if (!current) throw new Error('RACE_FIXTURE_CURRENT_MISSING');
      const raced = sealVehicleMasterNode({
        id: current.id,
        nodeType: current.nodeType,
        status: current.status,
        revision: current.revision + 1,
        canonicalName: current.canonicalName,
        parentId: current.parentId ?? null,
        refs: current.refs,
        aliases: [...current.aliases, 'race-marker'],
        attributes: current.attributes,
        sourceEvidenceIds: current.sourceEvidenceIds,
        effectiveFrom: current.effectiveFrom ?? null,
        effectiveTo: current.effectiveTo ?? null,
        createdAt: current.createdAt,
        updatedAt: '2026-09-27T04:49:00.000Z',
      });
      await this.putNode(raced);
    }
    return super.commitRepair(input);
  }
}

describe('vehicle master repair command', () => {
  it('commits one READY repair with CAS, revision history, receipt, and readback', async () => {
    const store = new MemoryVehicleMasterStore();
    const seeded = await seedStore(store);
    const prepared = await buildCommand(store, 'NODE', seeded.powertrain.id);

    expect(prepared.item.status).toBe('READY');

    const result = await applyVehicleMasterRepairCommand(store, prepared.input);

    expect(result.status).toBe('COMMITTED');
    expect(result.receipt).toEqual(expect.objectContaining({
      entityKind: 'NODE',
      entityId: seeded.powertrain.id,
      beforeRevision: 1,
      afterRevision: 2,
      beforeContentHash: prepared.item.beforeContentHash,
      afterContentHash: prepared.item.afterContentHash,
      sourceAuditDigest: prepared.audit.digest,
      repairPlanDigest: prepared.plan.digest,
      dryRunDigest: prepared.dryRun.digest,
    }));
    const updated = await store.getNode(seeded.powertrain.id);
    expect(updated?.revision).toBe(2);
    expect(updated?.attributes.identityKey).toBe(
      canonicalPowertrainIdentity(seeded.powertrain.canonicalName)
    );
    expect(updated?.contentHash).toBe(prepared.item.afterContentHash);
    expect(
      (await store.listNodeRevisions())
        .filter((node) => node.id === seeded.powertrain.id)
        .map((node) => node.revision)
    ).toEqual([1, 2]);
    expect(await store.getRepairReceipt(result.receipt.receiptId))
      .toEqual(result.receipt);
    expect(result.postAudit?.status).toBe('PASS');
  });

  it('replays the same idempotency request without creating revision 3', async () => {
    const store = new MemoryVehicleMasterStore();
    const seeded = await seedStore(store);
    const prepared = await buildCommand(store, 'NODE', seeded.powertrain.id);

    const first = await applyVehicleMasterRepairCommand(store, prepared.input);
    const second = await applyVehicleMasterRepairCommand(store, prepared.input);

    expect(first.status).toBe('COMMITTED');
    expect(second.status).toBe('IDEMPOTENT_REPLAY');
    expect(second.receipt).toEqual(first.receipt);
    expect(
      (await store.listNodeRevisions())
        .filter((node) => node.id === seeded.powertrain.id)
        .map((node) => node.revision)
    ).toEqual([1, 2]);
  });

  it('rejects reuse of one idempotency key for a different request', async () => {
    const store = new MemoryVehicleMasterStore();
    const seeded = await seedStore(store);
    const prepared = await buildCommand(store, 'NODE', seeded.powertrain.id);
    await applyVehicleMasterRepairCommand(store, prepared.input);

    await expect(
      applyVehicleMasterRepairCommand(store, {
        ...prepared.input,
        commandId: 'cmd_repair_different',
      })
    ).rejects.toMatchObject({
      code: 'VEHICLE_MASTER_REPAIR_COMMAND_REJECTED',
      reason: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
  });

  it('rejects stale dry-run after the target changes', async () => {
    const store = new MemoryVehicleMasterStore();
    const seeded = await seedStore(store);
    const prepared = await buildCommand(store, 'NODE', seeded.powertrain.id);

    const current = await store.getNode(seeded.powertrain.id);
    if (!current) throw new Error('TEST_CURRENT_MISSING');
    await store.putNode(sealVehicleMasterNode({
      id: current.id,
      nodeType: current.nodeType,
      status: current.status,
      revision: 2,
      canonicalName: current.canonicalName,
      parentId: current.parentId ?? null,
      refs: current.refs,
      aliases: [...current.aliases, 'changed-before-command'],
      attributes: current.attributes,
      sourceEvidenceIds: current.sourceEvidenceIds,
      effectiveFrom: current.effectiveFrom ?? null,
      effectiveTo: current.effectiveTo ?? null,
      createdAt: current.createdAt,
      updatedAt: '2026-09-27T04:46:00.000Z',
    }));

    await expect(
      applyVehicleMasterRepairCommand(store, prepared.input)
    ).rejects.toBeInstanceOf(VehicleMasterRepairCommandRejectedError);

    expect((await store.getNode(seeded.powertrain.id))?.revision).toBe(2);
  });

  it('rejects a target that Dry-Run blocks because source evidence is still required', async () => {
    const store = new MemoryVehicleMasterStore();
    const seeded = await seedStore(store, { badFuel: true });
    const prepared = await buildCommand(store, 'NODE', seeded.powertrain.id);

    expect(prepared.item.status).toBe('BLOCKED');

    await expect(
      applyVehicleMasterRepairCommand(store, prepared.input)
    ).rejects.toMatchObject({
      code: 'VEHICLE_MASTER_REPAIR_COMMAND_REJECTED',
      reason: 'TARGET_NOT_READY_IN_DRY_RUN',
    });
    expect((await store.getNode(seeded.powertrain.id))?.revision).toBe(1);
  });

  it('rejects a forged dry-run digest', async () => {
    const store = new MemoryVehicleMasterStore();
    const seeded = await seedStore(store);
    const prepared = await buildCommand(store, 'NODE', seeded.powertrain.id);

    await expect(
      applyVehicleMasterRepairCommand(store, {
        ...prepared.input,
        dryRunDigest: 'f'.repeat(64),
      })
    ).rejects.toMatchObject({
      code: 'VEHICLE_MASTER_REPAIR_COMMAND_REJECTED',
      reason: 'DRY_RUN_DIGEST_STALE',
    });
  });

  it('uses Store CAS as the final race-condition guard', async () => {
    const store = new RacingMemoryStore();
    const seeded = await seedStore(store);
    const prepared = await buildCommand(store, 'NODE', seeded.powertrain.id);

    await expect(
      applyVehicleMasterRepairCommand(store, prepared.input)
    ).rejects.toThrow(/VEHICLE_MASTER_REPAIR_CAS_MISMATCH/);

    const current = await store.getNode(seeded.powertrain.id);
    expect(current?.revision).toBe(2);
    expect(current?.aliases).toContain('race-marker');
    expect(await store.getRepairReceipt(
      deterministicVehicleMasterRecordId(
        'vehicle_master_repair_receipt',
        { idempotencyKey: prepared.input.idempotencyKey }
      )
    )).toBeNull();
  });

  it('blocks RULE hash reseal when the immutable rule revision is also corrupted', async () => {
    const store = new MemoryVehicleMasterStore();
    const seeded = await seedStore(store, { withRule: true });
    const rule = await store.getCompatibilityRule('rule_repair_command');
    if (!rule) throw new Error('TEST_RULE_MISSING');

    const tampered = {
      ...rule,
      contentHash: '0'.repeat(64),
    };
    const ruleStore = new MemoryVehicleMasterStore();
    await seedStore(ruleStore);
    await ruleStore.putCompatibilityRule(tampered);

    const prepared = await buildCommand(ruleStore, 'RULE', tampered.id);

    expect(prepared.item.status).toBe('BLOCKED');
    expect(prepared.item.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('NON_AUTO_SAFE_ISSUE:CONTENT_HASH_MISMATCH:REVISION'),
    ]));

    await expect(
      applyVehicleMasterRepairCommand(ruleStore, prepared.input)
    ).rejects.toMatchObject({
      code: 'VEHICLE_MASTER_REPAIR_COMMAND_REJECTED',
      reason: 'TARGET_NOT_READY_IN_DRY_RUN',
    });
    expect((await ruleStore.getCompatibilityRule(tampered.id))?.revision).toBe(1);
    expect(seeded.trim.id).toBe('trim_repair_command');
  });

  it('Store rejects a forged receipt/candidate pair before any mutation', async () => {
    const store = new MemoryVehicleMasterStore();
    const seeded = await seedStore(store);
    const prepared = await buildCommand(store, 'NODE', seeded.powertrain.id);
    const candidate = materializeVehicleMasterRepairCandidate({
      snapshot: prepared.snapshot,
      repairPlan: prepared.plan,
      dryRunItem: prepared.item,
      observedAt: dryRunAt,
    });
    if (!candidate.record) throw new Error('TEST_CANDIDATE_MISSING');

    const receipt = sealVehicleMasterRepairReceipt({
      receiptId: 'receipt_forged',
      idempotencyKey: 'idem_forged',
      commandId: 'cmd_forged',
      requestDigest: stableDigest({ forged: true }),
      sourceAuditDigest: prepared.audit.digest,
      repairPlanDigest: prepared.plan.digest,
      dryRunDigest: prepared.dryRun.digest,
      entityKind: 'NODE',
      entityId: seeded.powertrain.id,
      beforeRevision: prepared.item.currentRevision!,
      afterRevision: candidate.record.revision,
      beforeContentHash: 'f'.repeat(64),
      afterContentHash: candidate.record.contentHash,
      committedAt,
    });

    await expect(
      store.commitRepair({
        entityKind: 'NODE',
        expectedRevision: prepared.item.currentRevision!,
        expectedContentHash: prepared.item.beforeContentHash!,
        record: candidate.record as VehicleMasterNode,
        receipt,
      })
    ).rejects.toThrow(/VEHICLE_MASTER_REPAIR_RECEIPT_MISMATCH/);

    expect((await store.getNode(seeded.powertrain.id))?.revision).toBe(1);
    expect(await store.getRepairReceipt(receipt.receiptId)).toBeNull();
  });
});
