import { createHash } from 'node:crypto';
import { stableDigest, stableValue } from '../shared/stable-digest.js';

export type KakaoInfoType = '재고' | '가격' | '조건' | '정책변경' | '계약진행';
export type KakaoInfoLayer = 'T0' | 'T1';
export type KakaoInfoPlateEvidenceSource = 'LITERAL_IN_UTTERANCE' | 'LITERAL_IN_PREVIOUS';
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
  | 'PII_DETECTED'
  | 'FUTURE_SENT_AT';

export type KakaoInfoCandidateWarning = { code: 'UNKNOWN_FIELD'; fields: string[] };

export type KakaoInfoCandidateInput = {
  roomCode: string;
  source: { sentAt: string; side: string; msgNo: string; excerpt: string };
  type: KakaoInfoType;
  /**
   * Plate evidence is extractor-owned trust-boundary proof. This transformer cannot inspect
   * neighboring utterance text, so it only preserves literal evidence metadata and demotes
   * missing/out-of-window evidence. D2 write must later verify products/<plate>; if absent,
   * downgrade to vehicle-unspecified. TODO: implement that check in the D2 write stage only.
   */
  vehicle?: {
    plate?: string;
    model?: string;
    plateUnverified?: string;
    plateEvidenceMsgNo?: number;
    plateStatusSameSentence?: boolean;
    plateEvidence?: { source: KakaoInfoPlateEvidenceSource };
  };
  fields: { 요약: string; 값: string };
  confidence: number;
  needsSupplierConfirm: boolean;
  aiInvolved: true;
  status: 'CANDIDATE';
};

export type KakaoInfoCandidate = KakaoInfoCandidateInput & {
  schemaVersion: 'KakaoInfoCandidate/v1';
  candidateId: string;
  warnings?: KakaoInfoCandidateWarning[];
};

export type KakaoInfoCandidateResult =
  | { ok: true; candidate: KakaoInfoCandidate }
  | { ok: false; reason: KakaoInfoRejectReason };

const validTypes = new Set<KakaoInfoType>(['재고', '가격', '조건', '정책변경', '계약진행']);
const stateTypes = new Set<KakaoInfoType>(['재고', '계약진행']);
const moneyTypes = new Set<KakaoInfoType>(['가격', '조건', '정책변경']);
const stateSignals = ['재고 있음', '재고 없음', '접수 가능', '출고 예정', '예약', '불가'];
const statePositiveSignals = ['재고 있음', '접수 가능', '출고 가능', '출고 예정', '예약', '가능'];
const stateNegativeSignals = ['재고 없음', '출고 불가', '불가'];
const stateNegationSignals = ['아님', '않', '없음 아님'];

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
  const normalized = value.replace(/\+82/g, '0').replace(/[()\s.,-]/g, '');
  return /0\d{1,2}\d{7,8}/.test(normalized);
};

const hasResidentNumber = (value: string) => /\d{6}\s*-?\s*[1-4]\d{6}/.test(value);

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

const isThousandCommaAmount = (value: string) => /^\d{1,3}(,\d{3})+$/.test(value.trim());

const hasLongNumericIdentifier = (value: string) => {
  const numericLikeChunks = value.match(/[\d\s().,-]{10,}/g) ?? [];
  return numericLikeChunks.some((chunk) => {
    const digits = chunk.replace(/\D/g, '');
    if (digits.length < 10) return false;
    if (isThousandCommaAmount(chunk)) return false;
    return true;
  });
};

