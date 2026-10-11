import { plateIdentityKey, isStrictKoreanPlate } from '../domain/vehicle-plate.js';
import { createHash } from 'node:crypto';
import { CONDITION_DIMENSION_SPECS } from './product-condition-dimensions.js';
import { policyScalar } from './product-pricing-policy.js';
import { selectErp5Policy } from '../adapters/erp5-product-mapping.js';
import { assessDepositEvidence, depositEvidenceInputFromProduct, depositSourceWaiverFieldForTermMonths, depositStatusLabel, hasConflictingPaidDeposit, parseErp5CompatibilityPriceKey, readIancarPublishedDeposit, resolveDepositWithRuleNote } from '../domain/deposit-evidence.js';
import { verifiedMasterRecords, verifiedVehicleMasterReference, type VehicleMasterSnapshot } from '../adapters/vehicle-identity-inputs.js';
import { chooseVehicleIdentity, indexVehicleMaster, type VehicleMasterReference } from '../domain/vehicle-identity-resolution.js';
import sheetSpec from '../../contracts/supplier-input-sheet-spec.v1.json' with { type: 'json' };
import type { FieldLineageRecord } from '../domain/lineage.js';
import type { SourceIngestionStore } from '../ports/source-store.js';
import type { RawRecord, NormalizedCandidateRecord } from '../domain/source.js';
import { isAssignedPlate } from '../domain/vehicle-plate.js';
import { stableDigest } from '../shared/stable-digest.js';
import { sharedSheetRegisteredChannels } from '../adapters/shared-sheet-source.js';
import { F04_SUPPLIER_CODES } from './f04-commission-projection.js';
import { evidenceByTermForProduct, publicVehicleValueEvidence, type NewCarTrimEvidenceInput, type VehicleValueEvidence } from './vehicle-value-evidence.js';

export const referenceResponseDigest = (data: unknown, sourceObservations?: unknown) => hash(JSON.stringify(sourceObservations ? { data, sourceObservations } : data));

/** Existing consumer application composes stored facts and sealed source evidence without a relay API. */
export async function readStoredConsumerProducts<T extends { products: { supplierId?: string | null }[] }, C>(reader: {
  readStoredProducts(consumerId: string, search: Record<string, string>, photoProjection?: (product: Rec) => unknown,
    registeredNames?: (supplierId: string) => readonly string[]): Promise<T>;
  sourceStore: Pick<SourceIngestionStore, 'getSourceHead' | 'getRun' | 'listRaw' | 'listCandidates'> & Partial<Pick<SourceIngestionStore, 'listLineage'>>;
  readCanonicalProducts?: (search: Record<string, string>, ledgerRows: readonly unknown[]) => Promise<C>;
}, consumerId: string, search: Record<string, string> = {}, sourceGrant?: {
  /** Trusted server configuration after its own authorization; never accept this from a client body. */
  sourceScope: 'COLLECTED'; supplierIds: readonly string[] | null;
}) {
  if (!search || typeof search !== 'object' || Array.isArray(search)) throw new Error('INVALID_PRODUCT_SEARCH');
  for (const [name, value] of Object.entries(search))
    if (!['productId', 'supplierId', 'supplierName', 'vehicleName', 'plate'].includes(name)
      || typeof value !== 'string' || !value.trim()) throw new Error('INVALID_PRODUCT_SEARCH');
  if (search.plate && !isAssignedPlate(search.plate)) throw new Error('PLATE_NOT_ASSIGNED');
  if (sourceGrant && (sourceGrant.sourceScope !== 'COLLECTED' || (sourceGrant.supplierIds !== null
    && (!Array.isArray(sourceGrant.supplierIds) || sourceGrant.supplierIds.some(id => typeof id !== 'string' || !id.trim())))))
    throw new Error('INVALID_SOURCE_READ_GRANT');
  const supplierScope = sourceGrant?.supplierIds === null ? null : [...(sourceGrant?.supplierIds ?? [])];
  const registeredNames = (id: string) => [...sharedSheetRegisteredChannels.filter(row => row.code === id).map(row => row.companyName),
    ...Object.entries(F04_SUPPLIER_CODES).filter(([, code]) => code === id).map(([name]) => name)];
  const saved = await reader.readStoredProducts(consumerId, search, resolveReferenceVehiclePhotos, registeredNames);
  const ledgerRows = (saved as { ledgerRows?: readonly unknown[] }).ledgerRows ?? [];
  const source = sourceGrant && (supplierScope === null || supplierScope.length > 0)
    ? await readCurrentReferenceObservations(reader.sourceStore, { storedFeesOnly: true })
    : { observations: [], sourceSnapshot: null, state: 'HOLD',
      reasonCode: sourceGrant ? 'SOURCE_READ_SCOPE_EMPTY' : 'SOURCE_READ_GRANT_REQUIRED' };
  const key = (v: unknown) => typeof v === 'string' ? v.normalize('NFKC').replace(/\s+/g, '').toLowerCase() : '';
  const savedSupplierIds = [...new Set(saved.products.map(p => p.supplierId).filter((id): id is string => !!id))];
  const sourceRows = source.observations.filter(row => (supplierScope === null || (row.normalized.supplierId !== null
    && supplierScope.includes(row.normalized.supplierId))) && (!search.productId || row.productId === search.productId.trim())
    && (!search.supplierId || row.normalized.supplierId === search.supplierId.trim())
    && (!search.supplierName || key(row.original.supplierName) === key(search.supplierName)
      || (savedSupplierIds.length === 1 && row.normalized.supplierId === savedSupplierIds[0])
      || (row.normalized.supplierId && registeredNames(row.normalized.supplierId).some(name => key(name) === key(search.supplierName))))
    && (!search.plate || plateIdentityKey(row.normalized.plateNumber) === plateIdentityKey(search.plate))
    && (!search.vehicleName || key([row.normalized.maker, row.normalized.model, row.normalized.subModel, row.normalized.trim].filter(Boolean).join(' ')).includes(key(search.vehicleName))));
  const supplierIds = [...new Set([...saved.products.map(p => p.supplierId), ...sourceRows.map(p => p.normalized.supplierId)].filter((id): id is string => !!id))];
  const ambiguous = !!search.supplierName && supplierIds.length > 1;
  const canonicalSearch: Record<string, string> = search.supplierName && supplierIds.length === 1 ? { ...search, supplierId: supplierIds[0]! } : { ...search };
  if (search.supplierName && supplierIds.length === 1) delete canonicalSearch.supplierName;
  const canonicalProducts = reader.readCanonicalProducts && !ambiguous ? await reader.readCanonicalProducts(canonicalSearch, ledgerRows) : null;
  return { ...saved, canonicalProducts, supplierSearchEvidence: { state: ambiguous ? 'HOLD' : 'EXACT',
    reasonCode: ambiguous ? 'SUPPLIER_SEARCH_AMBIGUOUS' : null, matchedSupplierIds: supplierIds.length },
    canonicalEvidence: { state: reader.readCanonicalProducts && !ambiguous ? 'READ_COMPLETED' : 'UNKNOWN',
    reasonCode: ambiguous ? 'SUPPLIER_SEARCH_AMBIGUOUS' : reader.readCanonicalProducts ? null : 'CANONICAL_READER_NOT_CONNECTED', snapshotConsistency: 'SEPARATE_CANONICAL_READ',
    authority: 'STORED_CANONICAL', emptyDoesNotProveAbsence: true },
    sourceFreshness: { state: 'UNVERIFIED', reasonCode: 'CURRENT_SOURCE_HEAD_NOT_PROOF_OF_CANONICAL_FRESHNESS' },
    ledgerSnapshot: { observedAt: (saved as { meta?: { readAt?: string } }).meta?.readAt ?? null,
      digest: stableDigest(ledgerRows), currentHeadVerified: false },
    photoAccessVerification: 'NOT_CHECKED',
    settlementConfirmation: 'NOT_ASSESSED',
    sourceRows, sourceEvidence: { state: source.state, reasonCode: source.reasonCode,
    snapshot: source.sourceSnapshot ? { ...source.sourceSnapshot, returnedProductRowCount: sourceRows.length } : null,
    snapshotConsistency: 'SEPARATELY_SEALED_NOT_PRODUCT_TRANSACTION' } };
}

/** Opt-in authenticated ERP input adapter. A source row is a product, not a publicly sellable asset. */
export function referenceObservationToCompatibilityProduct(row: ReturnType<typeof projectReferenceObservation>) {
  const n = row.normalized, o = row.original;
  const fact = (key: string) => row.facts.find(f => f.fieldKey === key);
  const known = (key: string) => fact(key)?.state === 'KNOWN' ? fact(key)!.normalizedValue : null;
  return { product_code: row.productId, _key: row.productId, id: row.productId,
    provider_company_code: n.supplierId, provider_name: o.supplierName,
    car_number: n.plateNumber, vehicle_uid: null, maker: n.maker ?? o.maker, model: n.model ?? o.model,
    sub_model: n.subModel ?? o.subModel, trim_name: n.trim ?? o.trim,
    fuel_type: known('fuel'), engine_cc: known('displacementCc'), drive_type: known('drive'), seats: known('seats'),
    mileage: known('mileageKm'), year: known('modelYear')?.toString() ?? null,
    exterior_color: fact('exteriorColor')?.rawValue ?? null, interior_color: fact('interiorColor')?.rawValue ?? null,
    _needs_master_review: true,
    product_type: o.commercialType, vehicle_status: o.status, listable: false,
    price: Object.fromEntries(n.priceConditions.map(t => [String(t.termMonths), {
      rent: t.monthlyRentAmount, deposit: t.depositAmount, depositState: t.depositState, monthlyRentState: t.monthlyRentState,
      supplierBillingFee: t.supplierBillingFee, channelPayoutFee: t.channelPayoutFee,
      expectedGrossMargin: t.expectedGrossMargin, priceSourceRefs: t.priceSourceRefs,
    }])),
    _representation_kind: 'CURRENT_SOURCE_ROW_PRODUCT' as const,
    _publication_decision: 'HOLD' as const, _source_row_product: row };
}

/** Existing source owner and sealed input binding; never scan arbitrary RAW collections. */
export async function readCurrentReferenceObservations(store: Pick<SourceIngestionStore, 'getSourceHead' | 'getRun' | 'listRaw' | 'listCandidates'> & Partial<Pick<SourceIngestionStore, 'listLineage'>>, options?: { storedFeesOnly: boolean }) {
  const sourceId = sheetSpec.supplierManagement.sourceBinding.sourceId;
  const head = await store.getSourceHead(sourceId);
  if (!head) return { state: 'HOLD' as const, reasonCode: 'SOURCE_HEAD_MISSING', observations: [], sourceSnapshot: null };
  const run = await store.getRun(head.runId);
  if (!run || run.sourceId !== sourceId || run.status !== 'COMPLETED' || run.headStatus !== 'CURRENT'
    || run.observedAt !== head.observedAt) throw new Error('REFERENCE_SOURCE_RUN_UNVERIFIED');
  const [raw, candidates, feeLineage] = await Promise.all([store.listRaw(run.runId), store.listCandidates(run.runId), options?.storedFeesOnly && store.listLineage ? store.listLineage(run.runId) : Promise.resolve([])]);
  if (raw.length !== run.rawCount || candidates.length !== run.candidateCount
    || new Set(raw.map(r => r.rawRecordId)).size !== raw.length
    || [...raw, ...candidates].some(r => r.runId !== run.runId || r.sourceId !== sourceId)
    || candidates.some(c => !raw.some(r => r.sourceRecordId === c.sourceRecordId && r.sourceFingerprint === c.sourceFingerprint))) {
    throw new Error('REFERENCE_SOURCE_READ_INCOMPLETE');
  }
  const observations = raw.map(r => {
    const matches = candidates.filter(c => c.sourceRecordId === r.sourceRecordId && c.sourceFingerprint === r.sourceFingerprint);
    return projectReferenceObservation(r, matches.length === 1 ? matches[0] : undefined, options ? {...options, feeLineage} : undefined);
  });
  if (new Set(observations.map(o => o.productId)).size !== observations.length) throw new Error('REFERENCE_SOURCE_ROW_ID_AMBIGUOUS');
  const after = await store.getSourceHead(sourceId);
  if (stableDigest(after) !== stableDigest(head)) throw new Error('REFERENCE_SOURCE_HEAD_DRIFT');
  const tabCounts = new Map<string, number>();
  for (const r of raw) if (typeof r.payload.tab === 'string') tabCounts.set(r.payload.tab, (tabCounts.get(r.payload.tab) ?? 0) + 1);
  return { state: 'HOLD' as const, reasonCode: 'SOURCE_OBSERVATIONS_NOT_CANONICAL', observations,
    sourceSnapshot: { sourceId, runId: run.runId, observedAt: head.observedAt, headStatus: 'CURRENT' as const,
      coverageMode: run.coverage.mode, completeness: run.coverage.completeness,
      countScope: 'CAPTURED_SOURCE_PRODUCT_ROWS_NOT_PHYSICAL_VEHICLES' as const,
      rawRowCount: raw.length, normalizedCandidateCount: candidates.length, currentProductRowCount: observations.length,
      returnedProductRowCount: observations.length,
      observedTabCounts: Object.fromEntries([...tabCounts].sort(([a], [b]) => a.localeCompare(b))),
      unobservedRegisteredTabs: [...new Set(sheetSpec.supplierChannels.sharedInputSheet.map(c => c.tab))].filter(t => !tabCounts.has(t)).sort() } };
}

/** Immutable observations are not permanent products or counted physical vehicles. No free text/PII payload is returned. */
export function sourceFeePolicyContractDigest() {
  const {sourceFiles,...rules}=KAKAO_COMMISSION_POLICY;
  return stableDigest(rules);
}
const SOURCE_FEE_TRANSFORM = 'APPROVED_ENGINE_SOURCE_FEE';
const sourceFeeInputDigest = (raw: RawRecord, record: NormalizedCandidateRecord, termKey: string) => {
  const c=record.candidate, term=c.priceTerms.find(t=>t.termKey===termKey);
  const billin=['RP021','PT-0026'].includes(c.providerCompanyCode??'') && /SUBSCRIPTION/.test(c.commercialType??'');
  return stableDigest({fingerprint:raw.sourceFingerprint,supplier:c.providerCompanyCode??null,
    productType:c.commercialType??null,term:term ? {termKey:term.termKey,termMonths:term.termMonths,monthlyRent:term.monthlyRent,mileageLimitKmPerYear:term.mileageLimitKmPerYear??null} : null,
    ...(billin ? {basis36:c.priceTerms.filter(t=>t.termMonths===36 && t.mileageLimitKmPerYear===term?.mileageLimitKmPerYear)} : {}),
    ...(['RP004','RP023'].includes(c.providerCompanyCode??'') ? {fuel:c.vehicleFacts?.fields.fuel??null} : {})});
};

