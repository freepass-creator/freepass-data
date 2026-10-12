import { createHash } from 'node:crypto';
import { stableDigest, stableValue } from '../shared/stable-digest.js';

export type KakaoInfoType = '재고' | '가격' | '조건' | '정책변경' | '계약진행';
export type KakaoInfoLayer = 'T0' | 'T1';
export type KakaoInfoRejectReason =
  | 'INVALID_ROOM_CODE'
  | 'INVALID_SOURCE'
  | 'SENDER_UNVERIFIED'
  | 'INVALID_EXCERPT'
  | 'SENSITIVE_EXCERPT'
  | 'INVALID_TYPE'
  | 'INVALID_FIELDS'
  | 'INVALID_CONFIDENCE'
  | 'INVALID_STATUS';

export type KakaoInfoCandidateInput = {
  roomCode: string;
  source: { sentAt: string; side: string; msgNo: string; excerpt: string };
  type: KakaoInfoType;
  vehicle?: { plate?: string; model?: string; plateUnverified?: string };
  fields: { 요약: string; 값: string };
  confidence: number;
  needsSupplierConfirm: boolean;
  aiInvolved: true;
  status: 'CANDIDATE';
};

export type KakaoInfoCandidate = KakaoInfoCandidateInput & {
  schemaVersion: 'KakaoInfoCandidate/v1';
  candidateId: string;
};

export type KakaoInfoCandidateResult =
  | { ok: true; candidate: KakaoInfoCandidate }
  | { ok: false; reason: KakaoInfoRejectReason };

const validTypes = new Set<KakaoInfoType>(['재고', '가격', '조건', '정책변경', '계약진행']);
const stateTypes = new Set<KakaoInfoType>(['재고', '계약진행']);
const moneyTypes = new Set<KakaoInfoType>(['가격', '조건', '정책변경']);
const stateSignals = ['재고 있음', '재고 없음', '접수 가능', '출고 예정', '예약', '불가'];

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export function hasSensitiveKakaoExcerpt(value: string) {
  const compact = value.replace(/[\s-]/g, '');
  return [
    /\d{2,6}-\d{2,6}-\d{2,8}/,
    /\d{3}-\d{2}-\d{5}/,
    /\d{6}[ -]?[1-4]\d{6}/,
    /(?:010|011|016|017|018|019)[ -]?\d{3,4}[ -]?\d{4}/,
    /\d{10,14}/,
  ].some((pattern) => pattern.test(value) || pattern.test(compact));
}

export function kakaoVehicleKey(candidate: Pick<KakaoInfoCandidateInput, 'vehicle'>) {
  const plate = candidate.vehicle?.plate?.trim();
  if (plate) return plate;
  return 'UNSPECIFIED';
}

export function kakaoInfoCandidateId(input: KakaoInfoCandidateInput) {
  const fieldsHash = createHash('sha256')
    .update(JSON.stringify(stableValue(input.fields)))
    .digest('hex');
  return createHash('sha256')
    .update([
      input.roomCode.trim(),
      new Date(input.source.sentAt).toISOString(),
      input.source.msgNo.trim(),
      input.type,
      kakaoVehicleKey(input),
      fieldsHash,
    ].join('|'))
    .digest('hex');
}

export function createKakaoInfoCandidate(input: KakaoInfoCandidateInput): KakaoInfoCandidateResult {
  if (!/^K-[A-Za-z0-9_-]{1,64}$/.test(input.roomCode)) return { ok: false, reason: 'INVALID_ROOM_CODE' };
  if (!Number.isFinite(Date.parse(input.source?.sentAt)) || !nonBlank(input.source?.msgNo)) {
    return { ok: false, reason: 'INVALID_SOURCE' };
  }
  if (input.source.side !== '상대') return { ok: false, reason: 'SENDER_UNVERIFIED' };
  if (!nonBlank(input.source.excerpt) || Array.from(input.source.excerpt).length > 80) {
    return { ok: false, reason: 'INVALID_EXCERPT' };
  }
  if (hasSensitiveKakaoExcerpt(input.source.excerpt)) return { ok: false, reason: 'SENSITIVE_EXCERPT' };
  if (!validTypes.has(input.type)) return { ok: false, reason: 'INVALID_TYPE' };
  if (!nonBlank(input.fields?.요약) || !nonBlank(input.fields?.값)) return { ok: false, reason: 'INVALID_FIELDS' };
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    return { ok: false, reason: 'INVALID_CONFIDENCE' };
  }
  if (input.aiInvolved !== true || input.status !== 'CANDIDATE') return { ok: false, reason: 'INVALID_STATUS' };

  const normalized: KakaoInfoCandidateInput = {
    ...input,
    roomCode: input.roomCode.trim(),
    source: {
      sentAt: new Date(input.source.sentAt).toISOString(),
      side: '상대',
      msgNo: input.source.msgNo.trim(),
      excerpt: input.source.excerpt,
    },
    fields: { 요약: input.fields.요약.trim(), 값: input.fields.값.trim() },
    needsSupplierConfirm: Boolean(input.needsSupplierConfirm || input.vehicle?.plateUnverified),
  };
  if (input.vehicle) {
    normalized.vehicle = {
      ...(input.vehicle.plate ? { plate: input.vehicle.plate.trim() } : {}),
      ...(input.vehicle.model ? { model: input.vehicle.model.trim() } : {}),
      ...(input.vehicle.plateUnverified ? { plateUnverified: input.vehicle.plateUnverified.trim() } : {}),
    };
  }
  return { ok: true, candidate: { schemaVersion: 'KakaoInfoCandidate/v1', ...normalized, candidateId: kakaoInfoCandidateId(normalized) } };
}

export function assertKakaoInfoCandidate(input: KakaoInfoCandidateInput) {
  const result = createKakaoInfoCandidate(input);
  if (!result.ok) throw new Error(result.reason);
  return result.candidate;
}

export function classifyKakaoInfoSignal(candidate: Pick<KakaoInfoCandidate, 'type' | 'fields' | 'source'>, now: string) {
  if (!Number.isFinite(Date.parse(now))) throw new Error('INVALID_KAKAO_INFO_NOW');
  const ttlMs = stateTypes.has(candidate.type) ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const sent = Date.parse(candidate.source.sentAt);
  const expiresAt = new Date(sent + ttlMs).toISOString();
  return {
    layer: 'T1' as KakaoInfoLayer,
    ttlSeconds: ttlMs / 1000,
    expiresAt,
    isFresh: Date.parse(now) <= Date.parse(expiresAt),
  };
}

export function isKakaoMoneyInfo(type: KakaoInfoType) {
  return moneyTypes.has(type);
}

export function isKakaoStateAutoPromotable(candidate: Pick<KakaoInfoCandidate, 'type' | 'fields'>) {
  return stateTypes.has(candidate.type) && stateSignals.some((signal) =>
    candidate.fields.값.includes(signal) || candidate.fields.요약.includes(signal));
}

export function kakaoInfoFieldsDigest(candidate: Pick<KakaoInfoCandidate, 'fields'>) {
  return stableDigest(candidate.fields);
}
