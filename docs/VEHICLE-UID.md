# 차량 UID 설계

작성일: 2026-10-10  
범위: 설계 문서만. 코드, Firestore, 시트, 배포 변경 없음.

## 배경

대표 결정: "차 한 대를 관리할 개별 UID 코드 -- 신차 번호 안 나온 애들은 차량번호로 못 한다."  
개발 총괄 승인안: 대리 키 + 외부 식별자 대응표.

운영 읽기 결과는 값 없이 건수만 사용한다. `products` 문서 키는 차량번호 1706/1776, 이안카 자체 ID 키 49, `RP023_<차량번호>` 접두 키 21이다. 차량번호 칸은 전부 있으나 번호 없는 신차는 현재 0건이고, 담을 길도 없다. `catalog_vehicle_assets` 160개 id는 `va_` + 해시(`plate`, 차량번호)이며 opaque라서 번호가 바뀌면 다른 차가 된다. VIN은 94건이다. 공급사 차량 ID는 이안카 `iancar_one_vehicle_id` 153, 손오공 원문 `id` 300, 아이언 URL UUID 35, 오토플러스 0, 시트 공급사 0이다.

## 결정

1. 기존 `catalog_vehicle_assets` 160개 id는 불변 그대로 Vehicle UID로 승격한다. 이유: 이미 소비처와 이력의 참조점이라 재발급하면 기존 자산 연결이 끊긴다.
2. 새 자산은 `va_` + ULID로 발급한다. 이유: 차량번호가 없어도 발급 가능하고 시간순 정렬과 불변성을 같이 얻는다.
3. 외부 식별자는 `VehicleAsset.externalIds[]` 필드로 둔다. 새 모음은 만들지 않는다. 이유: 자산 문서와 식별자 이력을 같은 revision/감사 단위로 묶어야 한다.
4. 같은 차 판정 순서는 VIN -> 공급사 코드 -> 차량번호다. 이유: VIN이 가장 강한 실물 식별자이고, 공급사 자체 ID가 그다음이며, 차량번호는 변경 가능한 외부 표식이다.
5. 애매하면 `UNKNOWN`으로 두고 새 UID를 만들지 않는다. 이유: 중복 UID 생성은 나중에 병합보다 위험하고 되돌리기 어렵다.
6. 번호가 나오면 같은 UID에 `PLATE`만 추가한다. 이유: 신차의 실물 자산은 그대로이고 외부 식별자만 늦게 생긴 것이다.
7. 번호가 바뀌면 이전 `PLATE`는 `validTo`로 닫고 이력을 유지한다. 이유: 과거 상품, 사진, 계약, 조회 로그가 과거 번호로 재현되어야 한다.

## 모델

`VehicleAsset` 확장 타입안:

```ts
type VehicleExternalIdKind = 'PLATE' | 'VIN' | 'SUPPLIER_VEHICLE' | 'SHEET_ROW';

type VehicleExternalId = {
  kind: VehicleExternalIdKind;
  supplierCode?: string;
  value: string;
  validFrom: string;
  validTo?: string | null;
  source: string;
};

type VehicleAsset = EntityMeta & {
  id: string;
  vehicleModelId: string;
  status: VehicleAssetStatus;
  plateNumber?: string | null; // 호환 투영용 현재 번호. 정본 이력은 externalIds.
  vin?: string | null;         // 호환 투영용 현재 VIN. 정본 이력은 externalIds.
  odometerKm?: number | null;
  externalIds?: VehicleExternalId[];
};
```

`products` 문서에는 `vehicle_uid` 칸을 추가한다. 상품 문서 키는 이전 완료 전까지 기존 번호 기반 키를 유지하고, `vehicle_uid`가 연결된 뒤 소비처 전환이 끝날 때까지 번호 키와 UID를 병행한다.

`RP023_<차량번호>` 접두 키 문서는 `vehicle_uid`를 부여한 뒤 상품 키 정리 대상이다. 접두 키 자체를 차량 UID로 쓰지 않는다. `iancar_<id>` 문서는 이안카 공급사 자체 ID를 `SUPPLIER_VEHICLE` externalId로 보존하고, 문서 키는 이전 완료 전 호환 키로만 둔다.

