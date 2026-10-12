import { classifyKakaoInfoSignal, isKakaoMoneyInfo, isKakaoT0OnlyInfo, type KakaoInfoPlateEvidenceSource } from '../domain/kakao-info-candidate.js';
import type { SourceIngestionStore } from '../ports/source-store.js';
import { hasKakaoInfoStoredInvariantViolation } from './apply-kakao-info-candidates.js';

export type KakaoKnownFactTopic = '재고' | '가격' | '조건' | '정책변경' | '계약진행' | '서류요구' | '접수가능';

export type KakaoKnownFact = {
  layer: 'T0' | 'T1' | 'T2' | 'T3';
  topic: KakaoKnownFactTopic;
  item: string;
  valueSummary: string;
  sentAt: string;
  roomCode: string;
  expiresAt: string;
  hasConflict: boolean;
  plateEvidence: { msgNo: number | null; source: KakaoInfoPlateEvidenceSource | null };
  signalOnly: boolean;
};

export type KakaoKnownFactReadResult = KakaoKnownFact[] & { warningCount: number };

export type KakaoKnownFactQuery = {
  vehicleKey?: string;
  vehicleUid?: string;
  supplierCode: string;
  topic: KakaoKnownFactTopic;
  asOf: string;
};

const SOURCE_ID = 'kakao-info-candidate';
const futureToleranceMs = 5 * 60 * 1000;

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function maskValue(value: string) {
  return value.replace(/\d{2,}/g, match => match.length >= 4 ? `${match.slice(0, 2)}***` : match);
}

function validTime(value: string) {
  return Number.isFinite(Date.parse(value));
}

function matchesSupplier(candidate: Record<string, unknown>, info: Record<string, unknown>, supplierCode: string) {
  const supplier = text(info.supplierCode)
    || text(info.supplierId)
    || text(candidate.supplierCode)
    || text(candidate.supplierId);
  return Boolean(supplier) && supplier === supplierCode;
}

function matchesVehicle(root: Record<string, unknown>, vehicle: Record<string, unknown> | undefined, query: KakaoKnownFactQuery) {
  const resolution = text((root.kakaoInfo as Record<string, unknown> | undefined)?.vehicleResolution);
  if (!query.vehicleKey && !query.vehicleUid) return true;
  if (resolution !== 'LINKED') return false;
  const productRef = text(vehicle?.productRef);
  const bodyPlate = text(root.carNumber);
  const vehicleUid = text(vehicle?.vehicleUid);
  const vehicleKeyRef = query.vehicleKey ? `products/${query.vehicleKey}` : '';
  if (query.vehicleUid) {
    // 저장된 UID 가 있어야만 UID 로 확인한다 — UID–번호 연결을 확인할 수 없으면 반환하지 않는다(fail-closed).
    return Boolean(vehicleUid) && vehicleUid === query.vehicleUid;
  }
  if (!query.vehicleKey) return false;
  return bodyPlate === query.vehicleKey || productRef === vehicleKeyRef;
}

function factLayer(topic: KakaoKnownFactTopic, vehicleResolution: string, channel: string): KakaoKnownFact['layer'] {
  return vehicleResolution === 'LINKED' && !isKakaoT0OnlyInfo(topic) && (channel === '' || channel === 'KAKAO_RAW') ? 'T1' : 'T0';
}

function recomputedSignal(info: Record<string, unknown>, asOf: string) {
  const sentAt = text(info.sentAt);
  const type = info.type as KakaoKnownFactTopic;
  if (!validTime(sentAt)) return null;
  return classifyKakaoInfoSignal({
    type,
    fields: { 항목: text(info.item), 요약: text(info.summary), 값: text(info.value) },
    source: {
      sentAt, side: '', msgNo: '', excerpt: '',
      ...(text(info.channel) ? { channel: text(info.channel) as 'KAKAO_RAW' | 'EN1_SUMMARY' | 'KAKAO_NOTICE' } : {}),
      ...(info.noticeFixed === true ? { noticeFixed: true as const } : {}),
    },
  }, asOf);
}

export async function readKakaoKnownFacts(
  store: Pick<SourceIngestionStore, 'listCandidatesBySource'>,
  query: KakaoKnownFactQuery,
): Promise<KakaoKnownFactReadResult> {
  if (!query.asOf || !Number.isFinite(Date.parse(query.asOf))) throw new Error('KAKAO_FACT_AS_OF_REQUIRED');
  if (!query.supplierCode?.trim()) throw new Error('KAKAO_FACT_SUPPLIER_REQUIRED');
  const asOfMs = Date.parse(query.asOf);
  const records = await store.listCandidatesBySource(SOURCE_ID);
  let warningCount = 0;
  const facts = records.flatMap(record => {
    if (hasKakaoInfoStoredInvariantViolation(record.candidate)) {
      warningCount++;
      return [];
    }
    const root = record.candidate as Record<string, unknown>;
    const info = (record.candidate as { kakaoInfo?: Record<string, unknown> }).kakaoInfo;
    if (!info || info.type !== query.topic) return [];
    if (!matchesSupplier(root, info, query.supplierCode)) return [];
    const vehicle = info.vehicle as Record<string, unknown> | undefined;
    const vehicleResolution = text(info.vehicleResolution);
    if (!matchesVehicle(root, vehicle, query)) return [];
    const sentAt = text((info as { sentAt?: unknown }).sentAt);
    const signal = recomputedSignal(info, query.asOf);
    const expectedLayer = factLayer(query.topic, vehicleResolution, text(info.channel));
    if (!query.vehicleKey && !query.vehicleUid && expectedLayer !== 'T0') return [];
    if (!signal || text(info.expiresAt) !== signal.expiresAt || text(info.layer) !== expectedLayer) {
      warningCount++;
      return [];
    }
    const expiresAt = signal.expiresAt;
    if (Date.parse(expiresAt) < asOfMs) return [];
    if (!validTime(sentAt) || Date.parse(sentAt) - asOfMs > futureToleranceMs) return [];
    const candidate = (record.candidate as { kakaoInfo?: Record<string, unknown> }).kakaoInfo!;
    const plateEvidenceSource: KakaoInfoPlateEvidenceSource | null =
      vehicle?.plateEvidenceSource === 'LITERAL_IN_UTTERANCE' || vehicle?.plateEvidenceSource === 'LITERAL_IN_PREVIOUS'
        ? vehicle.plateEvidenceSource
        : null;
    return [{
      layer: expectedLayer,
      topic: query.topic,
      item: text(candidate.item || candidate.summary),
      valueSummary: maskValue(text(candidate.value)),
      sentAt,
      roomCode: text(candidate.roomCode),
      expiresAt,
      hasConflict: candidate.conflict === true,
      plateEvidence: {
        msgNo: typeof vehicle?.plateEvidenceMsgNo === 'number' ? vehicle.plateEvidenceMsgNo : null,
        source: plateEvidenceSource,
      },
      signalOnly: isKakaoMoneyInfo(query.topic),
    }];
  });
  const sorted = facts.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt)) as KakaoKnownFactReadResult;
  Object.defineProperty(sorted, 'warningCount', { value: warningCount, enumerable: false });
  return sorted;
}
