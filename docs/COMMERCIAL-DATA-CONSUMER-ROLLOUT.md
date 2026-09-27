# 상품조건 데이터 소비처 반영 설계

## 목적

FreePass Data에서 가격과 조건 귀속을 만들었으면 모든 소비처가 다시 각자 가격/정책을 조합하면 안 된다.
한 번 계산·귀속한 상품조건을 공통 commercial block으로 내려주고 소비처는 목적에 맞게 표현만 한다.

## Data 내부 계층

1. Canonical facts
   - VehicleModel / VehicleAsset / Product / Offer / Policy
   - PriceTerm은 원천 Basis를 보존한다.
2. Commercial derivation
   - 가격행 조건 귀속
   - 정책 직접 연결 및 안전한 역매칭
   - UNKNOWN / AMBIGUOUS
   - 기본조건 Preview
   - 조건 변경 규칙과 산출 trace
3. Consumer projection
   - ERP public
   - Admin catalog
   - Kakao Ops
   - Sheet publication
   - 필요한 경우 Estimate용 소비 계약

Canonical에 소비처 표시용 값을 다시 저장하지 않는다.

## 공통 Commercial Offer Block

Offer마다 다음 블록을 Projection에 실어주는 것을 목표로 한다.

- offerId / supplierId / policyId
- basisRows
  - termKey
  - 기준 월대여료
  - 기준 보증금
  - 조건 귀속
  - 조건별 origin/sourceRef
  - policyMatch
- conditionSummary
  - known
  - unknown
- preview
  - 기본 선택값
  - 최종 월대여료/보증금
  - READY / NEEDS_DECISION / INVALID
- review
  - 결정 필요 항목
  - 모순 항목

## 왜 별도 API를 두 번 호출하지 않는가

상품과 commercial 조건을 서로 다른 Release로 읽어서 소비처에서 join하면 시점이 다른 두 Release가 섞일 수 있다.
따라서 같은 projection release 안에 commercial block을 포함시키는 것이 원칙이다.
계산 로직은 공통 helper 하나를 쓰되 ERP-public/Admin-catalog가 각각 자기 release를 만들 때 같은 helper를 호출한다.

## 소비처별 표현

### FreePass Admin

가장 깊게 보여준다.
- 기준 가격행
- 조건별 KNOWN / UNKNOWN
- SOURCE_PRICE_KEY / LINKED_POLICY_FACT / MATCHED_POLICY_FACT
- UNIQUE_MATCH / AMBIGUOUS / NO_MATCH
- 미확인 조건 목록
- 기본 Preview
- 앞으로 채워야 할 가격 조정 규칙

운영자는 여기서 UNKNOWN과 AMBIGUOUS를 해소한다.

### ERP.com

업무자가 빠르게 상품을 보는 화면이다.
- 기본 Preview 월대여료/보증금
- 기본 기간/주행거리/연령
- 보험/운전자/정비 등 확인된 핵심조건
- 조건 일부 미확인이 있으면 배지
- 상세에서 Basis 가격행과 선택 가능한 조건 확인

원천 priceTerms를 화면에서 다시 해석하지 않는다.

### White Label / 고객 노출

확정된 사실만 보여준다.
- preview READY이면 기본가격과 확정 조건 표시
- PARTIAL/NEEDS_DECISION이면 미확정 조건을 기본조건처럼 표시하지 않는다.
- 가격 자체는 원천에서 확인돼도 적용조건이 불완전한 경우 공개정책을 별도로 정한다.
  기본 안전안은 상세 조건이 필요한 화면에서 가격 확정 표현을 제한하는 것이다.

### Kakao Ops

AI Operator가 commercial block을 직접 질의한다.
답변 규칙:
- KNOWN만 사실로 답변
- UNKNOWN은 확인 필요라고 답변
- AMBIGUOUS는 정책 후보가 여러 개라 확정 불가라고 답변
- sourceRef를 내부 trace에 남긴다.

구조화 query path는 기존 priceTerms만이 아니라 preview/status/known conditions까지 확장한다.

### Google Sheet

Sheet는 정본이 아니라 검수/입력 인터페이스다.

