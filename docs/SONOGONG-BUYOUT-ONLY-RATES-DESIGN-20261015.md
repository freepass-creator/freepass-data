# 손오공 «인수형 가격만 있는 차» 편입 설계 (한 장, 코드 없음) — 2026-10-15, DATA

> 대표 결정 10-15: 인수형 가격만 있는 차는 **인수형 가격만 노출해서 가져온다**(«반납형 없음 → 비노출·TERMS_HOLD» 로 처리하지 않는다).
> 설계 확인 뒤 코드 PR. 쓰기 경로(노출 대상·가격 칸)이므로 Codex 검토 대상.

## 0. 현재 동작(코드 확인)
- 어댑터(`src/adapters/sonogong-api.ts`): 탭별 «반납형» 가격 유형(`rent`→`RENT_RETURN`, `sub`·`pick`→`SUBSCRIBE_RETURN`)의 `monthly` 만 읽어 `terms` 를 만든다. 인수형(`RENT_BUYOUT`·`SUBSCRIBE_BUYOUT`)은 `raw.prices` 에 원문으로만 남는다.
- 반납형 `monthly` 에 양수 대여료가 없으면 `terms` 가 비어 `validateSourceRecord` 가 `TERMS_HOLD` → 새 차는 `INFO_INCOMPLETE` 비노출 편입(문서는 생기지만 노출 안 됨).

## 1. 어댑터 변경(설계)
- **선택 규칙(차량 단위, 행 섞지 않음)**: 반납형 `monthly` 에 양수 대여료 행이 **하나라도 있으면 현행 그대로**(반납형만 사용, 인수형은 raw 에만). 반납형에 양수 행이 **하나도 없고** 같은 탭의 인수형(`RENT_BUYOUT`/`SUBSCRIBE_BUYOUT`)에 양수 행이 ≥1 이면 그 인수형 행만 `terms` 로 만든다. 반납형 칸은 만들지 않는다(0·빈 값으로 채우지 않음).
- 인수형 행의 보증금은 같은 유형의 `deposit`(상세에만 있음, 현행과 같은 규칙: 상세 있을 때 읽고, 없으면 UNKNOWN). 보증금 0 은 원천에 0 이 있을 때만.
- 기록 표식: `term.raw.priceType` = `SUBSCRIBE_BUYOUT`/`RENT_BUYOUT`(현행 필드 재사용), 레코드 `raw.price_basis = 'BUYOUT_ONLY'`(추적용 짧은 문자열).
- 유효성 가드 유지: 양수 대여료 행 ≥1(`validateSourceRecord` 의 TERMS_HOLD 규칙 그대로), 보증금 KNOWN/ZERO/UNKNOWN 규칙 그대로. 인수형도 양수가 없으면 지금처럼 TERMS_HOLD.

## 2. 엔진 표현(판매 가격 칸)
- 공통 모듈(`source-engine`)에 «정산 방식» 개념이 없다 — `termIdentity`=`개월|약정거리`, `salePriceMap` 키 = `String(개월)`(대표 항) + 옵션 키 `{개월}_월/연{N}km`.
- 변경: `term.raw.priceType` 이 `*_BUYOUT` 인 항은 **별도 항**이다. `termIdentity` 에 정산 방식을 포함해 반납형·인수형이 같은 개월에도 충돌하지 않게 하고(이번 규칙은 둘을 섞지 않지만 안전을 위해), `salePriceMap` 은 인수형 항을 **`{개월}_인수형`** 키로 쓴다 — 이 키는 이미 데이터·ERP5 가 쓰는 규약이다(`parseErp5CompatibilityPriceKey`, ERP5 `ratesOf`: 접미사 «인수형» → `maturity=BUYOUT`).
- 결과 예: 인수형만 있는 차의 `price` = `{ "36_인수형": {rent, deposit}, "48_인수형": … }`, **평문 `"36"` 키 없음**.
- 반납형이 있는 차의 `price` 는 한 글자도 바뀌지 않는다(인수형 행을 추가하지 않음 — 시험으로 고정).

