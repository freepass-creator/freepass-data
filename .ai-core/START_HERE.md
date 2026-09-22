# AI 작업 시작 키트

1. 프로젝트 루트에서 `node .ai-core/session-bootstrap.mjs`를 실행해 정체성·정본·GitHub 연결·원격 최신성·검증 명령을 한 번에 확인한다.
2. 원격보다 뒤처졌고 작업 트리가 깨끗하면 `node .ai-core/session-bootstrap.mjs --sync`로 현재 브랜치를 fast-forward only 방식으로 갱신한다. dirty·diverged·접근 실패 상태에서는 자동 반영하지 않는다.
3. `kit.json`의 대상 repository와 baseline revision, 출력의 AI Core kit revision을 확인한다.
4. `standards/`의 규격만 적용하고 대상 프로젝트 지침을 우선한다.
5. 기존 자산을 먼저 찾고, 새 자산은 재사용 판정을 기록한다.
6. `node .ai-core/verify-kit.mjs`로 키트 무결성을 확인한다.
7. 완료 시 `WORK_RESULT.md`를 채운다.
