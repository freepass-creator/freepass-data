export type DataSensitivity = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
export type DataAvailability = 'AVAILABLE' | 'PARTIAL' | 'HOLD' | 'UNAVAILABLE';
export type DataAssetKind = 'FIRESTORE_COLLECTION' | 'GOOGLE_SHEET' | 'API' | 'PROJECTION' | 'DOCUMENT_STORE';
export type DataOwnership = 'FREEPASS_DATA' | 'DOMAIN_OWNED' | 'SOURCE_OWNED' | 'CONSUMER_OUTPUT';

export type DataDomainDefinition = {
  domainId: string;
  displayName: string;
  aliases: string[];
  description: string;
  semanticOwner: string;
  sensitivity: DataSensitivity;
  availability: DataAvailability;
  currentScope: 'CATALOG_V1' | 'FUTURE_CONNECTION';
};

export type DataAssetDefinition = {
  assetId: string;
  domainId: string;
  displayName: string;
  aliases: string[];
  kind: DataAssetKind;
  system: string;
  locator: string;
  ownership: DataOwnership;
  authority: 'SOURCE' | 'RAW_EVIDENCE' | 'CANONICAL' | 'PROJECTION' | 'WORKFLOW' | 'OUTPUT' | 'AUDIT';
  keyDescription: string;
  sensitivity: DataSensitivity;
  availability: DataAvailability;
  freshnessPolicy: string;
  contractRef: string;
  consumers: string[];
  notes: string[];
};

export type ObservedDataAsset = {
  kind: DataAssetKind;
  system: string;
  locator: string;
  observedAt: string;
  recordCount?: number | null;
};

export type ClassifiedObservation = {
  status: 'CLASSIFIED' | 'UNCLASSIFIED' | 'STALE';
  observation: ObservedDataAsset;
  asset: DataAssetDefinition | null;
  domain: DataDomainDefinition | null;
  reasons: string[];
};

export const DATA_DOMAINS: readonly DataDomainDefinition[] = [
  {
    domainId: 'catalog', displayName: '상품·차량·가격·정책',
    aliases: ['상품', '차량', '재고', '가격', '요금', '보증금', '정책', 'product', 'vehicle', 'offer', 'pricing', 'policy'],
    description: '공급사 원천부터 Canonical Catalog와 소비처 Release까지',
    semanticOwner: 'freepass-data/catalog', sensitivity: 'INTERNAL', availability: 'PARTIAL', currentScope: 'CATALOG_V1'
  },
  {
    domainId: 'customer-sales', displayName: '고객·영업·통화',
    aliases: ['고객', '영업', '리드', '관심', '통화', '문자', 'customer', 'lead', 'sales', 'call'],
    description: 'Sales가 소유하는 고객과 영업 활동 기록',
    semanticOwner: 'freepass-sales', sensitivity: 'RESTRICTED', availability: 'HOLD', currentScope: 'FUTURE_CONNECTION'
  },
  {
    domainId: 'application-contract', displayName: '접수·계약·인도',
    aliases: ['접수', '신청', '계약', '인도', '취소', '반납', 'application', 'contract', 'delivery'],
    description: 'Admin 업무 흐름과 당시 상품 조건 snapshot',
    semanticOwner: 'freepass-admin', sensitivity: 'RESTRICTED', availability: 'HOLD', currentScope: 'FUTURE_CONNECTION'
  },
  {
    domainId: 'settlement-finance', displayName: '정산·청구·수금·지급',
    aliases: ['정산', '수수료', '청구', '수금', '지급', '입금', '환수', 'settlement', 'invoice', 'payment', 'commission'],
    description: 'Admin 정산 규칙과 증거가 있는 금융 이벤트',
    semanticOwner: 'freepass-admin/settlement', sensitivity: 'RESTRICTED', availability: 'HOLD', currentScope: 'FUTURE_CONNECTION'
  },
  {
    domainId: 'quote-estimate', displayName: '견적·계산 입력과 결과',
    aliases: ['견적', '계산', 'quote', 'estimate', 'calculator'],
    description: 'Estimate가 소유하는 견적 기능과 버전된 입력·결과',
    semanticOwner: 'freepass-estimate', sensitivity: 'CONFIDENTIAL', availability: 'HOLD', currentScope: 'FUTURE_CONNECTION'
  },
  {
    domainId: 'publication', displayName: '시트·웹·소비처 발행',
    aliases: ['F01', 'F86', '시트', '구글시트', 'ERP.com', '화이트라벨', 'Admin projection', 'publication', 'sheet'],
    description: '승인된 Release를 소비처별 형식으로 전달하고 receipt를 남기는 출력',
    semanticOwner: 'freepass-data/distribution', sensitivity: 'INTERNAL', availability: 'PARTIAL', currentScope: 'CATALOG_V1'
  },
  {
    domainId: 'evidence-audit', displayName: '원문·문서·이력·감사',
    aliases: ['원문', '증빙', '문서', '이력', '감사', 'RAW', 'lineage', 'audit', 'receipt'],
    description: '원본 위치·digest·revision·lineage·audit·receipt 증거',
    semanticOwner: 'freepass-data/control-plane', sensitivity: 'RESTRICTED', availability: 'PARTIAL', currentScope: 'CATALOG_V1'
  }
] as const;

