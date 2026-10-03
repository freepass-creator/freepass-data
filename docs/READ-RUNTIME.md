# FreePass Data — Authenticated Read Runtime

Status: IMPLEMENTED / VALIDATION REQUIRED BEFORE DEPLOYMENT

## Purpose

Expose the proven ERP public projection and Catalog Data Health through a dedicated
read-only backend without exposing raw Firestore topology or Catalog write commands.

## Runtime

Start:

```bash
FREEPASS_DATA_DRIVER=firestore \
FIREBASE_PROJECT_ID=freepasserp5 \
FREEPASS_DATA_CONSUMERS_JSON='[...]' \
npm run serve:consumers
```

The runtime rejects:
- memory mode
- non-`freepasserp5` projects
- Firestore emulator mode
- unregistered consumers
- invalid/shared service tokens

It does not seed data, publish releases, run workers, or expose Catalog mutation routes.

## 수수료 연동 기준 — 사용자 결정 2026-09-30

**프리패스 수수료는 지급수수료(`channelPayoutFee`)다.** FreePass가 영업채널에 지급하는 금액이며, 공급사로부터 받는 청구수수료나 내부 마진을 뜻하지 않는다.

| 연동 대상 | 제공할 수수료 | 지급 방향 |
|---|---|---|
| 영업채널 / 기본 수수료 연동 | `channelPayoutFee` — 프리패스 수수료 | FreePass → 해당 영업채널 |
| 공급사 | `supplierBillingFee` — 공급사 청구수수료 | 해당 공급사 → FreePass |

`src/domain/catalog.ts`의 `COMMISSION_CONSUMER_POLICY`와 `projectCounterpartyCommission`이 이름과 선택 규칙의 실행 정본이다. 두 외부용 projection은 상대편 수수료, 마진, 내부 산식·원천 참조를 포함하지 않는다. 미확정은 `UNKNOWN`/null, 명시적 0원은 `ZERO`/0이며 기간별 값을 유지한다.

이 helper는 **PREPARED** 상태다. 신규 공급사/영업채널 API와 운영 등록은 아직 연결되지 않았다. 운영 API에 연결할 때 audience와 공급사/영업채널 ID 범위는 서버가 등록된 전용키의 grant에서 결정해야 한다. 요청의 query/body로 audience를 바꾸거나 다른 공급사·채널을 조회할 수 있게 만들지 않는다. 상대별 계약조건이 다르면 해당 조건을 조회하고, 없으면 공통 기준을 확정 지급액으로 간주하지 않고 HOLD한다.

기존 Kakao `catalog-reference`는 내부 업무용으로 양쪽 수수료와 예상 마진을 포함하는 별도 계약이다. 이 응답과 키를 외부 공급사/영업채널에 전달하지 않는다. 현재 public ERP/화이트라벨 projection에는 내부 수수료를 추가하지 않는다. 외부 연동 완료는 전용 계약·scope 차단 테스트·인증된 운영 readback 이후에만 선언한다.

### Admin 내부 기간별 경제조건 — 2026-10-03

Canonical `catalog_offers.internalEconomicsTerms`는 신규 canonicalization, 승인된 원천 Offer 변경, 가격 변경의 기존 CatalogStore 거래 안에서 다시 계산한다. `precomputeOfferEconomics`는 `sales-commission-2026-10-04`의 공통 resolver를 재사용한다. 09-28 정책 및 ERP `settlement-fee-table.ts@f862d0097f6e83d79d0b699bc369a83716b1d982`는 이전 근거로 보존하고, 현재 정본은 아래 10-04 F04 제공 사본이며 10-03 정책 객체는 과거 규칙으로 보존한다. 대여료·보증금은 `priceTerms`에서 복사하며 별도 `internalPeriodFees` 저장소는 없다. 수수료는 계약 전체 1건의 VAT 별도 공급가액이고 `calculation`, `sourceRefs`, `ruleId`, `policyId`, `vatTreatment`, `vatAmount`, `totalAmount`를 보존한다. Offer의 기존 `policyId`(상품 정책)와 수수료의 `policyId`(규칙 묶음)는 다르다.

Admin 전용 `data[].offers[].priceTerms[].supplierBillingFee` / `channelPayoutFee`만 양쪽 금액을 제공한다. Admin은 FreePass 내부 계약접수 주체이므로 외부 공급사/영업채널의 상대편 수수료 제외 규칙과 구분한다. 서버의 `freepass-admin-catalog` 전용 등록·키 제한을 유지하고 public ERP·화이트라벨·Kakao 응답에는 이번 필드를 추가하지 않는다. Admin projection은 저장된 값만 읽고 누락·중복·무효·가격/기간 불일치를 UNKNOWN으로 내린다. Admin에서 재계산하지 않는다.

