import type { AdminPriceTerm, EconomicsCoverage, CommercialType, Money, Offer, OfferTermEconomics, Policy, PriceTerm, TermEconomicAmount } from '../domain/catalog.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { CommissionEvidenceByTerm } from './kakao-catalog-reference.js';
import { KAKAO_COMMISSION_POLICY, resolveSalesCommission, resolveSupplierBillingFee } from './kakao-catalog-reference.js';
import type { PeriodFeeLedgerRow } from './period-fee-ledger-plan.js';
import type {
  DepositResolution,
  MileageResolution,
  OfferCommercialTerms,
  OfferEconomicsAudit,
  ResolvedCommercialTerm,
} from '../domain/offer-commercial-terms.js';

const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Reuses the pinned engine; changes only two fee fields on existing, price-aligned rows. */
export function selectOfferFeeEconomics(offer: Offer, commercialType?: CommercialType, fuel?: string | null, termKeys?: readonly string[]) {
  if (termKeys === undefined) return precomputeOfferEconomics(offer, commercialType, fuel);
  if (!Array.isArray(termKeys) || !termKeys.length || new Set(termKeys).size!==termKeys.length || termKeys.some(key=>typeof key!=='string'||!key.trim()))
    throw new Error('FEE_SUBSET_KEYS_REQUIRED');
  const old=offer.internalEconomicsTerms ?? [];
  for (const key of termKeys) {
    const prices=offer.priceTerms.filter(term=>term.termKey===key), stored=old.filter(term=>term.termKey===key);
    if (prices.length!==1 || stored.length!==1) throw new Error('FEE_SUBSET_STORED_ROW_REQUIRED');
    if (stored[0]!.termMonths!==prices[0]!.termMonths || stableDigest(stored[0]!.monthlyRent ?? null)!==stableDigest(prices[0]!.monthlyRent) ||
        stored[0]!.depositCalculation.state!==prices[0]!.depositState || stableDigest(stored[0]!.depositCalculation.amount ?? null)!==stableDigest(prices[0]!.deposit ?? null))
      throw new Error('FEE_SUBSET_PRICE_EVIDENCE_DRIFT');
  }
  // Unselected rows are not recalculated, including legacy fee overrides.
  const selectedOffer={...offer,priceTerms:offer.priceTerms,internalEconomicsTerms:old.filter(term=>termKeys.includes(term.termKey))};
  const computed=precomputeOfferEconomics(selectedOffer,commercialType,fuel,{},termKeys);
  return old.map(term=>{
    if (!termKeys.includes(term.termKey)) return structuredClone(term);
    const next=computed.find(candidate=>candidate.termKey===term.termKey)!;
    return {...structuredClone(term),supplierBillingFee:next.supplierBillingFee,channelPayoutFee:next.channelPayoutFee};
  });
}