가격조건 탭 권장 열:
- productId
- offerId
- supplierId
- termKey
- 기준 월대여료
- 기준 보증금
- 기간
- 주행거리
- 기본연령
- 최대연령
- 개인/법인 운전자범위
- 보험포함
- 대인/대물
- 자차 기준/면책
- 정비
- 조건상태 COMPLETE/PARTIAL
- policyMatch
- unknownConditionKeys

가격규칙 탭은 condition dimension별 선택값과 조정규칙을 관리한다.

### FreePass Estimate

Estimate와 상품조건 산출은 분리한다.
Estimate는 필요할 때 FreePass Data의 확정된 상품조건 결과를 소비한다.
기간/연령/보험 가격규칙을 Estimate 저장소에 복제하지 않는다.
Quote ID, 고객별 선택, 견적 저장/발송은 Estimate 책임이다.

## 단계적 전환

### 1단계 — Data contract
- commercial-offer-view/v1 계약 고정
- 공통 builder/helper 검증
- UNKNOWN/AMBIGUOUS 포함

### 2단계 — Projection shadow
- erp-public에 optional commercial block 추가
- admin-catalog에 optional commercial block 추가
- 기존 priceTerms 유지
- release digest/lineage에 commercial fields 포함

### 3단계 — 소비처 shadow
- ERP.com: 기존 가격표와 commercial preview 비교
- Admin: 기존 Offer/Policy와 commercial block 비교
- Kakao Ops: 새 query path만 shadow
- Sheet: 새 탭/열을 별도 생성해 기존 탭과 비교

### 4단계 — 화면 전환
- Admin 먼저: 근거 검수 UI
- ERP.com 다음: preview/조건 배지
- Kakao Ops: AI 답변 근거로 사용
- White Label: 확정 사실만 공개

### 5단계 — legacy 해석 제거
- 소비처에서 직접 policy + priceTerms를 조합하는 코드 제거
- FreePass Data commercial block만 소비
- Canonical PriceTerm은 Data 내부 Basis/감사 용도로 계속 유지

## 가장 중요한 원칙

소비처가 같은 원천을 각자 다시 해석하면 또 여러 벌의 정답이 생긴다.
따라서 조건 귀속·역매칭·기본값·가격산출 의미는 FreePass Data 한 곳에서만 결정하고,
다른 프로젝트는 그 결과를 읽고 표현한다.
## Listing 가격과 Preview 가격 분리

상품찾기에서 처음 보이는 가격과 기본 계약조건 가격은 같은 개념이 아니다.

### listing
- 목적: 상품찾기 목록의 `월 N원부터`
- 정책: 일반 반납형 가격행이 있으면 인수형을 제외하고 그 안에서 가장 낮은 Basis 월대여료
- 금액만 내리지 않고 해당 가격행의 attribution을 함께 내림
- 기간/주행거리/연령/보험/대물/정비 등 확인된 조건을 함께 표시할 수 있어야 함
- 조건이 모르면 UNKNOWN을 유지

### preview
- 목적: 상품 상세 진입 시 기본 선택조건
- 공급사/상품 정책의 default term, default mileage, 기본 연령 등으로 산출
- listing보다 비쌀 수 있음
- listing을 덮어쓰지 않음

예:
- listing: 48개월 / 연 2만km / 월 65만원부터 / 보험조건 미확인
- preview: 36개월 / 연 2만km / 만21세 / 월 70만원

두 값이 다르면 Admin 상세에서 `최저가`와 `기본조건`을 별도 표시한다.
ERP.com도 동일한 commercial contract를 소비해 같은 의미를 사용한다.

## Admin → ERP.com 전개 원칙

1. Admin에서 먼저 commercial 데이터의 의미와 누락을 검수한다.
2. Data contract와 listing/preview 정책을 확정한다.
3. ERP.com은 자체 UI/UX를 유지한다.
4. ERP.com 내부에서 priceTerms/policy를 다시 계산하지 않는다.
5. Admin과 ERP.com은 같은 listing termKey, 같은 condition evidence, 같은 UNKNOWN 판정을 사용한다.
6. 화면 레이아웃만 서로 다를 수 있다.