export const DATA_ASSETS: readonly DataAssetDefinition[] = [
  {
    assetId: 'data-access-events', domainId: 'evidence-audit', displayName: 'FreePass Data 접근 감사 로그',
    aliases: ['data_access_events', 'access-events', '접근로그', 'read log', 'write log', 'access audit'], kind: 'DOCUMENT_STORE',
    system: 'freepass-data:control-plane',
    locator: 'logical:data-access-events (Firestore data_access_events + private GCS access-events/*)',
    ownership: 'FREEPASS_DATA', authority: 'AUDIT',
    keyDescription: 'immutable eventId + operationId + actor/client + READ/WRITE phase',
    sensitivity: 'RESTRICTED', availability: 'AVAILABLE',
    freshnessPolicy: '각 Data Access operation의 STARTED 이전/완료 직후 append-only 기록',
    contractRef: 'docs/DATA-ACCESS-GATEWAY.md',
    consumers: ['freepass-data-control-plane', 'security-audit', 'operations'],
    notes: [
      '동일 DataAccessEvent 계약을 privilege에 따라 Firestore 또는 불변 GCS sink에 저장',
      'read-only identity에 Firestore write 권한을 추가하지 않음',
      'raw payload/token/backend error text 저장 금지',
      'canonical mutation detail은 audit_events/receipt/revision이 별도 정본'
    ]
  },
  {
    assetId: 'erp5-products-source', domainId: 'catalog', displayName: 'ERP5 기존 상품 원천',
    aliases: ['products', 'ERP5 상품', '기존상품'], kind: 'FIRESTORE_COLLECTION', system: 'firebase:freepasserp5', locator: 'products',
    ownership: 'SOURCE_OWNED', authority: 'SOURCE', keyDescription: '원천 document ID와 차량/상품 식별 증거',
    sensitivity: 'INTERNAL', availability: 'PARTIAL', freshnessPolicy: '새 작업마다 전체 coverage와 readTime 재관측',
    contractRef: 'docs/ERP5-PRODUCT-MAPPING.md', consumers: ['freepass-data-ingestion'],
    notes: ['2026-09-21 count-only 1659; snapshot value is not a permanent count', 'Canonical write remains HOLD']
  },
  {
    assetId: 'erp5-policy-source', domainId: 'catalog', displayName: 'ERP5 기존 정책 원천',
    aliases: ['policy', '정책원천'], kind: 'FIRESTORE_COLLECTION', system: 'firebase:freepasserp5', locator: 'policy',
    ownership: 'SOURCE_OWNED', authority: 'SOURCE', keyDescription: '원천 policy document ID/code',
    sensitivity: 'INTERNAL', availability: 'PARTIAL', freshnessPolicy: '상품 캡처와 같은 read boundary에서 전체 관측',
    contractRef: 'docs/ERP5-PRODUCT-MAPPING.md', consumers: ['freepass-data-ingestion'],
    notes: ['2026-09-21 count-only 81; Policy Canonical parity is not verified']
  },
  {
    assetId: 'catalog-canonical', domainId: 'catalog', displayName: 'FreePass Data Canonical Catalog',
    aliases: ['canonical catalog', 'canonical product', 'canonical offer', 'canonical policy', '정본상품'], kind: 'FIRESTORE_COLLECTION',
    system: 'firebase:freepasserp5', locator: 'logical:catalog-canonical', ownership: 'FREEPASS_DATA', authority: 'CANONICAL',
    keyDescription: 'entity type + stable entity ID + revision', sensitivity: 'INTERNAL', availability: 'HOLD',
    freshnessPolicy: 'reviewed source head 또는 승인 command revision', contractRef: 'contracts/catalog-v1.schema.json',
    consumers: ['projection-builders', 'freepass-data-console'], notes: ['2026-09-21 observed empty; re-read before use']
  },
  {
    assetId: 'erp-public-release', domainId: 'publication', displayName: 'ERP 공개 Catalog ACTIVE Release',
    aliases: ['active catalog release', 'ERP release', '공개카탈로그'], kind: 'PROJECTION', system: 'firebase:freepasserp5',
    locator: 'projection:erp-public/active', ownership: 'FREEPASS_DATA', authority: 'PROJECTION',
    keyDescription: 'projection + release ID + manifest/data digest', sensitivity: 'PUBLIC', availability: 'HOLD',
    freshnessPolicy: 'ACTIVE release metadata와 consumer receipt로 확인', contractRef: 'docs/PROJECTION-RELEASE-EVIDENCE.md',
    consumers: ['ERP.com', 'ERP white-labels'], notes: ['empty release is rejected']
  },
  {
    assetId: 'estimate-newcar-master-release', domainId: 'catalog', displayName: 'Estimate 신차 Master ACTIVE Release',
    aliases: ['estimate-newcar-master', '견적기 차종마스터', '신차 견적 마스터'], kind: 'PROJECTION',
    system: 'firebase:freepasserp5', locator: 'projection:estimate-newcar-master/active',
    ownership: 'FREEPASS_DATA', authority: 'PROJECTION',
    keyDescription: 'productId + stable VehicleModel/ModelYear/Trim/Powertrain/Option/Color IDs + release evidence',
    sensitivity: 'INTERNAL', availability: 'HOLD',
    freshnessPolicy: 'CANONICAL_ACTIVE release + manifest/input/data digest 검증',
    contractRef: 'contracts/estimate-newcar-master-v1.schema.json',
    consumers: ['FreePass Estimate'],
    notes: ['read contract implemented 2026-09-25', 'ACTIVE release builder/source evidence is not yet implemented', 'legacy year:2026 display default is not model-year authority']
  },
  {
    assetId: 'sheet-f01', domainId: 'publication', displayName: 'Google Sheets F01',
    aliases: ['F01', '표준시트', '판매시트'], kind: 'GOOGLE_SHEET', system: 'google-workspace:pyh@teamjpk.com',
    locator: 'contract:f01-f86-sheet-spec.v1.json#workbooks/F01', ownership: 'CONSUMER_OUTPUT', authority: 'OUTPUT',
    keyDescription: 'stable spreadsheetId + sheetId + vehicle key', sensitivity: 'CONFIDENTIAL', availability: 'PARTIAL',
    freshnessPolicy: '발행 snapshot/release와 적용 후 새 readback', contractRef: 'contracts/f01-f86-sheet-spec.v1.json',
    consumers: ['sales-operations'], notes: ['표시 적용과 운영 publisher 연결은 별개']
  },
  {
    assetId: 'sheet-f86', domainId: 'publication', displayName: 'Google Sheets F86',
    aliases: ['F86', '레트로시트', '공급사시트'], kind: 'GOOGLE_SHEET', system: 'google-workspace:pyh@teamjpk.com',
    locator: 'contract:f01-f86-sheet-spec.v1.json#workbooks/F86', ownership: 'CONSUMER_OUTPUT', authority: 'OUTPUT',
    keyDescription: 'stable spreadsheetId + sheetId + vehicle key', sensitivity: 'CONFIDENTIAL', availability: 'PARTIAL',
    freshnessPolicy: '발행 snapshot/release와 적용 후 새 readback', contractRef: 'contracts/f01-f86-sheet-spec.v1.json',
    consumers: ['channel-operations'], notes: ['공급사 탭은 기본 재고 합계에 중복 가산하지 않음']
  },
  {
    assetId: 'sales-leads', domainId: 'customer-sales', displayName: 'Sales 고객·통화 운영 데이터',
    aliases: ['leads', 'calls', '고객DB', '통화기록'], kind: 'FIRESTORE_COLLECTION', system: 'firebase:welrixtable',
    locator: 'leads/{phone}/calls', ownership: 'DOMAIN_OWNED', authority: 'WORKFLOW',
    keyDescription: '현재 Sales의 기존 안정 키; 외부 노출 금지', sensitivity: 'RESTRICTED', availability: 'HOLD',
    freshnessPolicy: 'Sales 운영 Firestore readback', contractRef: 'freepass-sales/docs/SSOT.md',
    consumers: ['FreePass Sales'], notes: ['Catalog 연결과 고객 writer 전환을 분리']
  },
  {
    assetId: 'admin-applications', domainId: 'application-contract', displayName: 'Admin 접수·계약 업무 데이터',
    aliases: ['applications', '접수목록', '계약목록'], kind: 'FIRESTORE_COLLECTION', system: 'freepass-admin:unverified-production-store',
    locator: 'logical:applications-contracts', ownership: 'DOMAIN_OWNED', authority: 'WORKFLOW',
    keyDescription: 'application/contract stable ID + revision + selected catalog snapshot', sensitivity: 'RESTRICTED', availability: 'HOLD',
    freshnessPolicy: '실제 운영 repository와 writer 식별 후 정의', contractRef: 'freepass-admin/docs/MASTER-v1.md',
    consumers: ['FreePass Admin'], notes: ['production persistence is not verified']
  },
  {
    assetId: 'admin-settlement', domainId: 'settlement-finance', displayName: 'Admin 정산·수수료 원장',
    aliases: ['settlement_rows', 'settlement_events', '정산원장', '수수료'], kind: 'FIRESTORE_COLLECTION',
    system: 'firebase:freepasserp5', locator: 'settlement_* (candidate paths; live authority unverified)',
    ownership: 'DOMAIN_OWNED', authority: 'WORKFLOW', keyDescription: 'settlement ID + revision + source evidence',
    sensitivity: 'RESTRICTED', availability: 'HOLD', freshnessPolicy: '운영 owner/writer/namespace를 먼저 실측',
    contractRef: 'docs/BUSINESS-DATA-CONNECTION-MAP.md', consumers: ['FreePass Admin'],
    notes: ['새 Data 금융 원장을 만들지 않음', '실제 collection과 active writer는 미검증']
  },
  {
    assetId: 'estimate-contracts', domainId: 'quote-estimate', displayName: '견적 입력·결과 계약',
    aliases: ['QuoteRequest', 'QuoteResult', '견적API'], kind: 'API', system: 'freepass-estimate',
    locator: 'provider-adapters', ownership: 'DOMAIN_OWNED', authority: 'WORKFLOW',
    keyDescription: 'quote/provider/version/correlation ID', sensitivity: 'CONFIDENTIAL', availability: 'HOLD',
    freshnessPolicy: 'Estimate canonical contract revision과 provider 실행 증거', contractRef: 'freepass-estimate/docs/NEW_CAR_ARCHITECTURE.md',
    consumers: ['FreePass Sales', 'ERP.com', 'partner surfaces'], notes: ['FreePass Data는 계산기를 소유하지 않음']
  }
] as const;

