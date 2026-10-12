import type { FieldLineageRecord } from '../domain/lineage.js';
import type { NormalizedCandidateRecord, RawRecord } from '../domain/source.js';
import type { SourceIntakeBatch } from '../domain/source-intake.js';
import {
  assertKakaoInfoCandidate,
  classifyKakaoInfoSignal,
  isValidKakaoInfoPlate,
  isKakaoMoneyInfo,
  isKakaoStateAutoPromotable,
  isKakaoT0OnlyInfo,
  kakaoInfoFieldsDigest,
  type KakaoInfoCandidate,
  type KakaoInfoCandidateInput,
} from '../domain/kakao-info-candidate.js';
import { stableDigest } from '../shared/stable-digest.js';
import { prepareRawSourceBatch } from './ingest-raw-source.js';

export type KakaoInfoSourceBatchPlan = {
  batch: SourceIntakeBatch;
  normalize: (raw: RawRecord) => { record: NormalizedCandidateRecord; lineage: FieldLineageRecord[] };
  candidates: Array<{
    candidate: KakaoInfoCandidate;
    productRef: string | null;
    vehicleUnspecified: boolean;
    autoPromotable: boolean;
    conflict: boolean;
    expiresAt: string;
    isFresh: boolean;
  }>;
  writes: 0;
};

function payloadFor(candidate: KakaoInfoCandidate, now: string, conflict: boolean) {
  const signal = classifyKakaoInfoSignal(candidate, now);
  const plate = candidate.vehicle?.plate && isValidKakaoInfoPlate(candidate.vehicle.plate) ? candidate.vehicle.plate : null;
  const productRef = plate ? `products/${plate}` : null;
  return {
    ruleVersion: 'kakao-info-candidate/1',
    sourceKind: 'KAKAO',
    authority: 'CANDIDATE',
    aiInvolved: true,
    candidate,
    raw: {
      supplierCode: candidate.supplierCode,
      roomCode: candidate.roomCode,
      sentAt: candidate.source.sentAt,
      msgNo: candidate.source.msgNo,
      excerpt: candidate.source.excerpt,
    },
    normalized: {
      layer: isKakaoT0OnlyInfo(candidate.type) ? 'T0' : signal.layer,
      type: candidate.type,
      supplierCode: candidate.supplierCode,
      item: candidate.fields.항목,
      summary: candidate.fields.요약,
      value: candidate.fields.값,
      sentAt: candidate.source.sentAt,
      roomCode: candidate.roomCode,
      vehicle: {
        productRef,
        plate,
        model: candidate.vehicle?.model ?? null,
        plateUnverified: candidate.vehicle?.plateUnverified ?? null,
        plateEvidenceMsgNo: candidate.vehicle?.plateEvidenceMsgNo ?? null,
        plateEvidenceSource: candidate.vehicle?.plateEvidence?.source ?? null,
        plateEvidenceDistance: candidate.vehicle?.plateEvidence?.distance ?? null,
        plateStatusSameSentence: candidate.vehicle?.plateStatusSameSentence ?? false,
        unspecified: productRef == null,
      },
      needsSupplierConfirm: candidate.needsSupplierConfirm || Boolean(candidate.vehicle?.plateUnverified),
      confidence: candidate.confidence,
      autoPromotable: isKakaoMoneyInfo(candidate.type) || isKakaoT0OnlyInfo(candidate.type) ? false : isKakaoStateAutoPromotable(candidate, signal.isFresh),
      conflict,
      expiresAt: signal.expiresAt,
      isFresh: signal.isFresh,
    },
  };
}