/** Stored facts only. IDs, revision and complete price condition must match; never infer aliases. */
export function joinStoredProductEconomics(productId: string, offers: readonly Offer[], ledger: readonly PeriodFeeLedgerRow[]) {
  const unknown = (reasonCode: string): TermEconomicAmount => ({state:'UNKNOWN',amount:null,calculation:null,
    sourceRefs:[],vatAmount:null,totalAmount:null,reasonCode});
  const normalize = (fee: TermEconomicAmount): TermEconomicAmount => {
    if (fee.state === 'UNKNOWN') return unknown(fee.reasonCode || 'STORED_FEE_UNKNOWN');
    if (fee.state === 'NOT_APPLICABLE') return fee.amount == null ? structuredClone(fee) : unknown('INVALID_STORED_FEE_STATE');
    const valid = fee.amount?.currency === 'KRW' && Number.isSafeInteger(fee.amount.amount) &&
      (fee.state === 'ZERO' ? fee.amount.amount === 0 : fee.state === 'KNOWN' && fee.amount.amount > 0) && fee.sourceRefs.length > 0 && fee.sourceRefs.every(ref=>typeof ref==='string' && !!ref.trim());
    return valid ? structuredClone(fee) : unknown('STORED_FEE_EVIDENCE_REQUIRED');
  };
  const ledgerFee = (fee: PeriodFeeLedgerRow['supplierBillingFee']): TermEconomicAmount => normalize({
    ...structuredClone(fee), state:fee.state === 'CALCULATED' ? (fee.amount?.amount === 0 ? 'ZERO':'KNOWN') :
      fee.state === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE':'UNKNOWN',
    calculation:null, reasonCode:fee.state === 'CALCULATED_APPROX' ? 'APPROX_FEE_NOT_CONFIRMED':fee.reasonCode,
    vatTreatment:fee.vatTreatment ?? 'UNKNOWN',policyId:fee.policyId ?? ''});
  const comparable = (fee: TermEconomicAmount) => ({state:fee.state,amount:fee.amount ?? null,
    vatTreatment:fee.vatTreatment ?? 'UNKNOWN',vatAmount:fee.vatAmount ?? null,totalAmount:fee.totalAmount ?? null,
    policyId:fee.policyId?.trim() || null,ruleId:fee.ruleId ?? null});
  const selected = offers.filter(offer=>offer.productId===productId);
  const rows = selected.flatMap(offer=>offer.priceTerms.map(price=>{
    const economics=offer.internalEconomicsTerms?.filter(term=>term.termKey===price.termKey) ?? [];
    const matches=ledger.filter(row=>row.productId===productId && row.offerId===offer.id && row.termKey===price.termKey);
    let reason:string|null=null;
    if (selected.filter(candidate=>candidate.id===offer.id).length!==1 || offer.priceTerms.filter(term=>term.termKey===price.termKey).length!==1 || economics.length>1 || matches.length>1)
      reason='DUPLICATE_STORED_JOIN_KEY';
    const saved=economics[0], stored=matches[0];
    if (!reason && saved && (saved.termMonths!==price.termMonths || !saved.monthlyRent || stableDigest(saved.monthlyRent)!==stableDigest(price.monthlyRent) ||
      saved.depositCalculation.state!==price.depositState || stableDigest(saved.depositCalculation.amount ?? null)!==stableDigest(price.deposit ?? null))) reason='OFFER_ECONOMICS_PRICE_MISMATCH';
    if (!reason && stored && (stored.offerRevision!==offer.revision || stored.supplierId!==offer.supplierId || stored.termMonths!==price.termMonths ||
      stableDigest(stored.monthlyRent.state==='KNOWN'?{amount:stored.monthlyRent.amount,currency:stored.monthlyRent.currency}:null)!==stableDigest(price.monthlyRent) ||
      stored.deposit.state!==price.depositState || stableDigest(stored.deposit.amount)!==stableDigest(price.deposit ?? null))) reason='LEDGER_PRICE_OR_REVISION_MISMATCH';
    if (!reason && stored && stored.applyState!=='READY') reason=stored.holdReasonCode || 'LEDGER_NOT_READY';
    const billing=saved?normalize(saved.supplierBillingFee):stored?ledgerFee(stored.supplierBillingFee):unknown('STORED_ECONOMICS_NOT_FOUND');
    const payout=saved?normalize(saved.channelPayoutFee):stored?ledgerFee(stored.channelPayoutFee):unknown('STORED_ECONOMICS_NOT_FOUND');
    if (!reason && saved && stored && (stableDigest(comparable(billing))!==stableDigest(comparable(ledgerFee(stored.supplierBillingFee))) ||
      stableDigest(comparable(payout))!==stableDigest(comparable(ledgerFee(stored.channelPayoutFee))))) reason='STORED_FEE_SOURCES_CONFLICT';
    const rentValid=price.monthlyRent.currency==='KRW' && positiveSafeInteger(price.monthlyRent.amount);
    const verifiedZeroRent=price.monthlyRent.currency==='KRW' && price.monthlyRent.amount===0 &&
      stored?.monthlyRent.state==='KNOWN' && stored.monthlyRent.amount===0 && stored.priceSourceRefs.some(ref=>typeof ref==='string' && !!ref.trim());
    return {productId,offerId:offer.id,offerRevision:offer.revision,supplierId:offer.supplierId,
      termKey:price.termKey,termMonths:price.termMonths,joinState:reason?'HOLD':saved&&stored?'MATCHED':saved?'OFFER_ONLY':stored?'LEDGER_ONLY':'HOLD',reasonCode:reason ?? (saved||stored?null:'STORED_ECONOMICS_NOT_FOUND'),
      monthlyRent:{state:!reason&&verifiedZeroRent?'ZERO':rentValid&&!reason?'KNOWN':'UNKNOWN',amount:(rentValid||verifiedZeroRent)&&!reason?structuredClone(price.monthlyRent):null,reasonCode:reason ?? (rentValid||verifiedZeroRent?null:'RENT_EVIDENCE_REQUIRED')},
      deposit:reason?unknown(reason):normalize({state:price.depositState,amount:price.deposit ?? null,calculation:null,
        sourceRefs:stored?.deposit.sourceRefs ?? saved?.depositCalculation.sourceRefs ?? [],reasonCode:stored?.deposit.reasonCode ?? 'DEPOSIT_EVIDENCE_REQUIRED'}),
      supplierBillingFee:reason?unknown(reason):billing,channelPayoutFee:reason?unknown(reason):payout};
  }));
  return {productId,rows,orphanLedgerRows:ledger.filter(row=>row.productId===productId && !rows.some(join=>join.offerId===row.offerId && join.termKey===row.termKey)).length};
}

