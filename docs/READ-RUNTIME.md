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

`sourceRefs`는 KNOWN·ZERO 금액의 규칙·실사용 계산 근거만 담고 UNKNOWN·NOT_APPLICABLE이면 비운다. 가격 출처는 수수료·보증금 모두 별도 `priceSourceRefs`에 둔다.

**프리패스 수수료는 지급수수료(`channelPayoutFee`)다.** FreePass가 영업채널에 지급하는 금액이며, 공급사로부터 받는 청구수수료나 내부 마진을 뜻하지 않는다.

| 연동 대상 | 제공할 수수료 | 지급 방향 |
|---|---|---|
| 영업채널 / 기본 수수료 연동 | `channelPayoutFee` — 프리패스 수수료 | FreePass → 해당 영업채널 |
| 공급사 | `supplierBillingFee` — 공급사 청구수수료 | 해당 공급사 → FreePass |

`src/domain/catalog.ts`의 `COMMISSION_CONSUMER_POLICY`와 `projectCounterpartyCommission`이 이름과 선택 규칙의 실행 정본이다. 두 외부용 projection은 상대편 수수료, 마진, 내부 산식·원천 참조를 포함하지 않는다. 미확정은 `UNKNOWN`/null, 명시적 0원은 `ZERO`/0이며 기간별 값을 유지한다.

이 helper는 **PREPARED** 상태다. 신규 공급사/영업채널 API와 운영 등록은 아직 연결되지 않았다. 운영 API에 연결할 때 audience와 공급사/영업채널 ID 범위는 서버가 등록된 전용키의 grant에서 결정해야 한다. 요청의 query/body로 audience를 바꾸거나 다른 공급사·채널을 조회할 수 있게 만들지 않는다. 상대별 계약조건이 다르면 해당 조건을 조회하고, 없으면 공통 기준을 확정 지급액으로 간주하지 않고 HOLD한다.

기존 Kakao `catalog-reference`는 내부 업무용으로 양쪽 수수료와 예상 마진을 포함하는 별도 계약이다. 이 응답과 키를 외부 공급사/영업채널에 전달하지 않는다. 현재 public ERP/화이트라벨 projection에는 내부 수수료를 추가하지 않는다. 외부 연동 완료는 전용 계약·scope 차단 테스트·인증된 운영 readback 이후에만 선언한다.

### 기존 Offer 일괄 재계산 — PR1 (2026-10-04)

`src/jobs/recompute-offer-economics.ts`는 기본 dry-run이다. `listOffers()`와 기존
`precomputeOfferEconomics`를 조합하며 거래·파일·감사 로그·outbox·Admin projection을 쓰지 않는다.
공급사별 상품/기간 수, 청구·지급 각각 전후 KNOWN/ZERO/UNKNOWN/NOT_APPLICABLE,
변경 기간(금액/state/policyId/sourceRefs/reasonCode), UNKNOWN 사유 빈도와 검토용 plan을 JSON으로 출력한다.
기간은 전후 termKey 합집합이고 저장값 누락은 UNKNOWN/NOT_STORED로 집계한다. 변경 항목 수는
서로 중복될 수 있으며 `any`는 기간당 한 번이다. `unknownReasons`는 전후·청구/지급을 구분한 전체 빈도순이다.
plan에는 원본 Offer 전체(before-image), Offer revision, Product/Model을 포함한 입력 digest,
정책 ID와 정책 내용 digest, 대상 프로젝트가 고정된다. 내부 금액을 포함하므로 비공개로 보관한다.

로컬 메모리 확인(자격증명 불필요):

```powershell
npm.cmd run build
node dist/src/jobs/recompute-offer-economics.js --memory
```

운영 절차는 **dry-run → 승인 → apply → Admin 재발행 → Admin 응답 집계 확인** 순서다.
이번 PR은 코드·메모리 시험만이며 운영 실행/재발행 승인이 아니다.

1. 별도 승인된 읽기 환경에서 `FIREBASE_PROJECT_ID`를 명시하고 `--firestore`로 dry-run한다.
   기존 bootstrap → `createFirestoreDataStore` → `firebase-target.ts`만 사용한다.
   dry-run은 gateway 감사 쓰기도 수행하지 않는다. 기본 앱/ADC에서 대상을 추정하지 않는다.
2. 전체 JSON의 `plan` 객체를 비공개 파일로 보존하고 `planDigest`와 집계·UNKNOWN을 검토한다.
   실행 revision, 프로젝트, 공급사/Offer 범위, 정책 `sales-commission-2026-10-04`, 변경 수,
   before-image 보관, writer 소유권 및 중단/복구 계획을 고정해 운영 apply 승인을 받는다.
