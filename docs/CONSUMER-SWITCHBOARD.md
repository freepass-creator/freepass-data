# FreePass Data 프로젝트별 연결 스위치보드

상태: **PREPARED CONTRACT / ALL FINAL SWITCHES HOLD**  
실행 계약: `src/domain/consumer-cutover.ts`  
스키마: `contracts/consumer-cutover-registry.v1.schema.json`

## 목적

각 프로젝트는 기존 운영 경로를 유지한 채 FreePass Data 어댑터와 shadow 비교를
미리 준비한다. 실제 전환은 프로젝트별 스위치 하나로 수행하되, 중앙 레지스트리가
요구하는 증거가 없으면 전환을 거부한다.

```text
LEGACY_DIRECT -> OBSERVE -> SHADOW_READ -> PARITY_VERIFIED -> FREEPASS_DATA_READ
```

단계를 건너뛰지 않는다. 읽기 전환과 writer 전환은 별개다. 이 스위치보드는 writer,
IAM, 배포, 실제 데이터 수정 또는 스케줄 변경 권한을 부여하지 않는다.

## 현재 등록된 소비처

| consumer | 저장소/대상 | 현재 단계 | 스위치 키 | 현재 핵심 HOLD |
|---|---|---|---|---|
| ERP.com 공개 Catalog | `freepasserp4` | SHADOW_READ | `FREEPASS_DATA_ERP_COM_READ_MODE` | Data runtime 미배포, ACTIVE Release 없음, 실 parity 미확인 |
| ERP 화이트라벨 | `freepasserp4` | OBSERVE | `FREEPASS_DATA_WHITELABEL_READ_MODE` | tenant별 identity/노출/read receipt 미확인 |
| FreePass Admin Catalog | `freepass-admin` | OBSERVE | `FREEPASS_DATA_ADMIN_CATALOG_READ_MODE` | Projection PR 미통합, policy parity/운영 persistence 미확인 |
| FreePass Sales Catalog | `freepass-sales` | LEGACY_DIRECT | `FREEPASS_DATA_SALES_CATALOG_READ_MODE` | adapter 없음, Sales 고객·통화 도메인과 분리 필요 |
| FreePass Estimate Catalog 입력 | `freepass-estimate` | LEGACY_DIRECT | `FREEPASS_DATA_ESTIMATE_CATALOG_READ_MODE` | input adapter 없음, 계산·provider 소유권 분리 필요 |
| Google Sheets F01 | ERP publisher | OBSERVE | `FREEPASS_DATA_F01_READ_MODE` | 승인 Release 소비와 receipt 없음 |
| Google Sheets F86 | ERP publisher | OBSERVE | `FREEPASS_DATA_F86_READ_MODE` | 승인 Release 소비와 receipt 없음 |

레지스트리에 적힌 단계는 확인된 코드와 문서 기준이다. 실제 운영 환경변수 활성 상태를
추정하지 않는다. 새 실행 전 각 저장소의 현재 commit, 배포 revision과 runtime 설정을
다시 읽는다.

## 스위치 값의 공통 의미

각 프로젝트 구현에서는 위 `switchKey`에 다음 값만 허용한다.

- `LEGACY_DIRECT`: 기존 운영 reader만 사용
- `OBSERVE`: 연결 설정과 상태만 확인하며 Data 값을 사용자 결과에 사용하지 않음
- `SHADOW_READ`: 기존 결과와 Data 결과를 독립적으로 읽어 비교하며 기존 결과를 반환
- `PARITY_VERIFIED`: 지정한 revision/scope에 대한 parity 증거가 유효한 준비 상태
- `FREEPASS_DATA_READ`: FreePass Data 결과를 반환하고 검증된 마지막 정상 legacy/Release 복구 경로 유지

알 수 없는 값, 인증 실패, 계약 버전 불일치, 빈 ACTIVE Release, stale evidence는
시작 실패 또는 기존 경로 유지로 닫고 `HOLD`를 기록한다. 조용히 다른 Firebase나 RTDB로
fallback하지 않는다.

## 프로젝트별 준비 작업

### ERP.com과 화이트라벨

- 현재 ERP5 reader를 `LegacyCatalogReader` port 뒤에 유지한다.
- PR #23 consumer gateway용 `FreePassDataCatalogReader`를 별도로 둔다.
- shadow는 고객 응답 지연 경로에서 분리하고 timeout/failure receipt를 남긴다.
- 각 화이트라벨은 별도 consumer identity, tenant scope와 release receipt를 가진다.

### FreePass Admin

- PR #12 Admin projection을 현재 main과 충돌 없이 다시 통합한다.
- Product 검색·상세는 `AdminCatalogReader` port만 의존한다.
- application/contract/settlement workflow writer를 Catalog reader 전환과 섞지 않는다.
- `policyParity=COMPLETE`와 인증·운영 persistence 증거 전에는 Data read를 활성화하지 않는다.

### FreePass Sales

- 현재 `welrixtable` 고객·통화 writer를 유지한다.
- 상품 검색/선택 부분만 `SalesCatalogReader` port로 분리한다.
- 고객정보를 Catalog shadow 요청이나 비교 로그에 포함하지 않는다.
- 모바일 실제 기기에서 검색·선택·접수 snapshot을 확인한 뒤 전환한다.

### FreePass Estimate

- 차량·상품·가격 입력을 `EstimateCatalogInput` adapter로 분리한다.
- 견적 UI, QuoteRequest/QuoteResult, 계산과 provider adapter는 Estimate가 계속 소유한다.
- FreePass Data의 상품 가격을 외부 provider 계산 결과로 대체 해석하지 않는다.
- 동일 차량/Offer/revision을 사용한 입력 parity를 검증한다.

### F01/F86

- 기존 단일 publisher, workflow pin과 concurrency lock을 유지한다.
- 같은 승인 FreePass Data Release를 입력으로 받는 준비 단계를 추가한다.
- 쓰기 전 backup, 적용 후 새 readback, 화면 검증과 consumer receipt를 요구한다.
- 두 시트가 성공해도 ERP/Admin/화이트라벨 연결 완료로 확대하지 않는다.

## 최종 전환 필수 증거

`FREEPASS_DATA_READ` 전환은 다음이 모두 true일 때만 허용된다.

- `contractReady`
- `authenticationVerified`
- `legacyReadVerified`
- `freepassReadVerified`
- `parityVerified`
- `fallbackVerified`
- `productionReadbackVerified`
- 남은 `holdReasons` 없음

현재 등록된 모든 소비처는 이 조건을 충족하지 못하므로 최종 스위치는 전부 차단된다.
