# 공통 시트 빈 칸 채우기 계획기

## 목적

공통 시트 공급사 탭의 차량 줄에서 빈 칸만 프리패스 데이터 정본 값으로 채우는 `plan.json`과 `report.json`을 만든다. 시트 쓰기는 하지 않는다. 계획/보고서에는 차량번호가 들어가므로 공개 저장소에 올리지 말고 비공개 폴더에만 둔다.

## 입력/출력

입력은 `SHEET_BLANK_FILL_INPUT` JSON 파일이다. `spreadsheetId`, 15분 이내 `capturedAt`, 탭별 1행 머리글/행 값, 차량 정본, `policyLinks`, 정책 문서를 담는다. 실행은 `SHEET_BLANK_FILL_OUT` 폴더에 `plan.json`과 `report.json`을 쓴다. 출력 폴더를 생략하면 입력 파일 옆에 쓴다.

## 규칙

머리글 이름으로 열을 찾고, 머리글 누락/중복 탭은 전체 HOLD로 보고서에만 남긴다. 빈 칸(null, 빈 문자열, 공백)만 채우며 값이 있는 칸은 덮지 않고 차이만 기록한다. 수식 칸은 절대 건드리지 않는다. 차량 값은 확인됨, 근거 있음, 확인 필요 아님, 정본 값 있음일 때만 쓴다. 정책 값은 `field_evidence[필드].writer === 'policy-corrector'`인 값만 쓴다. 21세+/23세+는 판매 방침 값을 우선한다.

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
