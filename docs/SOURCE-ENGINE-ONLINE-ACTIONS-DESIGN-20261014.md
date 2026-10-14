# 원천 엔진 온라인(GitHub Actions) 실행 설계안 (2026-10-14, 설계만 — 구현 승인 전)

대표 지시: «배포된 것에 반영되게 온라인에서». 목적 = 엔진 회차를 B3Q 로컬 예약이 아니라 freepass-data GitHub Actions 에서 돌려 B3Q 의존을 없앤다.

## 1. 현재 구조와 문제

- 엔진 회차는 B3Q 로컬 작업 스케줄러(FreePass-Source-Cycle 정시, RP031 5분 단독)가 실행한다. 체크아웃 교체·환경 변수·비밀 폴더가 전부 B3Q 에 있다.
- 결과: ① B3Q 한 대가 멈추면 전 원천이 멈춘다 ② 코드 배포(체크아웃 교체)가 사람 절차라 «배포된 것에 바로 반영»이 안 된다 ③ 이 PC 에서는 운영 실행 결과를 볼 수 없다.

## 2. 제안 구조

| 구성 | 내용 |
|---|---|
| 워크플로 | `.github/workflows/source-cycle.yml` — `schedule`(5분 간격) + `workflow_dispatch`(원천 코드·dry-run 입력) + `repository_dispatch`(즉시 실행 요청 이벤트) |
| 실행 단위 | `scripts/run-source-cycle` 와 같은 CLI(`runUnattended`)를 `--source <코드>` 로 원천별 순차 실행. 변경 감지(시트 modifiedTime·홈피 사이트맵 수·상류 synced_at)가 없으면 UNCHANGED 로 즉시 종료 |
| 동시 실행 | 워크플로 `concurrency: group: source-cycle, cancel-in-progress: false` — 파일 잠금 대신 GitHub 직렬화. 엔진의 Firestore CAS·백업·되읽기는 그대로 |
| 비밀 | 아래 §3. 저장소 환경(Environment) `source-cycle-prod` 의 필수 검토자(승인)를 걸 수 있다 |
| 기록 | heartbeats·reconciliation 은 아티팩트(JSON)와 Firestore 요약 문서 한 곳에 남긴다(현재 B3Q 로컬 JSONL 대체). 감독 점검은 이 아티팩트/요약을 읽는다 |
| 백업 | 문서별 before 백업은 실행 러너가 사라지므로 Firestore 별도 컬렉션(append-only)이나 아티팩트로 이동 필요 — **미해결 설계 항목** |

## 3. 필요한 비밀과 재사용 가능성

| 용도 | 비밀 | 재사용 |
|---|---|---|
| Firestore 쓰기(상품 문서) | 서비스 계정 키 또는 Workload Identity Federation | ERP4 워크플로(`erp5-ssot-refresh`)가 이미 Firestore 쓰기를 한다 — 같은 서비스 계정 권한을 재사용하려면 이 저장소에 별도 시크릿 등록 필요(저장소 간 시크릿 공유 불가). **권고: WIF(키 없는 방식)** |
| 시트 읽기(F05·아이카) | Google SA JSON(ERP4 의 `GOOGLE_SA_JSON` 과 같은 읽기 계정 후보) | 계정은 재사용 가능, 시크릿은 이 저장소에 새로 등록 |
| 이안카 ONE API | 이안카 계정 비밀 | B3Q 로컬에만 있음 — 이관은 대표 손 |
| 손오공 ERP | `SONOGONG_ACCOUNT_JSON` | ERP4 시크릿에만 있음 — 엔진 RP012 쓰기를 켤 때 이관 필요 |
| 오토플러스·아이언 홈피 | 없음(공개 페이지) | — |

원칙: 비밀 값은 채팅·PR·로그에 쓰지 않는다. 등록은 대표 손(저장소 설정)이며 AI 는 이름과 용도만 문서화한다.

## 4. 지연(목표 5분)

| 단계 | 최대 |
|---|---|
| Actions schedule 지연 | 최대 약 5~10분(GitHub 부하 시 지연 가능, 보장 없음) |
| 변경 감지 + 원천 단독 회차 | 1~5분(이안카 읽기 약 5분) |
| ERP5 캐시 | 약 60초 |
| 즉시 요청(repository_dispatch) | 큐 대기 + 실행 약 1~6분 |

Actions schedule 은 정시 보장이 없으므로 «지시 후 5분»은 즉시 요청 이벤트 경로가 맡고, 정기 5분 감지는 보조다.

## 5. B3Q 의존 제거 이득과 남는 의존

- 제거: 체크아웃 교체 절차(병합 즉시 반영), 로컬 예약 등록, 단일 PC 장애.
- 남음: ① 이안카 429·세션 이력(이안카 호출은 직렬·간격 유지 필요), ② 비밀 배치(대표), ③ 백업 저장소 이전, ④ ERP4 라운드(손오공·오토플러스 변동 쓰기)는 ERP4 저장소 워크플로로 계속(엔진 RP012/RP023 쓰기 전환 전까지).

## 6. 이행 순서(제안, 구현 승인 후)

1. 서비스 계정 권한 범위 확인(WIF) — 대표/B3Q.
2. 워크플로를 dry-run 전용으로 먼저 배포하고 B3Q 정시 회차와 병행 비교(쓰기 0).
3. 백업 저장소 이전 후 원천 하나(F05)부터 쓰기 전환, B3Q 해당 원천 예약 해제.
4. 이안카·아이카·오토플러스 순 전환, 마지막에 B3Q 예약 폐기.
이중 쓰기 금지: 같은 원천을 B3Q 와 Actions 가 동시에 쓰지 않게 원천 단위로 전환한다.
