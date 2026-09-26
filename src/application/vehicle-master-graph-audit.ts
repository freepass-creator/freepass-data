import { stableDigest } from '../shared/stable-digest.js';
import type {
  VehicleMasterCompatibilityRule,
  VehicleMasterNode,
  VehicleMasterNodeType,
  VehicleMasterPriceRevision,
} from '../domain/vehicle-master.js';
import {
  canonicalDrivetrain,
  canonicalHierarchyLabelIdentity,
  canonicalPowertrainIdentity,
  canonicalSeatCount,
  canonicalSupplementalIdentity,
  canonicalTrimIdentity,
  inferPowertrainFuelType,
  inferVariantFacts,
} from '../domain/vehicle-master-normalization.js';
import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';

export type VehicleMasterGraphAuditIssue = {
  code: string;
  severity: 'ERROR' | 'WARN';
  entityKind: 'NODE' | 'RULE' | 'PRICE';
  entityId: string;
  fieldPath?: string;
  relatedId?: string;
  detail?: string;
};

export type VehicleMasterGraphAuditReport = {
  status: 'PASS' | 'FAIL';
  digest: string;
  counts: {
    nodes: number;
    rules: number;
    prices: number;
    errors: number;
    warnings: number;
  };
  issues: VehicleMasterGraphAuditIssue[];
};

export type VehicleMasterGraphSnapshot = {
  nodes: readonly VehicleMasterNode[];
  rules: readonly VehicleMasterCompatibilityRule[];
  prices: readonly VehicleMasterPriceRevision[];
};

const NODE_TYPES: readonly VehicleMasterNodeType[] = [
  'MAKE',
  'MODEL',
  'GENERATION',
  'PHASE',
  'MODEL_YEAR',
  'POWERTRAIN',
  'VARIANT',
  'TRIM',
  'BASE_ITEM',
  'OPTION',
  'PACKAGE',
  'OPTION_GROUP',
  'COLOR',
];

const LINEAGE_FIELDS = [
  'makeId',
  'modelId',
  'generationId',
  'phaseId',
  'modelYearId',
  'powertrainId',
  'variantId',
] as const;

const SUPPLEMENTAL_TYPES = new Set<VehicleMasterNodeType>([
  'BASE_ITEM',
  'OPTION',
  'PACKAGE',
  'OPTION_GROUP',
  'COLOR',
]);

const SELECTABLE_SUPPLEMENTAL_TYPES = new Set<VehicleMasterNodeType>([
  'OPTION',
  'PACKAGE',
  'COLOR',
]);

const OPTION_GROUP_RULE_TYPES = new Set<VehicleMasterCompatibilityRule['ruleType']>([
  'ONE_OF',
  'AT_LEAST_ONE',
  'MAX_SELECTION',
]);

const AVAILABILITY_RULE_TYPES = new Set<VehicleMasterCompatibilityRule['ruleType']>([
  'AVAILABLE_IF',
  'UNAVAILABLE_IF',
]);

const DEPENDENCY_RULE_TYPES = new Set<VehicleMasterCompatibilityRule['ruleType']>([
  'REQUIRES',
  'EXCLUDES',
]);

const expectedParentType = (type: VehicleMasterNodeType): VehicleMasterNodeType | null => {
  switch (type) {
    case 'MODEL': return 'MAKE';
    case 'GENERATION': return 'MODEL';
    case 'PHASE': return 'GENERATION';
    case 'MODEL_YEAR': return 'PHASE';
    case 'POWERTRAIN': return 'MODEL_YEAR';
    case 'VARIANT': return 'POWERTRAIN';
    case 'TRIM': return 'VARIANT';
    case 'BASE_ITEM':
    case 'OPTION':
    case 'PACKAGE':
    case 'OPTION_GROUP':
    case 'COLOR':
      return 'MODEL_YEAR';
    default:
      return null;
  }
};

const expectedParentRefField = (type: VehicleMasterNodeType): string | null => {
  switch (type) {
    case 'MODEL': return 'makeId';
    case 'GENERATION': return 'modelId';
    case 'PHASE': return 'generationId';
    case 'MODEL_YEAR': return 'phaseId';
    case 'POWERTRAIN': return 'modelYearId';
    case 'VARIANT': return 'powertrainId';
    case 'TRIM': return 'variantId';
    case 'BASE_ITEM':
    case 'OPTION':
    case 'PACKAGE':
    case 'OPTION_GROUP':
    case 'COLOR':
      return 'modelYearId';
    default:
      return null;
  }
};

const expectedRefType = (field: string): VehicleMasterNodeType | null => {
  switch (field) {
    case 'makeId': return 'MAKE';
    case 'modelId': return 'MODEL';
    case 'generationId': return 'GENERATION';
    case 'phaseId': return 'PHASE';
    case 'modelYearId': return 'MODEL_YEAR';
    case 'powertrainId': return 'POWERTRAIN';
    case 'variantId': return 'VARIANT';
    case 'trimId': return 'TRIM';
    default: return null;
  }
};

const requiredRefFields = (type: VehicleMasterNodeType): readonly string[] => {
  switch (type) {
    case 'MAKE': return [];
    case 'MODEL': return LINEAGE_FIELDS.slice(0, 1);
    case 'GENERATION': return LINEAGE_FIELDS.slice(0, 2);
    case 'PHASE': return LINEAGE_FIELDS.slice(0, 3);
    case 'MODEL_YEAR': return LINEAGE_FIELDS.slice(0, 4);
    case 'POWERTRAIN': return LINEAGE_FIELDS.slice(0, 5);
    case 'VARIANT': return LINEAGE_FIELDS.slice(0, 6);
    case 'TRIM': return LINEAGE_FIELDS.slice(0, 7);
    case 'BASE_ITEM':
    case 'OPTION':
    case 'PACKAGE':
    case 'OPTION_GROUP':
    case 'COLOR':
      return LINEAGE_FIELDS.slice(0, 5);
  }
};

