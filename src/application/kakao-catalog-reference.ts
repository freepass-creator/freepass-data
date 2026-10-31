import { priceWithoutIancarAliases } from '../domain/iancar-price-alias.js';
import { plateIdentityKey, isStrictKoreanPlate } from '../domain/vehicle-plate.js';
import { createHash } from 'node:crypto';
import { CONDITION_DIMENSION_SPECS } from './product-condition-dimensions.js';
import { policyScalar } from './product-pricing-policy.js';
import { selectErp5Policy } from '../adapters/erp5-product-mapping.js';
import { assessDepositEvidence, depositEvidenceInputFromProduct, depositSourceWaiverFieldForTermMonths, depositStatusLabel, hasConflictingPaidDeposit, parseErp5CompatibilityPriceKey, readIancarEngineDeposit, resolveDepositWithRuleNote } from '../domain/deposit-evidence.js';
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
export async function readCurrentReferenceObservations(store: Pick<SourceIngestionStore, 'getSourceHead' | 'getRun' | 'listRaw' | 'listCandidates'> & Partial<Pick<SourceIngestionStore, 'listLineage' | 'getLineageById'>>, options?: { storedFeesOnly: boolean }) {
  const sourceId = sheetSpec.supplierManagement.sourceBinding.sourceId;
  const head = await store.getSourceHead(sourceId);
  if (!head) return { state: 'HOLD' as const, reasonCode: 'SOURCE_HEAD_MISSING', observations: [], sourceSnapshot: null };
  const run = await store.getRun(head.runId);
  if (!run || run.sourceId !== sourceId || run.status !== 'COMPLETED' || run.headStatus !== 'CURRENT'
    || run.observedAt !== head.observedAt) throw new Error('REFERENCE_SOURCE_RUN_UNVERIFIED');
  const [raw, candidates, legacyFeeLineage] = await Promise.all([store.listRaw(run.runId), store.listCandidates(run.runId), options?.storedFeesOnly && store.listLineage ? store.listLineage(run.runId) : Promise.resolve([])]);
  if (raw.length !== run.rawCount || candidates.length !== run.candidateCount
    || new Set(raw.map(r => r.rawRecordId)).size !== raw.length
    || [...raw, ...candidates].some(r => r.runId !== run.runId || r.sourceId !== sourceId)
    || candidates.some(c => !raw.some(r => r.sourceRecordId === c.sourceRecordId && r.sourceFingerprint === c.sourceFingerprint))) {
    throw new Error('REFERENCE_SOURCE_READ_INCOMPLETE');
  }
  const expectedFeeIds=options?.storedFeesOnly && store.getLineageById ? [...new Set(raw.flatMap(r=>{
    const matches=candidates.filter(c=>c.sourceRecordId===r.sourceRecordId&&c.sourceFingerprint===r.sourceFingerprint);
    return matches.length===1?sourceFeeLineage(r,matches[0]!).map(l=>l.lineageRecordId):[];
  }))]:[];
  const directFeeLineage=await Promise.all(expectedFeeIds.map(id=>store.getLineageById!(id)));
  // 새 ID 직접 조회를 우선하고, 없는 ID만 현재 run의 옛 형식 목록에서 찾는다.
  const feeLineage=[...new Map([...legacyFeeLineage,...directFeeLineage.filter((x):x is FieldLineageRecord=>x!==null)]
    .map(item=>[item.lineageRecordId,item] as const)).values()];
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
/** 계산 분기·반올림 등 의미가 바뀌면 반드시 올린다. 정책 데이터 버전과 별개다. */
export const SOURCE_FEE_ENGINE_VERSION = 'source-fee-engine/2026-10-30-1';
export const sourceFeeInputDigest = (raw: RawRecord, record: NormalizedCandidateRecord, termKey: string) => {
  const c=record.candidate, term=c.priceTerms.find(t=>t.termKey===termKey);
  const billin=['RP021','PT-0026'].includes(c.providerCompanyCode??'') && /SUBSCRIPTION/.test(c.commercialType??'');
  return stableDigest({fingerprint:raw.sourceFingerprint,supplier:c.providerCompanyCode??null,
    productType:c.commercialType??null,term:term ? {termKey:term.termKey,termMonths:term.termMonths,monthlyRent:term.monthlyRent,mileageLimitKmPerYear:term.mileageLimitKmPerYear??null} : null,
    ...(billin ? {basis36:c.priceTerms.filter(t=>t.termMonths===36 && t.mileageLimitKmPerYear===term?.mileageLimitKmPerYear)} : {}),
    ...(['RP004','RP023'].includes(c.providerCompanyCode??'') ? {fuel:c.vehicleFacts?.fields.fuel??null} : {})});
};

const stablePriceSourceRefs = (refs: readonly {field:string;row:number|null}[]) =>
  refs.map(ref=>({field:ref.field,row:ref.row}));
const feeLineageComparable = (record: FieldLineageRecord) => {
  const {runId:_runId,observedAt:_observedAt,createdRunId:_createdRunId,
    createdObservedAt:_createdObservedAt,...content}=record;
  return content;
};
export const sourceFeeLineageMatchesExpected = (actual: FieldLineageRecord, expected: FieldLineageRecord) =>
  stableDigest(feeLineageComparable(actual))===stableDigest(feeLineageComparable(expected));

const validStoredFee=(fee:unknown): fee is CommissionResolution => {
  if(!fee || typeof fee!=='object' || Array.isArray(fee)) return false;
  const f=fee as CommissionResolution;
  if(!['EXCLUDED','INCLUDED','UNKNOWN'].includes(f.vatTreatment) ||
    (f.ruleId!==null && (typeof f.ruleId!=='string'||!/^[A-Z][A-Z0-9_:.-]{0,199}$/.test(f.ruleId))) ||
    (f.reasonCode!==null && (typeof f.reasonCode!=='string'||!/^[A-Z][A-Z0-9_:.-]{0,199}$/.test(f.reasonCode))) ||
    (f.sourceRefs!==undefined && (!Array.isArray(f.sourceRefs)||f.sourceRefs.some(r=>typeof r!=='string'||!(/^(?:ledger:59c7c3ba|ledger:2026-10-28-rp004-payout-equals-billing|NONSTANDARD_TERM_NEAREST_SHORTER_STANDARD\([1-9][0-9]*→(?:1|3|5|12|24|36|48|60)\)|USER:2026-10-09:BILLIN_LC_36_MONTH_RENT_100_80|USER:2026-10-11:ONE_MONTH_RENT_5_PERCENT_FULL_PAYOUT|OGONG_12M_BASE_MINUS_INSURANCE_2026-10-12|SONOKONG_INSURANCE_DEDUCT_100K|SONOKONG_PICKUP_TERM_PROXY_RERENT|SONOKONG_PICKUP_60_PROVISIONAL_ROW191|F04:수수료표!A[1-9][0-9]*:M[1-9][0-9]*)$/.test(r)))))) return false;
  return (f.state==='CALCULATED' || f.state==='CALCULATED_APPROX') ? f.vatTreatment!=='UNKNOWN' && !!f.sourceRefs?.length && Number.isSafeInteger(f.amount) && f.amount!>=0 && !!f.ruleId &&
    Number.isSafeInteger(f.vatAmount) && f.vatAmount!>=0 && Number.isSafeInteger(f.totalAmount) &&
    f.totalAmount===f.amount!+f.vatAmount! :
    ['UNKNOWN','COORDINATION_REQUIRED','NOT_APPLICABLE'].includes(f.state) && f.amount===null && f.vatAmount===null && f.totalAmount===null;
};

/** Producer composition only. Persists derived facts without promoting candidate identity. */
export function sourceFeeLineage(raw: RawRecord, record: NormalizedCandidateRecord,
  feeEngineVersion=SOURCE_FEE_ENGINE_VERSION): FieldLineageRecord[] {
  const observation = projectReferenceObservation(raw, record);
  return record.candidate.priceTerms.flatMap(price => {
    const matches=observation.normalized.priceConditions.filter(t=>t.termMonths===price.termMonths &&
      t.monthlyRentAmount===price.monthlyRent.amount && t.mileageKm===(price.mileageLimitKmPerYear??null));
    if(matches.length!==1) return [];
    const term=matches[0]!,termKey=price.termKey,inputDigest=sourceFeeInputDigest(raw, record, termKey);
    const policyDigest=sourceFeePolicyContractDigest(),priceSourceRefs=stablePriceSourceRefs(term.priceSourceRefs);
    const valueBase = { authority: 'APPROVED_ENGINE_DERIVED_NOT_SETTLEMENT', currency: 'KRW', policyId: KAKAO_COMMISSION_POLICY.policyId,
      policyDigest, policyContractDigest: sourceFeePolicyContractDigest(), inputDigest, feeEngineVersion, termKey,
      supplierBillingFee: term.supplierBillingFee, channelPayoutFee: term.channelPayoutFee, priceSourceRefs };
    const value={...valueBase,valueDigest:stableDigest(valueBase)};
    const id = `source_fee_${stableDigest({sourceId:raw.sourceId,sourceRecordId:raw.sourceRecordId,
      sourceFingerprint:raw.sourceFingerprint,termKey,inputDigest,policyDigest,feeEngineVersion})}`;
    const stableCandidateId=`source_record_${stableDigest({sourceId:raw.sourceId,sourceRecordId:raw.sourceRecordId,
      sourceFingerprint:raw.sourceFingerprint})}`;
    return [{lineageRecordId:id,lineageId:id,stage:'RAW_TO_NORMALIZED' as const,runId:raw.runId,sourceId:raw.sourceId,
      sourceRecordId:raw.sourceRecordId,sourceFingerprint:raw.sourceFingerprint,observedAt:raw.observedAt,
      createdRunId:raw.runId,createdObservedAt:raw.observedAt,
      source:{fieldPath:'priceTerms',value:{priceSourceRefs}},
      normalized:{candidateId:stableCandidateId,fieldPath:`derivedFees.${termKey}`,value},
      transformId:SOURCE_FEE_TRANSFORM,transformVersion:feeEngineVersion}];
  });
}
function readLegacySourceFeeLineage(raw: RawRecord, record: NormalizedCandidateRecord, termKey: string, lineage: readonly FieldLineageRecord[]) {
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
  if(!validStoredFee(v.supplierBillingFee)||!validStoredFee(v.channelPayoutFee))return null;
  const refs=(v.priceSourceRefs as {runId:string;rawRecordId:string;field:string;row:number|null}[]).map(ref=>({runId:ref.runId,rawRecordId:ref.rawRecordId,field:ref.field,row:ref.row}));
  const evidence={authority:v.authority,currency:v.currency,policyId:v.policyId,policyDigest:v.policyDigest,policyContractDigest:v.policyContractDigest,
    inputDigest:v.inputDigest,observedAt:v.observedAt,lineageRecordId:l.lineageRecordId,priceSourceRefs:refs};
  const fee=(f:CommissionResolution)=>({state:f.state,ruleId:f.ruleId,amount:f.amount,vatTreatment:f.vatTreatment,
    vatAmount:f.vatAmount,totalAmount:f.totalAmount,reasonCode:f.reasonCode,
    ...((f.state==='CALCULATED' || f.state==='CALCULATED_APPROX') && f.sourceRefs?{sourceRefs:[...f.sourceRefs]}:{}),
    derivedEvidence:evidence});
  return {supplierBillingFee:fee(v.supplierBillingFee),channelPayoutFee:fee(v.channelPayoutFee)};
}

function readSourceFeeLineage(raw: RawRecord, record: NormalizedCandidateRecord, termKey: string, lineage: readonly FieldLineageRecord[]) {
  const expected=sourceFeeLineage(raw,record).find(l=>l.normalized?.fieldPath===`derivedFees.${termKey}`);
  if(expected){
    const current=lineage.filter(l=>l.lineageRecordId===expected.lineageRecordId);
    if(current.length>1)return null;
    if(current.length===1){
      const l=current[0]!,v=l.normalized?.value as Record<string,unknown>|undefined;
      if(!v || l.lineageId!==l.lineageRecordId || l.createdRunId!==l.runId || l.createdObservedAt!==l.observedAt ||
        !sourceFeeLineageMatchesExpected(l,expected) || typeof v.valueDigest!=='string' ||
        v.valueDigest!==stableDigest(Object.fromEntries(Object.entries(v).filter(([key])=>key!=='valueDigest'))) ||
        !validStoredFee(v.supplierBillingFee)||!validStoredFee(v.channelPayoutFee))return null;
      const storedRefs=v.priceSourceRefs as {field:string;row:number|null}[];
      const currentRow=Number.isSafeInteger(raw.payload.row)&&Number(raw.payload.row)>0?Number(raw.payload.row):null;
      const refs=storedRefs.map(ref=>({runId:raw.runId,rawRecordId:raw.rawRecordId,field:ref.field,row:currentRow}));
      const evidence={authority:v.authority,currency:v.currency,policyId:v.policyId,policyDigest:v.policyDigest,
        policyContractDigest:v.policyContractDigest,inputDigest:v.inputDigest,observedAt:raw.observedAt,
        lineageRecordId:l.lineageRecordId,priceSourceRefs:refs};
      const fee=(f:CommissionResolution)=>({state:f.state,ruleId:f.ruleId,amount:f.amount,vatTreatment:f.vatTreatment,
        vatAmount:f.vatAmount,totalAmount:f.totalAmount,reasonCode:f.reasonCode,
        ...((f.state==='CALCULATED'||f.state==='CALCULATED_APPROX')&&f.sourceRefs?{sourceRefs:[...f.sourceRefs]}:{}),derivedEvidence:evidence});
      return {supplierBillingFee:fee(v.supplierBillingFee as CommissionResolution),channelPayoutFee:fee(v.channelPayoutFee as CommissionResolution)};
    }
  }
  return readLegacySourceFeeLineage(raw,record,termKey,lineage);
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
    // 대표 10-28 «우리가 계약서 써주는 업체는 우리 표준 수수료 적용하면 돼 심플하게»: 기본 회사는 공급사별 특칙 없이 표준표.
    // 표준표의 신차는 선출고(차량가격 3%)뿐이라, 출고 방식이 적히지 않은 신차렌트는 선출고로 본다(견적출고 명시는 그대로 합의 요율 필요).
    // 표준표에 없는 2~11개월은 계속 근거 필요(표에 값이 없다).
    unspecifiedNewDeliveryForm: 'STANDARD_PREDELIVERY',
    unspecifiedShortTerms: 'REQUIRES_EVIDENCE',
    contractWriterStandard: { decisionDate: '2026-10-28', authority: 'USER_DIRECT_DECISION', sourceRef: 'ledger:2026-10-28-contract-writer-standard-fee',
      newRentDefaultSubtype: 'NEW_PREDELIVERY', nonstandardTermNearestShorterStandard: 'BILLING_AND_PAYOUT' },
    billinProposal: { supplierIds: ['RP021', 'PT-0026'], state: 'CONFIRMED', termMonths: 36,
      billingBasis: 'MONTHLY_RENT_AT_36_MONTHS', billingPercent: 100, payoutPercentOfBilling: 80,
      authority: 'USER_DIRECT_DECISION_2026_10_09', appliesTo: 'SUBSCRIPTION',
      historicalSettlementRewrite: false },
  },
  currentAuthority: 'F04 수수료표 A1:M191(2026-10-04 사본) + AI 상황실 2026-10-05 결정(손오공 60개월 +60만, 원 미만 반올림) + 2026-10-09 대표 기본회사 지정 및 빌린카 LC 36개월 월대여료100/80 확정 + 2026-10-11 대표 1개월 월료5% 청구전액지급 VAT별도',
  evidenceHistory: [...KAKAO_COMMISSION_POLICY_2026_10_04.evidenceHistory,
    { policyId: KAKAO_COMMISSION_POLICY_2026_10_04.policyId, observedAt: '2026-10-04', revision: '35de6d9fa96ad07fba2fb2d68a4cb1c9113b61a5' },
    { policyId: 'sales-commission-2026-10-09', observedAt: '2026-10-09', revision: '1e1ea6894def6bebd3abe4d231471f3153ffdfea' }],
  sonokongAdditions: { 12: -100000, 24: 100000, 36: 300000, 48: 500000, 60: 500000 },
  sonokong60Evidence: { sourceRows: [14], evidence: 'private:ai-ops/정산-수수료규칙-20261005', decidedBy: 'AI 상황실 2026-10-05' },
  roundingRule: { rule: 'ROUND_HALF_UP_TO_WON', sourceRows: [171], evidence: 'private:ai-ops/정산-수수료규칙-20261005', decidedBy: 'AI 상황실 2026-10-05' },
  /** 뮤카(RP035, 2026-10-05 발급) 구독 — freepass-admin DEC-2026-10-04-01 8번 = F04 수수료표 169·170행. 일반·픽업 공통.
   * 청구(프리패스 몫) = 차량 기준가 × 1%(전 기간). 지급(영업 GA) = 선납/분납 × 기간 정액 + min(추가보증금 × 10%, 상한)(전 기간).
   * 별도 지급 재원 — 청구 − 지급 마진으로 계산하지 않는다. «분납 완납 전 미지급»은 계약 단계의 지급 가능 상태로 따로 다룬다.
   * 대표 2026-10-28 «뮤카 테슬라 수수료 150만원 … 프로모션 차종은 150이야»: 선납 정액은 뮤카 잔가표 6차 brands 값(차종 구분별),
   * 추가보증금 상한은 잔가표 5차 50만(gnafit pricing/policy-config-sixth·fifth-20261015). 10-03 «12개월 100만·24개월 이상 120만·40만» 대체.
   * 분납 줄은 10-05 폐지 전 계약에만 쓰는 옛 값 그대로(차종 구분 없음, 상한 40만). */
  mewcar: {
    supplierId: 'RP035', sourceRows: [169, 170], billingBasisPoints: 100,
    payout: {
      PREPAID: {
        DOMESTIC: { 12: 900000, 24: 1200000, 36: 1200000, 48: 1200000, 60: 1200000 },
        PREMIUM: { 12: 1000000, 24: 1500000, 36: 1500000, 48: 1500000, 60: 1500000 },
      },
      INSTALLMENT: { 12: 800000, 24: 1000000, 36: 1000000, 48: 1000000 },
    },
    extraDepositPercent: 10, extraDepositCap: 500000, installmentExtraDepositCap: 400000, separateFunding: true,
    brandFeeSourceRef: 'ledger:2026-10-28-mewcar-ga-fee-brands',
    /** 잔가표 6차 수신 2026-10-15 15:16(KST, 같은 날 아침 5차는 프리미엄 140만). 계약일이 이날 이전이면 어느 차수 값인지 몰라 «확인 필요»로 멈춘다.
     * 계약일이 없는 현재 상품·견적은 현행 값. 옛 엔진 값(12개월 100만 일괄)은 그때도 국산 90만과 어긋나 과거 계약에 쓰지 않는다. */
    prepaidBrandFeeContractFrom: '2026-10-16',
    /** 2026-10-05 뮤카 조건 변경: 보증금 분납 폐지 + 영업 분납 정액 줄 삭제. 효력일(포함) 이후 계약일의 신규 분납 계약은 계산하지 않고 «확인 필요»로 멈춘다.
     * 그 전 계약(계약일 < 효력일)은 위 INSTALLMENT 옛 정액으로 계산한다. 선납 정액·추가보증금 10%(40만 한도)·프리패스 1% 는 그대로. */
    installmentAbolishedFrom: '2026-10-05',
  },
} as const;