## 판정 알고리즘

```text
resolveVehicleUid(candidate):
  ids = normalizeExternalIds(candidate)

  # 1) 식별자마다 활성 자산 후보를 모은다(여러 개면 그 식별자 자체가 충돌).
  vin       = findActiveAssets(kind='VIN', value=ids.vin)                       # ids.vin 이 있을 때만
  supplier  = findActiveAssets(kind='SUPPLIER_VEHICLE', supplierCode=ids.supplierCode, value=ids.supplierVehicleId)
  plate     = findActiveAssets(kind='PLATE', value=ids.plate)
  for each in [vin, supplier, plate]: if many(each): return HOLD('<KIND>_CONFLICT')

  # 2) 어느 식별자든 가리키는 자산이 서로 다르면 HOLD (한 식별자만 맞아도 다른 식별자의 모순을 검사한다).
  linked = distinct(one(vin), one(supplier), one(plate))                         # 한 건씩 맞은 것만 모음
  if size(linked) > 1: return HOLD('IDENTIFIER_POINTS_TO_DIFFERENT_ASSETS')

  # 3) 후보가 하나면 강한 모순부터 검사하고, 하나라도 있으면 새 UID 를 만들지 않고 HOLD.
  if size(linked) == 1:
    asset = linked[0]
    if contradicts(asset, ids):                                                  # 아래 모순 정의
      return HOLD('IDENTIFIER_CONTRADICTION')                                    # CREATE 로 내려가지 않는다
    return LINK(asset, reason = first_matched(VIN, SUPPLIER_VEHICLE, PLATE))     # VIN → 공급사 코드 → 차량번호 순

  # 4) 아무 식별자도 기존 자산과 맞지 않을 때만 신규 UID.
  if hasStableIdentity(ids.vin or ids.supplierVehicleId or ids.plate):
    return CREATE(newUlidVehicleUid(), ids)
  return UNKNOWN('INSUFFICIENT_IDENTITY')

contradicts(asset, ids):                                                         # 모순 = 같은 종류의 활성 값이 서로 다름
  - ids.vin 이 있고 asset 의 활성 VIN 이 있는데 값이 다르다
  - ids.supplierVehicleId 가 있고 asset 에 같은 공급사의 활성 SUPPLIER_VEHICLE 이 있는데 값이 다르다
  - ids.plate 가 asset 의 활성 PLATE 와 다르다 → 단, VIN 또는 공급사 ID 가 일치한 경우의 «번호 변경»은 모순이 아니다
    (그 번호를 이미 다른 활성 자산이 쓰고 있으면 2)에서 HOLD)
```

## 충돌 처리표

| 상황 | 처리 | 이유 |
| --- | --- | --- |
| VIN 같고 번호 다름 | 같은 UID 후보. 새 번호는 `PLATE` 추가, 이전 번호는 필요 시 `validTo`로 닫음. 단, 동시 활성 번호가 복수면 HOLD. | 번호 변경 가능성을 VIN보다 낮게 본다. |
| 번호 같고 VIN 다름 (번호 1건 일치 + VIN 불일치 포함) | HOLD(IDENTIFIER_CONTRADICTION), 새 UID 만들지 않음 — CREATE 로 내려가지 않는다. | 같은 번호의 재사용/오입력 가능성이 있어 사람 판정 필요. |
| 공급사 코드만 같음 | 같은 `supplierCode + value`면 링크, 공급사 코드만 같고 값이 없으면 UNKNOWN. | 공급사 자체 ID 없는 공급사명만으로는 실물 식별 불가. |
| 번호 두 공급사에 중복 | VIN 또는 공급사 자체 ID가 같으면 링크 후보, 다르면 HOLD. | 번호 중복은 실제 운영에서 접두 키나 공급사 중복으로 발생할 수 있다. |