const time = (value?: string | null) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const temporalContains = (
  container: { effectiveFrom?: string | null; effectiveTo?: string | null },
  child: { effectiveFrom?: string | null; effectiveTo?: string | null }
) => {
  const from = time(container.effectiveFrom) ?? Number.NEGATIVE_INFINITY;
  const to = time(container.effectiveTo) ?? Number.POSITIVE_INFINITY;
  const childFrom = time(child.effectiveFrom) ?? Number.NEGATIVE_INFINITY;
  const childTo = time(child.effectiveTo) ?? Number.POSITIVE_INFINITY;
  return childFrom >= from && childTo <= to;
};

const periodsOverlap = (
  a: { effectiveFrom?: string | null; effectiveTo?: string | null },
  b: { effectiveFrom?: string | null; effectiveTo?: string | null }
) => {
  const aFrom = time(a.effectiveFrom) ?? Number.NEGATIVE_INFINITY;
  const aTo = time(a.effectiveTo) ?? Number.POSITIVE_INFINITY;
  const bFrom = time(b.effectiveFrom) ?? Number.NEGATIVE_INFINITY;
  const bTo = time(b.effectiveTo) ?? Number.POSITIVE_INFINITY;
  return aFrom < bTo && bFrom < aTo;
};

const explicitOverlap = (
  a: { effectiveFrom?: string | null; effectiveTo?: string | null },
  b: { effectiveFrom?: string | null; effectiveTo?: string | null }
) => {
  if (!a.effectiveFrom || !b.effectiveFrom) return false;
  return periodsOverlap(a, b);
};

const issueSort = (a: VehicleMasterGraphAuditIssue, b: VehicleMasterGraphAuditIssue) =>
  a.entityKind.localeCompare(b.entityKind) ||
  a.entityId.localeCompare(b.entityId) ||
  a.code.localeCompare(b.code) ||
  (a.fieldPath ?? '').localeCompare(b.fieldPath ?? '') ||
  (a.relatedId ?? '').localeCompare(b.relatedId ?? '') ||
  (a.detail ?? '').localeCompare(b.detail ?? '');

const add = (
  issues: VehicleMasterGraphAuditIssue[],
  issue: VehicleMasterGraphAuditIssue
) => issues.push(issue);

const nodeLineageValue = (node: VehicleMasterNode, field: string) => {
  const expected = expectedRefType(field);
  if (expected && node.nodeType === expected) return node.id;
  return node.refs[field] ?? null;
};

const modelYearValue = (node: VehicleMasterNode) => {
  const value = node.attributes.modelYear;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
};

const explicitModelYearLabel = (value: string): number | null => {
  const normalized = value.normalize('NFKC').trim();
  const match = normalized.match(/^(19|20|21|22)\d{2}(?:년형|MY)?$/i);
  return match ? Number(normalized.slice(0, 4)) : null;
};

const explicitPhaseOverlap = (
  a: { effectiveFrom?: string | null; effectiveTo?: string | null },
  b: { effectiveFrom?: string | null; effectiveTo?: string | null }
) => {
  const aFrom = time(a.effectiveFrom);
  const aTo = time(a.effectiveTo);
  const bFrom = time(b.effectiveFrom);
  const bTo = time(b.effectiveTo);

  if (aFrom === null || bFrom === null) return false;
  if (aTo !== null && bFrom < aTo && bFrom >= aFrom) return true;
  if (bTo !== null && aFrom < bTo && aFrom >= bFrom) return true;
  return false;
};

const normalizedNames = (
  node: VehicleMasterNode,
  normalize: (value: string) => string
) => new Set(
  [node.canonicalName, ...node.aliases]
    .map(normalize)
    .filter(Boolean)
);

const sameScope = (
  a: VehicleMasterCompatibilityRule,
  b: VehicleMasterCompatibilityRule
) => stableDigest(a.scope) === stableDigest(b.scope);

const sameCondition = (
  a: VehicleMasterCompatibilityRule,
  b: VehicleMasterCompatibilityRule
) => stableDigest(a.condition) === stableDigest(b.condition);

const sameTargets = (
  a: VehicleMasterCompatibilityRule,
  b: VehicleMasterCompatibilityRule
) => stableDigest([...a.targetIds].sort()) === stableDigest([...b.targetIds].sort());

const sharedTargets = (
  a: VehicleMasterCompatibilityRule,
  b: VehicleMasterCompatibilityRule
) => a.targetIds.filter((id) => b.targetIds.includes(id)).sort();

type DependencyEdge = {
  from: string;
  to: string;
  rule: VehicleMasterCompatibilityRule;
};

const dependencyEdges = (
  rules: readonly VehicleMasterCompatibilityRule[],
  ruleType: 'REQUIRES' | 'EXCLUDES'
): DependencyEdge[] =>
  rules
    .filter((rule) => rule.ruleType === ruleType)
    .flatMap((rule) =>
      rule.targetIds.map((to) => ({
        from: rule.subjectId,
        to,
        rule,
      }))
    );

const rulesShareEffectiveWindow = (
  rules: readonly VehicleMasterCompatibilityRule[]
) => {
  const start = Math.max(
    ...rules.map((rule) => time(rule.effectiveFrom) ?? Number.NEGATIVE_INFINITY)
  );
  const end = Math.min(
    ...rules.map((rule) => time(rule.effectiveTo) ?? Number.POSITIVE_INFINITY)
  );
  return start < end;
};

