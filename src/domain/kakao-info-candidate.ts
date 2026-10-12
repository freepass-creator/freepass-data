import { createHash } from 'node:crypto';
import { stableDigest, stableValue } from '../shared/stable-digest.js';

export type KakaoInfoType = '재고' | '가격' | '조건' | '정책변경' | '계약진행' | '서류요구' | '접수가능';
export type KakaoInfoLayer = 'T0' | 'T1';
export type KakaoInfoPlateEvidenceSource = 'LITERAL_IN_UTTERANCE' | 'LITERAL_IN_PREVIOUS';
export type KakaoInfoRejectReason =
  | 'INVALID_ROOM_CODE'
  | 'INVALID_SOURCE'
  | 'INVALID_MSG_NO'
  | 'INVALID_PLATE_EVIDENCE'
  | 'SENDER_UNVERIFIED'
  | 'INVALID_EXCERPT'
  | 'SENSITIVE_EXCERPT'
  | 'INVALID_TYPE'
  | 'TYPE_NOT_ACCEPTED'
  | 'INVALID_FIELDS'
  | 'INVALID_CONFIDENCE'
  | 'INVALID_STATUS'
  | 'PII_DETECTED'
  | 'FUTURE_SENT_AT';

export type KakaoInfoCandidateWarning = { code: 'UNKNOWN_FIELDS_DROPPED'; count: number };

export type KakaoInfoCandidateInput = {
  supplierCode: string;
  roomCode: string;
  source: { sentAt: string; side: string; msgNo: string; excerpt: string };
  type: KakaoInfoType;
  vehicle?: {
    plate?: string;
    model?: string;
    plateUnverified?: string;
    plateEvidenceMsgNo?: number;
    plateEvidence?: { source: KakaoInfoPlateEvidenceSource; distance?: 0 | 1 | 2 };
    plateStatusSameSentence?: boolean;
  };
  fields: { 항목: string; 요약: string; 값: string };
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

const validTypes = new Set<KakaoInfoType>(['재고', '가격', '조건', '정책변경', '계약진행', '서류요구', '접수가능']);
const rejectedInputTypes = new Set<string>(['영업요구']);
const stateTypes = new Set<KakaoInfoType>(['재고', '계약진행']);
const t0OnlyTypes = new Set<KakaoInfoType>(['서류요구', '접수가능']);
const moneyTypes = new Set<KakaoInfoType>(['가격', '조건', '정책변경']);
const stateSignals = ['재고 있음', '재고 없음', '접수 가능', '출고 예정', '예약', '불가'];
const statePositiveSignals = ['재고 있음', '접수 가능', '출고 가능', '출고 예정', '예약', '가능'];
const stateNegativeSignals = ['재고 없음', '출고 불가', '불가'];
const stateNegationSignals = ['아님', '않', '없음 아님'];

const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isStrictIsoUtc = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const isValidMsgNo = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,6}$/.test(value.trim());

const isValidSupplierCode = (value: unknown): value is string =>
  typeof value === 'string' && /^(RP|PT-)\d{1,5}$/.test(value.trim());

const normalizePlateText = (value: string) => value.replace(/[^0-9A-Za-z가-힣]/g, '').toUpperCase();

export const isValidKakaoInfoPlate = (value: string) => /^\d{2,3}[가-힣]\d{4}$/.test(normalizePlateText(value));

const isDigit = (value: string | undefined) => value !== undefined && /^\d$/.test(value);

function hasPlateLiteralWithNumericBoundary(excerpt: string, plate: string) {
  const normalizedExcerpt = normalizePlateText(excerpt);
  const normalizedPlate = normalizePlateText(plate);
  let index = normalizedExcerpt.indexOf(normalizedPlate);
  while (index >= 0) {
    const previous = normalizedExcerpt[index - 1];
    const next = normalizedExcerpt[index + normalizedPlate.length];
    if (!isDigit(previous) && !isDigit(next)) return true;
    index = normalizedExcerpt.indexOf(normalizedPlate, index + 1);
  }
  return false;
}

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
    input.source?.side,
    input.type,
    input.vehicle?.plate,
    input.source?.excerpt,
    input.fields?.항목,
    input.fields?.요약,
    input.fields?.값,
    input.vehicle?.model,
    input.vehicle?.plateUnverified,
  ].filter((value): value is string => typeof value === 'string');
  return strings;
}