/** 이안카(RP031) 기간별 «월 렌트료 × 배수»(퍼센트). 대표 10-31 결정 — 1개월 0.05 · 3개월 0.10 · 5개월 0.25 · 12개월 0.50 · 24개월 0.75 · 36개월 1.00 · 48개월 1.25 · 60개월 1.50. */
const IANCAR_RENT_MULTIPLE_PERCENT: Readonly<Record<number, number>> = { 1: 5, 3: 10, 5: 25, 12: 50, 24: 75, 36: 100, 48: 125, 60: 150 };

const f04Ref = (row: number) => `F04:수수료표!A${row}:M${row}`;

/** One supplier assignment over the existing authority. Never a policy per vehicle. */
export function getSupplierCommissionPolicy(supplierId: string) {
  const p = KAKAO_COMMISSION_POLICY;
  const includes = (ids: readonly string[]) => ids.includes(supplierId);
  const standard = includes(p.standardSupplierIds);
  const group = includes(p.exceptionSupplierIds.excludedMindcar) ? 'EXCLUDED'
    : supplierId === p.mewcar.supplierId ? 'MEWCAR'
    : includes(p.exceptionSupplierIds.sonokong) ? 'SONOKONG'
    : includes(p.exceptionSupplierIds.star) ? 'STAR'
    : includes(p.exceptionSupplierIds.autoplus) ? 'AUTOPLUS'
    : includes(p.exceptionSupplierIds.switchplan) ? 'SWITCH'
    : includes(p.exceptionSupplierIds.iancar) ? 'AICAR'
    : includes(p.exceptionSupplierIds.pacific) ? 'PACIFIC'
    : standard ? 'STANDARD' : null;
  if (!group) return null;
  const basicSubscription = includes(p.supplierPolicyAssignments.basicSupplierIds);
  const billinSubscription = includes(p.supplierPolicyAssignments.billinProposal.supplierIds);
  // Existing representative decision 2026-10-12 (RP006·RP020) + 2026-10-28 basic companies standard table; explicit matching delivery still wins.
  const newRentDefaultSubtype = supplierId === 'RP006' || basicSubscription ? 'NEW_PREDELIVERY' as const : undefined;
  const groups = new Set(['STANDARD', ...(supplierId === 'RP006' ? ['IRON'] : []),
    ...(group === 'AICAR' ? ['IANCAR'] : [group])]);
  const definition = {
    supplierId, policyId: p.policyId, assignmentId: `supplier-fee:${supplierId}`,
    engineRevision: 'supplier-policy-2026-10-28', group, basicSubscription, billinSubscription,
    newRentDefaultSubtype: newRentDefaultSubtype ?? null,
    standardLadder: standard || ['SONOKONG', 'STAR', 'AICAR', 'PACIFIC'].includes(group),
    rules: p.rules.filter(rule => ('supplierGroup' in rule && groups.has(rule.supplierGroup)) ||
      (group === 'AUTOPLUS' && rule.id.startsWith('AUTOPLUS_')) ||
      (group === 'SONOKONG' && rule.id.startsWith('SONOKONG_'))),
    oneMonthBasic: p.oneMonthBasic,
    ...(basicSubscription ? { contractWriterStandard: p.supplierPolicyAssignments.contractWriterStandard } : {}),
    ...(billinSubscription ? { subscription: p.supplierPolicyAssignments.billinProposal } : {}),
    ...(group === 'SONOKONG' ? { sonokongAdditions: p.sonokongAdditions } : {}),
    ...(group === 'PACIFIC' ? { pacificRates: p.pacificRates } : {}),
    ...(group === 'MEWCAR' ? { mewcar: p.mewcar } : {}),
  };
  return { ...definition, digest: stableDigest(definition) };
}