const findRequiresPath = (
  edges: readonly DependencyEdge[],
  start: string,
  goal: string,
  requiredRules: readonly VehicleMasterCompatibilityRule[] = []
): DependencyEdge[] | null => {
  const ordered = [...edges].sort((a, b) =>
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.rule.id.localeCompare(b.rule.id)
  );

  const visit = (
    current: string,
    visited: Set<string>,
    path: DependencyEdge[]
  ): DependencyEdge[] | null => {
    if (current === goal) return path;

    for (const edge of ordered) {
      if (edge.from !== current || visited.has(edge.to)) continue;
      const candidateRules = [
        ...requiredRules,
        ...path.map((item) => item.rule),
        edge.rule,
      ];
      if (!rulesShareEffectiveWindow(candidateRules)) continue;

      const nextVisited = new Set(visited);
      nextVisited.add(edge.to);
      const found = visit(edge.to, nextVisited, [...path, edge]);
      if (found) return found;
    }
    return null;
  };

  return visit(start, new Set([start]), []);
};

const expectedPriceTargetType = (
  type: VehicleMasterPriceRevision['priceType']
): VehicleMasterNodeType | null => {
  switch (type) {
    case 'BASE': return 'TRIM';
    case 'OPTION': return 'OPTION';
    case 'PACKAGE': return 'PACKAGE';
    case 'COLOR': return 'COLOR';
    case 'ADJUSTMENT': return null;
  }
};

function auditNodeStructure(
  nodes: readonly VehicleMasterNode[],
  issues: VehicleMasterGraphAuditIssue[]
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    const parentType = expectedParentType(node.nodeType);
    const parentRefField = expectedParentRefField(node.nodeType);

    if (parentType && !node.parentId) {
      add(issues, {
        code: 'PARENT_ID_REQUIRED',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'parentId',
        detail: parentType,
      });
    }

    if (node.parentId) {
      if (node.parentId === node.id) {
        add(issues, {
          code: 'REFERENCE_NODE_SELF',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: node.id,
          fieldPath: 'parentId',
          relatedId: node.parentId,
        });
      } else {
        const parent = byId.get(node.parentId);
        if (!parent) {
          add(issues, {
            code: 'PARENT_NODE_MISSING',
            severity: 'ERROR',
            entityKind: 'NODE',
            entityId: node.id,
            fieldPath: 'parentId',
            relatedId: node.parentId,
          });
        } else {
          if (parentType && parent.nodeType !== parentType) {
            add(issues, {
              code: 'PARENT_NODE_TYPE_MISMATCH',
              severity: 'ERROR',
              entityKind: 'NODE',
              entityId: node.id,
              fieldPath: 'parentId',
              relatedId: parent.id,
              detail: `${parent.nodeType}!=${parentType}`,
            });
          }
          if (node.status !== 'HOLD' && parent.status === 'HOLD') {
            add(issues, {
              code: 'PARENT_NODE_HOLD',
              severity: 'ERROR',
              entityKind: 'NODE',
              entityId: node.id,
              fieldPath: 'parentId',
              relatedId: parent.id,
            });
          }
          if (!temporalContains(parent, node)) {
            add(issues, {
              code: 'PARENT_EFFECTIVE_RANGE_MISMATCH',
              severity: 'ERROR',
              entityKind: 'NODE',
              entityId: node.id,
              fieldPath: 'parentId',
              relatedId: parent.id,
            });
          }
        }
      }
    }

    if (
      parentRefField &&
      node.parentId &&
      node.refs[parentRefField] &&
      node.parentId !== node.refs[parentRefField]
    ) {
      add(issues, {
        code: 'PARENT_REFERENCE_MISMATCH',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'parentId',
        detail: `${node.parentId}!=${node.refs[parentRefField]}`,
      });
    }

    for (const field of requiredRefFields(node.nodeType)) {
      if (!node.refs[field]) {
        add(issues, {
          code: 'REQUIRED_REFERENCE_MISSING',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: node.id,
          fieldPath: `refs.${field}`,
          detail: node.nodeType,
        });
      }
    }

    for (const [field, refId] of Object.entries(node.refs).sort(([a], [b]) => a.localeCompare(b))) {
      if (!refId) continue;
      if (refId === node.id) {
        add(issues, {
          code: 'REFERENCE_NODE_SELF',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: node.id,
          fieldPath: `refs.${field}`,
          relatedId: refId,
        });
        continue;
      }

      const ref = byId.get(refId);
      if (!ref) {
        add(issues, {
          code: 'REFERENCE_NODE_MISSING',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: node.id,
          fieldPath: `refs.${field}`,
          relatedId: refId,
        });
        continue;
      }

      const expected = expectedRefType(field);
      if (expected && ref.nodeType !== expected) {
        add(issues, {
          code: 'REFERENCE_NODE_TYPE_MISMATCH',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: node.id,
          fieldPath: `refs.${field}`,
          relatedId: ref.id,
          detail: `${ref.nodeType}!=${expected}`,
        });
      }

      if (node.status !== 'HOLD' && ref.status === 'HOLD') {
        add(issues, {
          code: 'REFERENCE_NODE_HOLD',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: node.id,
          fieldPath: `refs.${field}`,
          relatedId: ref.id,
        });
      }

      if (!temporalContains(ref, node)) {
        add(issues, {
          code: 'REFERENCE_EFFECTIVE_RANGE_MISMATCH',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: node.id,
          fieldPath: `refs.${field}`,
          relatedId: ref.id,
        });
      }

      if (expected && ref.nodeType === expected) {
        const index = LINEAGE_FIELDS.indexOf(field as typeof LINEAGE_FIELDS[number]);
        if (index >= 0) {
          for (const ancestorField of LINEAGE_FIELDS.slice(0, index)) {
            const wanted = node.refs[ancestorField];
            const actual = ref.refs[ancestorField];
            if (!actual) {
              add(issues, {
                code: 'REFERENCE_LINEAGE_INCOMPLETE',
                severity: 'ERROR',
                entityKind: 'NODE',
                entityId: node.id,
                fieldPath: `refs.${field}.${ancestorField}`,
                relatedId: ref.id,
              });
            } else if (wanted && actual !== wanted) {
              add(issues, {
                code: 'REFERENCE_LINEAGE_MISMATCH',
                severity: 'ERROR',
                entityKind: 'NODE',
                entityId: node.id,
                fieldPath: `refs.${field}.${ancestorField}`,
                relatedId: ref.id,
                detail: `${actual}!=${wanted}`,
              });
            }
          }
        }
      }
    }
  }

  for (const start of nodes) {
    const seen = new Set<string>([start.id]);
    let current = start;
    while (current.parentId) {
      const parent = byId.get(current.parentId);
      if (!parent) break;
      if (seen.has(parent.id)) {
        add(issues, {
          code: 'PARENT_CYCLE',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: start.id,
          fieldPath: 'parentId',
          relatedId: parent.id,
        });
        break;
      }
      seen.add(parent.id);
      current = parent;
    }
  }
}

