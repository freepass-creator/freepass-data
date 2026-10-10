import type { Offer, PriceTerm, Product, VehicleAsset } from '../domain/catalog.js';
import type { InternalFeeLookupTerm } from '../domain/internal-fee-lookup-contract.js';
import { toInternalFeeLookup } from '../domain/internal-fee-lookup-contract.js';
import type { CatalogStore } from '../ports/catalog-store.js';

export type ContractFeeLinkInput = {
  /** 차량 UID(vehicleAssetId). 있으면 이것으로 찾고 차량번호는 쓰지 않는다(차량번호는 찾기용 보조 키). */
  assetId?: string;
  plate?: string;
  supplierId: string;
  termMonths: number;
  monthlyRent: number;
  deposit?: number;
};

export type ContractFeeLinkData = {
  assets: VehicleAsset[];
  products: Product[];
  offers: Offer[];
};

export type ContractFeeLinkFailure =
  | 'NO_PLATE'
  | 'NO_ASSET'
  | 'MULTI_ASSET'
  | 'NO_PRODUCT'
  | 'MULTI_PRODUCT'
  | 'NO_OFFER'
  | 'MULTI_OFFER'
  | 'SUPPLIER_MISMATCH'
  | 'NO_TERM'
  | 'CONDITION_MISMATCH'
  | 'MULTI_TERM';

export type ContractFeeLinkStatus = 'LINKED' | 'FEE_UNCONFIRMED' | 'FAILED';

export type ContractFeeLinkPriceTerm = {
  termKey: string;
  termMonths: number;
  monthlyRent: number;
  deposit: number | null;
  depositState: PriceTerm['depositState'];
};

export type ContractFeeLinkResult = {
  status: ContractFeeLinkStatus;
  failure?: ContractFeeLinkFailure;
  detail?: unknown;
  assetId?: string;
  productId?: string;
  offerId?: string;
  offerRevision?: number;
  priceTerm?: ContractFeeLinkPriceTerm;
  fees?: InternalFeeLookupTerm;
};

const normalizePlate = (plate: string) => plate.replace(/\s+/g, '');

const moneyAmount = (money: { amount: number; currency: 'KRW' } | null | undefined) =>
  money?.currency === 'KRW' ? money.amount : null;

const priceTermResult = (term: PriceTerm): ContractFeeLinkPriceTerm => ({
  termKey: term.termKey,
  termMonths: term.termMonths,
  monthlyRent: term.monthlyRent.amount,
  deposit: moneyAmount(term.deposit),
  depositState: term.depositState,
});

const firstFeeForTerm = (offer: Offer, term: PriceTerm) =>
  toInternalFeeLookup(offer.id, offer.priceTerms, offer.internalEconomicsTerms)
    .terms.find((fee) => fee.termKey === term.termKey);

const failureResult = (
  failure: ContractFeeLinkFailure,
  ids: Partial<Pick<ContractFeeLinkResult, 'assetId' | 'productId' | 'offerId' | 'offerRevision'>>,
  detail?: unknown,
  term?: PriceTerm,
  offer?: Offer,
): ContractFeeLinkResult => {
  const fees = term && offer ? firstFeeForTerm(offer, term) : undefined; // 한 번만 계산
  return {
  status: 'FAILED',
  failure,
  ...ids,
  ...(detail !== undefined ? { detail } : {}),
  ...(term ? { priceTerm: priceTermResult(term) } : {}),
  ...(fees ? { fees } : {}),
  };
};

const conditionMismatches = (input: ContractFeeLinkInput, term: PriceTerm) => {
  const mismatches: Array<'rent' | 'deposit' | 'DEPOSIT_UNKNOWN'> = [];
  if (term.monthlyRent.amount !== input.monthlyRent) {
    mismatches.push('rent');
  }
  if (input.deposit !== undefined) {
    if (term.depositState === 'UNKNOWN') {
      mismatches.push('DEPOSIT_UNKNOWN');
    } else if (moneyAmount(term.deposit) !== input.deposit) {
      mismatches.push('deposit');
    }
  }
  return mismatches;
};

