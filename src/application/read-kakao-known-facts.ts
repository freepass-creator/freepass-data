import { classifyKakaoInfoSignal, isKakaoMoneyInfo, isKakaoT0OnlyInfo, type KakaoInfoPlateEvidenceSource } from '../domain/kakao-info-candidate.js';
import type { SourceIngestionStore } from '../ports/source-store.js';

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

function matchesVehicle(vehicle: Record<string, unknown> | undefined, query: KakaoKnownFactQuery) {
  const productRef = text(vehicle?.productRef);
  const vehicleUid = text(vehicle?.vehicleUid);
  const vehicleKeyRef = query.vehicleKey ? `products/${query.vehicleKey}` : '';
  if (query.vehicleUid) {
    if (vehicleUid) return vehicleUid === query.vehicleUid;
    if (query.vehicleKey && productRef) return productRef === vehicleKeyRef;
    return false;
  }
  if (!query.vehicleKey) return false;
  return productRef === vehicleKeyRef;
}

function factLayer(topic: KakaoKnownFactTopic): KakaoKnownFact['layer'] {
  return isKakaoT0OnlyInfo(topic) ? 'T0' : 'T1';
}

function recomputedSignal(info: Record<string, unknown>, asOf: string) {
  const sentAt = text(info.sentAt);
  const type = info.type as KakaoKnownFactTopic;
  if (!validTime(sentAt)) return null;
  return classifyKakaoInfoSignal({
    type,
    fields: { 항목: text(info.item), 요약: text(info.summary), 값: text(info.value) },
    source: { sentAt, side: '', msgNo: '', excerpt: '' },
  }, asOf);
}

export async function readKakaoKnownFacts(
  store: Pick<SourceIngestionStore, 'listCandidatesBySource'>,
  query: KakaoKnownFactQuery,
): Promise<KakaoKnownFactReadResult> {
  if (!query.asOf || !Number.isFinite(Date.parse(query.asOf))) throw new Error('KAKAO_FACT_AS_OF_REQUIRED');
  if (!query.supplierCode?.trim()) throw new Error('KAKAO_FACT_SUPPLIER_REQUIRED');
  if (!query.vehicleKey && !query.vehicleUid) throw new Error('KAKAO_FACT_VEHICLE_REQUIRED');
  const asOfMs = Date.parse(query.asOf);
  const records = await store.listCandidatesBySource(SOURCE_ID);
  let warningCount = 0;
  const facts = records.flatMap(record => {
    const root = record.candidate as Record<string, unknown>;
    const info = (record.candidate as { kakaoInfo?: Record<string, unknown> }).kakaoInfo;
    if (!info || info.type !== query.topic) return [];
    if (!matchesSupplier(root, info, query.supplierCode)) return [];
    const vehicle = info.vehicle as Record<string, unknown> | undefined;
    if (!matchesVehicle(vehicle, query)) return [];
    const sentAt = text((info as { sentAt?: unknown }).sentAt);
    const signal = recomputedSignal(info, query.asOf);
    const expectedLayer = factLayer(query.topic);
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