`meta.economicsTermCounts.{supplierBillingFee,channelPayoutFee}.{KNOWN,ZERO,UNKNOWN,NOT_APPLICABLE}`는 각 수수료별 기간 행 수다. `meta.economicsCoverage`는 빈 기간 목록 또는 한쪽 UNKNOWN이 있으면 INCOMPLETE, 나머지는 COMPLETE다. 릴리스의 `economics`에도 저장하고 gateway는 검증된 release data로 다시 집계한다. Health `checks.offerEconomics`에도 같은 지표를 쓰되 분모는 전체 Canonical Offer의 기간이며 Admin ACTIVE 대상과 다를 수 있다. COMPLETE는 지급 확정·정산 완료·원천 최신성 확인을 뜻하지 않는다.

#### 수수료 연동 기준

- 스타 RP018·스카이 RP033 재렌트: 월료 100% 청구·80% 지급, VAT 포함. 공급사 ID는 유지하고 규칙만 공유한다. 신차는 이 특칙에 포함하지 않는다.
- 퍼시픽 RP022 신차: `vehicleValue` × 요율. `newProductSubtype`은 `NEW_PREDELIVERY`/`NEW_MATCHING`, `depositTierPercent`는 계약상 5/10이다. 선출고 청구/지급은 5% 등급 3%/2.5%, 10% 등급 4%/3%; 매칭은 3%/3%, 3.3%/3.3%. 모두 VAT 포함. 등급 없으면 `DEPOSIT_TIER_REQUIRED`이며 보증금 금액으로 추정하지 않는다. 재렌트는 표준, VAT 별도다.
- 원 단위 반올림은 F04 171행 미확정이다. 산식·공급가·VAT에 소수점이 생기면 `UNKNOWN / WON_ROUNDING_POLICY_UNCONFIRMED`; 정수로 정확히 나누어지는 경우만 계산한다. VAT 포함 공급가 = 총액×10÷11, VAT 별도 = 공급가÷10. 마진은 공급가끼리 차감한다.
- 손오공 구독: `q12Basis: { amount, sourceRef }`는 근거로 선택한 12개월 계약 기준 **월** 구독료다. 없으면 `Q12_BASIS_REQUIRED`. `subscriptionForm`은 `BUYOUT`/`RETURN`; 반납형은 12개월만. 청구는 Q12＋기간 가산(12:10만, 24:30만, 36:50만, 48:70만; 60: 사용자 명시 HOLD), 지급은 Q12다. 기간 보간은 없다.
- 아이언 신차 선출고 4%/3%, 일반 표준 신차 3.5%/3%, 오토플러스 일반 구독 100만/80만, 아이카 재렌트 6개월 40만/30만·전기차 100만/80만은 VAT 별도다.
- 마음카 RP034는 `NOT_APPLICABLE / SUPPLIER_EXCLUDED_BY_DECISION`. 미등록 공급사, 미지원 기간, 표준 매칭 개별율, 아이카 1개월 기준액·연장 조건, 빌린카·엘씨 60개월 외 구독·웰릭스 구독 범위, 스위치 비구독 등은 UNKNOWN과 사유를 유지한다. `individualException: true`만 있고 아래의 유효한 개별 근거가 없으면 `INDIVIDUAL_EXCEPTION_EVIDENCE_REQUIRED`; 오토플러스 프로모션 등 개별 거래를 일반 규칙으로 확장하지 않는다.

`precomputeOfferEconomics`의 네 번째 인자 `evidenceByTerm[termKey]`로 위 계약 근거를 전달할 수 있다. 기존 자동 저장 호출은 이 계약 근거를 수집하지 않으므로 입력이 필요한 상품은 UNKNOWN을 유지한다. 월료나 다른 기간 가격에서 Q12를 선택하지 않는다. 저장된 기존 정책 값은 읽기 시 자동 재계산하지 않으며, 새 정책 반영에는 승인된 재저장이 필요하다.

ERP 차이: 이번에는 ERP를 수정하지 않았다. ERP의 스타·퍼시픽·손오공 문자열/`auto:false` 규칙과 달리 Data는 필수 근거가 있으면 계산한다. Data는 스카이 ID, 계약 등급, 구독 형태, Q12 출처, VAT 분리와 UNKNOWN 사유를 명시하며 ERP의 상품 기본 재렌트 분류·형태 무시 fallback을 사용하지 않는다. 청구·지급 시점과 일반 분납은 별도 정산 업무다. 아래 승인된 개별 고정액만 명시적으로 계산한다.

로컬 구현이며 운영 backfill·발행·배포·cutover는 없다. 저장값이 없는 기존 Offer는 새 승인된 저장까지 UNKNOWN이다. 새 필수 필드가 없는 구형 Admin release는 gateway 계약 검증에서 거절되므로 운영 도입 시 승인된 Canonical 저장 및 Admin release 재생성을 먼저 검증해야 한다.


### F04 정본 정렬 — 2026-10-04 (로컬 구현)