function exceedsResidualDigitBudget(values: string[]) {
  let digits = 0;
  let concat = '';
  const stripped = (match: string) => { concat += match.replace(/\D/g, ''); return ' '; };
  for (const raw of values) {
    let text = raw;
    text = text.replace(/(?<!\d)\d{2,3}[\s-]*[가나다라마거너더러머버서어저고노도로모보소오조구누두루무부수우주아바사자배하허호][\s-]*\d{4}(?!\d)/g, ' ');
    text = text.replace(/(?<!\d)\d{2,3}\s*[가나다라마거너더러머버서어저고노도로모보소오조구누두루무부수우주아바사자배하허호]\s*\d{4}(?!\d)/g, ' ');
    text = text.replace(/\d{4}-\d{2}-\d{2}(?:T[0-9:.]+Z?)?/g, ' ')
      .replace(/(?<![\d,])\d{1,3}(?:,\d{3}){1,2}(?![\d,])\s*원?/g, stripped)
      .replace(/(?<!\d)\d{1,9}\s*(?:만원|만|천원|원|개월|월|일|km|㎞|대|건|%)/g, stripped);
    for (const run of text.match(/\d+/g) ?? []) {
      concat += run;
      if (run.length <= 5 || run.length >= 10) digits += run.length;
    }
  }
  if (/01[016789]\d{7,8}/.test(concat) || /\d{6}[1-4]\d{6}/.test(concat)) return true;
  return digits >= 8;
}

function candidateSensitiveProbeValues(values: string[]) {
  const adjacent = values.slice(0, -1).flatMap((value, index) => [`${value}${values[index + 1]}`, `${values[index + 1]}${value}`]);
  return [...values, values.join(''), values.join(' '), ...adjacent];
}

function hasCrossFieldAccountEvidence(values: string[]) {
  return values.some((value, index) => {
    if (!/(계좌|은행|입금)/.test(value)) return false;
    return [
      value,
      `${value}${values[index - 1] ?? ''}`,
      `${value}${values[index + 1] ?? ''}`,
    ].some((probe) => probe.replace(/\D/g, '').length >= 10);
  });
}

