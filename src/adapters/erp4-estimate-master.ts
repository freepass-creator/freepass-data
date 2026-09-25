import {
  buildEstimateNewcarMasterRecord,
  type EstimateMasterCandidate,
} from '../application/estimate-master.js';
import type {
  EstimateMasterColor,
  EstimateMasterOption,
  EstimateNewcarMasterRecord,
  EstimateMasterMoney,
} from '../domain/estimate-master.js';

type LegacyTrimMasterRecord = {
  trim_row_key: string;
  master_id: string;
  powertrain_seq: number;
  trim_seq: number;
  usage_tier: 'blocked' | 'manual' | 'automatic';
  market_status: '신차' | '중고차' | '';
  maker: string;
  model: string;
  sub_model: string;
  powertrain: string;
  trim: string;
  model_year_start: string;
  model_year_end: string;
  drivetrain?: string;
  seats?: number | null;
  body_configuration?: string;
};

type LegacyOption = {
  name?: unknown;
  price?: unknown;
  requires?: unknown;
};

type LegacyColor = {
  name?: unknown;
  code?: unknown;
  price?: unknown;
};

export type LegacyNewcarFeedRow = {
  id: string;
  trimKey?: string;
  maker?: string;
  sub_model?: string;
  fuel?: string;
  trim?: string;
  priceBefore?: number;
  priceAfter?: number;
  priceBasis?: string;
  modelYear?: number;
  model_year?: number;
  optionsMaster?: Record<string, LegacyOption>;
  optionExcludes?: Record<string, unknown>;
  exclusiveGroups?: Array<{ id?: unknown; label?: unknown; members?: unknown }>;
  availableOptions?: string[];
  impliedOptions?: string[];
  extColors?: LegacyColor[];
  intColors?: LegacyColor[];
};

const S = (value: unknown) => String(value ?? '').trim();

function safeMoney(value: unknown): EstimateMasterMoney | null {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) return null;
  return { amount, currency: 'KRW' };
}

function parseYear(value: unknown): number | null {
  const text = S(value);
  if (!/^\d{4}$/.test(text)) return null;
  const year = Number(text);
  return year >= 1900 && year <= 2200 ? year : null;
}

function exactModelYear(feed: LegacyNewcarFeedRow, master: LegacyTrimMasterRecord): {
  year: number | null;
  reason?: string;
} {
  const explicit = Number(feed.modelYear ?? feed.model_year);
  const start = parseYear(master.model_year_start);
  const end = parseYear(master.model_year_end);

  if (Number.isSafeInteger(explicit) && explicit >= 1900 && explicit <= 2200) {
    if (start && explicit < start) return { year: null, reason: 'PRODUCT_MODEL_YEAR_OUTSIDE_MASTER_RANGE' };
    if (end && explicit > end) return { year: null, reason: 'PRODUCT_MODEL_YEAR_OUTSIDE_MASTER_RANGE' };
    return { year: explicit };
  }

  if (start && end && start === end) return { year: start };
  return { year: null, reason: 'MODEL_YEAR_UNVERIFIED' };
}

export function permanentIdentityOf(master: LegacyTrimMasterRecord) {
  const key = S(master.trim_row_key);
  const masterId = S(master.master_id);
  const match = /^(.*)::v(\d{2,})::t(\d{2,})$/.exec(key);
  if (!match || match[1] !== masterId ||
      Number(match[2]) !== Number(master.powertrain_seq) ||
      Number(match[3]) !== Number(master.trim_seq)) {
    return {
      vehicleModelId: null,
      trimId: null,
      powertrainId: null,
      subModelId: null,
      issue: 'PERMANENT_TRIM_KEY_INVALID',
    };
  }

  const modelMatch = /^(mf-[^.]+\.[^.]+)(?:\.|$)/.exec(masterId);
  if (!modelMatch) {
    return {
      vehicleModelId: null,
      trimId: key,
      powertrainId: `${masterId}::v${match[2]}`,
      subModelId: masterId,
      issue: 'VEHICLE_MODEL_ID_UNVERIFIED',
    };
  }

  return {
    vehicleModelId: modelMatch[1],
    trimId: key,
    powertrainId: `${masterId}::v${match[2]}`,
    subModelId: masterId,
    issue: null,
  };
}

