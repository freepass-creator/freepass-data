# 공급사 원문 입력 시트 — 다음 작업은 여기서 시작

2026-10-02 사용자 결정. **공급사가 우리 시트에 원문을 입력하는 창구**이며 ERP 연동 공급사와 운영 F01/F86 상품 발행기는 별도다.

## 정본과 실행

- 기계 규격: `contracts/supplier-input-sheet-spec.v1.json`.
- 실행기: `scripts/supplier-input-sheet.mjs`. 기존 `sheet-presentation.mjs`와 의미색 정본을 재사용한다. 새 writer/자동화/RTDB를 만들지 않는다.
- 공개 저장소에는 실제 파일 ID·공급사별 원본·자격 증명을 넣지 않는다. 현재 private binding/원본 보존/검증 자료는 로컬 private evidence에 둔다.
- `npm run sheets:input:plan -- --input=<private-fresh-readback.json>`은 변경안을 출력할 뿐 Google에 쓰지 않는다. 검토한 requests를 연결된 Sheets batchUpdate로 실행하고 원본을 다시 읽어 검증한다. 운영 자동 갱신·공급사 공유·원천 cutover 완료라는 뜻이 아니다.

## 입력 구조

보이는 탭은 종합 + 렌트사 약칭이다. 회사명 → 상태 → 분류 → 차량번호 → 입고일자 → 점검사항으로 시작한다. 1/6/12/24/36/48/60개월을 유지하며 옵션은 기간별 대여료 뒤에 둔다. 기타기간은 값과 수식을 삭제하지 않고 숨긴다. 정책코드와 차고지·운전자·연주행·분납·연령·보험·정비·전용계좌·비고 입력칸을 공개한다. 내부 정제 열은 보존한다.

숫자로 입력된 금액·주행거리·배기량은 `#,##0` 표시만 적용한다. 단위 환산·텍스트 숫자화·10의 의미 추정·금액 변경을 하지 않는다. 설명형 보증금 등 원문은 그대로 남는다.

맑은 고딕9pt/기울임/21px, 연회색 굵은 헤더와 아래 구분선, 공용 기간별 배경색, 원본 F86 의미별 너비를 재적용한다. 원문을 제약하지 않는 일반 선택 목록을 상태·분류·제조사·모델명에 둔다. 2026-10-02 F03 실조회 목록은 제조사16/모델114개이며 자동 갱신이나 제조사별 종속 선택은 아직 연결하지 않았다. 차종마스터가 갱신되면 F03 원본 B/C열을 다시 읽고 규격 목록을 갱신해야 한다.

사용자 요청으로 입력 파일의 탭 자물쇠를 제거한다. `authorization.removeSheetProtections=true`가 있어야 기존 protection 삭제 요청을 만들며, 실제 공유 대상/편집 권한은 별도다. 종합 수식도 편집자가 수정할 수 있으므로 매 적용 후 수식 검증이 필요하다.

## 읽기·적용·검증

입력 JSON: `capturedAt`, `binding:{spreadsheetId,summarySheetId,guideSheetId,suppliers:[{sheetId,title,code}]}`, 별도 전체 metadata의 `sheetInventory:[{sheetId}]`, native `spreadsheet`(전체 sheet metadata와 A1부터 헤더 CellData), 필요한 protection 제거 authorization. 5분 이상 지난 입력, 잘못된 ID, 일부 inventory, 중복 code/ID/title, 알 수 없는 헤더, native table은 HOLD다. F01/F86 파일 ID로 실행할 수 없다.

1. 실제 native metadata·전체 입력값·종합 수식·열 치수·조건부서식·보호 범위를 private backup하고 binding을 재확인한다. 코드 예제나 캐시를 원본으로 대체하지 않는다.
2. 계획을 생성한다. 누락 필수 열은 명시적 migration 후 재조회하며, native Table 제거는 atomic delete+원문 복구 검증 없이는 실행하지 않는다. 실행기는 단독으로 Table/행/열/시트를 삭제하지 않는다.
3. 읽은 뒤 다른 편집이 없음을 재조회하여 확인하고 같은 계획을 순서대로 적용한다. 변경안 전체는 단일 batch가 가능할 때 atomic batch로 적용한다. 회사명 원문이 비어 있어도 임의 회사명으로 덮지 않는다.
4. 전체 provider row/field typed values를 이동 전후 **헤더 기준**으로 대조한다. 종합 수식·정책코드 supplier scope·부분입력 행·중복번호·열 구조 gate·행 수·오류값을 검사한다. 수식은 코드의 헤더 기반 HSTACK으로 재생성되므로 열 이동 후 오래된 INDEX 수식을 그대로 쓰지 않는다.
5. native tables0/protections0, 첫 회사명 열, 기타기간 숨김, 1/6/12 표시, 콤마 숫자, 일반 dropdown, 폰트/색/너비와 실제 화면을 확인한다. 210은 관측 입력행 수이며 차량 대수가 아니다.

## 현재 완료와 남음

코드/계획/실제 종합 재생성·열 이동·보호 해제는 검증 대상이다. 원문 latest refresh, 공급사 편집 권한/공유, 자동 운영 pin, 제조사 종속 모델 목록은 별도 미연결이다. 수동 화면 수정만으로 완료를 확대하지 않는다.