function auditNodeSemantics(
  nodes: readonly VehicleMasterNode[],
  issues: VehicleMasterGraphAuditIssue[]
) {
  const active = nodes.filter((node) => node.status !== 'HOLD');

  const hierarchyTypes: readonly VehicleMasterNodeType[] = [
    'MAKE',
    'MODEL',
    'GENERATION',
    'PHASE',
  ];
  for (const type of hierarchyTypes) {
    const rows = active.filter((node) => node.nodeType === type);
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i]!;
        const b = rows[j]!;
        if (type !== 'MAKE' && a.parentId !== b.parentId) continue;
        const aNames = normalizedNames(a, canonicalHierarchyLabelIdentity);
        const bNames = normalizedNames(b, canonicalHierarchyLabelIdentity);
        if (![...aNames].some((name) => bNames.has(name))) continue;
        add(issues, {
          code:
            type === 'MAKE'
              ? 'MAKE_DUPLICATE'
              : type === 'MODEL'
                ? 'MODEL_DUPLICATE_IN_MAKE'
                : type === 'GENERATION'
                  ? 'GENERATION_DUPLICATE_IN_MODEL'
                  : 'PHASE_DUPLICATE_IN_GENERATION',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: b.id,
          fieldPath: 'canonicalName',
          relatedId: a.id,
        });
      }
    }
  }

  const modelYears = active.filter((node) => node.nodeType === 'MODEL_YEAR');
  for (const node of modelYears) {
    const value = modelYearValue(node);
    if (value === null || value < 1900 || value > 2200) {
      add(issues, {
        code: 'MODEL_YEAR_VALUE_INVALID',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'attributes.modelYear',
      });
      continue;
    }

    const nameYear = explicitModelYearLabel(node.canonicalName);
    if (nameYear !== null && nameYear !== value) {
      add(issues, {
        code: 'MODEL_YEAR_NAME_MISMATCH',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'canonicalName',
        detail: `${nameYear}!=${value}`,
      });
    }

    for (const alias of node.aliases) {
      const aliasYear = explicitModelYearLabel(alias);
      if (aliasYear !== null && aliasYear !== value) {
        add(issues, {
          code: 'MODEL_YEAR_ALIAS_MISMATCH',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: node.id,
          fieldPath: 'aliases',
          detail: `${alias}!=${value}`,
        });
      }
    }
  }
  for (let i = 0; i < modelYears.length; i += 1) {
    for (let j = i + 1; j < modelYears.length; j += 1) {
      const a = modelYears[i]!;
      const b = modelYears[j]!;
      if (a.parentId !== b.parentId) continue;
      if (modelYearValue(a) !== null && modelYearValue(a) === modelYearValue(b)) {
        add(issues, {
          code: 'MODEL_YEAR_DUPLICATE_IN_PHASE',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: b.id,
          fieldPath: 'attributes.modelYear',
          relatedId: a.id,
        });
      }
    }
  }

  const powertrains = active.filter((node) => node.nodeType === 'POWERTRAIN');
  for (const node of powertrains) {
    const expectedIdentity = canonicalPowertrainIdentity(node.canonicalName);
    const storedIdentity =
      typeof node.attributes.identityKey === 'string'
        ? node.attributes.identityKey.trim()
        : '';
    if (!storedIdentity || storedIdentity !== expectedIdentity) {
      add(issues, {
        code: 'POWERTRAIN_IDENTITY_MISMATCH',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'attributes.identityKey',
        detail: `${storedIdentity || 'MISSING'}!=${expectedIdentity}`,
      });
    }

    const inferredFuel = inferPowertrainFuelType(node.canonicalName);
    const storedFuel =
      typeof node.attributes.fuelType === 'string'
        ? node.attributes.fuelType.trim().toUpperCase()
        : null;
    if (inferredFuel && storedFuel !== inferredFuel) {
      add(issues, {
        code: 'POWERTRAIN_FUEL_TYPE_MISMATCH',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'attributes.fuelType',
        detail: `${storedFuel ?? 'MISSING'}!=${inferredFuel}`,
      });
    }
  }

  for (let i = 0; i < powertrains.length; i += 1) {
    for (let j = i + 1; j < powertrains.length; j += 1) {
      const a = powertrains[i]!;
      const b = powertrains[j]!;
      if (a.parentId !== b.parentId) continue;
      if (
        canonicalPowertrainIdentity(a.canonicalName) ===
        canonicalPowertrainIdentity(b.canonicalName)
      ) {
        add(issues, {
          code: 'POWERTRAIN_DUPLICATE_IN_MODEL_YEAR',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: b.id,
          fieldPath: 'canonicalName',
          relatedId: a.id,
        });
      }
    }
  }

  const variants = active.filter((node) => node.nodeType === 'VARIANT');
  for (const node of variants) {
    const seats = canonicalSeatCount(node.attributes.seats);
    const storedDrivetrain =
      typeof node.attributes.drivetrain === 'string'
        ? node.attributes.drivetrain.trim()
        : null;
    const drivetrain = canonicalDrivetrain(storedDrivetrain);

    if (seats === null) {
      add(issues, {
        code: 'VARIANT_SEATS_INVALID',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'attributes.seats',
      });
    }
    if (drivetrain === null) {
      add(issues, {
        code: 'VARIANT_DRIVETRAIN_INVALID',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'attributes.drivetrain',
      });
    } else if (storedDrivetrain !== drivetrain) {
      add(issues, {
        code: 'VARIANT_DRIVETRAIN_NOT_CANONICAL',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'attributes.drivetrain',
        detail: `${storedDrivetrain}!=${drivetrain}`,
      });
    }

    const labelFacts = inferVariantFacts(node.canonicalName);
    if (labelFacts.seats !== null && seats !== null && labelFacts.seats !== seats) {
      add(issues, {
        code: 'VARIANT_NAME_SEATS_MISMATCH',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'canonicalName',
        detail: `${labelFacts.seats}!=${seats}`,
      });
    }
    if (
      labelFacts.drivetrain !== null &&
      drivetrain !== null &&
      labelFacts.drivetrain !== drivetrain
    ) {
      add(issues, {
        code: 'VARIANT_NAME_DRIVETRAIN_MISMATCH',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'canonicalName',
        detail: `${labelFacts.drivetrain}!=${drivetrain}`,
      });
    }
  }

  for (let i = 0; i < variants.length; i += 1) {
    for (let j = i + 1; j < variants.length; j += 1) {
      const a = variants[i]!;
      const b = variants[j]!;
      if (a.parentId !== b.parentId) continue;
      const aSeats = canonicalSeatCount(a.attributes.seats);
      const bSeats = canonicalSeatCount(b.attributes.seats);
      const aDrive = canonicalDrivetrain(
        typeof a.attributes.drivetrain === 'string' ? a.attributes.drivetrain : null
      );
      const bDrive = canonicalDrivetrain(
        typeof b.attributes.drivetrain === 'string' ? b.attributes.drivetrain : null
      );
      if (
        aSeats !== null &&
        aSeats === bSeats &&
        aDrive !== null &&
        aDrive === bDrive
      ) {
        add(issues, {
          code: 'VARIANT_DUPLICATE_IN_POWERTRAIN',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: b.id,
          fieldPath: 'canonicalName',
          relatedId: a.id,
        });
      }
    }
  }

  const trims = active.filter((node) => node.nodeType === 'TRIM');
  for (const node of trims) {
    const expectedIdentity = canonicalTrimIdentity(node.canonicalName);
    const storedIdentity =
      typeof node.attributes.identityKey === 'string'
        ? node.attributes.identityKey.trim()
        : '';
    if (!storedIdentity || storedIdentity !== expectedIdentity) {
      add(issues, {
        code: 'TRIM_IDENTITY_MISMATCH',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: node.id,
        fieldPath: 'attributes.identityKey',
        detail: `${storedIdentity || 'MISSING'}!=${expectedIdentity}`,
      });
    }
  }

  for (let i = 0; i < trims.length; i += 1) {
    for (let j = i + 1; j < trims.length; j += 1) {
      const a = trims[i]!;
      const b = trims[j]!;
      if (a.parentId !== b.parentId) continue;
      const aNames = normalizedNames(a, canonicalTrimIdentity);
      const bNames = normalizedNames(b, canonicalTrimIdentity);
      if ([...aNames].some((name) => bNames.has(name))) {
        add(issues, {
          code: 'TRIM_DUPLICATE_IN_VARIANT',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: b.id,
          fieldPath: 'canonicalName',
          relatedId: a.id,
        });
      }
    }
  }

  const phases = active.filter((node) => node.nodeType === 'PHASE');
  for (let i = 0; i < phases.length; i += 1) {
    for (let j = i + 1; j < phases.length; j += 1) {
      const a = phases[i]!;
      const b = phases[j]!;
      if (!a.parentId || a.parentId !== b.parentId) continue;
      if (!explicitPhaseOverlap(a, b)) continue;
      add(issues, {
        code: 'PHASE_EFFECTIVE_RANGE_OVERLAP',
        severity: 'ERROR',
        entityKind: 'NODE',
        entityId: b.id,
        fieldPath: 'effectiveFrom',
        relatedId: a.id,
      });
    }
  }

  const supplemental = active.filter((node) => SUPPLEMENTAL_TYPES.has(node.nodeType));
  for (let i = 0; i < supplemental.length; i += 1) {
    for (let j = i + 1; j < supplemental.length; j += 1) {
      const a = supplemental[i]!;
      const b = supplemental[j]!;
      if (!a.refs.modelYearId || a.refs.modelYearId !== b.refs.modelYearId) continue;
      const aNames = normalizedNames(a, canonicalSupplementalIdentity);
      const bNames = normalizedNames(b, canonicalSupplementalIdentity);
      if (![...aNames].some((name) => bNames.has(name))) continue;

      if (a.nodeType === b.nodeType) {
        add(issues, {
          code: 'SUPPLEMENTAL_DUPLICATE_IN_MODEL_YEAR',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: b.id,
          fieldPath: 'canonicalName',
          relatedId: a.id,
        });
      } else if (
        SELECTABLE_SUPPLEMENTAL_TYPES.has(a.nodeType) &&
        SELECTABLE_SUPPLEMENTAL_TYPES.has(b.nodeType)
      ) {
        add(issues, {
          code: 'SUPPLEMENTAL_TYPE_CONFLICT_IN_MODEL_YEAR',
          severity: 'ERROR',
          entityKind: 'NODE',
          entityId: b.id,
          fieldPath: 'nodeType',
          relatedId: a.id,
          detail: `${a.nodeType}!=${b.nodeType}`,
        });
      }
    }
  }
}

