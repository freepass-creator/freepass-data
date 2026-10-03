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

Canonical `catalog_offers.internalEconomicsTerms`는 신규 canonicalization, 승인된 원천 Offer 변경, 가격 변경의 기존 CatalogStore 거래 안에서 다시 계산한다. `precomputeOfferEconomics`는 `sales-commission-2026-09-28`과 ERP `settlement-fee-table.ts@f862d0097f6e83d79d0b699bc369a83716b1d982`를 참조하는 기존 resolver를 재사용한다. 대여료·보증금은 `priceTerms`에서 복사하며 별도 `internalPeriodFees` 저장소는 없다. 수수료는 계약 전체 1건의 VAT 별도 공급가액이고 `calculation`, `sourceRefs`, `ruleId`, `policyId`를 보존한다. Offer의 기존 `policyId`(상품 정책)와 수수료의 `policyId`(규칙 묶음)는 다르다.

Admin 전용 `data[].offers[].priceTerms[].supplierBillingFee` / `channelPayoutFee`만 양쪽 금액을 제공한다. Admin은 FreePass 내부 계약접수 주체이므로 외부 공급사/영업채널의 상대편 수수료 제외 규칙과 구분한다. 서버의 `freepass-admin-catalog` 전용 등록·키 제한을 유지하고 public ERP·화이트라벨·Kakao 응답에는 이번 필드를 추가하지 않는다. Admin projection은 저장된 값만 읽고 누락·중복·무효·가격/기간 불일치를 UNKNOWN으로 내린다. Admin에서 재계산하지 않는다.

`meta.economicsTermCounts.{supplierBillingFee,channelPayoutFee}.{KNOWN,ZERO,UNKNOWN,NOT_APPLICABLE}`는 각 수수료별 기간 행 수다. `meta.economicsCoverage`는 빈 기간 목록 또는 한쪽 UNKNOWN이 있으면 INCOMPLETE, 나머지는 COMPLETE다. 릴리스의 `economics`에도 저장하고 gateway는 검증된 release data로 다시 집계한다. Health `checks.offerEconomics`에도 같은 지표를 쓰되 분모는 전체 Canonical Offer의 기간이며 Admin ACTIVE 대상과 다를 수 있다. COMPLETE는 지급 확정·정산 완료·원천 최신성 확인을 뜻하지 않는다.

마음카 RP034·스카이 RP033·미등록 공급사는 규칙 없음, 지원하지 않는 기간은 기간 규칙 없음, 미매칭 상품은 NO_MATCHING_RULE로 UNKNOWN이다. 손오공 구독·스타 렌트·퍼시픽 신차 등 협의는 `UNKNOWN / COORDINATION_REQUIRED`다. 신차 세부상품/기준 차량가액 미확정, RP004 연료 누락, 기존 규칙의 반올림/VAT 반올림 미정도 UNKNOWN이며 임의 환산하지 않는다. 명시적 0원만 ZERO다.

로컬 구현이며 운영 backfill·발행·배포·cutover는 없다. 저장값이 없는 기존 Offer는 새 승인된 저장까지 UNKNOWN이다. 새 필수 필드가 없는 구형 Admin release는 gateway 계약 검증에서 거절되므로 운영 도입 시 승인된 Canonical 저장 및 Admin release 재생성을 먼저 검증해야 한다.

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