## 번호 키로 읽는 곳 인벤토리

이 저장소 grep 기준이다. 공개 문서에는 실제 번호·VIN·시트 ID를 남기지 않는다.

| 파일:줄 | 현재 의존 | 이전 방향 |
| --- | --- | --- |
| `src/jobs/ingest-shared-sheet-canonical.ts:117` | `plateNumber`로 기존 asset 매칭 | `externalIds` 기반 UID resolver로 교체 |
| `src/jobs/ingest-shared-sheet-canonical.ts:128` | 신규 asset id를 `opaque('va','plate', carNumber)`로 발급 | `va_` + ULID 발급으로 교체, 옛 160개는 유지 |
| `src/jobs/ingest-shared-sheet-canonical.ts:133-134` | `getProduct(...)`로 번호/원천 기반 상품 충돌 확인 | `vehicle_uid` 연결 후 상품 충돌 기준 보강 |
| `src/jobs/ingest-shared-sheet-canonical.ts:268` | binding의 productId로 상품 조회 | `vehicle_uid`가 있는 상품 우선 확인 |
| `src/application/canonicalize-catalog-candidate.ts:559-596` | `carNumber`가 있어야 VehicleAsset CREATE/LINK 가능, `plateNumber` 충돌 검사 | 번호 없는 신차도 UID 판정 가능하게 변경 |
| `src/domain/catalog.ts:26` | `VehicleAsset`에 `plateNumber`, `vin` 단일 현재값 | `externalIds[]` 이력 필드 추가 |
| `src/infra/erp5-compat-catalog-reader.ts:104-123` | legacy `car_number`와 이안카 ID로 사진 읽기 | `vehicle_uid`와 externalIds 병행 수용 |
| `src/domain/consumer-output-contract.ts:43-92` | 번호 문자로 손오공 상품군/렌트 판정 | UID와 별개로 현재 PLATE가 없으면 HOLD 유지 |
| `src/infra/iancar-policy-sync-firestore.ts:54-130` | `car_number`/`vehicle_number` normalize 매칭 | 공급사 ID 우선, 번호는 보조 |
| `src/infra/iancar-publication-withdrawal-firestore.ts:200-270` | 번호 set으로 철회/관측 비교 | UID 또는 공급사 ID 기준으로 보강 |
| `src/application/kakao-catalog-reference.ts:792-827` | `plateNumber` query filter | UID 필터 추가, 번호 필터는 호환 유지 |
| `src/application/kakao-source-intake.ts:47,216` | 조회/응답 identity를 번호로 비교 | UID가 있으면 UID 우선 비교 |
| `src/application/settlement-id-link-audit.ts:105-121` | products/contracts를 번호 snapshot으로 연결 | 계약·정산에는 `vehicle_uid` snapshot 추가 |
| `src/application/vehicle-media-evidence.ts:28-203` | 상품/소비처/원천 사진 증거를 번호로 대조 | 사진 증거 key를 UID 또는 공급사 ID 우선으로 변경 |
| `src/jobs/query-canonical-by-plate.ts:12` | 번호로 canonical asset 조회 | `query-canonical-by-uid` 추가 후 plate 조회는 보조 |
| `src/jobs/collect-iancar-one-api.ts:60-62` | 이안카 ID + 번호로 사진 record 생성 | `vehicle_uid` 포함 |
| `src/jobs/collect-iancar-direct.ts:63-66` | `car_number` 없으면 invalid | 공급사 자체 ID가 있으면 번호 없음 허용 |

확인 필요 목록: ERP4 feed, ERP5, 카톡 조회 `프리패스안내.mjs`, 사진 프록시. 특히 사진 프록시 키 `vehiclePhotoKey`는 `supplier_vehicle_id`가 있으면 `(공급사, ID)`, 없으면 `(공급사, 차번 해시)`이므로 UID 이전과 함께 번호 해시 fallback 폐기 시점을 별도 확인한다.

## 이전 단계표