/** Existing approved vehicle-price rates need an explicit source fact; rent is not that fact. */
export function refreshOfferEconomicsForChangedInputs(
  previous: Offer, next: Offer, policyContextChanged: boolean, commercialType?: CommercialType, fuel?: string | null,
  vehiclePriceChange?: { before: Money | null; after: Money | null; sourceRef: string },
) {
  if (typeof policyContextChanged !== 'boolean') throw new Error('POLICY_CONTEXT_CHANGE_DECISION_REQUIRED');
  const candidate = precomputeOfferEconomics(next, commercialType, fuel);
  const old = new Map((previous.internalEconomicsTerms ?? []).map(term => [term.termKey, term]));
  const oldPrices = new Map(previous.priceTerms.map(term => [term.termKey, term]));
  const changedPriceKeys = new Set(next.priceTerms.filter(term => stableDigest(oldPrices.get(term.termKey) ?? null) !== stableDigest(term)).map(term => term.termKey));
  for (const key of oldPrices.keys()) if (!next.priceTerms.some(term => term.termKey === key)) changedPriceKeys.add(key);
  const reference36Changed = stableDigest(previous.priceTerms.filter(term => term.termMonths === 36)) !==
    stableDigest(next.priceTerms.filter(term => term.termMonths === 36));
  const priceChanged = !!vehiclePriceChange && stableDigest(vehiclePriceChange.before) !== stableDigest(vehiclePriceChange.after);
  return candidate.map(term => {
    for (const side of ['supplierBillingFee', 'channelPayoutFee'] as const) {
      const fee = old.get(term.termKey)?.[side];
      if (!fee) continue;
      if (fee.calculation?.kind !== 'RATE' || fee.calculation.base !== 'VEHICLE_PRICE') {
        const referenceChanged = (fee.referenceRentBasis && changedPriceKeys.has(fee.referenceRentBasis.termKey)) ||
          (fee.ruleId?.startsWith('BILLIN_SUBSCRIPTION_36_RENT') && reference36Changed);
        if (!policyContextChanged && !changedPriceKeys.has(term.termKey) && !referenceChanged) term[side] = structuredClone(fee);
        continue;
      }
      term[side] = structuredClone(fee);
      const oldPrice = oldPrices.get(term.termKey), newPrice = next.priceTerms.find(price => price.termKey === term.termKey)!;
      if (policyContextChanged || oldPrice?.termMonths !== newPrice.termMonths ||
          oldPrice?.mileageLimitKmPerYear !== newPrice.mileageLimitKmPerYear) {
        term[side] = { ...structuredClone(fee), state: 'UNKNOWN', amount: null, calculation: null,
          sourceRefs: [], vatAmount: null, totalAmount: null, reasonCode: 'VEHICLE_PRICE_POLICY_CONTEXT_REVIEW_REQUIRED' };
        continue;
      }
      if (!priceChanged) continue;
      const fact = vehiclePriceChange!;
      const valid = fact.after?.currency === 'KRW' && positiveSafeInteger(fact.after.amount) &&
        !!fact.sourceRef.trim() && !!fee.ruleId && !!fee.policyId && fee.sourceRefs.some(ref => ref.trim()) &&
        (fee.state === 'KNOWN' || fee.state === 'ZERO') && Number.isFinite(fee.calculation.rate) && fee.calculation.rate >= 0;
      const amount = valid ? Math.round(fact.after!.amount * fee.calculation.rate) : null;
      if (amount === null || !Number.isSafeInteger(amount) || amount < 0) {
        term[side] = { ...structuredClone(fee), state: 'UNKNOWN', amount: null, calculation: null,
          sourceRefs: [], vatAmount: null, totalAmount: null, reasonCode: 'VEHICLE_PRICE_EVIDENCE_REQUIRED' };
        continue;
      }
      const vat = fee.vatTreatment === 'EXCLUDED' ? Math.round(amount * 0.1) :
        fee.vatTreatment === 'INCLUDED' ? Math.round(amount / 11) : null;
      term[side] = { ...structuredClone(fee), state: amount === 0 ? 'ZERO' : 'KNOWN',
        amount: { amount, currency: 'KRW' }, priceSourceRefs: [fact.sourceRef], vatAmount: vat,
        totalAmount: vat === null ? null : fee.vatTreatment === 'EXCLUDED' ? amount + vat : amount,
        reasonCode: null };
    }
    return term;
  });
}

/** Canonical save adapter for the existing pinned commission policy. No I/O or input mutation.
 * Fees are per whole contract, supply amounts excluding VAT; missing rules are not exemptions.
 * Reuses the period-fees prototype's fail-closed mapping without its compatibility storage path.
 */
