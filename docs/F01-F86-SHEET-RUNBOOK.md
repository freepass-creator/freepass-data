# F01/F86 반복 작업 절차

목적: AI가 매번 임의로 서식을 재구성하지 않고, 같은 입력과 같은 규격이면 같은 Google Sheets 요청을 생성한다.
정본: `contracts/f01-f86-sheet-spec.v1.json`. 작업 지침 진입점: `AGENTS.md`.

## 1. 원본 읽기

- Google Drive/Sheets 연결을 사용한다. credentials나 원문을 외부 AI 검토에 전달하지 않는다.
- workbook ID와 primary sheetId는 JSON에 고정되어 있다. 날짜가 앞에 붙는 이름으로 startsWith 검색을 하지 않는다.
- `spreadsheets.get`의 metadata, basicFilter, 전체 visible sheet grid의 rowData(userEnteredValue/effectiveValue), columnMetadata(pixelSize/hiddenByUser)를 읽는다. 전체 행·열 끝을 metadata gridProperties로 고정한다. 숨김 관리 탭은 metadata만 유지한다.
- 커넥터가 columnMetadata를 반환하지 않으면 읽기 API 또는 승인된 읽기 연결로 보충한다. 누락을 기본값으로 메우지 않는다. 원문/시크릿을 Git에 넣지 않는다.
- 읽은 결과를 로컬 `tmp/`에 아래 wrapper로 보존한다. coverage에는 **실제로 끝까지 읽은** 각 표시 탭의 범위만 적는다. 읽지 않은 범위를 완료했다고 표시하지 않는다.

```json
{
  "capturedAt": "2026-09-21T07:28:00Z",
  "sheetInventory": [{ "sheetId": 2024887857, "title": "상품리스트", "index": 0 }],
  "coverage": [{ "sheetId": 2024887857, "endRowIndex": 415, "endColumnIndex": 69 }],
  "spreadsheet": { "spreadsheetId": "실제 F86 ID", "sheets": [] }
}
```

위 예시는 구조 설명이며 실데이터나 완성 입력이 아니다. sheetInventory는 별도 metadata 조회의 **전체** 시트 목록이다. Google이 생략한 기본 startRow/startColumn=0은 허용한다. 전체 범위를 요청했고 전송이 정상 완료된 공식 API 응답에 한해서, Google이 생략한 마지막 빈 행/헤더 셀을 grid 크기까지 빈 배열/빈 셀로 정규화한다. 부분 읽기·오류 응답을 빈칸으로 채우면 안 된다. columnMetadata는 전체 열에 있어야 한다. 서로 떨어진 그리드 응답은 A1부터의 단일 완전 그리드로 정확하게 합쳐야 한다.

## 2. 변경안 생성 — 기본은 쓰기 없음

```powershell
npm run sheets:plan -- --input=tmp/f01-readback.json --workbook=F01 --updated-at=2026-09-21T07:28:00Z
npm run sheets:plan -- --input=tmp/f86-readback.json --workbook=F86 --updated-at=2026-09-21T07:28:00Z
```

- 두 호출에 같은 의도한 시트 갱신 시각을 사용한다. 숫자·색·너비는 JSON에서 읽는다.
- 읽기 유효기간 5분. 원본이 달라졌거나 오래됐으면 다시 읽는다.
- HOLD: 잘못된 workbook, 없어지거나 숨겨진 기본 탭, 불완전 읽기, 중복/누락 차량번호, 폐기된 오공구독 탭. 이때 전체 계획을 멈추고 원인을 해결한다.
- 공급사별 뷰는 기본 네 탭 합계에 더하지 않는다. 별도 그룹 안의 중복 키는 오류다.

## 3. 범위 내 적용

- 출력 `requests`만 확인된 동일 workbook의 Google Sheets batchUpdate에 전달한다. 실행기 자체에는 네트워크나 쓰기·배포 권한이 없다.
- 사용자 승인 범위와 현재 세션의 직접 지시를 따른다. 이미 특정 작업을 승인했다면 같은 승인을 반복해서 요구하지 않는다.
- 기존 필터 조건/정렬 설정은 보존하고 범위만 늘린다. 탭 ID/셀/수식/원문은 보존한다. 행 통합·삭제와 데이터 최신화는 별도 검증 작업이다.
- 필터가 전체 데이터를 포함하고 grid 안에 있으면 뒤의 빈 행 여유는 허용한다. 그 여유를 없애려고 불필요하게 필터를 축소하지 않는다.
- 원천과 다른 데이터를 복사해 놓고 presentation PASS를 데이터 PASS라고 하지 않는다.

## 4. 새 원본으로 검증

```powershell
npm run sheets:plan -- --input=tmp/f01-after.json --workbook=F01 --updated-at=2026-09-21T07:28:00Z --verify
npm run sheets:plan -- --input=tmp/f86-after.json --workbook=F86 --updated-at=2026-09-21T07:28:00Z --verify
```

- PASS=변경 요청 0. exit 1=규격 차이 남음, exit 2=HOLD/불완전 증거.
- 같은 timestamp로 검증한다. 검증할 때 현재 시각을 새로 넣어서 제목 변경을 만들지 않는다.
- 실제 브라우저 화면에서 이름·탭 색·원문 열 너비·장기 표시를 확인한다.
- 로컬 회귀 검사: `npm run check:sheets`. 전체 기본 검사 `npm run check`에도 포함되어 있다.

## 운영 자동화 경계

이 도구는 수동/AI 작업에 재사용할 계획·검증 도구다. 현재 외부 freepasserp4 Actions의 고정 엔진에는 연결되지 않았다. 따라서 예약 발행이 새 규격을 유지한다고 주장하면 안 된다. 연결 시 이 JSON과 실행기 버전을 고정해 발행 후 실행하고, 같은 회차의 새 readback으로 검증해야 한다. 별도 스케줄러나 이중 writer를 만들지 않는다.

### 온라인 호출 계약

`scripts/sheet-presentation-online.mjs`의 `runPresentation`은 같은 JSON과 planner를 직접 사용한다. `api(url, {method, body})`는 기존 발행기의 인증·재시도 정책을 재사용하며, 실패 응답은 반드시 throw하고 성공 응답의 parsed JSON만 반환한다. body는 문자열이 아닌 객체다.

기본 `apply=false`는 읽기와 변경 요약만 수행한다. `apply=true`에는 기존 production write gate를 실행하는 `authorizeWrite`와 비공개 원본 백업을 실제 저장하는 `saveBackup` callback이 필요하다. 기존 `erp5-inventory-publish` 동시실행 잠금 안에서 호출한다. 이 모듈 자체가 분산 잠금을 제공하지 않는다.

쓰기 직전 전체 관측값을 다시 읽어 바뀌면 HOLD한다. 적용 후 새 조회로 같은 timestamp의 요청 0개와 셀 값·수식 보존을 확인한다. Google Sheets API에는 이 모듈이 사용할 원자적 compare-and-swap이 없으므로 마지막 조회와 쓰기 사이의 외부 수동 편집까지 잠글 수는 없다. readback drift는 실패로 보고하며 자동 덮어쓰기/자동 rollback을 하지 않는다.

백업은 원문을 포함하므로 비공개 저장소에만 보관한다. 반환 receipt에는 차량 원문을 넣지 않지만 workbook ID와 대수·서식 변경은 포함된다. 온라인 운영 완료는 실제 workflow 엔진 pin과 발행기 연결, 실행 및 readback 증거가 모두 있어야 한다.
