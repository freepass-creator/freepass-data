import { stableDigest } from '../shared/stable-digest.js';
import type {
  VehicleMasterCompatibilityRule,
  VehicleMasterNode,
  VehicleMasterNodeType,
  VehicleMasterPipelineRecord,
  VehicleMasterPriceRevision,
  VehicleMasterSourceDocument,
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
  entityKind: 'NODE' | 'RULE' | 'PRICE' | 'SOURCE' | 'REVISION' | 'PIPELINE';
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
  sources?: readonly VehicleMasterSourceDocument[];
  nodeRevisions?: readonly VehicleMasterNode[];
  ruleRevisions?: readonly VehicleMasterCompatibilityRule[];
  pipelineRecords?: readonly VehicleMasterPipelineRecord[];
};

const PIPELINE_KINDS: readonly VehicleMasterPipelineRecord['kind'][] = [
  'RAW_RECORD',
  'NORMALIZED_RECORD',
  'CANDIDATE_FACT',
  'EVIDENCE_SET',
  'REVISION_CANDIDATE',
  'PROMOTION_RESULT',
  'CHANGE_EVENT',
  'AUDIT_REPORT',
];

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

const expectedContentHash = <T extends { contentHash: string }>(record: T) => {
  const { contentHash: _contentHash, ...payload } = record;
  return stableDigest(payload);
};

const auditContentHash = (
  record: { contentHash: string },
  entityKind: VehicleMasterGraphAuditIssue['entityKind'],
  entityId: string,
  issues: VehicleMasterGraphAuditIssue[]
) => {
  const expected = expectedContentHash(record);
  if (record.contentHash !== expected) {
    add(issues, {
      code: 'CONTENT_HASH_MISMATCH',
      severity: 'ERROR',
      entityKind,
      entityId,
      fieldPath: 'contentHash',
      detail: `${record.contentHash}!=${expected}`,
    });
  }
};

