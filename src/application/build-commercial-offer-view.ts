import type { Offer, Policy, Product, VehicleAsset, VehicleModel } from '../domain/catalog.js';
import type { CommercialOfferView } from '../domain/commercial-product-view.js';
import { buildCommercialProductView } from './build-commercial-product-view.js';
import { buildConditionDimensions } from './product-condition-dimensions.js';

export function buildCommercialOfferView(input: {
  product: Product;
  vehicleModel: VehicleModel;
  vehicleAsset?: VehicleAsset;
  offer: Offer;
  policy?: Policy;
}): CommercialOfferView {
  const productView = buildCommercialProductView(input);
  const basisRows = productView.pricingBasis.map((row) => ({
    termKey: row.termKey,
    monthlyRent: structuredClone(row.monthlyRent),
    deposit: {
      state: row.deposit.state,
      ...('amount' in row.deposit ? { amount: structuredClone(row.deposit.amount) } : {}),
    },
    attribution: structuredClone(row.attribution),
  }));

  const isBuyout = (row: (typeof basisRows)[number]) =>
    row.attribution.conditions.some((condition) =>
      condition.dimensionKey === 'settlement_type' &&
      condition.status === 'KNOWN' &&
      condition.value === 'BUYOUT'
    );
  const nonBuyoutRows = basisRows.filter((row) => !isBuyout(row));
  const listingPool = nonBuyoutRows.length ? nonBuyoutRows : basisRows;
  const listing = [...listingPool].sort((a, b) =>
    a.monthlyRent.amount - b.monthlyRent.amount ||
    a.termKey.localeCompare(b.termKey)
  )[0];
  if (!listing) throw new Error('COMMERCIAL_LISTING_PRICE_MISSING');

  const dimensions = buildConditionDimensions(input.policy);
  const groups = {
    TERM: [] as string[],
    MILEAGE: [] as string[],
    DRIVER: [] as string[],
    INSURANCE: [] as string[],
    MAINTENANCE: [] as string[],
    PAYMENT: [] as string[],
    DELIVERY: [] as string[],
    SETTLEMENT: [] as string[],
    OTHER: [] as string[],
  };
  for (const dimension of dimensions) groups[dimension.group].push(dimension.key);

  const unresolvedDimensionKeys = [...new Set(
    basisRows.flatMap((row) => row.attribution.unknownConditionKeys)
  )].sort();
  const partialBasisTermKeys = basisRows
    .filter((row) => row.attribution.status === 'PARTIAL')
    .map((row) => row.termKey)
    .sort();
  const ambiguousPolicyTermKeys = basisRows
    .filter((row) => row.attribution.policyMatch?.status === 'AMBIGUOUS')
    .map((row) => row.termKey)
    .sort();

  const previewBasis = productView.preview.basisTermKey
    ? basisRows.find((row) => row.termKey === productView.preview.basisTermKey)
    : undefined;
  const summaryConditions = previewBasis?.attribution.conditions ?? [];
  const known = summaryConditions
    .filter((condition) => condition.status === 'KNOWN')
    .map((condition) => structuredClone(condition));
  const unknown = summaryConditions
    .filter((condition) => condition.status === 'UNKNOWN')
    .map((condition) => condition.dimensionKey)
    .sort();

  return {
    offerId: input.offer.id,
    supplierId: input.offer.supplierId,
    ...(input.offer.policyId ? { policyId: input.offer.policyId } : {}),
    basisRows,
    dataCatalog: {
      dimensions: structuredClone(dimensions),
      classification: {
        priceInputKeys: dimensions.filter((item) => item.role === 'PRICE_INPUT').map((item) => item.key).sort(),
        eligibilityKeys: dimensions.filter((item) => item.role === 'ELIGIBILITY').map((item) => item.key).sort(),
        contractOnlyKeys: dimensions.filter((item) => item.role === 'CONTRACT_ONLY').map((item) => item.key).sort(),
        groups: Object.fromEntries(
          Object.entries(groups).map(([group, keys]) => [group, [...keys].sort()])
        ) as typeof groups,
      },
      pricingModifiers: structuredClone(productView.conditionProfile.monthlyRentModifiers),
      policyFacts: structuredClone(productView.policy.facts),
      contractFacts: structuredClone(productView.contractConditions.facts),
      derived: {
        lowestBasisPrice: {
          termKey: listing.termKey,
          monthlyRent: structuredClone(listing.monthlyRent),
          deposit: structuredClone(listing.deposit),
          attribution: structuredClone(listing.attribution),
        },
        defaultConditionResult: structuredClone(productView.preview),
      },
      quality: {
        unresolvedDimensionKeys,
        partialBasisTermKeys,
        ambiguousPolicyTermKeys,
        unclassifiedPolicyFactKeys: [...productView.review.unclassifiedPolicyFacts],
      },
    },
    listing: {
      strategy: 'LOWEST_BASIS_MONTHLY_RENT',
      termKey: listing.termKey,
      monthlyRent: structuredClone(listing.monthlyRent),
      deposit: structuredClone(listing.deposit),
      attribution: structuredClone(listing.attribution),
    },
    conditionSummary: {
      known,
      unknown,
    },
    preview: structuredClone(productView.preview),
    review: {
      status: productView.review.status,
      decisions: [...productView.review.decisions],
      invalidFacts: [...productView.review.invalidFacts],
    },
  };
}