- 기준 revision: Data `fd252b2508d4ccda5ecf8de03b587c1f9910cda4`; ERP4 로컬 `origin/main` `cd4a6686f3828d3370cf14dc77c15b8aaacca571`. Git fetch·쓰기, Google/Firestore 접속 없음. 원본 JSON·메모는 저장소에 복사하지 않았다.
- 정본: 사용자 제공 F04 `수수료표!A1:M191` 2026-10-04 읽음. 구버전 탭/엔진차이/탭수정안보다 최신 JSON을 우선한다. policyId `sales-commission-2026-10-04`; `KAKAO_COMMISSION_POLICY_2026_10_03`에 이전 규칙 보존. `sourceRefs`에 적용 F04 행을 기록한다.
- 우선순위: 마음카 제외 → 입력 검사 → 개별 계약 근거 → 픽업·전기차 등 특칙 → 일반 규칙. 아이카 전기차는 재렌트 또는 신차 선출고에만 적용; 구독·매칭은 제외한다. ERP4 `feeKindOf`의 견적출고 우선 분류를 따르며 모델명으로 연료를 추측하거나 알 수 없는 상품을 재렌트로 기본 분류하지 않는다.
- 오토플러스 전기차 구독 150만/130만(161행); 일반 구독 100만/80만. 연료 누락은 `FUEL_REQUIRED_FOR_SUPPLIER_RULE`. 손오공 픽업은 차량가액×4%/3%(190행); 빌린카/엘씨 구독은 60개월에만 대여료×60×2.25%/1.75%(162행).
- 입력 정규화: `선출고` → 신차/NEW_PREDELIVERY, `견적출고` → 신차/NEW_MATCHING, `장기렌트` → 재렌트. 명시 subtype과 표현이 충돌하면 `CONFLICTING_NEW_PRODUCT_SUBTYPE`.
- 카탈로그 입력: `buildKakaoCatalogReference`의 `commissionEvidenceByProduct[productId][원본 priceKey]` → `buildKakaoCatalogReferenceProduct`의 세 번째 인자 `evidenceByTerm` → 양쪽 resolver. 차량가액, Q12+출처, 구독 형태, 신차 subtype, 계약 보증금 등급과 개별 근거를 전달한다. `precomputeOfferEconomics`도 동일 근거 타입을 받는다. 이 경로는 신뢰된 비공개 호출자 전용이며 원천 JSON의 임의 필드·월료·보증금으로 근거를 만들지 않는다. 기존 자동 Canonical 저장 호출에는 근거 수집이 없으므로 해당 값 부재는 여전히 UNKNOWN이다. 운영 수집 연결 완료가 아니다.
- 개별 근거: `individualExceptionEvidence = { sourceRow, status, contractRef, matchedContractRef, ledgerRow }`. 비공개 호출자가 원장 계약과 일치시킨 **opaque 토큰**(`opaque:` + 16자 이상 영문/숫자/밑줄/하이픈)을 양쪽 ref에 전달한다. 서버가 일치·승인을 검증해야 하며 이 순수 함수는 승인 인증 수단이 아니다. 공개 저장소에 차량번호·실제 계약 토큰을 넣지 않는다. 단순 차량번호 SHA256은 열거 가능하므로 비공개 랜덤 계약 ID 또는 비밀키 HMAC을 권장한다. 원장 행 번호만으로 자동 매칭하지 않는다.
- 160행/원장413 + APPROVED + 손오공 구독60: 최신 사본의 청구 **862,000**, 지급 **562,000**. 옛 수정안 912,000은 사용하지 않는다. 163행/원장466·473·474·475 + PAYOUT_CONFIRMED + 아이카 선출고: 지급400,000; 청구는 차량가액을 주더라도 `INDIVIDUAL_BILLING_BASIS_UNCONFIRMED`. 미확정 상태·범위 불일치·토큰 불일치는 UNKNOWN.
- 판단 차이: 제공 JSON 14행은 +60만/판단 확정으로 바뀌었지만 사용자 최신 지시는 일반 60개월 충돌 UNKNOWN 유지다. 양쪽 `SONOKONG_60_ADDITION_CONFLICT`로 둔다. 160행의 승인된 개별 계약만 예외다. Q12 정상가/할인가 선택은 추측하지 않으며 명시 근거가 없으면 `Q12_BASIS_REQUIRED`; 24개월 이상 반납형은 UNKNOWN이다.
- 169~170행 뮤카는 최신 사본에 상세 값이 확정되어 있으나 이번 1~8 구현 범위 밖이고 엔진 공급사 ID·지급 재원/VAT 계약 미연결이다. **다름/HOLD**로 남긴다. 프리패스 1%와 GA 금액을 이 엔진의 청구-지급 마진으로 임의 계산하지 않는다.
- 미확정 공급사 AMR·오토셀렉션·금탑·빌림·퍼스트·SK는 로컬 근거에서 확정 ID를 찾지 못했다. 이름을 임의 표준 ID로 연결하지 않으며 미등록 ID는 `SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE`이다. 웰릭스 발주는 `WELRIX_ORDER_RULE_UNCONFIRMED`, 기타 미확정 구독은 `SUBSCRIPTION_RULE_SCOPE_UNCONFIRMED`, 기간 누락은 `TERM_NOT_IN_F04_COMMISSION_POLICY`.
- 검증/운영 경계: 로컬 검사만. 저장된 기존 economics 자동 재작성, 배포, 지급 승인 없음. Claude 독립 검토 호출은 `FAILED / CLAUDE_PROCESS_FAILED`(exit 1)이며 검토 완료로 세지 않는다. Claude 오더자가 diff/검사 후 커밋한다.

