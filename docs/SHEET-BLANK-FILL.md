# 공통 시트 빈 칸 채우기 계획기

## 목적

공통 시트 공급사 탭의 차량 줄에서 빈 칸만 프리패스 데이터 정본 값으로 채우는 `plan.json`과 `report.json`을 만든다. 시트 쓰기는 하지 않는다. 계획/보고서에는 차량번호가 들어가므로 공개 저장소에 올리지 말고 비공개 폴더에만 둔다.

## 입력/출력

입력은 `SHEET_BLANK_FILL_INPUT` JSON 파일이다. `spreadsheetId`, 15분 이내 `capturedAt`, 탭별 1행 머리글/행 값, 차량 정본, `policyLinks`, 정책 문서를 담는다. 실행은 `SHEET_BLANK_FILL_OUT` 폴더에 `plan.json`과 `report.json`을 쓴다. 출력 폴더를 생략하면 입력 파일 옆에 쓴다.

## 규칙

머리글 이름으로 열을 찾고, 머리글 누락/중복 탭은 전체 HOLD로 보고서에만 남긴다. 빈 칸(null·undefined·빈 문자열)만 채우며(공백만 있는 칸은 사람이 지운 흔적일 수 있어 건너뜀 WHITESPACE_ONLY) 값이 있는 칸은 덮지 않고 차이만 기록한다. 수식 칸은 절대 건드리지 않는다. 차량 값은 확인됨, 근거 있음, 확인 필요 아님, 정본 값 있음일 때만 쓴다. 정책 값은 `field_evidence[필드].writer === 'policy-corrector'`인 값만 쓴다. 21세+/23세+는 판매 방침 값을 우선한다.

## 입력 필수 사항(검토 반영 2026-10-05)

- 모든 행에 formulaCols(수식 칸 열 인덱스, 없으면 빈 배열)가 있어야 한다 — 수식 읽기(FORMULA)를 캡처에 포함하지 않으면 SHEET_BLANK_FILL_FORMULA_READ_REQUIRED 로 멈춘다(결과가 빈 글자인 수식 칸을 빈 칸으로 오인하지 않기 위해).
- policyLinks 값은 {code, plate} — 정책확인 탭에는 차량번호 열이 없으므로 시트 줄 차량번호의 products 문서 `policy_code` 가 정책확인 정책코드와 같을 때만 만든다. 상품 문서가 없거나 코드가 다르면 연결하지 않고 정책 칸은 NO_POLICY_LINK 로 건너뛴다.
- 숫자 칸(연식·배기량·인승)의 정본 값은 순수 숫자여야 한다. «1,598»·«2024년» 같은 값은 INVALID_NUMBER 로 건너뛴다(글자로 넣지 않는다).

## 줄확인(2026-10-05)

plan.json 에 `줄확인:[{범위, 값}]` 이 들어 있다 — 채우는 줄마다 같은 줄의 차량번호 칸을 «쓰지 않고 대조만» 한다(시트고치기 줄확인, ai-ops#62 이상 필요). 계획을 만든 뒤 줄이 움직여 차량번호가 달라지면 CONFLICT 로 전체가 멈춰 다른 차 빈 칸에 들어가지 않는다. 차량번호 칸에는 쓰지 않으므로 사진 링크가 지워지지 않는다.

## 운영 절차

시트는 읽기 전용으로 캡처하고 같은 캡처 파일을 15분 안에 실행한다.

```powershell
$env:SHEET_BLANK_FILL_INPUT="D:\private\sheet-blank-fill\input.json"
$env:SHEET_BLANK_FILL_OUT="D:\private\sheet-blank-fill\out"
npm.cmd run plan:sheet-blank-fill
```

`plan.json`은 시트고치기 엔진에 넘길 계획이다. 이 저장소의 계획기는 적용하지 않는다.

## 읽기 어댑터

`export:sheet-blank-fill-input`은 쓰기 0 읽기 전용 job이다. `SHEET_BLANK_FILL_SPREADSHEET`에는 비공개 시트 ID를, `SHEET_BLANK_FILL_INPUT_OUT`에는 체크아웃 밖 비공개 출력 파일의 절대경로를 넣는다. 공급사 탭은 `contracts/supplier-input-sheet-spec.v1.json`의 `supplierChannels.sharedInputSheet` 탭만 읽고, 읽기 순서는 값 `UNFORMATTED_VALUE` → 수식 `FORMULA` → 값 `UNFORMATTED_VALUE` → 수식 `FORMULA`다. 값 앞뒤와 수식 앞뒤가 모두 같아야 진행하며, FORMULA 응답 범위 수가 요청 수와 다르거나 누락되면 `SHEET_BLANK_FILL_INPUT_SHAPE` 로 멈춘다. 한 탭의 데이터 행이 5,000행을 초과하면 `SHEET_BLANK_FILL_TAB_TOO_LARGE` 로 멈춘다.

FORMULA response is not padded or defaulted. For every non-empty `UNFORMATTED_VALUE` cell, the same row/column in the `FORMULA` response must exist and must not be `undefined`; `values: []`, a missing FORMULA row, a shorter FORMULA row, or a missing FORMULA cell for a non-empty value cell stops with `SHEET_BLANK_FILL_INPUT_SHAPE`. Extra FORMULA rows are allowed; formula cells on value-empty rows are still recorded in `formulaCols`, and the planner skips those rows when they have no plate.

```powershell
$env:SHEET_BLANK_FILL_SPREADSHEET="<private sheet id>"
$env:SHEET_BLANK_FILL_INPUT_OUT="D:\private\sheet-blank-fill\input.json"
npm.cmd run export:sheet-blank-fill-input
npm.cmd run plan:sheet-blank-fill
```

이후 `plan.json`은 줄확인 지원 시트고치기(ai-ops#62 이상)로만 시험 실행·적용한다. 처음 2주는 `report.json`의 차이/스킵과 `plan.json` 줄확인을 사람이 확인한 뒤 적용한다.

## 후속

상황실/사람이 `report.json`의 HOLD 사유와 차이를 확인한 뒤, 비공개 경로의 `plan.json`만 별도 시트고치기 엔진으로 적용한다.