function stableChildId(scope: string | null, kind: string, rawId: unknown): string | null {
  const id = S(rawId);
  if (!scope || !id) return null;
  return `${scope}::${kind}:${encodeURIComponent(id)}`;
}

function optionRecords(
  feed: LegacyNewcarFeedRow,
  trimId: string | null,
): { options: EstimateMasterOption[]; holdReasons: string[] } {
  const om = feed.optionsMaster && typeof feed.optionsMaster === 'object' ? feed.optionsMaster : {};
  const rawAvailable = Array.isArray(feed.availableOptions) ? feed.availableOptions : null;
  const implied = new Set(Array.isArray(feed.impliedOptions) ? feed.impliedOptions.map(S) : []);
  const holdReasons: string[] = [];

  if (Object.keys(om).length && rawAvailable === null) holdReasons.push('AVAILABLE_OPTIONS_UNVERIFIED');

  const selectedRaw = (rawAvailable ?? Object.keys(om))
    .map(S)
    .filter(Boolean)
    .filter((id) => !implied.has(id));

  const groupByMember = new Map<string, string>();
  for (const group of feed.exclusiveGroups || []) {
    const gid = S(group.id || group.label);
    const members = Array.isArray(group.members) ? group.members.map(S).filter(Boolean) : [];
    if (!gid || members.length < 2) continue;
    for (const member of members) {
      if (groupByMember.has(member) && groupByMember.get(member) !== gid) {
        holdReasons.push('OPTION_MULTIPLE_EXCLUSIVE_GROUPS');
      } else {
        groupByMember.set(member, gid);
      }
    }
  }

  const stableId = (rawId: unknown) => stableChildId(trimId, 'opt', rawId);
  const options: EstimateMasterOption[] = [];
  for (const rawId of selectedRaw) {
    const raw = om[rawId];
    if (!raw) {
      options.push({
        optionId: stableId(rawId),
        name: rawId,
        price: { amount: 0, currency: 'KRW' },
        requires: [],
        excludes: [],
      });
      holdReasons.push('AVAILABLE_OPTION_MISSING_MASTER');
      continue;
    }
    const price = safeMoney(raw.price);
    if (!price) holdReasons.push('OPTION_PRICE_UNVERIFIED');
    const requiresRaw = Array.isArray(raw.requires) ? raw.requires.map(S).filter(Boolean) : [];
    const excludesRaw = Array.isArray(feed.optionExcludes?.[rawId])
      ? (feed.optionExcludes?.[rawId] as unknown[]).map(S).filter(Boolean)
      : [];
    options.push({
      optionId: stableId(rawId),
      name: S(raw.name) || rawId,
      price: price || { amount: 0, currency: 'KRW' },
      requires: requiresRaw.map((id) => stableId(id) || id),
      excludes: excludesRaw.map((id) => stableId(id) || id),
      exclusiveGroupId: groupByMember.get(rawId)
        ? stableChildId(trimId, 'group', groupByMember.get(rawId))
        : null,
    });
  }

  return { options, holdReasons };
}

function colorRecords(
  colors: LegacyColor[] | undefined,
  trimId: string | null,
  kind: 'ext' | 'int',
): { colors: EstimateMasterColor[]; holdReasons: string[] } {
  const holdReasons: string[] = [];
  const out: EstimateMasterColor[] = [];
  for (const color of colors || []) {
    const name = S(color?.name);
    if (!name) continue;
    const rawCode = S(color?.code);
    if (!rawCode) holdReasons.push('COLOR_CODE_UNVERIFIED');
    const price = safeMoney(color?.price ?? 0);
    if (!price) holdReasons.push('COLOR_PRICE_UNVERIFIED');
    out.push({
      colorId: rawCode ? stableChildId(trimId, kind, rawCode) : null,
      name,
      code: rawCode || null,
      price: price || { amount: 0, currency: 'KRW' },
    });
  }
  return { colors: out, holdReasons };
}