function normalized(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('ko-KR');
}

export function searchDataCatalog(query: string) {
  const needle = normalized(query);
  if (!needle) return { domains: [...DATA_DOMAINS], assets: [...DATA_ASSETS] };

  const matches = (values: string[]) => values.some((value) => normalized(value).includes(needle));
  const directlyMatchedDomains = DATA_DOMAINS.filter((domain) => matches([
    domain.domainId, domain.displayName, domain.description, ...domain.aliases
  ]));
  const directlyMatchedDomainIds = new Set(directlyMatchedDomains.map((domain) => domain.domainId));
  const assets = DATA_ASSETS.filter((asset) => directlyMatchedDomainIds.has(asset.domainId) || matches([
    asset.assetId, asset.domainId, asset.displayName, asset.system, asset.locator,
    asset.keyDescription, ...asset.aliases, ...asset.consumers, ...asset.notes
  ]));
  const resultDomainIds = new Set([
    ...directlyMatchedDomainIds,
    ...assets.map((asset) => asset.domainId)
  ]);
  const domains = DATA_DOMAINS.filter((domain) => resultDomainIds.has(domain.domainId));

  return { domains, assets };
}

export function classifyObservedDataAsset(
  observation: ObservedDataAsset,
  now: string,
  maxAgeMs: number
): ClassifiedObservation {
  const observed = Date.parse(observation.observedAt);
  const current = Date.parse(now);
  const reasons: string[] = [];
  const asset = DATA_ASSETS.find((candidate) =>
    candidate.kind === observation.kind &&
    normalized(candidate.system) === normalized(observation.system) &&
    normalized(candidate.locator) === normalized(observation.locator)
  ) ?? null;
  const domain = asset
    ? DATA_DOMAINS.find((candidate) => candidate.domainId === asset.domainId) ?? null
    : null;

  if (!Number.isFinite(observed) || !Number.isFinite(current) || maxAgeMs < 0) {
    return { status: 'STALE', observation, asset, domain, reasons: ['invalid observation time or freshness policy'] };
  }
  if (observed > current || current - observed > maxAgeMs) {
    reasons.push('observation is outside the allowed freshness window');
    return { status: 'STALE', observation, asset, domain, reasons };
  }
  if (!asset || !domain) {
    reasons.push('asset is not registered; classification and authority review required');
    return { status: 'UNCLASSIFIED', observation, asset: null, domain: null, reasons };
  }
  if (observation.recordCount !== undefined && observation.recordCount !== null &&
      (!Number.isSafeInteger(observation.recordCount) || observation.recordCount < 0)) {
    reasons.push('record count is invalid');
    return { status: 'UNCLASSIFIED', observation, asset, domain, reasons };
  }
  return { status: 'CLASSIFIED', observation, asset, domain, reasons };
}

export function auditCatalogCoverage(observations: ObservedDataAsset[], now: string, maxAgeMs: number) {
  const results = observations.map((item) => classifyObservedDataAsset(item, now, maxAgeMs));
  return {
    status: results.every((item) => item.status === 'CLASSIFIED') ? 'PASS' as const : 'HOLD' as const,
    classified: results.filter((item) => item.status === 'CLASSIFIED').length,
    stale: results.filter((item) => item.status === 'STALE').length,
    unclassified: results.filter((item) => item.status === 'UNCLASSIFIED').length,
    results
  };
}
