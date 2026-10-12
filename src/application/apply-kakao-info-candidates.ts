import { ingestRawSourceBatch } from './ingest-raw-source.js';
import { kakaoInfoCandidatesToSourceBatch } from './kakao-info-to-source-batch.js';
import { isKakaoMoneyInfo, isKakaoT0OnlyInfo, type KakaoInfoCandidateInput } from '../domain/kakao-info-candidate.js';
import type { SourceIntakeBatch } from '../domain/source-intake.js';
import type { SourceIngestionStore } from '../ports/source-store.js';
import { stableDigest } from '../shared/stable-digest.js';

export type KakaoInfoApplyOutcome = 'CREATED' | 'SKIPPED_SAME' | 'CONFLICT';
export type KakaoInfoVehicleResolution = 'LINKED' | 'UNSPECIFIED_NO_PRODUCT';

export type KakaoInfoApplyPort = SourceIngestionStore & {
  productExists?: (productRef: string) => Promise<boolean>;
};

export type KakaoInfoApplyOptions = {
  expectedDigest: string;
  now: string;
  writeApproved?: boolean;
  env?: Record<string, string | undefined>;
};

export type KakaoInfoCandidateReceipt = {
  candidateId: string;
  result: KakaoInfoApplyOutcome;
  readbackDigest: string | null;
  vehicleUnspecified: boolean;
  productExistence: 'CONFIRMED' | 'MISSING_DOWNGRADED' | 'UNKNOWN' | 'NOT_APPLICABLE';
  vehicleResolution: KakaoInfoVehicleResolution;
  updatePending: boolean;
};

export type KakaoInfoApplyResult = {
  status: 'DRY_RUN' | 'APPLIED';
  digest: string;
  writesEnabled: boolean;
  counts: {
    input: number;
    created: number;
    skippedSame: number;
    conflict: number;
    writes: number;
  };
  receipts: KakaoInfoCandidateReceipt[];
};

const APPLY_SOURCE_ID = 'kakao-info-candidate';
const WRITE_ENV_ONE = 'FREEPASS_KAKAO_INFO_APPLY';
const WRITE_ENV_TWO = 'FREEPASS_KAKAO_INFO_WRITE_APPROVED';

function assertWriteAllowed(options: KakaoInfoApplyOptions) {
  if (!options.writeApproved) return false;
  if (options.env?.[WRITE_ENV_ONE] !== 'on' || options.env?.[WRITE_ENV_TWO] !== options.expectedDigest) {
    throw new Error('KAKAO_INFO_WRITE_NOT_APPROVED');
  }
  return true;
}

function assertDigest(inputs: readonly KakaoInfoCandidateInput[], expectedDigest: string) {
  if (!expectedDigest || stableDigest(inputs) !== expectedDigest) throw new Error('KAKAO_INFO_DIGEST_MISMATCH');
}

function stableCandidateForDigest(candidate: unknown) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const copy = structuredClone(candidate) as Record<string, unknown>;
  if (Array.isArray(copy.issues)) {
    copy.issues = copy.issues.filter(issue => issue !== 'KAKAO_INFO_CONFLICT' && issue !== 'KAKAO_INFO_EXPIRED');
  }
  const info = copy.kakaoInfo;
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const kakaoInfo = { ...(info as Record<string, unknown>) };
    delete kakaoInfo.autoPromotable;
    delete kakaoInfo.conflict;
    delete kakaoInfo.expiresAt;
    delete kakaoInfo.isFresh;
    delete kakaoInfo.layer;
    delete kakaoInfo.vehicleResolution;
    if (kakaoInfo.vehicle && typeof kakaoInfo.vehicle === 'object' && !Array.isArray(kakaoInfo.vehicle)) {
      const vehicle = { ...(kakaoInfo.vehicle as Record<string, unknown>) };
      delete vehicle.productRef;
      delete vehicle.unspecified;
      kakaoInfo.vehicle = vehicle;
    }
    copy.kakaoInfo = kakaoInfo;
  }
  return copy;
}

function candidateDigest(record: { sourceFingerprint: string; candidate: unknown }) {
  return stableDigest({ sourceFingerprint: record.sourceFingerprint, candidate: stableCandidateForDigest(record.candidate) });
}

