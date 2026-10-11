import type { Offer, PriceTerm, Product, VehicleAsset } from '../domain/catalog.js';
import type { InternalFeeLookupTerm } from '../domain/internal-fee-lookup-contract.js';
import { toInternalFeeLookup } from '../domain/internal-fee-lookup-contract.js';
import { kstDate, type PeriodFeeLedgerRow } from './period-fee-ledger-plan.js';
import type { CatalogStore } from '../ports/catalog-store.js';

export type ContractFeeLinkInput = {
  /** 차량 UID(vehicleAssetId). 있으면 이것으로 찾고 차량번호는 쓰지 않는다(차량번호는 찾기용 보조 키). */
  assetId?: string | undefined;
  plate?: string | undefined;
  contractDate?: string | undefined;
  contractAt?: string | undefined;
  supplierId: string;
  termMonths: number;
  monthlyRent: number;
  deposit?: number;
};

export type ContractFeeLinkData = {
  assets: VehicleAsset[];
  products: Product[];
  offers: Offer[];
  ledgerRows?: readonly PeriodFeeLedgerRow[];
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

export type ContractFeeLinkLedgerFee = {
  status: 'CONFIRMED' | 'HOLD';
  snapshotId?: string;
  valueAsOf?: string;
  evidenceScope?: PeriodFeeLedgerRow['evidenceScope'];
  baselineExcludedCount?: number;
  supplierBillingFee: {
    state: PeriodFeeLedgerRow['supplierBillingFee']['state'];
    amount: PeriodFeeLedgerRow['supplierBillingFee']['amount'];
    reasonCode: string | null;
  };
  channelPayoutFee: {
    state: PeriodFeeLedgerRow['channelPayoutFee']['state'];
    amount: PeriodFeeLedgerRow['channelPayoutFee']['amount'];
    reasonCode: string | null;
  };
  vehicleValueEvidence: Pick<NonNullable<PeriodFeeLedgerRow['vehicleValueEvidence']>, 'grade' | 'source'> | null;
  reasonCode?: 'CONTRACT_TIME_VALUE_UNAVAILABLE' | string;
};

export type ContractFeeLinkResult = {
  status: ContractFeeLinkStatus;
  failure?: ContractFeeLinkFailure;
  detail?: unknown;
  assetId?: string | undefined;
  productId?: string;
  offerId?: string;
  offerRevision?: number;
  priceTerm?: ContractFeeLinkPriceTerm;
  fees?: InternalFeeLookupTerm;
  ledgerFee?: ContractFeeLinkLedgerFee;
};

export type ContractLedgerPickInput = {
  rows: readonly PeriodFeeLedgerRow[];
  contractDate: string;
  contractAt?: string | undefined;
  termMonths: number;
  monthlyRent: number;
  deposit: number;
};

export type ContractLedgerPickResult =
  | { status: 'CONFIRMED'; row: PeriodFeeLedgerRow }
  | { status: 'HOLD'; reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE'; detail: { candidateCount: number; baselineExcludedCount: number; latestValueAsOf?: string; mismatch?: Array<'rent' | 'deposit'> } };

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

const ledgerMoneyAmount = (money: { amount: number; currency: 'KRW' } | null | undefined) =>
  money?.currency === 'KRW' ? money.amount : null;

const ledgerRowMismatches = (input: Pick<ContractLedgerPickInput, 'monthlyRent' | 'deposit'>, row: PeriodFeeLedgerRow) => {
  const mismatches: Array<'rent' | 'deposit'> = [];
  if (ledgerMoneyAmount(row.monthlyRent) !== input.monthlyRent) mismatches.push('rent');
  if (ledgerMoneyAmount(row.deposit.amount) !== input.deposit) mismatches.push('deposit');
  return mismatches;
};

const parseTime = (value: string | undefined) => {
  if (!value) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

const dateOnly = (value: string | undefined) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

const ledgerObservationMs = (row: PeriodFeeLedgerRow) => {
  const computedAtMs = parseTime(row.computedAt);
  // 날짜만 있는 valueAsOf 는 시각 근거가 아니다(UTC 자정으로 해석되어 계약 후 관측을 계약 전으로 오판). 시각 비교에는 쓰지 않는다.
  const valueAsOfMs = dateOnly(row.valueAsOf) ? NaN : parseTime(row.valueAsOf);
  const observed = [computedAtMs, valueAsOfMs].filter(Number.isFinite);
  return observed.length > 0 ? Math.max(...observed) : NaN;
};

const contractInstantMs = (input: Pick<ContractLedgerPickInput, 'contractDate' | 'contractAt'>) =>
  parseTime(input.contractAt ?? input.contractDate);

const ledgerObservationKstDate = (row: PeriodFeeLedgerRow) => {
  const observationMs = ledgerObservationMs(row);
  if (Number.isFinite(observationMs)) return kstDate(new Date(observationMs).toISOString());
  const valueAsOfDate = dateOnly(row.valueAsOf);
  return valueAsOfDate ?? null;
};

const observedBeforeContract = (row: PeriodFeeLedgerRow, input: Pick<ContractLedgerPickInput, 'contractDate' | 'contractAt'>) => {
  if (!input.contractAt) {
    const contractDate = dateOnly(input.contractDate);
    const observationDate = ledgerObservationKstDate(row);
    return Boolean(contractDate && observationDate && observationDate < contractDate);
  }
  const rowMs = ledgerObservationMs(row);
  const contractMs = contractInstantMs(input);
  return Number.isFinite(rowMs) && Number.isFinite(contractMs) && rowMs < contractMs;
};

export function pickLedgerRowForContract(input: ContractLedgerPickInput): ContractLedgerPickResult {
  const baselineExcludedCount = input.rows.filter((row) =>
    row.termMonths === input.termMonths
    && (row.evidenceScope === 'BASELINE_NOT_CONTRACT_EVIDENCE' || row.evidenceScope === 'UNKNOWN_SCOPE' || !row.evidenceScope))
    .length;
  const candidates = input.rows
    .filter((row) =>
      row.valueBasis === 'CURRENT_AT_SNAPSHOT'
      && row.evidenceScope === 'OBSERVED_AT_SNAPSHOT'
      && observedBeforeContract(row, input)
      && row.termMonths === input.termMonths)
    .sort((a, b) => ledgerObservationMs(b) - ledgerObservationMs(a) || b.snapshotId.localeCompare(a.snapshotId));
  const latest = candidates[0];
  if (!latest) {
    return { status: 'HOLD', reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE', detail: { candidateCount: 0, baselineExcludedCount } };
  }
  const mismatch = ledgerRowMismatches(input, latest);
  if (mismatch.length > 0) {
    return {
      status: 'HOLD',
      reasonCode: 'CONTRACT_TIME_VALUE_UNAVAILABLE',
      detail: { candidateCount: candidates.length, baselineExcludedCount, latestValueAsOf: latest.valueAsOf, mismatch },
    };
  }
  return { status: 'CONFIRMED', row: latest };
}

const ledgerFeeFromRow = (row: PeriodFeeLedgerRow): ContractFeeLinkLedgerFee => ({
  status: row.applyState === 'HOLD' ? 'HOLD' : 'CONFIRMED',
  snapshotId: row.snapshotId,
  valueAsOf: row.valueAsOf,
  evidenceScope: row.evidenceScope,
  supplierBillingFee: {
    state: row.supplierBillingFee.state,
    amount: row.supplierBillingFee.amount,
    reasonCode: row.supplierBillingFee.reasonCode,
  },
  channelPayoutFee: {
    state: row.channelPayoutFee.state,
    amount: row.channelPayoutFee.amount,
    reasonCode: row.channelPayoutFee.reasonCode,
  },
  vehicleValueEvidence: row.vehicleValueEvidence
    ? { grade: row.vehicleValueEvidence.grade, source: row.vehicleValueEvidence.source }
    : null,
  ...(row.applyState === 'HOLD' ? { reasonCode: row.holdReasonCode ?? 'CONTRACT_TIME_VALUE_UNAVAILABLE' } : {}),
});

const ledgerFeeForContract = (
  input: ContractFeeLinkInput,
  data: ContractFeeLinkData,
  term: PriceTerm,
  match: { assetId: string; supplierId: string },
): ContractFeeLinkLedgerFee | undefined => {
  if (!data.ledgerRows || !input.contractDate) return undefined;
  const deposit = input.deposit ?? moneyAmount(term.deposit);
  if (deposit === null) return undefined;
  const picked = pickLedgerRowForContract({
    // 같은 개월·금액의 다른 차량 행이 섞이지 않도록 이미 매칭된 차량·공급사·기간 키로 먼저 좁힌다. 후보가 없으면 HOLD.
    rows: data.ledgerRows.filter((row) => row.assetId === match.assetId
      && row.supplierId === match.supplierId),
    contractDate: input.contractDate,
    contractAt: input.contractAt,
    termMonths: input.termMonths,
    monthlyRent: input.monthlyRent,
    deposit,
  });
  if (picked.status === 'HOLD') {
    return {
      status: 'HOLD',
      supplierBillingFee: { state: 'UNKNOWN', amount: null, reasonCode: picked.reasonCode },
      channelPayoutFee: { state: 'UNKNOWN', amount: null, reasonCode: picked.reasonCode },
      vehicleValueEvidence: null,
      reasonCode: picked.reasonCode,
      baselineExcludedCount: picked.detail.baselineExcludedCount,
    };
  }
  return ledgerFeeFromRow(picked.row);
};

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
  const ledgerFee = ledgerFeeForContract(input, data, term, { assetId: asset.id, supplierId: offer.supplierId });
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
      ...(ledgerFee ? { ledgerFee } : {}),
    };
  }
  return {
    status: 'LINKED',
    ...offerIds,
    priceTerm: priceTermResult(term),
    fees,
    ...(ledgerFee ? { ledgerFee } : {}),
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
