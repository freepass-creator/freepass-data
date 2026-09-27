# Commercial Data Catalog

## 역할 경계

FreePass Data는 소비처의 화면을 결정하지 않는다.
FreePass Data의 책임은 렌터카 상품 데이터를 의미별로 정리하고, 근거와 불확실성을 포함해 소비하기 쉬운 계약으로 제공하는 것이다.

Admin, ERP.com, Kakao Ops, Sheet, Estimate 등 각 소비처는 같은 데이터 카탈로그에서 자기 목적에 필요한 항목을 선택한다.

## 데이터 분류

### 1. basisRows — 원천 가격 사실
- 기간별 원천 월대여료
- 보증금
- 그 가격이 성립하는 조건
- 조건별 provenance
- UNKNOWN / policy match

### 2. dataCatalog.dimensions — 조건축 전체
조건마다 다음 메타데이터를 제공한다.
- key / label
- group: TERM / MILEAGE / DRIVER / INSURANCE / MAINTENANCE / PAYMENT / DELIVERY / SETTLEMENT / OTHER
- role: PRICE_INPUT / ELIGIBILITY / CONTRACT_ONLY
- valueType
- defaultValue / allowedValues / options
- sourcePolicyKeys
- mayAffect: MONTHLY_RENT / DEPOSIT / UPFRONT_FEE / ELIGIBILITY

### 3. dataCatalog.classification — 골라 쓰기 위한 색인
- priceInputKeys: 가격을 만들거나 바꿀 수 있는 조건
- eligibilityKeys: 계약 가능 여부를 판단하는 조건
- contractOnlyKeys: 가격 계산과 별개인 계약조건
- groups: 업무영역별 조건키 목록

### 4. dataCatalog.pricingModifiers — 현재 확인된 가격 가감 정보
- 주행거리 상향
- 연령 하향
- 추가운전자
- 향후 보험/정비/대차 등의 typed adjustment rule로 확장

### 5. policyFacts / contractFacts
- policyFacts: 상품값 선택/산출에 관여하는 정책 사실
- contractFacts: 계약상 권리·의무·처리 조건
- 한 사실이 가격 입력이면서 계약서 표시값일 수도 있으므로 의미를 잃지 않고 분류한다.

### 6. derived — 파생값
소비처가 반복 계산하지 않아도 되도록 유용한 파생값을 제공한다.
- lowestBasisPrice: 원천 Basis 중 최저 월대여료와 그 조건
- defaultConditionResult: 명시적 기본조건을 적용한 산출 결과

파생값은 표시 지시가 아니다.
소비처는 lowestBasisPrice를 쓸 수도 있고 defaultConditionResult를 쓸 수도 있고 둘 다 안 쓸 수도 있다.

### 7. quality — 데이터 품질
- unresolvedDimensionKeys
- partialBasisTermKeys
- ambiguousPolicyTermKeys
- unclassifiedPolicyFactKeys

소비처는 품질 상태를 보고 표시/업무/검수 정책을 자체 결정한다.

## 핵심 원칙

FreePass Data는 다음 질문에 답한다.
- 우리가 아는 사실은 무엇인가?
- 어떤 조건의 가격인가?
- 그 사실은 어디에서 왔는가?
- 어떤 조건이 가격을 바꿀 수 있는가?
- 어떤 조건은 계약 가능성만 바꾸는가?
- 어떤 계약조건이 존재하는가?
- 무엇을 아직 모르는가?
- 어떤 파생값을 안전하게 계산할 수 있는가?

FreePass Data는 다음 질문에는 답하지 않는다.
- Admin 목록에 무엇을 보여줄 것인가?
- ERP.com 상세의 첫 줄은 무엇인가?
- 고객 화면에서 어떤 배지를 쓸 것인가?
- Kakao 답변에서 몇 개 항목을 말할 것인가?

그 결정은 각 소비처의 책임이다.

## 호환 필드

현재 소비처 전환 중이므로 commercial block의 listing/preview/conditionSummary는 당분간 호환용으로 유지한다.
정본 의미는 dataCatalog와 basisRows에 두고, 이후 소비처가 안정적으로 dataCatalog를 사용하면 호환 필드 제거 여부를 별도로 결정한다.