export function listSupplierCommissionPolicies() {
  const p = KAKAO_COMMISSION_POLICY;
  const ids = [...new Set([...p.standardSupplierIds, ...Object.values(p.exceptionSupplierIds).flat(), p.mewcar.supplierId])].sort();
  return ids.map(id => getSupplierCommissionPolicy(id)!);
}
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
  approximate?: boolean;
  note?: string | null;
  vehicleValueEvidence?: { grade: 'CONFIRMED' | 'APPROX'; source: 'SUPPLIER_RAW' | 'CONSUMER_PRICE' | 'NEW_CAR_TRIM' };
};

const ogongTermAddon = (termMonths: number): number | null => {
  if (termMonths === 12) return 0;
  if (termMonths === 24) return 200000;
  if (termMonths === 36) return 400000;
  if (termMonths === 48 || termMonths === 60) return 600000;
  return null;
};

function computeOgongBillingAmount(input: { rent12: number; termMonths: number }): number | null {
  const addon = ogongTermAddon(input.termMonths);
  if (addon === null || !Number.isSafeInteger(input.rent12)) return null;
  return input.rent12 - 100000 + addon;
}

type MarginResolution = {
  state: MarginState;
  amount: number | null;
  currency: 'KRW';
  basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT';
  reasonCode: string | null;
};

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
/** 연료 글자에서 공백을 지운 뒤 정확히 «전기»인지(부분 일치 금지: «가솔린+전기»는 하이브리드). */
const isExactElectricFuel = (value: unknown) => text(value).replace(/\s+/g, '') === '전기';
const integer =(value: unknown): number | null => {
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
  calculatedDepositRule?: unknown;
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

export const truncWon = (amount: number): number => Math.trunc(amount);

type RoundingMode = 'ROUND' | 'TRUNC';

const roundWon = (amount: number, rounding: RoundingMode): number =>
  rounding === 'TRUNC' ? truncWon(amount) : Math.round(amount);

const calculatedCommission = (
  ruleId: string,
  amount: number,
  vatTreatment: VatTreatment,
  rounding: RoundingMode = 'ROUND',
): CommissionResolution => {
  if (Number.isFinite(amount)) amount = roundWon(amount, rounding); // 원 단위 반올림(F04 접수 관행, 아래 VAT 근거와 같음)
  if (!Number.isSafeInteger(amount) || amount < 0) return unknownCommission('COMMISSION_AMOUNT_OUT_OF_RANGE');
  // F04 접수 관행(2026-10-04 확정): VAT 포함 금액 ÷ 1.1 → 원 단위 반올림. 근거(원장 줄)는 비공개 기록.
  const supply = vatTreatment === 'INCLUDED' ? roundWon(amount / 1.1, rounding) : amount;
  const vatAmount = vatTreatment === 'INCLUDED' ? amount - supply : roundWon(supply / 10, rounding);
  const totalAmount = supply + vatAmount;
  if (!Number.isSafeInteger(totalAmount)) return unknownCommission('COMMISSION_AMOUNT_OUT_OF_RANGE');
  return { state: 'CALCULATED', ruleId, amount: supply, vatTreatment, vatAmount, totalAmount, reasonCode: null };
};

const approximateCommission = (
  ruleId: string,
  amount: number,
  vatTreatment: VatTreatment,
  note: string,
  rounding: RoundingMode = 'ROUND',
): CommissionResolution => {
  const resolved = calculatedCommission(ruleId, amount, vatTreatment, rounding);
  return resolved.state === 'CALCULATED'
    ? { ...resolved, state: 'CALCULATED_APPROX', approximate: true, note }
    : resolved;
};

const unknownCommission = (reasonCode: string): CommissionResolution => ({
  state: 'UNKNOWN', ruleId: null, amount: null, vatTreatment: 'UNKNOWN', vatAmount: null, totalAmount: null, reasonCode,
});

const standardLadderSupplier = (supplierId: string) =>
  getSupplierCommissionPolicy(supplierId)?.standardLadder === true;

const resolveTermLadder = (
  termMonths: number,
  monthlyRent: number,
  side: 'BILLING' | 'PAYOUT',
  prefix = 'STANDARD_RERENT',
  rounding: RoundingMode = 'ROUND',
  allowNonstandardBilling = false,
): CommissionResolution => {
  const standardTerms = [12, 24, 36, 48, 60] as const;
  const appliedTerm = (side === 'PAYOUT' || allowNonstandardBilling) && termMonths >= 12 && !standardTerms.includes(termMonths as never)
    ? [...standardTerms].reverse().find(term => term <= termMonths) ?? termMonths
    : termMonths;
  const nonstandardNote = appliedTerm !== termMonths
    ? `NONSTANDARD_TERM_NEAREST_SHORTER_STANDARD(${termMonths}→${appliedTerm})`
    : null;
  const ruleId = (term: number, suffix: 'FIXED' | 'RENT_X_TERM') => {
    if (prefix === 'STANDARD_RERENT' && side === 'PAYOUT') {
      return term === 12 ? 'STANDARD_RERENT_12_FIXED' : `STANDARD_RERENT_${term}_RENT_X_TERM`;
    }
    return `${prefix}_${term}_${side}_${suffix}`;
  };
  if (prefix === 'STANDARD_RERENT' && termMonths === KAKAO_COMMISSION_POLICY.oneMonthBasic.termMonths) {
    return calculatedCommission(`STANDARD_RERENT_1_${side}_RENT_5_PERCENT`,
      monthlyRent * KAKAO_COMMISSION_POLICY.oneMonthBasic.monthlyRentBasisPoints / 10000, 'EXCLUDED', rounding);
  }
  // 사다리 값은 공유 정책표(#798)에서 읽고, 조회 기간은 비정형 기간을 가까운 짧은 표준 기간으로 바꾼 값(#800, 대표 10-28)이다.
  const policy = KAKAO_COMMISSION_POLICY;
  const billing = policy.rules.find(rule => rule.id === 'STANDARD_RERENT_BILLING_LADDER')!;
  const payout = policy.rules.find(rule => rule.id.startsWith('STANDARD_RERENT_') &&
    'termMonths' in rule && rule.termMonths === appliedTerm && 'supplierGroup' in rule && rule.supplierGroup === 'STANDARD' &&
    'basis' in rule && (rule.basis === 'FIXED' || rule.basis === 'MONTHLY_RENT_X_TERM'));
  const selected = side === 'BILLING' ? billing.termRules.find(rule => rule.termMonths === appliedTerm) : payout;
  if (selected && 'fixedAmount' in selected && typeof selected.fixedAmount === 'number')
    return { ...calculatedCommission(ruleId(appliedTerm, 'FIXED'), selected.fixedAmount, 'EXCLUDED', rounding),
      ...(nonstandardNote ? { note: nonstandardNote } : {}) };
  const basisPoints = selected && 'rateBasisPoints' in selected ? selected.rateBasisPoints : null;
  if (!basisPoints) return unknownCommission('TERM_NOT_IN_F04_COMMISSION_POLICY');
  return { ...calculatedCommission(
    ruleId(appliedTerm, 'RENT_X_TERM'),
    monthlyRent * termMonths * basisPoints / 10000,
    'EXCLUDED',
    rounding,
  ), ...(nonstandardNote ? { note: nonstandardNote } : {}) };
};

const SONOKONG_RERENT_TERM_MONTHS = [12, 24, 36, 48, 60] as const;
const SONOKONG_PICKUP_PROXY_TERM_MONTHS = [12, 24, 36, 48] as const;

export type CommissionInput = {
  supplierId: string;
  productType: string;
  fuel?: string;
  termMonths: number;
  monthlyRent: number;
  /** 계약 조건의 검증된 보증금 상태. RP004 무보증 청구 정액 외에는 사용하지 않는다. */
  depositState?: 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
  vehicleValue?: number;
  /** Same product and pricing variant: 36-month monthly rental amount, not total rent. */
  billin36MonthlyRent?: number | undefined;
  newProductSubtype?: 'NEW_PREDELIVERY' | 'NEW_MATCHING';
  /** Explicit contractual tier, never inferred from a deposit amount. */
  depositTierPercent?: 5 | 10;
  subscriptionForm?: 'BUYOUT' | 'RETURN';
  subscriptionFormConflict?: boolean;
  q12Basis?: { amount: number; sourceRef: string };
  /** 뮤카: 보증금 선납/분납(접수 납입 방식). 추정하지 않는다. */
  depositPayment?: 'PREPAID' | 'INSTALLMENT';
  /** 계약일(YYYY-MM-DD). 뮤카 분납은 계약일이 정책 효력일(2026-10-05) 전이냐 후냐로 갈린다 — 모르면 분납을 계산하지 않는다. */
  contractDate?: string;
  /** 뮤카: 추가보증금(원, 없으면 0 을 명시). 모르면 넣지 않는다 — 계산하지 않는다. */
  extraDeposit?: number;
  /** 뮤카 선납 GA 정액의 차종 구분 — DOMESTIC = 국산, PREMIUM = 제네시스·수입·테슬라·카니발 하이리무진. mewcarBrandClassFromSource 로만 정한다. */
  mewcarBrandClass?: 'DOMESTIC' | 'PREMIUM';
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
export type SonokongQ12BasisCandidate = {
  termMonths: number;
  settlement?: 'BUYOUT' | 'RETURN' | undefined;
  mileageKm?: number | null | undefined;
  mileagePeriod?: 'month' | 'year' | undefined;
  currency: string;
  amount: number;
  sourceRef: string;
};

export function matchesReferenceRentBasisCandidate(target: SonokongQ12BasisCandidate, candidate: SonokongQ12BasisCandidate, termMonths: 12 | 36): boolean {
  return candidate.termMonths === termMonths &&
    candidate.settlement === target.settlement &&
    candidate.mileageKm === target.mileageKm &&
    (candidate.mileagePeriod ?? 'year') === (target.mileagePeriod ?? 'year') &&
    candidate.currency === target.currency &&
    Number.isSafeInteger(candidate.amount) && candidate.amount > 0;
}

export function resolveSubscriptionFormForTerm(
  explicit: 'BUYOUT' | 'RETURN' | undefined,
  priceKeySettlement: 'BUYOUT' | 'RETURN' | undefined,
): { subscriptionForm?: 'BUYOUT' | 'RETURN'; conflict?: true } {
  if (explicit && priceKeySettlement && explicit !== priceKeySettlement) return { conflict: true };
  const subscriptionForm = explicit ?? priceKeySettlement;
  return subscriptionForm ? { subscriptionForm } : {};
}

export function selectSonokongQ12Basis(target: SonokongQ12BasisCandidate, candidates: readonly SonokongQ12BasisCandidate[]): CommissionInput['q12Basis'] | undefined {
  if (target.termMonths === 12 && Number.isSafeInteger(target.amount) && target.amount > 0) {
    return { amount: target.amount, sourceRef: target.sourceRef };
  }
  const matching = candidates.filter(candidate => matchesReferenceRentBasisCandidate(target, candidate, 12));
  return matching.length === 1 ? { amount: matching[0]!.amount, sourceRef: matching[0]!.sourceRef } : undefined;
}

export function validateSonokongQ12Basis(
  explicitQ12: CommissionInput['q12Basis'] | undefined,
  target: SonokongQ12BasisCandidate,
  candidates: readonly SonokongQ12BasisCandidate[],
): { q12Basis?: CommissionInput['q12Basis']; reasonCode?: 'OGONG_12M_BASE_MISSING' | 'Q12_BASIS_CONFLICT' } {
  if (!explicitQ12) return {};
  const matching = candidates.filter(candidate => matchesReferenceRentBasisCandidate(target, candidate, 12));
  if (matching.length !== 1) return { reasonCode: 'OGONG_12M_BASE_MISSING' };
  if (matching[0]!.amount !== explicitQ12.amount) return { reasonCode: 'Q12_BASIS_CONFLICT' };
  return { q12Basis: { amount: explicitQ12.amount, sourceRef: matching[0]!.sourceRef } };
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
  const term = input.termMonths as 12 | 24 | 36 | 48 | 60;
  if (![12, 24, 36, 48, 60].includes(term)) return unknownCommission('MEWCAR_TERM_NOT_IN_POLICY');
  if (side === 'BILLING') {
    if (term === 60) return unknownCommission('MEWCAR_TERM_NOT_IN_POLICY');
    if (!Number.isSafeInteger(input.vehicleValue) || input.vehicleValue! <= 0) return unknownCommission('MEWCAR_BASE_PRICE_REQUIRED');
    return calculatedCommission('MEWCAR_FREEPASS_SHARE_BILLING', input.vehicleValue! * rule.billingBasisPoints / 10000, 'EXCLUDED');
  }
  if (input.depositPayment !== 'PREPAID' && input.depositPayment !== 'INSTALLMENT') return unknownCommission('MEWCAR_DEPOSIT_PAYMENT_REQUIRED');
  if (input.depositPayment === 'INSTALLMENT') {
    if (term === 60) return unknownCommission('MEWCAR_TERM_NOT_IN_POLICY');
    // 분납은 10-05 이후 폐지 — 계약일을 모르면 어느 규칙인지 모르므로 멈추고, 효력일 이후면 «확인 필요»로 멈춘다(옛 정액을 내지 않는다).
    if (!isCalendarDate(input.contractDate)) return unknownCommission('MEWCAR_CONTRACT_DATE_REQUIRED');
    if (input.contractDate! >= rule.installmentAbolishedFrom) return unknownCommission('MEWCAR_INSTALLMENT_ABOLISHED_CONFIRM_REQUIRED');
  }
  const prepaid = input.depositPayment === 'PREPAID';
  if (!Number.isSafeInteger(input.extraDeposit) || input.extraDeposit! < 0) return unknownCommission('MEWCAR_EXTRA_DEPOSIT_REQUIRED');
  if (prepaid && input.contractDate !== undefined) {
    if (!isCalendarDate(input.contractDate)) return unknownCommission('MEWCAR_CONTRACT_DATE_REQUIRED');
    if (input.contractDate < rule.prepaidBrandFeeContractFrom) return unknownCommission('MEWCAR_PREPAID_PRE_BRAND_RULE_CONFIRM_REQUIRED');
  }
  // 선납 정액은 차종 구분별(대표 10-28) — 구분을 모르면 둘 중 하나로 고르지 않는다.
  if (prepaid && input.mewcarBrandClass !== 'DOMESTIC' && input.mewcarBrandClass !== 'PREMIUM') return unknownCommission('MEWCAR_BRAND_CLASS_REQUIRED');
  const addition = Math.min(Math.round(input.extraDeposit! * rule.extraDepositPercent / 100), prepaid ? rule.extraDepositCap : rule.installmentExtraDepositCap);
  const baseAmount = prepaid ? rule.payout.PREPAID[input.mewcarBrandClass!][term] : rule.payout.INSTALLMENT[term as 12 | 24 | 36 | 48];
  return calculatedCommission(prepaid ? `MEWCAR_GA_PREPAID_${input.mewcarBrandClass}_${term}_PAYOUT` : `MEWCAR_GA_INSTALLMENT_${term}_PAYOUT`,
    baseAmount + addition, 'EXCLUDED');
}

/** 국내에서만 만드는 제조사(origin 수입이면 어긋남) / 국산으로 볼 수 있는 제조사 전체(르노·쉐보레는 수입 차종도 있어 origin 을 따른다). */
const MEWCAR_DOMESTIC_ONLY_MAKERS = /^(현대|기아|KGM|KG모빌리티|쌍용)$/;
const MEWCAR_DOMESTIC_MAKERS = /^(현대|기아|KGM|KG모빌리티|쌍용|르노|르노코리아|르노삼성|쉐보레|한국GM)$/;
/**
 * 뮤카 선납 GA 정액의 차종 구분을 상품 칸에서만 읽는다(gnafit latestBrandPolicy 와 같은 갈래).
 * 테슬라·제네시스 = maker(국산/수입 어느 쪽이어도 같은 PREMIUM 값이라 origin 이 비어도 정한다, 어긋나면 멈춤),
 * 국산/수입 = origin, 카니발 하이리무진 = sub_model·trim_name(정형 칸) 우선, model·car_name 은 정형 칸이 비었을 때만.
 * origin 이 없거나 maker 와 어긋나거나 차명이 없거나 이름이 서로 다르면 구분하지 않는다(추정 금지 → MEWCAR_BRAND_CLASS_REQUIRED).
 */
export function mewcarBrandClassFromSource(source: Rec): 'DOMESTIC' | 'PREMIUM' | undefined {
  const maker = text(source.maker);
  const origin = text(source.origin);
  if (!maker) return undefined;
  const tesla = /^(테슬라|tesla)$/i.test(maker), genesis = /^(제네시스|genesis)$/i.test(maker);
  if (tesla) return origin === '' || origin === '수입' ? 'PREMIUM' : undefined;
  if (genesis) return origin === '' || origin === '국산' ? 'PREMIUM' : undefined;
  if (origin === '수입') return MEWCAR_DOMESTIC_ONLY_MAKERS.test(maker) ? undefined : 'PREMIUM';
  if (origin !== '국산' || !MEWCAR_DOMESTIC_MAKERS.test(maker)) return undefined;
  const structured = [source.sub_model, source.trim_name].map(text).filter(Boolean);
  const free = [source.model, source.car_name].map(text).filter(Boolean);
  // 차명이 없으면 카니발 하이리무진인지 알 수 없다.
  if (!structured.length && !free.length) return undefined;
  const carnival = (name: string) => /카니발|carnival/i.test(name);
  if (![...structured, ...free].some(carnival)) return 'DOMESTIC';
  // 모델과 세부모델이 카니발 여부에서 갈리면(예: 모델 쏘렌토·세부모델 카니발) 어느 차인지 모른다.
  const model = text(source.model), subModel = text(source.sub_model);
  if (model && subModel && carnival(model) !== carnival(subModel)) return undefined;
  const highLimousine = (name: string) => /하이[\s-]*리무진|(?:high|hi)[\s-]*limousine/i.test(name);
  if (structured.some(highLimousine)) return 'PREMIUM';
  if (!free.some(highLimousine)) return 'DOMESTIC';
  // 정형 칸(세부모델·트림)은 하이리무진이 아닌데 자유 이름만 하이리무진이면 어느 쪽인지 모른다.
  return structured.length ? undefined : 'PREMIUM';
}

function resolveCommissionAmount(input: CommissionInput, side: 'BILLING' | 'PAYOUT'): CommissionResolution {
  const { supplierId, termMonths, monthlyRent } = input;
  const rounding: RoundingMode = supplierId === 'RP012' ? 'TRUNC' : 'ROUND';
  const rawProduct = input.productType.trim();
  const inferredSubtype = rawProduct === '견적출고' ? 'NEW_MATCHING' : rawProduct === '선출고' ? 'NEW_PREDELIVERY' : undefined;
  if (inferredSubtype && input.newProductSubtype && inferredSubtype !== input.newProductSubtype) return unknownCommission('CONFLICTING_NEW_PRODUCT_SUBTYPE');
  if (inferredSubtype && !input.newProductSubtype) input = { ...input, newProductSubtype: inferredSubtype };
  const productType = inferredSubtype ? '신차렌트' : rawProduct === '장기렌트' ? '재렌트' : rawProduct;
  const supplierPolicy = getSupplierCommissionPolicy(supplierId);
  if (productType === '신차렌트' && !input.newProductSubtype && supplierPolicy?.newRentDefaultSubtype)
    input = { ...input, newProductSubtype: supplierPolicy.newRentDefaultSubtype };
  const billing = side === 'BILLING';
  const fixed = (id: string, amount: number, vat: VatTreatment = 'EXCLUDED') => calculatedCommission(id, amount, vat, rounding);
  const fixedRule = (id: string) => {
    const rule = KAKAO_COMMISSION_POLICY.rules.find(rule => rule.id === id);
    return rule && 'fixedAmount' in rule && typeof rule.fixedAmount === 'number'
      ? fixed(id, rule.fixedAmount, 'vatTreatment' in rule ? rule.vatTreatment : 'EXCLUDED')
      : unknownCommission('COMMISSION_POLICY_RULE_REQUIRED');
  };
  const agreement = input.individualAgreement;
  const hasAgreement = agreement !== undefined;
  if (!hasAgreement && input.individualExceptionEvidence !== undefined) {
    return unknownCommission('LEGACY_INDIVIDUAL_EXCEPTION_INPUT');
  }
  if (supplierId === 'RP034') return { ...unknownCommission('SUPPLIER_EXCLUDED_BY_DECISION'), state: 'NOT_APPLICABLE' };
  if (!Number.isSafeInteger(termMonths) || termMonths < 1 || !Number.isSafeInteger(monthlyRent) || monthlyRent < 0) return unknownCommission('INVALID_PRICE_TERM_INPUT');
  if (hasAgreement && (!agreement || typeof agreement !== 'object' || Array.isArray(agreement))) return unknownCommission('INDIVIDUAL_AGREEMENT_INVALID');
  // 대표 2026-10-28 정정: 아이카 무보증만 청구·지급 500,000원이며, 그 외에는 기존 지급 사다리를 따른다.
  if (supplierId === 'RP004' && !billing && input.depositState === 'ZERO') {
    const billed = resolveCommissionAmount(input, 'BILLING');
    if (billed.state !== 'CALCULATED' && billed.state !== 'CALCULATED_APPROX') return billed;
    return { ...billed, ruleId: billed.ruleId?.replace('_BILLING_', '_PAYOUT_EQUALS_BILLING_')
      .replace(/_BILLING$/, '_PAYOUT_EQUALS_BILLING') ?? 'IANCAR_PAYOUT_EQUALS_BILLING' };
  }
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
    if (SONOKONG_PICKUP_PROXY_TERM_MONTHS.includes(termMonths as never)) {
      const base = resolveTermLadder(termMonths, monthlyRent, side, 'STANDARD_RERENT', rounding);
      if (base.state !== 'CALCULATED' || base.amount === null) return base;
      return billing
        ? approximateCommission(`SONOKONG_PICKUP_${termMonths}_BILLING_RERENT_LADDER`, base.amount, 'EXCLUDED', 'SONOKONG_PICKUP_TERM_PROXY_RERENT', rounding)
        : approximateCommission(`SONOKONG_PICKUP_${termMonths}_PAYOUT_RERENT_LADDER`, base.amount, 'EXCLUDED', 'SONOKONG_PICKUP_TERM_PROXY_RERENT', rounding);
    }
    if (termMonths !== 60) return unknownCommission('TERM_NOT_IN_F04_COMMISSION_POLICY');
    const rule = KAKAO_COMMISSION_POLICY.rules.find(rule => rule.id === 'SONOKONG_PICKUP_60_RENT_X_TERM')!;
    const rate = billing ? rule.billingBasisPoints : rule.payoutBasisPoints;
    return approximateCommission(`SONOKONG_PICKUP_60_${side}_RENT_X_TERM`, monthlyRent * termMonths * rate / 10000,
      'EXCLUDED', 'SONOKONG_PICKUP_60_PROVISIONAL_ROW191', rounding);
  }
  if (supplierPolicy?.billinSubscription && subscription) {
    const basis = input.billin36MonthlyRent ?? (termMonths === 36 ? monthlyRent : undefined);
    if (!Number.isSafeInteger(basis) || basis! <= 0) return unknownCommission('BILLIN_36_MONTH_RENT_REQUIRED');
    if (termMonths === 36 && basis !== monthlyRent) return unknownCommission('BILLIN_36_MONTH_RENT_CONFLICT');
    const rule = KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.billinProposal;
    return fixed(`BILLIN_SUBSCRIPTION_36_RENT_${side}`, basis! * rule.billingPercent / 100 * (billing ? 1 : rule.payoutPercentOfBilling / 100));
  }
  if (supplierId === 'RP012' && subscription) {
    if (ogongTermAddon(termMonths) === null) return unknownCommission('TERM_NOT_IN_F04_COMMISSION_POLICY');
    if (input.subscriptionFormConflict) return unknownCommission('SUBSCRIPTION_FORM_CONFLICT');
    if (!input.q12Basis || !Number.isSafeInteger(input.q12Basis.amount) || input.q12Basis.amount <= 0 || !text(input.q12Basis.sourceRef)) return unknownCommission('OGONG_12M_BASE_MISSING');
    const amount = billing ? computeOgongBillingAmount({ rent12: input.q12Basis.amount, termMonths }) : input.q12Basis.amount;
    if (amount === null) return unknownCommission('TERM_NOT_IN_F04_COMMISSION_POLICY');
    if (billing && amount < 0) return unknownCommission('NEGATIVE_BILLING_CONFIRM_REQUIRED');
    if (termMonths === 12) return billing
      ? fixed(`SONOKONG_SUBSCRIPTION_${termMonths}_${side}`, amount)
      : fixed(`SONOKONG_SUBSCRIPTION_${termMonths}_${side}`, amount);
    if (input.subscriptionForm === 'RETURN') return unknownCommission('RETURN_SUBSCRIPTION_TERM_NOT_SUPPORTED');
    if (input.subscriptionForm !== 'BUYOUT' && input.subscriptionForm !== 'RETURN') return unknownCommission('SUBSCRIPTION_FORM_REQUIRED');
    return billing
      ? fixed(`SONOKONG_SUBSCRIPTION_${termMonths}_${side}`, amount)
      : fixed(`SONOKONG_SUBSCRIPTION_${termMonths}_${side}`, amount);
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.star.includes(supplierId as 'RP018') && rerent) {
    const id = billing ? 'STAR_RERENT_ONE_MONTH_RENT_BILLING' : 'STAR_RERENT_ONE_MONTH_RENT_X_80_PERCENT';
    const rule = KAKAO_COMMISSION_POLICY.rules.find(rule => rule.id === id)!;
    if (!('rateBasisPoints' in rule) || typeof rule.rateBasisPoints !== 'number' || !('vatTreatment' in rule)) return unknownCommission('COMMISSION_POLICY_RULE_REQUIRED');
    return fixed(id, monthlyRent * rule.rateBasisPoints / 10000, rule.vatTreatment);
  }
  // F04 161행 계약기간 「기간 무관」(123행 일반 구독과 같음): 기간 검증 없이 정액.
  // 전기 구독(161행)은 연료가 정확히 «전기»일 때만 — «가솔린+전기» 같은 하이브리드는 일반 구독(123행).
  if (supplierId === 'RP023' && subscription && isExactElectricFuel(input.fuel)) {
    const rule = KAKAO_COMMISSION_POLICY.rules.find(rule => rule.id === 'AUTOPLUS_EV_SUBSCRIPTION')!;
    return fixed(`AUTOPLUS_EV_SUBSCRIPTION_${side}`, billing ? rule.billing : rule.payout);
  }
  if (supplierId === 'RP023' && subscription && !text(input.fuel)) return unknownCommission('FUEL_REQUIRED_FOR_SUPPLIER_RULE');
  if (supplierId === 'RP023' && subscription) return fixedRule(billing ? 'AUTOPLUS_SUBSCRIPTION_BILLING_FIXED' : 'AUTOPLUS_SUBSCRIPTION_FIXED');
  if (supplierId === 'RP014' && subscription) return resolveTermLadder(termMonths, monthlyRent, side, 'SWITCH_SUBSCRIPTION');
  if (supplierId === 'RP004') {
    if (billing && input.depositState === 'ZERO') return fixed('IANCAR_DEPOSIT_FREE_BILLING_FIXED', 500000);
    if (!subscription && (rerent || input.newProductSubtype === 'NEW_PREDELIVERY') && !text(input.fuel)) return unknownCommission('FUEL_REQUIRED_FOR_SUPPLIER_RULE');
    if (!subscription && (rerent || (productType === '신차렌트' && input.newProductSubtype === 'NEW_PREDELIVERY')) && isExactElectricFuel(input.fuel)) return fixedRule(billing ? 'IANCAR_EV_BILLING_FIXED' : 'IANCAR_EV_FIXED');
    if (rerent && termMonths === 6) return fixedRule(billing ? 'IANCAR_RERENT_6_MONTH_BILLING_FIXED' : 'IANCAR_RERENT_6_MONTH_FIXED');
    if (rerent && termMonths === 1) return unknownCommission('IANCAR_SHORT_TERM_BASIS_REQUIRED');
  }
  // 이안카(RP031) 대표 10-31 결정: 수수료 = 월 렌트료 × 기간 배수(나눗셈 없음), 영업자 지급 = 그 80%. 선출고(신차)도 같은 배수, 매칭출고는 사람이 정한다(아래 기존 규칙).
  if (supplierId === 'RP031' && (rerent || subscription || (/^신차/.test(productType) && input.newProductSubtype === 'NEW_PREDELIVERY'))) {
    // 비정형 기간은 대표 10-28 규칙대로 «더 짧은 가장 가까운 표준 기간»(1·3·5·12·24·36·48·60). 1개월 미만 같은 표 밖 값만 확인 필요.
    const appliedTerm = Object.keys(IANCAR_RENT_MULTIPLE_PERCENT).map(Number).filter(term => term <= termMonths).pop() ?? termMonths;
    const percent = IANCAR_RENT_MULTIPLE_PERCENT[appliedTerm];
    if (percent === undefined) return unknownCommission('TERM_NOT_IN_F04_COMMISSION_POLICY');
    const result = fixed(`IANCAR_RENT_MULTIPLE_${appliedTerm}_${side}`, monthlyRent * percent * (billing ? 100 : 80) / 10000, 'EXCLUDED');
    return appliedTerm === termMonths ? result : { ...result, note: `NONSTANDARD_TERM_NEAREST_SHORTER_STANDARD(${termMonths}→${appliedTerm})` };
  }
  if (!standardLadderSupplier(supplierId)) return unknownCommission('SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE');
  // 기본 회사(대표 10-28 표준표)는 청구도 지급과 같이 비정형 기간을 가까운 짧은 표준 기간으로 본다 — 아이언(RP006)은 #801.
  const nonstandardBilling = side === 'BILLING' && (supplierId === 'RP006' || supplierPolicy?.basicSubscription === true);
  if (subscription && supplierPolicy?.basicSubscription) {
    return resolveTermLadder(termMonths, monthlyRent, side, 'STANDARD_RERENT', rounding, nonstandardBilling);
  }
  // 손오공 재렌트·중고렌트는 F04 기간표 값 그대로(보험료 −100,000 차감은 오공구독 청구에만 — 지휘통제실 2026-10-12).
  if (rerent) return resolveTermLadder(termMonths, monthlyRent, side, 'STANDARD_RERENT', rounding, nonstandardBilling);
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
    const ruleId = billing ? supplierId === 'RP006' ? 'IRON_NEW_PREDELIVERY_BILLING' : 'STANDARD_NEW_PREDELIVERY_BILLING_3_5_PERCENT' : 'STANDARD_NEW_PREDELIVERY_3_PERCENT';
    const rule = KAKAO_COMMISSION_POLICY.rules.find(rule => rule.id === ruleId)!;
    if (!('rateBasisPoints' in rule) || typeof rule.rateBasisPoints !== 'number' || !('vatTreatment' in rule)) return unknownCommission('COMMISSION_POLICY_RULE_REQUIRED');
    return fixed(`${supplierId === 'RP006' ? 'IRON' : 'STANDARD'}_NEW_PREDELIVERY_${side}`, input.vehicleValue! * rule.rateBasisPoints / 10000, rule.vatTreatment);
  }
  return unknownCommission(subscription ? 'SUBSCRIPTION_RULE_SCOPE_UNCONFIRMED' : 'NO_MATCHING_RULE');
}

