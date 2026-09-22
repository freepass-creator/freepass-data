# FreePass Data 도메인 카탈로그

상태: **EXECUTABLE BASELINE / LIVE INVENTORY REFRESH REQUIRED**  
실행 정본: `src/domain/data-domain-catalog.ts`

## 목적

사람이 Firestore collection 이름, 시트 URL, 과거 작업 경로를 기억하지 않아도
“상품”, “정산”, “F86”, “고객”, “계약” 같은 업무 용어로 데이터의 위치와 상태를
찾을 수 있게 한다.

```powershell
npm run data:catalog
npm run data:catalog -- F86
npm run data:catalog -- 정산
npm run data:catalog -- products
```

결과는 도메인, 데이터 자산, 시스템/위치, 정본 역할, 키, 민감도, freshness,
계약, 소비처와 현재 제공 상태를 JSON으로 반환한다. 원문 데이터나 자격증명은 출력하지 않는다.

## 분류 원칙

- `도메인`: 상품·고객·계약·정산·견적처럼 업무 의미가 같은 묶음
- `자산`: 실제 Firestore collection, Google Sheet, API, Projection, 문서 저장소
- `authority`: SOURCE / RAW_EVIDENCE / CANONICAL / PROJECTION / WORKFLOW / OUTPUT
- `ownership`: FreePass Data 소유, 업무 도메인 소유, 원천 소유, 소비처 출력
- `sensitivity`: PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED
- `availability`: AVAILABLE / PARTIAL / HOLD / UNAVAILABLE

새 collection이나 시트가 관측됐는데 등록되어 있지 않으면 이름으로 추측 분류하지 않는다.
`UNCLASSIFIED/HOLD`로 올리고 정본·키·writer·민감도를 검토한 뒤 등록한다.
오래된 inventory는 `STALE`이며 현재 데이터가 있다고 주장하는 근거로 쓰지 않는다.

## 현재 도메인

| 도메인 | 소유 경계 | 현재 상태 |
|---|---|---|
| 상품·차량·가격·정책 | FreePass Data Catalog | PARTIAL / Catalog V1 |
| 고객·영업·통화 | FreePass Sales | HOLD / 후속 연결 |
| 접수·계약·인도 | FreePass Admin | HOLD / 후속 연결 |
| 정산·청구·수금·지급 | FreePass Admin Settlement | HOLD / 후속 연결 |
| 견적·계산 입력과 결과 | FreePass Estimate | HOLD / 후속 연결 |
| 시트·웹·소비처 발행 | FreePass Data Distribution | PARTIAL |
| 원문·문서·이력·감사 | FreePass Data Control Plane | PARTIAL |

## Google Sheets 빠른 연결

F01/F86은 URL이나 바뀌는 탭 제목을 다시 검색하지 않는다.
`contracts/f01-f86-sheet-spec.v1.json`의 spreadsheetId와 stable sheetId를 사용한다.
카탈로그의 `sheet-f01`, `sheet-f86`은 이 계약을 참조한다.

시트 작업은 다음 순서로 고정한다.

1. 카탈로그에서 workbook 계약과 데이터 Release를 찾는다.
2. 전체 sheet inventory와 grid coverage를 읽는다.
3. 동일 Release/snapshot으로 dry-run 계획을 만든다.
4. 기존 publisher lock 안에서만 적용한다.
5. 새 조회와 화면으로 값·sheetId·탭·필터·release receipt를 검증한다.

표시 규격을 고치는 일과 데이터를 최신화하는 일을 한 작업으로 추정하지 않는다.
등록된 sheetId가 없거나 달라졌으면 이름으로 대체 탭을 고르지 않고 HOLD한다.

## 라이브 inventory 갱신

현재 checkout에는 Firebase/Sheets 자격증명이 설정되어 있지 않다. 따라서 이 문서의
count와 상태는 이전 관측을 설명하는 기준선일 뿐 현재 live 증거가 아니다.

라이브 작업에서는 승인된 읽기 연결로 다음을 새로 관측한다.

- Firestore collection inventory, count, readTime, field-shape digest
- Google workbook ID, 전체 sheetId/title/index/hidden 상태, coverage와 수정 시각
- 각 repository의 reader/writer, feature switch와 배포 revision
- Projection Release와 consumer receipt

관측 결과는 원문 없이 locator/count/digest/readTime만 inventory 입력으로 만들고
`classifyObservedDataAsset()`과 `auditCatalogCoverage()`로 검사한다. 미등록·오래된·불완전
관측이 하나라도 있으면 전체 inventory 상태는 HOLD다.