function auditPrices(
  prices: readonly VehicleMasterPriceRevision[],
  nodes: readonly VehicleMasterNode[],
  issues: VehicleMasterGraphAuditIssue[]
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const price of prices) {
    const target = byId.get(price.targetId);
    if (!target) {
      add(issues, {
        code: 'PRICE_TARGET_MISSING',
        severity: 'ERROR',
        entityKind: 'PRICE',
        entityId: price.id,
        fieldPath: 'targetId',
        relatedId: price.targetId,
      });
      continue;
    }

    const expected = expectedPriceTargetType(price.priceType);
    if (expected && target.nodeType !== expected) {
      add(issues, {
        code: 'PRICE_TARGET_TYPE_MISMATCH',
        severity: 'ERROR',
        entityKind: 'PRICE',
        entityId: price.id,
        fieldPath: 'targetId',
        relatedId: target.id,
        detail: `${target.nodeType}!=${expected}`,
      });
    }
    if (target.status === 'HOLD') {
      add(issues, {
        code: 'PRICE_TARGET_HOLD',
        severity: 'ERROR',
        entityKind: 'PRICE',
        entityId: price.id,
        fieldPath: 'targetId',
        relatedId: target.id,
      });
    }
    if (!temporalContains(target, price)) {
      add(issues, {
        code: 'PRICE_TARGET_EFFECTIVE_RANGE_MISMATCH',
        severity: 'ERROR',
        entityKind: 'PRICE',
        entityId: price.id,
        fieldPath: 'targetId',
        relatedId: target.id,
      });
    }
  }

  const groups = new Map<string, VehicleMasterPriceRevision[]>();
  for (const price of prices) {
    const key = `${price.targetId}|${price.priceType}`;
    const list = groups.get(key) ?? [];
    list.push(price);
    groups.set(key, list);
  }

  for (const rows of groups.values()) {
    rows.sort((a, b) =>
      (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? '') ||
      a.id.localeCompare(b.id)
    );
    if (rows.length > 1) {
      for (const row of rows) {
        if (!row.effectiveFrom) {
          add(issues, {
            code: 'PRICE_EFFECTIVE_FROM_REQUIRED_FOR_HISTORY',
            severity: 'ERROR',
            entityKind: 'PRICE',
            entityId: row.id,
            fieldPath: 'effectiveFrom',
            relatedId: row.targetId,
          });
        }
      }
    }
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i]!;
        const b = rows[j]!;
        if (a.effectiveFrom && a.effectiveFrom === b.effectiveFrom) {
          add(issues, {
            code: 'PRICE_EFFECTIVE_START_CONFLICT',
            severity: 'ERROR',
            entityKind: 'PRICE',
            entityId: b.id,
            fieldPath: 'effectiveFrom',
            relatedId: a.id,
          });
        } else if (explicitOverlap(a, b)) {
          add(issues, {
            code: 'PRICE_EXPLICIT_RANGE_OVERLAP',
            severity: 'ERROR',
            entityKind: 'PRICE',
            entityId: b.id,
            fieldPath: 'effectiveFrom',
            relatedId: a.id,
          });
        }
      }
    }
  }
}