/**
 * 대표 10-28 표준표 결정이 근거인 결과 표시: 기본 회사의 신차 선출고(출고 방식 미기재 기본값은 원천 투영에서 이미 채워져 오므로
 * 명시·기본값을 가르지 않는다)와 청구 비정형 기간.
 */
function contractWriterStandardApplied(input: CommissionInput, side: 'BILLING' | 'PAYOUT', result: CommissionResolution): boolean {
  if (!KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.basicSupplierIds.some(id => id === input.supplierId)) return false;
  const newPredelivery = result.ruleId?.includes('NEW_PREDELIVERY') === true;
  const nonstandardBilling = side === 'BILLING' && result.note?.startsWith('NONSTANDARD_TERM_NEAREST_SHORTER_STANDARD(') === true;
  return newPredelivery || nonstandardBilling;
}

function resolveCommission(input: CommissionInput, side: 'BILLING' | 'PAYOUT'): CommissionResolution {
  const result = resolveCommissionAmount(input, side);
  const id = result.ruleId ?? '';
  const product = input.productType.trim();
  const first = supplierFirstRow[input.supplierId];
  const appliedTerm = Number(/NONSTANDARD_TERM_NEAREST_SHORTER_STANDARD\([1-9][0-9]*→(1|3|5|12|24|36|48|60)\)/.exec(result.note ?? '')?.[1] ?? input.termMonths);
  let rows: number[] = [];
  if (input.individualException || input.individualAgreement || input.individualExceptionEvidence !== undefined) rows = input.individualAgreement ? [input.individualAgreement.sourceRow] : [160, 163];
  else if (input.supplierId === 'RP034') rows = [168];
  else if (input.supplierId === KAKAO_COMMISSION_POLICY.mewcar.supplierId) rows = [...KAKAO_COMMISSION_POLICY.mewcar.sourceRows];
  else if (input.supplierId === 'RP012' && /^픽업\s*구독/.test(product)) rows = input.termMonths === 60 ? [191] : input.termMonths === 12 ? [5] : input.termMonths === 24 ? [6] : input.termMonths === 36 ? [7] : input.termMonths === 48 ? [8] : [];
  else if (input.supplierId === 'RP012' && /구독/.test(product)) rows = [({12:10,24:11,36:12,48:13,60:14} as Record<number, number>)[input.termMonths] ?? 183, 173, 191];
  else if (input.supplierId === 'RP023' && /구독/.test(product)) rows = isExactElectricFuel(input.fuel) ? [161] : [123, 161];
  else if (['RP021', 'PT-0026'].includes(input.supplierId) && /구독/.test(product)) rows = [162];
  else if (input.supplierId === 'RP014') rows = /구독/.test(product) ? ([12,24,36,48,60].includes(appliedTerm) ? [124 + [12,24,36,48,60].indexOf(appliedTerm)] : [183,184,185,186,187,188,189]) : [175,176];
  else if (/구독/.test(product) && first && KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.basicSupplierIds.some(supplierId => supplierId === input.supplierId)) {
    const index = [12,24,36,48,60].indexOf(appliedTerm);
    rows = index >= 0 ? [first + 2 + index] : [183,184,185,186,187,188,189];
  }
  else if (input.supplierId === 'RP013' && /구독|발주/.test(product)) rows = /구독/.test(product) ? [174] : [164];
  else if (input.supplierId === 'RP031' && /재렌트|중고렌트|장기렌트|구독|선출고|신차/.test(product) && !/견적출고/.test(product)) rows = [22, 23, 24, 25, 26, 27, 28];
  else if (id.startsWith('IANCAR_EV')) rows = [138];
  else if (id.startsWith('IANCAR_RERENT_6')) rows = [132];
  else if (result.reasonCode === 'IANCAR_SHORT_TERM_BASIS_REQUIRED') rows = [131];
  else if (first) {
    if (/신차|선출고|견적출고/.test(product) && !/구독/.test(product)) rows = [first + (input.newProductSubtype === 'NEW_MATCHING' || product === '견적출고' ? 1 : 0)];
    else if (['RP018','RP033'].includes(input.supplierId)) rows = [first + 2];
    else { const offset = [12,24,36,48,60].indexOf(appliedTerm); rows = offset < 0 ? [183,184,185,186,187,188,189] : [first + (input.supplierId === 'RP004' ? 4 : 2) + offset]; }
  } else rows = [177,178,179,180,181,182];
  if (result.reasonCode === 'WON_ROUNDING_POLICY_UNCONFIRMED') rows.push(171);
  if (result.reasonCode === 'DEPOSIT_TIER_REQUIRED') rows.push(172);
  // 근거 행은 계산된 결과에만 단다. UNKNOWN·NOT_APPLICABLE·협의는 reasonCode만 — 미등록 공급사가 「근거 있는 규칙」처럼 보이지 않게.
  if (result.state !== 'CALCULATED' && result.state !== 'CALCULATED_APPROX') return result;
  if (id.startsWith('STANDARD_RERENT_1_')) return { ...result, sourceRefs: [KAKAO_COMMISSION_POLICY.oneMonthBasic.sourceRef] };
  if (id.startsWith('BILLIN_SUBSCRIPTION_36_RENT')) return { ...result, sourceRefs: ['USER:2026-10-09:BILLIN_LC_36_MONTH_RENT_100_80'] };
  const notes = [
    ...(id.startsWith('SONOKONG_SUBSCRIPTION_') && side === 'BILLING' ? ['OGONG_12M_BASE_MINUS_INSURANCE_2026-10-12'] : []),
    ...(result.note ? [result.note] : []),
    ...(side === 'PAYOUT' && result.note?.startsWith('NONSTANDARD_TERM_NEAREST_SHORTER_STANDARD(') ? ['ledger:59c7c3ba'] : []),
    ...(side === 'BILLING' && input.supplierId === 'RP006' && result.note?.startsWith('NONSTANDARD_TERM_NEAREST_SHORTER_STANDARD(') ? ['ledger:59c7c3ba'] : []),
    ...(contractWriterStandardApplied(input, side, result) ? [KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.contractWriterStandard.sourceRef] : []),
    ...(id.startsWith('MEWCAR_GA_PREPAID_') ? [KAKAO_COMMISSION_POLICY.mewcar.brandFeeSourceRef] : []),
    ...(side === 'PAYOUT' && input.supplierId === 'RP004' && input.depositState === 'ZERO'
      ? ['ledger:2026-10-28-rp004-payout-equals-billing'] : []),
  ];
  return { ...result, sourceRefs: [...new Set([...new Set(rows)].map(f04Ref).concat(notes))] };
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
  'vehicleValue' | 'newProductSubtype' | 'depositTierPercent' | 'subscriptionForm' | 'q12Basis' |
  'depositPayment' | 'extraDeposit' | 'mewcarBrandClass' | 'contractDate' | 'individualException' | 'individualAgreement' | 'individualExceptionEvidence'>>>>;

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

/**
 * 공급사 원문 「구분」 칸이 «신차(선출고)» 처럼 출고 방식을 괄호로 직접 적은 경우만 신차 세부조건으로 읽는다(예: 이안카 시트).
 * 「신차」「즉시출고」 같은 말은 선출고/견적출고를 가리지 못하므로 읽지 않는다 — 추정 금지, 없으면 NEW_PRODUCT_SUBTYPE_REQUIRED 유지.
 */
export function explicitNewProductSubtypeFromSource(source: Rec): 'NEW_PREDELIVERY' | 'NEW_MATCHING' | undefined {
  if (text(source.product_type) !== '신차렌트') return undefined;
  const stated = statedNewProductSubtype(source);
  // 대표 2026-10-12: 아이언(RP006)·우리캐피탈렌더카(RP020)는 시트의 신차렌트를 차량가액 기준 선출고 규칙(F04 139·50행)으로 읽는다.
  // 대표 2026-10-28: 기본 회사(계약서를 프리패스가 써 주는 곳)도 표준표의 선출고로 읽는다. 원문에 견적출고가 명시되면 그것이 우선(위 stated).
  return stated ?? getSupplierCommissionPolicy(text(source.provider_company_code))?.newRentDefaultSubtype ?? undefined;
}

export function statedNewProductSubtype(source: Rec): 'NEW_PREDELIVERY' | 'NEW_MATCHING' | undefined {
  const raw = source['원문'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const all = (raw as Rec)['전체'];
  const holder = all && typeof all === 'object' && !Array.isArray(all) ? all as Rec : raw as Rec;
  const m = /^신차\s*\(\s*(선출고|견적출고)\s*\)$/.exec(text(holder['구분']));
  return m ? (m[1] === '선출고' ? 'NEW_PREDELIVERY' : 'NEW_MATCHING') : undefined;
}

export type ReferenceSourceScope = 'LISTABLE' | 'COLLECTED';
export function buildKakaoCatalogReferenceProduct(documentId: string, source: Rec, evidenceByTerm: CommissionEvidenceByTerm = {}, policies: Record<string, Rec> = {}, observedAt?: string, sourceScope: ReferenceSourceScope = 'LISTABLE', rawVehicleValueEvidence: VehicleValueEvidence | null = null) {
  const collected = sourceScope === 'COLLECTED';
  if (!collected && source.listable !== true) return null;
  const supplierId = text(source.provider_company_code);
  if (!collected && !supplierId) return null;
  // 이안카 별칭 키(기간만 있는 복사본)는 조건이 아니므로 뺀다 — 6087 60개월이 4행(별칭+3구간)이 아니라 3행(주행 3종)으로 나오게.
  const price = source.price && typeof source.price === 'object' && !Array.isArray(source.price) ? priceWithoutIancarAliases(source) : {};
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
      const resolvedCandidateSubscriptionForm = resolveSubscriptionFormForTerm(
        evidenceByTerm[key]?.subscriptionForm,
        candidate.settlement,
      );
      if (resolvedCandidateSubscriptionForm.conflict) return [];
      const amount = integer((value as Rec).rent);
      return amount !== null && amount > 0 ? [{
        termMonths: candidate.months,
        settlement: resolvedCandidateSubscriptionForm.subscriptionForm,
        mileageKm: candidate.contractedMileage?.km ?? candidate.mileageKm,
        mileagePeriod: candidate.contractedMileage?.period ?? 'year',
        currency: 'KRW',
        amount,
        sourceRef: key,
      }] : [];
    });
    const resolvedSubscriptionForm = resolveSubscriptionFormForTerm(
      evidenceByTerm[sourceKey]?.subscriptionForm,
      parsed.settlement,
    );
    const automaticQ12 = resolvedSubscriptionForm.conflict ? undefined : selectSonokongQ12Basis({
      termMonths: parsed.months,
      settlement: resolvedSubscriptionForm.subscriptionForm,
      mileageKm: parsed.contractedMileage?.km ?? parsed.mileageKm,
      mileagePeriod: parsed.contractedMileage?.period ?? 'year',
      currency: 'KRW',
      amount: monthlyRent,
      sourceRef: `source-product:${documentId}#price:${sourceKey}`,
    }, q12Candidates);
    const explicitQ12Result = supplierId === 'RP012' && text(source.product_type)?.replace(/\s+/g, '').includes('오공구독') && !resolvedSubscriptionForm.conflict
      ? validateSonokongQ12Basis(evidenceByTerm[sourceKey]?.q12Basis, {
        termMonths: parsed.months,
        settlement: resolvedSubscriptionForm.subscriptionForm,
        mileageKm: parsed.contractedMileage?.km ?? parsed.mileageKm,
        mileagePeriod: parsed.contractedMileage?.period ?? 'year',
        currency: 'KRW',
        amount: monthlyRent,
        sourceRef: `source-product:${documentId}#price:${sourceKey}`,
      }, q12Candidates)
      : {};
    const subscriptionForm = resolvedSubscriptionForm.subscriptionForm;
    const sourceMewcarBrandClass = supplierId === KAKAO_COMMISSION_POLICY.mewcar.supplierId ? mewcarBrandClassFromSource(source) : undefined;
    const automaticCommissionEvidence = {
      ...(supplierId === 'RP012' && text(source.product_type)?.replace(/\s+/g, '').includes('오공구독') && automaticQ12 && !evidenceByTerm[sourceKey]?.q12Basis ? { q12Basis: automaticQ12 } : {}),
      ...(supplierId === 'RP012' && text(source.product_type)?.replace(/\s+/g, '').includes('오공구독') && explicitQ12Result.q12Basis ? { q12Basis: explicitQ12Result.q12Basis } : {}),
      ...(supplierId === 'RP012' && text(source.product_type)?.replace(/\s+/g, '').includes('오공구독') && subscriptionForm ? { subscriptionForm } : {}),
      ...(supplierId === 'RP012' && text(source.product_type)?.replace(/\s+/g, '').includes('오공구독') && resolvedSubscriptionForm.conflict ? { subscriptionFormConflict: true as const } : {}),
      // 뮤카 차종 구분은 상품 칸에서만 — 증거 입력이 따로 넘긴 값은 아래 effectiveEvidence 에서 뺀다.
      ...(sourceMewcarBrandClass ? { mewcarBrandClass: sourceMewcarBrandClass } : {}),
    } satisfies Partial<Pick<CommissionInput, 'q12Basis' | 'subscriptionForm' | 'subscriptionFormConflict' | 'mewcarBrandClass'>>;
    const { mewcarBrandClass: _sourceOnlyBrandClass, ...termEvidence } = evidenceByTerm[sourceKey] ?? {};
    const { q12Basis: _ignoredInvalidQ12Basis, ...evidenceWithoutQ12 } = termEvidence;
    const effectiveEvidence = explicitQ12Result.reasonCode ? evidenceWithoutQ12 : termEvidence;
    const depositInput = depositEvidenceInputFromProduct(source, (raw as Rec).deposit, {
      termMonths: parsed.months,
      monthlyRent,
      hasPositivePaidDeposit: hasConflictingPaidDeposit(price),
    });
    // 이안카(RP031)는 원천 엔진 근거만 쓴다(옛 1차 발행 칸 iancar_phase_one 은 근거가 아님). 엔진 근거가 없으면 미확인.
    const publishedDeposit = supplierId === 'RP031' ? readIancarEngineDeposit(source, sourceKey, observedAt, { preserveStalePositiveReference: true }) : null;
    const deposit = publishedDeposit ? {
      depositAmount: publishedDeposit.amount,
      depositState: publishedDeposit.state,
      depositRule: publishedDeposit.state === 'UNKNOWN' ? null : {
        code: publishedDeposit.reason, multiplier: null,
        label: '공급사 기간·주행거리 조건',
        ...('depositEvidenceBasis' in publishedDeposit ? { depositEvidenceBasis: publishedDeposit.depositEvidenceBasis } : {}),
      },
    } : resolveReferenceDeposit(depositInput);
    const depositEvidence = {
      sourceRef: `source-product:${documentId}#price:${sourceKey}`,
      sourceAmount: typeof (raw as Rec).deposit === 'number' || typeof (raw as Rec).deposit === 'string' ? (raw as Rec).deposit as number | string : null,
      sourceNote: text(source.deposit_note) || null,
      reasonCode: publishedDeposit?.reason ?? deposit.depositRule?.code ?? assessDepositEvidence(depositInput).reason,
    };
    const vehicleValueEvidence = publicVehicleValueEvidence(evidenceByTerm[sourceKey]?.vehicleValue ? rawVehicleValueEvidence : null);
    const withVehicleValueEvidence = (fee: CommissionResolution) => {
      const { approximate: _approximate, note, ...publicFee } = fee;
      return {
        ...publicFee,
        ...(fee.state === 'CALCULATED_APPROX' && note && !fee.reasonCode ? { reasonCode: note } : {}),
        ...(fee.state === 'CALCULATED' && vehicleValueEvidence?.grade === 'APPROX' ? { state: 'CALCULATED_APPROX' as const } : {}),
        ...(fee.state === 'CALCULATED' && vehicleValueEvidence ? { vehicleValueEvidence } : {}),
      };
    };
    const explicitSubtype = explicitNewProductSubtypeFromSource(source);
    // 원문이 직접 적은 출고 방식(예: 견적출고)과 증거 입력의 subtype 이 다르면 어느 쪽도 믿지 않고 멈춘다.
    const statedSubtype = statedNewProductSubtype(source);
    const evidenceSubtype = (automaticCommissionEvidence as Rec).newProductSubtype ?? (effectiveEvidence as Rec | undefined)?.newProductSubtype;
    const subtypeConflict = !!statedSubtype && !!evidenceSubtype && statedSubtype !== evidenceSubtype;
    const guardSubtype = (fee: CommissionResolution): CommissionResolution => subtypeConflict ? unknownCommission('CONFLICTING_NEW_PRODUCT_SUBTYPE') : fee;
    const channelPayoutFee = withVehicleValueEvidence(guardSubtype(resolveSalesCommission({
      ...(explicitSubtype ? { newProductSubtype: explicitSubtype } : {}),
      ...effectiveEvidence,
      ...automaticCommissionEvidence,
      supplierId,
      productType: text(source.product_type),
      fuel: text(source.fuel_type),
      termMonths: parsed.months,
      monthlyRent,
      billin36MonthlyRent,
    })));
    const supplierBillingFee = withVehicleValueEvidence(guardSubtype(resolveSupplierBillingFee({
      ...(explicitSubtype ? { newProductSubtype: explicitSubtype } : {}),
      ...effectiveEvidence,
      ...automaticCommissionEvidence,
      supplierId,
      productType: text(source.product_type),
      fuel: text(source.fuel_type),
      termMonths: parsed.months,
      monthlyRent,
      billin36MonthlyRent,
    })));
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