export function precomputeOfferEconomics(
  offer: Pick<Offer, 'id' | 'supplierId' | 'priceTerms'> & Pick<Partial<Offer>, 'internalEconomicsTerms'>,
  commercialType?: CommercialType,
  fuel?: string | null,
  evidenceByTerm: CommissionEvidenceByTerm = {},
  termKeys?: readonly string[],
): OfferTermEconomics[] {
  const productType = commercialType ? ({
    NEW_RENT: '신차렌트', USED_RENT: '중고렌트', NEW_SUBSCRIPTION: '신차구독',
    USED_SUBSCRIPTION: '중고구독', OGONG_SUBSCRIPTION: '오공구독', PICKUP_SUBSCRIPTION: '픽업구독',
  } as const)[commercialType] : '';
  const policy = KAKAO_COMMISSION_POLICY;
  return offer.priceTerms.filter(term=>termKeys===undefined || termKeys.includes(term.termKey)).map((term) => {
    const priceRef = `catalog_offers/${offer.id}/priceTerms/${term.termKey}`;
    const basis36 = offer.priceTerms.filter(candidate => candidate.termMonths === 36 &&
      candidate.mileageLimitKmPerYear === term.mileageLimitKmPerYear && candidate.monthlyRent.currency === 'KRW' &&
      positiveSafeInteger(candidate.monthlyRent.amount));
    const q12Basis = offer.supplierId === 'RP012' && commercialType === 'OGONG_SUBSCRIPTION'
      ? offer.priceTerms.filter(candidate => candidate.termMonths === 12 &&
        candidate.mileageLimitKmPerYear === term.mileageLimitKmPerYear && candidate.monthlyRent.currency === 'KRW' &&
        positiveSafeInteger(candidate.monthlyRent.amount))
      : [];
    const automaticSonokongEvidence = offer.supplierId === 'RP012' && commercialType === 'OGONG_SUBSCRIPTION' && q12Basis.length === 1
      ? { q12Basis: { amount: q12Basis[0]!.monthlyRent.amount, sourceRef: 'PRODUCT_12_MONTH_RENT' } }
      : {};
    const args = { ...evidenceByTerm[term.termKey], supplierId: offer.supplierId, productType, fuel: fuel ?? '',
      termMonths: term.termMonths, monthlyRent: term.monthlyRent.amount,
      billin36MonthlyRent: basis36.length === 1 ? basis36[0]!.monthlyRent.amount : undefined,
      ...automaticSonokongEvidence };
    const convert = (result: ReturnType<typeof resolveSalesCommission>, side: 'BILLING' | 'PAYOUT'): TermEconomicAmount => {
      const saved = offer.internalEconomicsTerms?.find(candidate => candidate.termKey === term.termKey)?.[
        side === 'BILLING' ? 'supplierBillingFee' : 'channelPayoutFee'];
      // This adapter has no canonical vehicle-price fact. Never replace that approved basis with rent.
      if (saved?.calculation?.kind === 'RATE' && saved.calculation.base === 'VEHICLE_PRICE') return structuredClone(saved);
      const base: Pick<TermEconomicAmount, 'ruleId' | 'policyId' | 'sourceRefs' | 'priceSourceRefs' | 'vatTreatment' | 'vatAmount' | 'totalAmount' | 'referenceRentBasis'> = { ruleId: result.ruleId, policyId: policy.policyId,
        sourceRefs: [] as string[], priceSourceRefs: [priceRef],
        vatTreatment: result.vatTreatment, vatAmount: result.vatAmount, totalAmount: result.totalAmount };
      if (result.ruleId?.startsWith('BILLIN_SUBSCRIPTION_36_RENT') && basis36.length === 1) {
        base.priceSourceRefs = [...new Set([priceRef, `catalog_offers/${offer.id}/priceTerms/${basis36[0]!.termKey}`])];
        base.referenceRentBasis = { termKey: basis36[0]!.termKey, termMonths: 36,
          monthlyRent: structuredClone(basis36[0]!.monthlyRent), multiplier: side === 'BILLING' ? 1 : 0.8 };
      }
      const unknown = (reasonCode: string): TermEconomicAmount => ({ ...base,
        state: 'UNKNOWN', amount: null, calculation: null, vatAmount: null, totalAmount: null, reasonCode });
      if (!productType) return unknown('PRODUCT_TYPE_REQUIRED');
      if (policy.exceptionSupplierIds.iancar.includes(offer.supplierId as 'RP004') && !fuel?.trim()) {
        return unknown('FUEL_REQUIRED_FOR_SUPPLIER_RULE');
      }
      if (!Number.isSafeInteger(term.termMonths) || term.termMonths < 1 ||
          term.monthlyRent.currency !== 'KRW' || !Number.isSafeInteger(args.monthlyRent) || args.monthlyRent < 0) {
        return unknown('INVALID_PRICE_TERM_INPUT');
      }
      if (result.state === 'NOT_APPLICABLE') return { ...base, state: 'NOT_APPLICABLE', amount: null, calculation: null, reasonCode: result.reasonCode };
      if (result.state === 'COORDINATION_REQUIRED') return unknown('COORDINATION_REQUIRED');
      if (result.state !== 'CALCULATED' || result.amount === null) return unknown(result.reasonCode ?? 'NO_MATCHING_RULE');

      let calculation: TermEconomicAmount['calculation'];
      const monthlyRule = policy.rules.find(rule => rule.id === result.ruleId && 'basis' in rule && rule.basis === 'MONTHLY_RENT');
      if (term.termMonths === 1 && result.ruleId?.startsWith('STANDARD_RERENT_1_') && monthlyRule &&
          'rateBasisPoints' in monthlyRule && typeof monthlyRule.rateBasisPoints === 'number') {
        // Existing supported RATE base equals monthly rent for a one-month contract.
        // Legacy FIXED rows need the original confirmed policy evidence, not just a familiar rule ID.
        if (saved?.calculation?.kind === 'FIXED') {
          const storedTerm = offer.internalEconomicsTerms?.find(candidate => candidate.termKey === term.termKey);
          const oldRent = storedTerm?.monthlyRent;
          const verified = saved.ruleId === result.ruleId && saved.policyId === policy.policyId &&
            saved.sourceRefs.includes(policy.oneMonthBasic.sourceRef) &&
            (saved.state === 'KNOWN' || saved.state === 'ZERO') && oldRent?.currency === 'KRW' &&
            positiveSafeInteger(oldRent.amount) && saved.amount?.currency === 'KRW' &&
            saved.amount.amount === Math.round(oldRent.amount * monthlyRule.rateBasisPoints / 10000) &&
            saved.calculation.amount.currency === 'KRW' && saved.calculation.amount.amount === saved.amount.amount;
          if (!verified) throw new Error('LEGACY_RENT_FEE_BASIS_REVIEW_REQUIRED');
        }
        calculation = { kind: 'RATE', base: 'MONTHLY_RENT_X_TERM', rate: monthlyRule.rateBasisPoints / 10000 };
      } else if (result.ruleId?.endsWith('_RENT_X_TERM')) {
        // Read rates from the same policy table, including the Switch ladder alias.
        const billing = policy.rules.find((rule) => rule.id === 'STANDARD_RERENT_BILLING_LADDER')!;
        const payout = policy.rules.find((rule) => 'termMonths' in rule && rule.termMonths === term.termMonths &&
          rule.id.startsWith('STANDARD_RERENT_') && 'rateBasisPoints' in rule);
        const row = side === 'BILLING' ? billing.termRules.find((rule) => rule.termMonths === term.termMonths) : payout;
        const rate = row && 'rateBasisPoints' in row ? row.rateBasisPoints : null;
        if (rate == null) return unknown('CALCULATION_RULE_REQUIRED');
        calculation = { kind: 'RATE', base: 'MONTHLY_RENT_X_TERM', rate: rate / 10000 };
      } else {
        calculation = { kind: 'FIXED', amount: { amount: result.amount, currency: 'KRW' } };
      }
      return { ...base, state: result.amount === 0 ? 'ZERO' : 'KNOWN',
        sourceRefs: [...(result.sourceRefs ?? []), policy.currentAuthority,
          ...(result.ruleId?.startsWith('SONOKONG_SUBSCRIPTION_') && args.q12Basis?.sourceRef ? [args.q12Basis.sourceRef] : [])],
        amount: { amount: result.amount, currency: 'KRW' }, calculation, reasonCode: null };
    };
    const deposit = structuredClone(term.deposit ?? null);
    return {
      termKey: term.termKey, termMonths: term.termMonths, monthlyRent: structuredClone(term.monthlyRent),
      depositCalculation: { state: term.depositState, amount: deposit,
        calculation: deposit ? { kind: 'FIXED', amount: structuredClone(deposit) } : null,
        sourceRefs: deposit && (term.depositState === 'KNOWN' || term.depositState === 'ZERO') ? [priceRef] : [],
        priceSourceRefs: [priceRef] },
      supplierBillingFee: convert(resolveSupplierBillingFee(args), 'BILLING'),
      channelPayoutFee: convert(resolveSalesCommission(args), 'PAYOUT'),
    };
  });
}

