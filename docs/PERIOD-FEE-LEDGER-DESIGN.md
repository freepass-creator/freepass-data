# 기간별 청구·지급 장부 설계 (2026-10-11)

## 목적과 결정

대표 승인(2026-10-11): **기간별 청구·지급을 프리패스 데이터(Firestore)에 박제하고 온라인에서 직접 읽는다.**

범위는 Firestore `products` 전체 중 가격이 있는 문서의 기간별 월 대여료, 보증금, 공급사 청구 수수료(`supplierBillingFee`), 영업채널 지급 수수료(`channelPayoutFee`)를 내부 소비자가 즉시 조회하는 장부다. 대표 2026-10-11 지휘통제실 정정에 따라 박제 범위는 판매 중 475대가 아니라 Firestore `products` 전체다. 실측 기준 전체 1,776문서 중 가격 있는 1,724문서, 기간 가격 행 15,054행을 상태와 무관하게 박제한다. 정산 화면의 사람 입력값, 실제 청구·수금·지급 사건, 환수·조정은 기존 `settlement_rows`와 Admin 정산 도메인에 남긴다.

## 대표 10-11 지휘통제실 정정

- 박제는 판매 중 여부나 출고 상태와 무관하다. `출고불가`, `계약중` 등 상태값과 관계없이 가격 있는 `products` 전체 문서의 기간 가격 행을 박제한다.
- 출고 상태가 `출고불가`에서 `출고가능`으로 바뀌어도 수수료를 다시 계산하지 않아도 되도록, 해당 차량의 가격 행은 이미 장부에 있어야 한다.
- 판매 중 여부와 출고 상태 필터링은 박제 값이 아니다. 소비처가 읽는 상품 문서의 현재 상태값으로 거른다.
- 박제 컬렉션에는 판매 중 여부, 출고 상태, 공개 노출 상태를 복제하지 않는다. 장부는 차량 키(`vehicleUid` 우선, 없으면 계획 HOLD)와 가격행 키로 상품 문서에 연결한다.

이번 문서는 설계만 한다. 코드, 운영 쓰기, 배포, 커밋, push 없음.

## 정본과 재사용 판정

재사용 대상:

- `Offer.internalEconomicsTerms`: 기간 가격행(`Offer.priceTerms[].termKey`)에 `depositCalculation`, `supplierBillingFee`, `channelPayoutFee`를 붙이는 내부 경제조건 저장소다. 공개 응답에는 내보내지 않는 내부 필드로 정의돼 있다(`src/domain/catalog.ts`).
- `precomputeOfferEconomics`: 기존 `resolveSupplierBillingFee`·`resolveSalesCommission` 엔진을 사용해 기간별 경제조건을 만든다. 새 계산기를 만들지 않는다(`src/application/resolve-offer-commercial-terms.ts`).
- `toInternalFeeLookup` / `readStoredTermFees`: 저장된 수수료를 계산 없이 가격행 1:1로 읽는다(`src/domain/internal-fee-lookup-contract.ts`, `src/application/resolve-offer-commercial-terms.ts`).
- `resolveContractFeeLink`: Admin 접수/정산 한 줄이 차량 UID 또는 차량번호, 공급사, 기간, 월대여료, 보증금으로 현재 Catalog 가격행을 찾는 순수 조회 경로다(`src/application/contract-fee-link.ts`).
- #448: 원천 상품행과 가격행 응답에 `supplierBillingFee`·`channelPayoutFee`를 읽기 투영했다. 로컬/운영 기록 기준 LISTABLE 475상품, 5,193기간이 확인됐고, 공개 응답 차단 테스트가 추가됐다. 이 475상품 기준은 신뢰도 점검표의 표본/대조 분모이지, 장부 박제 범위가 아니다.

판정: **기존 `catalog_offers.internalEconomicsTerms`와 #448 가격행 투영만으로는 충분하지 않다. `COMPOSE_OR_EXTEND`로 계산·가격행 계약은 재사용하되, 차량별 기간 장부 컬렉션은 `CREATE_NEW_JUSTIFIED`다.**