const allowedInputFields = new Set([
  'supplierCode',
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
const allowedPlateEvidenceFields = new Set(['source', 'distance']);
const allowedFieldsFields = new Set(['항목', '요약', '값']);

function collectUnknownFields(input: KakaoInfoCandidateInput) {
  let count = 0;
  let hasSensitiveKey = false;
  const add = (key: string) => {
    count += 1;
    if (hasSensitiveKakaoExcerpt(key)) hasSensitiveKey = true;
  };
  for (const key of Object.keys(input as unknown as Record<string, unknown>)) {
    if (!allowedInputFields.has(key)) add(key);
  }
  for (const key of Object.keys(input.source as unknown as Record<string, unknown> ?? {})) {
    if (!allowedSourceFields.has(key)) add(key);
  }
  for (const key of Object.keys(input.vehicle as unknown as Record<string, unknown> ?? {})) {
    if (!allowedVehicleFields.has(key)) add(key);
  }
  for (const key of Object.keys(input.vehicle?.plateEvidence as unknown as Record<string, unknown> ?? {})) {
    if (!allowedPlateEvidenceFields.has(key)) add(key);
  }
  for (const key of Object.keys(input.fields as unknown as Record<string, unknown> ?? {})) {
    if (!allowedFieldsFields.has(key)) add(key);
  }
  return { count, hasSensitiveKey };
}

function isValidRoomCode(value: string) {
  const trimmed = value.trim();
  if (!/^K-[A-Z0-9]{3,12}$/.test(trimmed)) return false;
  const suffix = trimmed.slice(2);
  if (/^\d{10,}$/.test(suffix)) return false;
  if ((suffix.match(/\d/g) ?? []).length > 6) return false;
  return !hasSensitiveKakaoExcerpt(trimmed);
}

export function kakaoVehicleKey(candidate: Pick<KakaoInfoCandidateInput, 'vehicle'>) {
  const plate = candidate.vehicle?.plate?.trim();
  if (plate && isValidKakaoInfoPlate(plate)) return normalizePlateText(plate);
  return 'UNSPECIFIED';
}

export function kakaoInfoCandidateId(input: KakaoInfoCandidateInput) {
  const fieldsHash = createHash('sha256')
    .update(JSON.stringify(stableValue(input.fields)))
    .digest('hex');
  return createHash('sha256')
    .update([
      input.supplierCode.trim(),
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
  if (!isValidSupplierCode(input.supplierCode)) return { ok: false, reason: 'INVALID_FIELDS' };
  if (!isStrictIsoUtc(input.source?.sentAt)) {
    return { ok: false, reason: 'INVALID_SOURCE' };
  }
  if (!isValidMsgNo(input.source?.msgNo)) return { ok: false, reason: 'INVALID_MSG_NO' };
  // 차량 근거 msgNo 도 메시지 번호와 같은 범위(0~999999 정수)만 허용한다 — 긴 숫자(주민번호 등)가 출력에 새지 않게.
  if (input.vehicle?.plateEvidenceMsgNo !== undefined
    && !(typeof input.vehicle.plateEvidenceMsgNo === 'number' && Number.isInteger(input.vehicle.plateEvidenceMsgNo)
      && input.vehicle.plateEvidenceMsgNo >= 0 && input.vehicle.plateEvidenceMsgNo <= 999999)) {
    return { ok: false, reason: 'INVALID_PLATE_EVIDENCE' };
  }
  if (Date.parse(input.source.sentAt) - Date.now() > 5 * 60 * 1000) return { ok: false, reason: 'FUTURE_SENT_AT' };
  if (input.source.side !== '상대') return { ok: false, reason: 'SENDER_UNVERIFIED' };
  if (!nonBlank(input.source.excerpt) || Array.from(input.source.excerpt).length > 80) {
    return { ok: false, reason: 'INVALID_EXCERPT' };
  }
  const stringValues = candidateStringValues(input);
  if (candidateSensitiveProbeValues(stringValues).some(hasSensitiveKakaoExcerpt) || hasCrossFieldAccountEvidence(stringValues)
    || stringValues.some((value) => value.includes('@')) // 이메일 조각은 어떤 칸에도 허용하지 않는다(칸 분할 우회 차단)
    || exceedsResidualDigitBudget([...stringValues, (input.source.msgNo ?? '').length >= 5 ? input.source.msgNo : ''])) {
    return { ok: false, reason: 'PII_DETECTED' };
  }
  if (rejectedInputTypes.has(String(input.type))) return { ok: false, reason: 'TYPE_NOT_ACCEPTED' };
  if (!validTypes.has(input.type)) return { ok: false, reason: 'INVALID_TYPE' };
  if (!nonBlank(input.fields?.항목) || !nonBlank(input.fields?.요약) || !nonBlank(input.fields?.값)) return { ok: false, reason: 'INVALID_FIELDS' };
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    return { ok: false, reason: 'INVALID_CONFIDENCE' };
  }
  if (input.aiInvolved !== true || input.status !== 'CANDIDATE') return { ok: false, reason: 'INVALID_STATUS' };

  const unknownFields = collectUnknownFields(input);
  if (unknownFields.hasSensitiveKey) return { ok: false, reason: 'PII_DETECTED' };
  const warnings = unknownFields.count ? [{ code: 'UNKNOWN_FIELDS_DROPPED' as const, count: unknownFields.count }] : undefined;
  const normalized: KakaoInfoCandidateInput = {
    supplierCode: input.supplierCode.trim(),
    roomCode: input.roomCode.trim(),
    source: {
      sentAt: new Date(input.source.sentAt).toISOString(),
      side: '상대',
      msgNo: input.source.msgNo.trim(),
      excerpt: input.source.excerpt,
    },
    fields: { 항목: input.fields.항목.trim(), 요약: input.fields.요약.trim(), 값: input.fields.값.trim() },
    confidence: Math.round(input.confidence * 100) / 100,
    needsSupplierConfirm: Boolean(input.needsSupplierConfirm || input.vehicle?.plateUnverified),
    aiInvolved: true,
    type: input.type,
    status: 'CANDIDATE',
  };
  if (input.vehicle) {
    const sourceMsgNo = parseMsgNo(input.source.msgNo);
    const plate = input.vehicle.plate?.trim();
    const validPlate = plate && isValidKakaoInfoPlate(plate) ? normalizePlateText(plate) : undefined;
    const plateEvidenceMsgNo = typeof input.vehicle.plateEvidenceMsgNo === 'number' && Number.isInteger(input.vehicle.plateEvidenceMsgNo)
      ? input.vehicle.plateEvidenceMsgNo
      : undefined;
    const plateEvidenceSource = input.vehicle.plateEvidence?.source;
    const declaredDistance = input.vehicle.plateEvidence?.distance;
    const plateDistance = plateEvidenceMsgNo !== undefined ? sourceMsgNo - plateEvidenceMsgNo : Number.NaN;
    const plateEvidenceDistanceAccepted = declaredDistance === undefined || declaredDistance === plateDistance;
    const plateHasEvidence =
      Boolean(validPlate) &&
      Number.isInteger(plateEvidenceMsgNo) &&
      plateEvidenceSource === 'LITERAL_IN_UTTERANCE' &&
      Number.isInteger(sourceMsgNo) &&
      plateDistance === 0 &&
      plateEvidenceMsgNo === sourceMsgNo &&
      input.vehicle.plateStatusSameSentence === true &&
      plateEvidenceDistanceAccepted &&
      hasPlateLiteralWithNumericBoundary(input.source.excerpt, validPlate!);
    const plateUnverified = plateHasEvidence ? input.vehicle.plateUnverified?.trim() : plate || input.vehicle.plateUnverified?.trim();
    normalized.vehicle = {
      ...(plateHasEvidence && validPlate ? { plate: validPlate } : {}),
      ...(input.vehicle.model ? { model: input.vehicle.model.trim() } : {}),
      ...(plateUnverified ? { plateUnverified } : {}),
      ...(plateEvidenceMsgNo !== undefined ? { plateEvidenceMsgNo } : {}),
      ...(input.vehicle.plateStatusSameSentence === true ? { plateStatusSameSentence: true } : {}),
      ...(plateHasEvidence && plateEvidenceSource ? { plateEvidence: { source: plateEvidenceSource, distance: plateDistance as 0 | 1 | 2 } } : {}),
    };
    normalized.needsSupplierConfirm = Boolean(normalized.needsSupplierConfirm || plateUnverified);
  }
  const finalValues = candidateStringValues(normalized);
  if (candidateSensitiveProbeValues(finalValues).some(hasSensitiveKakaoExcerpt) || hasCrossFieldAccountEvidence(finalValues)
    || finalValues.some((value) => value.includes('@'))
    || exceedsResidualDigitBudget([...finalValues, normalized.source.msgNo.length >= 5 ? normalized.source.msgNo : ''])) {
    return { ok: false, reason: 'PII_DETECTED' };
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
  const ttlMs = candidate.type === '서류요구'
    ? 30 * 24 * 60 * 60 * 1000
    : stateTypes.has(candidate.type) || candidate.type === '접수가능'
      ? 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000;
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

export function isKakaoT0OnlyInfo(type: KakaoInfoType) {
  return t0OnlyTypes.has(type);
}

export function isKakaoStateAutoPromotable(candidate: Pick<KakaoInfoCandidate, 'type' | 'fields' | 'source' | 'vehicle'>, isFresh: boolean) {
  if (typeof isFresh !== 'boolean') throw new Error('INVALID_KAKAO_INFO_FRESHNESS');
  const text = `${candidate.fields.요약} ${candidate.fields.값}`;
  const hasPositive = statePositiveSignals.some((signal) => text.includes(signal));
  const hasNegative = stateNegativeSignals.some((signal) => text.includes(signal));
  const hasNegation = stateNegationSignals.some((signal) => text.includes(signal));
  const sourceMsgNo = parseMsgNo(candidate.source.msgNo);
  const plateEvidenceMsgNo = candidate.vehicle?.plateEvidenceMsgNo;
  const plate = candidate.vehicle?.plate;
  const hasLiteralSameSentencePlate =
    typeof plate === 'string' &&
    isValidKakaoInfoPlate(plate) &&
    candidate.vehicle?.plateEvidence?.source === 'LITERAL_IN_UTTERANCE' &&
    candidate.vehicle.plateEvidence.distance === 0 &&
    candidate.vehicle?.plateStatusSameSentence === true &&
    Number.isInteger(sourceMsgNo) &&
    plateEvidenceMsgNo === sourceMsgNo &&
    hasPlateLiteralWithNumericBoundary(candidate.source.excerpt, plate);
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