const conditionMatches = (input: ContractFeeLinkInput, term: PriceTerm) =>
  conditionMismatches(input, term).length === 0;

export function resolveContractFeeLink(
  input: ContractFeeLinkInput,
  data: ContractFeeLinkData,
): ContractFeeLinkResult {
  const assetId = (input.assetId ?? '').trim();
  const plate = normalizePlate(input.plate ?? '');
  // 번호가 비어 있으면 «번호 없는 자산» 끼리 '' 로 맞아 잘못 연결되므로 조회 전에 막는다.
  if (!assetId && !plate) {
    return failureResult('NO_PLATE', {});
  }
  const assets = assetId
    ? data.assets.filter((asset) => asset.id === assetId)
    : data.assets.filter((asset) => {
      const assetPlate = normalizePlate(asset.plateNumber ?? '');
      return assetPlate !== '' && assetPlate === plate;
    });
  if (assets.length === 0) {
    return failureResult('NO_ASSET', {});
  }
  if (assets.length > 1) {
    return failureResult('MULTI_ASSET', {}, { count: assets.length });
  }
  const asset = assets[0]!;
  const assetIds = { assetId: asset.id };

  const products = data.products.filter((product) => product.vehicleAssetId === asset.id);
  if (products.length === 0) {
    return failureResult('NO_PRODUCT', assetIds);
  }
  if (products.length > 1) {
    return failureResult('MULTI_PRODUCT', assetIds, { count: products.length });
  }
  const product = products[0]!;
  const productIds = { ...assetIds, productId: product.id };

  const offers = data.offers.filter((offer) => offer.productId === product.id);
  if (offers.length === 0) {
    return failureResult('NO_OFFER', productIds);
  }
  if (offers.length > 1) {
    return failureResult('MULTI_OFFER', productIds, { count: offers.length });
  }
  const offer = offers[0]!;
  const offerIds = { ...productIds, offerId: offer.id, offerRevision: offer.revision };
  if (offer.supplierId !== input.supplierId) {
    return failureResult('SUPPLIER_MISMATCH', offerIds, {
      expected: input.supplierId,
      actual: offer.supplierId,
    });
  }

  const termsByMonths = offer.priceTerms.filter((term) => term.termMonths === input.termMonths);
  if (termsByMonths.length === 0) {
    return failureResult('NO_TERM', offerIds);
  }
  const matchingTerms = termsByMonths.filter((term) => conditionMatches(input, term));
  if (matchingTerms.length === 0) {
    const referenceTerm = termsByMonths[0]!;
    return failureResult('CONDITION_MISMATCH', offerIds, {
      mismatches: [...new Set(termsByMonths.flatMap((term) => conditionMismatches(input, term)))],
      checkedTerms: termsByMonths.map((term) => priceTermResult(term)),
    }, referenceTerm, offer);
  }
  if (matchingTerms.length > 1) {
    return failureResult('MULTI_TERM', offerIds, { count: matchingTerms.length }, matchingTerms[0], offer);
  }

  const term = matchingTerms[0]!;
  const fees = firstFeeForTerm(offer, term)!;
  const reasonCodes = [
    fees.supplierBillingFee,
    fees.channelPayoutFee,
  ].filter((fee) => fee.status === 'UNCONFIRMED')
    .map((fee) => fee.reasonCode)
    .filter((reasonCode): reasonCode is string => Boolean(reasonCode));
  if (reasonCodes.length > 0) {
    return {
      status: 'FEE_UNCONFIRMED',
      detail: { reasonCodes },
      ...offerIds,
      priceTerm: priceTermResult(term),
      fees,
    };
  }
  return {
    status: 'LINKED',
    ...offerIds,
    priceTerm: priceTermResult(term),
    fees,
  };
}

export async function readContractFeeLink(
  store: CatalogStore,
  input: ContractFeeLinkInput,
): Promise<ContractFeeLinkResult> {
  const [assets, products, offers] = await Promise.all([
    store.listVehicleAssets(),
    store.listProducts(),
    store.listOffers(),
  ]);
  return resolveContractFeeLink(input, { assets, products, offers });
}