부족한 이유:

- 문서 키가 차량번호/차량 UID 조회에 맞지 않는다. `catalog_offers`는 offer 중심이고, 현행 `products` 문서 키도 차량번호만으로 안정 조회할 수 없다. `Vehicle UID` 문서에 따르면 기존 `catalog_vehicle_assets` 160개는 `va_` 해시이고, 운영 `products` 문서 키는 차량번호·공급사 자체 ID·접두 키가 섞여 있다.
- 현재 Canonical 제안은 160개 수준이고, 2026-10-11 관측 LISTABLE 475대 대부분은 새 Catalog 제안에 아직 없다. `internalEconomicsTerms`만 읽으면 운영 중인 차량 다수를 놓친다. 또한 장부 박제는 LISTABLE 475대가 아니라 가격 있는 `products` 전체 1,724문서/15,054행이므로, 판매 중 목록을 박제 분모로 쓰면 출고 상태 변경 시 필요한 값을 놓친다.
- #448은 가격행 응답 투영이다. 영구 장부, 일 단위 박제 id, snapshot digest, products 문서 updateTime, 되읽기 증거를 보존하지 않는다.
- 상품 문서와 공개 응답을 분리해야 한다. 내부 수수료·마진은 public ERP, 화이트라벨, `freepass-data-public` 응답에서 0건 노출이어야 한다.
- 하루 박제 이력은 가격행 현재값과 다르다. 오늘 계산값을 내일 다시 재현하는 것과, 오늘 박제한 행을 snapshot으로 증명하는 것은 다른 요구다.

## 컬렉션 선택

컬렉션 이름 후보:

- 1순위: `period_fee_ledger`
- 2순위: `catalog_period_fee_snapshots`
- 3순위: `internal_period_fee_rows`

권장: `period_fee_ledger`. 이유는 상품 Catalog 내부 필드도 아니고 정산 원장도 아닌, 차량별 기간 경제조건 장부임을 이름에 드러낸다.

`src/infra/firestore-layout.ts`에는 현재 `catalog_*`, `source_*`, `projection_*`, `legacyAdminWorkflow.settlementRows` 등이 있다. 구현 PR에서는 다음처럼 별도 내부 영역을 추가한다.

```ts
periodFees: Object.freeze({
  ledger: 'period_fee_ledger',
  snapshotRuns: 'period_fee_snapshot_runs'
})
```

## 문서 키와 행 단위

비교:

| 선택지 | 읽기 | 쓰기 | 장점 | 단점 |
| --- | --- | --- | --- | --- |
| 한 문서 = 한 가격행 | 500건 일괄 조회는 `snapshotId`/`vehicleUid`/`termKey` 색인으로 단순. 차량 한 대는 `vehicleUid + snapshotId` query. | 일 박제 멱등키가 행마다 안정적. 일부 실패 재시도 안전. | 가격행 단위 digest, 상태, reason을 독립 보존. 공개/내부 필드 차단 테스트가 쉽다. | 차량 한 대의 기간 배열을 만들려면 여러 문서를 읽어야 한다. |
| 한 문서 = 한 차량의 기간 배열 | 차량 한 대 조회가 단일 문서. | 한 기간만 바뀌어도 차량 문서 전체 갱신. 동시성/부분 실패 증거가 커진다. | 화면 응답 모양과 비슷하다. | 500건 일괄 조회에서 큰 문서 fan-out, 행별 멱등/되읽기/차이 기록이 흐려진다. |

선택: **한 문서 = 한 가격행**.

문서 키:

```text
snapshotId__vehicleUid__supplierId__productId__offerId__termKey
```

규칙:

- `vehicleUid`는 `vehicle_uid` 또는 `assetId` 우선. 없으면 행을 쓰지 않고 계획에서 `VEHICLE_UID_REQUIRED`로 HOLD한다.
- 차량번호는 문서 키에 넣지 않는다. `plateLookupKey`와 `plateLast4ForReport` 같은 찾기용 보조 필드·색인만 둔다.
- 공개 저장소 테스트 데이터는 `TEST-FAKE-ASSET-001`, `TEST-FAKE-PLATE-0001`, `TEST-FAKE-SUPPLIER`처럼 쓴다.
- `termKey`는 기존 `Offer.priceTerms[].termKey`를 그대로 사용한다. 기간 개월만으로 문서 키를 만들지 않는다.

