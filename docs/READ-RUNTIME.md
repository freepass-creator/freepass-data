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

## Consumer capabilities

### 수수료 연동 기준 — 사용자 결정 2026-09-30

**프리패스 수수료는 지급수수료(`channelPayoutFee`)다.** FreePass가 영업채널에 지급하는 금액이며, 공급사로부터 받는 청구수수료나 내부 마진을 뜻하지 않는다.

| 연동 대상 | 제공할 수수료 | 지급 방향 |
|---|---|---|
| 영업채널 / 기본 수수료 연동 | `channelPayoutFee` — 프리패스 수수료 | FreePass → 해당 영업채널 |
| 공급사 | `supplierBillingFee` — 공급사 청구수수료 | 해당 공급사 → FreePass |

`src/domain/catalog.ts`의 `COMMISSION_CONSUMER_POLICY`와 `projectCounterpartyCommission`이 이름과 선택 규칙의 실행 정본이다. 두 외부용 projection은 상대편 수수료, 마진, 내부 산식·원천 참조를 포함하지 않는다. 미확정은 `UNKNOWN`/null, 명시적 0원은 `ZERO`/0이며 기간별 값을 유지한다.

이 helper는 **PREPARED** 상태다. 신규 공급사/영업채널 API와 운영 등록은 아직 연결되지 않았다. 운영 API에 연결할 때 audience와 공급사/영업채널 ID 범위는 서버가 등록된 전용키의 grant에서 결정해야 한다. 요청의 query/body로 audience를 바꾸거나 다른 공급사·채널을 조회할 수 있게 만들지 않는다. 상대별 계약조건이 다르면 해당 조건을 조회하고, 없으면 공통 기준을 확정 지급액으로 간주하지 않고 HOLD한다.

기존 Kakao `catalog-reference`는 내부 업무용으로 양쪽 수수료와 예상 마진을 포함하는 별도 계약이다. 이 응답과 키를 외부 공급사/영업채널에 전달하지 않는다. 현재 public ERP/화이트라벨 projection에는 내부 수수료를 추가하지 않는다. 외부 연동 완료는 전용 계약·scope 차단 테스트·인증된 운영 readback 이후에만 선언한다.

Registration fields:

- `id`: `erp-com`, `kakao-ops`, `freepass-estimate`, `freepass-admin-catalog`, or `whitelabel-<slug>`
- `projectionId`: currently only `erp-public`
- `token`: unique backend token, minimum 32 characters
- `capabilities`: optional

Capability rules:

- omitted `capabilities` => `["catalog"]`; `catalog-reference` must be granted explicitly to `kakao-ops`
- `catalog` => ERP public projection read
- `catalog-reference` => Kakao-only, typed `REFERENCE_ONLY` ERP5 facts; it never means Canonical ACTIVE
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
- returns the verified F80-F85 sales-commission policy snapshot and term-level calculated,
  coordination-required, unknown, or not-applicable result;
- always returns `authority=REFERENCE_ONLY` and `publicationDecision=HOLD`.

This route is an explicit migration bridge, not a silent fallback for `/catalog`. Kakao must opt into
the route and must not convert its response into a Canonical ACTIVE claim.

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