function fullCandidateDigest(record: { sourceFingerprint: string; candidate: unknown }) {
  return stableDigest({ sourceFingerprint: record.sourceFingerprint, candidate: record.candidate });
}

function derivedSafetyFields(candidate: unknown) {
  const info = candidate && typeof candidate === 'object'
    ? (candidate as { kakaoInfo?: Record<string, unknown> }).kakaoInfo
    : undefined;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  return {
    expiresAt: info.expiresAt,
    conflict: info.conflict,
  };
}

function hasExpectedDerivedSafetyFields(existing: unknown, expected: unknown) {
  return stableDigest(derivedSafetyFields(existing)) === stableDigest(derivedSafetyFields(expected));
}

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function storedKakaoInfo(candidate: unknown) {
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as { kakaoInfo?: Record<string, unknown> }).kakaoInfo
    : undefined;
}

function isT2OrAbove(layer: unknown) {
  return typeof layer === 'string' && /^T[2-9][0-9]*$/.test(layer);
}

function isT1OrAbove(layer: unknown) {
  return typeof layer === 'string' && /^T[1-9][0-9]*$/.test(layer);
}

function isPromotionForbiddenType(type: unknown) {
  const typed = type as Parameters<typeof isKakaoMoneyInfo>[0];
  return isKakaoMoneyInfo(typed) || isKakaoT0OnlyInfo(typed) || text(type) === 'SALES_REQUEST';
}

function hasStoredLiteralSameSentencePlateEvidence(info: Record<string, unknown>) {
  const vehicle = info.vehicle;
  if (!vehicle || typeof vehicle !== 'object' || Array.isArray(vehicle)) return false;
  const v = vehicle as Record<string, unknown>;
  return v.plateEvidenceSource === 'LITERAL_IN_UTTERANCE'
    && v.plateEvidenceDistance === 0
    && v.plateStatusSameSentence === true;
}

export function hasKakaoInfoStoredInvariantViolation(candidate: unknown) {
  const info = storedKakaoInfo(candidate);
  if (!info || typeof info !== 'object' || Array.isArray(info)) return false;
  const type = info.type;
  if (info.vehicleResolution === 'UNSPECIFIED_NO_PRODUCT') {
    const vehicle = info.vehicle;
    const productRef = vehicle && typeof vehicle === 'object' && !Array.isArray(vehicle)
      ? (vehicle as Record<string, unknown>).productRef
      : null;
    if (productRef != null) return true;
    if (info.autoPromotable === true) return true;
    if (isT1OrAbove(info.layer)) return true;
  }
  if (isPromotionForbiddenType(type) && info.autoPromotable === true) return true;
  if (typeof info.channel === 'string' && info.channel !== 'KAKAO_RAW' && (info.layer !== 'T0' || info.autoPromotable === true)) return true;
  if (isT2OrAbove(info.layer)) return true;
  if (info.autoPromotable === true && !hasStoredLiteralSameSentencePlateEvidence(info)) return true;
  return false;
}

async function resolveProductExistence(port: KakaoInfoApplyPort, plan: ReturnType<typeof kakaoInfoCandidatesToSourceBatch>, writesEnabled: boolean) {
  const productExistenceByInput = new Map<number, KakaoInfoCandidateReceipt['productExistence']>();
  const vehicleResolutionByCandidateId = new Map<string, KakaoInfoVehicleResolution>();
  if (!port.productExists) {
    if (writesEnabled) throw new Error('KAKAO_INFO_PRODUCT_EXISTS_PORT_REQUIRED');
    plan.candidates.forEach((item, index) => {
      productExistenceByInput.set(index, item.productRef ? 'UNKNOWN' : 'NOT_APPLICABLE');
      vehicleResolutionByCandidateId.set(item.candidate.candidateId, item.productRef ? 'LINKED' : 'UNSPECIFIED_NO_PRODUCT');
    });
    return { productExistenceByInput, vehicleResolutionByCandidateId };
  }
  for (const [index, item] of plan.candidates.entries()) {
    if (!item.productRef) {
      productExistenceByInput.set(index, 'NOT_APPLICABLE');
      vehicleResolutionByCandidateId.set(item.candidate.candidateId, 'UNSPECIFIED_NO_PRODUCT');
      continue;
    }
    if (await port.productExists(item.productRef)) {
      productExistenceByInput.set(index, 'CONFIRMED');
      vehicleResolutionByCandidateId.set(item.candidate.candidateId, 'LINKED');
      continue;
    }
    productExistenceByInput.set(index, 'MISSING_DOWNGRADED');
    vehicleResolutionByCandidateId.set(item.candidate.candidateId, 'UNSPECIFIED_NO_PRODUCT');
  }
  return { productExistenceByInput, vehicleResolutionByCandidateId };
}

