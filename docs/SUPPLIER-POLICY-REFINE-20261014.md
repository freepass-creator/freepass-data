# 공급사 정책 정제 — 보증금 (2026-10-14)

> 대표 2026-10-14: «원문을 먼저 가지고 오고 대수를 맞추고 가지고 온 것들을 정제를 하면 되잖아. 옵션, 정책 이런 것들 다 그 회사에서 주는 곳을 보면 거기에 정책이 있다. 값이 숫자로 존재하거나 산출식으로 존재한다.»

## 원칙

1. **원문 → 대수 → 정제.** 원천 엔진은 공급사 원문을 먼저 가져오고(원문은 `raw`·`source_cycle_record` 에 보존), 차량 대수를 맞춘 뒤, 공급사 **자기 정책**으로 값을 정제한다.
2. **자리채움 0 은 «무보증»이 아니다.** 공급사 API·시트의 숫자 0·빈칸은 확인된 무보증이 아니다. 무보증(ZERO)은 명시 문구 근거가 있을 때만이다(기존 `deposit-evidence` 규칙 그대로).
3. **숫자가 먼저, 숫자가 없을 때 산출식.** 보증금은 공급사가 준 **숫자(원문 금액)** 이거나, 숫자가 없을 때(0·빈칸 = 자리채움) 공급사 정책의 **산출식(규칙 코드)** 이다. 양수 원문 금액은 어느 상품 구분이든 KNOWN 원문 금액(`SOURCE_AMOUNT`)이고 계산 표식을 달지 않는다 — 규칙 값과 다르면 검토 근거로만 남긴다(READ-RUNTIME «양수 원문 금액 우선», NEXT-START-HERE 2026-10-10). 산출식 값은 계산값임을 표식으로 남긴다.

정본 코드: `src/domain/supplier-deposit-policy.ts` (규칙 표 + 공급사·상품 구분별 정책 표). 이 표에 없는 공급사는 정제하지 않는다(기존 원문 금액 경로).

## 정책 표

| 공급사 | 상품 구분(원천) | 보증금 | 규칙 코드 | 정책 출처 |
|---|---|---|---|---|
| RP012 손오공 | 중고렌트 (`tab=rent`) | 원문 금액: 상세 `prices.RENT_RETURN.deposit` 양수만 KNOWN. 0·빈칸 = UNKNOWN (API 에 무보증 표시 칸 없음) | — | 손오공 파트너 API(ERP 원값) |
| RP012 손오공 | 오공구독 (`tab=sub`) | 원문 양수 금액이 있으면 그 금액. 0·빈칸이면 산출식: 월 대여료 × 약정연수, 최대 3개월 (12개월 ×1 · 24개월 ×2 · 36개월 이상 ×3) | `RENT_X_CONTRACT_YEARS_MAX3` | 손오공 구독 정책 «월 대여료 × 약정연수 (최대 3개월)» |
| RP012 손오공 | 픽업구독 (`tab=pick`) | 위와 같음 | `RENT_X_CONTRACT_YEARS_MAX3` | 위와 같음 |
| RP023 오토플러스 | 오플구독 | 산출식: 월 대여료 × 2(국산) / × 3(수입). 국산·수입을 가를 수 없으면 UNKNOWN | `AUTOPLUS_RENT_X2_DOMESTIC` · `AUTOPLUS_RENT_X3_IMPORT` | 오토플러스 구글 시트 계산 규칙 (#642) |

- 약정연수 계산은 `contractYearsMultiplierMax3` 하나다. 비고 문구 해석(`resolveDepositByRuleNote`·`depositFromYearsRuleNote`)도 같은 함수를 쓴다.
- 손오공 구독 항의 API 양수 보증금이 계산값과 다르면 원문 금액을 쓰고, 계산값은 `term.raw.rule_deposit` 에 검토용으로 남기며 읽기 경고 `DEPOSIT_RULE_DIFFERS:n` 으로 센다. 구독 항의 API 0 은 `term.raw.api_deposit=0` 으로 남기고 산출식을 쓴다. 중고렌트 0 은 UNKNOWN 이고 `DEPOSIT_PLACEHOLDER_ZERO:n` 으로 센다.

## 엔진 쓰기와 표시

- **항(개월)마다 표식.** 어댑터는 계산한 항에 `term.raw.deposit_rule` 을 남기고, 엔진은 판매 가격 칸(`price[개월]`)과 같은 대표 항에서 문서 칸 `deposit_rules: { "<개월>": "<규칙 코드>" }` 와 `deposit_source: "CALCULATED"` 를 쓴다. 계산 항이 없으면 둘 다 `null` 로 지운다. #642 의 문서 단위 `deposit_rule` 은 `null` 로 지운다.
  - 문서 단위 표식만 두면, 한 문서에 원문 금액 항과 계산 항이 섞이거나 탭이 바뀐 뒤(중고렌트 ↔ 구독) 낡은 표식이 남는다. 항마다 표식을 두면 가격 칸과 같은 곳에서 만들어 항상 짝이 맞는다(correct-by-construction).
  - 가격을 새로 쓸 때만 표식도 쓴다(가격을 보존하는 비노출 문서는 둘 다 그대로).
- **보존 불변식.** 원천 보증금 UNKNOWN 은 같은 항의 이전 KNOWN 을 지우지 않는다. 이전 값이 계산값이었으면 규칙 코드도 함께 보존한다(`preservedDepositOf`). 자리채움 0 공급사(RP012)의 이전 ZERO 는 보존하지 않는다 — 옛 매핑이 API 0 을 ZERO 로 써 둔 «무보증»을 되살리지 않는다. 정합 보고(`source-reconciliation`)도 같은 함수를 쓴다.
- **표시(소비처).** `calculatedDepositRuleFromProduct(product, termMonths)` 가 다음을 모두 만족할 때만 규칙을 근거로 쓴다: 원천 엔진이 쓴 문서(`source_cycle_write.by === 'source-engine'`), `deposit_source === 'CALCULATED'`, 그 항의 규칙 코드가 그 공급사의 규칙. 그리고 금액이 «현재 대여료·개월로 다시 계산한 값»과 정확히 같아야 KNOWN(`CALCULATED_RULE:<코드>`). 다르면 `UNKNOWN`(`CALCULATED_DEPOSIT_RULE_MISMATCH`). `deposit_rules` 가 없는 옛 #642 문서만 문서 단위 `deposit_rule` 을 읽는다.

## 상태

- CODED · TESTED (`tests/supplier-deposit-policy.test.ts`, `tests/sonogong-api.test.ts`, `tests/autoplus-deposit-rule.test.ts`).
- 운영 반영(엔진 회차 실제 쓰기·소비처 되읽기)은 별도 확인 대상이다. 기존 RP012 문서는 다음 엔진 회차에서 가격이 바뀌면서 표식과 함께 다시 쓰인다.