필수 색인:

- `snapshotId ASC, vehicleUid ASC, termKey ASC`
- `vehicleUid ASC, snapshotId DESC, termMonths ASC`
- `plateLookupKey ASC, snapshotId DESC, supplierId ASC`
- `supplierId ASC, productId ASC, termMonths ASC, snapshotId DESC`

## 필드

```ts
type PeriodFeeLedgerRow = {
  schemaVersion: 'period-fee-ledger/v1';
  snapshotId: string;
  snapshotDateKst: string; // YYYY-MM-DD
  computedAt: string;
  valueBasis: 'CURRENT_AT_SNAPSHOT';
  valueAsOf: string; // YYYY-MM-DD, computedAt KST date
  engineRevision: string;
  sourceDigest: string;

  vehicleUid: string;
  assetId: string;
  plateLookupKey: string | null;
  plateLast4ForReport: string | null;
  supplierId: string;
  productId: string;
  offerId: string;
  offerRevision: number;
  productUpdateTime: string;

  termKey: string;
  termMonths: number;
  monthlyRent: { amount: number; currency: 'KRW'; state: 'KNOWN' | 'UNKNOWN'; reasonCode: string | null };
  deposit: {
    state: 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
    amount: { amount: number; currency: 'KRW' } | null;
    reasonCode: string | null;
    sourceRefs: string[];
    depositEvidence: {
      kind: 'SOURCE_AMOUNT' | 'SUPPLIER_RULE_NOTE' | 'VERIFIED_ZERO_TEXT' | 'UNKNOWN';
      ruleCode: string | null;
      noteField: 'deposit_note' | string | null;
      noteText: string | null;
      sourcePriceKey: string;
      calculationBasis: string | null;
      policyCode: string | null;
    };
  };

  supplierBillingFee: LedgerFeeAmount;
  channelPayoutFee: LedgerFeeAmount;
  ruleIds: string[];
  policyIds: string[];
  priceSourceRefs: string[];
  inputRefs: {
    productPath: string;
    offerPath: string;
    priceTermRef: string;
    internalEconomicsRef: string | null;
  };
};

type LedgerFeeAmount = {
  state: 'CALCULATED' | 'UNKNOWN' | 'NOT_APPLICABLE';
  amount: { amount: number; currency: 'KRW' } | null;
  vatTreatment: 'EXCLUDED' | 'INCLUDED' | 'UNKNOWN' | null;
  vatAmount: number | null;
  totalAmount: number | null;
  reasonCode: string | null;
  ruleId: string | null;
  policyId: string | null;
  sourceRefs: string[];
};
```

상품 상태 필드는 이 타입에 넣지 않는다. `출고불가`, `출고가능`, `계약중`, 판매 중 여부, 공개 노출 여부는 소비처가 상품 문서의 현재 상태값을 읽어 판단한다. 장부는 `vehicleUid`와 `inputRefs.productPath`로 상품 문서에 연결할 뿐, 상태 snapshot을 복제하지 않는다.

상태 규칙:

- 저장 원천의 `KNOWN`·`ZERO`는 장부 응답에서 `CALCULATED`로 읽는다. 금액 0도 계산된 값이면 `CALCULATED + amount 0`이고, 모름은 `UNKNOWN + amount null`이다.
- `NOT_APPLICABLE`은 금액 null, reasonCode 필수다.
- 월 대여료가 미확정이면 수수료는 계산하지 않고 `UNKNOWN / SOURCE_MONTHLY_RENT_MISSING_OR_INVALID`다.
- 보증금 상태는 기존 `DepositState`(`KNOWN`, `ZERO`, `UNKNOWN`, `NOT_APPLICABLE`)를 재사용한다.
- 미확정은 절대 0으로 채우지 않는다.

