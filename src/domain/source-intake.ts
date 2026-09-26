export type FreePassSourceLaneId =
  | 'SUPPLIER'
  | 'PRODUCT_VEHICLE'
  | 'VEHICLE_MASTER'
  | 'SETTLEMENT';

export type FreePassSourceLane = {
  laneId: FreePassSourceLaneId;
  displayName: string;
  purpose: string;
  rawFirst: true;
  canonicalTarget: string;
  normalizerOwner: string;
};

export const FREEPASS_SOURCE_LANES: readonly FreePassSourceLane[] = [
  {
    laneId: 'SUPPLIER',
    displayName: '공급사 원천',
    purpose: '공급사/제휴사 식별, 코드, 표시명, 운영 상태와 출처를 원문 그대로 수집',
    rawFirst: true,
    canonicalTarget: 'Supplier/Partner facts',
    normalizerOwner: 'freepass-data/catalog',
  },
  {
    laneId: 'PRODUCT_VEHICLE',
    displayName: '차량·상품 원천',
    purpose: '공급사 상품, 재고 차량, 가격, 보증금, 기간, 정책 참조와 판매 상태를 수집',
    rawFirst: true,
    canonicalTarget: 'VehicleAsset/Product/Offer/Policy',
    normalizerOwner: 'freepass-data/catalog',
  },
  {
    laneId: 'VEHICLE_MASTER',
    displayName: '차종마스터 원천',
    purpose: '제조사·모델·세대·연식·파워트레인·트림·옵션·색상·당시 가격의 근거를 수집',
    rawFirst: true,
    canonicalTarget: 'Vehicle Master identity graph',
    normalizerOwner: 'freepass-data/vehicle-master',
  },
  {
    laneId: 'SETTLEMENT',
    displayName: '정산 원천',
    purpose: '청구·수금·지급·수수료·환수·조정과 원 거래/계약 연결 근거를 수집',
    rawFirst: true,
    canonicalTarget: 'Settlement facts/evidence',
    normalizerOwner: 'freepass-admin/settlement',
  },
] as const;

export type SourceIntakeEnvelope = {
  laneId: FreePassSourceLaneId;
  sourceId: string;
  sourceRecordId: string;
  observedAt: string;
  sourceRevision?: string | null;
  checksum?: string | null;
  payload: Record<string, unknown>;
};

const nonBlank = (value: string) => Boolean(value.trim());
const sha256 = (value: string) => /^[a-f0-9]{64}$/i.test(value);

export function sourceLane(laneId: FreePassSourceLaneId) {
  const lane = FREEPASS_SOURCE_LANES.find((item) => item.laneId === laneId);
  if (!lane) throw new Error('UNKNOWN_FREEPASS_SOURCE_LANE');
  return lane;
}

export function validateSourceIntakeEnvelope(input: SourceIntakeEnvelope) {
  sourceLane(input.laneId);

  if (
    !nonBlank(input.sourceId) ||
    !nonBlank(input.sourceRecordId) ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    !input.payload ||
    typeof input.payload !== 'object' ||
    Array.isArray(input.payload)
  ) {
    throw new Error('INVALID_SOURCE_INTAKE_ENVELOPE');
  }

  if (input.sourceRevision != null && !nonBlank(input.sourceRevision)) {
    throw new Error('INVALID_SOURCE_INTAKE_REVISION');
  }
  if (input.checksum != null && !sha256(input.checksum)) {
    throw new Error('INVALID_SOURCE_INTAKE_CHECKSUM');
  }

  return true;
}
