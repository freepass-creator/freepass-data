import { describe, expect, it } from 'vitest';
import {
  sealVehicleMasterCompatibilityRule,
  sealVehicleMasterNode,
  type VehicleMasterNode,
} from '../src/domain/vehicle-master.js';
import {
  canonicalPowertrainIdentity,
} from '../src/domain/vehicle-master-normalization.js';
import {
  auditVehicleMasterGraph,
  type VehicleMasterGraphSnapshot,
} from '../src/application/vehicle-master-graph-audit.js';
import {
  buildVehicleMasterRepairPlan,
} from '../src/application/vehicle-master-repair-plan.js';
import {
  buildVehicleMasterRepairDryRun,
} from '../src/application/vehicle-master-repair-dry-run.js';

const at = '2026-09-26T14:00:00.000Z';
const dryRunAt = '2026-09-26T14:30:00.000Z';

function cleanLineage() {
  const make = sealVehicleMasterNode({
    id: 'make_dry',
    nodeType: 'MAKE',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '기아',
    parentId: null,
    refs: {},
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const model = sealVehicleMasterNode({
    id: 'model_dry',
    nodeType: 'MODEL',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '쏘렌토',
    parentId: make.id,
    refs: { makeId: make.id },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const generation = sealVehicleMasterNode({
    id: 'gen_dry',
    nodeType: 'GENERATION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: 'MQ4',
    parentId: model.id,
    refs: {
      makeId: make.id,
      modelId: model.id,
    },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const phase = sealVehicleMasterNode({
    id: 'phase_dry',
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
    sourceEvidenceIds: [],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const modelYear = sealVehicleMasterNode({
    id: 'my_dry',
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
    sourceEvidenceIds: [],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const powertrain = sealVehicleMasterNode({
    id: 'pt_dry',
    nodeType: 'POWERTRAIN',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '2.5 가솔린 터보',
    parentId: modelYear.id,
    refs: {
      ...modelYear.refs,
      modelYearId: modelYear.id,
    },
    aliases: [],
    attributes: {
      identityKey: canonicalPowertrainIdentity('2.5 가솔린 터보'),
      fuelType: 'GASOLINE',
    },
    sourceEvidenceIds: [],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });

  return {
    list: [make, model, generation, phase, modelYear, powertrain],
    make,
    model,
    generation,
    phase,
    modelYear,
    powertrain,
  };
}

function run(snapshot: VehicleMasterGraphSnapshot) {
  const audit = auditVehicleMasterGraph(snapshot);
  const plan = buildVehicleMasterRepairPlan(audit);
  const dryRun = buildVehicleMasterRepairDryRun({
    snapshot,
    auditReport: audit,
    repairPlan: plan,
    observedAt: dryRunAt,
  });
  return { audit, plan, dryRun };
}

describe('vehicle master repair dry run', () => {
  it('simulates deterministic identity repair as a new revision without mutating input', () => {
    const n = cleanLineage();
    const broken = sealVehicleMasterNode({
      id: n.powertrain.id,
      nodeType: n.powertrain.nodeType,
      status: n.powertrain.status,
      revision: n.powertrain.revision,
      canonicalName: n.powertrain.canonicalName,
      parentId: n.powertrain.parentId ?? null,
      refs: n.powertrain.refs,
      aliases: n.powertrain.aliases,
      attributes: {
        ...n.powertrain.attributes,
        identityKey: 'wrong',
      },
      sourceEvidenceIds: n.powertrain.sourceEvidenceIds,
      effectiveFrom: n.powertrain.effectiveFrom ?? null,
      effectiveTo: n.powertrain.effectiveTo ?? null,
      createdAt: n.powertrain.createdAt,
      updatedAt: n.powertrain.updatedAt,
    });
    const snapshot: VehicleMasterGraphSnapshot = {
      nodes: n.list.map((node) => node.id === broken.id ? broken : node),
      rules: [],
      prices: [],
    };
    const before = structuredClone(snapshot);

    const { dryRun } = run(snapshot);

    expect(dryRun.status).toBe('READY');
    expect(dryRun.executionPolicy).toBe('DRY_RUN_ONLY');
    expect(dryRun.counts.readyEntities).toBe(1);
    expect(dryRun.counts.blockedEntities).toBe(0);
    expect(dryRun.items[0]).toEqual(expect.objectContaining({
      entityKind: 'NODE',
      entityId: broken.id,
      status: 'READY',
      currentRevision: 1,
      expectedRevision: 2,
      resolvedIssueCodes: ['POWERTRAIN_IDENTITY_MISMATCH'],
    }));
    expect(dryRun.items[0]!.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fieldPath: 'attributes.identityKey',
        before: 'wrong',
        after: canonicalPowertrainIdentity(broken.canonicalName),
      }),
      expect.objectContaining({
        fieldPath: 'revision',
        before: 1,
        after: 2,
      }),
      expect.objectContaining({
        fieldPath: 'updatedAt',
        before: at,
        after: dryRunAt,
      }),
    ]));
    expect(dryRun.simulatedAudit.status).toBe('PASS');
    expect(snapshot).toEqual(before);
  });

  it('simulates resealing a current NODE hash only as revision+1', () => {
    const n = cleanLineage();
    const tampered = {
      ...n.make,
      contentHash: '0'.repeat(64),
    };
    const snapshot: VehicleMasterGraphSnapshot = {
      nodes: n.list.map((node) => node.id === tampered.id ? tampered : node),
      rules: [],
      prices: [],
    };

    const { dryRun } = run(snapshot);

    expect(dryRun.status).toBe('READY');
    expect(dryRun.items[0]).toEqual(expect.objectContaining({
      entityId: tampered.id,
      status: 'READY',
      currentRevision: 1,
      expectedRevision: 2,
      resolvedIssueCodes: ['CONTENT_HASH_MISMATCH'],
    }));
    expect(dryRun.items[0]!.changes.map((change) => change.fieldPath)).toEqual(
      expect.arrayContaining(['revision', 'updatedAt', 'contentHash'])
    );
    expect(dryRun.simulatedAudit.status).toBe('PASS');
  });

  it('simulates resealing a current RULE hash without writing', () => {
    const n = cleanLineage();
    const option = sealVehicleMasterNode({
      id: 'opt_dry',
      nodeType: 'OPTION',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '옵션',
      parentId: n.modelYear.id,
      refs: {
        makeId: n.make.id,
        modelId: n.model.id,
        generationId: n.generation.id,
        phaseId: n.phase.id,
        modelYearId: n.modelYear.id,
      },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: at,
      updatedAt: at,
    });
    const base = sealVehicleMasterNode({
      id: 'base_dry',
      nodeType: 'BASE_ITEM',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '기본품목',
      parentId: n.modelYear.id,
      refs: option.refs,
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: at,
      updatedAt: at,
    });
    const variant = sealVehicleMasterNode({
      id: 'variant_dry',
      nodeType: 'VARIANT',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '5인승 2WD',
      parentId: n.powertrain.id,
      refs: {
        ...n.powertrain.refs,
        powertrainId: n.powertrain.id,
      },
      aliases: [],
      attributes: { seats: 5, drivetrain: '2WD' },
      sourceEvidenceIds: [],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: at,
      updatedAt: at,
    });
    const trim = sealVehicleMasterNode({
      id: 'trim_dry',
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
      attributes: { identityKey: '프레스티지' },
      sourceEvidenceIds: [],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: at,
      updatedAt: at,
    });
    const rule = sealVehicleMasterCompatibilityRule({
      id: 'rule_dry',
      revision: 1,
      subjectId: trim.id,
      ruleType: 'INCLUDES',
      targetIds: [base.id],
      scope: { trimId: trim.id },
      condition: { evidence: 'ok' },
      effect: 'VALID',
      priority: 1,
      sourceEvidenceIds: [],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: at,
      updatedAt: at,
    });
    const tamperedRule = {
      ...rule,
      contentHash: 'f'.repeat(64),
    };
    const snapshot: VehicleMasterGraphSnapshot = {
      nodes: [...n.list, option, base, variant, trim],
      rules: [tamperedRule],
      prices: [],
    };
    const before = structuredClone(snapshot);

    const { dryRun } = run(snapshot);

    expect(dryRun.status).toBe('READY');
    expect(dryRun.items[0]).toEqual(expect.objectContaining({
      entityKind: 'RULE',
      entityId: rule.id,
      expectedRevision: 2,
      resolvedIssueCodes: ['CONTENT_HASH_MISMATCH'],
    }));
    expect(dryRun.simulatedAudit.status).toBe('PASS');
    expect(snapshot).toEqual(before);
  });

  it('blocks AUTO_SAFE on an entity that also has SOURCE_REQUIRED issues', () => {
    const n = cleanLineage();
    const broken = sealVehicleMasterNode({
      id: n.powertrain.id,
      nodeType: n.powertrain.nodeType,
      status: n.powertrain.status,
      revision: n.powertrain.revision,
      canonicalName: '1.6 하이브리드',
      parentId: n.powertrain.parentId ?? null,
      refs: n.powertrain.refs,
      aliases: n.powertrain.aliases,
      attributes: {
        identityKey: 'wrong',
        fuelType: 'GASOLINE',
      },
      sourceEvidenceIds: n.powertrain.sourceEvidenceIds,
      effectiveFrom: n.powertrain.effectiveFrom ?? null,
      effectiveTo: n.powertrain.effectiveTo ?? null,
      createdAt: n.powertrain.createdAt,
      updatedAt: n.powertrain.updatedAt,
    });
    const snapshot: VehicleMasterGraphSnapshot = {
      nodes: n.list.map((node) => node.id === broken.id ? broken : node),
      rules: [],
      prices: [],
    };

    const { plan, dryRun } = run(snapshot);

    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueCode: 'POWERTRAIN_IDENTITY_MISMATCH',
        classification: 'AUTO_SAFE',
      }),
      expect.objectContaining({
        issueCode: 'POWERTRAIN_FUEL_TYPE_MISMATCH',
        classification: 'SOURCE_REQUIRED',
      }),
    ]));
    expect(dryRun.status).toBe('BLOCKED');
    expect(dryRun.items[0]).toEqual(expect.objectContaining({
      entityId: broken.id,
      status: 'BLOCKED',
      expectedRevision: null,
      changes: [],
      blockers: expect.arrayContaining([
        expect.stringContaining('NON_AUTO_SAFE_ISSUE:POWERTRAIN_FUEL_TYPE_MISMATCH'),
      ]),
    }));
  });

  it('fails closed when snapshot and audit report no longer match', () => {
    const n = cleanLineage();
    const snapshot: VehicleMasterGraphSnapshot = {
      nodes: n.list,
      rules: [],
      prices: [],
    };
    const audit = auditVehicleMasterGraph(snapshot);
    const plan = buildVehicleMasterRepairPlan(audit);
    const changedSnapshot: VehicleMasterGraphSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) =>
        node.id === n.make.id
          ? { ...node, contentHash: '0'.repeat(64) }
          : node
      ),
    };

    const dryRun = buildVehicleMasterRepairDryRun({
      snapshot: changedSnapshot,
      auditReport: audit,
      repairPlan: plan,
      observedAt: dryRunAt,
    });

    expect(dryRun.status).toBe('STALE_INPUT');
    expect(dryRun.items).toEqual([]);
    expect(dryRun.globalBlockers).toContain('AUDIT_SNAPSHOT_DIGEST_MISMATCH');
  });

  it('returns NO_CHANGES when audit has no AUTO_SAFE repairs', () => {
    const n = cleanLineage();
    const snapshot: VehicleMasterGraphSnapshot = {
      nodes: n.list,
      rules: [],
      prices: [],
    };

    const { dryRun } = run(snapshot);

    expect(dryRun.status).toBe('NO_CHANGES');
    expect(dryRun.counts.autoSafeItems).toBe(0);
    expect(dryRun.items).toEqual([]);
    expect(dryRun.simulatedAudit.status).toBe('PASS');
  });

  it('is deterministic for the same snapshot, plan, and observedAt', () => {
    const n = cleanLineage();
    const broken = sealVehicleMasterNode({
      id: n.powertrain.id,
      nodeType: n.powertrain.nodeType,
      status: n.powertrain.status,
      revision: n.powertrain.revision,
      canonicalName: n.powertrain.canonicalName,
      parentId: n.powertrain.parentId ?? null,
      refs: n.powertrain.refs,
      aliases: n.powertrain.aliases,
      attributes: {
        ...n.powertrain.attributes,
        identityKey: 'wrong',
      },
      sourceEvidenceIds: n.powertrain.sourceEvidenceIds,
      effectiveFrom: n.powertrain.effectiveFrom ?? null,
      effectiveTo: n.powertrain.effectiveTo ?? null,
      createdAt: n.powertrain.createdAt,
      updatedAt: n.powertrain.updatedAt,
    });
    const snapshot: VehicleMasterGraphSnapshot = {
      nodes: n.list.map((node) => node.id === broken.id ? broken : node),
      rules: [],
      prices: [],
    };
    const audit = auditVehicleMasterGraph(snapshot);
    const plan = buildVehicleMasterRepairPlan(audit);

    const a = buildVehicleMasterRepairDryRun({
      snapshot,
      auditReport: audit,
      repairPlan: plan,
      observedAt: dryRunAt,
    });
    const b = buildVehicleMasterRepairDryRun({
      snapshot: {
        ...snapshot,
        nodes: [...snapshot.nodes].reverse(),
      },
      auditReport: audit,
      repairPlan: plan,
      observedAt: dryRunAt,
    });

    expect(b).toEqual(a);
  });
});