export function hasSensitiveKakaoExcerpt(value: string) {
  return hasPhoneNumber(value)
    || hasResidentNumber(value)
    || hasEmail(value)
    || hasAccountNumber(value)
    || hasLongNumericIdentifier(value);
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

function hasCrossFieldAccountEvidence(values: string[]) {
  const hasAccountKeyword = values.some((value) => /(계좌|은행|입금)/.test(value));
  if (!hasAccountKeyword) return false;
  return values.some((value) => value.replace(/\D/g, '').length >= 10);
}

const allowedInputFields = new Set([
  'roomCode',
  'source',
  'type',
  'vehicle',
  'fields',
  'confidence',
  'needsSupplierConfirm',
  'aiInvolved',
  'status',
]);

const allowedSourceFields = new Set(['sentAt', 'side', 'msgNo', 'excerpt']);
const allowedVehicleFields = new Set(['plate', 'model', 'plateUnverified', 'plateEvidenceMsgNo', 'plateStatusSameSentence', 'plateEvidence']);
const allowedPlateEvidenceFields = new Set(['source']);
const allowedFieldsFields = new Set(['요약', '값']);

function collectUnknownFields(input: KakaoInfoCandidateInput) {
  const fields: string[] = [];
  for (const key of Object.keys(input as unknown as Record<string, unknown>)) {
    if (!allowedInputFields.has(key)) fields.push(key);
  }
  for (const key of Object.keys(input.source as unknown as Record<string, unknown> ?? {})) {
    if (!allowedSourceFields.has(key)) fields.push(`source.${key}`);
  }
  for (const key of Object.keys(input.vehicle as unknown as Record<string, unknown> ?? {})) {
    if (!allowedVehicleFields.has(key)) fields.push(`vehicle.${key}`);
  }
  for (const key of Object.keys(input.vehicle?.plateEvidence as unknown as Record<string, unknown> ?? {})) {
    if (!allowedPlateEvidenceFields.has(key)) fields.push(`vehicle.plateEvidence.${key}`);
  }
  for (const key of Object.keys(input.fields as unknown as Record<string, unknown> ?? {})) {
    if (!allowedFieldsFields.has(key)) fields.push(`fields.${key}`);
  }
  return fields;
}

function isValidRoomCode(value: string) {
  const trimmed = value.trim();
  if (!/^K-[A-Z0-9]{3,12}$/.test(trimmed)) return false;
  const suffix = trimmed.slice(2);
  if (/^\d{10,}$/.test(suffix)) return false;
  return !hasSensitiveKakaoExcerpt(trimmed);
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
  if (!isValidRoomCode(input.roomCode)) return { ok: false, reason: 'INVALID_ROOM_CODE' };
  if (!Number.isFinite(Date.parse(input.source?.sentAt)) || !nonBlank(input.source?.msgNo)) {
    return { ok: false, reason: 'INVALID_SOURCE' };
  }
  if (Date.parse(input.source.sentAt) - Date.now() > 5 * 60 * 1000) return { ok: false, reason: 'FUTURE_SENT_AT' };
  if (input.source.side !== '상대') return { ok: false, reason: 'SENDER_UNVERIFIED' };
  if (!nonBlank(input.source.excerpt) || Array.from(input.source.excerpt).length > 80) {
    return { ok: false, reason: 'INVALID_EXCERPT' };
  }
  const stringValues = candidateStringValues(input);
  if (stringValues.some(hasSensitiveKakaoExcerpt) || hasCrossFieldAccountEvidence(stringValues)) {
    return { ok: false, reason: 'PII_DETECTED' };
  }
  if (!validTypes.has(input.type)) return { ok: false, reason: 'INVALID_TYPE' };
  if (!nonBlank(input.fields?.요약) || !nonBlank(input.fields?.값)) return { ok: false, reason: 'INVALID_FIELDS' };
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    return { ok: false, reason: 'INVALID_CONFIDENCE' };
  }
  if (input.aiInvolved !== true || input.status !== 'CANDIDATE') return { ok: false, reason: 'INVALID_STATUS' };

  const unknownFields = collectUnknownFields(input);
  const warnings = unknownFields.length ? [{ code: 'UNKNOWN_FIELD' as const, fields: unknownFields }] : undefined;
  const normalized: KakaoInfoCandidateInput = {
    roomCode: input.roomCode.trim(),
    source: {
      sentAt: new Date(input.source.sentAt).toISOString(),
      side: '상대',
      msgNo: input.source.msgNo.trim(),
      excerpt: input.source.excerpt,
    },
    fields: { 요약: input.fields.요약.trim(), 값: input.fields.값.trim() },
    confidence: input.confidence,
    needsSupplierConfirm: Boolean(input.needsSupplierConfirm || input.vehicle?.plateUnverified),
    aiInvolved: true,
    type: input.type,
    status: 'CANDIDATE',
  };
  if (input.vehicle) {
    const sourceMsgNo = parseMsgNo(input.source.msgNo);
    const plate = input.vehicle.plate?.trim();
    const plateEvidenceMsgNo = typeof input.vehicle.plateEvidenceMsgNo === 'number' && Number.isInteger(input.vehicle.plateEvidenceMsgNo)
      ? input.vehicle.plateEvidenceMsgNo
      : undefined;
    const plateEvidenceSource = input.vehicle.plateEvidence?.source;
    const plateDistance = plateEvidenceMsgNo !== undefined ? sourceMsgNo - plateEvidenceMsgNo : Number.NaN;
    const plateHasEvidence =
      Boolean(plate) &&
      Number.isInteger(plateEvidenceMsgNo) &&
      plateEvidenceSource === 'LITERAL_IN_UTTERANCE' &&
      Number.isInteger(sourceMsgNo) &&
      plateDistance === 0 &&
      plateEvidenceMsgNo === sourceMsgNo &&
      input.vehicle.plateStatusSameSentence === true &&
      normalizePlateText(input.source.excerpt).includes(normalizePlateText(plate!));
    const plateUnverified = plateHasEvidence ? input.vehicle.plateUnverified?.trim() : plate || input.vehicle.plateUnverified?.trim();
    normalized.vehicle = {
      ...(plateHasEvidence && plate ? { plate } : {}),
      ...(input.vehicle.model ? { model: input.vehicle.model.trim() } : {}),
      ...(plateUnverified ? { plateUnverified } : {}),
      ...(plateEvidenceMsgNo !== undefined ? { plateEvidenceMsgNo: plateEvidenceMsgNo } : {}),
      ...(input.vehicle.plateStatusSameSentence === true ? { plateStatusSameSentence: true } : {}),
      ...(plateHasEvidence && plateEvidenceSource ? { plateEvidence: { source: plateEvidenceSource } } : {}),
    };
    normalized.needsSupplierConfirm = Boolean(normalized.needsSupplierConfirm || plateUnverified);
  }
  return { ok: true, candidate: { schemaVersion: 'KakaoInfoCandidate/v1', ...normalized, candidateId: kakaoInfoCandidateId(normalized), ...(warnings ? { warnings } : {}) } };
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
  const nowMs = Date.parse(now);
  return {
    layer: 'T1' as KakaoInfoLayer,
    ttlSeconds: ttlMs / 1000,
    expiresAt,
    isFresh: sent - nowMs <= 5 * 60 * 1000 && nowMs <= Date.parse(expiresAt),
  };
}