/** Producer composition only. Persists derived facts without promoting candidate identity. */
export function sourceFeeLineage(raw: RawRecord, record: NormalizedCandidateRecord): FieldLineageRecord[] {
  const observation = projectReferenceObservation(raw, record);
  return record.candidate.priceTerms.flatMap(price => {
    const matches=observation.normalized.priceConditions.filter(t=>t.termMonths===price.termMonths &&
      t.monthlyRentAmount===price.monthlyRent.amount && t.mileageKm===(price.mileageLimitKmPerYear??null));
    if(matches.length!==1) return [];
    const term=matches[0]!,termKey=price.termKey;
    const value = { authority: 'APPROVED_ENGINE_DERIVED_NOT_SETTLEMENT', currency: 'KRW', policyId: KAKAO_COMMISSION_POLICY.policyId, policyDigest: stableDigest(KAKAO_COMMISSION_POLICY), policyContractDigest: sourceFeePolicyContractDigest(),
      inputDigest: sourceFeeInputDigest(raw, record, termKey), observedAt: raw.observedAt, termKey,
      supplierBillingFee: term.supplierBillingFee, channelPayoutFee: term.channelPayoutFee, priceSourceRefs: term.priceSourceRefs };
    const id = `source_fee_${stableDigest({runId:raw.runId,candidateId:record.candidateId,termKey,value})}`;
    return [{lineageRecordId:id,lineageId:id,stage:'RAW_TO_NORMALIZED' as const,runId:raw.runId,sourceId:raw.sourceId,
      sourceRecordId:raw.sourceRecordId,sourceFingerprint:raw.sourceFingerprint,observedAt:raw.observedAt,
      source:{fieldPath:'priceTerms',value:{priceSourceRefs:term.priceSourceRefs}},
      normalized:{candidateId:record.candidateId,fieldPath:`derivedFees.${termKey}`,value},
      transformId:SOURCE_FEE_TRANSFORM,transformVersion:KAKAO_COMMISSION_POLICY.policyId}];
  });
}
function readSourceFeeLineage(raw: RawRecord, record: NormalizedCandidateRecord, termKey: string, lineage: readonly FieldLineageRecord[]) {
  const matches=lineage.filter(l=>l.transformId===SOURCE_FEE_TRANSFORM && l.runId===raw.runId && l.sourceId===raw.sourceId &&
    l.sourceRecordId===raw.sourceRecordId && l.sourceFingerprint===raw.sourceFingerprint && l.normalized?.candidateId===record.candidateId &&
    l.normalized.fieldPath===`derivedFees.${termKey}`);
  if(matches.length!==1) return null;
  const l=matches[0]!, v=l.normalized!.value as Record<string, unknown>;
  if(!v || v.authority!=='APPROVED_ENGINE_DERIVED_NOT_SETTLEMENT' || v.currency!=='KRW' || v.policyId!==KAKAO_COMMISSION_POLICY.policyId || typeof v.policyDigest!=='string' || !/^[a-f0-9]{64}$/.test(v.policyDigest) || v.policyContractDigest!==sourceFeePolicyContractDigest() ||
    v.inputDigest!==sourceFeeInputDigest(raw,record,termKey) || v.observedAt!==raw.observedAt || v.termKey!==termKey || l.stage!=='RAW_TO_NORMALIZED' ||
    l.transformVersion!==KAKAO_COMMISSION_POLICY.policyId || l.observedAt!==raw.observedAt || l.canonical ||
    !Array.isArray(v.priceSourceRefs) || !v.priceSourceRefs.length || v.priceSourceRefs.some(ref=>!ref || ref.runId!==raw.runId || ref.rawRecordId!==raw.rawRecordId || typeof ref.field!=='string' || !['payload.supplierCode',...sheetSpec.inputHeaders].includes(ref.field) || (ref.row!==null && (!Number.isSafeInteger(ref.row)||ref.row<=0))) ||
    l.lineageId!==l.lineageRecordId ||
    l.lineageRecordId!==`source_fee_${stableDigest({runId:raw.runId,candidateId:record.candidateId,termKey,value:v})}`) return null;
  const valid=(fee:unknown): fee is CommissionResolution => {
    if(!fee || typeof fee!=='object' || Array.isArray(fee)) return false;
    const f=fee as CommissionResolution;
    if(!['EXCLUDED','INCLUDED','UNKNOWN'].includes(f.vatTreatment) ||
      (f.ruleId!==null && (typeof f.ruleId!=='string'||!/^[A-Z][A-Z0-9_:.-]{0,199}$/.test(f.ruleId))) ||
      (f.reasonCode!==null && (typeof f.reasonCode!=='string'||!/^[A-Z][A-Z0-9_:.-]{0,199}$/.test(f.reasonCode))) ||
      (f.sourceRefs!==undefined && (!Array.isArray(f.sourceRefs)||f.sourceRefs.some(r=>typeof r!=='string'||!(/^(?:USER:2026-10-09:BILLIN_LC_36_MONTH_RENT_100_80|USER:2026-10-11:ONE_MONTH_RENT_5_PERCENT_FULL_PAYOUT|F04:수수료표!A[1-9][0-9]*:M[1-9][0-9]*)$/.test(r)))))) return false;
    return f.state==='CALCULATED' ? f.vatTreatment!=='UNKNOWN' && !!f.sourceRefs?.length && Number.isSafeInteger(f.amount) && f.amount!>=0 && !!f.ruleId &&
      Number.isSafeInteger(f.vatAmount) && f.vatAmount!>=0 && Number.isSafeInteger(f.totalAmount) &&
      f.totalAmount===f.amount!+f.vatAmount! :
      ['UNKNOWN','COORDINATION_REQUIRED','NOT_APPLICABLE'].includes(f.state) && f.amount===null && f.vatAmount===null && f.totalAmount===null;
  };
  if(!valid(v.supplierBillingFee)||!valid(v.channelPayoutFee))return null;
  const refs=(v.priceSourceRefs as {runId:string;rawRecordId:string;field:string;row:number|null}[]).map(ref=>({runId:ref.runId,rawRecordId:ref.rawRecordId,field:ref.field,row:ref.row}));
  const evidence={authority:v.authority,currency:v.currency,policyId:v.policyId,policyDigest:v.policyDigest,policyContractDigest:v.policyContractDigest,
    inputDigest:v.inputDigest,observedAt:v.observedAt,lineageRecordId:l.lineageRecordId,priceSourceRefs:refs};
  const fee=(f:CommissionResolution)=>({state:f.state,ruleId:f.ruleId,amount:f.amount,vatTreatment:f.vatTreatment,
    vatAmount:f.vatAmount,totalAmount:f.totalAmount,reasonCode:f.reasonCode,
    ...(f.state==='CALCULATED' && f.sourceRefs?{sourceRefs:[...f.sourceRefs]}:{}),derivedEvidence:evidence});
  return {supplierBillingFee:fee(v.supplierBillingFee),channelPayoutFee:fee(v.channelPayoutFee)};
}

export function projectReferenceObservation(raw: RawRecord, record?: NormalizedCandidateRecord, options?: { storedFeesOnly: boolean; feeLineage?: readonly FieldLineageRecord[] }) {
  if (record && (record.runId !== raw.runId || record.sourceId !== raw.sourceId
    || record.sourceRecordId !== raw.sourceRecordId || record.sourceFingerprint !== raw.sourceFingerprint)) {
    throw new Error('REFERENCE_SOURCE_CANDIDATE_MISMATCH');
  }
  const values = Array.isArray(raw.payload.values) ? raw.payload.values : [];
  const scalar = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v
    : typeof v === 'string' && v.length <= 256 ? v : null;
  const original = (header: string) => scalar(values[sheetSpec.inputHeaders.indexOf(header)]);
  const string = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null;
  const candidate = record?.candidate;
  const amount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const sourceRef = (field: string) => ({ runId: raw.runId, rawRecordId: raw.rawRecordId,
    row: Number.isSafeInteger(raw.payload.row) && Number(raw.payload.row) > 0 ? Number(raw.payload.row) : null, field });
  const supplierId = string(candidate?.providerCompanyCode);
  const productType = string(original('상품구분')) ?? '';
  const verifiedProductType = knownProductType(productType) !== 'UNKNOWN'
    && candidate?.commercialType === knownProductType(productType);
  const fuelFact = candidate?.vehicleFacts?.fields.fuel;
  const fuel = fuelFact?.state === 'KNOWN' ? string(fuelFact.value) : null;
  const observation = {
    observationId: `source_observation_${hash(JSON.stringify([raw.runId, raw.rawRecordId, raw.sourceFingerprint]))}`,
    identityKind: 'CURRENT_SOURCE_ROW' as const,
    representationKind: 'CURRENT_SOURCE_ROW_PRODUCT' as const,
    // Position identity for this current source row, never a permanent product/asset UID.
    productId: `source_row_${hash(JSON.stringify([raw.sourceId, raw.payload.tab ?? null, raw.payload.row ?? raw.sourceRecordId]))}`,
    vehicleAssetId: null,
    publicationDecision: 'HOLD' as const,
    reasonCode: !record ? 'NORMALIZED_CANDIDATE_UNAVAILABLE_OR_AMBIGUOUS' : 'SOURCE_IDENTITY_NOT_CANONICAL',
    source: { sourceId: raw.sourceId, runId: raw.runId, rawRecordId: raw.rawRecordId,
      candidateId: record?.candidateId ?? null, sourceFingerprint: raw.sourceFingerprint, observedAt: raw.observedAt,
      candidateStatus: record?.status ?? null,
      tab: sheetSpec.supplierChannels.sharedInputSheet.some(c => c.tab === raw.payload.tab) ? string(raw.payload.tab) : null,
      row: Number.isSafeInteger(raw.payload.row) && Number(raw.payload.row) > 0 ? Number(raw.payload.row) : null,
      captureDigest: typeof raw.payload.captureDigest === 'string' && /^[a-f0-9]{64}$/.test(raw.payload.captureDigest) ? raw.payload.captureDigest : null,
      normalizerRuleVersion: string(candidate?.vehicleFacts?.ruleVersion) },
    normalizationIssues: (candidate?.issues ?? []).filter(code => /^[A-Z][A-Z0-9_:.-]{0,199}$/.test(code)),
    original: { supplierName: original('회사명'), plateNumber: original('차량번호'), status: original('차량상태'),
      maker: original('제조사'), model: original('모델'), subModel: original('세부모델'), trim: original('세부트림'),
      commercialType: original('상품구분'),
      priceConditions: [1, 6, 12, 24, 36, 48, 60].map(termMonths => ({ termMonths,
        monthlyRent: original(`${termMonths}개월`),
        deposit: original(depositSourceWaiverFieldForTermMonths(termMonths) === '원문.전체.단기보증' ? '단기보증' : '장기보증') })) },
    normalized: { supplierId: string(candidate?.providerCompanyCode),
      plateNumber: isAssignedPlate(candidate?.carNumber) ? string(candidate?.carNumber) : null,
      status: string(candidate?.vehicleStatusRaw) ?? string(candidate?.vehicleFacts?.fields.supplierStatus?.value),
      maker: string(candidate?.maker), model: string(candidate?.model), subModel: string(candidate?.subModel), trim: string(candidate?.trimName),
      commercialType: string(candidate?.commercialType),
      priceConditions: (candidate?.priceTerms ?? []).map(t => {
        const rent = amount(t.monthlyRent?.amount), deposit = amount(t.deposit?.amount);
        const state = t.depositState === 'ZERO' && deposit === 0 ? 'ZERO' as const
          : t.depositState === 'KNOWN' && deposit !== null && deposit > 0 ? 'KNOWN' as const : 'UNKNOWN' as const;
        // Never infer a price variant from another row, a plate, or a supplier name.
        const bases36 = (candidate?.priceTerms ?? []).filter(basis => basis.termMonths === 36
          && basis.mileageLimitKmPerYear === t.mileageLimitKmPerYear);
        const billinBasisUsed = ['RP021', 'PT-0026'].includes(supplierId ?? '') && verifiedProductType && /구독/.test(productType);
        const reason = !supplierId ? 'SOURCE_SUPPLIER_MISSING' : !verifiedProductType ? 'SOURCE_PRODUCT_TYPE_UNVERIFIED'
          : rent === null || rent <= 0 ? 'SOURCE_PRICE_CONDITION_UNUSABLE'
          : billinBasisUsed && bases36.length > 1 ? 'BILLIN_36_MONTH_RENT_AMBIGUOUS' : null;
        const input: CommissionInput = { supplierId: supplierId ?? '', productType, termMonths: t.termMonths,
          monthlyRent: rent ?? 0, ...(fuel ? { fuel } : {}),
          billin36MonthlyRent: bases36.length === 1 ? amount(bases36[0]!.monthlyRent.amount) ?? undefined : undefined };
        const storedReason = options?.storedFeesOnly ? 'SOURCE_ROW_STORED_FEE_NOT_LINKED' : reason;
        const stored = options?.storedFeesOnly && record ? readSourceFeeLineage(raw, record, t.termKey, options.feeLineage ?? []) : null;
        const supplierBillingFee = stored?.supplierBillingFee ?? (storedReason ? unknownCommission(storedReason) : resolveSupplierBillingFee(input));
        const channelPayoutFee = stored?.channelPayoutFee ?? (storedReason ? unknownCommission(storedReason) : resolveSalesCommission(input));
        // Supplier identity comes from capture metadata, not the visible company-name cell.
        const priceSourceRefs = [sourceRef('payload.supplierCode'), sourceRef('상품구분'), sourceRef(`${t.termMonths}개월`),
          ...(fuel ? [sourceRef('연료')] : []), ...(billinBasisUsed && bases36.length === 1 ? [sourceRef('36개월')] : [])];
        return { termMonths: t.termMonths, monthlyRentAmount: rent, monthlyRentState: rent === null ? 'UNKNOWN' as const : 'KNOWN' as const,
          depositAmount: state === 'UNKNOWN' ? null : deposit, depositState: state,
          mileageKm: t.mileageLimitKmPerYear ?? null, mileagePeriod: t.mileageLimitKmPerYear == null ? null : 'year' as const,
          supplierBillingFee, channelPayoutFee, expectedGrossMargin: resolveExpectedGrossMargin(supplierBillingFee, channelPayoutFee), priceSourceRefs };
      }) },
  };
  const reasons = (codes: string[]) => codes.filter(code => /^[A-Z][A-Z0-9_:.-]{0,199}$/.test(code));
  const facts = Object.entries({ maker: '제조사', model: '모델', subModel: '세부모델', trimName: '세부트림',
    fuel: '연료', displacementCc: '배기량', drive: '구동방식', seats: '인승', mileageKm: '주행거리',
    modelYear: '연식', firstRegistration: '최초등록일', batteryKwh: '배터리용량', supplierStatus: '차량상태',
    exteriorColor: '외부색상', interiorColor: '내부색상' }).map(([fieldKey, header]) => {
    const fact = candidate?.vehicleFacts?.fields[fieldKey];
    return { fieldKey, rawValue: original(header), normalizedValue: fact?.state === 'KNOWN' ? scalar(fact.value) : null,
      state: fact?.state === 'KNOWN' ? 'KNOWN' : fact?.state === 'REVIEW_REQUIRED' ? 'HOLD' : 'UNKNOWN',
      reasons: reasons(fact?.reasons ?? ['NORMALIZED_FACT_MISSING']), sourceRef: sourceRef(header) };
  });
  facts.push({ fieldKey: 'plateNumber', rawValue: observation.original.plateNumber, normalizedValue: observation.normalized.plateNumber,
    state: observation.normalized.plateNumber ? 'KNOWN' : 'HOLD', reasons: observation.normalized.plateNumber ? [] : ['PLATE_IDENTITY_UNVERIFIED'], sourceRef: sourceRef('차량번호') });
  for (const rawTerm of observation.original.priceConditions) {
    const term = observation.normalized.priceConditions.find(t => t.termMonths === rawTerm.termMonths);
    facts.push({ fieldKey: `monthlyRent:m${rawTerm.termMonths}`, rawValue: rawTerm.monthlyRent, normalizedValue: term?.monthlyRentAmount ?? null,
      state: term?.monthlyRentState ?? 'UNKNOWN', reasons: term?.monthlyRentState === 'KNOWN' ? [] : ['PRICE_TERM_NOT_NORMALIZED'], sourceRef: sourceRef(`${rawTerm.termMonths}개월`) });
    facts.push({ fieldKey: `deposit:m${rawTerm.termMonths}`, rawValue: rawTerm.deposit, normalizedValue: term?.depositAmount ?? null,
      state: term?.depositState ?? 'UNKNOWN', reasons: term?.depositState === 'KNOWN' || term?.depositState === 'ZERO' ? [] : ['DEPOSIT_NOT_VERIFIED'],
      sourceRef: sourceRef(depositSourceWaiverFieldForTermMonths(rawTerm.termMonths) === '원문.전체.단기보증' ? '단기보증' : '장기보증') });
  }
  // Account for every input column without publishing free-form text that may contain PII/documents.
  // Unparsed business cells remain original reference values, never guessed normalized facts.
  const privateFreeText = new Set(['차명 원문', '옵션 원문', '예외사항', '차고지', '접수서류', '비고']);
  const covered = new Set(facts.map(f => f.sourceRef.field));
  for (const header of sheetSpec.inputHeaders) if (!covered.has(header)) {
    facts.push({ fieldKey: `sourceColumn:${header}`, rawValue: privateFreeText.has(header) ? null : original(header),
      normalizedValue: null, state: 'UNKNOWN', reasons: [privateFreeText.has(header) ? 'RAW_FREE_TEXT_WITHHELD' : 'RAW_FIELD_NOT_NORMALIZED'], sourceRef: sourceRef(header) });
  }
  return { ...observation, facts };
}