function resolveDefaultMileage(
  offer: Offer,
  policy: Policy | undefined,
  decisions: string[],
  invalidFacts: string[],
): OfferCommercialTerms['defaultMileage'] {
  if (!offer.policyId) {
    decisions.push('DEFAULT_MILEAGE_POLICY_REQUIRED');
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }
  if (!policy) {
    decisions.push('POLICY_NOT_FOUND');
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }
  if (policy.id !== offer.policyId) {
    invalidFacts.push('POLICY_ID_MISMATCH');
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }

  const raw = policy.facts.annual_mileage;
  if (raw === undefined || raw === null || raw === '') {
    decisions.push('DEFAULT_MILEAGE_REQUIRED');
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }
  if (!positiveSafeInteger(raw)) {
    invalidFacts.push('INVALID_POLICY_ANNUAL_MILEAGE');
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }
  return { state: 'KNOWN', kmPerYear: raw, source: 'POLICY' };
}

function resolveDeposit(
  term: PriceTerm,
  decisions: string[],
  invalidFacts: string[],
): DepositResolution {
  if (term.depositState === 'NOT_APPLICABLE') {
    if (term.deposit != null) invalidFacts.push(`DEPOSIT_NOT_APPLICABLE_WITH_AMOUNT:${term.termKey}`);
    return { state: 'NOT_APPLICABLE', source: 'TERM' };
  }

  if (term.depositState === 'UNKNOWN') {
    if (term.deposit != null) invalidFacts.push(`UNKNOWN_DEPOSIT_WITH_AMOUNT:${term.termKey}`);
    decisions.push(`DEPOSIT_REQUIRED:${term.termKey}`);
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }

  if (!term.deposit || term.deposit.currency !== 'KRW' || !Number.isSafeInteger(term.deposit.amount) || term.deposit.amount < 0) {
    invalidFacts.push(`INVALID_DEPOSIT_AMOUNT:${term.termKey}`);
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }

  if (term.depositState === 'ZERO') {
    if (term.deposit.amount !== 0) {
      invalidFacts.push(`ZERO_DEPOSIT_WITH_NONZERO_AMOUNT:${term.termKey}`);
      return { state: 'UNKNOWN', source: 'UNRESOLVED' };
    }
    return { state: 'ZERO', amount: structuredClone(term.deposit), source: 'TERM' };
  }

  if (term.deposit.amount === 0) {
    invalidFacts.push(`KNOWN_DEPOSIT_WITH_ZERO_AMOUNT:${term.termKey}`);
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }
  return { state: 'KNOWN', amount: structuredClone(term.deposit), source: 'TERM' };
}