#### 최종 로컬 검증 기록

- `npm run check`: exit **1**, 전체 PASS 아님. 아키텍처·규격·데이터 접근 경계·빌드 PASS; Node 검사 **109/109 PASS**; Vitest **1305 PASS / 9 FAIL / 14 SKIP**, 119파일(111 PASS/4 FAIL/4 SKIP).
- 실패9건: iancar-source-capture CLI2, read-pilot CLI4, runtime-policy2, vehicle-finder-route1. `node --import tsx -e ...` 단독 호출도 `uv_os_get_passwd ENOMEM`으로 실패하여 앱 코드 이전 환경 오류를 재현했다. `bash -c 'jq --version'`도 `Permission denied`; Finder는 tsx로 서버가 뜨지 않아 `ECONNREFUSED`. 보안 설정·의존성·다른 기능 코드를 바꾸어 우회하지 않았다.
- 별도 집중검사: 수수료/Canonical/저장변경/Kakao gateway **5파일128 PASS**. 표준/특칙·입력 불변·미확정 보존·예외 범위/상태·행 참조 검증 포함. 이전 정책 객체 원문 보존 및 191행 대응표의 누락·중복0 확인.
- 최종 전체 로그: 로컬 임시 경로 `C:/Users/admin/AppData/Local/Temp/commission-f04-check-final.log`. skipped14는 기존 emulator/workflow 조건부 검사이며 PASS로 세지 않는다. 운영 접속·배포·커밋 없음.

#### 표준 공급사 15곳 ↔ standardSupplierIds 19개

근거: Data `contracts/supplier-input-sheet-spec.v1.json:supplierChannels`; ERP4 위 origin/main의 `inventory-source-registry.ts`, `partner-ci.ts`, `partner-code.ts`(렌트존), `scripts/cleanup-partners.mts`(J&J). 운영 거래처 명부의 현재 활성 여부는 조회하지 않았다. 15곳=18개 ID, 나머지 1개는 아이언(별도 특칙)이다. 이름 중복이 있어도 ID를 합치거나 삭제하지 않는다.

| F04 실명 | standardSupplierIds | 탭 행 / 판정 |
|---|---|---|
| 웰릭스 | RP013 | 15~21 |
| 이안카 | RP031 | 22~28; 아이카 RP004와 별개 |
| 경진카 | RP016 | 29~35 |
| 경진렌트카 | RP015 | 36~42 |
| 에이스 | RP019 | 43~49 |
| 우리캐피탈렌터카 | RP020 | 50~56; 공동 시트 우리캐피탈 |
| 에코렌터카 | RP032 | 57~63; 공동 시트 에코 |
| SA | PT-0023 | 64~70; 공동 시트 에스에이 |
| 센트로 | RP017 | 71~77 |
| 연카 | RP011 | 78~84 |
| 빌린카(LC) | RP021, PT-0026 | 85~91; 빌린카·엘씨 |
| KH | RP010 | 92~98 |
| J&J | RP030, PT-0012 | 99~105; 구 ID 보존, 현 활성 여부 미조회 |
| 리더스 | RP008 | 106~112 |
| 렌트존 | PT-0001, RP007 | 113~119; 복수 ID 보존 |
| 표준 15곳 외: 아이언 | RP006 | 139~145; 신차 청구4% 특칙 |

#### F04 191행 ↔ 엔진 규칙 대응표

B=BILLING, P=PAYOUT, `{S}`=BILLING 또는 PAYOUT. 표준 재렌트 지급 ruleId는 12개월 `STANDARD_RERENT_12_FIXED`, 나머지 `STANDARD_RERENT_{기간}_RENT_X_TERM`; 청구는 `STANDARD_RERENT_{기간}_BILLING_FIXED/RENT_X_TERM`이다. `STANDARD_RERENT(t)`는 이 양쪽 ID를 뜻한다. UNKNOWN은 실제 `ruleId:null`이므로 괄호에 reasonCode를 적는다. ‘같음’은 산식/범위의 정렬이며 필수 입력 부재·171행 소수점은 UNKNOWN, 지급 시점 완료를 뜻하지 않는다.

