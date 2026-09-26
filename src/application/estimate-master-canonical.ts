import {
  buildEstimateNewcarMasterRecord,
  uncoveredEstimateMasterIssues,
  type EstimateMasterColor,
  type EstimateMasterMoney,
  type EstimateMasterOption,
  type EstimateNewcarMasterRecord,
} from '../domain/estimate-master.js';
import type {
  VehicleMasterCompatibilityRule,
  VehicleMasterNode,
  VehicleMasterPriceRevision,
} from '../domain/vehicle-master.js';
import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';
import { stableDigest } from '../shared/stable-digest.js';

export type EstimateMasterColorDomain = 'EXTERIOR' | 'INTERIOR';

export type EstimateMasterCommercialBridge = {
  trimId: string;
  productId: string;
  priceBefore?: number | null;
  priceAfter?: number | null;
  priceBasis?: string | null;
};

export type EstimateMasterCanonicalBridge = {
  products?: readonly EstimateMasterCommercialBridge[];
  colorDomains?: Readonly<Record<string, EstimateMasterColorDomain>>;
};

export type EstimateMasterCanonicalInput = {
  kind: 'NODE' | 'RULE' | 'PRICE';
  id: string;
  revision: number;
  contentHash: string;
};

export type EstimateMasterCanonicalBuild = {
  records: EstimateNewcarMasterRecord[];
  canonicalInputs: EstimateMasterCanonicalInput[];
  summary: {
    total: number;
    active: number;
    hold: number;
    activeRate: number;
    holdReasons: Array<{ reason: string; count: number }>;
    inputDigest: string;
  };
};

const text = (value: unknown) => String(value ?? '').trim();

function money(amount: number | null | undefined): EstimateMasterMoney | null {
  if (amount == null) return null;
  if (!Number.isSafeInteger(amount) || amount < 0) return null;
  return { amount, currency: 'KRW' };
}

function activeAt(record: { effectiveFrom?: string | null; effectiveTo?: string | null }, asOf: string) {
  const at = Date.parse(asOf);
  if (!Number.isFinite(at)) throw new Error('ESTIMATE_MASTER_CANONICAL_INVALID:asOf');
  if (record.effectiveFrom && Date.parse(record.effectiveFrom) > at) return false;
  if (record.effectiveTo && Date.parse(record.effectiveTo) <= at) return false;
  return true;
}

function currentPrice(
  rows: readonly VehicleMasterPriceRevision[],
  priceType: VehicleMasterPriceRevision['priceType'],
  asOf: string
): { value: EstimateMasterMoney | null; reason?: string; input?: VehicleMasterPriceRevision } {
  const candidates = rows
    .filter((row) => row.priceType === priceType && row.currency === 'KRW' && activeAt(row, asOf))
    .sort((a, b) =>
      b.revision - a.revision ||
      String(b.effectiveFrom ?? '').localeCompare(String(a.effectiveFrom ?? '')) ||
      b.updatedAt.localeCompare(a.updatedAt)
    );
  if (!candidates.length) return { value: null, reason: 'PRICE_UNVERIFIED' };

  const highestRevision = candidates[0]!.revision;
  const sameRevision = candidates.filter((row) => row.revision === highestRevision);
  const amounts = new Set(sameRevision.map((row) => row.amount));
  if (amounts.size !== 1) {
    return { value: null, reason: 'PRICE_REVISION_AMBIGUOUS' };
  }
  const chosen = sameRevision[0]!;
  return { value: { amount: chosen.amount, currency: 'KRW' }, input: chosen };
}

function nodeStatusReason(node: VehicleMasterNode | null, field: string) {
  if (!node) return `${field.toUpperCase()}_NOT_FOUND`;
  if (node.status !== 'ACTIVE') return `${field.toUpperCase()}_NOT_ACTIVE`;
  return null;
}