## 읽기 권한과 소비 경로

읽을 수 있음:

- Kakao Ops 내부 조회: 차량번호/차량 UID로 기간별 경제조건을 읽는다.
- FreePass Admin: 상품/계약접수/정산 보조 조회에서 읽는다.

읽을 수 없음:

- ERP5 public compatibility 응답
- public feed
- `freepass-data-public`
- 화이트라벨 공개 상품 응답
- 공개 `/catalog`

차단 방식은 IAM/Firestore Rules만 믿지 않는다. 코드 구조로 막는다.

- public reader의 허용 컬렉션 목록에 `period_fee_ledger`를 넣지 않는다.
- public schema allowlist에 `supplierBillingFee`, `channelPayoutFee`, `expectedGrossMargin`, `priceSourceRefs`, `ruleId`, `policyId`를 넣지 않는다.
- `tests/public-product-feed.test.ts`처럼 JSON 문자열에 내부 필드명과 `PRIVATE_` 근거가 0건인지 검사한다.
- consumer gateway 테스트에서 public 응답 body에 `supplierBillingFee|channelPayoutFee|expectedGrossMargin|period_fee_ledger`가 0건인지 검사한다.

관계:

- Admin HTTP 문 `contract-fee-links`는 현재 Catalog 목록을 읽어 “지금 어떤 가격행인가”를 판정하는 얇은 내부 조회다. 장부가 생기면 이 문은 선택된 `assetId/termKey/snapshotId`를 반환하거나, 별도 `period-fee-ledger/read` 내부 route가 그 역할을 맡는다.
- 장부의 읽기 경로는 **Firestore 직접 읽기(온라인)** 다. 다만 소비자는 내부 Gateway 계약을 통해 읽고, Gateway 구현이 Firestore에서 직접 조회한다.
- 수수료 엔진을 consumer route에서 다시 돌리지 않는다. route는 장부나 저장된 `internalEconomicsTerms`를 읽는다.

## 일 단위 박제 작업

freepass-data 자기 workflow로 한다. `data-owned-refresh.yml`는 퇴역 공지이고, 현재 패턴은 `shared-sheet-daily.yml`의 자기 서비스 계정, 계획→쓰기→되읽기, 증거 보관, 멱등키, 기대 revision, readback mismatch 실패 구조를 따른다.

단계:

1. 읽기: `CatalogStore.listVehicleAssets/listProducts/listOffers`와 필요한 source/product updateTime을 같은 실행에서 읽는다. 입력 범위는 판매 중 필터가 아니라 Firestore `products` 전체 1,776문서 중 가격 있는 1,724문서다.
2. 계산: 새 계산 금지. `precomputeOfferEconomics` 또는 이미 저장된 `internalEconomicsTerms`를 재사용하고, `toInternalFeeLookup`으로 가격행 1:1 상태를 만든다.
3. 계획 파일: 쓰기 0. 전체 문서 수 1,776, 가격 있는 문서 수 1,724, 기간 가격 행 15,054, UNKNOWN 사유별 수, 공개 차단 검사 결과, `planDigest`, before-image digest를 만든다.
4. 승인 후 쓰기: `snapshotId + vehicleUid + supplierId + productId + offerId + termKey` 멱등키로 `create` 또는 expected revision 조건부 `set`을 사용한다.
5. 되읽기: 쓴 문서 수, dataDigest, readback mismatch 0을 확인한다.

저장소 일관성과 비용 추정: `한 문서 = 한 가격행` 설계이므로 2026-10-11 실측 15,054기간 가격 행은 장부 문서 15,054개와 같다. 첫 박제 apply는 최대 15,054문서 create/쓰기이고, 같은 `snapshotId` 재실행은 same-digest no-op이어야 한다. 일 단위 새 snapshot을 실제로 만든다면 하루 최대 쓰기 수는 15,054건이며, 계획기와 되읽기는 이 수를 기준으로 용량, Firestore batch 분할, 예상 쓰기 비용, readback 문서 수를 산정한다. 분모를 LISTABLE 475대/5,193기간으로 낮춰 비용을 추정하지 않는다.

