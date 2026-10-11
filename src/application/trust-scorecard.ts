import { createHash } from 'node:crypto';
import type { Offer, Product, VehicleAsset, VehicleModel } from '../domain/catalog.js';
import { resolveErp5InventoryStatus } from '../domain/erp5-inventory-status.js';
import { toInternalFeeLookup } from '../domain/internal-fee-lookup-contract.js';
import { auditVehicleNameReferenceParity, type LegacyVehicleMasterNameRow, type LegacyVehicleProductNameRow, type VehicleNameReferenceRow } from './vehicle-master-reference-parity.js';

export type TrustScorecardMetric = {
  id: string;
  name: string;
  numerator: number;
  denominator: number;
  ratio: number;
  readAt: string;
  basis: 'DIRECT' | 'PROXY';
  note: string;
};

export type TrustScorecardLegacyProduct = Record<string, unknown> & { _key?: string };
export type TrustScorecardSourceFreshnessInput = {
  sourceId: string;
  expectedFreshnessSeconds: number | null;
  observedAt?: string | null;
  acceptedAt?: string | null;
};
export type TrustScorecardCanonicalInput = {
  vehicleModels: VehicleModel[];
  vehicleAssets: VehicleAsset[];
  products: Product[];
  offers: Offer[];
};
export type TrustScorecardInput = {
  readAt: string;
  legacyProducts: Record<string, TrustScorecardLegacyProduct>;
  legacyVehicleMasterRows: LegacyVehicleMasterNameRow[];
  vehicleReferenceRows: VehicleNameReferenceRow[];
  canonical: TrustScorecardCanonicalInput;
  sourceFreshness: TrustScorecardSourceFreshnessInput[];
};

export type TrustScorecardVehiclePass = {
  hash: string;
  vehicleName: boolean;
  deposit: boolean;
  economics: boolean;
  photo: boolean;
  all: boolean;
};

export type TrustScorecardReport = {
  schema: 'freepass-data.trust-scorecard/v1';
  readAt: string;
  summary: TrustScorecardMetric;
  metrics: TrustScorecardMetric[];
  freshnessSources: Array<{ sourceId: string; ageSeconds: number | null; expectedFreshnessSeconds: number | null; pass: boolean; basis: 'DIRECT'; note: string }>;
  bottlenecks: Array<{ item: string; count: number }>;
  vehiclePasses: TrustScorecardVehiclePass[];
  digest: string;
};

export type TrustScorecardPublicSummary = {
  schema: 'freepass-data.trust-scorecard-summary/v1';
  readAt: string;
  summary: Pick<TrustScorecardMetric, 'id' | 'name' | 'ratio' | 'basis' | 'readAt'>;
  metrics: Array<Pick<TrustScorecardMetric, 'id' | 'name' | 'ratio' | 'basis' | 'readAt'>>;
  digest: string;
};

const metric = (id: string, name: string, numerator: number, denominator: number, readAt: string, basis: 'DIRECT' | 'PROXY', note: string): TrustScorecardMetric => ({
  id,
  name,
  numerator,
  denominator,
  ratio: denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6)),
  readAt,
  basis,
  note,
});

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const isNonEmpty = (value: unknown) => text(value).length > 0;
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const productId = (id: string, product: TrustScorecardLegacyProduct) => text(product._key) || id;
const isDeleted = (product: TrustScorecardLegacyProduct) => product._deleted === true || !!product.deletedAt || !!product.publication_withdrawal;
const isListableProduct = (product: TrustScorecardLegacyProduct) => product.listable === true && !isDeleted(product);
const isHttp = (value: unknown) => typeof value === 'string' && /^https?:\/\//i.test(value.trim());

function priceRows(product: TrustScorecardLegacyProduct) {
  if (!product.price || typeof product.price !== 'object' || Array.isArray(product.price)) return [];
  return Object.entries(product.price as Record<string, Record<string, unknown>>)
    .filter(([, row]) => row && typeof row === 'object' && !Array.isArray(row) && positive(row.rent))
    .map(([termKey, row]) => ({ termKey, row }));
}

const vehicleHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

function legacyProductNameRows(products: Array<[string, TrustScorecardLegacyProduct]>): LegacyVehicleProductNameRow[] {
  return products.map(([id, product]) => ({
    id: productId(id, product),
    plateNumber: productId(id, product),
    maker: text(product.maker),
    model: text(product.model),
    subModel: text(product.sub_model),
  }));
}