| 날짜 | 단계 | 완료 증거 |
| --- | --- | --- |
| 2026-10-11 | 설계 확정 | 이 문서 승인, 열린 질문 해소 또는 HOLD 표시 |
| 2026-10-12 | 발급 함수·판정 코드 | 새 UID 발급 «추가» + resolver 단위 테스트 PASS (옛 hash 발급은 아직 지우지 않는다) |
| 2026-10-13 | 이전 계획 -> 시험 -> digest -> 적용 -> 되읽기 | products 1776·assets 160에 `vehicle_uid`·`externalIds` 부여, 전후 대수 대조, digest 기록, 실패 시 되돌림 절차 검증 |
| 2026-10-14 | 소비처 전환·되읽기 뒤 옛 길 삭제 | 읽기 쪽 UID 수용 확인, 쓰기 전환 확인, 소비처(ERP5·카톡·사진 프록시) readback 통과 «뒤에» 옛 hash 발급 코드와 번호 키 전용 읽기 삭제 PR, 회귀 테스트 PASS |

## 호환 순서

ERP5·카톡이 멈추지 않게 읽기 쪽을 먼저 바꾼다. 1단계는 기존 번호 키 읽기에 `vehicle_uid`를 추가 수용한다. 2단계는 쓰기·발행 경로가 `vehicle_uid`와 externalIds를 함께 쓴다. 3단계는 products 키를 유지한 채 소비처 readback을 끝낸다. 4단계에서만 번호 키 전용 읽기와 옛 hash 발급 경로를 삭제한다.

**무중단 순서는 이 하나다(단계표와 같음): ① 새 UID 발급 «추가»(10-12, 옛 hash 발급 유지) → ② 이전 적용·소비처 전환·되읽기(10-13~14) → ③ 소비처 readback 통과 «뒤에» 옛 hash 발급과 번호 키 전용 읽기 삭제(10-14).** 어느 단계에서도 옛 길을 먼저 지우지 않는다.

## 열린 질문

1. 손오공 원문 `id` 300건을 별도 전용 칸 없이 `SUPPLIER_VEHICLE`로 승격해도 되는가.
2. 시트 공급사 0건의 `SHEET_ROW` externalId는 어느 안정 키를 쓸 것인가: 공급사 코드 + 탭 + 행번호는 행 이동에 약하므로 별도 원천 row id가 필요하다.
3. `plateNumber`/`vin` 단일 필드를 계속 현재값 캐시로 유지할 것인가, 아니면 소비처 전환 뒤 projection 전용으로만 남길 것인가.

## 폐기 목록

- `opaque('va','plate', carNumber)` 신규 발급 코드.
- 번호만으로 VehicleAsset CREATE/LINK를 강제하는 경로.
- products 문서 키를 차량 정체성으로 보는 읽기 경로.
- 사진 프록시의 `(공급사, 차번 해시)` 신규 생성 fallback.
- 번호 전용 조회 job/API. 단, 이력 조회용 plate filter는 UID resolver 뒤 보조 기능으로만 유지한다.

## 재사용 판정

쓴 것: 기존 `VehicleAsset`, `Product.vehicleAssetId`, source binding, lineage/audit/revision 구조를 그대로 확장한다.  
못 쓴 것: 현재 `va_` + plate hash 발급은 번호 없는 신차와 번호 변경을 표현하지 못해 신규 발급에는 재사용하지 않는다.

## 구현 상태(10-12)

`src/domain/catalog.ts`에 `VehicleExternalId`/`VehicleExternalIdKind`와 `VehicleAsset.externalIds?: VehicleExternalId[]`를 옵션 필드로 추가했고, `src/domain/vehicle-uid.ts`에 순수 UID 발급(`va_` + ULID), 기존 24hex hash ID 구분, externalId 정규화, 활성 식별자 판정, resolver, `addExternalId` 이력 갱신 함수를 넣었다. `src/jobs/ingest-shared-sheet-canonical.ts`의 옛 `opaque('va','plate', carNumber)` 발급은 삭제하지 않고 `issueVehicleAssetId` 기본 전략(`LEGACY_PLATE_HASH`) 뒤에 두었으며, ULID 전략은 10-13~10-14 소비처 readback 전까지 기본 호출 경로가 아니다. `tests/vehicle-uid.test.ts`가 ULID 형식/정렬/단조 증가/결정적 주입, 충돌 처리표, 번호 없는 신차 생성 후 번호 추가, 입력 불변과 이력 갱신을 검증한다.

