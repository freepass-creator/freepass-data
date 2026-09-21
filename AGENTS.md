# FreePass Data 작업 지침

## F01/F86 시트 작업

- 작업 시작 전 `docs/F01-F86-SHEET-SPEC.md`를 읽는다. 기계 정본은 `contracts/f01-f86-sheet-spec.v1.json` 하나다. 사용자 최신 지시는 이전 규격보다 우선하며 변경 시 정본도 같이 고친다.
- 이름·색·열 너비·숨김을 기억이나 임의 숫자로 다시 만들지 않는다. `scripts/sheet-presentation.mjs`로 전체 변경안을 생성한다.
- F01/F86 전체를 읽고 `scripts/sheet-presentation.mjs`에 넣는 표준 절차는 `docs/F01-F86-SHEET-RUNBOOK.md`를 따른다. 일부 탭만 고치고 전체 완료라고 말하지 않는다.
- 실행기는 presentation-only다. 원천 최신화, 차량 통합/삭제, 금액 수정 권한이나 검증을 대체하지 않는다. HOLD를 우회하지 않는다.
- 수정 후 새 조회로 `--verify`를 실행하고 실제 시트 화면도 확인한다. Actions/운영 pin 미연결을 자동화 완료로 표현하지 않는다.
- 원본과 다른 작업의 변경을 보존한다. RTDB는 영구 폐기 상태이며 복원/fallback/배포하지 않는다.