export function isKakaoMoneyInfo(type: KakaoInfoType) {
  return moneyTypes.has(type);
}

export function isKakaoStateAutoPromotable(candidate: Pick<KakaoInfoCandidate, 'type' | 'fields' | 'source' | 'vehicle'>, isFresh = true) {
  const text = `${candidate.fields.요약} ${candidate.fields.값}`;
  const hasPositive = statePositiveSignals.some((signal) => text.includes(signal));
  const hasNegative = stateNegativeSignals.some((signal) => text.includes(signal));
  const hasNegation = stateNegationSignals.some((signal) => text.includes(signal));
  const sourceMsgNo = parseMsgNo(candidate.source.msgNo);
  const plateEvidenceMsgNo = candidate.vehicle?.plateEvidenceMsgNo;
  const plate = candidate.vehicle?.plate;
  const hasLiteralSameSentencePlate =
    Boolean(plate) &&
    candidate.vehicle?.plateEvidence?.source === 'LITERAL_IN_UTTERANCE' &&
    candidate.vehicle?.plateStatusSameSentence === true &&
    Number.isInteger(sourceMsgNo) &&
    plateEvidenceMsgNo === sourceMsgNo &&
    normalizePlateText(candidate.source.excerpt).includes(normalizePlateText(plate!));
  return stateTypes.has(candidate.type)
    && isFresh
    && hasLiteralSameSentencePlate
    && !hasNegation
    && !(hasPositive && hasNegative)
    && stateSignals.some((signal) => text.includes(signal));
}

export function kakaoInfoFieldsDigest(candidate: Pick<KakaoInfoCandidate, 'fields'>) {
  return stableDigest(candidate.fields);
}
