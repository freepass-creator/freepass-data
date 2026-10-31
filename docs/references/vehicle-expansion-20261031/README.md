# 비HKG 차량 추가 패킷 — 2026-10-31

## 최신 직접 지시: 데이터 보유와 운영 개방 분리

신용무관·신용심사·소득확인 중 일부 유형에서만 취급하더라도 차량 데이터는 보유한다. 운영하지 않는다는 이유로 차량/파워트레인/트림 데이터를 제외하거나 삭제하지 않는다. 이전 visible-only 201행 범위를 대체하여 숨김 46행도 추가 보존했다.

차량 정본의 정확성/검증 상태와 공급사·상품·심사 유형별 운영 상태는 서로 다른 축이다. `visible`, `creditTypes` 원문은 보존하지만 운영 허가로 자동 해석하지 않는다. 소득확인만 열리는 상황은 예시이며 지금 어떤 유형도 새로 열라는 지시가 아니다. 심사 유형의 내부 키는 기존 상품 정책 확인 후 매핑하고 새 이름/코드를 임의 생성하지 않는다.

- 차량 정본: 제조사·모델·연식·파워트레인·트림·옵션·색상·제조사 가격 및 근거를 보유한다.
- 상품 운영: 공급사/상품/심사 유형에 따라 조회 노출·신규 견적·계약 접수 가능 여부를 판정한다. 화면 숨김과 서버 견적 허용은 별도로 일관되게 검사해야 한다.
- 미운영 데이터는 보존하고 해당 상품의 노출/견적/접수를 닫는다. 소득확인에서만 열려도 공통 차량 ID는 하나다.
- 미확인 운영 범위는 자동 개방하지 않는다. 검증 미완료 데이터 역시 보존하되 확정 데이터처럼 사용하지 않는다.

## 실제 범위

전체 247행 / 원본 모델명 45개, visible 201 / hidden 46. 원본 모델명 수는 정규화 후 모델 수가 아니다. 현대·기아·제네시스 및 HKG EV 분류는 제외한다.

| 브랜드 | 원본 모델명 수 | 전체 행 수 |
|---|---:|---:|
| BMW | 17 | 105 |
| 벤츠 | 14 | 54 |
| KGM | 9 | 64 |
| 르노 | 4 | 22 |
| 폭스바겐 | 1 | 2 |

## 파일과 검증

- `candidates.json`: 원본 ID, 모델/lineup/trim/가격/visible/creditTypes, pinned source provenance와 SHA256. canonical ID와 연식 미확정은 null. raw lineup을 일괄 POWERTRAIN으로 확정하지 않는다.
- `manufacturer-review.json`: 공식 근거와 발견10그룹/영향13행. 공식 검증은 PARTIAL이며 이번 숨김46행도 별도 전수 검증 완료가 아니다.
- `validation.json`: 전체 원본 ID와 7개 원문 필드 대사 결과. 6개 경계 회귀 PASS. 운영 writes/개방/배포0.

현재 계정 메뉴에 없는 브랜드도 원본 데이터 보유 범위에서 제외하지 않는다. 원본 visible=true 역시 현재 계정의 판매 가능 증거가 아니다. 운영 가능 목록은 기존 공급사/상품 정책의 별도 확인 대상이다.

## 실제 적재와 남음

기존 KGM/르노 정본 ID를 먼저 대조해 중복을 막는다. BMW의 EV 혼합 가족, VW Pro/Lite와 두 원본 ID, Z4/X4 등은 제조사·연식·차체·파워트레인과 대조한다. source 가격을 정본에 덮어쓰지 않는다.

[현행 적재 규칙](../../VEHICLE-MASTER-REFERENCE-IMPORT.md)의 차단된 reference importer는 재개하지 않는다. 기존 capture → ingest → promote를 이용한다. 현재 ACTIVE 정본 ID/연식 대조, 미확인 트림 제조사 확인, 실제 적재 영수증과 Estimate 소비처 되읽기가 남았다. 이번 변경은 후보 추출 코드/데이터/설명 수정이며 운영 정본 추가나 상품별 운영 스위치 구현·연결 완료가 아니다. 수수료·웰릭스·옵션 배타 로직 변경도 없다.

## 재현

```sh
node scripts/prepare-vehicle-expansion.mjs /path/to/catalog.snapshot.json.gz /tmp/candidates.json
node --test scripts/prepare-vehicle-expansion.test.mjs
```

## 모델별 원본 목록

| 브랜드 | 원본 모델명 | 행 수 |
|---|---|---:|
| BMW | iX (i20)Series | 3 |
| BMW | 1 Series | 3 |
| BMW | 2 Series | 8 |
| BMW | 3 Series | 9 |
| BMW | 4 Series | 6 |
| BMW | 5 Series | 15 |
| BMW | 7 Series | 9 |
| BMW | 8 Series | 1 |
| BMW | X1 Series | 8 |
| BMW | X2 Series | 3 |
| BMW | X3 Series | 8 |
| BMW | X4 Series | 4 |
| BMW | X5 Series | 11 |
| BMW | X6 Series | 5 |
| BMW | X7 Series | 9 |
| BMW | XM Label | 1 |
| BMW | Z4 | 2 |
| KGM | 렉스턴 뉴 아레나 | 8 |
| KGM | 무쏘 | 30 |
| KGM | 무쏘 EV | 4 |
| KGM | 엑티언 | 2 |
| KGM | 엑티언 하이브리드 | 1 |
| KGM | 토레스 | 8 |
| KGM | 토레스 EVX | 4 |
| KGM | 토레스 하이브리드 | 3 |
| KGM | 티볼리 | 4 |
| 르노 | Arkana | 5 |
| 르노 | Filante | 4 |
| 르노 | Grand Koleos | 10 |
| 르노 | SCENIC | 3 |
| 벤츠 | A-Class | 2 |
| 벤츠 | C-Class | 2 |
| 벤츠 | CLE | 8 |
| 벤츠 | E-Class | 7 |
| 벤츠 | EQA | 2 |
| 벤츠 | EQB | 2 |
| 벤츠 | EQE | 3 |
| 벤츠 | EQS | 2 |
| 벤츠 | GLA | 1 |
| 벤츠 | GLB | 2 |
| 벤츠 | GLC | 7 |
| 벤츠 | GLE | 7 |
| 벤츠 | G바겐 | 5 |
| 벤츠 | S-Class | 4 |
| 폭스바겐 | ID4 | 2 |