## 분모 구분

신뢰도 점검표와 박제 범위의 분모는 다르다.

- 신뢰도 점검표: 대표/지휘통제실이 보는 운영 대조 표본이다. 기존 LISTABLE 475대 기준은 판매 중 상품을 중심으로 수치와 상태를 검산하기 위한 점검 분모다.
- 박제 범위: Firestore `products` 전체 1,776문서 중 가격 있는 1,724문서, 기간 가격 행 15,054행이다. 상태와 무관한 장부 분모이며, `출고불가`·`계약중`도 가격이 있으면 포함한다.
- 소비처 필터: 상품 조회 화면, Admin, Kakao Ops 등은 장부 문서의 상태값이 아니라 상품 문서의 현재 상태값으로 판매 중/출고 가능/계약 중 등을 필터링한다.

안전 규칙:

- RTDB 쓰기 금지.
- ERP4 쓰기 금지.
- `settlement_rows` 읽기 갱신 0, 쓰기 0. 사람 입력 칸 `claimWritten`, `payWritten`, `calculationBasis`, 비고·증빙은 불가침이다.
- `settlement_rows` 관련 테스트는 “장부 job 실행 중 legacyAdminWorkflow.settlementRows 접근 0”을 회귀로 둔다.
- 같은 날 재시도는 같은 `snapshotId`이면 같은 행을 no-op 또는 same-digest로 처리한다. 입력 digest가 달라지면 `PERIOD_FEE_PLAN_STALE`로 멈춘다.
- 공개 로그에는 실제 차량번호, 시트 ID, 토큰, 고객/계약 원문을 출력하지 않는다.

## 단계와 완료 증거

### 가. 계획기

산출물:

- `period-fee-ledger-plan.json`
- `planDigest`
- counts: vehicles, products, offers, terms, CALCULATED/UNKNOWN/NOT_APPLICABLE, reasonCounts
- public-leak scan 결과
- `settlement_rows` access count 0

되돌리기: 쓰기 0이므로 파일 폐기.

### 나. 지휘통제실 20대 판정

지휘통제실은 차량 20대를 고른다. 공개 보고에는 마지막 4자리도 실제 차량번호가 되지 않게 `TEST-FAKE-*` 또는 내부 비공개 보고만 사용한다.

대조 항목:

- 공급사 원본 월대여료
- Firestore 월대여료
- 보증금 금액·상태
- 청구·지급 상태와 reasonCode
- 가격행 termKey와 기간

완료 증거:

- `20/20` 또는 불일치 목록과 HOLD 사유
- 원천 updateTime과 장부 sourceDigest
- 공개 저장소에는 민감값 0

되돌리기: 판정 전이면 쓰기 없음. 판정 파일은 비공개 증거 위치에 보관.

### 다. 실제 쓰기

선행 조건:

- 계획기 PASS
- 20대 판정 PASS 또는 승인된 HOLD 목록
- 대표/상황실의 이번 실행 대상·날짜·범위 승인

완료 증거:

- `snapshotId`
- `planDigest`
- committed/noChange/held/readbackMismatch counts
- readbackMismatch 0
- backup path와 되읽기 `cmp` PASS
- 운영 기록에 바꾼 문서 수, 바꾸지 않은 문서 수, HOLD 사유 수

되돌리기:

- 새 `snapshotId`를 active pointer로 쓰기 전이면 소비자가 이전 snapshot을 계속 읽는다.
- active pointer를 바꿨다면 이전 pointer와 backup digest로 되돌린다.
- 행 삭제로 되돌리지 않고 snapshot pointer를 이전 것으로 돌리는 방식을 우선한다.

## 테스트 계획

단위:

- key builder: `vehicleUid` 없으면 HOLD, 차량번호는 key에 없음.
- 상태 변환: KNOWN/ZERO/UNKNOWN/NOT_APPLICABLE과 CALCULATED/UNKNOWN/NOT_APPLICABLE 매핑.
- 0과 UNKNOWN 분리.
- `toInternalFeeLookup` 재사용, 중복/고아/누락 reason 보존.

