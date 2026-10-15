# 손오공 선택·유상 옵션 연결 — 설계 한 장 (2026-10-16, 대표 질문 «옵션을 안 가져오냐 / 유상 옵션도 끌고 와야»)

상태: DESIGNED. 코드 변경 없음. 근거 = B3Q 읽기 전용 조회(source_raw/RP012 339건, API 호출 0)와 저장소 코드. 승인 뒤 구현·Codex.

## 1. 사실
- 파트너 API 는 상세에 옵션을 «준다». 전체 원문은 products 가 아니라 `source_raw/RP012__<번호>` 의 raw 에 있고, products·`source_cycle_record` 에는 digest 해시만 남는다. products 에는 옵션·설명·점검·보험 칸이 없다 → ERP5 에 안 나간다.
- `detail.options` = `[{ category: 문자열, name: 문자열, amount: 정수|null }]`. 339건 중 283건에 있음(총 약 11,000개). category: CONVENIENCE 5,255 · INTERIOR 2,455 · SAFETY 1,685 · EXTERIOR 759 · MULTIMEDIA 605 · «선택옵션» 541. `amount` 는 «원 단위 정수», non-null 484개이며 «선택옵션» 에 걸린다(샘플 90만~510만 원대).
- 어댑터(`sonogong-api.ts`)는 목록·상세의 일부 칸만 쓴다(차종·제원·가격·사진·상태). 옵션·설명·점검·보험은 읽지 않는다. 레거시 ERP 정규화(`normalize-sonogong`)는 «존재 여부(RAW_ONLY)»만 남겼다.

## 2. 사용/버림 표
| 구분 | 키 | 현재 |
| --- | --- | --- |
| 쓴다 | brand·model·detailName(→차종·원문 차명), carNumber, fuel·displacementCc·manufactureYearMonth·exteriorColor·mileageKm(→제원), prices·deposit, images, 계약 여부 | 반영 중 |
| 버린다 | options 전체(무상·유상)·amount, description, newCarOptionNote, inspection, insuranceHistory, insurance, interiorColor, id·tab | products 에 칸 없음 |

## 3. 구조안 (옵션)
- 상품 문서에 **새 칸**을 둔다(기존 `options`/`옵션원문`/`정제옵션` 은 과거 시트 유래 칸이라 섞지 않는다 — 사람이 고친 값 보호).
  - `api_options_basic`: `[{ category, name }]` — 무상(기본 포함). `선택옵션` 이 아닌 category 전부.
  - `api_options_paid`: `[{ name, amount_krw: 정수|null, amount_state: 'KNOWN'|'UNKNOWN', amount_raw }]` — 유상 후보(`선택옵션`). `amount` 가 null 이면 UNKNOWN(금액 미확인 — «확인 필요»), 값이 양의 정수면 KNOWN(원 단위, 근거 = 원문 amount). 0·음수·비정수는 UNKNOWN.
  - `api_options_observed_at`·`api_options_source: 'RP012-api'`.
- 원문 보존: `source_raw` 가 원문 정본(변경 없음). 상품 칸은 정제 투영 — 이름은 공백·전각 정리만 하고(표준 옵션 사전 매핑은 사전이 생길 때 별도), 의미를 바꾸지 않는다.
- «선택옵션» = 유상 구분의 근거는 API category 한 가지다. 무상/유상을 이름에서 추정하지 않는다. `amount` 가 있는데 category 가 선택옵션이 아닌 항목이 있으면 UNKNOWN 으로 두고 사례를 노트로 낸다(실측 필요).

## 4. 공개 범위·표시 전용
- 공개 피드(`public-product-feed`): 문자열 `options`(300자)에 금액·% 꼴이 있으면 검증이 던진다 → 유상 금액은 문자열에 섞지 않는다. 새 구조 칸으로만 낸다: `option_basic: string[]`, `option_paid: [{ name, amount_krw|null }]`(계약 스키마 버전 추가, 선택 필드). 이름 문자열은 금액 꼴 검사 대상.
- 계산 비반영: 유상 옵션 금액은 대여료·보증금·견적 계산에 들어가지 않는다 — 표시만(«유상 옵션, 별도 안내»). 계산 반영은 별도 결정(대표). price 맵·deposit_rule 은 건드리지 않는다.
- 내부 메모(`partner_memo`·`sales_notes`)·공급사 정책 메모와 섞지 않는다(별도 칸, 별도 허용 목록).

## 5. 설명(carDescription)·신차 옵션 메모
- `description`(채움 297, 최대 1,353자, 금액 꼴 61건, 전화번호 꼴 0): 공급사가 쓴 자유 서술 — **비공개 내부 메모**로 판정(기본). 금액·조건 문구가 섞여 공개 비고로 바로 쓰면 약속·오표시 위험. 공개가 필요하면 정제·승인 뒤 별도 칸.
- `newCarOptionNote`(27): 신차 옵션 안내 — 공개 후보이나 같은 금액 꼴 검사를 거친 뒤. 점검·보험(inspection·insurance*)은 이번 범위 밖(별도 요청 시 설계).

## 6. 반영 계획(336대)
1. 엔진 읽기 확장: 어댑터가 `detail.options` 를 `raw.options` 로 싣는다(압축 레코드의 digest 가 바뀌므로 한 번 전체 갱신 후보가 된다).
2. 쓰기: 사진 주소(#654)와 같은 방식 — 변경 차만, 사람이 고친 칸 보호, 비어 있는 칸은 채움, 원천 값이 바뀌면 갱신. 첫 반영은 `rewriteReasons: OPTIONS_LAYOUT` 한 번(되풀이 없음), 회차당 상한을 두고 plan(쓰기 0) → 승인.
3. 영향 대수는 plan 으로 확인(옵션 있는 문서 283건 예상, 유상 amount 있는 문서 수는 읽기 전용 집계 필요).
4. ERP5 표시(ERP·개발): 상세에 «기본 옵션»·«유상 옵션(별도)» 두 구역. 목록 카드는 변경 없음.

## 7. 다른 공급사
이안카 ONE·오토플러스·아이언 어댑터에는 옵션을 읽는 코드가 현재 없다. 오토플러스 시트와 마음카 파일은 «옵션» 텍스트 칸이 있으나 무상/유상 구분과 금액은 없다(텍스트 한 칸). 이안카·아이언의 옵션 제공 여부는 각 원천 응답 확인이 필요하다 — 응답 모양 확인 도구(`probe-sonogong-shape`)와 같은 방식으로 원천별 확인 가능.

## 8. 결정 필요
1. 새 칸 이름·구조(`api_options_basic/paid`)와 공개 피드 스키마 추가(선택 필드) 승인.
2. `description` 을 비공개 내부 메모로 둘지(권고), 공개 비고 정제 경로를 둘지.
3. 유상 옵션 금액의 «표시 전용» 범위(상세만, 견적서 미표시) 확정.