type Rec = Record<string, unknown>;

/** Supplier vehicle images only; never collect registration/customer document images. */
export function resolveReferenceVehiclePhotos(source: Rec) {
  let rejectedCount = 0;
  const readUrls = (value: unknown): string[] => {
    if (value == null || value === '') return [];
    if (Array.isArray(value)) return value.flatMap(readUrls);
    if (typeof value !== 'string') { rejectedCount += 1; return []; }
    const raw = value.trim();
    if (!raw) return [];
    if (raw.startsWith('[')) {
      try { return readUrls(JSON.parse(raw)); } catch { rejectedCount += 1; return []; }
    }
    if (raw.includes('\n')) return raw.split(/\r?\n/).flatMap(readUrls);
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password) { rejectedCount += 1; return []; }
      return [url.href];
    } catch { rejectedCount += 1; return []; }
  };
  const candidates = [...new Set([source.image_urls, source.images, source.photos, source.image_url, source.photo].flatMap(readUrls))];
  const rejectedBeforeDocuments = rejectedCount;
  const documentUrls = new Set(readUrls(source.doc_images));
  rejectedCount = rejectedBeforeDocuments;
  const imageUrls = candidates.filter(url => !documentUrls.has(url));
  rejectedCount += candidates.length - imageUrls.length;
  const sourceLinks = [...new Set(readUrls(source.photo_link))];
  return {
    state: imageUrls.length ? 'URLS_PRESENT' as const : sourceLinks.length ? 'LINK_ONLY' as const : rejectedCount ? 'UNUSABLE' as const : 'NOT_PROVIDED' as const,
    imageUrls,
    representativeUrl: imageUrls[0] ?? null,
    // Opaque folders may also contain registration/customer documents; do not expand access.
    sourceLinkCount: sourceLinks.length,
    rejectedCount,
    accessVerification: 'NOT_CHECKED' as const,
  };
}
type DepositState = 'KNOWN' | 'ZERO' | 'UNKNOWN';
type VatTreatment = 'EXCLUDED' | 'INCLUDED' | 'UNKNOWN';
type CommissionState = 'CALCULATED' | 'CALCULATED_APPROX' | 'COORDINATION_REQUIRED' | 'UNKNOWN' | 'NOT_APPLICABLE';
type MarginState = 'CALCULATED' | 'UNKNOWN' | 'NOT_APPLICABLE';

export const KAKAO_CATALOG_REFERENCE_SCHEMA = 'freepass-data.kakao-catalog-reference/v1' as const;