3. 승인 후에만 아래 형식으로 실행한다(이 PR에서는 운영 실행하지 않음).

   ```powershell
   node dist/src/jobs/recompute-offer-economics.js --firestore --apply --plan <비공개-plan.json> --policy-id sales-commission-2026-10-04 --expected-plan-digest <승인된-planDigest>
   ```

   파일에는 보고서 전체가 아닌 `plan` 객체를 넣는다. `--apply` 이외 경로는 쓰지 않는다.
   거래 안에서 writer·멱등키·expectedRevision·Product/Model 입력을 다시 확인하며,
   변화가 있는 Offer만 revision/history/audit/outbox/receipt를 원자적으로 저장한다.
   감사 action은 가격 변경과 별개인 `RECOMPUTE_OFFER_ECONOMICS`; 감사의 `before`가 원자적 before-image다.
   소유권 기록 누락도 HOLD다. 입력 누락은 0으로 보정하지 않는다.
   같은 plan 재실행은 receipt로 중복 쓰기를 막고, 새 plan의 동일 결과도 쓰지 않는다.
   첫 충돌/오류에서 HOLD로 중단하고 앞서 완료한 건수와 미처리 건수를 보고한다.
   전체 배치는 단일 거래가 아니다. revision을 자동 갱신해 재시도하지 않는다.
4. 다음 PR에서 별도 승인 아래 `buildAdminCatalogProjection`으로 검증된 READY 릴리스를 만들고
   활성화한다. 이 job은 dry-run/apply 모두 projection 생성·활성화·outbox worker 실행을 하지 않는다.
   이미 실행 중인 worker가 `catalog.offer.changed`를 소비할 수 있으므로 운영 apply 전 그 영향도 확인한다.
5. 인증된 Admin 응답에서 공급사·기간별 청구/지급 상태와 금액, UNKNOWN 사유 및 릴리스/정책을
   원본·apply 결과와 대사한다. 코드 시험은 운영 저장/발행/소비 확인을 대신하지 않는다.

복구는 층별로 구분한다. **코드 revert**는 새 실행을 중단할 뿐 이미 저장한 금액을 되돌리지 않는다.
Canonical 복구는 비공개 plan 및 원자적 감사 before-image와 현재 revision을 대조한 **보상 거래**로 한다
(후속 PR/별도 승인; raw overwrite 및 revision 감소 금지). 소비처 복구는 검증된
**이전 READY 릴리스 재활성화**로 하며 Canonical 복구와 별개다. 셋 모두 대상·영향을 재확인한다.

### Admin 내부 기간별 경제조건 — 2026-10-03

Canonical `catalog_offers.internalEconomicsTerms`는 신규 canonicalization, 승인된 원천 Offer 변경, 가격 변경의 기존 CatalogStore 거래 안에서 다시 계산한다. `precomputeOfferEconomics`는 `sales-commission-2026-10-04`의 공통 resolver를 재사용한다. 09-28 정책 및 ERP `settlement-fee-table.ts@f862d0097f6e83d79d0b699bc369a83716b1d982`는 이전 근거로 보존하고, 현재 정본은 아래 10-04 F04 제공 사본이며 10-03 정책 객체는 과거 규칙으로 보존한다. 대여료·보증금은 `priceTerms`에서 복사하며 별도 `internalPeriodFees` 저장소는 없다. 수수료는 계약 전체 1건의 VAT 별도 공급가액이고 `calculation`, `sourceRefs`, `ruleId`, `policyId`, `vatTreatment`, `vatAmount`, `totalAmount`를 보존한다. Offer의 기존 `policyId`(상품 정책)와 수수료의 `policyId`(규칙 묶음)는 다르다.

Admin 전용 `data[].offers[].priceTerms[].supplierBillingFee` / `channelPayoutFee`만 양쪽 금액을 제공한다. Admin은 FreePass 내부 계약접수 주체이므로 외부 공급사/영업채널의 상대편 수수료 제외 규칙과 구분한다. 서버의 `freepass-admin-catalog` 전용 등록·키 제한을 유지하고 public ERP·화이트라벨·Kakao 응답에는 이번 필드를 추가하지 않는다. Admin projection은 저장된 값만 읽고 누락·중복·무효·가격/기간 불일치를 UNKNOWN으로 내린다. Admin에서 재계산하지 않는다.

`meta.economicsTermCounts.{supplierBillingFee,channelPayoutFee}.{KNOWN,ZERO,UNKNOWN,NOT_APPLICABLE}`는 각 수수료별 기간 행 수다. `meta.economicsCoverage`는 빈 기간 목록 또는 한쪽 UNKNOWN이 있으면 INCOMPLETE, 나머지는 COMPLETE다. 릴리스의 `economics`에도 저장하고 gateway는 검증된 release data로 다시 집계한다. Health `checks.offerEconomics`에도 같은 지표를 쓰되 분모는 전체 Canonical Offer의 기간이며 Admin ACTIVE 대상과 다를 수 있다. COMPLETE는 지급 확정·정산 완료·원천 최신성 확인을 뜻하지 않는다.

#### 수수료 연동 기준