function resolveMileage(
  term: PriceTerm,
  defaultMileage: OfferCommercialTerms['defaultMileage'],
  invalidFacts: string[],
): MileageResolution {
  const raw = term.mileageLimitKmPerYear;
  if (raw !== undefined && raw !== null) {
    if (!positiveSafeInteger(raw)) {
      invalidFacts.push(`INVALID_TERM_MILEAGE:${term.termKey}`);
      return { state: 'UNKNOWN', source: 'UNRESOLVED', isDefault: false };
    }
    return {
      state: 'KNOWN',
      kmPerYear: raw,
      source: 'TERM',
      isDefault: defaultMileage.state === 'KNOWN' && raw === defaultMileage.kmPerYear,
    };
  }
  if (defaultMileage.state === 'KNOWN') {
    return {
      state: 'KNOWN',
      kmPerYear: defaultMileage.kmPerYear,
      source: 'POLICY_DEFAULT',
      isDefault: true,
    };
  }
  return { state: 'UNKNOWN', source: 'UNRESOLVED', isDefault: false };
}

export function resolveOfferCommercialTerms(
  offer: Offer,
  policy?: Policy,
): OfferCommercialTerms {
  const decisions: string[] = [];
  const invalidFacts: string[] = [];
  const defaultMileage = resolveDefaultMileage(offer, policy, decisions, invalidFacts);

  const terms: ResolvedCommercialTerm[] = offer.priceTerms
    .map((term) => ({
      termKey: term.termKey,
      termMonths: term.termMonths,
      monthlyRent: structuredClone(term.monthlyRent),
      mileage: resolveMileage(term, defaultMileage, invalidFacts),
      deposit: resolveDeposit(term, decisions, invalidFacts),
    }))
    .sort((a, b) =>
      a.termMonths - b.termMonths ||
      (a.mileage.state === 'KNOWN' ? a.mileage.kmPerYear : Number.MAX_SAFE_INTEGER) -
        (b.mileage.state === 'KNOWN' ? b.mileage.kmPerYear : Number.MAX_SAFE_INTEGER) ||
      a.termKey.localeCompare(b.termKey)
    );

  const variantKeys = new Set<string>();
  for (const term of terms) {
    if (term.mileage.state !== 'KNOWN') {
      decisions.push(`MILEAGE_REQUIRED:${term.termKey}`);
      continue;
    }
    const variantKey = `${term.termMonths}:${term.mileage.kmPerYear}`;
    if (variantKeys.has(variantKey)) invalidFacts.push(`DUPLICATE_TERM_VARIANT:${variantKey}`);
    variantKeys.add(variantKey);
  }

  if (defaultMileage.state === 'KNOWN') {
    const months = [...new Set(terms.map((term) => term.termMonths))].sort((a, b) => a - b);
    for (const termMonths of months) {
      const hasDefaultVariant = terms.some((term) =>
        term.termMonths === termMonths &&
        term.mileage.state === 'KNOWN' &&
        term.mileage.kmPerYear === defaultMileage.kmPerYear
      );
      if (!hasDefaultVariant) decisions.push(`DEFAULT_MILEAGE_PRICE_MISSING:${termMonths}`);
    }
  }

  const uniqueDecisions = [...new Set(decisions)].sort();
  const uniqueInvalidFacts = [...new Set(invalidFacts)].sort();
  const status = uniqueInvalidFacts.length
    ? 'INVALID'
    : uniqueDecisions.length
      ? 'NEEDS_DECISION'
      : 'READY';

  return {
    offerId: offer.id,
    productId: offer.productId,
    supplierId: offer.supplierId,
    ...(offer.policyId ? { policyId: offer.policyId } : {}),
    defaultMileage,
    terms,
    status,
    decisions: uniqueDecisions,
    invalidFacts: uniqueInvalidFacts,
  };
}