## 3. ERP5 화면 확인(코드 확인 결과, freepasserp5)
- `catalog-model.js` `ratesOf`: 가격 키 `^(\d+)(?:_(.+))?$` 의 접미사 «인수형» → `maturity=BUYOUT`, `maturityLabel='인수형'`(공급사 «손오공»). 접미사 없는 구독 = `RETURN`/«반납형», 렌트 = `NEGOTIATED`/«협의형». 접미사 있는 행은 `rates` 에 정상 포함된다.
- `catalog.js` `templateVehicle`: 모든 `rates` 가 `baselineRates` 가 되고 대표 요금 = 최저 월 대여료 — **반납형이 없어도 `rates` 가 비지 않으므로 «가격 없음» 으로 보이지 않는다.** 상세(`consumer-view.js`)는 반납형·협의형·**인수형**·만기 조건 확인 필요 그룹으로 나누고 인수형에는 설명(?) 패널이 있다.
- 필터(만기 조건 `maturity`)·기간·예산·보증금 필터는 행 단위라 인수형 행에도 동작한다.
- **ERP5 변경 항목: 없음(필수). 확인 항목 1건(클라우드 freepasserp5)**: 목록 카드의 대표 월 대여료가 «최저가 행»이라 인수형만 있는 차는 인수형 요금이 대표로 나온다 — 카드에 만기 조건(인수형) 표기가 같이 나오는지 확인하고, 없으면 카드 라벨 보강(선택).
- Data 쪽 소비처: `deposit-evidence`·카톡 수수료 참조(`kakao-catalog-reference`)가 `_인수형` 키를 이미 읽어 `subscriptionForm=BUYOUT` 으로 쓴다. 정산·수수료는 «인수형 수수료 규칙»이 별도라(정산 담당) 인수형만 있는 차의 수수료는 규칙 확정 전 «확인 필요»로 남는다(차량 노출과 별개).
- 주의: 옛 정규화 경로(`erp5-product-mapping`)는 BUYOUT 키를 만나면 `BUYOUT_PRODUCT_SEPARATION_REQUIRED` 를 내지만 이는 정본 상품 생성 경로이고 엔진→ERP5 소비 경로가 아니다(영향 확인만).

## 4. 영향 대수
- **새로 노출될 차량 수 = 반납형 양수 행이 없고 인수형 양수 행이 있는 차량 수.** 지금 값은 비공개 plan evidence(목록 행 `prices` 키·`monthly`)에서만 셀 수 있다. 후보 3대(385서9417·100저9582·100저9593)가 이 조건인지는 **B3Q 확인 회신 대기**(문서 필드·tab·가격 키 구성). 3대 모두 해당하면 +3, 일부면 그만큼.
- 현재 배포 catalog 기준: 손오공 334(반납형 보유), 이 규칙의 영향 0 → 적용 후 334 + 새 인수형 전용 차량 수.
- 계약중(`hasActiveContract`)은 현행대로 «계약중» 표시 노출.

## 5. 이미 노출된 반납형 보유 차에는 영향 없음 — 보증 방법
- 선택 규칙이 «반납형 양수 행 존재 시 현행 경로 그대로»이므로 해당 차량의 `terms`·`price`·digest 는 변하지 않는다 → plan 에서 UPDATE 가 생기지 않는다(변경 0 문서는 건너뜀).
- 시험으로 고정: (a) 반납형만 있는 차 = 변경 전과 동일한 terms/price, (b) 반납형+인수형 둘 다 있는 차 = 반납형만(인수형 행 미추가), (c) 인수형만 있는 차 = `{개월}_인수형` 키만, 평문 키 없음, (d) 둘 다 양수 행 없음 = TERMS_HOLD, (e) 인수형 보증금 상세 유무, (f) 반납형이 일부 개월만 있는 차 = 반납형 일부만(현행) — 규칙은 «행 존재 여부»가 아니라 «반납형 양수 행이 하나도 없음»일 때만 전환, (g) 엔진 digest/되읽기 일치(`{개월}_인수형` 키 왕복).

## 6. 구현 범위(확인 뒤)
- `sonogong-api.ts`(선택 규칙), `source-engine.ts`(`termIdentity`·`salePriceMap` 인수형 키), `source-cycle-firestore.ts`(`PRICE_LAYOUT` 재기록 사유가 인수형 키를 기대 키로 인식 — 기대 옵션 키 계산은 `salePriceMap` 재사용이라 자동), 시험, 문서. 쓰기 경로이므로 Codex 검토, 적용은 DRY_RUN → plan 의 ENROLL/REEXPOSE 건수 확인 후 정시 회차.

## 7. 결정·확인이 필요한 것
1. **혼합 차(반납형+인수형 둘 다 있음)**: 이번 규칙은 «반납형만 노출(현행)». 인수형 행도 같이 보여 줄지는 별도 결정(ERP5 는 지원하지만 수수료·정산 규칙이 먼저).
2. 렌트(중고렌트) 탭의 `RENT_BUYOUT` 도 같은 규칙으로 «인수형» 표기해도 되는지(ERP5 는 공급사 손오공이면 탭과 무관하게 BUYOUT 표기).
3. 목록 카드 대표 요금에 만기 조건 표기(클라우드 freepasserp5, 선택).