통합:

- 500건 계획 파일 생성, digest 안정성.
- 같은 `snapshotId` 재실행 no-op.
- 입력 digest 변경 시 stale 실패.
- `settlement_rows` 접근 0.
- public response/body/schema에 내부 수수료·마진 문자열 0.
- Admin/Kakao 내부 소비자는 `assetId` 우선, 차량번호는 보조 조회.

운영 전 dry-run:

- Firestore `products` 전체 1,776문서 중 가격 있는 1,724문서, 기간 가격 행 15,054행 기준 batch 조회 계획.
- LISTABLE 475대 기준 신뢰도 점검표와 박제 범위 1,724문서/15,054행을 혼동하지 않는 coverage report.
- Canonical 160 제안만으로 충분하다고 오판하지 않는 coverage report.
- 공개 저장소 출력에서 실제 차량번호·시트 ID·토큰 0.

## PR 분할

1. 설계 PR: 이 문서와 NEXT 한 줄.
2. 계획기 PR: 읽기 전용 plan job, schema/type, public leak tests, settlement_rows 접근 0 테스트.
3. 박제 쓰기기 PR: 승인된 plan digest만 apply, backup/readback, active pointer 전환 없음 또는 별도 flag.
4. workflow PR: 자기 서비스 계정, 수동 dry-run 기본, 승인 후 apply, daily guard와 로그 누락 감시.
5. 소비자 read PR: Kakao/Admin 내부 route 또는 기존 route 확장. public 차단 회귀 포함.

## 일정 제안 (오늘 2026-10-11 기준)

- 10-11: 설계 확정, 열린 질문 답변.
- 10-12 오전: 계획기 PR, 가짜 데이터 테스트, 공개 차단 테스트.
- 10-12 오후: 실제 원천 읽기 dry-run 계획 파일 생성, 20대 판정 묶음 전달.
- 10-13: 판정 결과 반영, 박제 쓰기기 PR, 승인 전까지 apply 비활성.
- 10-14: 승인된 범위 첫 apply, readback, 내부 Kakao/Admin 조회 연결 검증.
- 10-15: workflow 예약/수동 운영 게이트와 신선도 경보 분리.

## 열린 질문

1. `snapshotId`는 KST 날짜 하나(`period-fee-YYYY-MM-DD`)로 고정할지, 같은 날 재계산을 허용하는 run suffix를 둘지 결정 필요.
2. 장부 조회가 기본적으로 “최신 active snapshot”만 읽을지, 날짜 지정 조회를 1차부터 열지 결정 필요.
3. 차량 UID 마이그레이션 전 가격 있는 `products` 전체 1,724문서 중 UID 없는 행은 전부 HOLD할지, 임시 source observation id로 계획만 만들지 결정 필요.
4. Admin 기존 `contract-fee-links`에 장부 snapshotId를 붙일지, 별도 `period-fee-ledger/read` route로 분리할지 결정 필요.

## 상태·가격 변경 이력

대표 2026-10-11 지휘통제실 판정: “상태값 변경 이력은 다 있어야겠지, 어떤 값이었는데 어떻게 바뀌었나.” 현재 실측 기준 `products` 1,776문서는 상태값 현재값만 있고, 이전 값과 바뀐 시각 이력이 없다. 새 Catalog 160 제안 밖의 상품 문서 필드 변경은 `audit_events`·`catalog_entity_revisions`에도 남지 않으며, `raw_records`는 원천 행 관측이 4~9회뿐이라 일별 상태·가격 변경 이력을 복원하기에 부족하다.

재사용 판정:

- `audit_events`: `src/domain/catalog.ts`의 `AuditEvent`는 `commandId`, `entityType`, `entityId`, `before`, `after`, `revisionBefore`, `revisionAfter`, `occurredAt`를 갖는 명령 감사다. `src/application/catalog.ts`는 Offer 가격 명령과 Canonical 생성 같은 정본 명령에서만 `appendAudit`를 호출한다. 운영 `products` 문서의 일일 snapshot 필드 차이를 자동 기록하는 장부가 아니므로 이 용도에는 맞지 않는다.
- `catalog_entity_revisions`: `src/infra/firestore-layout.ts`의 `catalog.revisions = 'catalog_entity_revisions'`이고, `src/domain/history.ts`의 revision snapshot은 Canonical entity revision 단위다. 새 Catalog 160 제안 밖의 legacy `products` 현재값 변동을 일별로 비교·append하는 구조가 아니며, 기간 가격행 단위 보증금 상태까지 남기는 이력 저장소도 아니다.
- `field_lineage`: `src/domain/lineage.ts`의 `FieldLineageRecord`는 `RAW_TO_NORMALIZED`와 `NORMALIZED_TO_CANONICAL` 단계에서 원천 필드가 정리값·정본값으로 간 경로를 보존한다. 값 A가 직전 snapshot의 A에서 B로 바뀐 “상품 문서 필드 변경 이력”이 아니라 원천·정규화·정본 provenance다.
- `raw_records`: 원천 관측 증거로 재사용하되, 관측 횟수가 제한되어 과거 전체 변경 이력을 복원할 수 없다. 과거 상태는 별도 표시 `APPROXIMATE`가 붙은 근사 분석으로만 다룬다.

판정: `CREATE_NEW_JUSTIFIED`. 기존 audit/revision/lineage는 근거·정본·명령 이력으로 재사용하지만, 상품 문서 필드별 상태·가격 변경 이력에는 별도 append-only 컬렉션 하나가 필요하다. 후보 이름은 `product_change_history`다.

문서 키:

```text
productKey__snapshotId__fieldPathHash
```

규칙:

- `productKey`는 차량 UID를 우선한다. 없으면 상품 고유키를 보조로 쓰되, 차량 UID 누락 사유를 HOLD 또는 별도 reason으로 남긴다.
- 같은 snapshot을 같은 날 다시 실행해도 같은 `productKey + snapshotId + fieldPathHash`에 도달해야 하며 중복 문서를 만들지 않는다.
- 문서는 추가만 한다. 덮어쓰기·삭제·정정 업데이트를 하지 않는다. 잘못 쓴 이력은 별도 correction 이력으로 추가한다.
- `period_fee_ledger`와 별개 문서다. 장부 행에 상태·가격 변경 배열을 끼워 넣지 않는다.

필드:

```ts
type ProductChangeHistoryRow = {
  schemaVersion: 'product-change-history/v1';
  productKey: string;
  fieldPath: 'vehicle_status' | 'status' | 'status_kind' | 'listable' | 'priceTerms.monthlyRent' | 'priceTerms.deposit';
  before: unknown;
  after: unknown;
  changedAtKst: string;
  snapshotId: string;
  sourceObservationRef: string | null;
  kind: 'STATUS' | 'RENT' | 'DEPOSIT';
};
```

상태 이력 규칙:

- 일 박제 때 `vehicle_status`, `status`, `status_kind`, `listable` 등 상품 상태값을 직전 snapshot과 비교한다.
- 다르면 `productKey`, 이전 상태, 이후 상태, 바뀐 시각(KST), 근거(`sourceObservationRef` 또는 `snapshotId`)를 append-only로 남긴다.
- 첫 snapshot은 비교 대상이 없으므로 변경 이력 0건이다. 대신 기준선 snapshot으로만 기록한다.

가격 이력 규칙:

- 월 대여료와 보증금은 기간 키 단위로 비교한다.
- 월 대여료는 이전 값·이후 값을 남긴다.
- 보증금은 금액뿐 아니라 `KNOWN`·`ZERO`·`UNKNOWN`·`NOT_APPLICABLE` 같은 보증금 상태까지 같이 비교해 남긴다.
- 기간 키가 새로 생기거나 사라진 경우도 fieldPath와 kind를 유지하고 before/after에 `null` 또는 상태값을 명시한다.