## 재사용 판정

쓴 것: 기존 `VehicleAsset`, `Product.vehicleAssetId`, source binding, lineage/audit/revision 구조를 그대로 확장한다.  
못 쓴 것: 현재 `va_` + plate hash 발급은 번호 없는 신차와 번호 변경을 표현하지 못해 신규 발급에는 재사용하지 않는다.

## 10-13 이전 계획기

범위: 이 PR은 읽기 전용 계획기와 분석 문서까지만 포함한다. 운영 적용기, Firestore 쓰기, `products`/`catalog_vehicle_assets` 변경 코드는 없다. 공개 문서와 stdout에는 상품 키, 차량번호, VIN, 시트 ID를 싣지 않고 sha256 앞 12자리 해시와 건수만 둔다. 테스트 데이터의 식별자는 `TEST-FAKE-*`만 쓴다.

계획기는 순차 단건 확정이 아니라 식별자 그래프를 먼저 만든다. 상품이 가진 번호·VIN·공급사 범위 차량 ID·시트 행·기존 binding asset과 기존 asset의 활성 식별자를 노드로 두고 같은 상품/asset 안의 식별자를 union-find로 묶은 뒤, 묶음별로 기존 asset 둘 이상 또는 같은 종류 식별자 값 충돌을 판정한다. 충돌 묶음은 선행 상품까지 모두 `GRAPH_COMPONENT_CONFLICT` HOLD로 남기며, 깨끗한 묶음은 기존 asset 하나면 그 UID로 LINK하고 asset이 없으면 묶음 대표 키 정렬순으로 계획 생성 시 UID를 고정한다. 적용은 HOLD 묶음 제외, HOLD 목록은 확인 동선으로 보낸다.

실행:

```powershell
$env:VEHICLE_UID_PLAN_OUT="C:\temp\freepass-private\vehicle-uid-plan.json"
npm.cmd run plan:vehicle-uid-migration
```

`VEHICLE_UID_PLAN_OUT`은 저장소 밖 절대경로여야 하며, 기존 `writePrivateArtifact`가 같은 경로 덮어쓰기와 checkout 내부 저장을 거부한다. stdout은 `writes: 0`, products/assets 건수, 종류별 건수, 이유별 건수, `planDigest`, 공개 보고 digest만 출력한다. 전체 계획 파일에는 원본 `productKey`가 포함되므로 비공개 증거로 취급한다.

계획 항목:

| kind | 의미 | 적용 전제 |
| --- | --- | --- |
| `ASSET_ADD_EXTERNAL_IDS` | 기존 `catalog_vehicle_assets` id는 그대로 두고 `PLATE`, `VIN` externalIds를 추가할 계획. `validFrom`은 asset `createdAt`. | 별도 적용 PR에서 digest 승인과 readback 필요. |
| `PRODUCT_SET_UID` | legacy `products` 문서에 `vehicle_uid`를 붙일 계획. binding asset, 단일 plate match, 계획에 고정된 신규 ULID 중 하나. | 적용기는 이번 PR에 없음. 신규 UID는 계획 생성 때 박아 digest를 고정한다. |
| `HOLD` | 접두 키 문서, 이안카 자체 키 문서, 번호 중복, VIN 모순, resolver HOLD/UNKNOWN 등 사람 확인 대상. | 새 UID를 만들지 않는다. |

계획 불변식:

| 항목 | 판정 |
| --- | --- |
| 기존 asset 160 id 불변 | 계획은 기존 asset id를 변경하지 않고 `externalIds` 추가만 표현한다. |
| products 수 불변 | `PRODUCT_SET_UID`는 필드 추가 계획만 만들며 문서 생성/삭제가 없다. |
| 한 UID에 활성 PLATE 하나 | planner summary의 `oneActivePlatePerUid`가 false면 적용 금지. |