export function summarizeCommercialTerms(
  resolved: readonly OfferCommercialTerms[],
) {
  const byStatus = { READY: 0, NEEDS_DECISION: 0, INVALID: 0 };
  const decisionCounts: Record<string, number> = {};
  const invalidCounts: Record<string, number> = {};

  for (const item of resolved) {
    byStatus[item.status] += 1;
    for (const decision of item.decisions) {
      const code = decision.split(':', 1)[0]!;
      decisionCounts[code] = (decisionCounts[code] ?? 0) + 1;
    }
    for (const invalid of item.invalidFacts) {
      const code = invalid.split(':', 1)[0]!;
      invalidCounts[code] = (invalidCounts[code] ?? 0) + 1;
    }
  }

  return {
    total: resolved.length,
    byStatus,
    decisionCounts: Object.fromEntries(Object.entries(decisionCounts).sort(([a], [b]) => a.localeCompare(b))),
    invalidCounts: Object.fromEntries(Object.entries(invalidCounts).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function auditEconomicAmount(
  value: TermEconomicAmount,
  label: string,
  monthlyRent: number,
  termMonths: number,
  decisions: string[],
  invalidFacts: string[],
) {
  if (!['KNOWN', 'ZERO', 'UNKNOWN', 'NOT_APPLICABLE'].includes(value.state)) {
    invalidFacts.push(`INVALID_ECONOMICS_STATE:${label}`);
    return;
  }
  const amount = value.amount?.amount;
  const hasAmount = value.amount != null;
  const hasCalculation = value.calculation != null;
  const validRefs = Array.isArray(value.sourceRefs) && value.sourceRefs.length > 0 &&
    value.sourceRefs.every((ref) => typeof ref === 'string' && ref.trim().length > 0);

  if (value.state === 'UNKNOWN' || value.state === 'NOT_APPLICABLE') {
    if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length !== 0) invalidFacts.push(`ECONOMICS_UNRESOLVED_WITH_SOURCE:${label}`);
    if (hasAmount || hasCalculation) invalidFacts.push(`ECONOMICS_UNRESOLVED_WITH_VALUE:${label}`);
    if (value.state === 'UNKNOWN') decisions.push(`ECONOMICS_VALUE_REQUIRED:${label}`);
    return;
  }
  if (!validRefs) invalidFacts.push(`ECONOMICS_SOURCE_REQUIRED:${label}`);
  if (!hasAmount || value.amount?.currency !== 'KRW' || !Number.isSafeInteger(amount) || amount! < 0) {
    invalidFacts.push(`INVALID_ECONOMICS_AMOUNT:${label}`);
    return;
  }
  if (value.state === 'ZERO' && amount !== 0) invalidFacts.push(`ZERO_ECONOMICS_WITH_NONZERO_AMOUNT:${label}`);
  if (value.state === 'KNOWN' && amount === 0) invalidFacts.push(`KNOWN_ECONOMICS_WITH_ZERO_AMOUNT:${label}`);
  if (!hasCalculation) {
    invalidFacts.push(`ECONOMICS_CALCULATION_REQUIRED:${label}`);
    return;
  }

  const calculation = value.calculation!;
  let expected: number | undefined;
  if (calculation.kind === 'FIXED') {
    if (calculation.amount.currency !== 'KRW' || !Number.isSafeInteger(calculation.amount.amount) || calculation.amount.amount < 0) {
      invalidFacts.push(`INVALID_ECONOMICS_CALCULATION:${label}`);
      return;
    }
    expected = calculation.amount.amount;
  } else if (calculation.kind === 'MULTIPLY') {
    if (!Number.isFinite(calculation.multiplier) || calculation.multiplier < 0) {
      invalidFacts.push(`INVALID_ECONOMICS_CALCULATION:${label}`);
      return;
    }
    expected = Math.round(monthlyRent * calculation.multiplier);
  } else if (calculation.base === 'MONTHLY_RENT_X_TERM') {
    if (!Number.isFinite(calculation.rate) || calculation.rate < 0) {
      invalidFacts.push(`INVALID_ECONOMICS_CALCULATION:${label}`);
      return;
    }
    expected = Math.round(monthlyRent * termMonths * calculation.rate);
  } else if (!Number.isFinite(calculation.rate) || calculation.rate < 0) {
    invalidFacts.push(`INVALID_ECONOMICS_CALCULATION:${label}`);
    return;
  }

  if (calculation.kind === 'RATE' && calculation.base === 'VEHICLE_PRICE') {
    decisions.push(`ECONOMICS_CALCULATION_INPUT_REQUIRED:${label}:VEHICLE_PRICE`);
  }

  // VEHICLE_PRICE needs the contract/quote snapshot input and is validated there.
  if (expected !== undefined && expected !== amount) {
    invalidFacts.push(`ECONOMICS_CALCULATION_MISMATCH:${label}`);
  }
}

/**
 * Audits pre-contract product economics without becoming a settlement calculator.
 * Contract overrides, invoicing, collection and payout remain in the Admin settlement domain.
 */
export function auditOfferEconomicsTerms(offer: Offer): OfferEconomicsAudit {
  const decisions: string[] = [];
  const invalidFacts: string[] = [];
  const economics = structuredClone(offer.internalEconomicsTerms ?? []);
  const prices = new Map(offer.priceTerms.map((term) => [term.termKey, term]));
  const seen = new Set<string>();

  for (const term of economics) {
    if (seen.has(term.termKey)) invalidFacts.push(`DUPLICATE_ECONOMICS_TERM:${term.termKey}`);
    seen.add(term.termKey);
    const price = prices.get(term.termKey);
    if (!price) {
      invalidFacts.push(`ORPHAN_ECONOMICS_TERM:${term.termKey}`);
      continue;
    }
    if ((term.monthlyRent && (term.monthlyRent.amount !== price.monthlyRent.amount || term.monthlyRent.currency !== price.monthlyRent.currency)) ||
        (term.termMonths !== undefined && term.termMonths !== price.termMonths)) {
      invalidFacts.push(`STALE_ECONOMICS_INPUT:${term.termKey}`);
    }
    auditEconomicAmount(term.depositCalculation, `${term.termKey}:DEPOSIT`, price.monthlyRent.amount, price.termMonths, decisions, invalidFacts);
    auditEconomicAmount(term.supplierBillingFee, `${term.termKey}:SUPPLIER_BILLING_FEE`, price.monthlyRent.amount, price.termMonths, decisions, invalidFacts);
    auditEconomicAmount(term.channelPayoutFee, `${term.termKey}:CHANNEL_PAYOUT_FEE`, price.monthlyRent.amount, price.termMonths, decisions, invalidFacts);
    for (const side of ['supplierBillingFee', 'channelPayoutFee'] as const) {
      const fee = term[side], basis = fee.referenceRentBasis;
      if (!basis) continue;
      const reference = prices.get(basis.termKey);
      if (!reference || reference.termMonths !== 36 || basis.termMonths !== 36 ||
          reference.monthlyRent.amount !== basis.monthlyRent.amount || reference.monthlyRent.currency !== basis.monthlyRent.currency ||
          basis.multiplier !== (side === 'supplierBillingFee' ? 1 : 0.8) ||
          Math.round(basis.monthlyRent.amount * basis.multiplier) !== fee.amount?.amount) {
        invalidFacts.push(`ECONOMICS_REFERENCE_RENT_MISMATCH:${term.termKey}:${side}`);
      }
    }

    if (
      (term.depositCalculation.state === 'KNOWN' || term.depositCalculation.state === 'ZERO') &&
      (price.depositState === 'KNOWN' || price.depositState === 'ZERO') &&
      term.depositCalculation.amount?.amount !== price.deposit?.amount
    ) {
      invalidFacts.push(`DEPOSIT_ECONOMICS_MISMATCH:${term.termKey}`);
    }
  }
  for (const term of offer.priceTerms) {
    if (!seen.has(term.termKey)) decisions.push(`ECONOMICS_TERM_REQUIRED:${term.termKey}`);
  }

  const uniqueDecisions = [...new Set(decisions)].sort();
  const uniqueInvalidFacts = [...new Set(invalidFacts)].sort();
  return {
    status: uniqueInvalidFacts.length ? 'INVALID' : uniqueDecisions.length ? 'NEEDS_DECISION' : 'READY',
    terms: economics.sort((a, b) => a.termKey.localeCompare(b.termKey)),
    decisions: uniqueDecisions,
    invalidFacts: uniqueInvalidFacts,
  };
}


/** Reads stored facts only. Never calculate commissions on the Admin read path. */
export function readStoredTermFees(offer: Offer, price: PriceTerm): Pick<AdminPriceTerm, 'supplierBillingFee' | 'channelPayoutFee'> {
  const matches = (offer.internalEconomicsTerms ?? []).filter(row => row.termKey === price.termKey);
  const read = (field: 'supplierBillingFee' | 'channelPayoutFee'): TermEconomicAmount => {
    const row = matches.length === 1 ? matches[0] : undefined;
    const value = row?.[field];
    const unknown = (reasonCode: string): TermEconomicAmount => ({
      state: 'UNKNOWN', amount: null, calculation: null, reasonCode,
      ruleId: value?.ruleId ?? null, ...(value?.policyId ? { policyId: value.policyId } : {}),
      sourceRefs: [], priceSourceRefs: [`catalog_offers/${offer.id}/priceTerms/${price.termKey}`],
    });
    if (!value) return unknown(matches.length > 1 ? 'DUPLICATE_ECONOMICS_TERM' : 'ECONOMICS_NOT_PRECOMPUTED');
    if ((row?.monthlyRent && (row.monthlyRent.amount !== price.monthlyRent.amount || row.monthlyRent.currency !== price.monthlyRent.currency)) ||
        (row?.termMonths !== undefined && row.termMonths !== price.termMonths)) return unknown('STALE_ECONOMICS_INPUT');
    const errors: string[] = [];
    auditEconomicAmount(value, field, price.monthlyRent.amount, price.termMonths, [], errors);
    if (!['KNOWN', 'ZERO', 'UNKNOWN', 'NOT_APPLICABLE'].includes(value.state) || errors.length) return unknown('INVALID_STORED_ECONOMICS');
    return { ...structuredClone(value), amount: structuredClone(value.amount ?? null) };
  };
  return { supplierBillingFee: read('supplierBillingFee'), channelPayoutFee: read('channelPayoutFee') };
}

/** Each fee counts one entry per price term; UNKNOWN on either side makes coverage incomplete. */
export function summarizeEconomicsCoverage(
  terms: readonly Partial<Pick<AdminPriceTerm, 'supplierBillingFee' | 'channelPayoutFee'>>[],
): EconomicsCoverage {
  const counts = () => ({ KNOWN: 0, ZERO: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 });
  const economicsTermCounts = { supplierBillingFee: counts(), channelPayoutFee: counts() };
  for (const term of terms) for (const side of ['supplierBillingFee', 'channelPayoutFee'] as const) {
    const state = term[side]?.state;
    economicsTermCounts[side][state && state in economicsTermCounts[side] ? state : 'UNKNOWN'] += 1;
  }
  return { economicsTermCounts, economicsCoverage: !terms.length ||
    economicsTermCounts.supplierBillingFee.UNKNOWN > 0 || economicsTermCounts.channelPayoutFee.UNKNOWN > 0
    ? 'INCOMPLETE' : 'COMPLETE' };
}