function fingerprintPayloadFor(candidate: KakaoInfoCandidate) {
  const plate = candidate.vehicle?.plate && isValidKakaoInfoPlate(candidate.vehicle.plate) ? candidate.vehicle.plate : null;
  const productRef = plate ? `products/${plate}` : null;
  return {
    ruleVersion: 'kakao-info-candidate/1',
    sourceKind: 'KAKAO',
    authority: 'CANDIDATE',
    aiInvolved: true,
    candidate,
    raw: {
      supplierCode: candidate.supplierCode,
      roomCode: candidate.roomCode,
      sentAt: candidate.source.sentAt,
      msgNo: candidate.source.msgNo,
      excerpt: candidate.source.excerpt,
    },
    normalized: {
      layer: isKakaoT0OnlyInfo(candidate.type) ? 'T0' : 'T1',
      type: candidate.type,
      supplierCode: candidate.supplierCode,
      item: candidate.fields.항목,
      summary: candidate.fields.요약,
      value: candidate.fields.값,
      sentAt: candidate.source.sentAt,
      roomCode: candidate.roomCode,
      vehicle: {
        productRef,
        plate,
        model: candidate.vehicle?.model ?? null,
        plateUnverified: candidate.vehicle?.plateUnverified ?? null,
        plateEvidenceMsgNo: candidate.vehicle?.plateEvidenceMsgNo ?? null,
        plateEvidenceSource: candidate.vehicle?.plateEvidence?.source ?? null,
        plateEvidenceDistance: candidate.vehicle?.plateEvidence?.distance ?? null,
        plateStatusSameSentence: candidate.vehicle?.plateStatusSameSentence ?? false,
        unspecified: productRef == null,
      },
      needsSupplierConfirm: candidate.needsSupplierConfirm || Boolean(candidate.vehicle?.plateUnverified),
      confidence: candidate.confidence,
    },
  };
}

function conflictKeys(candidates: KakaoInfoCandidate[]) {
  const values = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const plate = candidate.vehicle?.plate && isValidKakaoInfoPlate(candidate.vehicle.plate) ? candidate.vehicle.plate : null;
    if (!plate) continue;
    const key = `${plate}|${candidate.type}`;
    const set = values.get(key) ?? new Set<string>();
    set.add(kakaoInfoFieldsDigest(candidate));
    values.set(key, set);
  }
  return new Set([...values].filter(([, set]) => set.size > 1).map(([key]) => key));
}

