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
  | 'INVALID_STATUS'
  | 'PII_DETECTED';

export type KakaoInfoCandidateInput = {
  roomCode: string;
  source: { sentAt: string; side: string; msgNo: string; excerpt: string };
  type: KakaoInfoType;
  vehicle?: { plate?: string; model?: string; plateUnverified?: string; plateEvidenceMsgNo?: number };
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

const normalizePlateText = (value: string) => value.replace(/[^0-9A-Za-z가-힣]/g, '').toUpperCase();

const parseMsgNo = (value: string) => {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const trailing = trimmed.match(/(\d+)$/);
  return trailing ? Number(trailing[1]) : Number.NaN;
};

const hasPhoneNumber = (value: string) => {
  const normalized = value.replace(/\+82/g, '0').replace(/[()\s.-]/g, '');
  return /(?:010|011|016|017|018|019)\d{7,8}/.test(normalized) || /0[2-6]\d{7,8}/.test(normalized);
};

const hasResidentNumber = (value: string) => /\d{6}\s*-\s*[1-4]\d{6}/.test(value);

const hasEmail = (value: string) => /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value);

const hasAccountNumber = (value: string) => {
  const hyphenAccount = value.match(/\d{2,6}-\d{2,6}-\d{2,8}/);
  if (hyphenAccount) {
    const digits = hyphenAccount[0].replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 14) return true;
  }
  if (!/(계좌|은행|입금)/.test(value)) return false;
  const digits = value.replace(/\D/g, '');
  return /\d[\d\s.-]{8,}\d/.test(value) && digits.length >= 10 && digits.length <= 14;
};

export function hasSensitiveKakaoExcerpt(value: string) {
  return hasPhoneNumber(value) || hasResidentNumber(value) || hasEmail(value) || hasAccountNumber(value);
}

function candidateStringValues(input: KakaoInfoCandidateInput) {
  const strings: string[] = [
    input.source?.sentAt,
    input.source?.side,
    input.source?.msgNo,
    input.source?.excerpt,
    input.type,
    input.fields?.요약,
    input.fields?.값,
    input.vehicle?.plate,
    input.vehicle?.model,
    input.vehicle?.plateUnverified,
  ].filter((value): value is string => typeof value === 'string');
  return strings;
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
  if (candidateStringValues(input).some(hasSensitiveKakaoExcerpt)) return { ok: false, reason: 'PII_DETECTED' };
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
    const sourceMsgNo = parseMsgNo(input.source.msgNo);
    const plate = input.vehicle.plate?.trim();
    const plateEvidenceMsgNo = typeof input.vehicle.plateEvidenceMsgNo === 'number' && Number.isInteger(input.vehicle.plateEvidenceMsgNo)
      ? input.vehicle.plateEvidenceMsgNo
      : undefined;
    const plateDistance = plateEvidenceMsgNo !== undefined ? sourceMsgNo - plateEvidenceMsgNo : Number.NaN;
    const plateHasEvidence =
      Boolean(plate) &&
      Number.isInteger(plateEvidenceMsgNo) &&
      Number.isInteger(sourceMsgNo) &&
      plateDistance >= 0 &&
      plateDistance <= 2 &&
      (plateDistance !== 0 || normalizePlateText(input.source.excerpt).includes(normalizePlateText(plate!)));
    const plateUnverified = plateHasEvidence ? input.vehicle.plateUnverified?.trim() : plate || input.vehicle.plateUnverified?.trim();
    normalized.vehicle = {
      ...(plateHasEvidence && plate ? { plate } : {}),
      ...(input.vehicle.model ? { model: input.vehicle.model.trim() } : {}),
      ...(plateUnverified ? { plateUnverified } : {}),
      ...(plateEvidenceMsgNo !== undefined ? { plateEvidenceMsgNo: plateEvidenceMsgNo } : {}),
    };
    normalized.needsSupplierConfirm = Boolean(normalized.needsSupplierConfirm || plateUnverified);
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