function auditRuleReference(
  rule: VehicleMasterCompatibilityRule,
  node: VehicleMasterNode,
  fieldPath: string,
  anchor: VehicleMasterNode | null,
  issues: VehicleMasterGraphAuditIssue[]
) {
  for (const field of requiredRefFields(node.nodeType)) {
    if (!node.refs[field]) {
      add(issues, {
        code: 'RULE_LINEAGE_INCOMPLETE',
        severity: 'ERROR',
        entityKind: 'RULE',
        entityId: rule.id,
        fieldPath: `${fieldPath}.${field}`,
        relatedId: node.id,
      });
    }
  }
  if (node.status === 'HOLD') {
    add(issues, {
      code: fieldPath === 'subjectId' ? 'RULE_SUBJECT_HOLD' : 'RULE_TARGET_HOLD',
      severity: 'ERROR',
      entityKind: 'RULE',
      entityId: rule.id,
      fieldPath,
      relatedId: node.id,
    });
  }
  if (!anchor) return;
  for (const field of LINEAGE_FIELDS) {
    const a = nodeLineageValue(anchor, field);
    const b = nodeLineageValue(node, field);
    if (a !== null && b !== null && a !== b) {
      add(issues, {
        code: 'RULE_LINEAGE_MISMATCH',
        severity: 'ERROR',
        entityKind: 'RULE',
        entityId: rule.id,
        fieldPath: `${fieldPath}.${field}`,
        relatedId: node.id,
        detail: `${b}!=${a}`,
      });
    }
  }
}

