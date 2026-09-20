# FreePass Data Migration Plan

Status: BASELINE
Date: 2026-09-20

## 1. 현재 확인된 구조

| Project | Current data state | Target relation |
|---|---|---|
| FreePass Admin | Production Product/Application DB NOT VERIFIED. Domain SSOT/Port/Adapter 구조는 준비 중 | FreePass Data contract consumer + command client |
| FreePass Sales | `welrixtable` Firestore 직접 사용. leads/calls/users/config 운영 | 단계적 migration. workflow는 Sales 소유, persistence/data access는 Data contract로 이동 |
| FreePass Estimate | 견적 기능 SSOT / upstream | vehicle/product/pricing input consumer, quote output writer 후보 |
| freepasserp4 / ERP.com legacy | `freepasserp3` Firebase binding. Firestore + RTDB + Storage 설정 존재 | 공개 catalog projection consumer. RTDB는 migration debt |
| FreePass Data | 신규 repo | Central data platform |

## 2. 전환 원칙

Big-bang migration을 하지 않는다.

```
LEGACY_DIRECT
   ↓
OBSERVE
   ↓
SHADOW_READ
   ↓
PARITY_VERIFIED
   ↓
DATA_GATEWAY_READ
   ↓
COMMAND_WRITE
   ↓
DIRECT_ACCESS_BLOCKED
```

각 consumer를 독립적으로 이동한다.

## 3. Phase 0 — Inventory

목표:
- current source map
- collection/path map
- writer map
- consumer map
- schema drift map
- Firebase project binding map
- freshness map

이 단계에서는 production data를 변경하지 않는다.

산출물:
- source-registry
- consumer-registry
- entity-registry
- field-authority-registry
- migration-status

## 4. Phase 1 — Product / Vehicle / Pricing 우선 중앙화

첫 대상:
- Product
- Vehicle
- Offer
- Pricing
- Policy

이유:
- Admin, Sales, ERP.com, Estimate가 공통으로 필요
- PII가 없어 migration 위험이 상대적으로 낮음
- 동일 상품 정본이 앱별로 생기는 문제를 먼저 제거 가능

Flow:

```
legacy firebase / sheet / partner
          ↓
      adapters
          ↓
 raw + normalized
          ↓
 canonical catalog
          ↓
  projection gateway
   ├─ Admin
   ├─ Sales
   ├─ ERP.com
   └─ Estimate
```

## 5. Phase 2 — Shadow Read

각 앱은 일정 기간 기존 결과와 FreePass Data 결과를 동시에 읽어 비교한다.

사용자에게 보여주는 값은 아직 legacy.
FreePass Data는 shadow.

비교:
- record count
- entity identity
- price
- deposit
- term
- status
- freshness
- missing/extra
- mapping conflict

기준을 충족하면 consumer 하나씩 read cutover.

## 6. Phase 3 — Read Cutover

앱의 read source를 FreePass Data로 변경한다.

중요:
- UI는 entity contract만 안다.
- Firebase project id / collection path는 consumer 코드에서 제거한다.
- cache/projection 사용 여부는 Data 내부 구현으로 숨긴다.

## 7. Phase 4 — Write Cutover

모든 write는 command gateway를 통과한다.

초기:
- Admin product override
- price/deposit/policy update

후속:
- quote persistence
- Sales customer/status
- application/contract
- settlement

write cutover 조건:
- idempotency
- revision conflict
- audit
- rollback/recovery
- permission
- receipt
가 검증되어야 한다.

## 8. Phase 5 — Direct Firebase Access 차단

consumer repo CI에서:
- 금지된 Firebase SDK import
- 금지된 collection/path string
- 금지된 RTDB 사용
을 검출한다.

예외는 migration adapter에만 허용한다.

## 9. Sales migration

Sales는 현재 실제 운영 중이므로 마지막까지 안정성을 우선한다.

1. leads/status/calls schema inventory
2. read model shadow
3. status/calls append behavior parity
4. read cutover
5. command write shadow/receipt
6. write cutover
7. legacy Firestore path read-only
8. retire

Sales workflow semantics는 Sales repo가 계속 소유한다.
FreePass Data는 저장/조회/lineage/audit contract를 제공한다.

## 10. ERP4 / RTDB migration

freepasserp4에 RTDB rules/config가 남아 있는 것은 target architecture가 아니다.

- 신규 RTDB writer 금지
- RTDB path inventory
- Firestore/canonical mapping
- shadow parity
- consumer cutover
- read-only
- retirement evidence

"파일이 남아 있음"과 "운영에서 사용 중"은 구분한다. 실제 retirement는 runtime evidence 후 판정한다.

## 11. 완료 기준

consumer 하나가 FreePass Data migration 완료로 표시되려면:

- no direct production Firebase read
- no direct production Firebase write
- contract version pinned
- revision/freshness observable
- write receipt observable
- lineage available
- rollback/recovery documented
- auth scope verified
- runtime smoke verified

CI green만으로 migration complete를 선언하지 않는다.
