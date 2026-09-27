# ERP / Sheet 상품 4분할 구조

## 결론

상품 데이터를 저장하는 Canonical 구조와 사람이 보는 Google Sheet/ERP 화면 구조를 동일하게 만들 필요는 없다.

Canonical은 원천 사실을 손실 없이 보존하고, ERP 소비 뷰는 다음 네 영역으로 고정한다.

1. **차량**
2. **기간별 대여료**
3. **정책**
4. **계약조건**

Google Sheet는 이 네 영역을 열(column) 또는 탭(tab)으로 펼쳐도 되지만, 권위는 FreePass Data의 Canonical + Projection에 남긴다.

## 1. 차량

목적: "이 차가 무엇이고 어떤 상품인가?"

포함:
- productId
- commercialType
- 상품명
- vehicleModelId / vehicleAssetId
- 제조사 / 모델 / 세대 / 세부모델 / 트림
- 연료 / 구동 / 인승
- 차량번호 / 현재 주행거리 / 재고상태

포함하지 않음:
- 월대여료
- 보증금
- 보험/연령 조건
- 기본 주행거리 정책

즉 ERP 목록에서 상품을 식별하고 분류하는 축이다.

## 2. 기간별 대여료

목적: "몇 개월, 몇 km 조건에서 월 얼마인가?"

행의 최소 키:
- termMonths
- mileageKmPerYear
- monthlyRent

보조:
- termKey
- isDefaultMileage

보증금은 이 영역에서 제외한다. 원천 Canonical PriceTerm에는 보증금이 남아 있을 수 있지만 ERP 소비 뷰에서는 계약조건으로 이동한다.

예:
- 24개월 / 20,000km / 700,000원 / 기본
- 24개월 / 30,000km / 760,000원
- 36개월 / 20,000km / 650,000원 / 기본

## 3. 정책

목적: "시스템이 이 상품을 어떻게 해석하고 기본 선택할 것인가?"

현재 정책으로 분류:
- annual_mileage
- max_annual_mileage
- mileage_upcharge_per_10000km
- over_mileage_rate_domestic
- over_mileage_rate_imported
- over_mileage_rate_per_km

대표적으로 `annual_mileage`는 기본 주행거리다.
가격표에 2만/3만 km가 같이 있어도 정책값이 2만 km이면 2만 km 행을 기본으로 선택한다.

정책은 **상품 구성/선택 로직**이고 고객과 직접 약정하는 문구·의무 자체는 아니다.

## 4. 계약조건

목적: "이 상품을 계약할 때 고객에게 실제로 적용되는 조건은 무엇인가?"

기간별:
- 보증금 금액 / 0원 / 비적용 / 미확정

공통 조건:
- 보험 포함 여부
- 운전자 연령
- 연령 하향 비용
- 추가 운전자 비용
- 자차/대물/대인 관련 면책
- 정비 포함 여부
- 승계 가능 여부 / 승계 수수료
- 중도해지율
- 연체율 / 자동해지 연체일
- 사고해지 기준
- 보증금 반환일
- 보증금 카드/할부 가능 여부

즉 고객 계약서나 상품 상세의 "조건"으로 표시될 값이다.

## Google Sheet 표현

시트는 전송/검수 편의를 위해 넓게 펼친다.

### 상품 시트
차량 및 상품 identity 중심.

### 대여료 시트
한 행 = productId + offerId + termMonths + mileageKmPerYear.
가격 variant가 여러 개면 여러 행.

### 정책 시트
한 행 = policyId + policy key + value.
또는 안정된 key는 wide columns로 펴도 된다.

### 계약조건 시트
한 행 = product/offer + 조건.
보증금처럼 기간별 조건은 termKey를 함께 둔다.

단, Sheet를 다시 정본으로 사용하지 않는다.

## 분류 안전장치

새로운 policy fact가 들어왔는데 네 영역 중 정책/계약조건 어느 쪽인지 아직 정의되지 않았다면:
- 임의로 노출하지 않는다.
- `POLICY_FACT_CLASSIFICATION_REQUIRED`를 발생시킨다.
- `unclassifiedPolicyFacts`에 원래 key를 남긴다.

이 방식이면 공급사 신규 정책값이 들어와도 조용히 사라지거나 엉뚱한 영역으로 섞이지 않는다.

## ERP 소비 원칙

ERP는 원천 컬렉션을 직접 조합하지 않는다.

`CommercialProductView`만 소비하면:
- 상품 목록: `vehicle`
- 기간/가격 선택: `rentalRates`
- 기본값/자동선택: `policy`
- 상세/계약 검토: `contractConditions`

으로 역할이 명확하게 갈린다.
