# 공통 시트 빈 칸 채우기 계획기

## 목적

공통 시트 공급사 탭의 차량 줄에서 빈 칸만 프리패스 데이터 정본 값으로 채우는 `plan.json`과 `report.json`을 만든다. 시트 쓰기는 하지 않는다. 계획/보고서에는 차량번호가 들어가므로 공개 저장소에 올리지 말고 비공개 폴더에만 둔다.

## 입력/출력

입력은 `SHEET_BLANK_FILL_INPUT` JSON 파일이다. `spreadsheetId`, 15분 이내 `capturedAt`, 탭별 1행 머리글/행 값, 차량 정본, `policyLinks`, 정책 문서를 담는다. 실행은 `SHEET_BLANK_FILL_OUT` 폴더에 `plan.json`과 `report.json`을 쓴다. 출력 폴더를 생략하면 입력 파일 옆에 쓴다.

## 규칙

머리글 이름으로 열을 찾고, 머리글 누락/중복 탭은 전체 HOLD로 보고서에만 남긴다. 빈 칸(null·undefined·빈 문자열)만 채우며(공백만 있는 칸은 사람이 지운 흔적일 수 있어 건너뜀 WHITESPACE_ONLY) 값이 있는 칸은 덮지 않고 차이만 기록한다. 수식 칸은 절대 건드리지 않는다. 차량 값은 확인됨, 근거 있음, 확인 필요 아님, 정본 값 있음일 때만 쓴다. 정책 값은 `field_evidence[필드].writer === 'policy-corrector'`인 값만 쓴다. 21세+/23세+는 판매 방침 값을 우선한다.

## 입력 필수 사항(검토 반영 2026-10-05)

- 모든 행에 formulaCols(수식 칸 열 인덱스, 없으면 빈 배열)가 있어야 한다 — 수식 읽기(FORMULA)를 캡처에 포함하지 않으면 SHEET_BLANK_FILL_FORMULA_READ_REQUIRED 로 멈춘다(결과가 빈 글자인 수식 칸을 빈 칸으로 오인하지 않기 위해).
- policyLinks 값은 {code, plate} — 정책확인 줄의 차량번호가 시트 줄의 차량번호와 다르면 POLICY_LINK_MISMATCH 로 건너뛴다(정렬 변경 대비).
- 숫자 칸(연식·배기량·인승)의 정본 값은 순수 숫자여야 한다. «1,598»·«2024년» 같은 값은 INVALID_NUMBER 로 건너뛴다(글자로 넣지 않는다).

## 운영 절차

시트는 읽기 전용으로 캡처하고 같은 캡처 파일을 15분 안에 실행한다.

```powershell
$env:SHEET_BLANK_FILL_INPUT="D:\private\sheet-blank-fill\input.json"
$env:SHEET_BLANK_FILL_OUT="D:\private\sheet-blank-fill\out"
npm.cmd run plan:sheet-blank-fill
```

`plan.json`은 시트고치기 엔진에 넘길 계획이다. 이 저장소의 계획기는 적용하지 않는다.

## 후속

상황실/사람이 `report.json`의 HOLD 사유와 차이를 확인한 뒤, 비공개 경로의 `plan.json`만 별도 시트고치기 엔진으로 적용한다.