| 탭 행 | 엔진 ruleId / 경로 | 같음·다름·UNKNOWN 유지(이유) |
|---:|---|---|
| 1 | `—` | 같음: 제목/헤더/빈 행, 계산 대상 아님 |
| 2 | `—` | 같음: 제목/헤더/빈 행, 계산 대상 아님 |
| 3 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 4 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 5 | `STANDARD_RERENT(12)` | 같음 |
| 6 | `STANDARD_RERENT(24)` | 같음 |
| 7 | `STANDARD_RERENT(36)` | 같음 |
| 8 | `STANDARD_RERENT(48)` | 같음 |
| 9 | `STANDARD_RERENT(60)` | 같음 |
| 10 | `SONOKONG_SUBSCRIPTION_12_{S}` | 같음: Q12 출처·형태 필수; 부재 UNKNOWN |
| 11 | `SONOKONG_SUBSCRIPTION_24_{S}` | 같음: Q12 출처·형태 필수; 부재 UNKNOWN |
| 12 | `SONOKONG_SUBSCRIPTION_36_{S}` | 같음: Q12 출처·형태 필수; 부재 UNKNOWN |
| 13 | `SONOKONG_SUBSCRIPTION_48_{S}` | 같음: Q12 출처·형태 필수; 부재 UNKNOWN |
| 14 | `null (SONOKONG_60_ADDITION_CONFLICT)` | UNKNOWN 유지: 사용자 최신 HOLD 지시 우선; 사본 +60만과 다름 |
| 15 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 16 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 17 | `STANDARD_RERENT(12)` | 같음 |
| 18 | `STANDARD_RERENT(24)` | 같음 |
| 19 | `STANDARD_RERENT(36)` | 같음 |
| 20 | `STANDARD_RERENT(48)` | 같음 |
| 21 | `STANDARD_RERENT(60)` | 같음 |
| 22 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 23 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 24 | `STANDARD_RERENT(12)` | 같음 |
| 25 | `STANDARD_RERENT(24)` | 같음 |
| 26 | `STANDARD_RERENT(36)` | 같음 |
| 27 | `STANDARD_RERENT(48)` | 같음 |
| 28 | `STANDARD_RERENT(60)` | 같음 |
| 29 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 30 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 31 | `STANDARD_RERENT(12)` | 같음 |
| 32 | `STANDARD_RERENT(24)` | 같음 |
| 33 | `STANDARD_RERENT(36)` | 같음 |
| 34 | `STANDARD_RERENT(48)` | 같음 |
| 35 | `STANDARD_RERENT(60)` | 같음 |
| 36 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 37 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 38 | `STANDARD_RERENT(12)` | 같음 |
| 39 | `STANDARD_RERENT(24)` | 같음 |
| 40 | `STANDARD_RERENT(36)` | 같음 |
| 41 | `STANDARD_RERENT(48)` | 같음 |
| 42 | `STANDARD_RERENT(60)` | 같음 |
| 43 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 44 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 45 | `STANDARD_RERENT(12)` | 같음 |
| 46 | `STANDARD_RERENT(24)` | 같음 |
| 47 | `STANDARD_RERENT(36)` | 같음 |
| 48 | `STANDARD_RERENT(48)` | 같음 |
| 49 | `STANDARD_RERENT(60)` | 같음 |
| 50 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 51 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 52 | `STANDARD_RERENT(12)` | 같음 |
| 53 | `STANDARD_RERENT(24)` | 같음 |
| 54 | `STANDARD_RERENT(36)` | 같음 |
| 55 | `STANDARD_RERENT(48)` | 같음 |
| 56 | `STANDARD_RERENT(60)` | 같음 |
| 57 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 58 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 59 | `STANDARD_RERENT(12)` | 같음 |
| 60 | `STANDARD_RERENT(24)` | 같음 |
| 61 | `STANDARD_RERENT(36)` | 같음 |
| 62 | `STANDARD_RERENT(48)` | 같음 |
| 63 | `STANDARD_RERENT(60)` | 같음 |
| 64 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 65 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 66 | `STANDARD_RERENT(12)` | 같음 |
| 67 | `STANDARD_RERENT(24)` | 같음 |
| 68 | `STANDARD_RERENT(36)` | 같음 |
| 69 | `STANDARD_RERENT(48)` | 같음 |
| 70 | `STANDARD_RERENT(60)` | 같음 |
| 71 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 72 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 73 | `STANDARD_RERENT(12)` | 같음 |
| 74 | `STANDARD_RERENT(24)` | 같음 |
| 75 | `STANDARD_RERENT(36)` | 같음 |
| 76 | `STANDARD_RERENT(48)` | 같음 |
| 77 | `STANDARD_RERENT(60)` | 같음 |
| 78 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 79 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 80 | `STANDARD_RERENT(12)` | 같음 |
| 81 | `STANDARD_RERENT(24)` | 같음 |
| 82 | `STANDARD_RERENT(36)` | 같음 |
| 83 | `STANDARD_RERENT(48)` | 같음 |
| 84 | `STANDARD_RERENT(60)` | 같음 |
| 85 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 86 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 87 | `STANDARD_RERENT(12)` | 같음 |
| 88 | `STANDARD_RERENT(24)` | 같음 |
| 89 | `STANDARD_RERENT(36)` | 같음 |
| 90 | `STANDARD_RERENT(48)` | 같음 |
| 91 | `STANDARD_RERENT(60)` | 같음 |
| 92 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 93 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 94 | `STANDARD_RERENT(12)` | 같음 |
| 95 | `STANDARD_RERENT(24)` | 같음 |
| 96 | `STANDARD_RERENT(36)` | 같음 |
| 97 | `STANDARD_RERENT(48)` | 같음 |
| 98 | `STANDARD_RERENT(60)` | 같음 |
| 99 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 100 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 101 | `STANDARD_RERENT(12)` | 같음 |
| 102 | `STANDARD_RERENT(24)` | 같음 |
| 103 | `STANDARD_RERENT(36)` | 같음 |
| 104 | `STANDARD_RERENT(48)` | 같음 |
| 105 | `STANDARD_RERENT(60)` | 같음 |
| 106 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 107 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 108 | `STANDARD_RERENT(12)` | 같음 |
| 109 | `STANDARD_RERENT(24)` | 같음 |
| 110 | `STANDARD_RERENT(36)` | 같음 |
| 111 | `STANDARD_RERENT(48)` | 같음 |
| 112 | `STANDARD_RERENT(60)` | 같음 |
| 113 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 114 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 115 | `STANDARD_RERENT(12)` | 같음 |
| 116 | `STANDARD_RERENT(24)` | 같음 |
| 117 | `STANDARD_RERENT(36)` | 같음 |
| 118 | `STANDARD_RERENT(48)` | 같음 |
| 119 | `STANDARD_RERENT(60)` | 같음 |
| 120 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 121 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 122 | `STAR_RERENT_ONE_MONTH_RENT_BILLING / STAR_RERENT_ONE_MONTH_RENT_X_80_PERCENT` | 같음: VAT 포함, 소수점 HOLD |
| 123 | `AUTOPLUS_SUBSCRIPTION_BILLING_FIXED / AUTOPLUS_SUBSCRIPTION_FIXED` | 같음: 일반 연료만, EV는161행 우선 |
| 124 | `SWITCH_SUBSCRIPTION_12_{S}_FIXED` | 같음 |
| 125 | `SWITCH_SUBSCRIPTION_24_{S}_RENT_X_TERM` | 같음 |
| 126 | `SWITCH_SUBSCRIPTION_36_{S}_RENT_X_TERM` | 같음 |
| 127 | `SWITCH_SUBSCRIPTION_48_{S}_RENT_X_TERM` | 같음 |
| 128 | `SWITCH_SUBSCRIPTION_60_{S}_RENT_X_TERM` | 같음 |
| 129 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 130 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 131 | `null (IANCAR_SHORT_TERM_BASIS_REQUIRED)` | UNKNOWN 유지: 기준액·연장 조건 필요 |
| 132 | `IANCAR_RERENT_6_MONTH_BILLING_FIXED / IANCAR_RERENT_6_MONTH_FIXED` | 같음 |
| 133 | `STANDARD_RERENT(12)` | 같음 |
| 134 | `STANDARD_RERENT(24)` | 같음 |
| 135 | `STANDARD_RERENT(36)` | 같음 |
| 136 | `STANDARD_RERENT(48)` | 같음 |
| 137 | `STANDARD_RERENT(60)` | 같음 |
| 138 | `IANCAR_EV_BILLING_FIXED / IANCAR_EV_FIXED` | 같음: 구독·매칭 제외 |
| 139 | `IRON_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 140 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 141 | `STANDARD_RERENT(12)` | 같음 |
| 142 | `STANDARD_RERENT(24)` | 같음 |
| 143 | `STANDARD_RERENT(36)` | 같음 |
| 144 | `STANDARD_RERENT(48)` | 같음 |
| 145 | `STANDARD_RERENT(60)` | 같음 |
| 146 | `PACIFIC_NEW_PREDELIVERY_{5/10}_{S}` | 같음: 명시 등급·차량가액 필요 |
| 147 | `PACIFIC_NEW_MATCHING_{5/10}_{S}` | 같음: 명시 등급·차량가액 필요 |
| 148 | `STANDARD_RERENT(12)` | 같음 |
| 149 | `STANDARD_RERENT(24)` | 같음 |
| 150 | `STANDARD_RERENT(36)` | 같음 |
| 151 | `STANDARD_RERENT(48)` | 같음 |
| 152 | `STANDARD_RERENT(60)` | 같음 |
| 153 | `—` | 같음: 제목/헤더/빈 행, 계산 대상 아님 |
| 154 | `—` | 같음: 제목/헤더/빈 행, 계산 대상 아님 |
| 155 | `—` | 같음: 제목/헤더/빈 행, 계산 대상 아님 |
| 156 | `timingRules.STAR_IANCAR` | 같음: 선언 보존, 시점 실행은 정산 경계 |
| 157 | `timingRules.OTHERS` | 같음: 선언 보존, 시점 실행은 정산 경계 |
| 158 | `timingRules.ALL.LUMP_SUM` | 같음: 선언 보존 |
| 159 | `timingRules.ALL.DEPOSIT_INSTALLMENT` | 같음: 선언 보존 |
| 160 | `F04_INDIVIDUAL_413_{S}` | 같음: 승인·계약 일치 필수, 최신 사본862000/562000 |
| 161 | `AUTOPLUS_EV_SUBSCRIPTION_{S}` | 같음:150만/130만 |
| 162 | `BILLIN_SUBSCRIPTION_60_{S}_RENT_X_TERM` | 같음:60개월만 |
| 163 | `F04_AICA_INDIVIDUAL_PAYOUT / null` | 같음: 지급40만; 청구UNKNOWN (INDIVIDUAL_BILLING_BASIS_UNCONFIRMED) |
| 164 | `null (WELRIX_ORDER_RULE_UNCONFIRMED)` | UNKNOWN 유지: 발주 근거 없음 |
| 165 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 166 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 167 | `STAR_RERENT_ONE_MONTH_RENT_BILLING / STAR_RERENT_ONE_MONTH_RENT_X_80_PERCENT` | 같음: VAT 포함, 소수점 HOLD |
| 168 | `null (SUPPLIER_EXCLUDED_BY_DECISION)` | 같음: NOT_APPLICABLE, 0원 아님 |
| 169 | `미구현` | 다름/HOLD: 뮤카 전용 재원·VAT·ID 계약, 이번 범위 밖 |
| 170 | `미구현` | 다름/HOLD: 뮤카 상세표 확정; 전용 계약 연결은 이번 범위 밖 |
| 171 | `null (WON_ROUNDING_POLICY_UNCONFIRMED)` | UNKNOWN 유지: 소수점 정책 미확정 |
| 172 | `null (DEPOSIT_TIER_REQUIRED)` | UNKNOWN 유지: 5/10 등급 외 |
| 173 | `null (RETURN_SUBSCRIPTION_TERM_NOT_SUPPORTED)` | UNKNOWN 유지: 60은 충돌 코드가 우선 |
| 174 | `null (SUBSCRIPTION_RULE_SCOPE_UNCONFIRMED)` | UNKNOWN 유지 |
| 175 | `null (SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE)` | UNKNOWN 유지: 스위치 신차 규칙 없음 |
| 176 | `null (SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE)` | UNKNOWN 유지: 스위치 재렌트 규칙 없음 |
| 177 | `null (SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE)` | UNKNOWN 유지: 실명-ID/수수료 근거 미확정 |
| 178 | `null (SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE)` | UNKNOWN 유지: 실명-ID/수수료 근거 미확정 |
| 179 | `null (SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE)` | UNKNOWN 유지: 실명-ID/수수료 근거 미확정 |
| 180 | `null (SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE)` | UNKNOWN 유지: 실명-ID/수수료 근거 미확정 |
| 181 | `null (SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE)` | UNKNOWN 유지: 실명-ID/수수료 근거 미확정 |
| 182 | `null (SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE)` | UNKNOWN 유지: 실명-ID/수수료 근거 미확정 |
| 183 | `null (TERM_NOT_IN_F04_COMMISSION_POLICY)` | UNKNOWN 유지: 미등재 20개월; 기간무관 특칙 제외 |
| 184 | `null (TERM_NOT_IN_F04_COMMISSION_POLICY)` | UNKNOWN 유지: 미등재 25개월; 기간무관 특칙 제외 |
| 185 | `null (TERM_NOT_IN_F04_COMMISSION_POLICY)` | UNKNOWN 유지: 미등재 26개월; 기간무관 특칙 제외 |
| 186 | `null (TERM_NOT_IN_F04_COMMISSION_POLICY)` | UNKNOWN 유지: 미등재 28개월; 기간무관 특칙 제외 |
| 187 | `null (TERM_NOT_IN_F04_COMMISSION_POLICY)` | UNKNOWN 유지: 미등재 33개월; 기간무관 특칙 제외 |
| 188 | `null (TERM_NOT_IN_F04_COMMISSION_POLICY)` | UNKNOWN 유지: 미등재 72개월; 기간무관 특칙 제외 |
| 189 | `null (TERM_NOT_IN_F04_COMMISSION_POLICY)` | UNKNOWN 유지: 미등재 84개월; 기간무관 특칙 제외 |
| 190 | `SONOKONG_PICKUP_{S}` | 같음: 차량가액4%/3% |
| 191 | `null (SONOKONG_60_ADDITION_CONFLICT)` | UNKNOWN 유지: 관측 실적을 일반 요율로 쓰지 않음 |

원본 제공 JSON SHA256: `3df6f812c95bfa2ad66dca224d2d9786e169b5a0e1ec06134105226a7302ee22` (내용 복사 없음).

## Consumer capabilities

Registration fields:

- `id`: `erp-com`, `kakao-ops`, `freepass-estimate`, `freepass-admin-catalog`, `whitelabel-<slug>`, or `internal-ai-<project-slug>`
- `projectionId`: currently only `erp-public`
- `token`: unique backend token, minimum 32 characters
- `capabilities`: optional

Capability rules:

- omitted `capabilities` => `["catalog"]`; `catalog-reference` must be granted explicitly to `kakao-ops`
- `catalog` => ERP public projection read
- `catalog-reference` => Kakao-only, typed `REFERENCE_ONLY` ERP5 facts; it never means Canonical ACTIVE
- `internal-ai-reference` => internal-project-only typed reference facts. Explicit capability required; no other capability may be combined. This identity cannot read raw compatibility, public catalog, customer/admin workflows or settlement ledgers.
- `catalog-health` => Catalog Data Health read
- health-only registration is allowed and does not grant catalog payload access

## Routes

### Catalog

`GET /v1/consumers/{consumerId}/catalog`

- 401 unauthenticated
- 403 authenticated but missing `catalog`
- 503 no trustworthy ACTIVE release
- 200 validated ERP public projection

### Catalog Data Health

`GET /v1/consumers/{consumerId}/catalog-health`

- 401 unauthenticated
- 403 authenticated but missing `catalog-health`
- 503 reader failure / schema failure
- 200 HEALTHY
- 200 DEGRADED
- 503 BLOCKED with the versioned Health report body

Both responses use `Cache-Control: no-store`.

### Kakao catalog reference

`GET /v1/consumers/kakao-ops/catalog-reference`

- only the separately registered `kakao-ops` identity may use it;
- projects current listable ERP5 products in memory without a Firestore write;
- materializes each period's deposit amount/rule/state, including explicit `ZERO` vs `UNKNOWN`;
- carries `vehicle.exteriorColor` from ERP5 `products.ext_color`;
- carries `vehiclePhotos` with ordered HTTPS `imageUrls`, `representativeUrl`, and supplementary
  `sourceLinkCount`. Supplementary folder URLs are not exposed because opaque folders may contain
  documents. `URLS_PRESENT` means URLs were supplied, not that every image was verified;
  `LINK_ONLY` means only a source link was supplied; `UNUSABLE` means evidence was rejected;
  `NOT_PROVIDED` means no photo evidence was supplied. `rejectedCount` exposes parsing/rejection,
  including partially usable records. `accessVerification=NOT_CHECKED` prevents a read from implying
  a network check. Document images (`doc_images`) are excluded. Consumers using a strict schema must update
  their schema before adopting this additive field; deployed older responses may omit it.
- returns the verified F80-F85 sales-commission policy snapshot and term-level calculated,
  coordination-required, unknown, or not-applicable result;
- always returns `authority=REFERENCE_ONLY` and `publicationDecision=HOLD`.

This route is an explicit migration bridge, not a silent fallback for `/catalog`. Kakao must opt into
the route and must not convert its response into a Canonical ACTIVE claim.

## Internal AI reference API — CODED/TESTED, deployment and grants HOLD

`GET /v1/consumers/internal-ai-<project-slug>/internal-ai-reference`

Register each approved internal project separately with a unique backend service token (minimum 32 characters), `projectionId=erp-public` (registration compatibility only) and exactly `capabilities=["internal-ai-reference"]`. The response projection is `internal-ai-reference`, schema `freepass-data.internal-ai-reference/v1`. No token is minted or deployed by this code change. Do not share an internal token with an external supplier/channel or put it in browser code/chat/repository. Internal AI sees typed product facts, both fee axes and margin reference; this is NOT the external channel's default payout-only view.

The endpoint reuses the existing product/commission projector with a distinct identity, schema, reader gate, read audit and `no-store`. It reads products only; arbitrary customer/contract/collection queries and writes are unsupported. It always returns `REFERENCE_ONLY`/`HOLD`: a source snapshot is not an approved ACTIVE release or permission to quote/send/write. A responding API is not proof of downstream deployment.

## Deposit evidence and visible labels — 2026-09-30 user decision

Numeric `0` without waiver evidence is never `ZERO`. RP012 and pickup products cannot be promoted to zero deposit. Explicit waiver with positive/invalid amounts, conflicting notes or missing supplier/product identity remains `UNKNOWN`. Positive ERP amounts for RP012 used rental are preserved; formula-backed subscription placeholders are not written over with invented values. Positive amounts carrying unresolved rule notes are held, not silently replaced by a formula.

Both reference APIs emit `priceTerms[].depositStatusLabel`: no amount/note input => `미입력`; unresolved 0/formula/conflict => `확인중`; proven waiver => `무보증`; resolved positive amount => `보증금 있음` (display the accompanying amount/rule). `UNKNOWN` has null numeric amount, never 0. Labels are display metadata, not monetary strings to write into numeric source fields. Keep known rule wording; don't label unsupported/nonexistent term columns as missing input.

The Canonical mapper preserves raw source evidence and emits UNKNOWN/HOLD for ambiguous deposit facts. Existing ERP/Sheet consumers must adopt the evidence/label contract, remove their own numeric-zero heuristic, and obtain authorized deployment/publication + live readback before ALL_CONSUMER completion.

## Storage boundary

The consumer projection reader exposes only projection reads.
The Data Health reader exposes only:

- VehicleModel / VehicleAsset / Product / Offer / Policy lists
- Revision History
- ACTIVE release / manifest / projection lineage
- atomic ACTIVE projection evidence snapshot

The Health reader exposes no `stage`, `activate`, `transact`, `put*`, or other write surface.

## Still required before live use

1. Merge/finalize Catalog Data Health baseline.
2. Run full integrated test suite on the clean runtime branch.
3. Run Firestore emulator integration tests.
4. Provision a read-only service identity/IAM policy for the deployed service.
5. Deploy the read runtime behind TLS/private service access.
6. Shadow-read against current consumer output and compare release identity/data.
7. Keep existing consumer path as rollback until shadow parity is accepted.

This runtime is not a consumer cutover authorization and does not prove Source freshness,
Source-to-Canonical parity, or a whole-Catalog atomic snapshot.