export const KAKAO_COMMISSION_POLICY_2026_10_03 = {
  policyId: 'sales-commission-2026-10-03',
  decisionDate: '2026-10-03',
  evidenceHistory: [{ policyId: 'sales-commission-2026-09-28', observedAt: '2026-09-28T00:09:22.575Z', revision: 'f862d0097f6e83d79d0b699bc369a83716b1d982' }],
  currentAuthority: '2026-10-03 대표 결정 및 commission-research.md ①③④',
  sonokongAdditions: { 12: 100000, 24: 300000, 36: 500000, 48: 700000, 60: 700000 },
  pacificRates: { NEW_PREDELIVERY: { 5: [300, 250], 10: [400, 300] }, NEW_MATCHING: { 5: [300, 300], 10: [330, 330] } },
  sourceRole: 'REPOSITORY_SSOT_WITH_GOOGLE_SHEET_COPY',
  sourceObservedAt: '2026-09-28T00:09:22.575Z',
  canonicalSource: {
    repository: 'freepass-creator/freepasserp4',
    path: 'lib/domain/settlement-fee-table.ts',
    revision: 'f862d0097f6e83d79d0b699bc369a83716b1d982',
  },
  sourceFiles: [
    { code: 'F04', get id() { const id = process.env.FREEPASS_SHEET_F04_ID?.trim(); if (!id) throw new Error('MISSING_SHEET_ID_ENV: FREEPASS_SHEET_F04_ID'); return id; }, sheetId: 1982531660, range: '수수료표!A1:J180', modifiedTime: '2026-09-28T00:09:22.575Z' },
  ],
  standardSupplierIds: [
    'RP013', 'RP031', 'RP016', 'RP015', 'RP019', 'RP020', 'RP032', 'PT-0023',
    'RP017', 'RP011', 'RP021', 'PT-0026', 'RP010', 'RP030', 'PT-0012', 'RP008',
    'PT-0001', 'RP007', 'RP006',
  ],
  exceptionSupplierIds: {
    sonokong: ['RP012'],
    star: ['RP018', 'RP033'],
    autoplus: ['RP023'],
    switchplan: ['RP014'],
    iancar: ['RP004'],
    iron: ['RP006'],
    pacific: ['RP022'],
    excludedMindcar: ['RP034'],
  },
  rules: [
    { id: 'IRON_NEW_PREDELIVERY_BILLING', supplierGroup: 'IRON', product: 'NEW_PREDELIVERY', basis: 'VEHICLE_VALUE', rateBasisPoints: 400, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STAR_RERENT_ONE_MONTH_RENT_BILLING', supplierGroup: 'STAR', product: 'RERENT', basis: 'MONTHLY_RENT', rateBasisPoints: 10000, vatTreatment: 'INCLUDED', coordinationRequired: false },
    { id: 'SONOKONG_SUBSCRIPTION_BILLING_Q12_PLUS_ADDITION', supplierGroup: 'SONOKONG', product: 'SUBSCRIPTION', basis: 'Q12_PLUS_TERM_ADDITION', vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_NEW_PREDELIVERY_BILLING_3_5_PERCENT', supplierGroup: 'STANDARD', product: 'NEW_PREDELIVERY', basis: 'VEHICLE_VALUE', rateBasisPoints: 350, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_NEW_PREDELIVERY_3_PERCENT', supplierGroup: 'STANDARD', product: 'NEW_PREDELIVERY', basis: 'VEHICLE_VALUE', rateBasisPoints: 300, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_NEW_MATCHING_UP_TO_9_PERCENT', supplierGroup: 'STANDARD', product: 'NEW_MATCHING', basis: 'COORDINATION', rateBasisPoints: null, vatTreatment: 'EXCLUDED', coordinationRequired: true },
    { id: 'STANDARD_RERENT_12_FIXED', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 12, basis: 'FIXED', fixedAmount: 500000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_RERENT_24_RENT_X_TERM_X_4_PERCENT', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 24, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 400, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_RERENT_36_RENT_X_TERM_X_3_PERCENT', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 36, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 300, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_RERENT_48_RENT_X_TERM_X_2_5_PERCENT', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 48, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 250, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_RERENT_60_RENT_X_TERM_X_1_75_PERCENT', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 60, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 175, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_RERENT_BILLING_LADDER', supplierGroup: 'STANDARD', product: 'RERENT', basis: 'TERM_LADDER', termRules: [
      { termMonths: 12, basis: 'FIXED', fixedAmount: 600000 },
      { termMonths: 24, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 475 },
      { termMonths: 36, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 375 },
      { termMonths: 48, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 325 },
      { termMonths: 60, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 225 },
    ], vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'SONOKONG_SUBSCRIPTION_12_MONTH_RENT_100_PERCENT', supplierGroup: 'SONOKONG', product: 'SUBSCRIPTION', basis: 'Q12_WITH_EVIDENCE', rateBasisPoints: 10000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STAR_RERENT_ONE_MONTH_RENT_X_80_PERCENT', supplierGroup: 'STAR', product: 'RERENT', basis: 'MONTHLY_RENT', rateBasisPoints: 8000, vatTreatment: 'INCLUDED', coordinationRequired: false },
    { id: 'AUTOPLUS_SUBSCRIPTION_FIXED', supplierGroup: 'AUTOPLUS', product: 'SUBSCRIPTION', basis: 'FIXED', fixedAmount: 800000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'AUTOPLUS_SUBSCRIPTION_BILLING_FIXED', supplierGroup: 'AUTOPLUS', product: 'SUBSCRIPTION', basis: 'FIXED', fixedAmount: 1000000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'SWITCH_SUBSCRIPTION_LADDER', supplierGroup: 'SWITCH', product: 'SUBSCRIPTION', basis: 'TERM_LADDER', vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_RERENT_1_MONTH', supplierGroup: 'IANCAR', product: 'RERENT', termMonths: 1, basis: 'COORDINATION', rateBasisPoints: null, vatTreatment: 'EXCLUDED', coordinationRequired: true },
    { id: 'IANCAR_RERENT_6_MONTH_BILLING_FIXED', supplierGroup: 'IANCAR', product: 'RERENT', termMonths: 6, basis: 'FIXED', fixedAmount: 400000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_RERENT_6_MONTH_FIXED', supplierGroup: 'IANCAR', product: 'RERENT', termMonths: 6, basis: 'FIXED', fixedAmount: 300000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_EV_BILLING_FIXED', supplierGroup: 'IANCAR', product: 'EV', basis: 'FIXED', fixedAmount: 1000000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_EV_FIXED', supplierGroup: 'IANCAR', product: 'EV', basis: 'FIXED', fixedAmount: 800000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'PACIFIC_NEW_PREDELIVERY_DEPOSIT_TIER', supplierGroup: 'PACIFIC', product: 'NEW_PREDELIVERY', basis: 'VEHICLE_VALUE_DEPOSIT_TIER', rateBasisPoints: null, vatTreatment: 'INCLUDED', coordinationRequired: false },
    { id: 'PACIFIC_NEW_MATCHING_DEPOSIT_TIER', supplierGroup: 'PACIFIC', product: 'NEW_MATCHING', basis: 'VEHICLE_VALUE_DEPOSIT_TIER', rateBasisPoints: null, vatTreatment: 'INCLUDED', coordinationRequired: false },
  ],
  timingRules: [
    { supplierGroup: 'STAR_IANCAR', case: 'INSTALLMENT', billingAndPayout: 'AFTER_ALL_INSTALLMENTS_RECEIVED', broken: 'NO_FEE' },
    { supplierGroup: 'OTHERS', case: 'INSTALLMENT', billingAndPayout: 'FULL_ON_DELIVERY', broken: 'PRORATE_BY_RECEIVED_INSTALLMENTS' },
    { supplierGroup: 'ALL', case: 'LUMP_SUM', billingAndPayout: 'FULL_ON_DELIVERY', broken: 'NOT_APPLICABLE' },
    { supplierGroup: 'ALL', case: 'DEPOSIT_INSTALLMENT', billingAndPayout: 'INSTALLMENT_DUE_DATES_FROM_DELIVERY', broken: 'COMPLETE_AFTER_FINAL_DUE_DATE_PLUS_ONE_MONTH' },
  ],
} as const;

/** Previous published rules remain available for historical evidence, never rewritten. */
export const KAKAO_COMMISSION_POLICY_2026_10_04 = {
  ...KAKAO_COMMISSION_POLICY_2026_10_03,
  policyId: 'sales-commission-2026-10-04',
  decisionDate: '2026-10-04',
  currentAuthority: 'F04 수수료표 A1:M191, 2026-10-04 제공 사본 및 사용자 명시 HOLD',
  sourceRole: 'F04_GOOGLE_SHEET_SSOT',
  canonicalSource: { code: 'F04', range: '수수료표!A1:M191', observedDate: '2026-10-04' },
  sourceObservedAt: '2026-10-04',
  sourceFiles: [{ code: 'F04', get id() { const id = process.env.FREEPASS_SHEET_F04_ID?.trim(); if (!id) throw new Error('MISSING_SHEET_ID_ENV: FREEPASS_SHEET_F04_ID'); return id; }, sheetId: 1982531660, range: '수수료표!A1:M191' }],
  evidenceHistory: [...KAKAO_COMMISSION_POLICY_2026_10_03.evidenceHistory,
    { policyId: KAKAO_COMMISSION_POLICY_2026_10_03.policyId, observedAt: '2026-10-03', revision: 'fd252b2508d4ccda5ecf8de03b587c1f9910cda4' }],
  sonokongAdditions: { 12: 100000, 24: 300000, 36: 500000, 48: 700000 },
  rules: [...KAKAO_COMMISSION_POLICY_2026_10_03.rules,
    { id: 'AUTOPLUS_EV_SUBSCRIPTION', sourceRows: [161], billing: 1500000, payout: 1300000 },
    { id: 'SONOKONG_PICKUP_60_RENT_X_TERM', sourceRows: [191], billingBasisPoints: 275, payoutBasisPoints: 200, termMonths: 60 },
    { id: 'BILLIN_SUBSCRIPTION_60', sourceRows: [162], billingBasisPoints: 225, payoutBasisPoints: 175 },
    // 개별 합의(F04 수수료표 160·163행): 금액·대상 계약은 공개 저장소에 두지 않고 비공개 목록에서 입력(individualAgreement)으로 받는다.
    { id: 'INDIVIDUAL_AGREEMENT', sourceRows: [160, 163], amounts: 'PRIVATE_INPUT' },
  ],
} as const;

/**
 * 2026-10-05 AI 상황실 결정(대표 10-05 «정산 확실하게 맞춰놔»):
 * - 손오공 오공 구독 60개월 청구 가산 = +600,000 (F04 수수료표 14행). 지급은 다른 기간과 같이 Q12.
 * - 원 단위: 원 미만 반올림 — calculatedCommission 의 Math.round 그대로.
 * 근거(실제 청구 줄 대조)는 비공개 ai-ops 인수인계(정산-수수료규칙-20261005)에 둔다 — 공개 저장소에는 원장 행·개별 금액을 적지 않는다.
 */
export const KAKAO_COMMISSION_POLICY = {
  ...KAKAO_COMMISSION_POLICY_2026_10_04,
  policyId: 'sales-commission-2026-10-11',
  decisionDate: '2026-10-11',
  rules: [...KAKAO_COMMISSION_POLICY_2026_10_04.rules,
    { id: 'STANDARD_RERENT_1_BILLING_RENT_5_PERCENT', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 1, basis: 'MONTHLY_RENT', rateBasisPoints: 500, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_RERENT_1_PAYOUT_RENT_5_PERCENT', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 1, basis: 'MONTHLY_RENT', rateBasisPoints: 500, vatTreatment: 'EXCLUDED', coordinationRequired: false },
  ],
  oneMonthBasic: { termMonths: 1, monthlyRentBasisPoints: 500, payoutPercentOfBilling: 100, vatTreatment: 'EXCLUDED',
    authority: 'USER_DIRECT_DECISION_2026_10_11', sourceRef: 'USER:2026-10-11:ONE_MONTH_RENT_5_PERCENT_FULL_PAYOUT',
    scope: 'EXISTING_BASIC_TERM_LADDER', supplierAndIndividualExceptionsTakePrecedence: true },
  supplierPolicyAssignments: {
    decisionDate: '2026-10-09',
    authority: 'USER_DIRECT_DECISION',
    basicSupplierIds: ['RP020', 'RP030', 'PT-0001', 'RP016', 'PT-0023', 'RP015', 'RP013', 'RP010'],
    policyKind: 'BASIC',
    policyRef: 'FREEPASS_BASIC',
    subscriptionUsesBasicTermLadder: true,
    unspecifiedNewDeliveryForm: 'REQUIRES_EVIDENCE',
    unspecifiedShortTerms: 'REQUIRES_EVIDENCE',
    billinProposal: { supplierIds: ['RP021', 'PT-0026'], state: 'CONFIRMED', termMonths: 36,
      billingBasis: 'MONTHLY_RENT_AT_36_MONTHS', billingPercent: 100, payoutPercentOfBilling: 80,
      authority: 'USER_DIRECT_DECISION_2026_10_09', appliesTo: 'SUBSCRIPTION',
      historicalSettlementRewrite: false },
  },
  currentAuthority: 'F04 수수료표 A1:M191(2026-10-04 사본) + AI 상황실 2026-10-05 결정(손오공 60개월 +60만, 원 미만 반올림) + 2026-10-09 대표 기본회사 지정 및 빌린카 LC 36개월 월대여료100/80 확정 + 2026-10-11 대표 1개월 월료5% 청구전액지급 VAT별도',
  evidenceHistory: [...KAKAO_COMMISSION_POLICY_2026_10_04.evidenceHistory,
    { policyId: KAKAO_COMMISSION_POLICY_2026_10_04.policyId, observedAt: '2026-10-04', revision: '35de6d9fa96ad07fba2fb2d68a4cb1c9113b61a5' },
    { policyId: 'sales-commission-2026-10-09', observedAt: '2026-10-09', revision: '1e1ea6894def6bebd3abe4d231471f3153ffdfea' }],
  sonokongAdditions: { ...KAKAO_COMMISSION_POLICY_2026_10_04.sonokongAdditions, 60: 600000 },
  sonokong60Evidence: { sourceRows: [14], evidence: 'private:ai-ops/정산-수수료규칙-20261005', decidedBy: 'AI 상황실 2026-10-05' },
  roundingRule: { rule: 'ROUND_HALF_UP_TO_WON', sourceRows: [171], evidence: 'private:ai-ops/정산-수수료규칙-20261005', decidedBy: 'AI 상황실 2026-10-05' },
  /** 뮤카(RP035, 2026-10-05 발급) 구독 — freepass-admin DEC-2026-10-04-01 8번 = F04 수수료표 169·170행. 일반·픽업 공통.
   * 청구(프리패스 몫) = 차량 기준가 × 1%(전 기간). 지급(영업 GA) = 선납/분납 × 기간 정액 + min(추가보증금 × 10%, 40만)(전 기간).
   * 별도 지급 재원 — 청구 − 지급 마진으로 계산하지 않는다. «분납 완납 전 미지급»은 계약 단계의 지급 가능 상태로 따로 다룬다. */
  mewcar: {
    supplierId: 'RP035', sourceRows: [169, 170], billingBasisPoints: 100,
    payout: { PREPAID: { 12: 1000000, 24: 1200000, 36: 1200000, 48: 1200000 }, INSTALLMENT: { 12: 800000, 24: 1000000, 36: 1000000, 48: 1000000 } },
    extraDepositPercent: 10, extraDepositCap: 400000, separateFunding: true,
    /** 2026-10-05 뮤카 조건 변경: 보증금 분납 폐지 + 영업 분납 정액 줄 삭제. 효력일(포함) 이후 계약일의 신규 분납 계약은 계산하지 않고 «확인 필요»로 멈춘다.
     * 그 전 계약(계약일 < 효력일)은 위 INSTALLMENT 옛 정액으로 계산한다. 선납 정액·추가보증금 10%(40만 한도)·프리패스 1% 는 그대로. */
    installmentAbolishedFrom: '2026-10-05',
  },
} as const;

const f04Ref = (row: number) => `F04:수수료표!A${row}:M${row}`;
// Supplier IDs from local supplierChannels and ERP4 origin/main partner-code/cleanup-partners.
const supplierFirstRow: Readonly<Record<string, number>> = {
  RP012: 3, RP013: 15, RP031: 22, RP016: 29, RP015: 36, RP019: 43,
  RP020: 50, RP032: 57, 'PT-0023': 64, RP017: 71, RP011: 78,
  RP021: 85, 'PT-0026': 85, RP010: 92, RP030: 99, 'PT-0012': 99,
  RP008: 106, 'PT-0001': 113, RP007: 113, RP018: 120, RP004: 129,
  RP006: 139, RP022: 146, RP033: 165,
};

type CommissionResolution = {
  sourceRefs?: string[];
  state: CommissionState;
  ruleId: string | null;
  amount: number | null;
  vatTreatment: VatTreatment;
  vatAmount: number | null;
  totalAmount: number | null;
  reasonCode: string | null;
  vehicleValueEvidence?: { grade: 'CONFIRMED' | 'APPROX'; source: 'SUPPLIER_RAW' | 'CONSUMER_PRICE' | 'NEW_CAR_TRIM' };
};

type MarginResolution = {
  state: MarginState;
  amount: number | null;
  currency: 'KRW';
  basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT';
  reasonCode: string | null;
};

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const integer = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  const raw = text(value);
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(raw)) return null;
  const parsed = Number(raw.replaceAll(',', ''));
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const knownProductType = (source: string) => ({
  '신차렌트': 'NEW_RENT', '중고렌트': 'USED_RENT', '재렌트': 'USED_RENT',
  '신차구독': 'NEW_SUBSCRIPTION', '중고구독': 'USED_SUBSCRIPTION', '재구독': 'USED_SUBSCRIPTION',
  '오공구독': 'OGONG_SUBSCRIPTION', '픽업구독': 'PICKUP_SUBSCRIPTION', '오플구독': 'OPLUS_SUBSCRIPTION',
} as const)[source] ?? 'UNKNOWN';

export function resolveReferenceDeposit(input: {
  note: unknown;
  termMonths?: unknown;
  monthlyRent?: unknown;
  sourceAmount: unknown;
  supplierId?: unknown;
  productType?: unknown;
  depositFree?: unknown;
  depositFreeConfirmation?: unknown;
  depositSourceWaiverBasis?: unknown;
  hasPositivePaidDeposit?: boolean;
}) {
  const resolved = resolveDepositWithRuleNote(input);
  if (resolved.state === 'UNKNOWN') {
    return { depositAmount: null, depositState: 'UNKNOWN' as DepositState, depositRule: null };
  }
  if (resolved.state === 'ZERO') {
    return {
      depositAmount: 0,
      depositState: 'ZERO' as DepositState,
      depositRule: resolved.rule,
    };
  }
  return {
    depositAmount: resolved.amount,
    depositState: 'KNOWN' as DepositState,
    depositRule: resolved.rule,
    ...(resolved.depositRuleDifference ? { depositRuleDifference: resolved.depositRuleDifference } : {}),
  };
}

const calculatedCommission = (
  ruleId: string,
  amount: number,
  vatTreatment: VatTreatment,
): CommissionResolution => {
  if (Number.isFinite(amount)) amount = Math.round(amount); // 원 단위 반올림(F04 접수 관행, 아래 VAT 근거와 같음)
  if (!Number.isSafeInteger(amount) || amount < 0) return unknownCommission('COMMISSION_AMOUNT_OUT_OF_RANGE');
  // F04 접수 관행(2026-10-04 확정): VAT 포함 금액 ÷ 1.1 → 원 단위 반올림. 근거(원장 줄)는 비공개 기록.
  const supply = vatTreatment === 'INCLUDED' ? Math.round(amount / 1.1) : amount;
  const vatAmount = vatTreatment === 'INCLUDED' ? amount - supply : Math.round(supply / 10);
  const totalAmount = supply + vatAmount;
  if (!Number.isSafeInteger(totalAmount)) return unknownCommission('COMMISSION_AMOUNT_OUT_OF_RANGE');
  return { state: 'CALCULATED', ruleId, amount: supply, vatTreatment, vatAmount, totalAmount, reasonCode: null };
};

const unknownCommission = (reasonCode: string): CommissionResolution => ({
  state: 'UNKNOWN', ruleId: null, amount: null, vatTreatment: 'UNKNOWN', vatAmount: null, totalAmount: null, reasonCode,
});

const standardLadderSupplier = (supplierId: string) =>
  KAKAO_COMMISSION_POLICY.standardSupplierIds.includes(supplierId as never)
  || KAKAO_COMMISSION_POLICY.exceptionSupplierIds.sonokong.includes(supplierId as 'RP012')
  || KAKAO_COMMISSION_POLICY.exceptionSupplierIds.star.includes(supplierId as 'RP018')
  || KAKAO_COMMISSION_POLICY.exceptionSupplierIds.iancar.includes(supplierId as 'RP004')
  || KAKAO_COMMISSION_POLICY.exceptionSupplierIds.pacific.includes(supplierId as 'RP022');

const resolveTermLadder = (
  termMonths: number,
  monthlyRent: number,
  side: 'BILLING' | 'PAYOUT',
  prefix = 'STANDARD_RERENT',
): CommissionResolution => {
  const fixed = side === 'BILLING' ? 600000 : 500000;
  const ruleId = (term: number, suffix: 'FIXED' | 'RENT_X_TERM') => {
    if (prefix === 'STANDARD_RERENT' && side === 'PAYOUT') {
      return term === 12 ? 'STANDARD_RERENT_12_FIXED' : `STANDARD_RERENT_${term}_RENT_X_TERM`;
    }
    return `${prefix}_${term}_${side}_${suffix}`;
  };
  if (prefix === 'STANDARD_RERENT' && termMonths === KAKAO_COMMISSION_POLICY.oneMonthBasic.termMonths) {
    return calculatedCommission(`STANDARD_RERENT_1_${side}_RENT_5_PERCENT`,
      monthlyRent * KAKAO_COMMISSION_POLICY.oneMonthBasic.monthlyRentBasisPoints / 10000, 'EXCLUDED');
  }
  if (termMonths === 12) return calculatedCommission(ruleId(12, 'FIXED'), fixed, 'EXCLUDED');
  const rates = side === 'BILLING'
    ? new Map([[24, 475], [36, 375], [48, 325], [60, 225]])
    : new Map([[24, 400], [36, 300], [48, 250], [60, 175]]);
  const basisPoints = rates.get(termMonths);
  if (!basisPoints) return unknownCommission('TERM_NOT_IN_F04_COMMISSION_POLICY');
  return calculatedCommission(
    ruleId(termMonths, 'RENT_X_TERM'),
    monthlyRent * termMonths * basisPoints / 10000,
    'EXCLUDED',
  );
};

export type CommissionInput = {
  supplierId: string;
  productType: string;
  fuel?: string;
  termMonths: number;
  monthlyRent: number;
  vehicleValue?: number;
  /** Same product and pricing variant: 36-month monthly rental amount, not total rent. */
  billin36MonthlyRent?: number | undefined;
  newProductSubtype?: 'NEW_PREDELIVERY' | 'NEW_MATCHING';
  /** Explicit contractual tier, never inferred from a deposit amount. */
  depositTierPercent?: 5 | 10;
  subscriptionForm?: 'BUYOUT' | 'RETURN';
  q12Basis?: { amount: number; sourceRef: string };
  /** 뮤카: 보증금 선납/분납(접수 납입 방식). 추정하지 않는다. */
  depositPayment?: 'PREPAID' | 'INSTALLMENT';
  /** 계약일(YYYY-MM-DD). 뮤카 분납은 계약일이 정책 효력일(2026-10-05) 전이냐 후냐로 갈린다 — 모르면 분납을 계산하지 않는다. */
  contractDate?: string;
  /** 뮤카: 추가보증금(원, 없으면 0 을 명시). 모르면 넣지 않는다 — 계산하지 않는다. */
  extraDeposit?: number;
  /** A suspected individual promotion must not silently use the general rule. */
  individualException?: boolean;
  /** Legacy private input name. Its shape is intentionally unsupported; callers must migrate to individualAgreement. */
  individualExceptionEvidence?: unknown;
  /**
   * 개별 합의(F04 수수료표 160·163행 유형). 신뢰된 비공개 호출자가 비공개 목록(ai-ops 인수인계)의 합의를 이 계약에 묶어 넘긴다 —
   * 금액·대상 계약은 공개 저장소에 두지 않는다. HTTP 등 신뢰할 수 없는 입력으로 받지 않는다.
   * status: APPROVED = 청구·지급 모두 합의 금액, PAYOUT_CONFIRMED = 지급만(청구는 미확정), UNCONFIRMED = 둘 다 미확정.
   * 금액은 공급가(VAT 별도) 원 단위 정수, 미확정이면 null.
   */
  individualAgreement?: {
    agreementId: string;
    sourceRow: 160 | 163;
    status: 'APPROVED' | 'PAYOUT_CONFIRMED' | 'UNCONFIRMED';
    contractRef: string;
    matchedContractRef: string;
    billing: number | null;
    payout: number | null;
  };
};

/** YYYY-MM-DD 가 «달력에 실제로 있는 날»인지(Date.parse 는 2026-02-30 을 03-02 로 보정하므로 연·월·일을 되확인한다). */
type SonokongQ12BasisCandidate = {
  termMonths: number;
  settlement?: 'BUYOUT' | 'RETURN' | undefined;
  mileageKm?: number | null | undefined;
  mileagePeriod?: 'month' | 'year' | undefined;
  currency: string;
  amount: number;
  sourceRef: string;
};

export function selectSonokongQ12Basis(target: SonokongQ12BasisCandidate, candidates: readonly SonokongQ12BasisCandidate[]): CommissionInput['q12Basis'] | undefined {
  const matching = candidates.filter(candidate => candidate.termMonths === 12 &&
    candidate.settlement === target.settlement &&
    candidate.mileageKm === target.mileageKm &&
    (candidate.mileagePeriod ?? 'year') === (target.mileagePeriod ?? 'year') &&
    candidate.currency === target.currency &&
    Number.isSafeInteger(candidate.amount) && candidate.amount > 0);
  return matching.length === 1 ? { amount: matching[0]!.amount, sourceRef: matching[0]!.sourceRef } : undefined;
}

function isCalendarDate(value: unknown): boolean {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** 뮤카 구독(RP035). 사유 코드는 모두 MEWCAR_ 로 시작한다 — 마진 계산이 이 표시로 별도 재원임을 안다. */
function resolveMewcar(input: CommissionInput, productType: string, side: 'BILLING' | 'PAYOUT'): CommissionResolution {
  const rule = KAKAO_COMMISSION_POLICY.mewcar;
  if (!/구독/.test(productType)) return unknownCommission('MEWCAR_SUBSCRIPTION_ONLY');
  const term = input.termMonths as 12 | 24 | 36 | 48;
  if (![12, 24, 36, 48].includes(term)) return unknownCommission('MEWCAR_TERM_NOT_IN_POLICY');
  if (side === 'BILLING') {
    if (!Number.isSafeInteger(input.vehicleValue) || input.vehicleValue! <= 0) return unknownCommission('MEWCAR_BASE_PRICE_REQUIRED');
    return calculatedCommission('MEWCAR_FREEPASS_SHARE_BILLING', input.vehicleValue! * rule.billingBasisPoints / 10000, 'EXCLUDED');
  }
  if (input.depositPayment !== 'PREPAID' && input.depositPayment !== 'INSTALLMENT') return unknownCommission('MEWCAR_DEPOSIT_PAYMENT_REQUIRED');
  if (input.depositPayment === 'INSTALLMENT') {
    // 분납은 10-05 이후 폐지 — 계약일을 모르면 어느 규칙인지 모르므로 멈추고, 효력일 이후면 «확인 필요»로 멈춘다(옛 정액을 내지 않는다).
    if (!isCalendarDate(input.contractDate)) return unknownCommission('MEWCAR_CONTRACT_DATE_REQUIRED');
    if (input.contractDate! >= rule.installmentAbolishedFrom) return unknownCommission('MEWCAR_INSTALLMENT_ABOLISHED_CONFIRM_REQUIRED');
  }
  if (!Number.isSafeInteger(input.extraDeposit) || input.extraDeposit! < 0) return unknownCommission('MEWCAR_EXTRA_DEPOSIT_REQUIRED');
  const addition = Math.min(Math.round(input.extraDeposit! * rule.extraDepositPercent / 100), rule.extraDepositCap);
  return calculatedCommission(`MEWCAR_GA_${input.depositPayment}_${term}_PAYOUT`, rule.payout[input.depositPayment][term] + addition, 'EXCLUDED');
}

function resolveCommissionAmount(input: CommissionInput, side: 'BILLING' | 'PAYOUT'): CommissionResolution {
  const { supplierId, termMonths, monthlyRent } = input;
  const rawProduct = input.productType.trim();
  const inferredSubtype = rawProduct === '견적출고' ? 'NEW_MATCHING' : rawProduct === '선출고' ? 'NEW_PREDELIVERY' : undefined;
  if (inferredSubtype && input.newProductSubtype && inferredSubtype !== input.newProductSubtype) return unknownCommission('CONFLICTING_NEW_PRODUCT_SUBTYPE');
  if (inferredSubtype && !input.newProductSubtype) input = { ...input, newProductSubtype: inferredSubtype };
  const productType = inferredSubtype ? '신차렌트' : rawProduct === '장기렌트' ? '재렌트' : rawProduct;
  const billing = side === 'BILLING';
  const fixed = (id: string, amount: number, vat: VatTreatment = 'EXCLUDED') => calculatedCommission(id, amount, vat);
  const agreement = input.individualAgreement;
  const hasAgreement = agreement !== undefined;
  if (!hasAgreement && input.individualExceptionEvidence !== undefined) {
    return unknownCommission('LEGACY_INDIVIDUAL_EXCEPTION_INPUT');
  }
  if (supplierId === 'RP034') return { ...unknownCommission('SUPPLIER_EXCLUDED_BY_DECISION'), state: 'NOT_APPLICABLE' };
  if (!Number.isSafeInteger(termMonths) || termMonths < 1 || !Number.isSafeInteger(monthlyRent) || monthlyRent < 0) return unknownCommission('INVALID_PRICE_TERM_INPUT');
  if (hasAgreement && (!agreement || typeof agreement !== 'object' || Array.isArray(agreement))) return unknownCommission('INDIVIDUAL_AGREEMENT_INVALID');
  if (input.individualException || hasAgreement) {
    if (!agreement || !/^opaque:[a-zA-Z0-9_-]{16,}$/.test(agreement.contractRef) || agreement.contractRef !== agreement.matchedContractRef
      || !/^private:[a-zA-Z0-9_-]{4,}$/.test(agreement.agreementId) || ![160, 163].includes(agreement.sourceRow)) return unknownCommission('INDIVIDUAL_EXCEPTION_EVIDENCE_REQUIRED');
    const allowed = agreement.status === 'APPROVED' || (agreement.status === 'PAYOUT_CONFIRMED' && !billing);
    const amount = billing ? agreement.billing : agreement.payout;
    if (!allowed || amount === null) return unknownCommission(billing ? 'INDIVIDUAL_BILLING_BASIS_UNCONFIRMED' : 'INDIVIDUAL_PAYOUT_BASIS_UNCONFIRMED');
    if (!Number.isSafeInteger(amount) || amount < 0) return unknownCommission('INDIVIDUAL_AGREEMENT_AMOUNT_INVALID');
    return fixed(`INDIVIDUAL_AGREEMENT_${side}`, amount);
  }
  // 뮤카는 개별 예외 검사 뒤에 — 개별 표시가 있는 계약에 일반 정액을 내지 않는다.
  if (supplierId === KAKAO_COMMISSION_POLICY.mewcar.supplierId) return resolveMewcar(input, productType, side);
  const rerent = /^(중고렌트|재렌트)$/.test(productType);
  const subscription = /구독/.test(productType);
  if (supplierId === 'RP013' && /발주/.test(productType)) return unknownCommission('WELRIX_ORDER_RULE_UNCONFIRMED');
  if (supplierId === 'RP012' && /^픽업\s*구독(?:\(롯데T카\))?$/.test(productType)) {
    if (termMonths !== 60) return unknownCommission('PICKUP_TERM_RATE_NOT_IN_TABLE');
    return fixed(`SONOKONG_PICKUP_60_${side}_RENT_X_TERM`, monthlyRent * termMonths * (billing ? 275 : 200) / 10000);
  }
  if (['RP021', 'PT-0026'].includes(supplierId) && subscription) {
    const basis = input.billin36MonthlyRent ?? (termMonths === 36 ? monthlyRent : undefined);
    if (!Number.isSafeInteger(basis) || basis! <= 0) return unknownCommission('BILLIN_36_MONTH_RENT_REQUIRED');
    if (termMonths === 36 && basis !== monthlyRent) return unknownCommission('BILLIN_36_MONTH_RENT_CONFLICT');
    return fixed(`BILLIN_SUBSCRIPTION_36_RENT_${side}`, basis! * (billing ? 1 : 0.8));
  }
  if (supplierId === 'RP012' && subscription) {
    const addition = KAKAO_COMMISSION_POLICY.sonokongAdditions[termMonths as 12];
    if (addition === undefined) return unknownCommission('TERM_NOT_IN_F04_COMMISSION_POLICY');
    if (!input.q12Basis || !Number.isSafeInteger(input.q12Basis.amount) || input.q12Basis.amount <= 0 || !text(input.q12Basis.sourceRef)) return unknownCommission('Q12_BASIS_REQUIRED');
    if (termMonths === 12) return fixed(`SONOKONG_SUBSCRIPTION_${termMonths}_${side}`, input.q12Basis.amount + (billing ? addition : 0));
    if (input.subscriptionForm === 'RETURN') return unknownCommission('RETURN_SUBSCRIPTION_TERM_NOT_SUPPORTED');
    if (input.subscriptionForm !== 'BUYOUT' && input.subscriptionForm !== 'RETURN') return unknownCommission('SUBSCRIPTION_FORM_REQUIRED');
    return fixed(`SONOKONG_SUBSCRIPTION_${termMonths}_${side}`, input.q12Basis.amount + (billing ? addition : 0));
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.star.includes(supplierId as 'RP018') && rerent) {
    return fixed(billing ? 'STAR_RERENT_ONE_MONTH_RENT_BILLING' : 'STAR_RERENT_ONE_MONTH_RENT_X_80_PERCENT', monthlyRent * (billing ? 1 : 0.8), 'INCLUDED');
  }
  // F04 161행 계약기간 「기간 무관」(123행 일반 구독과 같음): 기간 검증 없이 정액.
  if (supplierId === 'RP023' && subscription && /전기/.test(input.fuel ?? '')) return fixed(`AUTOPLUS_EV_SUBSCRIPTION_${side}`, billing ? 1500000 : 1300000);
  if (supplierId === 'RP023' && subscription && !text(input.fuel)) return unknownCommission('FUEL_REQUIRED_FOR_SUPPLIER_RULE');
  if (supplierId === 'RP023' && subscription) return fixed(billing ? 'AUTOPLUS_SUBSCRIPTION_BILLING_FIXED' : 'AUTOPLUS_SUBSCRIPTION_FIXED', billing ? 1000000 : 800000);
  if (supplierId === 'RP014' && subscription) return resolveTermLadder(termMonths, monthlyRent, side, 'SWITCH_SUBSCRIPTION');
  if (supplierId === 'RP004') {
    if (!subscription && (rerent || input.newProductSubtype === 'NEW_PREDELIVERY') && !text(input.fuel)) return unknownCommission('FUEL_REQUIRED_FOR_SUPPLIER_RULE');
    if (!subscription && (rerent || (productType === '신차렌트' && input.newProductSubtype === 'NEW_PREDELIVERY')) && /전기/.test(input.fuel ?? '')) return fixed(billing ? 'IANCAR_EV_BILLING_FIXED' : 'IANCAR_EV_FIXED', billing ? 1000000 : 800000);
    if (rerent && termMonths === 6) return fixed(billing ? 'IANCAR_RERENT_6_MONTH_BILLING_FIXED' : 'IANCAR_RERENT_6_MONTH_FIXED', billing ? 400000 : 300000);
    if (rerent && termMonths === 1) return unknownCommission('IANCAR_SHORT_TERM_BASIS_REQUIRED');
  }
  if (!standardLadderSupplier(supplierId)) return unknownCommission('SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE');
  if (subscription && KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.basicSupplierIds.some(id => id === supplierId)) {
    return resolveTermLadder(termMonths, monthlyRent, side);
  }
  if (rerent) return resolveTermLadder(termMonths, monthlyRent, side);
  if (/^신차/.test(productType) && !subscription) {
    if (supplierId === 'RP022' && input.depositTierPercent !== 5 && input.depositTierPercent !== 10) return unknownCommission('DEPOSIT_TIER_REQUIRED');
    const subtype = input.newProductSubtype;
    if (subtype !== 'NEW_PREDELIVERY' && subtype !== 'NEW_MATCHING') return unknownCommission('NEW_PRODUCT_SUBTYPE_REQUIRED');
    if (!Number.isSafeInteger(input.vehicleValue) || input.vehicleValue! <= 0) return unknownCommission('VEHICLE_VALUE_REQUIRED');
    if (supplierId === 'RP022') {
      const rates = KAKAO_COMMISSION_POLICY.pacificRates[subtype][input.depositTierPercent!];
      return fixed(`PACIFIC_${subtype}_${input.depositTierPercent}_${side}`, input.vehicleValue! * rates[billing ? 0 : 1] / 10000, 'INCLUDED');
    }
    if (subtype === 'NEW_MATCHING') return unknownCommission('MATCHING_AGREED_RATE_REQUIRED');
    return fixed(`${supplierId === 'RP006' ? 'IRON' : 'STANDARD'}_NEW_PREDELIVERY_${side}`, input.vehicleValue! * (billing ? supplierId === 'RP006' ? 400 : 350 : 300) / 10000);
  }
  return unknownCommission(subscription ? 'SUBSCRIPTION_RULE_SCOPE_UNCONFIRMED' : 'NO_MATCHING_RULE');
}

function resolveCommission(input: CommissionInput, side: 'BILLING' | 'PAYOUT'): CommissionResolution {
  const result = resolveCommissionAmount(input, side);
  const id = result.ruleId ?? '';
  const product = input.productType.trim();
  const first = supplierFirstRow[input.supplierId];
  let rows: number[] = [];
  if (input.individualException || input.individualAgreement || input.individualExceptionEvidence !== undefined) rows = input.individualAgreement ? [input.individualAgreement.sourceRow] : [160, 163];
  else if (input.supplierId === 'RP034') rows = [168];
  else if (input.supplierId === KAKAO_COMMISSION_POLICY.mewcar.supplierId) rows = [...KAKAO_COMMISSION_POLICY.mewcar.sourceRows];
  else if (input.supplierId === 'RP012' && /^픽업\s*구독/.test(product)) rows = input.termMonths === 60 ? [191] : [];
  else if (input.supplierId === 'RP012' && /구독/.test(product)) rows = [({12:10,24:11,36:12,48:13,60:14} as Record<number, number>)[input.termMonths] ?? 183, 173, 191];
  else if (input.supplierId === 'RP023' && /구독/.test(product)) rows = /전기/.test(input.fuel ?? '') ? [161] : [123, 161];
  else if (['RP021', 'PT-0026'].includes(input.supplierId) && /구독/.test(product)) rows = [162];
  else if (input.supplierId === 'RP014') rows = /구독/.test(product) ? ([12,24,36,48,60].includes(input.termMonths) ? [124 + [12,24,36,48,60].indexOf(input.termMonths)] : [183,184,185,186,187,188,189]) : [175,176];
  else if (/구독/.test(product) && first && KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.basicSupplierIds.some(supplierId => supplierId === input.supplierId)) {
    const index = [12,24,36,48,60].indexOf(input.termMonths);
    rows = index >= 0 ? [first + 2 + index] : [183,184,185,186,187,188,189];
  }
  else if (input.supplierId === 'RP013' && /구독|발주/.test(product)) rows = /구독/.test(product) ? [174] : [164];
  else if (id.startsWith('IANCAR_EV')) rows = [138];
  else if (id.startsWith('IANCAR_RERENT_6')) rows = [132];
  else if (result.reasonCode === 'IANCAR_SHORT_TERM_BASIS_REQUIRED') rows = [131];
  else if (first) {
    if (/신차|선출고|견적출고/.test(product) && !/구독/.test(product)) rows = [first + (input.newProductSubtype === 'NEW_MATCHING' || product === '견적출고' ? 1 : 0)];
    else if (['RP018','RP033'].includes(input.supplierId)) rows = [first + 2];
    else { const offset = [12,24,36,48,60].indexOf(input.termMonths); rows = offset < 0 ? [183,184,185,186,187,188,189] : [first + (input.supplierId === 'RP004' ? 4 : 2) + offset]; }
  } else rows = [177,178,179,180,181,182];
  if (result.reasonCode === 'WON_ROUNDING_POLICY_UNCONFIRMED') rows.push(171);
  if (result.reasonCode === 'DEPOSIT_TIER_REQUIRED') rows.push(172);
  // 근거 행은 계산된 결과에만 단다. UNKNOWN·NOT_APPLICABLE·협의는 reasonCode만 — 미등록 공급사가 「근거 있는 규칙」처럼 보이지 않게.
  if (result.state !== 'CALCULATED') return result;
  if (id.startsWith('STANDARD_RERENT_1_')) return { ...result, sourceRefs: [KAKAO_COMMISSION_POLICY.oneMonthBasic.sourceRef] };
  if (id.startsWith('BILLIN_SUBSCRIPTION_36_RENT')) return { ...result, sourceRefs: ['USER:2026-10-09:BILLIN_LC_36_MONTH_RENT_100_80'] };
  return { ...result, sourceRefs: [...new Set(rows)].map(f04Ref) };
}

export function resolveSalesCommission(input: CommissionInput): CommissionResolution {
  return resolveCommission(input, 'PAYOUT');
}

export function resolveSupplierBillingFee(input: CommissionInput): CommissionResolution {
  return resolveCommission(input, 'BILLING');
}

export function resolveExpectedGrossMargin(
  supplierBillingFee: CommissionResolution,
  channelPayoutFee: CommissionResolution,
): MarginResolution {
  // 뮤카: 프리패스 몫과 영업 GA 지급은 재원이 따로라 청구 − 지급 마진을 만들지 않는다(F04 169·170행).
  if ([supplierBillingFee, channelPayoutFee].some(r => r.ruleId?.startsWith('MEWCAR_') || r.reasonCode?.startsWith('MEWCAR_'))) {
    return {
      state: 'NOT_APPLICABLE', amount: null, currency: 'KRW',
      basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: 'SEPARATE_FUNDING_NO_MARGIN',
    };
  }
  if (supplierBillingFee.state === 'NOT_APPLICABLE' && channelPayoutFee.state === 'NOT_APPLICABLE') {
    return {
      state: 'NOT_APPLICABLE', amount: null, currency: 'KRW',
      basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: 'NO_COMMISSION_APPLICABLE',
    };
  }
  if (
    supplierBillingFee.state !== 'CALCULATED' || supplierBillingFee.amount === null ||
    channelPayoutFee.state !== 'CALCULATED' || channelPayoutFee.amount === null
  ) {
    return {
      state: 'UNKNOWN', amount: null, currency: 'KRW',
      basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: 'BILLING_OR_PAYOUT_UNRESOLVED',
    };
  }
  const amount = supplierBillingFee.amount - channelPayoutFee.amount;
  if (!Number.isSafeInteger(amount)) {
    return {
      state: 'UNKNOWN', amount: null, currency: 'KRW',
      basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: 'MARGIN_OUT_OF_RANGE',
    };
  }
  return {
    state: 'CALCULATED', amount, currency: 'KRW',
    basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: null,
  };
}

const assetStatus = (value: unknown) => ({
  '즉시출고': 'AVAILABLE', '출고가능': 'AVAILABLE', '가용': 'AVAILABLE',
  '계약중': 'RESERVED', '점검중': 'MAINTENANCE',
} as const)[text(value)] ?? null;

export type CommissionEvidenceByTerm = Readonly<Record<string, Partial<Pick<CommissionInput,
  'vehicleValue' | 'newProductSubtype' | 'depositTierPercent' | 'subscriptionForm' | 'q12Basis' | 'individualException' | 'individualAgreement' | 'individualExceptionEvidence'>>>>;

export function resolveReferencePolicyContext(source: Rec, policies: Record<string, Rec> = {}) {
  const policyId = text(source.policy_code) || null;
  const matches = policyId ? Object.entries(policies).filter(([id, policy]) =>
    id === policyId || text(policy.policy_code) === policyId) : [];
  const candidates = matches.map(([id, policy]) => ({ id, policy, policyCode: policyId!,
    ...(text(policy.provider_company_code) ? { companyId: text(policy.provider_company_code) } : {}) }));
  const link = selectErp5Policy(candidates, policyId ?? '', text(source.provider_company_code) || undefined);
  const reasonCode = !policyId ? 'POLICY_LINK_MISSING' : link.kind === 'NOT_FOUND' ? 'POLICY_NOT_FOUND'
    : link.kind === 'AMBIGUOUS' ? 'POLICY_LINK_AMBIGUOUS' : link.kind === 'COMPANY_MISMATCH' ? 'POLICY_SUPPLIER_MISMATCH' : null;
  const empty = (reason: string) => ({ state: 'UNKNOWN' as const, policyId, policyCode: null, policyName: null,
    policyCodeSourceRef: null, policyNameSourceRef: null, sourceRef: null,
    facts: [] as Array<{ key: string; label: string; value: NonNullable<ReturnType<typeof policyScalar>>; sourceRef: string }>, reasonCode: reason });
  if (reasonCode) return empty(reasonCode);
  if (link.kind !== 'MATCH') return empty('POLICY_NOT_FOUND');
  const { id, policy } = candidates.find(candidate => candidate === link.policy)!;
  const values = policy.facts && typeof policy.facts === 'object' && !Array.isArray(policy.facts) ? policy.facts as Rec : policy;
  const allowed = new Map(CONDITION_DIMENSION_SPECS.flatMap(spec => spec.sourcePolicyKeys.map(key => [key, spec.label] as const)));
  const sourceRef = `policy/${id}`;
  const facts = [...allowed].flatMap(([key, label]) => {
    const value = policyScalar(values[key]);
    return value === undefined || value === '' || (Array.isArray(value) && !value.length) ? []
      : [{ key, label, value, sourceRef: `${sourceRef}/${key}` }];
  });
  // Raw allowed facts only: availability is not policy verification or eligibility approval.
  return { state: facts.length ? 'REFERENCE' as const : 'UNKNOWN' as const, policyId,
    policyCode: text(policy.policy_code) || null, policyName: text(policy.policy_name) || null, sourceRef, facts,
    policyCodeSourceRef: text(policy.policy_code) ? `${sourceRef}/policy_code` : null,
    policyNameSourceRef: text(policy.policy_name) ? `${sourceRef}/policy_name` : null,
    reasonCode: facts.length ? null : 'POLICY_FACTS_MISSING' };
}

export type ReferenceSourceScope = 'LISTABLE' | 'COLLECTED';
export function buildKakaoCatalogReferenceProduct(documentId: string, source: Rec, evidenceByTerm: CommissionEvidenceByTerm = {}, policies: Record<string, Rec> = {}, observedAt?: string, sourceScope: ReferenceSourceScope = 'LISTABLE', rawVehicleValueEvidence: VehicleValueEvidence | null = null) {
  const collected = sourceScope === 'COLLECTED';
  if (!collected && source.listable !== true) return null;
  const supplierId = text(source.provider_company_code);
  if (!collected && !supplierId) return null;
  const price = source.price && typeof source.price === 'object' && !Array.isArray(source.price) ? source.price as Rec : {};
  if (!collected && !Object.keys(price).length) return null;
  const priceTerms = Object.entries(price as Rec).flatMap(([sourceKey, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const parsed = parseErp5CompatibilityPriceKey(sourceKey);
    const monthlyRent = integer((raw as Rec).rent);
    if (!parsed || monthlyRent === null || monthlyRent <= 0) return [];
    const basis36 = Object.entries(price as Rec).flatMap(([key, value]) => {
      const candidate = parseErp5CompatibilityPriceKey(key);
      if (!candidate || candidate.months !== 36 || candidate.settlement !== parsed.settlement || (candidate.contractedMileage?.km ?? candidate.mileageKm) !== (parsed.contractedMileage?.km ?? parsed.mileageKm) || (candidate.contractedMileage?.period ?? 'year') !== (parsed.contractedMileage?.period ?? 'year') || !value || typeof value !== 'object' || Array.isArray(value)) return [];
      const amount = integer((value as Rec).rent);
      return amount !== null && amount > 0 ? [amount] : [];
    });
    const billin36MonthlyRent = basis36.length === 1 ? basis36[0] : undefined;
    const q12Candidates = Object.entries(price as Rec).flatMap(([key, value]) => {
      const candidate = parseErp5CompatibilityPriceKey(key);
      if (!candidate || candidate.months !== 12 || !value || typeof value !== 'object' || Array.isArray(value)) return [];
      const amount = integer((value as Rec).rent);
      return amount !== null && amount > 0 ? [{
        termMonths: candidate.months,
        settlement: candidate.settlement,
        mileageKm: candidate.contractedMileage?.km ?? candidate.mileageKm,
        mileagePeriod: candidate.contractedMileage?.period ?? 'year',
        currency: 'KRW',
        amount,
        sourceRef: 'PRODUCT_12_MONTH_RENT',
      }] : [];
    });
    const automaticQ12 = selectSonokongQ12Basis({
      termMonths: parsed.months,
      settlement: parsed.settlement,
      mileageKm: parsed.contractedMileage?.km ?? parsed.mileageKm,
      mileagePeriod: parsed.contractedMileage?.period ?? 'year',
      currency: 'KRW',
      amount: monthlyRent,
      sourceRef: `source-product:${documentId}#price:${sourceKey}`,
    }, q12Candidates);
    const subscriptionForm = parsed.months === 12 ? undefined : parsed.settlement;
    const automaticCommissionEvidence = {
      ...(supplierId === 'RP012' && text(source.product_type)?.replace(/\s+/g, '').includes('오공구독') && automaticQ12 && !evidenceByTerm[sourceKey]?.q12Basis ? { q12Basis: automaticQ12 } : {}),
      ...(supplierId === 'RP012' && text(source.product_type)?.replace(/\s+/g, '').includes('오공구독') && subscriptionForm ? { subscriptionForm } : {}),
    } satisfies Partial<Pick<CommissionInput, 'q12Basis' | 'subscriptionForm'>>;
    const depositInput = depositEvidenceInputFromProduct(source, (raw as Rec).deposit, {
      termMonths: parsed.months,
      monthlyRent,
      hasPositivePaidDeposit: hasConflictingPaidDeposit(price),
    });
    const publishedDeposit = supplierId === 'RP031' && source.iancar_phase_one
      ? readIancarPublishedDeposit(source, sourceKey, observedAt, { preserveStalePositiveReference: true }) : null;
    const deposit = publishedDeposit ? {
      depositAmount: publishedDeposit.amount,
      depositState: publishedDeposit.state,
      depositRule: publishedDeposit.state === 'UNKNOWN' ? null : {
        code: publishedDeposit.reason, multiplier: null,
        label: publishedDeposit.reason === 'SOURCE_AMOUNT' ? '공급사 입력 금액' : '공급사 기간·주행거리 조건',
      },
      ...('depositRuleDifference' in publishedDeposit && publishedDeposit.depositRuleDifference
        ? { depositRuleDifference: publishedDeposit.depositRuleDifference } : {}),
    } : resolveReferenceDeposit(depositInput);
    const depositEvidence = {
      sourceRef: `source-product:${documentId}#price:${sourceKey}`,
      sourceAmount: typeof (raw as Rec).deposit === 'number' || typeof (raw as Rec).deposit === 'string' ? (raw as Rec).deposit as number | string : null,
      sourceNote: text(source.deposit_note) || null,
      reasonCode: publishedDeposit?.reason ?? deposit.depositRule?.code ?? assessDepositEvidence(depositInput).reason,
      ...(publishedDeposit && 'publicationEvidenceReason' in publishedDeposit ? {
        publicationEvidenceReason: publishedDeposit.publicationEvidenceReason,
        publicationDecision: publishedDeposit.publicationDecision,
      } : {}),
    };
    const vehicleValueEvidence = publicVehicleValueEvidence(evidenceByTerm[sourceKey]?.vehicleValue ? rawVehicleValueEvidence : null);
    const withVehicleValueEvidence = (fee: CommissionResolution) => ({
      ...fee,
      ...(fee.state === 'CALCULATED' && vehicleValueEvidence?.grade === 'APPROX' ? { state: 'CALCULATED_APPROX' as const } : {}),
      ...(fee.state === 'CALCULATED' && vehicleValueEvidence ? { vehicleValueEvidence } : {}),
    });
    const channelPayoutFee = withVehicleValueEvidence(resolveSalesCommission({
      ...automaticCommissionEvidence,
      ...evidenceByTerm[sourceKey],
      supplierId,
      productType: text(source.product_type),
      fuel: text(source.fuel_type),
      termMonths: parsed.months,
      monthlyRent,
      billin36MonthlyRent,
    }));
    const supplierBillingFee = withVehicleValueEvidence(resolveSupplierBillingFee({
      ...automaticCommissionEvidence,
      ...evidenceByTerm[sourceKey],
      supplierId,
      productType: text(source.product_type),
      fuel: text(source.fuel_type),
      termMonths: parsed.months,
      monthlyRent,
      billin36MonthlyRent,
    }));
    const expectedGrossMargin = resolveExpectedGrossMargin(supplierBillingFee, channelPayoutFee);
    return [{
      termKey: `source:${sourceKey}`,
      termMonths: parsed.months,
      monthlyRent: { amount: monthlyRent, currency: 'KRW' as const },
      deposit: deposit.depositAmount === null ? null : { amount: deposit.depositAmount, currency: 'KRW' as const },
      ...deposit,
      ...('depositRuleDifference' in deposit && deposit.depositRuleDifference ? { depositRuleDifference: deposit.depositRuleDifference } : {}),
      depositEvidence,
      depositStatusLabel: depositStatusLabel(deposit.depositState, (raw as Rec).deposit, source.deposit_note),
      mileageLimitKmPerYear: parsed.mileageKm ?? null,
      ...(parsed.contractedMileage ? { contractedMileage: parsed.contractedMileage } : {}),
      settlement: parsed.settlement,
      // Backward-compatible alias for the existing Kakao consumer.
      salesCommission: channelPayoutFee,
      supplierBillingFee,
      channelPayoutFee,
      expectedGrossMargin,
    }];
  }).sort((a, b) => a.termMonths - b.termMonths || a.termKey.localeCompare(b.termKey));
  if (!collected && !priceTerms.length) return null;
  const sourceRecord = collected ? {
    scope: 'COLLECTED' as const, publicationDecision: 'HOLD' as const,
    listable: typeof source.listable === 'boolean' ? source.listable : null,
    status: text(source.status_kind) || text(source.vehicle_status) || text(source.status) || null,
    deleted: source._deleted === true || !!source.deletedAt || !!source.publication_withdrawal,
    supplierId: supplierId || null, supplierName: text(source.provider_name) || null,
    sourceRef: `source-product:${documentId}`,
    conditionState: (!supplierId || !priceTerms.length || priceTerms.length !== Object.keys(price).length ? 'HOLD' : 'REFERENCE') as 'HOLD' | 'REFERENCE',
    reasonCode: !supplierId ? 'SOURCE_SUPPLIER_MISSING' : !Object.keys(price).length ? 'SOURCE_PRICE_CONDITIONS_MISSING'
      : !priceTerms.length ? 'SOURCE_PRICE_CONDITIONS_UNUSABLE' : priceTerms.length !== Object.keys(price).length ? 'SOURCE_PRICE_CONDITIONS_PARTIAL' : null,
    priceConditions: Object.entries(price).map(([key, value]) => {
      const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : {};
      const parsed = parseErp5CompatibilityPriceKey(key);
      const term = priceTerms.find(candidate => candidate.termKey === `source:${key}`);
      const original = (v: unknown) => typeof v === 'string' || typeof v === 'number' && Number.isFinite(v) ? v as string | number : null;
      return { sourceKey: key, sourceRef: `source-product:${documentId}#price:${key}`, termMonths: parsed?.months ?? null,
        monthlyRentSourceValue: original(raw.rent), depositSourceValue: original(raw.deposit),
        contractedMileage: parsed?.contractedMileage ?? (parsed?.mileageKm ? { km: parsed.mileageKm, period: 'year' as const } : null),
        monthlyRentAmount: term?.monthlyRent.amount ?? null, monthlyRentState: (term ? 'KNOWN' : 'UNKNOWN') as 'KNOWN' | 'UNKNOWN',
        depositAmount: term?.depositAmount ?? null, depositState: term?.depositState ?? 'UNKNOWN' as const,
        supplierBillingFee: term && supplierId ? term.supplierBillingFee : unknownCommission('SOURCE_PRICE_CONDITION_UNUSABLE'),
        channelPayoutFee: term && supplierId ? term.channelPayoutFee : unknownCommission('SOURCE_PRICE_CONDITION_UNUSABLE'),
        state: (term && supplierId ? 'REFERENCE' : 'HOLD') as 'REFERENCE' | 'HOLD',
        reasonCode: !supplierId ? 'SOURCE_SUPPLIER_MISSING' : !parsed ? 'SOURCE_PRICE_KEY_UNRECOGNIZED'
          : !term ? 'SOURCE_MONTHLY_RENT_MISSING_OR_INVALID' : null };
    }),
  } : undefined;
  const maker = text(source.maker);
  const model = text(source.model);
  const trim = text(source.trim_name);
  const engineCc = integer(source.engine_cc);
  const vehicleModelId = `reference_vm_${hash(`${maker}|${model}|${trim}|${text(source.fuel_type)}`)}`;
  return {
    productId: `reference_${documentId}`,
    sourceProductId: documentId,
    displayName: [maker, model, trim].filter(Boolean).join(' ') || documentId,
    commercialType: knownProductType(text(source.product_type)),
    vehicleModelId,
    vehicleAssetId: `reference_va_${documentId}`,
    ...(sourceRecord ? { sourceRecord } : {}),
    vehiclePhotos: resolveReferenceVehiclePhotos(source),
    vehicle: {
      maker,
      model,
      subModel: text(source.sub_model) || null,
      trim: trim || null,
      fuel: text(source.fuel_type) || null,
      engineCc,
      engineCcState: engineCc === null ? 'HOLD' as const : 'KNOWN' as const,
      drive: text(source.drive_type) || null,
      seats: integer(source.seats),
      assetStatus: assetStatus(source.vehicle_status) ?? assetStatus(source.status) ?? assetStatus(source.status_kind),
      plateNumber: text(source.car_number) || null,
      odometerKm: integer(source.mileage),
      exteriorColor: text(source.ext_color) || null,
    },
    shadowFacts: {
      modelYear: integer(source.year),
      options: text(source.options) || null,
      depositNote: text(source.deposit_note) || null,
      vehicleStatus: text(source.vehicle_status) || null,
    },
    offers: supplierId ? [{
      offerId: `reference_offer_${documentId}`,
      supplierId,
      supplierName: text(source.provider_name) || null,
      policyId: text(source.policy_code) || null,
      policyContext: resolveReferencePolicyContext(source, policies),
      priceTerms,
    }] : [],
  };
}

export type KakaoCatalogReferenceSource = {
  consumerId: string;
  sourceScope?: ReferenceSourceScope;
  sourceObservations?: Awaited<ReturnType<typeof readCurrentReferenceObservations>>;
  products: Record<string, Rec>;
  observedAt: string;
  /** Policy documents captured with the same source read. Only approved fact keys are projected. */
  policies?: Record<string, Rec>;
  /** Trusted private evidence, keyed by product ID then exact ERP price key. */
  commissionEvidenceByProduct?: Readonly<Record<string, CommissionEvidenceByTerm>>;
  /** Master/trim share their sealed snapshot. Products/policies are separate reads. */
  vehicleMasterSnapshot?: VehicleMasterSnapshot | null;
  vehicleMasterReadState?: 'AVAILABLE' | 'UNAVAILABLE';
  /** Optional sealed new-car trim facts when the caller already read them; never opened here. */
  newCarTrim?: NewCarTrimEvidenceInput;
};
type LegacyReference = Omit<ReturnType<typeof buildReferenceFacts>, 'data'> & {
  data: Extract<ReturnType<typeof buildReferenceFacts>['data'][number], { offers: unknown }>[];
};
export function buildKakaoCatalogReference(input: Omit<KakaoCatalogReferenceSource, 'sourceObservations'> & { sourceObservations?: never }): LegacyReference;
export function buildKakaoCatalogReference(input: KakaoCatalogReferenceSource): ReturnType<typeof buildReferenceFacts>;
export function buildKakaoCatalogReference(input: KakaoCatalogReferenceSource) {
  if (input.consumerId !== 'kakao-ops') throw new Error('KAKAO_REFERENCE_CONSUMER_NOT_ALLOWED');
  return buildReferenceFacts(input);
}

export function buildInternalAiReference(input: Omit<KakaoCatalogReferenceSource, 'sourceObservations'> & { sourceObservations?: never }): Omit<LegacyReference, 'schema' | 'meta'> & { schema: 'freepass-data.internal-ai-reference/v1'; meta: Omit<LegacyReference['meta'], 'consumerId' | 'projectionId'> & { consumerId: string; projectionId: 'internal-ai-reference' } };
export function buildInternalAiReference(input: KakaoCatalogReferenceSource): ReturnType<typeof buildReferenceFacts> extends infer R ? Omit<R, 'schema' | 'meta'> & { schema: 'freepass-data.internal-ai-reference/v1'; meta: Omit<ReturnType<typeof buildReferenceFacts>['meta'], 'consumerId' | 'projectionId'> & { consumerId: string; projectionId: 'internal-ai-reference' } } : never;
export function buildInternalAiReference(input: KakaoCatalogReferenceSource) {
  if (!/^internal-ai-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.consumerId)) throw new Error('INTERNAL_AI_CONSUMER_NOT_ALLOWED');
  const result = buildReferenceFacts(input);
  return { ...result, schema: 'freepass-data.internal-ai-reference/v1' as const,
    meta: { ...result.meta, consumerId: input.consumerId, projectionId: 'internal-ai-reference' as const } };
}

function buildReferenceFacts(input: KakaoCatalogReferenceSource) {
  type NativeReference = (VehicleMasterReference & { reasonCode: null }) | {
    state: 'HOLD'; authority: 'FREEPASS_DATA_VEHICLE_MASTER'; identityKind: 'FIRESTORE_DOCUMENT_ID';
    masterId: null; trimId: null; snapshotDigest: string | null; readAt: string | null; reasonCode: string;
  };
  const hold = (reasonCode: string, snapshot?: VehicleMasterSnapshot): NativeReference => ({ state: 'HOLD',
    authority: 'FREEPASS_DATA_VEHICLE_MASTER', identityKind: 'FIRESTORE_DOCUMENT_ID', masterId: null, trimId: null,
    snapshotDigest: snapshot?.digest ?? null, readAt: snapshot?.readAt ?? null, reasonCode });
  const master = input.vehicleMasterSnapshot;
  let resolveMaster: (source: Rec) => NativeReference = () => hold(input.vehicleMasterReadState === 'UNAVAILABLE'
    ? 'VEHICLE_MASTER_READ_UNAVAILABLE' : 'VEHICLE_MASTER_SNAPSHOT_MISSING');
  if (master && input.vehicleMasterReadState !== 'UNAVAILABLE') {
    try {
      const now = Date.parse(input.observedAt);
      const index = indexVehicleMaster(verifiedMasterRecords(master, now));
      resolveMaster = source => {
        const choice = chooseVehicleIdentity(index, { sheet: [text(source.maker), text(source.model), text(source.sub_model), text(source.trim_name)],
          data: null, raw: '', firstRegistration: '', modelYear: '' });
        if (choice.pick === 'HOLD') return hold('VEHICLE_MASTER_IDENTITY_NOT_UNIQUE', master);
        const verified = verifiedVehicleMasterReference(master, choice, now);
        return verified.state === 'KNOWN' ? { ...verified, reasonCode: null } : hold(verified.reason, master);
      };
    } catch {
      // No credentials/raw exception strings; unavailable identity must not remove economic terms.
      resolveMaster = () => hold('VEHICLE_MASTER_SNAPSHOT_UNVERIFIED');
    }
  }
  let hasLiveUnsavedFee = false;
  const legacyData = Object.entries(input.products)
    .map(([id, source]) => {
      const automaticEvidence = input.consumerId === 'kakao-ops' ? evidenceByTermForProduct(source, input.newCarTrim) : null;
      const mergedEvidenceByTerm = { ...(automaticEvidence?.evidenceByTerm ?? {}), ...(input.commissionEvidenceByProduct?.[id] ?? {}) };
      if (automaticEvidence?.vehicleValueEvidence) hasLiveUnsavedFee = true;
      return buildKakaoCatalogReferenceProduct(id, source, mergedEvidenceByTerm, input.policies, input.observedAt, input.sourceScope, automaticEvidence?.vehicleValueEvidence ?? null);
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .map(row => ({ ...row, representationKind: 'LEGACY_PRODUCT' as const, vehicleMasterReference: resolveMaster(input.products[row.sourceProductId]!) }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
  const sourceObservations = input.sourceScope === 'COLLECTED' ? input.sourceObservations : undefined;
  const data = [...legacyData, ...(sourceObservations?.observations ?? [])];
  if (!data.length && !sourceObservations?.observations.length) throw new Error('KAKAO_REFERENCE_EMPTY');
  const dataDigest = referenceResponseDigest(data, sourceObservations);
  const policyDigest = hash(JSON.stringify(KAKAO_COMMISSION_POLICY));
  return {
    schema: KAKAO_CATALOG_REFERENCE_SCHEMA,
    data,
    ...(input.consumerId === 'kakao-ops' && hasLiveUnsavedFee ? { feeComputation: { mode: 'LIVE_ENGINE_UNSAVED' as const, note: '계산값·저장 전' as const } } : {}),
    ...(sourceObservations ? { sourceObservations } : {}),
    commissionPolicy: { ...KAKAO_COMMISSION_POLICY, digest: policyDigest },
    meta: {
      consumerId: 'kakao-ops' as const,
      projectionId: 'kakao-catalog-reference' as const,
      authority: 'REFERENCE_ONLY' as const,
      publicationDecision: 'HOLD' as const,
      observedAt: input.observedAt,
      sourceProject: 'freepasserp5' as const,
      sourceCollection: 'products' as const,
      sourceCount: Object.keys(input.products).length,
      projectedCount: data.length,
      ...(input.sourceScope === 'COLLECTED' ? { sourceScope: 'COLLECTED' as const } : {}),
      dataDigest,
      warning: 'REFERENCE_ONLY: 재고·가격·수수료 확정 전 공급사 확인 필요',
    },
  };
}

export type KakaoCatalogReference = ReturnType<typeof buildKakaoCatalogReference>;

/** All term conditions match one item; sibling terms remain visible. */
export function filterReferenceProducts<T extends KakaoCatalogReference | ReturnType<typeof buildInternalAiReference>>(reference: T, query: Record<string, unknown>): T {
  const fields = ['productId','sourceObservationId','supplierId','supplierName','plateNumber','maker','model','commercialType','assetStatus'];
  const numeric = ['termMonths','mileageKm','monthlyRentMin','monthlyRentMax','depositMin','depositMax'];
  const keys = [...fields,...numeric,'mileagePeriod','depositState','depositScope','sourceScope'];
  const invalid = () => { throw new Error('REFERENCE_DEPOSIT_FILTER_INVALID'); };
  if (query.sourceScope !== undefined && !['LISTABLE','COLLECTED'].includes(String(query.sourceScope))) invalid();
  if (query.sourceScope === 'COLLECTED' && !('sourceScope' in reference.meta && reference.meta.sourceScope === 'COLLECTED')) invalid();
  if (query.sourceObservationId !== undefined && query.sourceScope !== 'COLLECTED') invalid();
  if (query.sourceObservationId !== undefined && query.productId !== undefined) invalid();
  if (!Object.keys(query).length) return reference;
  for (const [key,value] of Object.entries(query)) {
    if (!keys.includes(key) || typeof value !== 'string' || !value.trim() || (!['supplierName','plateNumber'].includes(key) && value !== value.trim())) invalid();
    if (numeric.includes(key) && (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)))) invalid();
  }
  const nameKey = (value: unknown) => typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g,'') : '';
  // Lookup-only normalization explicitly requested by the user; never changes stored identity.
  const plateKey = (value: unknown) => plateIdentityKey(typeof value === 'string' ? value.normalize('NFC') : value).replace(/-/g,'');
  if (query.plateNumber !== undefined && !isStrictKoreanPlate(plateKey(query.plateNumber))) invalid();
  if (query.termMonths !== undefined && (Number(query.termMonths)<1 || Number(query.termMonths)>60)) invalid();
  if (query.depositState !== undefined && !['ZERO','KNOWN','UNKNOWN'].includes(String(query.depositState))) invalid();
  if (query.depositScope !== undefined && (query.depositState !== 'ZERO' || !['ANY_TERM','ALL_TERMS'].includes(String(query.depositScope)))) invalid();
  if (query.mileagePeriod !== undefined && !['year','month'].includes(String(query.mileagePeriod))) invalid();
  if ((query.mileageKm === undefined) !== (query.mileagePeriod === undefined)) invalid();
  for (const prefix of ['monthlyRent','deposit']) if (query[prefix+'Min'] !== undefined && query[prefix+'Max'] !== undefined && Number(query[prefix+'Min'])>Number(query[prefix+'Max'])) invalid();
  type Term = { termMonths: number; monthlyRent: { amount: number | null }; depositState: string;
    depositAmount: number | null; deposit?: { amount: number } | null; mileageLimitKmPerYear: number | null;
    contractedMileage?: { km: number; period: string } };
  const zero = (t: Term) => t.depositState === 'ZERO' && t.depositAmount === 0 && t.deposit?.amount === 0;
  const range = (v: number | null | undefined, k: string) => (query[k+'Min'] === undefined && query[k+'Max'] === undefined) ||
    (v !== null && v !== undefined && (query[k+'Min'] === undefined || v>=Number(query[k+'Min'])) && (query[k+'Max'] === undefined || v<=Number(query[k+'Max'])));
  const match = (t: Term) => (query.termMonths === undefined || t.termMonths === Number(query.termMonths)) &&
    (query.depositState === undefined || (query.depositState === 'ZERO' ? zero(t) : t.depositState === query.depositState)) &&
    range(t.monthlyRent.amount,'monthlyRent') && range(t.depositAmount,'deposit') &&
    (query.mileageKm === undefined || (t.contractedMileage ? t.contractedMileage.km === Number(query.mileageKm) && t.contractedMileage.period === query.mileagePeriod : query.mileagePeriod === 'year' && t.mileageLimitKmPerYear === Number(query.mileageKm)));
  const supplierMatches = (id: string | null, name: string | null) =>
    (query.supplierId === undefined || id === query.supplierId) && (query.supplierName === undefined || nameKey(name) === nameKey(query.supplierName));
  const termKeys = [...numeric, 'mileagePeriod', 'depositState', 'depositScope'];
  const sourceOnlyPeriod = Object.keys(query).every(key => !termKeys.includes(key) || key === 'termMonths');
  const referenceProducts = reference.data.filter(p => 'offers' in p);
  const sourceMatch = (p: typeof referenceProducts[number]) => p.sourceRecord?.scope === 'COLLECTED' && sourceOnlyPeriod
    && supplierMatches(p.sourceRecord.supplierId, p.sourceRecord.supplierName)
    && (query.termMonths === undefined || p.sourceRecord.priceConditions.some(t => t.termMonths === Number(query.termMonths)));
  // Match the complete returned product ID verbatim; never infer it from a plate,
  // supplier code, source document ID, external ID, or an ID substring.
  const productCandidates = query.productId === undefined ? [] : referenceProducts.filter(p => p.productId === query.productId);
  const productIdentityConflict = productCandidates.length > 0 && !productCandidates.some(p =>
    (query.plateNumber === undefined || plateKey(p.vehicle.plateNumber) === plateKey(query.plateNumber)) &&
    ((query.supplierId === undefined && query.supplierName === undefined) ||
      (p.sourceRecord?.scope === 'COLLECTED' && supplierMatches(p.sourceRecord.supplierId, p.sourceRecord.supplierName)) ||
      p.offers.some(o => supplierMatches(o.supplierId, o.supplierName))));
  const data = referenceProducts.filter(p => query.sourceObservationId === undefined && (query.productId === undefined || p.productId === query.productId) &&
    (query.plateNumber === undefined || plateKey(p.vehicle.plateNumber) === plateKey(query.plateNumber)) && (query.maker === undefined || p.vehicle.maker === query.maker) &&
    (query.model === undefined || p.vehicle.model === query.model) && (query.commercialType === undefined || p.commercialType === query.commercialType) &&
    (query.assetStatus === undefined || p.vehicle.assetStatus === query.assetStatus) &&
    (sourceMatch(p) || p.offers.some(o => supplierMatches(o.supplierId, o.supplierName) && o.priceTerms.some(match))) &&
    (query.depositScope !== 'ALL_TERMS' || p.offers.flatMap(o => o.priceTerms).every(zero)));
  const supplierCodes = new Set(data.flatMap(p => [
    ...p.offers.filter(o => query.supplierName !== undefined && supplierMatches(o.supplierId, o.supplierName) && o.priceTerms.some(match)).map(o => o.supplierId),
    ...(query.supplierName !== undefined && sourceMatch(p) && p.sourceRecord?.supplierId ? [p.sourceRecord.supplierId] : []),
  ]));
  const plateCandidates = query.plateNumber === undefined ? [] : data.filter(p => plateKey(p.vehicle.plateNumber) === plateKey(query.plateNumber));
  const reasonCode = productCandidates.length > 1 ? 'PRODUCT_ID_MULTIPLE_PRODUCTS' : productIdentityConflict ? 'PRODUCT_ID_IDENTITY_CONFLICT'
    : supplierCodes.size > 1 ? 'SUPPLIER_NAME_MULTIPLE_CODES' : plateCandidates.length > 1 ? 'PLATE_MULTIPLE_PRODUCTS' : null;
  const sourceObservations = reference.sourceObservations && { ...reference.sourceObservations,
    observations: reference.sourceObservations.observations.filter(o => {
      const n = o.normalized;
      const terms = n.priceConditions.map(t => ({ termMonths: t.termMonths, monthlyRent: { amount: t.monthlyRentAmount },
        depositState: t.depositState, depositAmount: t.depositAmount, deposit: t.depositAmount === null ? null : { amount: t.depositAmount },
        mileageLimitKmPerYear: t.mileageKm }));
      return (query.productId === undefined || o.productId === query.productId) && (query.sourceObservationId === undefined || o.observationId === query.sourceObservationId)
        && supplierMatches(n.supplierId, typeof o.original.supplierName === 'string' ? o.original.supplierName : null)
        && (query.plateNumber === undefined || plateKey(n.plateNumber) === plateKey(query.plateNumber))
        && (query.maker === undefined || (n.maker ?? o.original.maker) === query.maker)
        && (query.model === undefined || (n.model ?? o.original.model) === query.model)
        && (query.commercialType === undefined || n.commercialType === query.commercialType)
        // assetStatus is a canonical asset fact; source status is never promoted to it.
        && query.assetStatus === undefined && (sourceOnlyPeriod && query.termMonths === undefined || terms.some(match))
        && (query.depositScope !== 'ALL_TERMS' || terms.length > 0 && terms.every(zero));
    }) };
  const observationCandidates = query.sourceObservationId === undefined ? [] : reference.sourceObservations?.observations.filter(o => o.observationId === query.sourceObservationId) ?? [];
  const rowCandidates = query.productId === undefined ? [] : reference.sourceObservations?.observations.filter(o => o.productId === query.productId) ?? [];
  const resolvedReason = observationCandidates.length > 1 ? 'SOURCE_OBSERVATION_MULTIPLE_RECORDS'
    : rowCandidates.length > 1 ? 'PRODUCT_ID_MULTIPLE_PRODUCTS' : reasonCode;
  const observationCount = sourceObservations?.observations.length ?? 0;
  if (sourceObservations?.sourceSnapshot) sourceObservations.sourceSnapshot = { ...sourceObservations.sourceSnapshot, returnedProductRowCount: observationCount };
  const combinedData = [...data, ...(sourceObservations?.observations ?? [])];
  const queryResolution = { state: resolvedReason ? 'HOLD' : data.length || observationCount ? 'MATCHED' : 'NO_MATCH', reasonCode: resolvedReason,
    matchedProductCount: combinedData.length, ...(sourceObservations ? { matchedObservationCount: observationCount, matchedLegacyProductCount: data.length } : {}) };
  return { ...reference,data:combinedData,...(sourceObservations ? { sourceObservations } : {}),meta: { ...reference.meta,projectedCount:combinedData.length,dataDigest:referenceResponseDigest(combinedData,sourceObservations),queryFilter:{...query},...(query.productId !== undefined || query.sourceObservationId !== undefined || query.supplierName !== undefined || query.plateNumber !== undefined ? {queryResolution} : {}),
    ...(query.depositState === 'ZERO' ? {depositFilter:{state:'ZERO',termMonths:query.termMonths === undefined ? null : Number(query.termMonths),scope:query.depositScope === 'ALL_TERMS' ? 'ALL_TERMS' : 'ANY_TERM'}} : {}) } } as T;
}
export const filterReferenceZeroDeposit = filterReferenceProducts;