function applyVehicleResolutionToPlan(plan: ReturnType<typeof kakaoInfoCandidatesToSourceBatch>, vehicleResolutionByCandidateId: ReadonlyMap<string, KakaoInfoVehicleResolution>) {
  const batch = structuredClone(plan.batch) as SourceIntakeBatch;
  for (const record of batch.records) {
    const resolution = vehicleResolutionByCandidateId.get(record.sourceRecordId) ?? 'LINKED';
    const normalized = record.payload.normalized;
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) continue;
    const info = normalized as Record<string, unknown>;
    info.vehicleResolution = resolution;
    if (resolution !== 'LINKED') {
      info.layer = 'T0';
      info.autoPromotable = false;
      const vehicle = info.vehicle;
      if (vehicle && typeof vehicle === 'object' && !Array.isArray(vehicle)) {
        (vehicle as Record<string, unknown>).productRef = null;
        (vehicle as Record<string, unknown>).unspecified = true;
      }
    }
  }
  return { ...plan, batch };
}

function batchForCandidateIds(batch: SourceIntakeBatch, candidateIds: ReadonlySet<string>): SourceIntakeBatch {
  return {
    ...batch,
    records: batch.records.filter(record => candidateIds.has(record.sourceRecordId)),
  };
}

export async function applyKakaoInfoCandidates(
  port: KakaoInfoApplyPort,
  inputs: readonly KakaoInfoCandidateInput[],
  options: KakaoInfoApplyOptions,
): Promise<KakaoInfoApplyResult> {
  assertDigest(inputs, options.expectedDigest);
  if (!Number.isFinite(Date.parse(options.now))) throw new Error('KAKAO_INFO_NOW_REQUIRED');
  const writesEnabled = assertWriteAllowed(options);
  const basePlan = kakaoInfoCandidatesToSourceBatch([...inputs], { now: options.now });
  const { productExistenceByInput, vehicleResolutionByCandidateId } = await resolveProductExistence(port, basePlan, writesEnabled);
  const plan = applyVehicleResolutionToPlan(basePlan, vehicleResolutionByCandidateId);
  const productExistenceByCandidateId = new Map(plan.candidates.map((item, index) => [
    item.candidate.candidateId,
    productExistenceByInput.get(index) ?? (item.productRef ? 'UNKNOWN' : 'NOT_APPLICABLE'),
  ] as const));
  const expectedStableDigestById = new Map<string, string>();
  const expectedFullDigestById = new Map<string, string>();
  const expectedCandidateById = new Map<string, unknown>();
  for (const item of plan.candidates) {
    const expectedFingerprint = plan.batch.records.find(record => record.sourceRecordId === item.candidate.candidateId)?.sourceFingerprint;
    if (!expectedFingerprint) throw new Error('KAKAO_INFO_PLAN_BINDING_FAILED');
    const expectedCandidate = plan.normalize({
      firstObservedAt: options.now,
      firstRunId: null,
      rawRecordId: `readback-plan/${item.candidate.candidateId}`,
      runId: 'readback-plan',
      sourceId: APPLY_SOURCE_ID,
      sourceRecordId: item.candidate.candidateId,
      sourceFingerprint: expectedFingerprint,
      observedAt: options.now,
      payload: plan.batch.records.find(record => record.sourceRecordId === item.candidate.candidateId)!.payload,
    }).record.candidate;
    expectedCandidateById.set(item.candidate.candidateId, expectedCandidate);
    expectedStableDigestById.set(item.candidate.candidateId, candidateDigest({ sourceFingerprint: expectedFingerprint, candidate: expectedCandidate }));
    expectedFullDigestById.set(item.candidate.candidateId, fullCandidateDigest({ sourceFingerprint: expectedFingerprint, candidate: expectedCandidate }));
  }
  const receipts: KakaoInfoCandidateReceipt[] = [];
  let created = 0, skippedSame = 0, conflict = 0;
  const createdCandidateIds = new Set<string>();

  for (const item of plan.candidates) {
    const existing = await port.getCandidate(item.candidate.candidateId);
    const expectedFingerprint = plan.batch.records.find(record => record.sourceRecordId === item.candidate.candidateId)?.sourceFingerprint;
    if (!expectedFingerprint) throw new Error('KAKAO_INFO_PLAN_BINDING_FAILED');
    const expectedDigest = expectedStableDigestById.get(item.candidate.candidateId);
    const expectedCandidate = expectedCandidateById.get(item.candidate.candidateId);
    if (!expectedDigest) throw new Error('KAKAO_INFO_PLAN_BINDING_FAILED');
    if (!expectedCandidate) throw new Error('KAKAO_INFO_PLAN_BINDING_FAILED');
    const existingDigest = existing ? candidateDigest(existing) : null;
    const result: KakaoInfoApplyOutcome = !existing ? 'CREATED'
      : hasKakaoInfoStoredInvariantViolation(existing.candidate) ? 'CONFLICT'
      : existing.sourceFingerprint === expectedFingerprint
        && existingDigest === expectedDigest
        && hasExpectedDerivedSafetyFields(existing.candidate, expectedCandidate) ? 'SKIPPED_SAME'
        : 'CONFLICT';
    if (result === 'CREATED') {
      created++;
      createdCandidateIds.add(item.candidate.candidateId);
    }
    if (result === 'SKIPPED_SAME') skippedSame++;
    if (result === 'CONFLICT') conflict++;
    const vehicleResolution = vehicleResolutionByCandidateId.get(item.candidate.candidateId) ?? 'LINKED';
    const existingResolution = existing
      ? (((existing.candidate as unknown as { kakaoInfo?: { vehicleResolution?: unknown } }).kakaoInfo)?.vehicleResolution ?? null)
      : null;
    receipts.push({
      candidateId: item.candidate.candidateId,
      result,
      readbackDigest: existingDigest,
      vehicleUnspecified: item.vehicleUnspecified || vehicleResolution === 'UNSPECIFIED_NO_PRODUCT',
      productExistence: productExistenceByCandidateId.get(item.candidate.candidateId) ?? 'UNKNOWN',
      vehicleResolution,
      updatePending: result === 'SKIPPED_SAME' && existingResolution !== null && existingResolution !== vehicleResolution,
    });
  }

  if (!writesEnabled) {
    return {
      status: 'DRY_RUN',
      digest: stableDigest(inputs),
      writesEnabled: false,
      counts: { input: inputs.length, created, skippedSame, conflict, writes: 0 },
      receipts,
    };
  }
  if (conflict > 0) throw new Error('KAKAO_INFO_CANDIDATE_CONFLICT');
  if (createdCandidateIds.size === 0) {
    return {
      status: 'APPLIED',
      digest: stableDigest(inputs),
      writesEnabled: true,
      counts: { input: inputs.length, created, skippedSame, conflict, writes: 0 },
      receipts,
    };
  }

  const result = await ingestRawSourceBatch(port, batchForCandidateIds(plan.batch, createdCandidateIds), options.now, plan.normalize);
  const persisted = await port.listCandidates(result.runId);
  const persistedById = new Map(persisted.map(record => [record.candidateId, record]));
  for (const receipt of receipts) {
    if (receipt.result !== 'CREATED') continue;
    const record = persistedById.get(receipt.candidateId);
    if (!record) throw new Error('KAKAO_INFO_READBACK_MISSING');
    receipt.readbackDigest = fullCandidateDigest(record);
    if (receipt.readbackDigest !== expectedFullDigestById.get(receipt.candidateId)) {
      throw new Error('KAKAO_INFO_READBACK_MISMATCH');
    }
  }
  if (persisted.some(record => record.sourceId !== APPLY_SOURCE_ID)) throw new Error('KAKAO_INFO_READBACK_SOURCE_MISMATCH');

  return {
    status: 'APPLIED',
    digest: stableDigest(inputs),
    writesEnabled: true,
    counts: { input: inputs.length, created, skippedSame, conflict, writes: created },
    receipts,
  };
}
