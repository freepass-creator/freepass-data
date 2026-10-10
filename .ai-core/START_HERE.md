# AI 작업 시작 키트

> AI Core revision: f9eaeee55299a99d7445ae72d1d786e5bb37afee · target revision: cc70619313e5e7538ff3822a8c373b7a1feed643

1. 프로젝트 루트에서 `node .ai-core/session-bootstrap.mjs`를 실행해 정체성·정본·GitHub 연결·원격 최신성·검증 명령을 한 번에 확인한다.
2. 원격보다 뒤처졌고 작업 트리가 깨끗하면 `node .ai-core/session-bootstrap.mjs --sync`로 현재 브랜치를 fast-forward only 방식으로 갱신한다. dirty·diverged·접근 실패 상태에서는 자동 반영하지 않는다.
3. `kit.json`의 대상 repository와 baseline revision, 출력의 AI Core kit revision을 확인한다.
4. `standards/`의 규격만 적용하고 대상 프로젝트 지침을 우선한다.
5. `OPERATING_KNOWLEDGE.json`의 `confirmed_decisions`(다시 묻지 않을 결정)와 `lessons`(다른 AI가 실전에서 배운 교훈)를 읽는다. 배운 것이 생기면 개인 메모리가 아니라 AI Core 저장소의 `registry/operating-knowledge.json`에 남긴다.
6. 기존 자산을 먼저 찾고, 새 자산은 재사용 판정을 기록한다.
7. `node .ai-core/verify-kit.mjs`로 키트 무결성과 대상 revision binding을 확인한다.
8. 완료 시 `WORK_RESULT.md`를 채우고 사용자 수정·재작업·false completion 횟수를 실제 관측값으로 적는다. `UNKNOWN`을 0으로 바꾸지 않는다.
9. 셋 중 하나라도 1 이상이면 `학습환류: EPISODE`로 표시하고 AI Core의 `academy:closeout`을 Episode와 함께 실행한다. 교훈이 없을 때만 `학습환류: NONE`으로 닫는다.