export function kakaoInfoCandidatesToSourceBatch(
  inputs: KakaoInfoCandidateInput[],
  options: { observedAt?: string; now: string },
): KakaoInfoSourceBatchPlan {
  if (!options?.now) throw new Error('KAKAO_INFO_NOW_REQUIRED');
  const candidates = inputs.map(assertKakaoInfoCandidate);
  const observedAt = options.observedAt ?? candidates.map((candidate) => candidate.source.sentAt).sort()[0] ?? new Date(0).toISOString();
  const now = options.now;
  const conflicts = conflictKeys(candidates);
  const records = candidates.map((candidate) => {
    const plate = candidate.vehicle?.plate && isValidKakaoInfoPlate(candidate.vehicle.plate) ? candidate.vehicle.plate : null;
    const key = plate ? `${plate}|${candidate.type}` : '';
    const payload = payloadFor(candidate, now, conflicts.has(key));
    return {
      sourceRecordId: candidate.candidateId,
      sourceFingerprint: stableDigest(fingerprintPayloadFor(candidate)),
      payload,
    };
  });
  const batch: SourceIntakeBatch = {
    laneId: 'PRODUCT_VEHICLE',
    source: {
      sourceId: 'kakao-info-candidate',
      kind: 'FILE',
      displayName: 'Kakao info candidate',
      authorityScope: ['kakao-info-candidate', 'authority:CANDIDATE'],
      expectedFreshnessSeconds: 7 * 24 * 60 * 60,
    },
    observedAt,
    sourceRevision: 'kakao-info-candidate/1',
    coverage: {
      mode: 'PARTIAL',
      completeness: 'COMPLETE',
      scope: 'KAKAO_INFO_CANDIDATES',
      note: 'Candidate-only source evidence. No operational writes or canonical promotion.',
    },
    records,
  };

  const prepared = prepareRawSourceBatch(batch);
  const byRecord = new Map(prepared.rawRecords.map((raw) => [raw.sourceRecordId, raw]));
  const planned = candidates.map((candidate) => {
    const plate = candidate.vehicle?.plate && isValidKakaoInfoPlate(candidate.vehicle.plate) ? candidate.vehicle.plate : null;
    const key = plate ? `${plate}|${candidate.type}` : '';
    const signal = classifyKakaoInfoSignal(candidate, now);
    return {
      candidate,
      productRef: plate ? `products/${plate}` : null,
      vehicleUnspecified: !plate,
      autoPromotable: isKakaoMoneyInfo(candidate.type) || isKakaoT0OnlyInfo(candidate.type) ? false : isKakaoStateAutoPromotable(candidate, signal.isFresh),
      conflict: conflicts.has(key),
      expiresAt: signal.expiresAt,
      isFresh: signal.isFresh,
    };
  });

  const normalize = (raw: RawRecord) => {
    const payload = raw.payload as ReturnType<typeof payloadFor>;
    const candidate = payload.candidate;
    const normalizedCandidate = payload.normalized;
    const issues = [
      'KAKAO_CANDIDATE_ONLY',
      ...(normalizedCandidate.vehicle.unspecified && normalizedCandidate.vehicle.plate == null ? ['VEHICLE_UNSPECIFIED'] : []),
      ...(normalizedCandidate.needsSupplierConfirm ? ['SUPPLIER_CONFIRM_REQUIRED'] : []),
      ...(normalizedCandidate.conflict ? ['KAKAO_INFO_CONFLICT'] : []),
      ...(!normalizedCandidate.isFresh ? ['KAKAO_INFO_EXPIRED'] : []),
    ];
    const record: NormalizedCandidateRecord = {
      candidateId: candidate.candidateId,
      runId: raw.runId,
      sourceId: raw.sourceId,
      sourceRecordId: raw.sourceRecordId,
      sourceFingerprint: raw.sourceFingerprint,
      status: 'WARNING',
      candidate: {
        sourceRecordId: raw.sourceRecordId,
        sourceFingerprint: raw.sourceFingerprint,
        carNumber: candidate.vehicle?.plate,
        model: candidate.vehicle?.model,
        vehicleStatusRaw: candidate.type === '재고' || candidate.type === '계약진행' ? candidate.fields.값 : undefined,
        origin: 'KAKAO',
        priceTerms: [],
        issues,
        kakaoInfo: normalizedCandidate,
      } as unknown as NormalizedCandidateRecord['candidate'],
    };
    const lineage: FieldLineageRecord[] = [
      'type',
      'layer',
      'item',
      'summary',
      'value',
      'vehicle.productRef',
      'vehicle.plateEvidenceMsgNo',
      'vehicle.plateEvidenceSource',
      'vehicle.plateEvidenceDistance',
      'vehicle.plateStatusSameSentence',
      'needsSupplierConfirm',
      'autoPromotable',
    ]
      .map((fieldPath) => {
        const value = fieldPath.split('.').reduce<unknown>((current, part) =>
          current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined, normalizedCandidate);
        const id = stableDigest([raw.rawRecordId, fieldPath, value]);
        return {
          lineageRecordId: id,
          lineageId: id,
          stage: 'RAW_TO_NORMALIZED' as const,
          runId: raw.runId,
          sourceId: raw.sourceId,
          sourceRecordId: raw.sourceRecordId,
          sourceFingerprint: raw.sourceFingerprint,
          observedAt: raw.observedAt,
          source: { fieldPath: `candidate.${fieldPath}`, value },
          normalized: { candidateId: candidate.candidateId, fieldPath: `kakaoInfo.${fieldPath}`, value },
          transformId: 'kakao-info-candidate',
          transformVersion: 'kakao-info-candidate/1',
        };
      });
    return { record, lineage };
  };

  for (const candidate of candidates) {
    if (!byRecord.has(candidate.candidateId)) throw new Error('KAKAO_INFO_BATCH_BINDING_FAILED');
  }

  return { batch, normalize, candidates: planned, writes: 0 };
}