function auditRules(
  rules: readonly VehicleMasterCompatibilityRule[],
  nodes: readonly VehicleMasterNode[],
  issues: VehicleMasterGraphAuditIssue[]
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const rule of rules) {
    const subject = byId.get(rule.subjectId) ?? null;
    if (!subject) {
      add(issues, {
        code: 'RULE_SUBJECT_MISSING',
        severity: 'ERROR',
        entityKind: 'RULE',
        entityId: rule.id,
        fieldPath: 'subjectId',
        relatedId: rule.subjectId,
      });
    } else {
      auditRuleReference(rule, subject, 'subjectId', null, issues);
    }

    for (const targetId of rule.targetIds) {
      const target = byId.get(targetId) ?? null;
      if (!target) {
        add(issues, {
          code: 'RULE_TARGET_MISSING',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: rule.id,
          fieldPath: 'targetIds',
          relatedId: targetId,
        });
      } else {
        auditRuleReference(rule, target, `targetIds.${target.id}`, subject, issues);
      }
    }

    for (const [field, refId] of Object.entries(rule.scope).sort(([a], [b]) => a.localeCompare(b))) {
      if (!refId) continue;
      const node = byId.get(refId);
      if (!node) {
        add(issues, {
          code: 'RULE_SCOPE_REFERENCE_MISSING',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: rule.id,
          fieldPath: `scope.${field}`,
          relatedId: refId,
        });
        continue;
      }
      const expected = expectedRefType(field);
      if (expected && node.nodeType !== expected) {
        add(issues, {
          code: 'RULE_SCOPE_REFERENCE_TYPE_MISMATCH',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: rule.id,
          fieldPath: `scope.${field}`,
          relatedId: node.id,
          detail: `${node.nodeType}!=${expected}`,
        });
      }
      if (node.status === 'HOLD') {
        add(issues, {
          code: 'RULE_SCOPE_REFERENCE_HOLD',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: rule.id,
          fieldPath: `scope.${field}`,
          relatedId: node.id,
        });
      }
      auditRuleReference(rule, node, `scope.${field}`, subject, issues);
    }

    if (rule.ruleType === 'INCLUDES') {
      if (subject && subject.nodeType !== 'TRIM') {
        add(issues, {
          code: 'RULE_INCLUDES_SUBJECT_TYPE_MISMATCH',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: rule.id,
          fieldPath: 'subjectId',
          detail: `${subject.nodeType}!=TRIM`,
        });
      }
      for (const targetId of rule.targetIds) {
        const target = byId.get(targetId);
        if (target && target.nodeType !== 'BASE_ITEM') {
          add(issues, {
            code: 'RULE_INCLUDES_TARGET_TYPE_MISMATCH',
            severity: 'ERROR',
            entityKind: 'RULE',
            entityId: rule.id,
            fieldPath: `targetIds.${target.id}`,
            relatedId: target.id,
            detail: `${target.nodeType}!=BASE_ITEM`,
          });
        }
      }
      if (rule.effect !== 'VALID') {
        add(issues, {
          code: 'RULE_INCLUDES_EFFECT_MISMATCH',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: rule.id,
          fieldPath: 'effect',
          detail: `${rule.effect}!=VALID`,
        });
      }
    }

    if (rule.ruleType === 'PRICE_OVERRIDE') {
      add(issues, {
        code: 'RULE_PRICE_OVERRIDE_UNDEFINED',
        severity: 'ERROR',
        entityKind: 'RULE',
        entityId: rule.id,
        fieldPath: 'ruleType',
      });
    }

    if (AVAILABILITY_RULE_TYPES.has(rule.ruleType)) {
      if (!rule.condition || !Object.keys(rule.condition).length) {
        add(issues, {
          code: 'RULE_AVAILABILITY_CONDITION_REQUIRED',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: rule.id,
          fieldPath: 'condition',
        });
      }
      const expectedEffect = rule.ruleType === 'AVAILABLE_IF' ? 'VALID' : 'INVALID';
      if (rule.effect !== expectedEffect) {
        add(issues, {
          code: 'RULE_AVAILABILITY_EFFECT_MISMATCH',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: rule.id,
          fieldPath: 'effect',
          detail: `${rule.effect}!=${expectedEffect}`,
        });
      }
    }

    if (OPTION_GROUP_RULE_TYPES.has(rule.ruleType)) {
      if (subject && subject.nodeType !== 'OPTION_GROUP') {
        add(issues, {
          code: 'RULE_GROUP_SUBJECT_TYPE_MISMATCH',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: rule.id,
          fieldPath: 'subjectId',
          detail: `${subject.nodeType}!=OPTION_GROUP`,
        });
      }
      if (rule.targetIds.length < 2) {
        add(issues, {
          code: 'RULE_GROUP_TARGET_COUNT_INVALID',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: rule.id,
          fieldPath: 'targetIds',
          detail: String(rule.targetIds.length),
        });
      }
      for (const targetId of rule.targetIds) {
        const target = byId.get(targetId);
        if (target && !SELECTABLE_SUPPLEMENTAL_TYPES.has(target.nodeType)) {
          add(issues, {
            code: 'RULE_GROUP_TARGET_TYPE_MISMATCH',
            severity: 'ERROR',
            entityKind: 'RULE',
            entityId: rule.id,
            fieldPath: `targetIds.${target.id}`,
            relatedId: target.id,
            detail: target.nodeType,
          });
        }
      }
      if (rule.ruleType === 'MAX_SELECTION') {
        const max = rule.condition?.maxSelection;
        if (
          typeof max !== 'number' ||
          !Number.isSafeInteger(max) ||
          max < 1 ||
          max > rule.targetIds.length
        ) {
          add(issues, {
            code: 'RULE_GROUP_MAX_SELECTION_INVALID',
            severity: 'ERROR',
            entityKind: 'RULE',
            entityId: rule.id,
            fieldPath: 'condition.maxSelection',
            detail: String(max ?? 'MISSING'),
          });
        }
      }
    }
  }

  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const a = rules[i]!;
      const b = rules[j]!;
      if (!sameScope(a, b) || !periodsOverlap(a, b)) continue;

      if (
        AVAILABILITY_RULE_TYPES.has(a.ruleType) &&
        AVAILABILITY_RULE_TYPES.has(b.ruleType) &&
        a.subjectId === b.subjectId &&
        sameTargets(a, b) &&
        sameCondition(a, b)
      ) {
        add(issues, {
          code:
            a.ruleType === b.ruleType
              ? 'RULE_AVAILABILITY_DUPLICATE'
              : 'RULE_AVAILABILITY_CONFLICT',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: b.id,
          fieldPath: 'ruleType',
          relatedId: a.id,
        });
      }

      if (
        a.ruleType === 'INCLUDES' &&
        b.ruleType === 'INCLUDES' &&
        a.subjectId === b.subjectId &&
        sameTargets(a, b)
      ) {
        add(issues, {
          code: 'RULE_INCLUDES_DUPLICATE',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: b.id,
          fieldPath: 'ruleType',
          relatedId: a.id,
        });
      }

      const includes = a.ruleType === 'INCLUDES' ? a : b.ruleType === 'INCLUDES' ? b : null;
      const excludes = a.ruleType === 'EXCLUDES' ? a : b.ruleType === 'EXCLUDES' ? b : null;
      if (includes && excludes && includes.subjectId === excludes.subjectId) {
        const shared = sharedTargets(includes, excludes);
        if (shared.length) {
          add(issues, {
            code: 'RULE_INCLUDES_CONFLICT',
            severity: 'ERROR',
            entityKind: 'RULE',
            entityId: b.id,
            fieldPath: `targetIds.${shared[0]}`,
            relatedId: a.id,
          });
        }
      }

      if (
        DEPENDENCY_RULE_TYPES.has(a.ruleType) &&
        DEPENDENCY_RULE_TYPES.has(b.ruleType) &&
        a.subjectId === b.subjectId
      ) {
        const shared = sharedTargets(a, b);
        if (
          shared.length &&
          ((a.ruleType === 'REQUIRES' && b.ruleType === 'EXCLUDES') ||
            (a.ruleType === 'EXCLUDES' && b.ruleType === 'REQUIRES'))
        ) {
          add(issues, {
            code: 'RULE_DEPENDENCY_CONFLICT',
            severity: 'ERROR',
            entityKind: 'RULE',
            entityId: b.id,
            fieldPath: `targetIds.${shared[0]}`,
            relatedId: a.id,
          });
        } else if (a.ruleType === b.ruleType && sameTargets(a, b)) {
          add(issues, {
            code: 'RULE_DEPENDENCY_DUPLICATE',
            severity: 'ERROR',
            entityKind: 'RULE',
            entityId: b.id,
            fieldPath: 'ruleType',
            relatedId: a.id,
          });
        }
      }

      if (
        OPTION_GROUP_RULE_TYPES.has(a.ruleType) &&
        OPTION_GROUP_RULE_TYPES.has(b.ruleType) &&
        a.subjectId === b.subjectId &&
        sameTargets(a, b)
      ) {
        const aMax = a.ruleType === 'MAX_SELECTION' ? a.condition?.maxSelection : null;
        const bMax = b.ruleType === 'MAX_SELECTION' ? b.condition?.maxSelection : null;
        const duplicate =
          a.ruleType === b.ruleType &&
          (a.ruleType !== 'MAX_SELECTION' || aMax === bMax);
        const conflict =
          (a.ruleType === 'ONE_OF' && b.ruleType === 'MAX_SELECTION' && bMax !== 1) ||
          (b.ruleType === 'ONE_OF' && a.ruleType === 'MAX_SELECTION' && aMax !== 1) ||
          (a.ruleType === 'MAX_SELECTION' &&
            b.ruleType === 'MAX_SELECTION' &&
            aMax !== bMax);

        if (duplicate || conflict) {
          add(issues, {
            code: duplicate ? 'RULE_GROUP_DUPLICATE' : 'RULE_GROUP_CONSTRAINT_CONFLICT',
            severity: 'ERROR',
            entityKind: 'RULE',
            entityId: b.id,
            fieldPath: 'ruleType',
            relatedId: a.id,
          });
        }
      }
    }
  }
}