- 스타 RP018·스카이 RP033 재렌트: 월료 100% 청구·80% 지급, VAT 포함. 공급사 ID는 유지하고 규칙만 공유한다. 신차는 이 특칙에 포함하지 않는다.
- 퍼시픽 RP022 신차: `vehicleValue` × 요율. `newProductSubtype`은 `NEW_PREDELIVERY`/`NEW_MATCHING`, `depositTierPercent`는 계약상 5/10이다. 선출고 청구/지급은 5% 등급 3%/2.5%, 10% 등급 4%/3%; 매칭은 3%/3%, 3.3%/3.3%. 모두 VAT 포함. 등급 없으면 `DEPOSIT_TIER_REQUIRED`이며 보증금 금액으로 추정하지 않는다. 재렌트는 표준, VAT 별도다.
- 원 단위 반올림은 F04 접수 실제 관행으로 확정(2026-10-04 AI 상황실, 근거 원장 줄은 비공개 기록): VAT 포함 금액 ÷ 1.1 → 원 단위 반올림이 공급가, VAT = 총액 − 공급가. 산식 금액과 VAT 별도 VAT(공급가÷10)도 원 단위 반올림. 마진은 공급가끼리 차감한다.
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
- 개별 합의: `individualAgreement = { agreementId, sourceRow(160|163), status, contractRef, matchedContractRef, billing, payout }`. 금액·대상 계약은 공개 저장소에 두지 않고, 신뢰된 비공개 호출자가 비공개 목록(ai-ops 인수인계)의 합의를 이 계약에 묶어 넘긴다. `agreementId` 는 `private:` + 4자 이상, 계약 토큰은 **opaque**(`opaque:` + 16자 이상)로 양쪽이 같아야 한다. 이 순수 함수는 승인 인증 수단이 아니며 서버가 일치·승인을 검증해야 한다. 차량번호·실제 계약 토큰·원장 행을 넣지 않는다(단순 차량번호 SHA256 은 열거 가능 — 비공개 랜덤 ID 또는 비밀키 HMAC 권장).
- 상태: `APPROVED` = 청구·지급 모두 합의 금액(`INDIVIDUAL_AGREEMENT_{S}`), `PAYOUT_CONFIRMED` = 지급만(청구는 `INDIVIDUAL_BILLING_BASIS_UNCONFIRMED`), `UNCONFIRMED`·금액 null = 미확정. 같은 입력이면 같은 금액. 개별 표시(`individualException`)만 있고 합의 입력이 없으면 일반 규칙을 쓰지 않고 `INDIVIDUAL_EXCEPTION_EVIDENCE_REQUIRED`. (2026-10-05 정리: 예전엔 엔진에 원장 행·합의 금액을 상수로 두었다 — 비공개 입력으로 옮김.)
- **2026-10-05 AI 상황실 결정(정책 `sales-commission-2026-10-05`)**: 손오공 오공 구독 60개월 청구 가산 = **+600,000**(14행), 지급은 Q12. 원 단위는 **원 미만 반올림**. 근거(실제 청구 줄 대조)는 비공개 ai-ops 인수인계(정산-수수료규칙-20261005)에 있다 — 공개 문서에는 원장 행·개별 금액을 적지 않는다. (옛 판단: 일반 60개월 충돌 UNKNOWN — 폐기.) 이전 정책으로 저장된 기간별 수수료는 그 정책 ID 그대로 남고, 새 정책 값은 명시적 재계산(일괄 재계산 작업·새 적재) 때만 바뀐다.
- **169~170행 뮤카(2026-10-05 구현, 공급사 RP035 — freepass-data #365 발급)**: freepass-admin DEC-2026-10-04-01 8번대로. 청구(프리패스 몫) `MEWCAR_FREEPASS_SHARE_BILLING` = 차량 기준가 × 1%(전 기간). 지급(영업 GA) `MEWCAR_GA_{PREPAID|INSTALLMENT}_{12|24|36|48}_PAYOUT` = 선납 12개월 100만·24~48개월 120만 / 분납 12개월 80만·24~48개월 100만(★2026-10-05 폐지: 계약일 `contractDate` 가 효력일 2026-10-05 이후인 신규 분납 계약은 계산하지 않고 `MEWCAR_INSTALLMENT_ABOLISHED_CONFIRM_REQUIRED`(확인 필요)로 멈춘다, 계약일을 모르면 `MEWCAR_CONTRACT_DATE_REQUIRED`, 그 전 계약은 옛 정액) + min(추가보증금 × 10%, 40만). 선납/분납(`depositPayment`)·추가보증금(`extraDeposit`, 없으면 0 명시)·기준가를 모르면 계산하지 않음(사유 `MEWCAR_*`). 별도 지급 재원이라 예상 마진은 `NOT_APPLICABLE`(`SEPARATE_FUNDING_NO_MARGIN`). 공급가(VAT 별도) 기준 — VAT·원천세 처리 근거는 지급 단계에서. «분납 완납 전 미지급»은 계약 단계 지급 가능 상태(`payoutEligibility`)로 다룬다.
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
| 14 | `SONOKONG_SUBSCRIPTION_60_{S}` | 같음(2026-10-05 결정): 청구 Q12+60만, 지급 Q12; Q12 출처·형태 필수 |
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
| 160 | `INDIVIDUAL_AGREEMENT_{S}` | 같음: 비공개 합의 입력(APPROVED·계약 일치) 금액 그대로 |
| 161 | `AUTOPLUS_EV_SUBSCRIPTION_{S}` | 같음:150만/130만 |
| 162 | `BILLIN_SUBSCRIPTION_60_{S}_RENT_X_TERM` | 같음:60개월만. 다른 기간 구독은 `SUBSCRIPTION_RULE_SCOPE_UNCONFIRMED`(표준 재렌트로 흘리지 않음) |
| 163 | `INDIVIDUAL_AGREEMENT_PAYOUT / null` | 같음: 비공개 합의 입력(PAYOUT_CONFIRMED) 지급만; 청구UNKNOWN (INDIVIDUAL_BILLING_BASIS_UNCONFIRMED) |
| 164 | `null (WELRIX_ORDER_RULE_UNCONFIRMED)` | UNKNOWN 유지: 발주 근거 없음 |
| 165 | `STANDARD_NEW_PREDELIVERY_{S}` | 같음: 차량가액 필요 |
| 166 | `null (MATCHING_AGREED_RATE_REQUIRED)` | UNKNOWN 유지: 개별 합의율 필요 |
| 167 | `STAR_RERENT_ONE_MONTH_RENT_BILLING / STAR_RERENT_ONE_MONTH_RENT_X_80_PERCENT` | 같음: VAT 포함, 소수점 HOLD |
| 168 | `null (SUPPLIER_EXCLUDED_BY_DECISION)` | 같음: NOT_APPLICABLE, 0원 아님 |
| 169 | `MEWCAR_FREEPASS_SHARE_BILLING` / `MEWCAR_GA_*_PAYOUT` | 같음(2026-10-05): 170행 표로 계산, 마진 없음 |
| 170 | `MEWCAR_GA_{PREPAID\|INSTALLMENT}_{기간}_PAYOUT` | 같음(2026-10-05): 선납·분납 × 기간 + 추가보증금 가산; 입력 부재 UNKNOWN |
| 171 | 반올림 규칙(계산 단계) | 확정: F04 접수 관행 VAT 포함 ÷1.1 원 단위 반올림(근거 원장 줄은 비공개 기록) |
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

### F04 접수 탭 AE·AJ 투영 — 시험 실행 계획기 (2026-10-05, 쓰기 없음)

AI 상황실 결정(10-05 ㉢): F04 정산원장 «접수» 탭의 AE 판매수수료(공급사 청구)·AJ 출고수수료(영업채널 지급)를 이 엔진의 투영으로 채운다. 요구사항 원문은 비공개 ai-ops 인수인계(정산-수수료규칙-20261005/AE-AJ-투영쓰기-요구사항.md). 지금 단계는 **계획만** 만든다 — `src/application/f04-commission-projection.ts`(순수) · `src/jobs/plan-f04-commission-projection.ts`(로컬 입력 → 비공개 계획 파일, 공개 출력은 개수만).

- 채움: 확정(CALCULATED, 0 은 ZERO)만, 빈칸에만. 미확정은 빈칸 + 엔진 사유(0 금지). 공급가(VAT 별도).
- 덮지 않음: 값이 있는 AE·AJ 와 다르면, 또는 사람이 적은 청구액(U)·지급액(V)과 다르면 «차이 목록».
- 건드리지 않음: 취소 · 청구 TRUE · 닫힌 청구월(`--open-from` 보다 앞). 닫힌 줄의 값이 계산과 다르면 `closedDiffs`(사람 확인용).
- 회차청구 탭에 다음 회차가 있는 계약(차량번호 + 원 접수행)은 AE 를 쓰지 않음(이중 청구). 없으면 계약 전체.
- 비고 합의·정정 표시는 그 축만 보호: 하허호·F80·출고수수료·지급 말만 있으면 AJ, 청구·판매수수료·공급사 정산서 말만 있으면 AE, 둘 다·모르면 둘 다.
- VAT 포함 규칙(스타·스카이): 엔진 공급가(VAT 포함 ÷1.1, 원 미만 반올림 — AI 상황실 2026-10-05 결정, 원장 관행은 비공개 기록 참조).
- 연료는 프리패스 데이터 `products/<차량번호>.fuel_type` 에서(오토플러스 구독·아이카 EV 규칙). 없으면 빈칸. 공급사 이름 → 코드는 `F04_SUPPLIER_CODES`(정본 이름표 + F04 별칭, 스타스카이는 엔진상 스타·스카이 같은 규칙). 모르는 이름(AMR 등)은 빈칸.
- 열쇠 = 차량번호 + 접수일, 겹치면 판독 실패로 건드리지 않음. AE·AJ 칸 위치(31·36번째)가 바뀌면 멈춤.
- 실측 숫자(채울 칸·차이·빈칸 사유별)는 운영 집계라 이 공개 문서에 두지 않는다 — 비공개 ai-ops 인수인계에.
- 빈칸·글자 값은 0 이 아니라 «모름». 청구년·청구월이 둘 다 빈칸이면 열린 줄, 하나만 있거나 숫자로 못 읽으면 건드리지 않음. 개별 합의(비공개 개별 합의 계약 목록, 또는 비고 «개별»)는 일반 금액을 제안하지 않음. 입력은 두 탭을 A1 부터 시트 마지막 행까지 읽은 것만(`--grid-meta`). 개별 합의 계약 목록(차량번호|접수일, 비공개 ai-ops 인수인계)은 필수(`--individual`) — 행이 옮겨져도 계약으로 보호. 회차청구에 같은 차량번호가 있는데 원 접수행이 이 줄이 아니거나 못 읽으면 AE 는 «연결 불명»으로 쓰지 않음. 같은 접수 범위를 FORMULA 로도 읽어(`--from-batchget-formula`) AE·AJ 가 수식 칸이면 빈 글자를 돌려줘도 채우지 않음(두 읽기의 범위·줄·차량번호가 다르면 멈춤). 두 읽기 모두 그 칸이 비었을 때만 채움 후보 — 사이에 사람이 적은 값은 대조(같음·차이)만. 접수일은 일련번호·날짜 글자 모두 YYYY-MM-DD 로 맞춰 개별 합의 열쇠와 비교.
- 남음(HOLD): 시트 쓰기(백업 → 쓰기 → 되읽기 → 이력) — AI 상황실 10-05 결정: 승인된 계획을 운영자 PC 에서 상황실이 적용(접수 탭 보호 범위의 허용 계정, 보호는 풀지 않음). 계약별 수수료 저장 = 기존 `settlement_rows` 의 계산 칸(상황실 10-05 (A), BUSINESS-DATA-CONNECTION-MAP).

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

## 2026-10-09 기간 금액 수정·저장·조회 실행 경로

- 계산 정본: `KAKAO_COMMISSION_POLICY` 및 Commercial Data Catalog 최신 대표 확정. 새 정책은 code/contract 검사를 통과한 revision으로 고정한다. 현재 확정 정책은 `sales-commission-2026-10-09`.
- 가격·보증금 정정은 기존 `UPDATE_OFFER_PRICE`의 expectedRevision/idempotency 경로를 쓴다. 사람 입력 원본과 과거 계약 정산은 자동 덮어쓰지 않는다.
- 정책 정정은 아래 dry-run → reviewed plan apply를 쓴다. plan에는 모든 Offer before-image/inputDigest가 포함된다. 저장 변경은 CatalogStore 거래의 revision/audit/history/outbox/receipt로 남는다.
- apply는 각 상품을 새로 getOffer 해서 가격 불변과 정책 재계산 결과를 대조한다. `readbackVerifiedOffers === processedOffers`이고 status APPLIED여야 저장 검증 성공이다. PERSISTENCE_READBACK_MISMATCH면 부분 커밋 건수를 남기고 HOLD로 중단한다.
- 빌린카 LC는 referenceRentBasis에36개월 termKey·월료·100%/80% 배율을 보존한다. 별도 감사가 가격행/월료/통화/배율/금액을 다시 검증한다. 기준36개월 가격 수정 후 재계산하면 다른 기간 수수료도 바뀐다.
- 중앙 정본은 `catalog_offers.priceTerms/internalEconomicsTerms`. 모든 기간의 금액 또는 UNKNOWN/null/사유를 함께 둔다. 차량 번호 유무는 상품 식별자를 대체하지 않는다. 등록되지 않은 원천 상품을 저장했다고 확대하지 않는다.
- Kakao/internal AI 외부 조회: 기존 인증된 `/v1/consumers/:consumerId/catalog-reference` 및 `/v1/consumers/:consumerId/internal-ai-reference` 경로. Admin 저장값은 검증된 admin-catalog 릴리스 발행 뒤 별도 응답을 대사한다. 모든 소비처는 기존 grant를 유지하며 내부 청구수수료를 공개 화이트라벨에 노출하지 않는다.
- main 반영 및 consumer schema 배포 전에 새 referenceRentBasis 저장을 운영 실행하지 않는다. 운영 read runtime과 Admin 계약이 새 필드를 받는 것을 확인한 뒤 apply/재발행/조회 대사를 진행한다.

```powershell
$env:FIREBASE_PROJECT_ID='freepasserp5'
$env:NODE_ENV='production'
node --import tsx src/jobs/recompute-offer-economics.ts --firestore
# JSON 보고서의 plan만 비공개 UTF-8 파일로 보존하고 실제 planDigest를 고정한다.
node --import tsx src/jobs/recompute-offer-economics.ts --firestore --apply --plan <비공개-plan.json> --policy-id sales-commission-2026-10-09 --expected-plan-digest <검토한-planDigest>
```
### 정산 원장과 상품 기준표의 금액 의미

상품 기간별 수수료는 계약 전 기준 계산액이다. 같은 settlement_rows 문서의 접수 기록액(sourceReceiptClaim/Pay), 사람 입력액(claimWritten/payWritten), 계산액, 공급사·채널 확인 확정액, 증빙 있는 실입출금은 서로 다른 사실이다. 2026-10-09 새 조회에서도9월34개 동일ID의 청구 차이3,934,879원/지급차이0원이 재현됐다. sourceReceipt* VAT/Gross가 있다고 모든 계약이 공급사 확정됐다는 뜻은 아니다. 사람이 넣은 금액/근거를 상품 엔진 재계산으로 덮어쓰지 않는다. 계산액/확정액/공급가·VAT·합계/실입출금 증빙/처리자/업무일/변경이력 구분은 기존 PR399 정산 작업선과 연결하며, 현재 누락은 null/상태로 유지하고 영업자나 작성 시각으로 처리자를 발명하지 않는다.
### 2026-10-09 정산 조회 opt-in v2

기존 POST `/v1/consumers/:consumerId/settlement-ledger/read`에 `viewVersion: 2`를 전달한다. 생략/1은 기존 v1 응답이며 v1 schema와 금액 의미는 그대로다. 기존 settlement-ledger-read 인증·권한·감사 경로만 재사용하며 쓰기는 없다.

- reconciliation: 접수 기록/sourceReceipt 공급가·VAT·합계, 사람 입력, 명시적으로 저장된 계산액·확정액을 구분한다. 없는 계산액/확정액/VAT는 null; 상태나 수수료율로 추정하지 않는다.
- cash: 행의 수금/지급 projection과 settlementCashEvents의 불변 거래를 따로 제공한다. 거래의 code/axis/kind/amount/day/by/createdAt만 노출하고 원문 전체를 반환하지 않는다. 은행 대사 검증은 RECORDED_UNVERIFIED다.
- audit: createdBy/updatedBy/businessDate는 해당 필드만 사용하고 영업담당을 작성자로 바꾸지 않는다. 숫자와 Firestore Timestamp는 ISO로 읽는다. 기존 Admin intakeEventDocId/auditEventId에 연결된 aud_ 이력의 id/at/by/field/from/to만 조회한다. 없는 identity/조회 실패는 각각 IDENTITY_MISSING/UNAVAILABLE. 이력은 별도 관측이며 원장과 다중 읽기의 atomic snapshot을 주장하지 않는다.
- snapshotSummary: 조회한 동일 settlement_rows snapshot의 문서 IDs만 합산. 취소/정산제외 true는 제외, 미상 eligibility IDs는 명시. 한도 도달 또는 eligibility 미상이면 확정 supply/VAT/total은 null이고 관측 subtotal만 반환한다. billMonth 단일필터일 때만 MONTH이며 다른 조회는 FILTERED다. 공급가/VAT/총액별 누락수도 각각 제공한다.
- 기존 settlementRules/f04-confirmed-receipt-sync의 monthlyReceiptSummaries와 IDs·공급가·VAT·총액을 독립 대사한다. components MATCH/MISMATCH/UNKNOWN을 분리해 VAT미확인이 공급가 불일치로 오인되지 않게 한다. 이 비교는 저장 요약의 동시 관측을 보장하지 않는다.
- CREATE_NEW_JUSTIFIED: reuse check에서 기존 v1 strict schema/기존 gateway/projection을 검토했다. v1의 $id와 의미를 보존하려고 v2 schema만 별도로 추가했다. 새 엔진·원장·가지 없음.
- 운영 읽기 2026-10-09T05:35:51.701Z: 35행, 취소 제외34 IDs 정확일치; 청구 공급가36,582,600/VAT3,658,260/합계40,240,860; 지급 공급가29,322,051/VAT2,932,205/합계32,254,256. 기존 월 요약 일치. 이력READ34/identity미상1, cash read35. 직접 DB 쓰기·배포0.

### 2026-10-09 원본 최신성 binding 검증 패킷

settlement v2 meta.sourceFreshness는 UNVERIFIED / SOURCE_NOT_VERIFIED_BY_THIS_READ다. 저장 행·요약 MATCH, sourceReceiptSyncedAt, 서버 observedAt 어느 것도 최신 원본 검증을 뜻하지 않는다. 원본과 원장을 자동 수정하지 않는다.

- 실제 read binding 조회 2026-10-09T05:44:20.118Z: source=F04_RECEIPT, sourceTab=접수, monthlySummaryObservedAt=2026-10-07T06:32:13.553Z. sourceRange/valueRenderOption/digestAlgorithm/publisherRevision/publisherId/sourceSnapshotId는 없음.
- 기존 역사 조회에서 접수!A1:BT600 / UNFORMATTED_VALUE / stableDigest(values) 비교가 확인됐다. 이것은 검증자가 사용한 범위이며 실제 publisher 범위를 입증하지 않는다. 다른 기존 F04 전체 snapshot 도구 scripts/f04-ssot.mts는 A1:CZ2000을 읽는다. 이 범위는 대체 발행 계약으로 쓰지 않는다.
- 실제 owner 역할: FreePass Data settlementRules 월요약 publisher, 소비처 Admin은 reader. 현재 저장소의 기존 scripts/문서와 관련 ERP4/Admin/AI Ops scripts에서 해당 monthlySummarySourceDigest writer 구현·executor pin을 찾지 못했다. 실행 주체/실제 파일은 미확인이다.
- 동일 작업의 다음 입력: 실제 publisher 경로/immutable revision 및 실행 영수증; spreadsheetId/tab/range/valueRenderOption/dateTimeRenderOption/majorDimension; digest의 정확한 입력 형태·공백/빈셀/행열 padding·날짜/수식 정규화·알고리즘 버전; 실제 sourceObservedAt/sourceSnapshotId/executorRevision. 확인 전 값을 생성하지 않는다.
- dry-run 패킷 절차: 확인된 원본 binding으로 권한 있는 읽기 → private before evidence → publisher와 동일 정규화/digest 계산 → 기록된 sourceDigest 대조 → 같은 sourceReceipt IDs/공급가/VAT/총액/사람입력 보존 diff → 원장/요약을 다시 읽어 drift 검출. 불일치가 range/normalization/source change 중 어느 것인지 증거로 분류한다. apply는 이 단계에서 실행하지 않는다.
- 허용 결과: MATCH는 원본 binding·revision·동일digest·변경없는 재조회가 모두 입증된 시점에만. 그전에는 원본 최신성 HOLD, 저장원장과 요약 비교만 별도로 제공한다.

### 2026-10-09 운영 배포·실조회 날짜 회귀 및 발행기 실근거

read 배포 run37897561059/Admin run37897564010은 main2044416으로 성공했고 runtime identity/IAM 불변, Admin 기존 write on과 같은 secret내용을 보존했다. read00016-266/Admin00005-p4n READY. Kakao 상품기준 HTTP200/정책2026-10-09/schemaPASS, Admin workflow 9월 원장35개 HTTP200. 정산월조회 v1/v2는 billedAt ISO timestamp21개가 date schema를 위반해 HTTP503을 재현했다. 스키마 완화 없이 adapter만 수정: 날짜문자열은 그대로, RFC3339 timestamp는 Asia/Seoul 날짜로 투영, 불명/잘못된 날짜는 null. v2 dateSourceValues에 필드명과 원래 scalar를 보존하며 businessDate는 추정하지 않는다. UTC18시→KST다음날 반례와 v1/v2 schema 회귀를 추가했다.

실제 publisher 근거를 정산 담당 기존 실행 영수증에서 회수했다: ai-ops/state/정산-원본대조-20261006/접수복구-실행영수증.json의 partyNormalization.sheetAfter/sourceDigest와 ruleReceipt. 실행 대화01a11034-a593-7bd1-8062-57f889a30e3f의 2026-10-07T06:24:36.150Z 원본/06:25:48.401Z 요약발행 명령. 원본 요청 접수!A1:BT1000, valueRenderOption 생략(default FORMATTED_VALUE), majorDimension ROWS, SHA256 UTF8 JSON.stringify(values); 추가 padding/trim 없음. 반환range BT539는 요청범위와 구분한다. immutable 실행기 Git revision은 기록에 없어 확인되지 않았으며 새 pin을 만들지 않는다.

2026-10-09T07:18:55.987Z 같은 조건 dry-read: 당시 영수증 values digest는 저장 sourceDigest와 정확일치; 현재 원본 digest는 불일치. 당시539행/현재1000행이며 raw 행렬 비교491행 차이(행 삭제/추가/수식패딩은 별도분류해야 하므로 491개 계약변경으로 확대하지 않는다). 과거 검증자의 UNFORMATTED/BT600 차이뿐인 false alarm이라고 결론내릴 수 없다. 원본, 사람입력, 원장, 요약 변경0. 비공개 dryrun 증거는 TEMP/f04-publisher-binding-dryrun.json. 후속은 동일row/sourceReceiptRow와 실제 source identity로 금액·부가세·신규행·빈패딩을 분류하고 before/after plan을 지휘 판단에 제출하며 apply하지 않는다.

### 2026-10-09 운영 조회 복구 완료 기록

#### 2026-10-09 무보증 검색 후속 (배포 전)

- 재사용 판정 COMPOSE_OR_EXTEND: 기존 reference builder/gateway/schema/tests 및 `readIancarPublishedDeposit`를 확장한다. 원천 parser/수집 저장 파일은 다른 담당 영역으로 변경하지 않는다. Academy development READY.
- 운영 e0afae9 인증 Kakao reference HTTP200:485상품/3037기간, 보증금 KNOWN2048/UNKNOWN955/ZERO34. 같은 source 관측 `2026-10-09T07:52:17.440Z`로 상품ID·정확한 가격키 대사: 전체 원천 확인ZERO175기간 중 listable=true·대여료>0은34기간, 현재 응답 누락0. 175와34는 차량 대수가 아니다. ‘무보증’ 표시 있으나 양수금액도 있는2상품은 충돌 UNKNOWN이며 자동0원 정정하지 않는다.
- 기존 API는 검색 query를 적용하지 않았다. 이번 기존 경로 확장안은 `?depositState=ZERO&termMonths=36&depositScope=ANY_TERM` 또는 `ALL_TERMS`. 기간은 선택사항(1~60), 기본ANY_TERM. ANY_TERM은 해당기간 확인ZERO가 하나라도 있는 상품, ALL_TERMS는 모든 제공기간이 확인ZERO인 상품 중 선택기간도 존재하는 상품이다. 응답은 다른 유료/미확정 기간을 숨기지 않고 모든 priceTerms를 유지한다. 유효한 검색 결과0은 HTTP200/data[]; 잘못된 필터는400, 인증·grant는 유지한다.
- priceTerms.depositEvidence는 source-product 참조/원래 amount·note/판정 사유를 보존한다. 이안카 발행 증거의 주행거리별 키는 기존 producer 검증기로 확인하고 15분 freshness·alias·금액 대사를 재사용한다. 월/연 주행거리는 contractedMileage.period로 분리하며 월거리의 연거리 환산을 만들지 않는다. raw0을 확인ZERO로 바꾸지 않는다. RP012 중고/재렌트 무보증 금지는 기존 deposit-evidence 정본 그대로 유지한다.
- 고정 source로 보완안 비교:3037→5293기간(주행거리키2256행 보존), 확인무보증31상품/34기간, 전체 무보증31상품; 동일 source로 만든 응답·검색응답 schemaPASS. 추가행의 오래된 발행 근거는 UNKNOWN 유지. 비공개 TEMP/deposit-reference-source-before.json·deposit-reference-live-before.json·deposit-reference-proposed.json으로 정확키 재현한다.
- 로컬 check1701PASS/14emulatorSKIP. Claude 실제 호출은 조직 접근 제한FAILED이며 필수 독립 검토 미통과를 유지한다. 원천/원장/수수료 저장/APPLY/IAM 변경0. main 통합·운영 배포·새 검색 소비처 사용은 준비안과 검토 결과를 확인한 뒤 이어간다.

- 승인: Data 지휘 직접 userMessage 01a11f7d-5691-7b80-84f2-f33486a7be72(그럼 다음 전체 작업 한번 가자)를 read_thread로 확인. 서비스 배포/조회만, 운영 금액 APPLY/대량 원장쓰기 권한은 제외.
- 코드 main e0afae906566e61ace626c438cf416146c9026b8 / PR406. full check1698 PASS/14 emulatorSKIP, exacthead core/canonPASS. 독립 read-only CLI 검토 exit0/답변 중대지적없음(검토자가 실행한 test는 EPERM으로 실패하였으므로 PASS에 포함하지 않음). Claude 조직차단 UNAVAILABLE를 PASS로 세지 않았다.
- 실제 재배포: read run37898833623 SUCCESS → freepass-data-read-00017-wk6, Admin run37898836852 SUCCESS → freepass-data-admin-00006-jbk. 양쪽 e0afae9 immutable image/READY/traffic100. 기존 runtime identity/IAM bindings 그대로, 기존 Admin write on/secret3 내용 그대로. rollback은 배포전 read00015-649/Admin00004-lwg revision으로 기존 traffic 복귀하며 금액원장을 복원하는 작업과 구분한다.
- owner production read: CloudRun IAM token+기존 consumer token으로 Kakao 정산9월 v1/v2 월조회 HTTP200/count35/각schemaPASS, 같은 source.documentId 단건 v1/v2 HTTP200/count1/schemaPASS. v2 sourceFreshness UNVERIFIED 유지. 기존 Data 지휘가 월·단건 v1/v2와 rawEvidence존재를 독립 실제 재조회했다.
- Kakao 기간상품기준 HTTP200/schemaPASS:485 reference products/485offers/3037terms. 월료·보증금state·청구state·지급state·policyContext 누락0, policy sales-commission-2026-10-09. 이것은 원천 reference 조회이며485대를 Canonical 저장/ACTIVE 전환했다고 주장하지 않는다. 미확정fee2223terms: vehicleValue1140, 신차subtype494,Q12basis270,noRule184,unsupportedterm94,Iancarshortbasis41. null/사유를 그대로 제공하며 확정액을 추정하지 않는다.
- Admin 기존 workflow 원장조회 HTTP200/count35. 양쪽 서비스 무인증403. Admin 권한에 settlement-ledger-read를 새로 추가하지 않았고 운영 쓰기 요청0.
- 정산 v2 월대사: 취소1제외34IDs와 기존 저장요약 IDs/공급가/VAT/총액 모두MATCH. 청구36582600+3658260=40240860,지급29322051+2932205=32254256. 원본 최신성 또는 상대방 확정/은행수금 검증으로 확대하지 않는다.
- 원본 dryrun 후속: 같은 publisher binding의 현재 digest 불일치.7수치차이 중3개는 FORMATTED 표시정밀도(UNFORMATTED 재조회로 확인),4개 실제 source금액 검토(row441/431/461/413). 표시영역539→1000 확대461행에는 인식가능차번/날짜0이며 새계약461건으로 해석하지 않는다. plan은 source/humanWritten before를 private TEMP/f04-source-change-classified-plan.json에 보존; 실제 APPLY/재청구0.