공개 차단:

- `product_change_history`는 내부 이력 컬렉션이며 공개 응답과 분리한다.
- public reader 허용 목록에 넣지 않는다.
- public response/body/schema 문자열 검사에 `product_change_history`, `vehicle_status`, `status_kind`, `sourceObservationRef`가 0건인지 추가한다.
- 실제 차량번호·시트 ID·토큰·고객 식별자는 이 컬렉션과 테스트 fixture에 넣지 않는다.

PR·시험·일정 반영:

- 10-12 계획기 묶음에 상태·가격 변경 이력 계획을 포함한다. 산출물은 직전 snapshot 대비 차이 목록이며 쓰기 0이다.
- 10-13 박제 쓰기기 PR 이후에만 실제 쓰기 경로를 붙인다.
- 계획기 PR 테스트에는 “첫 snapshot은 변경 이력 0건, 기준선만 기록”, “직전 snapshot 대비 상태 차이 목록 생성”, “가격 기간 키별 월 대여료·보증금 상태 차이 생성”, “공개 응답 차단”을 넣는다.
- 쓰기기 PR 테스트에는 “append-only”, “덮어쓰기·삭제 불가”, “같은 snapshot 재실행 멱등”, “동일 productKey+snapshotId+fieldPathHash 중복 차단”, “공개 차단”을 넣는다.
- PR 분할은 계획기 PR에 상태·가격 이력 차이 목록을 포함하고, 박제 쓰기기 PR에 `period_fee_ledger`와 `product_change_history` 추가 전용 쓰기를 함께 다룬다.

## 10-12 계획기 구현 상태

10-12 계획기 구현은 읽기 전용이다. `src/application/period-fee-ledger-plan.ts`가 `products`/`policy` 입력을 받아 기존 `buildKakaoCatalogReferenceProduct` 투영의 기간별 `supplierBillingFee`·`channelPayoutFee`와 `withCompatibilityDepositEvidence` 계열 보증금 상태를 재사용해 `period_fee_ledger` 계획 행과 `product_change_history` 차이 목록을 만든다. 실행은 `PERIOD_FEE_LEDGER_PLAN_OUT=<저장소 밖 절대경로> npm.cmd run plan:period-fee-ledger`이며 stdout은 개수·digest만 출력하고 원본 상품 키는 비공개 계획 파일에만 남긴다. 현재 한계는 운영 쓰기/apply, active snapshot 포인터, 이전 snapshot 운영 readback 연결, 20대 지휘통제실 판정 묶음이 아직 없다는 점이다. UID 없는 행은 `HOLD_NO_UID`로 계획에만 포함하고 apply 대상에서 제외한다.

## 값의 시점

`period_fee_ledger`의 금액은 계약 당시 원문을 복원한 값이 아니다. 각 행은 일 단위 snapshot을 만들 때 `products`와 현재 정책/수수료 규칙으로 계산한 현재값의 박제이며, 이 의미는 `valueBasis: 'CURRENT_AT_SNAPSHOT'`와 `valueAsOf`로 고정한다. `valueAsOf`는 snapshot `computedAt`의 KST 날짜다.

계약 연결 소비자는 장부 행을 계약 조건으로 바로 쓰지 않는다. 계약 조건으로 확정하려면 `valueAsOf <= 계약일(접수일)`인 행 중 가장 늦은 snapshot을 고르고, 그 행의 월 대여료와 보증금이 계약 기록과 일치해야 한다. 계약일 이전 snapshot이 없거나 값이 다르면 `CONTRACT_TIME_VALUE_UNAVAILABLE` HOLD로 둔다.

따라서 첫 snapshot 이전 계약, 예를 들어 장부가 없는 74건은 현재값으로 대체하지 않는다. 접수 시점 snapshot, 박제 이력, 공급사 원문 이력을 별도로 찾아야 하며 찾지 못하면 원문 없음 HOLD다. 계획기와 소비 규칙은 "계약 당시 값"이라는 플래그나 표현을 만들지 않는다.