export function auditVehicleMasterGraph(
  input: VehicleMasterGraphSnapshot
): VehicleMasterGraphAuditReport {
  const nodes = [...input.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const rules = [...input.rules].sort((a, b) => a.id.localeCompare(b.id));
  const prices = [...input.prices].sort((a, b) => a.id.localeCompare(b.id));
  const issues: VehicleMasterGraphAuditIssue[] = [];

  auditNodeStructure(nodes, issues);
  auditNodeSemantics(nodes, issues);
  auditRules(rules, nodes, issues);
  auditPrices(prices, nodes, issues);

  const sortedIssues = issues.sort(issueSort);
  const errors = sortedIssues.filter((issue) => issue.severity === 'ERROR').length;
  const warnings = sortedIssues.length - errors;
  const counts = {
    nodes: nodes.length,
    rules: rules.length,
    prices: prices.length,
    errors,
    warnings,
  };

  return {
    status: errors ? 'FAIL' : 'PASS',
    digest: stableDigest({ counts, issues: sortedIssues }),
    counts,
    issues: sortedIssues,
  };
}

export async function auditVehicleMasterStore(
  store: VehicleMasterStore
): Promise<VehicleMasterGraphAuditReport> {
  const nodeGroups = await Promise.all(
    NODE_TYPES.map((nodeType) => store.listNodesByType(nodeType))
  );
  const [rules, prices] = await Promise.all([
    store.listCompatibilityRules(),
    store.listPriceRevisions(),
  ]);

  return auditVehicleMasterGraph({
    nodes: nodeGroups.flat(),
    rules,
    prices,
  });
}