function hasApprovedPhoto(product: TrustScorecardLegacyProduct, isPublicIancarPhotoProduct: (product: Record<string, unknown>) => boolean): boolean {
  if (isPublicIancarPhotoProduct(product)) return true;
  if (isHttp(product.photo_link)) return true;
  return Array.isArray(product.image_urls) && product.image_urls.some(isHttp);
}

function statusConsistent(product: TrustScorecardLegacyProduct): boolean {
  const resolved = resolveErp5InventoryStatus(product.vehicle_status);
  if (!resolved.known) return false;
  if (text(product.status_kind) && text(product.status_kind) !== resolved.statusKind) return false;
  if (product.listable !== undefined && product.listable !== resolved.listable) return false;
  const status = text(product.status);
  return !status || status === resolved.status || status === resolved.statusKind;
}

export function buildTrustScorecard(
  input: TrustScorecardInput,
  helpers: {
    withCompatibilityDepositEvidence: (product: Record<string, unknown>, now?: string) => Record<string, unknown>;
    isPublicIancarPhotoProduct: (product: Record<string, unknown>) => boolean;
  },
): { report: TrustScorecardReport; publicSummary: TrustScorecardPublicSummary } {
  const legacyListable = Object.entries(input.legacyProducts).filter(([, product]) => isListableProduct(product));
  const parity = auditVehicleNameReferenceParity({
    referenceRows: input.vehicleReferenceRows,
    masterRows: input.legacyVehicleMasterRows,
    productRows: legacyProductNameRows(legacyListable),
  });
  const parityFailures = new Set(parity.issues.filter((issue) => issue.entityKind === 'PRODUCT').map((issue) => issue.entityId));
  const vehicleNamePass = new Map<string, boolean>();
  for (const [id, product] of legacyListable) {
    const completeSpecs = ['maker', 'model', 'sub_model', 'trim_name', 'fuel_type', 'engine_cc'].every((key) => isNonEmpty(product[key]));
    vehicleNamePass.set(productId(id, product), completeSpecs && !parityFailures.has(productId(id, product)));
  }

  const depositPass = new Map<string, boolean>();
  let depositNumerator = 0, depositDenominator = 0;
  for (const [id, product] of legacyListable) {
    const withEvidence = helpers.withCompatibilityDepositEvidence(product, input.readAt);
    const rows = priceRows(withEvidence);
    const allKnown = rows.length > 0 && rows.every(({ row }) => row.depositState === 'KNOWN' || row.depositState === 'ZERO');
    depositPass.set(productId(id, product), allKnown);
    for (const { row } of rows) {
      depositDenominator += 1;
      if (row.depositState === 'KNOWN' || row.depositState === 'ZERO') depositNumerator += 1;
    }
  }

  const productById = new Map(input.canonical.products.map((product) => [product.id, product]));
  const modelsById = new Map(input.canonical.vehicleModels.map((model) => [model.id, model]));
  const assetsById = new Map(input.canonical.vehicleAssets.map((asset) => [asset.id, asset]));
  const offerByProductId = new Map<string, Offer[]>();
  for (const offer of input.canonical.offers) offerByProductId.set(offer.productId, [...(offerByProductId.get(offer.productId) ?? []), offer]);
  let economicsNumerator = 0, economicsDenominator = 0, rentConfirmed = 0;
  const economicsPass = new Map<string, boolean>();
  const canonicalLegacyId = (product: Product) => product.id;
  for (const [id, legacy] of legacyListable) {
    const rows = priceRows(legacy);
    let all = rows.length > 0;
    for (const row of rows) {
      economicsDenominator += 1;
      if (positive(row.row.rent)) rentConfirmed += 1;
    }
    const canonicalProduct = productById.get(productId(id, legacy));
    const offers = canonicalProduct ? offerByProductId.get(canonicalLegacyId(canonicalProduct)) ?? [] : [];
    const confirmedTermKeys = new Set<string>();
    for (const offer of offers) {
      for (const term of toInternalFeeLookup(offer.id, offer.priceTerms, offer.internalEconomicsTerms).terms) {
        if (term.supplierBillingFee.status === 'CONFIRMED' && term.channelPayoutFee.status === 'CONFIRMED') confirmedTermKeys.add(term.termKey);
      }
    }
    for (const row of rows) {
      if (confirmedTermKeys.has(row.termKey)) economicsNumerator += 1;
      else all = false;
    }
    economicsPass.set(productId(id, legacy), all);
  }

  const photoPass = new Map<string, boolean>();
  for (const [id, product] of legacyListable) photoPass.set(productId(id, product), hasApprovedPhoto(product, helpers.isPublicIancarPhotoProduct));
  const freshnessRows = input.sourceFreshness.map((source) => {
    const observed = source.observedAt ?? source.acceptedAt ?? null;
    const ageSeconds = observed && Number.isFinite(Date.parse(observed)) ? Math.max(0, Math.floor((Date.parse(input.readAt) - Date.parse(observed)) / 1000)) : null;
    const pass = source.expectedFreshnessSeconds != null && ageSeconds != null && ageSeconds <= source.expectedFreshnessSeconds * 2;
    return { sourceId: source.sourceId, ageSeconds, expectedFreshnessSeconds: source.expectedFreshnessSeconds, pass, basis: 'DIRECT' as const, note: observed ? 'source_heads observedAt/acceptedAt 기준' : 'head timestamp unavailable' };
  });

  const statusPassCount = legacyListable.filter(([, product]) => statusConsistent(product)).length;
  const vehiclePasses = legacyListable.map(([id, product]) => {
    const pid = productId(id, product);
    const row = {
      hash: vehicleHash(pid),
      vehicleName: vehicleNamePass.get(pid) === true,
      deposit: depositPass.get(pid) === true,
      economics: economicsPass.get(pid) === true,
      photo: photoPass.get(pid) === true,
    };
    return { ...row, all: row.vehicleName && row.deposit && row.economics && row.photo };
  }).sort((a, b) => a.hash.localeCompare(b.hash));
  const onlyBlockers = ['vehicleName', 'deposit', 'economics', 'photo'].map((key) => ({
    item: key,
    count: vehiclePasses.filter((row) => !row[key as keyof Pick<TrustScorecardVehiclePass, 'vehicleName' | 'deposit' | 'economics' | 'photo'>]
      && ['vehicleName', 'deposit', 'economics', 'photo'].every((other) => other === key || row[other as keyof Pick<TrustScorecardVehiclePass, 'vehicleName' | 'deposit' | 'economics' | 'photo'>])).length,
  }));
  const metrics = [
    metric('vehicle-name-spec-confirmed', '차종·제원 정리율', [...vehicleNamePass.values()].filter(Boolean).length, legacyListable.length, input.readAt, 'DIRECT', 'vehicle_master/vehicle_trim_master 이름 대조 재사용'),
    metric('deposit-confirmed', '보증금 확정율', depositNumerator, depositDenominator, input.readAt, 'DIRECT', 'withCompatibilityDepositEvidence 재사용'),
    metric('period-rent-fee-confirmed', '기간별 대여료·수수료 확정율', economicsNumerator, economicsDenominator, input.readAt, 'DIRECT', `toInternalFeeLookup 재사용; 대여료 확정 단독 ${rentConfirmed}/${economicsDenominator}`),
    metric('photo-present', '사진 보유율', [...photoPass.values()].filter(Boolean).length, legacyListable.length, input.readAt, 'PROXY', 'ERP5 화면 실제 노출은 오프라인 검증 불가'),
    metric('source-freshness', '신선도', freshnessRows.filter((row) => row.pass).length, freshnessRows.length, input.readAt, 'DIRECT', 'sources expectedFreshnessSeconds 대비 source_heads observedAt/acceptedAt 2배 이내'),
    metric('status-consistency', '상태 정확도', statusPassCount, legacyListable.length, input.readAt, 'PROXY', '원천 대조는 박제 도구 확장 필요'),
  ];
  const summary = metric('all-core', '판매 중 차 중 ①②③④ 모두 맞는 차 비율', vehiclePasses.filter((row) => row.all).length, vehiclePasses.length, input.readAt, 'DIRECT', '차 단위: 보증금·수수료는 모든 가격행 통과 필요');
  const reportNoDigest = { schema: 'freepass-data.trust-scorecard/v1' as const, readAt: input.readAt, summary, metrics, freshnessSources: freshnessRows, bottlenecks: onlyBlockers, vehiclePasses };
  const digest = createHash('sha256').update(JSON.stringify(reportNoDigest)).digest('hex');
  const report = { ...reportNoDigest, digest };
  const publicMetric = ({ id, name, ratio, basis, readAt }: TrustScorecardMetric) => ({ id, name, ratio, basis, readAt });
  return { report, publicSummary: { schema: 'freepass-data.trust-scorecard-summary/v1', readAt: input.readAt, summary: publicMetric(summary), metrics: metrics.map(publicMetric), digest } };
}
