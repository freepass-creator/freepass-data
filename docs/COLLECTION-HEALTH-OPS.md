# 수집 15분·이안카 복구·손오공 편입 — 실측과 다음 단계 (2026-10-12)

상태: 감시 스크립트 CODED·TESTED(가짜 응답 6건)·이 PC 작업 스케줄러 등록 및 실측 1회. 나머지는 DESIGNED/HOLD(운영 승인 항목). 시트 ID·차량번호·토큰은 싣지 않는다.
설계 한 장(PR #490, `COLLECTION-HEALTH-PLAN.md`)을 이어받으며, 아래 «정정»은 그 문서의 B 절 일부를 바로잡는다.

## 1. 토큰 0 감시 (완료)
- `scripts/collection-health-watch.mjs` — `gh run list`(읽기)로 공통 시트 15분 워크플로의 **예약(schedule) 실행만** 읽어 마지막 성공 시각·연속 실패 수·24시간/7일 준수율을 `%LOCALAPPDATA%\freepass-data\collection-health\`(`state.json`·`history.jsonl`)에 남긴다. 45분 초과 정지 또는 3연속 실패면 `alerts.log` 에 한 줄(같은 경보는 1시간에 한 번). 쓰기·dispatch 없음, AI 토큰 0.
- `scripts/collection-health-watch-register.ps1` — 이 PC 작업 스케줄러 `FreepassData-CollectionHealthWatch`(15분마다) 등록. 경로는 등록 시점의 저장소 위치이므로 이 PR 반영 뒤 주 저장소 경로로 다시 등록한다.
- 첫 실측(2026-10-11T20:49Z): 마지막 예약 성공 00:27Z(1,221분 전), 연속 실패 1, 24h 5회(5.2%), 7일 27회(4.0%) → 정지 경보. PR #490 의 숫자(27/672)와 일치.

## 2. 15분이 안 도는 원인 — 정정
- #490 은 «마지막 예약 실패(10-11 18:17Z)가 매시 감사 가드 3시간 검사 불합격»이라 적었으나 **실제 로그와 다르다.** 그 회차는 관문을 통과했고(18:18), 시트 읽기 12탭·175행 뒤 적용 단계에서 `status HOLD / committed 0 / held 18 / remaining 157 / reason CANONICAL_COMMAND_REJECTED` 로 끝나 exit 1 이었다(소요 약 25분). 즉 «가드 종속»이 마지막 실패의 원인이 아니다.
- 구조 사실: 변경이 없는 회차는 8~21초, 변경이 있는 회차는 15~25분이다. 같은 concurrency 그룹(`freepass-data-production-delivery`, 진행 중 취소 안 함, 그룹당 대기 1개)이라 긴 회차 동안 들어온 예약은 대기 1개로 합쳐져 대체된다. 또 예약 실행이 UTC 21~01시에 몰리고 17시간 공백이 있어 GitHub 예약 자체의 누락/지연도 있다. 두 원인의 비중은 실행 이력만으로는 분리되지 않는다(UNKNOWN).
- ② 가드 완화(3시간→6시간)는 **하지 않는다.** 이유: 병목이 가드가 아니고, 오래된 감사 성공을 믿는 쓰기 안전 마진만 깎는다. (구현 Claude, 독립 검토 Gemini 동의: concurrency 대체가 유력, 완화는 stale guard 위험.)
- 권고(대표 승인 항목): 예약 신뢰성은 이미 만든 Cloud Scheduler → 비공개 OIDC 중계 → 허용 목록 dispatch 경로를 «보조 트리거»로 켠다(이 PC 에서 dispatch 하는 안은 절전·네트워크 단절에 약해 기각). 이때 수동 dispatch 는 검토 계획 입력을 요구하므로 «예약 전용 적용 모드»를 중계에서만 받는 입력으로 정의하는 별도 설계·독립 검토가 먼저다. 긴 회차가 짧은 예약을 대체하는 문제는 변경분 적용을 분할하거나 HOLD 회차를 일찍 끝내는 별도 개선으로 분리한다.
- 적용 HOLD(`CANONICAL_COMMAND_REJECTED`, 차 18대)의 원인 분석은 마스터 충돌 보강(#490 A①) 담당 몫이다.

## 3. 이안카(RP031) 수집기 중단 — 조사 결과
(Codex gpt-6-astra 읽기 전용 조사 + 코드 대조, 운영 로그는 확인하지 못했다.)
- 경로: Cloud Scheduler `supplier-relay-iancar-15m`(02·17·32·47분) → Cloud Run 중계(`src/api/supplier-relay.ts`) → ERP4 `erp5-ssot-refresh.yml` → ONE 수집·동기화. Data 저장소에는 이안카 전용 예약 워크플로가 없다.
- 중단 유력 원인: 인계 문서(`NEXT-START-HERE.md` 19행)가 이 스케줄러를 **PAUSED 로 유지**한다고 명시하며, 중계의 실패·취소·UNKNOWN pending 도 후속 실행을 막는다(`supplier-relay.ts` 98–114, 129–138). 10-01 노출 철회는 «노출 차단»이지 수집 중단이 아니다. 과거 ONE 전량 수집은 `IANCAR_ONE_DETAIL_AVAILABILITY_DRIFT`·HTTP 503 으로 실패한 기록이 있다.
- 결론: **코드 PR 로 고칠 부분은 확인되지 않았다.** 복구는 운영 대사 → 승인 → 재개다. 철회 가드 제거·폐기 워크플로 부활은 복구안에서 제외한다.
- 지휘통제실 승인 필요(운영): ① 스케줄러 상태·URI·pending 과 실제 Actions 실행 대사 ② pending 잠금 해제 필요 시 그 처리 ③ 새 전량 수집(시험) → 검토 → 승인 적용 → 소비처 재조회 뒤 스케줄러 재개(`docs/deploy/supplier-collect-relay-배포절차.md` 146–152). 재개와 철회 해제는 별개 결정이다.

## 4. 손오공(RP012) 편입 — 현황과 남은 층
- 이미 main 에 있는 것: `sonogong-erp-reader.ts`(로그인·페이지 순회·상세, 동시 1·요청 간 250ms·신선도 1시간), `source:sonogong` CLI(기본은 읽기·건수 요약, `--apply-raw` 는 `SONOGONG_RAW_INGEST_APPROVED=true`+RAW_READY 필요), 보증금 비교(`--compare-deposits`), 버킷 3개(DAILY·일반·TCAR) RAW 보존. 설계는 `NATIVE-SOURCE-COLLECTOR.md` «손오공 RP012 ERP 읽기 이식».
- 아직 새 파이프라인 밖인 이유(층별):
  1. 운영 실행 없음 — GitHub 에 손오공 계정 비밀값/예약 워크플로가 없고 RAW 적재는 승인 환경변수 전제(HOLD).
  2. RAW → 후보 변환 미연결 — «현재 RAW runtime 은 정규화 함수를 전달하지 않는다»(문서 332행). 즉 적재해도 상품 후보·보류 판정이 안 생긴다.
  3. 정리(차종·제원) 규칙 — 읽기 단계는 정리를 하지 않으며 마스터를 거친 후속 정리 책임이다.
- 편입 순서(제안): ⓐ 승인 하에 로컬 시험 실행으로 3버킷 실제 건수·DAILY 응답 형태 확인(읽기만) → ⓑ RAW → 후보 정규화 연결(페이지 증거 제외 계약 포함, Codex 구현·다른 모델 검토) → ⓒ 15분 예약을 위한 비밀값·워크플로(승인) → ⓓ 보류 판정이 공통 시트 계열과 같은 규칙으로 도는지 대조. 1차 구현(ⓑ)은 지휘통제실이 ⓐ 의 건수 확인과 실행 승인을 준 뒤 시작한다 — 계정 값은 AI 가 다루지 않는다.
- 공급사 현재 경로·주기: 손오공=공급사 API(ERP4 `sonokong` 레거시가 읽고 있음, Data 쪽은 위 CLI 대기). 이안카=위 3절 중계(PAUSED). 시트 계열 12탭=공통 시트 15분(준수율 4%). 아이언·RP023=사이트 수집 코드 있음/미연결.

## 5. 승인·결정 요청 (지휘통제실로만)
1. Cloud Scheduler→중계 보조 트리거 재개 여부 + «예약 전용 적용 모드» 설계 착수.
2. 이안카: 운영 대사(스케줄러·pending) 실행 승인.
3. 손오공: 읽기 시험 실행 승인(계정 사용) — 이후 정규화 연결 1차 구현.

## 6. 공통 시트 15분 «적용» 연속 실패 — 원인 확정과 판정 필요 (2026-10-13)
실측(비공개 증거 `apply.json`·`plan.json`·`live-capture.json`을 내려받아 오프라인 재현, 쓰기 0):
- 05:30Z 회차: 사전 점검 통과 → 첫 명령이 울타리 900초 초과로 `CANONICAL_COMMAND_REJECTED`(#576 이 3600초로 완화).
- 12:57Z 등 `SHARED_SHEET_JOB_HOLD`(출력 없음): 계획의 마스터 스냅샷 readAt(13:00:02Z)을 벽시계 기준 **5분**(`scripts/supplier-input-sheet.mjs` `vehicleMasterSnapshotRows`, `age>300000`)으로 검증하는데 적용 단계 사전 점검이 13:06:32Z 까지 걸려 `Active Data vehicle master snapshot required` 로 던지고, 바깥 catch 가 문구를 삼킨다. 같은 계획을 지금 `assertSharedSheetPlan` 에 넣으면 같은 문구로 재현된다(과거 4회 전부를 단정하진 않음 — 단계·시각 일치 근거).
- 구조: 계획 마스터 readAt → 적용 단계(라이브 재캡처 ~1.5분 + 사전 점검 재계획 수 분) 간격이 5분 안팎이라 예약 적용은 구조적으로 경주. 두 시험이 서로 다른 불변식을 못박고 있어 코드만 고치면 한쪽을 깬다:
  1. `does not renew an expired sealed master…`(8bc4d786) — 만료된 계획 마스터는 갱신하지 않는다.
  2. `rejects an operational observation older than fifteen minutes…` — 관측 15분 초과 운영 갱신은 적용 거절.
- 선택지(소유자 판정 필요): **B(권고, Codex)** 예약 회차만 적용 단계에서 라이브 캡처로 계획을 새로 만들고 5분 안에 적용(수동 승인 계획 의미 유지) — 워크플로·적용 경로 변경이라 별도 설계·시험 필요, 재계획·중복 사전 점검 시간 단축 병행. **A** 예약 갱신 계획에 한해 계획 자신의 증거 시각을 기준 시계로(라이브 대조·현재 마스터 digest 가 신선도를 보장) — 두 시험의 기대를 바꿔야 하고, 변경 후 되돌림·대조 후 변경을 digest 가 못 잡는다. 이 세션은 불변식을 임의로 바꾸지 않았다.
