# 비현대·기아·제네시스 차량 추가 패킷 — 2026-10-31

최신 직접 지시: 현대·기아·제네시스를 제외하고 카메치 모델·파워트레인·세부 트림을 넣고 제조사 자료도 확인한다. 기존 HKG 정본·배타그룹은 이번 패킷에서 변경하지 않는다.

## 실제 상태

201개 visible 원본 행을 추가 후보로 전량 보존했다. 40은 원본 모델명 수이며 정규화 후 실제 모델 수가 아니다. 제조사 검증은 부분 완료이며 현재 운영 정본 추가·판매 노출·소비처 연결은 미완료다. 현재 로그인 계정의 브랜드 메뉴에서는 HKG 다섯 분류만 확인했다. 원본 visible=true를 이 계정의 판매 권한으로 간주하지 않는다.

- `candidates.json`: 공급사 ID와 원문 모델/lineup/trim/가격, 원본 SHA256 및 pinned provenance. 미확정 canonical ID와 연식은 null. 원본 lineup은 POWERTRAIN으로 자동 확정하지 않는다.
- `manufacturer-review.json`: 제조사 URL, 10개 발견 그룹과 영향 원본 ID, 확인 범위·남은 검토. 공식 문서 날짜와 차량 연식은 별개다.
- `validation.json`: 원본 201행 ID 집합 및 5개 원문 필드 전량 대사 결과. 정확성 전체 PASS가 아니다.

## 브랜드별 원본 범위

| 브랜드 | 모델명 수 | 원본 행 수 |
|---|---:|---:|
| BMW | 17 | 105 |
| 벤츠 | 14 | 54 |
| KGM | 6 | 26 |
| 르노 | 2 | 14 |
| 폭스바겐 | 1 | 2 |

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
| KGM | 엑티언 | 2 |
| KGM | 엑티언 하이브리드 | 1 |
| KGM | 토레스 | 8 |
| KGM | 토레스 하이브리드 | 3 |
| KGM | 티볼리 | 4 |
| 르노 | Filante | 4 |
| 르노 | Grand Koleos | 10 |
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

## 적재 연결

기존 Data 차종 기준·stable ID를 따른다. KGM/르노는 기존 모델과 먼저 대조하여 중복 추가를 막는다. BMW EV가 내연기관 시리즈에 섞인 원본은 별도 모델/차체를 확인한다. VW 두 원본 ID는 삭제하지 않고 동일 정본 매핑 후보로 둔다. 0원·의심 가격을 견적가로 사용하거나 최신 제조사 가격으로 무조건 덮어쓰지 않는다.

[현행 적재 규칙](../../VEHICLE-MASTER-REFERENCE-IMPORT.md): `ingest:vehicle-reference`는 `VEHICLE_REFERENCE_IMPORT_BLOCKED`로 막혀 있다. 기존 capture → ingest → promote를 사용해야 한다. 이 패킷은 새 DB writer/두 번째 마스터/런타임 가격표를 만들지 않는다. 기존 parser의 modelYear는 필수인데 원본에는 대부분 연식이 없다. 현재 연도를 임의 주입해 승격하지 않는다.

다음 실행에는 현 ACTIVE release와 canonical ID/연식 대조, 미확인 트림 공식 근거, 기존 source lifecycle 적재 및 소비처 되읽기 영수증이 필요하다. 수수료/웰릭스/옵션 배타 로직은 이번 파일에서 변경하지 않았다.

## 재현

Estimate pinned snapshot을 내려받아 다음을 실행한다. Python은 validation 보고서 생성 시에만 사용했으며 추출기는 Node 내장 모듈만 사용한다.

```sh
node scripts/prepare-vehicle-expansion.mjs /path/to/catalog.snapshot.json.gz /tmp/candidates.json
node --test scripts/prepare-vehicle-expansion.test.mjs
```

검증: 추출기 경계 회귀 5 PASS, 실제 source ID 집합 201/201·원문 필드 차이 0·HKG 0·잘못 연결된 finding ID 0. 제조사 트림 전수 확인/운영 persistence/배포/소비처 검증 완료를 뜻하지 않는다.