const sourceEvidenceIds = (
  record: VehicleMasterNode | VehicleMasterCompatibilityRule | VehicleMasterPriceRevision
) => record.sourceEvidenceIds;

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
  const dedupe = nodes.filter((node) => node.status !== 'HOLD');

  const hierarchyTypes: readonly VehicleMasterNodeType[] = [
    'MAKE',
    'MODEL',
    'GENERATION',
    'PHASE',
  ];
  for (const type of hierarchyTypes) {
    const rows = dedupe.filter((node) => node.nodeType === type);
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

  const modelYears = nodes.filter((node) => node.nodeType === 'MODEL_YEAR');
  const dedupeModelYears = dedupe.filter((node) => node.nodeType === 'MODEL_YEAR');
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
  for (let i = 0; i < dedupeModelYears.length; i += 1) {
    for (let j = i + 1; j < dedupeModelYears.length; j += 1) {
      const a = dedupeModelYears[i]!;
      const b = dedupeModelYears[j]!;
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

  const powertrains = nodes.filter((node) => node.nodeType === 'POWERTRAIN');
  const dedupePowertrains = dedupe.filter((node) => node.nodeType === 'POWERTRAIN');
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

  for (let i = 0; i < dedupePowertrains.length; i += 1) {
    for (let j = i + 1; j < dedupePowertrains.length; j += 1) {
      const a = dedupePowertrains[i]!;
      const b = dedupePowertrains[j]!;
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

  const variants = nodes.filter((node) => node.nodeType === 'VARIANT');
  const dedupeVariants = dedupe.filter((node) => node.nodeType === 'VARIANT');
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

  for (let i = 0; i < dedupeVariants.length; i += 1) {
    for (let j = i + 1; j < dedupeVariants.length; j += 1) {
      const a = dedupeVariants[i]!;
      const b = dedupeVariants[j]!;
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

  const trims = nodes.filter((node) => node.nodeType === 'TRIM');
  const dedupeTrims = dedupe.filter((node) => node.nodeType === 'TRIM');
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

  for (let i = 0; i < dedupeTrims.length; i += 1) {
    for (let j = i + 1; j < dedupeTrims.length; j += 1) {
      const a = dedupeTrims[i]!;
      const b = dedupeTrims[j]!;
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

  const phases = dedupe.filter((node) => node.nodeType === 'PHASE');
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

  const supplemental = dedupe.filter((node) => SUPPLEMENTAL_TYPES.has(node.nodeType));
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

    for (const field of requiredRefFields(target.nodeType)) {
      if (!target.refs[field]) {
        add(issues, {
          code: 'PRICE_TARGET_LINEAGE_INCOMPLETE',
          severity: 'ERROR',
          entityKind: 'PRICE',
          entityId: price.id,
          fieldPath: `targetId.${field}`,
          relatedId: target.id,
        });
      }
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
  issues: VehicleMasterGraphAuditIssue[],
  holdCode: 'RULE_SUBJECT_HOLD' | 'RULE_TARGET_HOLD' | null
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
  if (node.status === 'HOLD' && holdCode) {
    add(issues, {
      code: holdCode,
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

function auditDependencyGraphSemantics(
  rules: readonly VehicleMasterCompatibilityRule[],
  issues: VehicleMasterGraphAuditIssue[]
) {
  const groups = new Map<string, VehicleMasterCompatibilityRule[]>();
  for (const rule of rules) {
    if (!DEPENDENCY_RULE_TYPES.has(rule.ruleType)) continue;
    const key = stableDigest(rule.scope);
    const list = groups.get(key) ?? [];
    list.push(rule);
    groups.set(key, list);
  }

  for (const scopeKey of [...groups.keys()].sort()) {
    const scoped = [...(groups.get(scopeKey) ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id));
    const requiresEdges = dependencyEdges(scoped, 'REQUIRES');
    const excludesEdges = dependencyEdges(scoped, 'EXCLUDES');

    const reverseKeys = new Set<string>();
    for (const required of requiresEdges) {
      for (const excluded of excludesEdges) {
        if (
          required.from !== excluded.to ||
          required.to !== excluded.from ||
          !rulesShareEffectiveWindow([required.rule, excluded.rule])
        ) {
          continue;
        }
        const ids = [required.rule.id, excluded.rule.id].sort();
        const key = ids.join('|');
        if (reverseKeys.has(key)) continue;
        reverseKeys.add(key);
        add(issues, {
          code: 'RULE_DEPENDENCY_CONFLICT',
          severity: 'ERROR',
          entityKind: 'RULE',
          entityId: excluded.rule.id,
          fieldPath: `targetIds.${excluded.to}`,
          relatedId: required.rule.id,
          detail: 'REVERSE_DIRECTION',
        });
      }
    }

    const transitiveKeys = new Set<string>();
    for (const first of requiresEdges) {
      for (const second of requiresEdges) {
        if (first.to !== second.from || first.from === second.to) continue;

        for (const excluded of excludesEdges) {
          const closesForward =
            excluded.from === first.from &&
            excluded.to === second.to;
          const closesReverse =
            excluded.from === second.to &&
            excluded.to === first.from;
          if (!closesForward && !closesReverse) continue;

          const triple = [first.rule, second.rule, excluded.rule];
          if (!rulesShareEffectiveWindow(triple)) continue;

          const ids = triple.map((rule) => rule.id).sort();
          const key = `${first.from}>${first.to}>${second.to}|${ids.join('|')}`;
          if (transitiveKeys.has(key)) continue;
          transitiveKeys.add(key);

          add(issues, {
            code: 'RULE_DEPENDENCY_TRANSITIVE_CONFLICT',
            severity: 'ERROR',
            entityKind: 'RULE',
            entityId: excluded.rule.id,
            fieldPath: `targetIds.${second.to}`,
            relatedId: first.rule.id,
            detail: `${first.rule.id}>${second.rule.id}|${excluded.rule.id}`,
          });
        }
      }
    }

    for (const excluded of excludesEdges) {
      const forwardPath = findRequiresPath(
        requiresEdges,
        excluded.from,
        excluded.to,
        [excluded.rule]
      );
      if (!forwardPath?.length) continue;

      const returnPath = findRequiresPath(
        requiresEdges,
        excluded.to,
        excluded.from,
        [excluded.rule, ...forwardPath.map((edge) => edge.rule)]
      );
      if (!returnPath?.length) continue;

      const allRules = [
        excluded.rule,
        ...forwardPath.map((edge) => edge.rule),
        ...returnPath.map((edge) => edge.rule),
      ];
      if (!rulesShareEffectiveWindow(allRules)) continue;

      add(issues, {
        code: 'RULE_DEPENDENCY_CYCLE_CONFLICT',
        severity: 'ERROR',
        entityKind: 'RULE',
        entityId: excluded.rule.id,
        fieldPath: `targetIds.${excluded.to}`,
        relatedId: forwardPath[0]!.rule.id,
        detail:
          `${forwardPath.map((edge) => edge.rule.id).join('>')}|` +
          returnPath.map((edge) => edge.rule.id).join('>'),
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
      auditRuleReference(rule, subject, 'subjectId', null, issues, 'RULE_SUBJECT_HOLD');
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
        auditRuleReference(rule, target, `targetIds.${target.id}`, subject, issues, 'RULE_TARGET_HOLD');
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
      auditRuleReference(rule, node, `scope.${field}`, subject, issues, null);
    }

    if (
      rule.scope.trimId &&
      subject?.nodeType === 'TRIM' &&
      rule.scope.trimId !== subject.id
    ) {
      add(issues, {
        code: 'RULE_SCOPE_SUBJECT_MISMATCH',
        severity: 'ERROR',
        entityKind: 'RULE',
        entityId: rule.id,
        fieldPath: 'scope.trimId',
        relatedId: rule.scope.trimId,
        detail: `${rule.scope.trimId}!=${subject.id}`,
      });
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

  auditDependencyGraphSemantics(rules, issues);
}

function auditCanonicalEvidenceAndDigests(
  input: VehicleMasterGraphSnapshot,
  issues: VehicleMasterGraphAuditIssue[]
) {
  const currentRecords: Array<{
    kind: 'NODE' | 'RULE' | 'PRICE';
    id: string;
    record: VehicleMasterNode | VehicleMasterCompatibilityRule | VehicleMasterPriceRevision;
  }> = [
    ...input.nodes.map((record) => ({ kind: 'NODE' as const, id: record.id, record })),
    ...input.rules.map((record) => ({ kind: 'RULE' as const, id: record.id, record })),
    ...input.prices.map((record) => ({ kind: 'PRICE' as const, id: record.id, record })),
  ];

  for (const item of currentRecords) {
    auditContentHash(item.record, item.kind, item.id, issues);
  }

  if (!input.sources) return;

  const sources = [...input.sources].sort((a, b) =>
    a.sourceDocumentId.localeCompare(b.sourceDocumentId)
  );
  const sourceById = new Map(sources.map((source) => [source.sourceDocumentId, source]));

  for (const source of sources) {
    auditContentHash(source, 'SOURCE', source.sourceDocumentId, issues);
  }

  for (const item of currentRecords) {
    const ids = [...new Set(sourceEvidenceIds(item.record))].sort();
    if (!ids.length) {
      add(issues, {
        code: 'SOURCE_EVIDENCE_REQUIRED',
        severity: 'ERROR',
        entityKind: item.kind,
        entityId: item.id,
        fieldPath: 'sourceEvidenceIds',
      });
    }
    for (const sourceId of ids) {
      if (sourceById.has(sourceId)) continue;
      add(issues, {
        code: 'SOURCE_EVIDENCE_MISSING',
        severity: 'ERROR',
        entityKind: item.kind,
        entityId: item.id,
        fieldPath: 'sourceEvidenceIds',
        relatedId: sourceId,
      });
    }

    if (item.kind === 'PRICE') {
      const price = item.record as VehicleMasterPriceRevision;
      if (!price.sourceDocumentIds.length) {
        add(issues, {
          code: 'PRICE_SOURCE_DOCUMENT_REQUIRED',
          severity: 'ERROR',
          entityKind: 'PRICE',
          entityId: price.id,
          fieldPath: 'sourceDocumentIds',
        });
      }
      for (const sourceId of [...new Set(price.sourceDocumentIds)].sort()) {
        if (sourceById.has(sourceId)) continue;
        add(issues, {
          code: 'PRICE_SOURCE_DOCUMENT_MISSING',
          severity: 'ERROR',
          entityKind: 'PRICE',
          entityId: price.id,
          fieldPath: 'sourceDocumentIds',
          relatedId: sourceId,
        });
      }
    }
  }
}

type VersionedCanonicalRecord = VehicleMasterNode | VehicleMasterCompatibilityRule;

function auditRevisionHistory(
  current: readonly VersionedCanonicalRecord[],
  revisions: readonly VersionedCanonicalRecord[] | undefined,
  recordKind: 'NODE' | 'RULE',
  sources: readonly VehicleMasterSourceDocument[] | undefined,
  issues: VehicleMasterGraphAuditIssue[]
) {
  if (!revisions) return;

  const currentById = new Map(current.map((record) => [record.id, record]));
  const sourceById = sources
    ? new Map(sources.map((source) => [source.sourceDocumentId, source]))
    : null;
  const groups = new Map<string, VersionedCanonicalRecord[]>();

  for (const revision of [...revisions].sort((a, b) =>
    a.id.localeCompare(b.id) || a.revision - b.revision
  )) {
    const revisionEntityId = `${recordKind}:${revision.id}:r${revision.revision}`;
    auditContentHash(revision, 'REVISION', revisionEntityId, issues);

    if (!currentById.has(revision.id)) {
      add(issues, {
        code: 'REVISION_ORPHAN',
        severity: 'ERROR',
        entityKind: 'REVISION',
        entityId: revisionEntityId,
        relatedId: revision.id,
      });
    }

    if (sourceById) {
      const evidenceIds = [...new Set(revision.sourceEvidenceIds)].sort();
      if (!evidenceIds.length) {
        add(issues, {
          code: 'SOURCE_EVIDENCE_REQUIRED',
          severity: 'ERROR',
          entityKind: 'REVISION',
          entityId: revisionEntityId,
          fieldPath: 'sourceEvidenceIds',
        });
      }
      for (const sourceId of evidenceIds) {
        if (sourceById.has(sourceId)) continue;
        add(issues, {
          code: 'SOURCE_EVIDENCE_MISSING',
          severity: 'ERROR',
          entityKind: 'REVISION',
          entityId: revisionEntityId,
          fieldPath: 'sourceEvidenceIds',
          relatedId: sourceId,
        });
      }
    }

    const list = groups.get(revision.id) ?? [];
    list.push(revision);
    groups.set(revision.id, list);
  }

  for (const record of [...current].sort((a, b) => a.id.localeCompare(b.id))) {
    const history = (groups.get(record.id) ?? [])
      .sort((a, b) => a.revision - b.revision);

    if (!history.length) {
      add(issues, {
        code: 'REVISION_HISTORY_MISSING',
        severity: 'ERROR',
        entityKind: recordKind,
        entityId: record.id,
        fieldPath: 'revision',
        detail: String(record.revision),
      });
      continue;
    }

    const byNumber = new Map<number, VersionedCanonicalRecord[]>();
    for (const revision of history) {
      const sameNumber = byNumber.get(revision.revision) ?? [];
      sameNumber.push(revision);
      byNumber.set(revision.revision, sameNumber);
    }

    for (const [revision, rows] of [...byNumber.entries()].sort(([a], [b]) => a - b)) {
      if (rows.length <= 1) continue;
      add(issues, {
        code: 'REVISION_DUPLICATE_NUMBER',
        severity: 'ERROR',
        entityKind: recordKind,
        entityId: record.id,
        fieldPath: 'revision',
        detail: String(revision),
      });
    }

    for (let revision = 1; revision <= record.revision; revision += 1) {
      if (byNumber.has(revision)) continue;
      add(issues, {
        code: 'REVISION_SEQUENCE_GAP',
        severity: 'ERROR',
        entityKind: recordKind,
        entityId: record.id,
        fieldPath: 'revision',
        detail: String(revision),
      });
    }

    const latest = history.at(-1)!;
    if (
      latest.revision !== record.revision ||
      stableDigest(latest) !== stableDigest(record)
    ) {
      add(issues, {
        code: 'REVISION_LATEST_MISMATCH',
        severity: 'ERROR',
        entityKind: recordKind,
        entityId: record.id,
        fieldPath: 'revision',
        relatedId: `r${latest.revision}`,
        detail: `${latest.revision}!=${record.revision}`,
      });
    }
  }
}

const pipelinePayloadString = (
  record: VehicleMasterPipelineRecord,
  field: string
) => {
  const value = record.payload[field];
  return typeof value === 'string' && value ? value : null;
};

const pipelinePayloadStringArray = (
  record: VehicleMasterPipelineRecord,
  field: string
) => {
  const value = record.payload[field];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value as string[]
    : null;
};

function auditPipelineIntegrity(
  input: VehicleMasterGraphSnapshot,
  issues: VehicleMasterGraphAuditIssue[]
) {
  const records = input.pipelineRecords;
  const sources = input.sources;
  if (!records) return;

  const sorted = [...records].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.recordId.localeCompare(b.recordId)
  );
  const byKindAndId = new Map(
    sorted.map((record) => [`${record.kind}:${record.recordId}`, record])
  );
  const sourceById = sources
    ? new Map(sources.map((source) => [source.sourceDocumentId, source]))
    : null;

  const candidateFacts = sorted.filter((record) => record.kind === 'CANDIDATE_FACT');
  const evidenceSets = sorted.filter((record) => record.kind === 'EVIDENCE_SET');
  const revisionCandidates = sorted.filter((record) => record.kind === 'REVISION_CANDIDATE');
  const promotionResults = sorted.filter((record) => record.kind === 'PROMOTION_RESULT');
  const changeEvents = sorted.filter((record) => record.kind === 'CHANGE_EVENT');

  const canonicalRevisionKeys = new Set<string>();
  for (const record of [
    ...input.nodes,
    ...input.rules,
    ...input.prices,
    ...(input.nodeRevisions ?? []),
    ...(input.ruleRevisions ?? []),
  ]) {
    canonicalRevisionKeys.add(
      `${record.id}|${record.revision}|${record.contentHash}`
    );
  }

  for (const record of sorted) {
    auditContentHash(record, 'PIPELINE', `${record.kind}:${record.recordId}`, issues);
    if (record.sourceDocumentId && sourceById && !sourceById.has(record.sourceDocumentId)) {
      add(issues, {
        code: 'PIPELINE_SOURCE_DOCUMENT_MISSING',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${record.kind}:${record.recordId}`,
        fieldPath: 'sourceDocumentId',
        relatedId: record.sourceDocumentId,
      });
    }
  }

  const revisionByEvidenceSet = new Map<string, VehicleMasterPipelineRecord[]>();
  for (const revision of revisionCandidates) {
    const evidenceSetId = pipelinePayloadString(revision, 'evidenceSetId');
    if (!evidenceSetId) {
      add(issues, {
        code: 'PIPELINE_EVIDENCE_SET_ID_MISSING',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${revision.kind}:${revision.recordId}`,
        fieldPath: 'payload.evidenceSetId',
      });
      continue;
    }
    if (!byKindAndId.has(`EVIDENCE_SET:${evidenceSetId}`)) {
      add(issues, {
        code: 'PIPELINE_EVIDENCE_SET_MISSING',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${revision.kind}:${revision.recordId}`,
        fieldPath: 'payload.evidenceSetId',
        relatedId: evidenceSetId,
      });
    }
    const list = revisionByEvidenceSet.get(evidenceSetId) ?? [];
    list.push(revision);
    revisionByEvidenceSet.set(evidenceSetId, list);
  }

  for (const revision of revisionCandidates) {
    const revisionNumber = revision.payload.revision;
    const proposalHash = pipelinePayloadString(revision, 'proposalHash');

    if (
      typeof revisionNumber !== 'number' ||
      !Number.isSafeInteger(revisionNumber) ||
      revisionNumber < 1
    ) {
      add(issues, {
        code: 'PIPELINE_REVISION_NUMBER_INVALID',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${revision.kind}:${revision.recordId}`,
        fieldPath: 'payload.revision',
        detail: String(revisionNumber ?? 'MISSING'),
      });
    }

    if (!proposalHash) {
      add(issues, {
        code: 'PIPELINE_PROPOSAL_HASH_MISSING',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${revision.kind}:${revision.recordId}`,
        fieldPath: 'payload.proposalHash',
      });
    }

    const matchingCandidate = proposalHash
      ? candidateFacts.find((candidate) =>
          candidate.entityId === revision.entityId &&
          candidate.observedAt === revision.observedAt &&
          candidate.payload.proposalHash === proposalHash
        )
      : null;
    if (!matchingCandidate) {
      add(issues, {
        code: 'PIPELINE_CANDIDATE_FACT_MISSING',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${revision.kind}:${revision.recordId}`,
        fieldPath: 'payload.proposalHash',
        ...(proposalHash ? { relatedId: proposalHash } : {}),
      });
    }
  }

  for (const evidence of evidenceSets) {
    const ids = pipelinePayloadStringArray(evidence, 'evidenceDocumentIds');
    if (!ids) {
      add(issues, {
        code: 'PIPELINE_EVIDENCE_DOCUMENT_IDS_INVALID',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${evidence.kind}:${evidence.recordId}`,
        fieldPath: 'payload.evidenceDocumentIds',
      });
    } else if (sourceById) {
      for (const sourceId of [...new Set(ids)].sort()) {
        if (sourceById.has(sourceId)) continue;
        add(issues, {
          code: 'PIPELINE_EVIDENCE_SOURCE_MISSING',
          severity: 'ERROR',
          entityKind: 'PIPELINE',
          entityId: `${evidence.kind}:${evidence.recordId}`,
          fieldPath: 'payload.evidenceDocumentIds',
          relatedId: sourceId,
        });
      }
    }

    if (!(revisionByEvidenceSet.get(evidence.recordId)?.length)) {
      add(issues, {
        code: 'PIPELINE_EVIDENCE_SET_ORPHAN',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${evidence.kind}:${evidence.recordId}`,
      });
    }
  }

  const promotionByRevision = new Map<string, VehicleMasterPipelineRecord[]>();
  for (const promotion of promotionResults) {
    const revisionCandidateId = pipelinePayloadString(promotion, 'revisionCandidateId');
    if (!revisionCandidateId) {
      add(issues, {
        code: 'PIPELINE_REVISION_CANDIDATE_ID_MISSING',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${promotion.kind}:${promotion.recordId}`,
        fieldPath: 'payload.revisionCandidateId',
      });
      continue;
    }
    if (!byKindAndId.has(`REVISION_CANDIDATE:${revisionCandidateId}`)) {
      add(issues, {
        code: 'PIPELINE_REVISION_CANDIDATE_MISSING',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${promotion.kind}:${promotion.recordId}`,
        fieldPath: 'payload.revisionCandidateId',
        relatedId: revisionCandidateId,
      });
    }
    const list = promotionByRevision.get(revisionCandidateId) ?? [];
    list.push(promotion);
    promotionByRevision.set(revisionCandidateId, list);
  }

  for (const revision of revisionCandidates) {
    if (promotionByRevision.get(revision.recordId)?.length) continue;
    add(issues, {
      code: 'PIPELINE_REVISION_CANDIDATE_ORPHAN',
      severity: 'ERROR',
      entityKind: 'PIPELINE',
      entityId: `${revision.kind}:${revision.recordId}`,
    });
  }

  for (const promotion of promotionResults) {
    if (promotion.payload.status !== 'PROMOTED') continue;
    const revisionCandidateId = pipelinePayloadString(promotion, 'revisionCandidateId');
    const revision = revisionCandidateId
      ? byKindAndId.get(`REVISION_CANDIDATE:${revisionCandidateId}`)
      : null;
    if (!revision) continue;

    const revisionNumber = revision.payload.revision;
    const proposalHash = pipelinePayloadString(revision, 'proposalHash');
    const evidenceSetId = pipelinePayloadString(revision, 'evidenceSetId');
    const revisionStatus = revision.payload.status;
    const promotionStatus = promotion.payload.status;
    const expectedPromotionStatus =
      revisionStatus === 'APPROVED'
        ? 'PROMOTED'
        : revisionStatus === 'HOLD'
          ? 'HOLD'
          : null;

    if (expectedPromotionStatus && promotionStatus !== expectedPromotionStatus) {
      add(issues, {
        code: 'PIPELINE_STATUS_MISMATCH',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${promotion.kind}:${promotion.recordId}`,
        fieldPath: 'payload.status',
        detail: `${String(promotionStatus)}!=${expectedPromotionStatus}`,
      });
    }

    if (
      promotionStatus === 'PROMOTED' &&
      typeof revisionNumber === 'number' &&
      proposalHash &&
      promotion.entityId &&
      !canonicalRevisionKeys.has(
        `${promotion.entityId}|${revisionNumber}|${proposalHash}`
      )
    ) {
      add(issues, {
        code: 'PIPELINE_PROPOSAL_HASH_MISMATCH',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${promotion.kind}:${promotion.recordId}`,
        fieldPath: 'payload.revisionCandidateId',
        relatedId: revision.recordId,
        detail: proposalHash,
      });
    }
    const matchingEvent = changeEvents.find((event) =>
      event.entityId === promotion.entityId &&
      event.observedAt === promotion.observedAt &&
      event.payload.revision === revisionNumber &&
      event.payload.evidenceSetId === evidenceSetId
    );
    if (!matchingEvent) {
      add(issues, {
        code: 'PIPELINE_CHANGE_EVENT_MISSING',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${promotion.kind}:${promotion.recordId}`,
        fieldPath: 'payload.status',
        detail: 'PROMOTED',
      });
    }
  }

  for (const event of changeEvents) {
    const evidenceSetId = pipelinePayloadString(event, 'evidenceSetId');
    if (
      evidenceSetId &&
      !byKindAndId.has(`EVIDENCE_SET:${evidenceSetId}`)
    ) {
      add(issues, {
        code: 'PIPELINE_EVIDENCE_SET_MISSING',
        severity: 'ERROR',
        entityKind: 'PIPELINE',
        entityId: `${event.kind}:${event.recordId}`,
        fieldPath: 'payload.evidenceSetId',
        relatedId: evidenceSetId,
      });
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
  auditCanonicalEvidenceAndDigests(input, issues);
  auditRevisionHistory(
    nodes,
    input.nodeRevisions,
    'NODE',
    input.sources,
    issues
  );
  auditRevisionHistory(
    rules,
    input.ruleRevisions,
    'RULE',
    input.sources,
    issues
  );
  auditPipelineIntegrity(input, issues);

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
  const [
    rules,
    prices,
    sources,
    nodeRevisions,
    ruleRevisions,
    pipelineGroups,
  ] = await Promise.all([
    store.listCompatibilityRules(),
    store.listPriceRevisions(),
    store.listSourceDocuments(),
    store.listNodeRevisions(),
    store.listCompatibilityRuleRevisions(),
    Promise.all(
      PIPELINE_KINDS.map((kind) => store.listPipelineRecordsByKind(kind))
    ),
  ]);

  return auditVehicleMasterGraph({
    nodes: nodeGroups.flat(),
    rules,
    prices,
    sources,
    nodeRevisions,
    ruleRevisions,
    pipelineRecords: pipelineGroups.flat(),
  });
}