function stringAttribute(node: VehicleMasterNode | null, key: string) {
  const value = node?.attributes?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function integerAttribute(node: VehicleMasterNode | null, key: string) {
  const value = node?.attributes?.[key];
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function optionGroupId(
  optionId: string,
  rules: readonly VehicleMasterCompatibilityRule[],
  trimId: string
) {
  const candidates = rules.filter((rule) =>
    rule.ruleType === 'ONE_OF' &&
    rule.effect === 'VALID' &&
    rule.scope?.trimId === trimId &&
    (rule.subjectId === optionId || rule.targetIds.includes(optionId))
  );
  if (!candidates.length) return null;
  return candidates
    .map((rule) => rule.id)
    .sort()[0] ?? null;
}

function dependenciesFor(
  optionId: string,
  rules: readonly VehicleMasterCompatibilityRule[],
  trimId: string,
  relation: 'REQUIRES' | 'EXCLUDES'
) {
  return [...new Set(
    rules
      .filter((rule) =>
        rule.ruleType === relation &&
        rule.subjectId === optionId &&
        rule.scope?.trimId === trimId &&
        (relation === 'EXCLUDES' ? rule.effect === 'INVALID' : rule.effect === 'VALID')
      )
      .flatMap((rule) => rule.targetIds)
  )].sort();
}

function colorDomain(
  node: VehicleMasterNode,
  bridge: EstimateMasterCanonicalBridge
): EstimateMasterColorDomain | null {
  const attribute = text(node.attributes?.colorDomain).toUpperCase();
  if (attribute === 'EXTERIOR' || attribute === 'INTERIOR') {
    return attribute as EstimateMasterColorDomain;
  }
  return bridge.colorDomains?.[node.id] ?? null;
}

function canonicalInput(kind: EstimateMasterCanonicalInput['kind'], value: {
  id: string;
  revision: number;
  contentHash: string;
}): EstimateMasterCanonicalInput {
  return { kind, id: value.id, revision: value.revision, contentHash: value.contentHash };
}

function uniqueCanonicalInputs(values: EstimateMasterCanonicalInput[]) {
  const map = new Map(values.map((value) => [
    `${value.kind}:${value.id}:r${value.revision}`,
    value,
  ]));
  return [...map.values()].sort((a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.id.localeCompare(b.id) ||
    a.revision - b.revision
  );
}

export async function buildEstimateMasterFromCanonicalVehicleMaster(
  store: Pick<
    VehicleMasterStore,
    'listNodesByType' | 'listCompatibilityRules' | 'listPriceRevisionsByTarget'
  >,
  {
    bridge = {},
    asOf = new Date().toISOString(),
  }: {
    bridge?: EstimateMasterCanonicalBridge;
    asOf?: string;
  } = {}
): Promise<EstimateMasterCanonicalBuild> {
  const nodeTypes: VehicleMasterNode['nodeType'][] = [
    'MAKE', 'MODEL', 'MODEL_YEAR', 'POWERTRAIN', 'VARIANT', 'TRIM',
    'OPTION', 'PACKAGE', 'COLOR',
  ];
  const nodeLists = await Promise.all(nodeTypes.map((type) => store.listNodesByType(type)));
  const nodes = nodeLists.flat();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const trims = nodeLists[nodeTypes.indexOf('TRIM')] ?? [];
  const supplemental = new Map(
    nodes
      .filter((node) => ['OPTION', 'PACKAGE', 'COLOR'].includes(node.nodeType))
      .map((node) => [node.id, node])
  );
  const rules = await store.listCompatibilityRules();
  const bridgeByTrim = new Map((bridge.products ?? []).map((item) => [item.trimId, item]));

  const records: EstimateNewcarMasterRecord[] = [];
  const inputs: EstimateMasterCanonicalInput[] = [];

  for (const trim of trims.sort((a, b) => a.id.localeCompare(b.id))) {
    const reasons: string[] = [];
    const makeId = text(trim.refs.makeId);
    const modelId = text(trim.refs.modelId);
    const modelYearId = text(trim.refs.modelYearId);
    const powertrainId = text(trim.refs.powertrainId);
    const variantId = text(trim.refs.variantId);

    const make = makeId ? byId.get(makeId) ?? null : null;
    const model = modelId ? byId.get(modelId) ?? null : null;
    const modelYear = modelYearId ? byId.get(modelYearId) ?? null : null;
    const powertrain = powertrainId ? byId.get(powertrainId) ?? null : null;
    const variant = variantId ? byId.get(variantId) ?? null : null;

    for (const [node, field] of [
      [trim, 'trim'],
      [make, 'make'],
      [model, 'model'],
      [modelYear, 'modelYear'],
      [powertrain, 'powertrain'],
      [variant, 'variant'],
    ] as const) {
      const reason = nodeStatusReason(node, field);
      if (reason) reasons.push(reason);
      if (node) inputs.push(canonicalInput('NODE', node));
    }

    const year = integerAttribute(modelYear, 'modelYear');
    if (year == null || year < 1900 || year > 2200) reasons.push('MODEL_YEAR_UNVERIFIED');

    const commercial = bridgeByTrim.get(trim.id);
    const productId = text(commercial?.productId) || trim.id;
    if (!commercial?.productId) reasons.push('PRODUCT_ID_BRIDGE_UNVERIFIED');

    const base = await store.listPriceRevisionsByTarget(trim.id);
    const basePrice = currentPrice(base, 'BASE', asOf);
    if (!basePrice.value) reasons.push(basePrice.reason ?? 'BASE_PRICE_UNVERIFIED');
    if (basePrice.input) inputs.push(canonicalInput('PRICE', basePrice.input));

    const priceBefore = money(commercial?.priceBefore);
    const priceAfter = money(commercial?.priceAfter);
    const priceBasis = text(commercial?.priceBasis) || null;
    if (!priceBefore || !priceAfter || !priceBasis) reasons.push('PRICE_BASIS_UNVERIFIED');

    const availability = rules.filter((rule) =>
      rule.ruleType === 'AVAILABLE_IF' &&
      rule.effect === 'VALID' &&
      rule.scope?.trimId === trim.id &&
      supplemental.has(rule.subjectId)
    );
    for (const rule of availability) inputs.push(canonicalInput('RULE', rule));

    const options: EstimateMasterOption[] = [];
    const exteriorColors: EstimateMasterColor[] = [];
    const interiorColors: EstimateMasterColor[] = [];

    for (const rule of availability.sort((a, b) => a.subjectId.localeCompare(b.subjectId))) {
      const node = supplemental.get(rule.subjectId)!;
      inputs.push(canonicalInput('NODE', node));
      const priceRows = await store.listPriceRevisionsByTarget(node.id);
      const expectedPriceType = node.nodeType === 'COLOR'
        ? 'COLOR'
        : node.nodeType === 'PACKAGE'
          ? 'PACKAGE'
          : 'OPTION';
      const resolvedPrice = currentPrice(priceRows, expectedPriceType, asOf);
      if (resolvedPrice.input) inputs.push(canonicalInput('PRICE', resolvedPrice.input));
      if (!resolvedPrice.value) reasons.push(
        node.nodeType === 'COLOR' ? 'COLOR_PRICE_UNVERIFIED' : 'OPTION_PRICE_UNVERIFIED'
      );

      if (node.nodeType === 'COLOR') {
        const domain = colorDomain(node, bridge);
        if (!domain) {
          reasons.push('COLOR_DOMAIN_UNVERIFIED');
          continue;
        }
        const color: EstimateMasterColor = {
          colorId: node.id,
          name: node.canonicalName,
          code: stringAttribute(node, 'code'),
          price: resolvedPrice.value ?? { amount: 0, currency: 'KRW' },
        };
        if (domain === 'EXTERIOR') exteriorColors.push(color);
        else interiorColors.push(color);
        continue;
      }

      const requires = dependenciesFor(node.id, rules, trim.id, 'REQUIRES');
      const excludes = dependenciesFor(node.id, rules, trim.id, 'EXCLUDES');
      for (const dependency of rules.filter((candidate) =>
        candidate.subjectId === node.id &&
        candidate.scope?.trimId === trim.id &&
        ['REQUIRES', 'EXCLUDES', 'ONE_OF'].includes(candidate.ruleType)
      )) {
        inputs.push(canonicalInput('RULE', dependency));
      }
      options.push({
        optionId: node.id,
        name: node.canonicalName,
        price: resolvedPrice.value ?? { amount: 0, currency: 'KRW' },
        requires,
        excludes,
        exclusiveGroupId: optionGroupId(node.id, rules, trim.id),
      });
    }

    const record = buildEstimateNewcarMasterRecord({
      productId,
      vehicleModelId: model?.id ?? null,
      modelYearId: modelYear?.id ?? null,
      trimId: trim.id,
      powertrainId: powertrain?.id ?? null,
      maker: make?.canonicalName ?? 'UNKNOWN',
      model: model?.canonicalName ?? 'UNKNOWN',
      modelYear: year,
      trimName: trim.canonicalName,
      powertrainName: powertrain?.canonicalName ?? 'UNKNOWN',
      basePrice: basePrice.value ?? { amount: 0, currency: 'KRW' },
      priceBefore,
      priceAfter,
      priceBasis,
      options,
      exteriorColors,
      interiorColors,
      configuration: {
        drivetrain: stringAttribute(variant, 'drivetrain'),
        seats: integerAttribute(variant, 'seats'),
        bodyConfiguration: stringAttribute(variant, 'bodyConfiguration'),
      },
      holdReasons: [...new Set(reasons)].sort(),
    });
    records.push(record);
  }

  const issues = uncoveredEstimateMasterIssues(records);
  if (issues.length) {
    throw new Error(
      `ESTIMATE_MASTER_CANONICAL_SET_INVALID:${issues.map((issue) => issue.code).join(',')}`
    );
  }

  const productIds = records.map((record) => record.productId);
  if (new Set(productIds).size !== productIds.length) {
    throw new Error('ESTIMATE_MASTER_CANONICAL_SET_INVALID:DUPLICATE_PRODUCT_ID');
  }

  const canonicalInputs = uniqueCanonicalInputs(inputs);
  const active = records.filter((record) => record.status === 'ACTIVE').length;
  const hold = records.length - active;
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const reason of record.holdReasons ?? []) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }

  return {
    records,
    canonicalInputs,
    summary: {
      total: records.length,
      active,
      hold,
      activeRate: records.length ? active / records.length : 0,
      holdReasons: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([reason, count]) => ({ reason, count })),
      inputDigest: stableDigest(canonicalInputs),
    },
  };
}
