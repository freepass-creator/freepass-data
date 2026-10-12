import { ingestRawSourceBatch } from './ingest-raw-source.js';
import { kakaoInfoCandidatesToSourceBatch } from './kakao-info-to-source-batch.js';
import type { KakaoInfoCandidateInput } from '../domain/kakao-info-candidate.js';
import type { SourceIntakeBatch } from '../domain/source-intake.js';
import type { SourceIngestionStore } from '../ports/source-store.js';
import { stableDigest } from '../shared/stable-digest.js';

export type KakaoInfoApplyOutcome = 'CREATED' | 'SKIPPED_SAME' | 'CONFLICT';

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

function candidateDigest(record: { sourceFingerprint: string; candidate: unknown }) {
  return stableDigest({ sourceFingerprint: record.sourceFingerprint, candidate: record.candidate });
}

function plannedCandidateDigest(record: { sourceFingerprint: string; candidate: unknown }) {
  return stableDigest({ sourceFingerprint: record.sourceFingerprint, candidate: record.candidate });
}

async function downgradeMissingProducts(port: KakaoInfoApplyPort, inputs: readonly KakaoInfoCandidateInput[], writesEnabled: boolean) {
  const prepared = structuredClone(inputs) as KakaoInfoCandidateInput[];
  const productExistenceByInput = new Map<number, KakaoInfoCandidateReceipt['productExistence']>();
  if (!port.productExists) {
    if (writesEnabled) throw new Error('KAKAO_INFO_PRODUCT_EXISTS_PORT_REQUIRED');
    prepared.forEach((input, index) => {
      productExistenceByInput.set(index, input.vehicle?.plate?.trim() ? 'UNKNOWN' : 'NOT_APPLICABLE');
    });
    return { prepared, productExistenceByInput };
  }
  for (const [index, input] of prepared.entries()) {
    const vehicle = input.vehicle;
    if (!vehicle) {
      productExistenceByInput.set(index, 'NOT_APPLICABLE');
      continue;
    }
    const plate = vehicle.plate?.trim();
    if (!plate) {
      productExistenceByInput.set(index, 'NOT_APPLICABLE');
      continue;
    }
    const productRef = `products/${plate}`;
    if (await port.productExists(productRef)) {
      productExistenceByInput.set(index, 'CONFIRMED');
      continue;
    }
    const { plate: _plate, plateEvidence: _plateEvidence, plateEvidenceMsgNo: _plateEvidenceMsgNo, ...vehicleRest } = vehicle;
    input.vehicle = {
      ...vehicleRest,
      plateUnverified: vehicleRest.plateUnverified ?? plate,
      plateStatusSameSentence: false,
    };
    input.needsSupplierConfirm = true;
    productExistenceByInput.set(index, 'MISSING_DOWNGRADED');
  }
  return { prepared, productExistenceByInput };
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
  const { prepared: effectiveInputs, productExistenceByInput } = await downgradeMissingProducts(port, inputs, writesEnabled);
  const plan = kakaoInfoCandidatesToSourceBatch(effectiveInputs, { now: options.now });
  const productExistenceByCandidateId = new Map(plan.candidates.map((item, index) => [
    item.candidate.candidateId,
    productExistenceByInput.get(index) ?? (item.productRef ? 'UNKNOWN' : 'NOT_APPLICABLE'),
  ] as const));
  const expectedDigestById = new Map(plan.candidates.map(item => {
    const expectedFingerprint = plan.batch.records.find(record => record.sourceRecordId === item.candidate.candidateId)?.sourceFingerprint;
    if (!expectedFingerprint) throw new Error('KAKAO_INFO_PLAN_BINDING_FAILED');
    return [item.candidate.candidateId, plannedCandidateDigest({ sourceFingerprint: expectedFingerprint, candidate: plan.normalize({
      firstObservedAt: options.now,
      firstRunId: null,
      rawRecordId: `readback-plan/${item.candidate.candidateId}`,
      runId: 'readback-plan',
      sourceId: APPLY_SOURCE_ID,
      sourceRecordId: item.candidate.candidateId,
      sourceFingerprint: expectedFingerprint,
      observedAt: options.now,
      payload: plan.batch.records.find(record => record.sourceRecordId === item.candidate.candidateId)!.payload,
    }).record.candidate })] as const;
  }));
  const receipts: KakaoInfoCandidateReceipt[] = [];
  let created = 0, skippedSame = 0, conflict = 0;
  const createdCandidateIds = new Set<string>();

  for (const item of plan.candidates) {
    const existing = await port.getCandidate(item.candidate.candidateId);
    const expectedFingerprint = plan.batch.records.find(record => record.sourceRecordId === item.candidate.candidateId)?.sourceFingerprint;
    const expectedDigest = expectedDigestById.get(item.candidate.candidateId);
    if (!expectedDigest) throw new Error('KAKAO_INFO_PLAN_BINDING_FAILED');
    const existingDigest = existing ? candidateDigest(existing) : null;
    const result: KakaoInfoApplyOutcome = !existing ? 'CREATED'
      : existing.sourceFingerprint === expectedFingerprint && existingDigest === expectedDigest ? 'SKIPPED_SAME'
        : 'CONFLICT';
    if (result === 'CREATED') {
      created++;
      createdCandidateIds.add(item.candidate.candidateId);
    }
    if (result === 'SKIPPED_SAME') skippedSame++;
    if (result === 'CONFLICT') conflict++;
    receipts.push({
      candidateId: item.candidate.candidateId,
      result,
      readbackDigest: existingDigest,
      vehicleUnspecified: item.vehicleUnspecified,
      productExistence: productExistenceByCandidateId.get(item.candidate.candidateId) ?? 'UNKNOWN',
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
    receipt.readbackDigest = candidateDigest(record);
    if (receipt.readbackDigest !== expectedDigestById.get(receipt.candidateId)) {
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