export function mapLegacyNewcarFeedToEstimateMaster(
  feed: LegacyNewcarFeedRow,
  masterRecords: readonly LegacyTrimMasterRecord[],
): EstimateNewcarMasterRecord {
  const holdReasons: string[] = [];
  const productId = S(feed.id);
  const trimKey = S(feed.trimKey);

  const matches = trimKey
    ? masterRecords.filter((record) => record.trim_row_key === trimKey)
    : [];
  const master = matches.length === 1 ? matches[0] : null;

  if (!trimKey) holdReasons.push('TRIM_KEY_UNVERIFIED');
  else if (matches.length === 0) holdReasons.push('TRIM_KEY_NOT_FOUND');
  else if (matches.length > 1) holdReasons.push('TRIM_KEY_DUPLICATE');

  const identity = master
    ? permanentIdentityOf(master)
    : {
        vehicleModelId: null,
        trimId: null,
        powertrainId: null,
        subModelId: null,
        issue: null,
      };

  if (identity.issue) holdReasons.push(identity.issue);
  if (master?.market_status !== '신차') holdReasons.push('MASTER_NOT_NEW_CAR');
  if (master?.usage_tier !== 'automatic') holdReasons.push('MASTER_NOT_AUTOMATIC');

  const year = master ? exactModelYear(feed, master) : { year: null, reason: 'MODEL_YEAR_UNVERIFIED' };
  if (year.reason) holdReasons.push(year.reason);

  const modelYearId = identity.subModelId && year.year
    ? `${identity.subModelId}::my${year.year}`
    : null;

  const priceBefore = safeMoney(feed.priceBefore);
  const priceAfter = safeMoney(feed.priceAfter);
  // Standard engine starts from the pre-tax-benefit vehicle price and applies
  // the verified before-after tax credit separately. Using priceAfter here
  // would subtract the benefit twice.
  const basePrice = (priceBefore && priceBefore.amount > 0 ? priceBefore : null)
    || (priceAfter && priceAfter.amount > 0 ? priceAfter : null);
  if (!basePrice) holdReasons.push('BASE_PRICE_UNVERIFIED');

  const optionMapped = optionRecords(feed, identity.trimId);
  holdReasons.push(...optionMapped.holdReasons);
  const ext = colorRecords(feed.extColors, identity.trimId, 'ext');
  const int = colorRecords(feed.intColors, identity.trimId, 'int');
  holdReasons.push(...ext.holdReasons, ...int.holdReasons);

  const candidate: EstimateMasterCandidate = {
    productId,
    vehicleModelId: identity.vehicleModelId,
    modelYearId,
    trimId: identity.trimId,
    powertrainId: identity.powertrainId,
    maker: S(master?.maker || feed.maker),
    model: S(master?.model || feed.sub_model),
    modelYear: year.year,
    trimName: S(master?.trim || feed.trim),
    powertrainName: S(master?.powertrain || feed.fuel),
    basePrice: basePrice || { amount: 0, currency: 'KRW' },
    priceBefore,
    priceAfter,
    priceBasis: S(feed.priceBasis) || null,
    options: optionMapped.options,
    exteriorColors: ext.colors,
    interiorColors: int.colors,
    configuration: {
      drivetrain: S(master?.drivetrain) || null,
      seats: master?.seats ?? null,
      bodyConfiguration: S(master?.body_configuration) || null,
    },
    holdReasons,
  };

  return buildEstimateNewcarMasterRecord(candidate);
}