`products` 쓰기 경로의 `vehicle_uid` 보존 분석:

| 경로 | 쓰기 방식 | `vehicle_uid` 보존 판정 |
| --- | --- | --- |
| `src/infra/autoplus-policy-repair-firestore.ts:66`, `:86` | `transaction.update(snapshot.ref, {...})` 필드 단위 정정 | 보존. 지정 필드만 갱신한다. |
| `src/infra/billincar-policy-repair-firestore.ts:65` | `transaction.update(snapshot.ref, {...})` 필드 단위 policy link | 보존. 지정 필드만 갱신한다. |
| `src/infra/iancar-policy-sync-firestore.ts:111` | `transaction.update(snap.ref, {...})` 필드 단위 policy link | 보존. 지정 필드만 갱신한다. |
| `src/infra/iancar-publication-withdrawal-firestore.ts:128` | `tx.update(ref, p.patch)` photo/status patch | 보존. patch가 `vehicle_uid`를 포함하지 않는 한 기존 필드는 유지된다. 적용 전 patch allowlist에 `vehicle_uid` 금지 확인 권장. |
| `src/infra/iancar-publication-withdrawal-firestore.ts:321` | 기존 문서는 `tx.update(ref, row.fields)`, 신규 문서는 `tx.create(ref, row.fields)` | 기존 문서 보존. 신규 문서는 `vehicle_uid`가 없을 수 있으므로 UID 적용 뒤 같은 writer를 다시 쓰려면 생성 경로에 UID resolver 연결 필요. |
| `src/infra/iancar-publication-withdrawal-firestore.ts:377` | `tx.update(ref, patch)` restore patch | 보존. 지정 필드만 갱신한다. |
| `src/infra/iancar-publication-withdrawal-firestore.ts:432` | `transaction.update(doc.ref, {...})` withdrawal status patch | 보존. 지정 필드만 갱신한다. |
| `src/infra/vehicle-name-reference-repair-firestore.ts:860` | `transaction.update(ref, update)` products name/source repair | 보존. update 객체는 이름/원문 정정 계열 필드 단위다. 적용 전 `vehicle_uid`가 update에 포함되지 않는 회귀 확인 필요. |
| `src/infra/erp5-compat-catalog-reader.ts:120`, `:135`, `:195` | 읽기 전용 | 보존. 쓰기 없음. |
| `src/adapters/legacy-freepasserp3.ts:40` | 읽기 전용 source adapter | 보존. 쓰기 없음. |
| `.github/workflows/shared-sheet-daily.yml:238-239` | source supplement merge 실행 | 직접 products 쓰기 아님. 하위 job이 products writer를 호출하는 경우 별도 적용 전 재확인. |
| `.github/workflows/erp5-continuous-audit.yml:401`, `:610`, `:635`, `:650` | audit/read/report | 보존. 쓰기 없음. |
| `.github/workflows/deploy-read-runtime.yml:202` | read-runtime response shape check | 보존. 쓰기 없음. |

적용 전에 고칠 것:

- `src/infra/iancar-publication-withdrawal-firestore.ts:321`의 신규 create 경로는 `vehicle_uid`를 모르는 legacy `products` 생성이 가능하므로, UID 적용 전 또는 같은 적용 PR에서 UID resolver/plan digest 연동이 필요하다.
- `src/infra/iancar-publication-withdrawal-firestore.ts:128` 및 `src/infra/vehicle-name-reference-repair-firestore.ts:860`은 현재 필드 단위라 보존되지만, `vehicle_uid`를 patch/update에 넣지 않는 회귀 테스트를 적용 PR에 추가한다.
- source ingest/data-owned refresh가 legacy `products`를 직접 덮어쓰는 새 경로가 생기면 `set`/replace 금지 또는 `merge/update` 보존 검사를 먼저 추가한다.
