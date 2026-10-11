# 읽기 계약 한 벌 — «읽는 규칙은 하나, 가져다 쓰는 건 각자» (설계 한 장, 2026-10-11)

상태: DESIGNED (코드 없음). 오더: 지휘통제실 대표 10-11. API 중계(중앙 상품 조회)는 쓰지 않는다 — 각 소비처가 프리패스 데이터(Firestore)를 직접 읽되, **읽는 규칙·허용 목록·해석은 이 저장소의 계약 모듈 하나**를 가져다 쓴다. 소비처 reader 를 각자 새로 만들지 않는다.

## 1. 계약(무엇을 어떻게 읽나) — `contracts/firestore-read-contract.v1.json` + `src/domain/firestore-read-contract.ts`
- **읽기 허용 컬렉션(코드 상수, 이 밖은 모듈이 거부)**: `products`(차 원문·정리값·가격), `period_fee_ledger`(기간별 청구·지급 박제, 최신 활성 스냅샷만), `product_change_history`(상태·가격 변경 이력), `policy`, `catalog_offers`(내부 경제 항목, 수수료 권한 소비처만). 금지(어떤 소비처도 읽지 않음): `settlement_rows`, 고객·계약·사용자·파트너 개인 모음.
- **필드 이름·단위**: 금액은 원(정수, 공급가 부가세 제외 여부는 `basis` 필드), 기간 키는 `parseErp5CompatibilityPriceKey` 하나로 해석(`12`·`12_2만`·`source:N` 등 → `{months, mileage, settlement}`), 날짜는 KST ISO. 이름은 기존 계약(`INTERNAL-FEE-LOOKUP-CONTRACT.md`·`ADMIN-CATALOG-CONSUMER-CONTRACT.md`)을 그대로 쓰고 새 이름을 만들지 않는다.
- **미확정·상태값 해석**: 모든 값은 `{state, amount|value, reasonCode}`. 상태 = KNOWN / ZERO(검증된 무보증만) / UNKNOWN(+사유) / NOT_APPLICABLE / CALCULATED_APPROX(근사, 따로 집계). **숫자 0 과 null 을 UNKNOWN 으로 읽는 규칙은 `resolveDepositWithRuleNote`·`pickLedgerRowForContract` 하나**. 소비처가 자체 해석 금지.
- **노출 범위**: 수수료(`supplierBillingFee`·`channelPayoutFee`·`period_fee_ledger` 수수료 칸)는 카톡·어드민 신원만. ERP5·ERP4·화이트라벨·공개 서비스는 차·가격·보증금까지(수수료·마진·VIN·원문 전체 제외). 소비처별 허용 필드는 계약 JSON 의 `consumers.<id>.fields` 한 곳.

## 2. 가져다 쓰는 읽기 모듈 — 새 reader 만들지 않음
- 기존 자산 재사용: `erp5-compat-catalog-reader.ts`(products·policy 투영, `readCollections` 옵션), `period-fee-ledger-firestore-reader.ts`, `contract-fee-link.ts`, `public-product-feed.ts`, 차번호 조회 `query-canonical-by-plate`(주의: 지금은 CatalogStore 기반 운영자 로컬 조회라 소비처가 쓰는 Firestore 직접 조회는 아니다 — «차량번호 하나를 읽는 진입점»을 모듈에 하나 추가해 둘 다 같은 투영을 쓰게 한다).
- 모듈 형태: `src/consumer-read/index.ts` 한 곳이 `createConsumerReader({consumerId, firestore})` 를 내보낸다. 안에서 ① 소비처 신원의 허용 컬렉션 검사 ② 위 기존 reader 호출 ③ 계약 필드만 걸러 반환. 소비처(카톡·어드민·ERP5·AI-OPS 도구)는 이것만 호출하고 Firestore 를 직접 `collection()` 하지 않는다(`check-data-access-boundary` 에 소비처 쪽 검사 추가 제안).
- 배포 방식: npm 패키지/서브모듈 대신 «계약 JSON + 얇은 모듈을 소비처 저장소가 버전 고정(커밋 SHA)으로 vendoring». 언어 다른 소비처(시트·AI-OPS 스크립트)는 계약 JSON 과 적합성 시험만 따른다.

## 3. 적합성 시험 묶음(같은 차 N대 → 같은 값)
- `tests/read-contract-conformance.test.ts` + 운영 확인 도구 `npm run audit:read-conformance`(읽기 전용): 같은 차량번호 N대(무작위 50 + 고정 20 판정 묶음)를 **각 소비처 reader 경로로** 읽어 `{차 수, 기간 행 수, 월대여료, 보증금 상태, 수수료 상태}` 가 계약 모듈 결과와 일치하는지 비교. 불일치는 소비처 이름·차·칸 단위로 보고. 소비처가 허용 밖 컬렉션을 읽으면 실패(시험은 관측된 읽기 컬렉션 목록을 단언).
- 합격 기준: 불일치 0, 노출 금지 필드 0, 허용 밖 컬렉션 읽기 0. 결과는 점검표(`TRUST-SCORECARD`)의 «소비처 일치» 열로 노출.

## 4. 소비처별 읽기 신원·최소 권한
| 소비처 | 신원 | 허용 컬렉션 | 수수료 |
|---|---|---|---|
| 카톡(작업 세션) | 전용 서비스 계정/ADC | products·period_fee_ledger·product_change_history·policy·catalog_offers | O |
| 어드민 | 기존 `freepass-data-admin-runtime` | 위 + 계약 수수료 링크 | O |
| ERP5 | 전용 읽기 계정 | products·policy | X |
| AI-OPS(도구 공방) | 사람/세션 ADC(읽기) | products·period_fee_ledger·product_change_history | 조회만(로그) |
| 공개/ERP4·화이트라벨 | 공개 서비스 계정 | products·policy 투영 | X |
- **한계(사실)**: Firestore IAM 은 컬렉션 단위가 없다(데이터베이스 단위까지). `roles/datastore.viewer` 는 프로젝트 전체를 읽을 수 있으므로 «허용 목록 코드(모듈이 허용 밖 컬렉션 호출을 거부) + 읽기 감사 경보»가 계약의 일부다. 소비처가 모듈을 우회해 직접 읽는 것은 IAM 으로 못 막는다 → 적합성 시험(관측 읽기 컬렉션)과 `data_access_events`·감사 로그로 사후 탐지. 인터넷에 직접 닿는 신원(공개 서비스)은 별도 읽기 전용 데이터베이스로 좁히는 안이 `IAM-명령-공개상품서비스-20261011.md` 에 있다.
- 쓰기는 이 계약 밖: 박제(period_fee_ledger)는 프리패스 데이터의 자기 워크플로 서비스 계정만 쓰고, 소비처는 읽기 전용 역할만 받는다.

## 5. 순서·산출물
1) 계약 JSON + 허용 목록 상수 + 소비처별 노출표 → 2) `createConsumerReader`(기존 reader 조합, 새 reader 없음) → 3) 적합성 시험 + audit 도구 → 4) 소비처 붙이기(AI-OPS 쪽은 도구 공방) → 5) 점검표 열 추가. 각 단계 PR 분리, 서비스 계정 생성·IAM 은 대표 승인 항목(실행 금지).
## 열린 질문(결정필요 아님, 기본안으로 진행)
- vendoring 방식(커밋 SHA 고정) 기본. 소비처가 시트 스크립트뿐이면 계약 JSON 만 따른다.
